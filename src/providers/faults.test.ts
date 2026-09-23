import { describe, expect, it } from "vitest";
import type { Judge, JudgeRequest, JudgeResult, LLM, LLMRequest, LLMResult } from "../core/types";
import { FaultSwitch, withFaultJudge, withFaultLLM } from "./faults";
import { ProviderError } from "./http";

const usage = { inputTokens: 1, outputTokens: 1, costUsd: 0 };
const meta = { runId: "r1", purpose: "verify" as const };

// Stands in for a hung provider: a wrapper that forwarded while down would blow the 20ms budget.
const HANG_MS = 500;

function slowJudge(calls: { n: number }): Judge {
  return {
    id: "jev-test",
    tier: "system1",
    simulated: false,
    async ask(): Promise<JudgeResult> {
      calls.n++;
      await new Promise((r) => setTimeout(r, 5));
      return { answers: { verify: { type: "noul", noul: 0.2 } }, usage, latencyMs: 5, model: "m" };
    },
  };
}

function hangingJudge(): Judge {
  return {
    id: "jev-hang",
    tier: "system1",
    simulated: false,
    ask: () => new Promise((r) => setTimeout(() => r({ answers: {}, usage, latencyMs: HANG_MS, model: "m" }), HANG_MS)),
  };
}

function fakeLLM(calls: { n: number }): LLM {
  return {
    id: "llm-test",
    simulated: true,
    async complete(): Promise<LLMResult> {
      calls.n++;
      return { text: "ANSWER: 4", usage, latencyMs: 1, model: "m" };
    },
  };
}

const judgeReq: JudgeRequest = { state: "s", questions: { verify: { type: "noul", instructions: "i" } }, meta };
const llmReq: LLMRequest = { messages: [{ role: "user", content: "2+2" }], meta };

async function timed<T>(p: Promise<T>): Promise<{ ms: number; error: unknown }> {
  const t0 = performance.now();
  try {
    await p;
    return { ms: performance.now() - t0, error: undefined };
  } catch (error) {
    return { ms: performance.now() - t0, error };
  }
}

describe("FaultSwitch", () => {
  it("starts up and toggles", () => {
    const sw = new FaultSwitch("jev");
    expect(sw.name).toBe("jev");
    expect(sw.down).toBe(false);
    sw.set(true);
    expect(sw.down).toBe(true);
    sw.set(false);
    expect(sw.down).toBe(false);
  });
});

describe("withFaultJudge", () => {
  it("keeps the inner identity and passes through while up", async () => {
    const calls = { n: 0 };
    const sw = new FaultSwitch("jev");
    const j = withFaultJudge(slowJudge(calls), sw);
    expect([j.id, j.tier, j.simulated]).toEqual(["jev-test", "system1", false]);
    const r = await j.ask(judgeReq);
    expect(r.answers.verify).toEqual({ type: "noul", noul: 0.2 });
    expect(calls.n).toBe(1);
  });

  it("throws a 503 ProviderError instantly while down, without calling the provider", async () => {
    const sw = new FaultSwitch("jev");
    sw.set(true);
    const { ms, error } = await timed(withFaultJudge(hangingJudge(), sw).ask(judgeReq));
    expect(ms).toBeLessThan(20);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).status).toBe(503);
    expect((error as ProviderError).message).toBe("jev offline (fault injected)");
  });

  it("recovers after set(false)", async () => {
    const calls = { n: 0 };
    const sw = new FaultSwitch("jev");
    const j = withFaultJudge(slowJudge(calls), sw);
    sw.set(true);
    await expect(j.ask(judgeReq)).rejects.toThrow(ProviderError);
    expect(calls.n).toBe(0);
    sw.set(false);
    await expect(j.ask(judgeReq)).resolves.toMatchObject({ model: "m" });
    expect(calls.n).toBe(1);
  });
});

describe("withFaultLLM", () => {
  it("keeps the inner identity and passes through while up", async () => {
    const calls = { n: 0 };
    const sw = new FaultSwitch("llm");
    const l = withFaultLLM(fakeLLM(calls), sw);
    expect([l.id, l.simulated]).toEqual(["llm-test", true]);
    expect((await l.complete(llmReq)).text).toBe("ANSWER: 4");
    expect(calls.n).toBe(1);
  });

  it("throws a 503 ProviderError instantly while down and recovers", async () => {
    const calls = { n: 0 };
    const sw = new FaultSwitch("llm");
    const l = withFaultLLM(fakeLLM(calls), sw);
    sw.set(true);
    const { ms, error } = await timed(l.complete(llmReq));
    expect(ms).toBeLessThan(20);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).status).toBe(503);
    expect((error as ProviderError).message).toBe("llm offline (fault injected)");
    expect(calls.n).toBe(0);
    sw.set(false);
    expect((await l.complete(llmReq)).text).toBe("ANSWER: 4");
    expect(calls.n).toBe(1);
  });

  it("shares one switch across wrappers", async () => {
    const sw = new FaultSwitch("llm");
    const a = withFaultLLM(fakeLLM({ n: 0 }), sw);
    const b = withFaultLLM(fakeLLM({ n: 0 }), sw);
    sw.set(true);
    await expect(a.complete(llmReq)).rejects.toThrow("llm offline");
    await expect(b.complete(llmReq)).rejects.toThrow("llm offline");
  });
});
