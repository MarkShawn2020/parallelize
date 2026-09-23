import { describe, expect, it } from "vitest";
import { MemoryLedger } from "./ledger";
import { computeMetrics } from "./metrics";
import type { AcceptedTask, MetricsInput } from "./metrics";
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

const ok = (correct: boolean, independentSources = 1): AcceptedTask => ({ correct, independentSources });

const base = (over: Partial<MetricsInput> = {}): MetricsInput => ({
  tasksTotal: 0,
  accepted: new Map(),
  ledger: new MemoryLedger(),
  decisions: [],
  passThrough: [],
  cellsAlive: 0,
  reopened: 0,
  echoAlarms: 0,
  genesAdopted: 0,
  quarantined: 0,
  libraryHits: 0,
  inheritedGenes: 0,
  jevDown: false,
  accuracyApplicable: true,
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
      passThroughErrorRate: 0,
      falseAcceptRate: 0,
      falseAcceptVerifiedRate: 0,
      coordinationShare: 0,
      elapsedMs: 0,
    });
    for (const v of Object.values(m)) if (typeof v === "number") expect(Number.isFinite(v)).toBe(true);
  });

  it("computes accuracy, token split, cost, AIR, escalation, latency and the honesty rates", () => {
    const ledger = new MemoryLedger();
    ledger.record(entry("solve", 1000, 500, 0.5));
    ledger.record(entry("report", 200, 300, 0.25));
    ledger.record(entry("claim", 400, 0, 0.125));
    ledger.record(entry("adjudicate", 500, 100, 0.125));
    const accepted = new Map([
      ["t1", ok(true, 2)],
      ["t2", ok(false, 2)],
      ["t3", ok(true)],
    ]);
    const decisions = [decision("system1", 100), decision("system1", 200), decision("system1", 300), decision("system2", 1400)];

    const m = computeMetrics(
      base({
        tasksTotal: 4,
        accepted,
        ledger,
        decisions,
        passThrough: [false, true, false, false],
        cellsAlive: 5,
        reopened: 2,
        echoAlarms: 1,
        genesAdopted: 3,
        quarantined: 1,
        libraryHits: 2,
        inheritedGenes: 4,
        jevDown: true,
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
      passThroughErrorRate: 0.25,
      falseAcceptRate: 1 / 3,
      falseAcceptVerifiedRate: 0.5,
      coordinationShare: 1 / 3,
      quarantined: 1,
      libraryHits: 2,
      inheritedGenes: 4,
      jevDown: true,
      accuracyApplicable: true,
      elapsedMs: 15_000,
    });
  });

  it("counts unaccepted tasks as wrong", () => {
    const m = computeMetrics(base({ tasksTotal: 10, accepted: new Map([["t1", ok(true)]]) }));
    expect(m.accuracy).toBe(0.1);
    expect(m.accepted).toBe(1);
  });

  it("scores only graded tasks when some have no ground truth (research canaries)", () => {
    const accepted = new Map([
      ["claim-1", ok(false, 3)],
      ["canary-1", ok(true, 2)],
      ["canary-2", ok(false)],
    ]);
    const m = computeMetrics(base({ tasksTotal: 5, accepted, graded: new Set(["canary-1", "canary-2", "canary-3"]), accuracyApplicable: false }));
    expect(m.accepted).toBe(3);
    expect(m.correct).toBe(1);
    expect(m.accuracy).toBeCloseTo(1 / 3);
    expect(m.falseAcceptRate).toBe(0.5);
    expect(m.falseAcceptVerifiedRate).toBe(0);
    expect(m.accuracyApplicable).toBe(false);
  });
});
