import { MARK } from "../core/types";
import type { LLM, PublicTask } from "../core/types";
import { extractFinalAnswer } from "../tasks/check";

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ANSWER_LINE = new RegExp(`\\b${escapeRe(MARK.taskId)}\\s+([A-Za-z0-9_-]+)\\s*:.*?${escapeRe(MARK.answer)}\\s*(.+)$`);

/** Parses "TASK <id>: ... ANSWER: <value>" lines; the last occurrence per id wins, unknown ids are ignored. */
export function parseBatchedAnswers(text: string, ids: Iterable<string>): Map<string, string> {
  const known = new Set(ids);
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = ANSWER_LINE.exec(line);
    const id = m?.[1];
    const tail = m?.[2];
    if (id === undefined || tail === undefined || !known.has(id)) continue;
    const answer = extractFinalAnswer(`${MARK.answer} ${tail}`);
    if (answer !== "") out.set(id, answer);
  }
  return out;
}

export function taskLines(tasks: PublicTask[]): string {
  return tasks.map((t) => `${MARK.taskId} ${t.id}: ${t.prompt.replace(/\s+/g, " ").trim()}`).join("\n");
}

/** Baseline: every problem in one context window, one call. */
export async function runSingle(p: { runId: string; tasks: PublicTask[]; llm: LLM }): Promise<Map<string, string>> {
  const r = await p.llm.complete({
    messages: [
      {
        role: "system",
        content: `Solve every problem independently. For each problem write at most two short lines of work, then a line exactly '${MARK.taskId} <id>: ${MARK.answer} <number>'.`,
      },
      { role: "user", content: taskLines(p.tasks) },
    ],
    maxTokens: Math.min(32_000, 200 + 160 * p.tasks.length),
    meta: { runId: p.runId, purpose: "single" },
  });
  return parseBatchedAnswers(
    r.text,
    p.tasks.map((t) => t.id),
  );
}
