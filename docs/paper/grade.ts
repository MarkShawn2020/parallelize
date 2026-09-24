// Grades answers against the synthetic hard tasks the paper's runs used, with the checker the swarm itself uses.
// stdin: [{ "seed": 7, "taskId": "t001", "answer": "42" }, ...]   stdout: [true, false, ...] in the same order.
// Run from the repo root: node_modules/.bin/tsx docs/paper/grade.ts < pairs.json
import { checkAnswer } from "../../src/tasks/check";
import { SyntheticTaskSource } from "../../src/tasks/synthetic";

const TASKS = 96;
const source = new SyntheticTaskSource({ difficulty: "hard" });
const expected = new Map<number, Map<string, string>>();

let input = "";
for await (const chunk of process.stdin) input += String(chunk);
const pairs = JSON.parse(input) as Array<{ seed: number; taskId: string; answer: string }>;

for (const seed of new Set(pairs.map((p) => p.seed))) {
  expected.set(seed, new Map((await source.load(TASKS, seed)).map((t) => [t.id, t.answer])));
}
const verdicts = pairs.map(({ seed, taskId, answer }) => {
  const want = expected.get(seed)?.get(taskId);
  if (want === undefined) throw new Error(`no task ${taskId} for seed ${seed}`);
  return checkAnswer(want, answer);
});
process.stdout.write(`${JSON.stringify(verdicts)}\n`);
