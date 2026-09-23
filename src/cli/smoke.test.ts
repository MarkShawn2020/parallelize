import { describe, expect, it } from "vitest";
import type { Judge, LLM } from "../core/types";
import { MockJudge, MockLLM, MockOracle } from "../providers/mock";
import { formatSmoke, smoke } from "./smoke";

describe("smoke", () => {
  it("makes one judge call and one solve call and formats both without secrets", async () => {
    const judge = new MockJudge({ tier: "system1", seed: 1, latencyMs: [0, 0] });
    const llm = new MockLLM({ oracle: new MockOracle([]), seed: 1, latencyMs: [0, 0] });
    const lines = await smoke(judge, llm);
    expect(lines.map((l) => l.name)).toEqual(["system1", "system2"]);
    const text = formatSmoke(lines);
    expect(text).toMatch(/system1 +model=mock-judge:system1 latency=\d+ms tokens=\d+\+0 cost=\$/);
    expect(text).toMatch(/system2 +model=mock-llm/);
  });

  it("fails when the judge omits an answer", async () => {
    const judge: Judge = {
      id: "j",
      tier: "system1",
      simulated: true,
      ask: async () => ({ answers: {}, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, latencyMs: 0, model: "j" }),
    };
    const llm: LLM = { id: "l", simulated: true, complete: () => Promise.reject(new Error("unreachable")) };
    await expect(smoke(judge, llm)).rejects.toThrow(/did not answer/);
  });
});
