import { describe, expect, it } from "vitest";
import { MARK } from "../core/types";
import type { LLM, LLMRequest, Task } from "../core/types";
import { MockLLM, MockOracle } from "../providers/mock";
import { runSubagent, toReportLine } from "./subagent";

const tasks: Task[] = Array.from({ length: 70 }, (_, i) => ({ id: `t${i + 1}`, domain: "arithmetic", prompt: `What is ${i} + 2?`, answer: String(i + 2) }));
const publicTasks = tasks.map(({ id, domain, prompt }) => ({ id, domain, prompt }));

describe("toReportLine", () => {
  it("collapses a reply into one prefixed line", () => {
    expect(toReportLine("t1", "added\nANSWER: 3")).toBe(`${MARK.taskId} t1 report: added ANSWER: 3`);
    expect(toReportLine("t1", "TASK t1 report: added ANSWER: 3")).toBe("TASK t1 report: added ANSWER: 3");
  });
});

describe("runSubagent", () => {
  it("runs one worker per task within the concurrency cap, then merges in chunks of 64", async () => {
    const calls: LLMRequest[] = [];
    let active = 0;
    let peak = 0;
    const llm: LLM = {
      id: "fake",
      simulated: true,
      async complete(req) {
        calls.push(req);
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 1));
        active--;
        const text =
          req.meta.purpose === "report"
            ? `${MARK.taskId} ${req.meta.taskId} report: added ${MARK.answer} 1`
            : (req.messages.at(-1)?.content ?? "")
                .split("\n")
                .map((l) => l.replace(/ report: .*$/, `: ${MARK.answer} 5`))
                .join("\n");
        return { text, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, latencyMs: 0, model: "f" };
      },
    };
    const answers = await runSubagent({ runId: "r", tasks: publicTasks, llm, concurrency: 4 });
    const reports = calls.filter((c) => c.meta.purpose === "report");
    const merges = calls.filter((c) => c.meta.purpose === "merge");
    expect(reports).toHaveLength(70);
    expect(reports.every((c) => c.meta.taskId !== undefined)).toBe(true);
    expect(peak).toBeLessThanOrEqual(4);
    expect(merges.map((m) => m.messages.at(-1)?.content.split("\n").length)).toEqual([64, 6]);
    expect(answers.size).toBe(70);
    expect(answers.get("t70")).toBe("5");
  });

  it("scores only what the coordinator wrote: the simulated merge loses answers", async () => {
    const llm = new MockLLM({ oracle: new MockOracle(tasks), seed: 5, latencyMs: [0, 0] });
    const answers = await runSubagent({ runId: "r", tasks: publicTasks, llm, concurrency: 8 });
    const correct = tasks.filter((t) => answers.get(t.id) === t.answer).length;
    expect(answers.size).toBe(70);
    expect(correct / 70).toBeLessThan(0.75);
    expect(correct / 70).toBeGreaterThan(0.3);
  });
});
