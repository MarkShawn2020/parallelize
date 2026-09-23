// Builds web/public/race/hard-96.json: compact timelines of the 2026-09-23 runs that the landing page's three-lane
// race replays side by side (single agent, the EvoMap-protocol swarm judged by rules or by the LLM, the Jev swarm).
// Every number comes from the runs' own events.jsonl; times are milliseconds since each run started. Run: pnpm race:build
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PROJECT_ROOT } from "../src/config";

const RUNS: ReadonlyArray<[string, string]> = [
  ["single", "single-20260923-152044-53da"],
  ["swarm-rules", "swarm-rules-20260923-152617-a404"],
  ["swarm-llm", "swarm-llm-20260923-152436-632f"],
  ["swarm-jev", "swarm-jev-20260923-151902-323c"],
];
const JUDGE_KEYS = ["verify", "adopt", "dispute", "claim"] as const;

type Ev = Record<string, unknown> & { type: string; at: number };

const round = (x: number, digits: number) => Number(x.toFixed(digits));
const cellNo = (id: unknown) => Number(/(\d+)$/.exec(String(id))?.[1] ?? 0);

async function events(runId: string): Promise<Ev[]> {
  const text = await readFile(join(PROJECT_ROOT, "runs", runId, "events.jsonl"), "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Ev);
}

let ids: string[] | null = null;
const runs: Record<string, unknown> = {};

for (const [mode, runId] of RUNS) {
  const evs = await events(runId);
  const started = evs.find((e) => e.type === "run.started") as (Ev & { tasks: Array<{ id: string }> }) | undefined;
  const finished = evs.find((e) => e.type === "run.finished");
  if (!started || !finished) throw new Error(`${runId}: missing run.started or run.finished`);
  const order = started.tasks.map((t) => t.id);
  if (!ids) ids = order;
  else if (order.join() !== ids.join()) throw new Error(`${runId}: task list differs from the first run`);
  const idx = new Map(order.map((id, i) => [id, i]));
  const t0 = started.at;
  const t = (e: Ev) => e.at - t0;
  const at = (e: Ev) => {
    const i = idx.get(String(e.taskId));
    if (i === undefined) throw new Error(`${runId}: unknown task ${String(e.taskId)}`);
    return i;
  };

  const acc: number[][] = [];
  const claim: number[][] = [];
  const ver: number[][] = [];
  const judge: number[][] = [];
  const adopt: number[] = [];
  const cost: number[][] = [];
  const guard: Array<[number, string, number, number]> = [];
  let last: Record<string, number> = {};

  for (const e of evs) {
    switch (e.type) {
      case "task.accepted":
        acc.push([t(e), at(e), e.correct === true ? 1 : 0, Number(e.independentSources)]);
        break;
      case "task.claimed":
        claim.push([t(e), at(e), cellNo(e.cellId)]);
        break;
      case "task.verifying":
        ver.push([t(e), at(e), cellNo(e.cellId)]);
        break;
      case "gene.adopted":
        adopt.push(t(e));
        break;
      case "judge.decision": {
        const d = e.decision as { key: string; tier: string; cellId: string; latencyMs: number; usage?: { costUsd?: number } };
        const k = JUDGE_KEYS.indexOf(d.key as (typeof JUDGE_KEYS)[number]);
        if (k < 0) throw new Error(`${runId}: unknown judgment key ${d.key}`);
        judge.push([t(e), k, d.tier === "system1" ? 1 : 2, cellNo(d.cellId), Math.round(d.latencyMs), round(d.usage?.costUsd ?? 0, 7)]);
        break;
      }
      case "judge.guard":
        guard.push([t(e), String(e.key), Number(e.disagreement), Number(e.window)]);
        break;
      case "metrics": {
        const m = e.metrics as Record<string, number>;
        const usd = round(m.costUsd ?? 0, 5);
        if (usd !== cost.at(-1)?.[1]) cost.push([t(e), usd]);
        last = m;
        break;
      }
    }
  }
  if (acc.length !== order.length) throw new Error(`${runId}: ${acc.length} accepted of ${order.length}`);
  const cells = evs.filter((e) => e.type === "cell.spawned").length || 1;
  runs[mode] = {
    runId,
    mode,
    cells,
    durationMs: finished.at - t0,
    acc,
    claim,
    ver,
    judge,
    adopt,
    cost,
    guard,
    final: {
      correct: acc.filter((a) => a[2] === 1).length,
      costUsd: round(last.costUsd ?? 0, 5),
      auditable: acc.filter((a) => (a[3] ?? 0) >= 2).length,
    },
  };
}

const race = {
  title: "2026-09-23 主对照 · 96 道困难题",
  model: "anthropic/claude-haiku-4.5",
  judgeModel: "typesafe/jev-1.13",
  judgeKeys: JUDGE_KEYS,
  ids,
  runs,
};

const out = join(PROJECT_ROOT, "web", "public", "race");
await mkdir(out, { recursive: true });
const body = `${JSON.stringify(race)}\n`;
await writeFile(join(out, "hard-96.json"), body);
console.log(
  `wrote ${Math.round(body.length / 1024)} KB; ${RUNS.map(([m]) => {
    const r = runs[m] as { final: { correct: number; costUsd: number }; durationMs: number; judge: unknown[] };
    return `${m} ${r.final.correct}/96 $${r.final.costUsd} ${Math.round(r.durationMs / 1000)}s ${r.judge.length} judgments`;
  }).join(" · ")}`,
);
