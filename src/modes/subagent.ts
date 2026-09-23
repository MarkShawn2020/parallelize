import { MARK, SUMMARY_TOKEN_BUDGET } from "../core/types";
import type { LLM, PublicTask } from "../core/types";
import { Semaphore } from "../providers/limiter";
import { parseBatchedAnswers } from "./single";

const MERGE_CHUNK = 64;
const REPORT_MAX_CHARS = SUMMARY_TOKEN_BUDGET * 4;

/** Collapses a worker reply into the one-line report shape the coordinator is told to expect. */
export function toReportLine(taskId: string, text: string): string {
  const prefix = `${MARK.taskId} ${taskId} report:`;
  const line = text.replace(/\s+/g, " ").trim();
  return (line.startsWith(prefix) ? line : `${prefix} ${line}`).slice(0, REPORT_MAX_CHARS);
}

/**
 * EvoMap's Sub-Agent baseline: one worker per task, then a coordinator rewrites the reports into
 * final answers. Only the coordinator's output is scored, so its lossy merge is what gets measured.
 */
export async function runSubagent(p: {
  runId: string;
  tasks: PublicTask[];
  llm: LLM;
  concurrency: number;
}): Promise<Map<string, string>> {
  const limiter = new Semaphore(Math.max(1, Math.floor(p.concurrency)));
  const reports = await Promise.all(
    p.tasks.map((t) =>
      limiter.run(async () => {
        const r = await p.llm.complete({
          messages: [
            {
              role: "system",
              content: `You are a worker agent. Solve the problem, then report in exactly one line: '${MARK.taskId} ${t.id} report: <method in a few words> ${MARK.answer} <number>'.`,
            },
            { role: "user", content: `${MARK.taskId} ${t.id}: ${t.prompt}` },
          ],
          maxTokens: 400,
          meta: { runId: p.runId, purpose: "report", taskId: t.id },
        });
        return toReportLine(t.id, r.text);
      }),
    ),
  );

  const answers = new Map<string, string>();
  const ids = p.tasks.map((t) => t.id);
  for (let i = 0; i < reports.length; i += MERGE_CHUNK) {
    const chunk = reports.slice(i, i + MERGE_CHUNK);
    const r = await p.llm.complete({
      messages: [
        {
          role: "system",
          content: `You are the coordinator. From the worker reports, write the final answer for every task as '${MARK.taskId} <id>: ${MARK.answer} <number>'.`,
        },
        { role: "user", content: chunk.join("\n") },
      ],
      maxTokens: Math.min(8000, 200 + 40 * chunk.length),
      meta: { runId: p.runId, purpose: "merge" },
    });
    for (const [id, answer] of parseBatchedAnswers(r.text, ids)) answers.set(id, answer);
  }
  return answers;
}
