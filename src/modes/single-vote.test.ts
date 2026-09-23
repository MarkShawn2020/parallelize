import { describe, expect, it } from "vitest";
import type { LLM, LLMRequest, PublicTask, Task } from "../core/types";
import { MARK } from "../core/types";
import { MockLLM, MockOracle } from "../providers/mock";
import { SOLVE_SYSTEM } from "../swarm/cell";
import { extractFinalAnswer, normalizeAnswer } from "../tasks/check";
import { DEFAULT_VOTE_K, MAX_VOTE_K, majority, runSingleVote, voteK, votePrompt } from "./single-vote";

const tasks: PublicTask[] = Array.from({ length: 4 }, (_, i) => ({ id: `t${i + 1}`, domain: "arithmetic", prompt: `What is ${i} + 1?` }));

/** Answers come from `answerAt(taskId, sampleIndex)`; every call costs `tokens` in total. */
function fakeLLM(opts: { tokens?: number; answerAt?: (taskId: string, i: number) => string; delayAt?: (i: number) => number } = {}) {
  const seen: LLMRequest[] = [];
  const perTask = new Map<string, number>();
  const llm: LLM = {
    id: "fake",
    simulated: true,
    async complete(req) {
      seen.push(req);
      const taskId = req.meta.taskId ?? "";
      const i = perTask.get(taskId) ?? 0;
      perTask.set(taskId, i + 1);
      const delay = opts.delayAt?.(i) ?? 0;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      const tokens = opts.tokens ?? 100;
      const answer = opts.answerAt?.(taskId, i) ?? "7";
      return {
        text: `${MARK.method} added\n${MARK.answer} ${answer}`,
        usage: { inputTokens: tokens - 20, outputTokens: 20, costUsd: 0 },
        latencyMs: 0,
        model: "fake",
      };
    },
  };
  return { llm, seen };
}

const run = (llm: LLM, budgetTokens: number, concurrency = 8, list = tasks) =>
  runSingleVote({ runId: "run", tasks: list, llm, budgetTokens, concurrency, normalize: normalizeAnswer, extract: extractFinalAnswer });

describe("majority", () => {
  it("picks the most frequent non-empty answer and breaks ties by the earliest sample", () => {
    expect(majority(["a", "b", "b"])).toBe("b");
    expect(majority(["b", "a", "a", "b"])).toBe("b");
    expect(majority(["", "", "x"])).toBe("x");
    expect(majority(["", ""])).toBeUndefined();
    expect(majority([])).toBeUndefined();
  });
});

describe("voteK", () => {
  it("fits the budget, clamped to [1, 15]; no budget means 5", () => {
    expect(voteK(0, 100, 4)).toBe(DEFAULT_VOTE_K);
    expect(voteK(-1, 100, 4)).toBe(DEFAULT_VOTE_K);
    expect(voteK(2000, 100, 4)).toBe(5);
    expect(voteK(2399, 100, 4)).toBe(5);
    expect(voteK(100, 100, 4)).toBe(1);
    expect(voteK(1e9, 100, 4)).toBe(MAX_VOTE_K);
  });
});

describe("runSingleVote", () => {
  it("sends independent single-task solves with the cell prompt shape", async () => {
    const { llm, seen } = fakeLLM();
    const r = await run(llm, 0);
    expect(r.k).toBe(5);
    expect(r.samples).toBe(20);
    expect(seen).toHaveLength(20);
    const req = seen[0] as LLMRequest;
    expect(req.meta).toEqual({ runId: "run", purpose: "solve", taskId: "t1" });
    expect(req).toMatchObject({ maxTokens: 600, temperature: 0.7 });
    expect(req.messages).toEqual([
      { role: "system", content: SOLVE_SYSTEM },
      { role: "user", content: votePrompt(tasks[0] as PublicTask) },
    ]);
    expect(votePrompt(tasks[0] as PublicTask)).toBe(
      `${MARK.domain} arithmetic\nWhat is 0 + 1?\nReply with one line starting with ${MARK.method} (max 30 words) and a final line ${MARK.answer} <answer>.`,
    );
  });

  it("sizes k from the pilot's mean tokens per sample", async () => {
    for (const [budget, k] of [
      [2000, 5],
      [100, 1],
      [1e9, 15],
    ] as const) {
      const { llm, seen } = fakeLLM({ tokens: 100 });
      const r = await run(llm, budget);
      expect(r.k).toBe(k);
      expect(r.samples).toBe(k * tasks.length);
      expect(seen).toHaveLength(k * tasks.length);
    }
    // Pilot tokens vary per task: mean of 50, 150, 250, 350 = 200 -> k = floor(4000 / (200 * 4)) = 5.
    const costs: Record<string, number> = { t1: 50, t2: 150, t3: 250, t4: 350 };
    const seen: LLMRequest[] = [];
    const varied: LLM = {
      id: "v",
      simulated: true,
      async complete(req) {
        seen.push(req);
        const total = costs[req.meta.taskId ?? ""] ?? 0;
        return { text: `${MARK.answer} 1`, usage: { inputTokens: total, outputTokens: 0, costUsd: 0 }, latencyMs: 0, model: "v" };
      },
    };
    expect((await run(varied, 4000)).k).toBe(5);
  });

  it("majority-votes normalized answers with a deterministic tie-break despite completion order", async () => {
    const pattern = ["2", "1", "1.0", "2", "3"];
    // Later samples finish first, so completion order is the reverse of sample order.
    const { llm } = fakeLLM({ answerAt: (id, i) => (id === "t1" ? (pattern[i] ?? "") : id === "t2" ? "" : "9"), delayAt: (i) => (5 - i) * 3 });
    const r = await run(llm, 0, 100);
    expect(r.answers.get("t1")).toBe("2");
    expect(r.answers.has("t2")).toBe(false);
    expect(r.answers.get("t3")).toBe("9");
  });

  it("stops spending after a failed sample and propagates the error", async () => {
    let calls = 0;
    const llm: LLM = {
      id: "broken",
      simulated: true,
      async complete() {
        calls++;
        throw new Error("cost cap reached");
      },
    };
    await expect(run(llm, 0, 1)).rejects.toThrow("cost cap reached");
    expect(calls).toBe(1);
  });

  it("returns nothing for an empty task list", async () => {
    const { llm, seen } = fakeLLM();
    expect(await run(llm, 1000, 4, [])).toEqual({ answers: new Map(), k: 0, samples: 0 });
    expect(seen).toHaveLength(0);
  });

  it("beats a single sample on the mock LLM", async () => {
    const full: Task[] = Array.from({ length: 120 }, (_, i) => ({ id: `q${i}`, domain: "logic", prompt: `Puzzle ${i}`, answer: String(i + 3) }));
    const oracle = new MockOracle(full);
    const publicTasks = full.map(({ id, domain, prompt }) => ({ id, domain, prompt }));
    const r = await runSingleVote({
      runId: "run",
      tasks: publicTasks,
      llm: new MockLLM({ oracle, seed: 5, latencyMs: [0, 0] }),
      budgetTokens: 0,
      concurrency: 16,
      normalize: normalizeAnswer,
      extract: extractFinalAnswer,
    });
    const correct = full.filter((t) => r.answers.get(t.id) === t.answer).length / full.length;
    expect(correct).toBeGreaterThan(0.9);
  });
});
