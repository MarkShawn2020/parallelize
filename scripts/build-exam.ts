// Builds web/public/exam/hard-96.json: the 96 hard tasks of the 2026-09-23 comparison with their exact answers and
// what each of the seven runs answered. Tasks are regenerated from the seed and checked against the prompts the runs
// actually saw, so the bank cannot drift from the evidence. Run: pnpm exam:build
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PROJECT_ROOT } from "../src/config";
import { createTaskSource } from "../src/tasks";

const RUNS: ReadonlyArray<[string, string]> = [
  ["single", "single-20260923-152044-53da"],
  ["single-vote", "single-vote-20260923-152143-6b9c"],
  ["subagent", "subagent-20260923-152348-20ea"],
  ["swarm-solo", "swarm-solo-20260923-152701-d944"],
  ["swarm-rules", "swarm-rules-20260923-152617-a404"],
  ["swarm-llm", "swarm-llm-20260923-152436-632f"],
  ["swarm-jev", "swarm-jev-20260923-151902-323c"],
];
const N = 96;
const SEED = 7;

type Result = { answer: string; correct: boolean; sources: number } | null;

async function events(runId: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(join(PROJECT_ROOT, "runs", runId, "events.jsonl"), "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const tasks = await createTaskSource({ kind: "synthetic", difficulty: "hard" }).load(N, SEED);
const results = new Map<string, Record<string, Result>>(tasks.map((t) => [t.id, {}]));

for (const [mode, runId] of RUNS) {
  const evs = await events(runId);
  const started = evs.find((e) => e.type === "run.started") as { tasks: Array<{ id: string; prompt: string }> } | undefined;
  if (!started) throw new Error(`${runId}: no run.started`);
  for (const t of tasks) {
    const seen = started.tasks.find((x) => x.id === t.id);
    if (seen?.prompt !== t.prompt) throw new Error(`${runId}: ${t.id} differs from the regenerated task`);
  }
  for (const t of tasks) (results.get(t.id) ?? {})[mode] = null;
  for (const e of evs) {
    if (e.type !== "task.accepted") continue;
    const row = results.get(String(e.taskId));
    if (row) row[mode] = { answer: String(e.answer), correct: e.correct === true, sources: Number(e.independentSources) };
  }
}

const bank = {
  title: "2026-09-23 主对照 · 96 道困难题",
  seed: SEED,
  model: "anthropic/claude-haiku-4.5",
  runs: Object.fromEntries(RUNS),
  tasks: tasks.map((t) => ({ id: t.id, domain: t.domain, prompt: t.prompt, answer: t.answer, results: results.get(t.id) ?? {} })),
};

const out = join(PROJECT_ROOT, "web", "public", "exam");
await mkdir(out, { recursive: true });
await writeFile(join(out, "hard-96.json"), `${JSON.stringify(bank)}\n`);
const right = (mode: string) => bank.tasks.filter((t) => t.results[mode]?.correct).length;
console.log(`wrote ${bank.tasks.length} tasks; correct per run: ${RUNS.map(([m]) => `${m} ${right(m)}`).join(", ")}`);
