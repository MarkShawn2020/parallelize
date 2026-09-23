import { describe, expect, it } from "vitest";
import { MemoryLedger } from "./ledger";
import { computeMetrics } from "./metrics";
import type { MetricsInput } from "./metrics";
import type { Decision, LedgerEntry, Purpose, Tier } from "./types";

const entry = (purpose: Purpose, input: number, output: number, cost: number): LedgerEntry => ({
  runId: "r",
  at: 0,
  provider: "mock-llm",
  model: "m",
  purpose,
  usage: { inputTokens: input, outputTokens: output, costUsd: cost },
  latencyMs: 0,
});

const decision = (tier: Tier, latencyMs: number): Decision => ({
  id: `d-${tier}-${latencyMs}`,
  runId: "r",
  key: "claim",
  tier,
  escalated: tier === "system2",
  answer: { type: "noul", noul: 0.5 },
  confidence: 0.5,
  latencyMs,
  usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  precedentsUsed: 0,
  at: 0,
});

const base = (over: Partial<MetricsInput> = {}): MetricsInput => ({
  tasksTotal: 0,
  accepted: new Map(),
  ledger: new MemoryLedger(),
  decisions: [],
  cellsAlive: 0,
  reopened: 0,
  echoAlarms: 0,
  genesAdopted: 0,
  startedAt: 1000,
  now: 1000,
  ...over,
});

describe("computeMetrics", () => {
  it("returns zeros without division by zero on an empty run", () => {
    const m = computeMetrics(base());
    expect(m).toMatchObject({
      accuracy: 0,
      air: 0,
      escalationRate: 0,
      meanJudgeLatencyMs: 0,
      totalTokens: 0,
      costUsd: 0,
      elapsedMs: 0,
    });
    expect(Object.values(m).every((v) => Number.isFinite(v))).toBe(true);
  });

  it("computes accuracy, token split, cost, AIR, escalation and latency", () => {
    const ledger = new MemoryLedger();
    ledger.record(entry("solve", 1000, 500, 0.5));
    ledger.record(entry("report", 200, 300, 0.25));
    ledger.record(entry("claim", 400, 0, 0.125));
    ledger.record(entry("adjudicate", 500, 100, 0.125));
    const accepted = new Map([
      ["t1", true],
      ["t2", false],
      ["t3", true],
    ]);
    const decisions = [decision("system1", 100), decision("system1", 200), decision("system1", 300), decision("system2", 1400)];

    const m = computeMetrics(
      base({
        tasksTotal: 4,
        accepted,
        ledger,
        decisions,
        cellsAlive: 5,
        reopened: 2,
        echoAlarms: 1,
        genesAdopted: 3,
        startedAt: 10_000,
        now: 25_000,
      }),
    );

    expect(m).toEqual({
      tasksTotal: 4,
      accepted: 3,
      correct: 2,
      accuracy: 0.5,
      totalTokens: 3000,
      workTokens: 2000,
      coordinationTokens: 1000,
      costUsd: 1,
      air: 2 / 3,
      s1Decisions: 3,
      s2Decisions: 1,
      escalationRate: 0.25,
      meanJudgeLatencyMs: 500,
      cellsAlive: 5,
      reopened: 2,
      echoAlarms: 1,
      genesAdopted: 3,
      elapsedMs: 15_000,
    });
  });

  it("counts unaccepted tasks as wrong", () => {
    const m = computeMetrics(base({ tasksTotal: 10, accepted: new Map([["t1", true]]) }));
    expect(m.accuracy).toBe(0.1);
    expect(m.accepted).toBe(1);
  });
});
