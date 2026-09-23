import { describe, expect, it } from "vitest";
import type { LLM, LLMRequest, Task } from "../core/types";
import { MockLLM, MockOracle } from "../providers/mock";
import { parseBatchedAnswers, runSingle, taskLines } from "./single";

const tasks: Task[] = Array.from({ length: 20 }, (_, i) => ({ id: `t${i + 1}`, domain: "arithmetic", prompt: `What is ${i} + 1?`, answer: String(i + 1) }));
const publicTasks = tasks.map(({ id, domain, prompt }) => ({ id, domain, prompt }));

describe("parseBatchedAnswers", () => {
  it("reads TASK lines, keeps the last occurrence and ignores unknown ids", () => {
    const text = [
      "t1 is easy.",
      "TASK t1: ANSWER: 3",
      "**TASK t2:** 5 + 5 = 10, ANSWER: 10 apples",
      "TASK t1: rechecked. ANSWER: 4",
      "TASK t9: ANSWER: 1",
      "TASK t3: ANSWER:",
    ].join("\n");
    expect(parseBatchedAnswers(text, ["t1", "t2", "t3"])).toEqual(
      new Map([
        ["t1", "4"],
        ["t2", "10"],
      ]),
    );
  });

  it("formats one TASK line per problem", () => {
    expect(taskLines([{ id: "t1", domain: "logic", prompt: "a\n b" }])).toBe("TASK t1: a b");
  });
});

describe("runSingle", () => {
  it("sends every problem in one call with a size-scaled token budget", async () => {
    const seen: LLMRequest[] = [];
    const llm: LLM = {
      id: "fake",
      simulated: true,
      async complete(req) {
        seen.push(req);
        return { text: "TASK t1: ANSWER: 1\nTASK t2: ANSWER: 7", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, latencyMs: 0, model: "f" };
      },
    };
    const answers = await runSingle({ runId: "r", tasks: publicTasks, llm });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.meta).toEqual({ runId: "r", purpose: "single" });
    expect(seen[0]?.maxTokens).toBe(200 + 160 * 20);
    expect(seen[0]?.messages.at(-1)?.content.split("\n")).toHaveLength(20);
    expect(answers).toEqual(
      new Map([
        ["t1", "1"],
        ["t2", "7"],
      ]),
    );
  });

  it("round-trips with the simulated LLM", async () => {
    const llm = new MockLLM({ oracle: new MockOracle(tasks), seed: 3, latencyMs: [0, 0] });
    const answers = await runSingle({ runId: "r", tasks: publicTasks, llm });
    expect(answers.size).toBe(20);
    const correct = tasks.filter((t) => answers.get(t.id) === t.answer).length;
    expect(correct).toBeGreaterThanOrEqual(15);
  });
});
