import { MARK, QK, UNCLEAR_CHOICE } from "../core/types";
import type { Answer, PublicTask, Question } from "../core/types";
import { confidenceOf } from "./confidence";

export interface DisputeCandidate {
  /** Choice key, e.g. "a1"; must not equal UNCLEAR_CHOICE. */
  key: string;
  answer: string;
  summary: string;
}

const SUMMARY_CHARS = 120;
export const DISPUTE_INSTRUCTIONS =
  "Two or more cells disagree. Which answer is correct given the problem and each method?";
export const UNCLEAR_CRITERION = "neither is clearly right; another independent solve is needed";

/** One candidate per distinct answer, keeping the first proposer's method, keyed a1..aN. */
export function disputeCandidates(proposals: ReadonlyArray<{ answer: string; summary: string }>): DisputeCandidate[] {
  const byAnswer = new Map<string, DisputeCandidate>();
  for (const p of proposals) {
    if (!byAnswer.has(p.answer)) byAnswer.set(p.answer, { key: `a${byAnswer.size + 1}`, answer: p.answer, summary: p.summary });
  }
  return [...byAnswer.values()];
}

/** Asked under QK.dispute. UNCLEAR_CHOICE lets the judge decline instead of guessing. */
export function disputeQuestion(candidates: readonly DisputeCandidate[]): Question {
  const criteria: Record<string, string> = {};
  for (const c of candidates) criteria[c.key] = `answer ${oneLine(c.answer)}: ${clip(oneLine(c.summary), SUMMARY_CHARS)}`;
  criteria[UNCLEAR_CHOICE] = UNCLEAR_CRITERION;
  return { type: "choice", instructions: DISPUTE_INSTRUCTIONS, criteria };
}

export function buildDisputeState(task: PublicTask): string {
  return [`${MARK.domain} ${task.domain}`, `PROBLEM: ${task.prompt}`].join("\n");
}

/** undefined means "no winner": unclear, low confidence, or not a candidate; the task needs another solve. */
export function disputeWinner(
  answer: Answer | undefined,
  candidates: ReadonlyArray<{ key: string; answer: string }>,
  minConfidence: number,
): string | undefined {
  if (answer?.type !== "choice" || answer.choice === UNCLEAR_CHOICE) return undefined;
  if (confidenceOf(answer) < minConfidence) return undefined;
  return candidates.find((c) => c.key === answer.choice)?.answer;
}

/**
 * Safe default when every judge failed: re-solve rather than trust, never adopt an unvetted gene,
 * never settle a dispute. Other keys get a neutral, zero-confidence answer.
 */
export function conservativeAnswer(key: string, q: Question): Answer {
  if (key === QK.verify && q.type === "noul") return { type: "noul", noul: 1 };
  if (key === QK.adopt && q.type === "noul") return { type: "noul", noul: 0 };
  if (key === QK.dispute && q.type === "choice") {
    const keys = Object.keys(q.criteria);
    if (!keys.includes(UNCLEAR_CHOICE)) keys.push(UNCLEAR_CHOICE);
    return { type: "choice", choice: UNCLEAR_CHOICE, probabilities: uniform(keys), confidence: 0 };
  }
  switch (q.type) {
    case "noul":
      return { type: "noul", noul: 0.5 };
    case "choice": {
      const keys = Object.keys(q.criteria);
      return { type: "choice", choice: keys[0] ?? "", probabilities: uniform(keys), confidence: 0 };
    }
    case "score":
      return { type: "score", score: Math.max(0, Math.floor((q.criteria.length - 1) / 2)), confidence: 0 };
  }
}

function uniform(keys: string[]): Record<string, number> {
  return Object.fromEntries(keys.map((k) => [k, 1 / keys.length]));
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
