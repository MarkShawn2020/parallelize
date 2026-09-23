// Executor x judge matrix: the same swarm on the same tasks, varying only who solves and who makes the coordination
// judgments. Scans runs/ for real runs of the chosen seed, classifies each by the models its ledger actually billed,
// and prints one table plus paired McNemar tests against the Jev judge in each executor row.
// Run: pnpm matrix [--seed 7] [--json out.json]
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { PROJECT_ROOT } from "../src/config";

const JUDGES = ["规则", "Jev", "Haiku 4.5", "Sonnet 5", "Opus 5"] as const;
const MODEL_NAMES: Record<string, string> = {
  "anthropic/claude-haiku-4.5": "Haiku 4.5",
  "anthropic/claude-sonnet-5": "Sonnet 5",
  "anthropic/claude-opus-5": "Opus 5",
};
const JUDGE_PURPOSES = new Set(["verify", "adopt", "adjudicate", "claim"]);

interface Cell {
  runId: string;
  executor: string;
  judge: string;
  correct: number;
  n: number;
  costUsd: number;
  wallS: number;
  judgeCalls: number;
  judgeUsd: number;
  outcomes: Map<string, boolean>;
}

const { values } = parseArgs({ options: { seed: { type: "string" }, json: { type: "string" } } });
const seed = Number(values.seed ?? 7);
const runsDir = join(PROJECT_ROOT, "runs");

const lines = async (path: string) =>
  (await readFile(path, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
const top = (counts: Map<string, number>) => [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
const name = (model: string) => MODEL_NAMES[model] ?? model;

async function classify(runId: string): Promise<Cell | null> {
  const events = await lines(join(runsDir, runId, "events.jsonl")).catch(() => null);
  const started = events?.find((e) => e.type === "run.started") as { config: Record<string, unknown>; simulated?: boolean } | undefined;
  if (!events || !started || started.simulated) return null;
  const c = started.config;
  const source = c.taskSource as { kind?: string; difficulty?: string } | undefined;
  if (c.seed !== seed || c.n !== 96 || c.cells !== 8 || source?.kind !== "synthetic" || source.difficulty !== "hard") return null;
  if (c.mode === "swarm-jev" && c.escalationThreshold !== 0) return null; // Jev + LLM hybrids are not a judge of their own here
  if (c.mode !== "swarm-rules" && c.mode !== "swarm-jev" && c.mode !== "swarm-llm") return null;

  const solveModels = new Map<string, number>();
  const judgeModels = new Map<string, number>();
  let judgeCalls = 0;
  let judgeUsd = 0;
  for (const e of await lines(join(runsDir, runId, "ledger.jsonl"))) {
    const model = String(e.model ?? "");
    const usd = Number((e.usage as { costUsd?: number } | undefined)?.costUsd ?? 0);
    if (e.purpose === "solve") solveModels.set(model, (solveModels.get(model) ?? 0) + 1);
    if (JUDGE_PURPOSES.has(String(e.purpose))) {
      judgeModels.set(model, (judgeModels.get(model) ?? 0) + 1);
      judgeCalls++;
      judgeUsd += usd;
    }
  }
  const judge = c.mode === "swarm-rules" ? "规则" : c.mode === "swarm-jev" ? "Jev" : name(top(judgeModels));
  const summary = JSON.parse(await readFile(join(runsDir, runId, "summary.json"), "utf8")) as { metrics?: Record<string, number> };
  const m = summary.metrics ?? (summary as Record<string, number>);
  const outcomes = new Map<string, boolean>();
  for (const e of events) if (e.type === "task.accepted") outcomes.set(String(e.taskId), e.correct === true);
  return {
    runId,
    executor: name(top(solveModels)),
    judge,
    correct: Number(m.correct),
    n: 96,
    costUsd: Number(m.costUsd),
    wallS: Number(m.elapsedMs) / 1000,
    judgeCalls,
    judgeUsd,
    outcomes,
  };
}

function mcnemar(a: Map<string, boolean>, b: Map<string, boolean>): [number, number, number] {
  let x = 0;
  let y = 0;
  for (const [id, ok] of a) {
    if (ok && !b.get(id)) x++;
    if (!ok && b.get(id)) y++;
  }
  const n = x + y;
  let tail = 0;
  let c = 1;
  for (let i = 0; i <= Math.min(x, y); i++) {
    tail += c;
    c = (c * (n - i)) / (i + 1);
  }
  return [x, y, n === 0 ? 1 : Math.min(1, (2 * tail) / 2 ** n)];
}

const cells = new Map<string, Cell>();
for (const runId of (await readdir(runsDir)).sort()) {
  const cell = await classify(runId);
  // Later runs of the same cell win; run ids sort by time.
  if (cell) cells.set(`${cell.executor}|${cell.judge}`, cell);
}
const executors = [...new Set([...cells.values()].map((c) => c.executor))].sort();

console.log(`seed ${seed} · 96 hard tasks · 8 cells\n`);
console.log(`| 执行者 \\ 判断者 | ${JUDGES.join(" | ")} |`);
console.log(`|---|${JUDGES.map(() => "---").join("|")}|`);
for (const ex of executors) {
  const row = JUDGES.map((j) => {
    const c = cells.get(`${ex}|${j}`);
    return c ? `${c.correct}/96 · $${c.costUsd.toFixed(3)} · ${Math.round(c.wallS)}s` : "—";
  });
  console.log(`| ${ex} | ${row.join(" | ")} |`);
}
console.log("");
for (const ex of executors) {
  const jev = cells.get(`${ex}|Jev`);
  if (!jev) continue;
  for (const j of JUDGES) {
    const c = cells.get(`${ex}|${j}`);
    if (!c || j === "Jev") continue;
    const [x, y, p] = mcnemar(jev.outcomes, c.outcomes);
    console.log(`${ex}: Jev vs ${j} ${x}:${y} p=${p.toFixed(3)} · judge $${jev.judgeUsd.toFixed(4)} vs $${c.judgeUsd.toFixed(4)}`);
  }
}

if (values.json) {
  const out = [...cells.values()].map(({ outcomes, ...c }) => ({ ...c, wallS: Math.round(c.wallS * 10) / 10 }));
  await writeFile(values.json, `${JSON.stringify({ seed, cells: out }, null, 2)}\n`);
}
