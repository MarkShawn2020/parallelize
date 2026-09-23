import { describe, expect, it } from "vitest";
import { BudgetExceededError, QK } from "../core/types";
import type { Decision, Judge, JudgeRequest, JudgeResult, Tier } from "../core/types";
import { conservativeAnswer } from "./dispute";
import { ObservedJudge } from "./observed";

class FakeJudge implements Judge {
  readonly id = "llm-judge:fake";
  readonly tier: Tier = "system2";
  readonly simulated = true;
  async ask(_req: JudgeRequest): Promise<JudgeResult> {
    return {
      answers: {
        adopt: { type: "noul", noul: 0.2 },
        claim: { type: "choice", choice: "t2", probabilities: { t2: 0.7, none: 0.3 }, confidence: 0.7 },
      },
      usage: { inputTokens: 300, outputTokens: 40, costUsd: 0.002 },
      latencyMs: 1200,
      model: "fake-model",
    };
  }
}

describe("ObservedJudge", () => {
  it("passes results through and logs one decision per asked key", async () => {
    const inner = new FakeJudge();
    const decisions: Decision[] = [];
    let n = 0;
    const judge = new ObservedJudge(inner, {
      onDecision: (d) => decisions.push(d),
      now: () => 42,
      newId: () => `o${++n}`,
    });
    expect([judge.id, judge.tier, judge.simulated]).toEqual([inner.id, "system2", true]);

    const req: JudgeRequest = {
      state: "S",
      questions: {
        adopt: { type: "noul", instructions: "Adopt?" },
        claim: { type: "choice", instructions: "Pick", criteria: { t2: "task 2", none: "decline" } },
      },
      meta: { runId: "r9", purpose: "adopt", cellId: "c3" },
    };
    const r = await judge.ask(req);

    expect(r).toEqual(await inner.ask(req));
    expect(decisions).toHaveLength(2);
    expect(decisions[0]).toEqual({
      id: "o1",
      runId: "r9",
      cellId: "c3",
      taskId: undefined,
      key: "adopt",
      tier: "system2",
      escalated: false,
      answer: { type: "noul", noul: 0.2 },
      confidence: 0.6,
      latencyMs: 1200,
      usage: { inputTokens: 150, outputTokens: 20, costUsd: 0.001 },
      precedentsUsed: 0,
      at: 42,
    });
    expect(decisions[1]).toMatchObject({ id: "o2", key: "claim", tier: "system2", confidence: 0.7 });
    expect(decisions[0]?.fallback).toBeUndefined();
  });

  describe("fallback", () => {
    const failing = (err: Error): Judge => ({
      id: "llm-judge:down",
      tier: "system2",
      simulated: true,
      ask: async () => {
        throw err;
      },
    });
    const req: JudgeRequest = {
      state: "S",
      questions: { [QK.verify]: { type: "noul", instructions: "Re-solve?" } },
      meta: { runId: "r9", purpose: "verify", cellId: "c3", taskId: "t1" },
    };

    it("answers with the fallback when the inner judge throws", async () => {
      const decisions: Decision[] = [];
      const judge = new ObservedJudge(failing(new Error("503")), {
        fallback: conservativeAnswer,
        onDecision: (d) => decisions.push(d),
      });
      const r = await judge.ask(req);
      expect(r).toEqual({
        answers: { [QK.verify]: { type: "noul", noul: 1 } },
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        latencyMs: 0,
        model: "fallback",
      });
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({ key: QK.verify, tier: "system2", fallback: true, confidence: 0, taskId: "t1" });
    });

    it("rethrows without a fallback", async () => {
      await expect(new ObservedJudge(failing(new Error("503"))).ask(req)).rejects.toThrow("503");
    });

    it("rethrows budget errors even with a fallback", async () => {
      const judge = new ObservedJudge(failing(new BudgetExceededError(1, 1)), { fallback: conservativeAnswer });
      await expect(judge.ask(req)).rejects.toBeInstanceOf(BudgetExceededError);
    });
  });
});
