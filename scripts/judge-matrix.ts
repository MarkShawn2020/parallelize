// Executor x judge matrix: the same swarm on the same tasks, varying only who solves and who makes the coordination
// judgments. Scans runs/ for real runs of the chosen seeds, classifies each by the models its ledger actually billed,
// pools the seeds per cell (paired by seed and task), and prints one table plus paired McNemar tests against the Jev
// judge in each executor row, Holm-corrected within the row. Run: pnpm matrix [--seeds 7,11] [--json out.json]
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
const EXECUTOR_ORDER = ["Haiku 4.5", "Sonnet 5"];
const JUDGE_PURPOSES = new Set(["verify", "adopt", "adjudicate", "claim"]);
const TASKS = 96;

interface Run {
  runId: string;
  seed: number;
  executor: string;
  judge: string;
  correct: number;
  costUsd: number;
  wallS: number;
  judgeCalls: number;
  judgeUsd: number;
  /** Executor calls: solving (first attempts and re-solves for review) and gene writing. */
  solveCalls: number;
  geneCalls: number;
  outcomes: Map<string, boolean>;
}

const { values } = parseArgs({ options: { seeds: { type: "string" }, seed: { type: "string" }, json: { type: "string" } } });
const seeds = (values.seeds ?? values.seed ?? "7").split(",").map((s) => Number(s.trim()));
const runsDir = join(PROJECT_ROOT, "runs");

const lines = async (path: string) =>
  (await readFile(path, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
const top = (counts: Map<string, number>) => [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
const name = (model: string) => MODEL_NAMES[model] ?? model;
const round = (x: number, digits: number) => Number(x.toFixed(digits));

async function classify(runId: string): Promise<Run | null> {
  const events = await lines(join(runsDir, runId, "events.jsonl")).catch(() => null);
  const started = events?.find((e) => e.type === "run.started") as { config: Record<string, unknown>; simulated?: boolean } | undefined;
  if (!events || !started || started.simulated) return null;
  const c = started.config;
  const source = c.taskSource as { kind?: string; difficulty?: string } | undefined;
  if (!seeds.includes(Number(c.seed)) || c.n !== TASKS || c.cells !== 8 || source?.kind !== "synthetic" || source.difficulty !== "hard") return null;
  if (c.mode === "swarm-jev" && c.escalationThreshold !== 0) return null; // Jev + LLM hybrids are not a judge of their own here
  if (c.mode !== "swarm-rules" && c.mode !== "swarm-jev" && c.mode !== "swarm-llm") return null;
  if (!events.some((e) => e.type === "run.finished")) return null;

  const solveModels = new Map<string, number>();
  const judgeModels = new Map<string, number>();
  let judgeCalls = 0;
  let judgeUsd = 0;
  let solveCalls = 0;
  let geneCalls = 0;
  for (const e of await lines(join(runsDir, runId, "ledger.jsonl"))) {
    if (e.purpose === "solve") solveCalls++;
    if (e.purpose === "gene") geneCalls++;
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
  for (const e of events) if (e.type === "task.accepted") outcomes.set(`${String(c.seed)}:${String(e.taskId)}`, e.correct === true);
  return {
    runId,
    seed: Number(c.seed),
    executor: name(top(solveModels)),
    judge,
    correct: Number(m.correct),
    costUsd: Number(m.costUsd),
    wallS: Number(m.elapsedMs) / 1000,
    judgeCalls,
    judgeUsd,
    solveCalls,
    geneCalls,
    outcomes,
  };
}

function mcnemar(a: Map<string, boolean>, b: Map<string, boolean>): { onlyA: number; onlyB: number; p: number } {
  let onlyA = 0;
  let onlyB = 0;
  for (const [id, ok] of a) {
    if (ok && !b.get(id)) onlyA++;
    if (!ok && b.get(id)) onlyB++;
  }
  const n = onlyA + onlyB;
  let tail = 0;
  let c = 1;
  for (let i = 0; i <= Math.min(onlyA, onlyB); i++) {
    tail += c;
    c = (c * (n - i)) / (i + 1);
  }
  return { onlyA, onlyB, p: n === 0 ? 1 : Math.min(1, (2 * tail) / 2 ** n) };
}

// Later runs of the same cell and seed win; run ids sort by time.
const bySeed = new Map<string, Run>();
for (const runId of (await readdir(runsDir)).sort()) {
  const run = await classify(runId);
  if (run) bySeed.set(`${run.executor}|${run.judge}|${run.seed}`, run);
}

interface Cell {
  executor: string;
  judge: string;
  runIds: string[];
  correct: number;
  n: number;
  /** Means per 96-task run. */
  costUsd: number;
  wallS: number;
  judgeCalls: number;
  judgeUsd: number;
  solveCalls: number;
  geneCalls: number;
  outcomes: Map<string, boolean>;
}

const cells = new Map<string, Cell>();
for (const ex of EXECUTOR_ORDER) {
  for (const j of JUDGES) {
    const runs = seeds.map((s) => bySeed.get(`${ex}|${j}|${s}`));
    if (runs.some((r) => !r)) continue; // a cell counts only when every requested seed has run
    const rs = runs as Run[];
    const mean = (f: (r: Run) => number) => rs.reduce((s, r) => s + f(r), 0) / rs.length;
    cells.set(`${ex}|${j}`, {
      executor: ex,
      judge: j,
      runIds: rs.map((r) => r.runId),
      correct: rs.reduce((s, r) => s + r.correct, 0),
      n: TASKS * rs.length,
      costUsd: mean((r) => r.costUsd),
      wallS: mean((r) => r.wallS),
      judgeCalls: mean((r) => r.judgeCalls),
      judgeUsd: mean((r) => r.judgeUsd),
      solveCalls: mean((r) => r.solveCalls),
      geneCalls: mean((r) => r.geneCalls),
      outcomes: new Map(rs.flatMap((r) => [...r.outcomes])),
    });
  }
}

/** Holm step-down adjustment over one family of p values, returned in input order. */
function holm(ps: number[]): number[] {
  const order = ps.map((p, i) => [p, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(ps.length).fill(1);
  let running = 0;
  order.forEach(([p, i], rank) => {
    running = Math.max(running, Math.min(1, (ps.length - rank) * p));
    out[i] = running;
  });
  return out;
}

// Each executor row is one family: Jev against every other judge.
const tests: Array<{ executor: string; a: string; b: string; onlyA: number; onlyB: number; p: number; pHolm: number }> = [];
for (const ex of EXECUTOR_ORDER) {
  const jev = cells.get(`${ex}|Jev`);
  if (!jev) continue;
  const row = JUDGES.flatMap((j) => {
    const c = cells.get(`${ex}|${j}`);
    return c && j !== "Jev" ? [{ executor: ex, a: "Jev", b: j, ...mcnemar(jev.outcomes, c.outcomes) }] : [];
  });
  const adjusted = holm(row.map((t) => t.p));
  row.forEach((t, i) => tests.push({ ...t, pHolm: adjusted[i] ?? 1 }));
}

console.log(`seeds ${seeds.join(", ")} · ${TASKS} hard tasks per run · 8 cells · cost and time are means per run\n`);
console.log(`| 执行者 \\ 判断者 | ${JUDGES.join(" | ")} |`);
console.log(`|---|${JUDGES.map(() => "---").join("|")}|`);
for (const ex of EXECUTOR_ORDER) {
  const row = JUDGES.map((j) => {
    const c = cells.get(`${ex}|${j}`);
    return c ? `${c.correct}/${c.n} · $${c.costUsd.toFixed(3)} · ${Math.round(c.wallS)}s` : "—";
  });
  if (row.some((r) => r !== "—")) console.log(`| ${ex} | ${row.join(" | ")} |`);
}
console.log("");
for (const t of tests) console.log(`${t.executor}: Jev vs ${t.b} ${t.onlyA}:${t.onlyB} p=${t.p.toFixed(3)} holm=${t.pHolm.toFixed(3)}`);

if (values.json) {
  const out = {
    seeds,
    tasksPerRun: TASKS,
    judges: JUDGES,
    executors: EXECUTOR_ORDER.filter((ex) => JUDGES.some((j) => cells.has(`${ex}|${j}`))),
    cells: [...cells.values()].map(({ outcomes, ...c }) => ({
      ...c,
      costUsd: round(c.costUsd, 4),
      wallS: round(c.wallS, 1),
      judgeCalls: round(c.judgeCalls, 1),
      judgeUsd: round(c.judgeUsd, 5),
      solveCalls: round(c.solveCalls, 1),
      geneCalls: round(c.geneCalls, 1),
    })),
    tests: tests.map((t) => ({ ...t, p: round(t.p, 4), pHolm: round(t.pHolm, 4) })),
  };
  await writeFile(values.json, `${JSON.stringify(out, null, 2)}\n`);
}
