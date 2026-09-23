import { MARK } from "../core/types";
import type { LLM, PublicTask } from "../core/types";
import { Semaphore } from "../providers/limiter";
import { SOLVE_SYSTEM } from "../swarm/cell";

export const DEFAULT_VOTE_K = 5;
export const MAX_VOTE_K = 15;

/** A cell's solve prompt without genes or teammates: each sample is one independent single-agent attempt. */
export function votePrompt(t: PublicTask): string {
  return `${MARK.domain} ${t.domain}\n${t.prompt}\nReply with one line starting with ${MARK.method} (max 30 words) and a final line ${MARK.answer} <answer>.`;
}

/** Samples per task (pilot included) that fit the budget, given the pilot's mean tokens per sample. */
export function voteK(budgetTokens: number, meanTokens: number, tasks: number): number {
  if (budgetTokens <= 0) return DEFAULT_VOTE_K;
  return Math.min(MAX_VOTE_K, Math.max(1, Math.floor(budgetTokens / (meanTokens * tasks))));
}

/** Most frequent non-empty answer; a tie goes to the answer that appeared in the earliest sample. */
export function majority(answers: readonly string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const a of answers) if (a) counts.set(a, (counts.get(a) ?? 0) + 1);
  let best: string | undefined;
  let bestCount = 0;
  for (const [a, c] of counts) {
    if (c > bestCount) {
      best = a;
      bestCount = c;
    }
  }
  return best;
}

/**
 * The fair same-budget baseline: every task solved independently k times, majority vote.
 * With a budget, one pilot sample per task measures the mean cost and sizes k to fit.
 */
export async function runSingleVote(p: {
  runId: string;
  tasks: PublicTask[];
  llm: LLM;
  budgetTokens: number;
  concurrency: number;
  normalize: (s: string) => string;
  extract: (text: string) => string;
}): Promise<{ answers: Map<string, string>; k: number; samples: number }> {
  if (p.tasks.length === 0) return { answers: new Map(), k: 0, samples: 0 };
  const limiter = new Semaphore(Math.max(1, Math.floor(p.concurrency)));
  // Indexed by sample number, not completion order, so the tie-break is deterministic.
  const votes = new Map<string, string[]>(p.tasks.map((t) => [t.id, []]));
  let samples = 0;
  let failed = false;

  const sample = (t: PublicTask, index: number) =>
    limiter.run(async () => {
      // After one failure (e.g. the cost cap) queued samples must not keep spending.
      if (failed) throw new Error("single-vote: skipped after an earlier sample failed");
      try {
        const r = await p.llm.complete({
          messages: [
            { role: "system", content: SOLVE_SYSTEM },
            { role: "user", content: votePrompt(t) },
          ],
          maxTokens: 600,
          temperature: 0.7,
          meta: { runId: p.runId, purpose: "solve", taskId: t.id },
        });
        samples++;
        (votes.get(t.id) ?? [])[index] = p.normalize(p.extract(r.text));
        return r.usage.inputTokens + r.usage.outputTokens;
      } catch (err) {
        failed = true;
        throw err;
      }
    });
  const round = (from: number, to: number) =>
    Promise.all(Array.from({ length: Math.max(0, to - from) }, (_, i) => p.tasks.map((t) => sample(t, from + i))).flat());

  let k = DEFAULT_VOTE_K;
  if (p.budgetTokens <= 0) await round(0, k);
  else {
    const pilot = await round(0, 1);
    k = voteK(p.budgetTokens, pilot.reduce((a, b) => a + b, 0) / pilot.length, p.tasks.length);
    await round(1, k);
  }

  const answers = new Map<string, string>();
  for (const t of p.tasks) {
    const winner = majority(votes.get(t.id) ?? []);
    if (winner !== undefined) answers.set(t.id, winner);
  }
  return { answers, k, samples };
}
