import { describe, expect, it, vi } from "vitest";
import { isWorkPurpose, MemoryLedger, meterJudge, meterLLM, sumTotals } from "./ledger";
import { BudgetExceededError } from "./types";
import type { Judge, JudgeRequest, LedgerEntry, LLM, LLMRequest, Purpose } from "./types";

const entry = (purpose: Purpose, input: number, output: number, cost: number, latency = 10): LedgerEntry => ({
  runId: "r",
  at: 0,
  provider: "mock-llm",
  model: "m",
  purpose,
  usage: { inputTokens: input, outputTokens: output, costUsd: cost },
  latencyMs: latency,
});

const llmReq = (purpose: Purpose = "solve"): LLMRequest => ({
  messages: [{ role: "user", content: "hi" }],
  meta: { runId: "run-1", purpose, cellId: "c1", taskId: "t1" },
});

const judgeReq: JudgeRequest = {
  state: "s",
  questions: { claim: { type: "noul", instructions: "claim?" } },
  meta: { runId: "run-1", purpose: "claim", cellId: "c2" },
};

function fakeLLM(costUsd = 0.01): LLM & { calls: number } {
  return {
    id: "fake-llm",
    simulated: true,
    calls: 0,
    async complete() {
      this.calls++;
      return { text: "ok", usage: { inputTokens: 100, outputTokens: 20, costUsd }, latencyMs: 50, model: "fake-model" };
    },
  };
}

const fakeJudge: Judge = {
  id: "fake-judge",
  tier: "system1",
  simulated: true,
  async ask() {
    return {
      answers: { claim: { type: "noul", noul: 0.9 } },
      usage: { inputTokens: 40, outputTokens: 0, costUsd: 0.001 },
      latencyMs: 120,
      model: "jev-mini",
    };
  },
};

describe("ledger totals", () => {
  it("classifies work purposes", () => {
    expect(["solve", "single", "report"].every((p) => isWorkPurpose(p as Purpose))).toBe(true);
    expect(["merge", "claim", "verify", "adopt", "gene", "adjudicate"].some((p) => isWorkPurpose(p as Purpose))).toBe(
      false,
    );
  });

  it("sums totals", () => {
    expect(sumTotals([])).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, latencyMs: 0 });
    expect(sumTotals([entry("solve", 100, 20, 0.5, 30), entry("claim", 10, 0, 0.25, 5)])).toEqual({
      calls: 2,
      inputTokens: 110,
      outputTokens: 20,
      totalTokens: 130,
      costUsd: 0.75,
      latencyMs: 35,
    });
  });

  it("computes filtered totals and per-purpose totals from entries", () => {
    const ledger = new MemoryLedger();
    ledger.record(entry("solve", 100, 50, 0.5));
    ledger.record(entry("claim", 10, 0, 0.125));
    ledger.record(entry("solve", 200, 50, 0.25));
    expect(ledger.entries()).toHaveLength(3);
    expect(ledger.totals().totalTokens).toBe(410);
    expect(ledger.totals((e) => isWorkPurpose(e.purpose))).toMatchObject({ calls: 2, totalTokens: 400, costUsd: 0.75 });
    const byPurpose = ledger.byPurpose();
    expect(Object.keys(byPurpose).sort()).toEqual(["claim", "solve"]);
    expect(byPurpose.solve).toMatchObject({ calls: 2, inputTokens: 300, outputTokens: 100 });
    expect(byPurpose.claim).toMatchObject({ calls: 1, totalTokens: 10, costUsd: 0.125 });
  });

  it("does not expose its internal array", () => {
    const ledger = new MemoryLedger();
    ledger.record(entry("solve", 1, 1, 0));
    ledger.entries().pop();
    expect(ledger.entries()).toHaveLength(1);
  });
});

describe("meterLLM / meterJudge", () => {
  it("records one entry per LLM call with meta, model and no tier", async () => {
    const ledger = new MemoryLedger();
    const onEntry = vi.fn();
    const llm = meterLLM(fakeLLM(), ledger, { provider: "mock-llm", onEntry, now: () => 1234 });
    expect(llm.id).toBe("fake-llm");
    expect(llm.simulated).toBe(true);
    const res = await llm.complete(llmReq("report"));
    expect(res.text).toBe("ok");
    const [e] = ledger.entries();
    expect(e).toEqual({
      runId: "run-1",
      at: 1234,
      provider: "mock-llm",
      model: "fake-model",
      purpose: "report",
      cellId: "c1",
      taskId: "t1",
      usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.01 },
      latencyMs: 50,
    });
    expect(e).not.toHaveProperty("tier");
    expect(onEntry).toHaveBeenCalledExactlyOnceWith(e);
  });

  it("records judge calls with the judge's tier and omits absent meta fields", async () => {
    const ledger = new MemoryLedger();
    const judge = meterJudge(fakeJudge, ledger, { provider: "jev", now: () => 7 });
    expect(judge).toMatchObject({ id: "fake-judge", tier: "system1", simulated: true });
    await judge.ask(judgeReq);
    const [e] = ledger.entries();
    expect(e).toMatchObject({ provider: "jev", tier: "system1", purpose: "claim", cellId: "c2", model: "jev-mini", at: 7 });
    expect(e).not.toHaveProperty("taskId");
  });

  it("throws BudgetExceededError before a call once the cap is reached", async () => {
    const ledger = new MemoryLedger();
    const inner = fakeLLM(0.4);
    const llm = meterLLM(inner, ledger, { provider: "llm", maxCostUsd: 1 });
    await llm.complete(llmReq());
    await llm.complete(llmReq());
    await llm.complete(llmReq()); // spent 0.8 < 1 before this call
    const err = await llm.complete(llmReq()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect((err as BudgetExceededError).spentUsd).toBeCloseTo(1.2);
    expect((err as BudgetExceededError).capUsd).toBe(1);
    expect(inner.calls).toBe(3);
    expect(ledger.entries()).toHaveLength(3);
  });

  it("shares the cap across metered providers on the same ledger", async () => {
    const ledger = new MemoryLedger();
    ledger.record(entry("solve", 0, 0, 0.5));
    const judge = meterJudge(fakeJudge, ledger, { provider: "jev", maxCostUsd: 0.5 });
    await expect(judge.ask(judgeReq)).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("never throws for budget without a cap", async () => {
    const ledger = new MemoryLedger();
    ledger.record(entry("solve", 0, 0, 1e6));
    await expect(meterLLM(fakeLLM(), ledger, { provider: "llm" }).complete(llmReq())).resolves.toBeDefined();
  });

  it("records nothing for a failed call and rethrows", async () => {
    const ledger = new MemoryLedger();
    const onEntry = vi.fn();
    const boom = new Error("upstream 500");
    const broken: LLM = { id: "x", simulated: false, complete: () => Promise.reject(boom) };
    await expect(meterLLM(broken, ledger, { provider: "llm", onEntry }).complete(llmReq())).rejects.toBe(boom);
    expect(ledger.entries()).toEqual([]);
    expect(onEntry).not.toHaveBeenCalled();
  });
});
