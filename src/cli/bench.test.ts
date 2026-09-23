import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config";
import type { LiveMetrics, RunSummary } from "../core/types";
import { BENCH_ORDER, buildPlan, formatTable } from "./bench";

describe("buildPlan", () => {
  it("expands --mode all into all seven modes, swarm-jev first, on identical settings", () => {
    const plan = buildPlan({ n: "48", cells: "6", llm: "mock", judge: "mock", seed: "3" });
    expect(plan.map((r) => r.config.mode)).toEqual(["swarm-jev", "single", "single-vote", "subagent", "swarm-llm", "swarm-rules", "swarm-solo"]);
    expect(plan.map((r) => r.label)).toEqual([...BENCH_ORDER]);
    for (const r of plan) expect(r.config).toMatchObject({ n: 48, cells: 6, llm: "mock", judge: "mock", seed: 3, inherit: false });
    expect(plan.filter((r) => r.budgetFromSwarm).map((r) => r.config.mode)).toEqual(["single-vote"]);
  });

  it("gives single-vote an explicit budget, or a fixed k when no swarm-jev run sets one", () => {
    const [vote] = buildPlan({ mode: "single-vote", llm: "mock" });
    expect(vote).toMatchObject({ budgetFromSwarm: false, config: { voteBudgetTokens: 0 } });
    const explicit = buildPlan({ mode: "single-vote,swarm-jev", "vote-budget": "12000", llm: "mock" });
    expect(explicit.map((r) => r.config.mode)).toEqual(["swarm-jev", "single-vote"]);
    expect(explicit[1]).toMatchObject({ budgetFromSwarm: false, config: { voteBudgetTokens: 12000 } });
  });

  it("runs --inherit as a cold/warm pair on consecutive seeds, both loading and publishing", () => {
    const plan = buildPlan({ inherit: true, llm: "mock", judge: "mock", seed: "5" });
    expect(plan.map((r) => r.label)).toEqual(["swarm-jev/cold", "swarm-jev/warm"]);
    expect(plan.map((r) => r.config.seed)).toEqual([5, 6]);
    expect(plan.every((r) => r.config.inherit)).toBe(true);
    expect(buildPlan({ inherit: true, mode: "swarm-rules" }).map((r) => r.label)).toEqual(["swarm-rules/cold", "swarm-rules/warm"]);
    expect(() => buildPlan({ inherit: true, mode: "single" })).toThrow(/--inherit needs one swarm mode/);
    expect(() => buildPlan({ inherit: true, mode: "all" })).toThrow(/--inherit/);
  });

  it("builds research, cell-model and EvoMap lookup configs", () => {
    const [cfg] = buildPlan({ mode: "swarm-rules", research: "A cafe for cats", claims: "4", canaries: "3", "cell-models": "a/b, c/d", "evomap-lookup": true });
    expect(cfg?.config.taskSource).toEqual({ kind: "research", idea: "A cafe for cats", claims: 4, canaries: 3 });
    expect(cfg?.config.n).toBe(7);
    expect(cfg?.config.cellModels).toEqual(["a/b", "c/d"]);
    expect(cfg?.config.evomapLookup).toBe(true);
  });

  it("validates arguments", () => {
    expect(() => buildPlan({ mode: "swarm" })).toThrow(/--mode/);
    expect(() => buildPlan({ n: "many" })).toThrow(/--n must be a number/);
    expect(() => buildPlan({ source: "csv" })).toThrow(/--source/);
    expect(() => buildPlan({ source: "gsm8k" })).toThrow(/--path/);
    expect(() => buildPlan({ claims: "4" })).toThrow(/--research/);
    expect(() => buildPlan({ research: "x", source: "gsm8k", path: "p" })).toThrow(/exclusive/);
    expect(() => buildPlan({ "cell-models": "bad model!" })).toThrow(/cellModels/);
  });

  it("lets the local CLI load a gsm8k file from any path", () => {
    const [run] = buildPlan({ mode: "single", source: "gsm8k", path: "test/fixtures/gsm8k-sample.jsonl" });
    expect(run?.config.taskSource).toEqual({ kind: "gsm8k", path: expect.stringMatching(/test\/fixtures\/gsm8k-sample\.jsonl$/) });
  });
});

describe("formatTable", () => {
  const metrics: LiveMetrics = {
    tasksTotal: 4,
    accepted: 4,
    correct: 3,
    accuracy: 0.75,
    totalTokens: 1000,
    workTokens: 600,
    coordinationTokens: 400,
    costUsd: 0.0123,
    air: 3,
    s1Decisions: 9,
    s2Decisions: 1,
    escalationRate: 0.1,
    meanJudgeLatencyMs: 100,
    cellsAlive: 2,
    reopened: 0,
    echoAlarms: 0,
    genesAdopted: 0,
    passThroughErrorRate: 0.125,
    falseAcceptRate: 0.25,
    falseAcceptVerifiedRate: 0.5,
    coordinationShare: 0.4,
    quarantined: 0,
    libraryHits: 0,
    inheritedGenes: 0,
    jevDown: false,
    accuracyApplicable: true,
    elapsedMs: 2500,
  };
  const run: RunSummary = {
    runId: "r",
    mode: "swarm-jev",
    config: DEFAULT_CONFIG,
    simulated: true,
    metrics,
    byPurpose: {},
    calibration: {},
    startedAt: 0,
    finishedAt: 2500,
  };

  it("prints one fixed-width row per run with the honesty columns", () => {
    const single: RunSummary = { ...run, mode: "single", metrics: { ...metrics, s1Decisions: 0, s2Decisions: 0 }, aborted: "budget" };
    const lines = formatTable([
      { label: "swarm-jev/warm", summary: run },
      { label: "single", summary: single },
    ]).split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(
      /^run\s+sim\s+accuracy\s+correct\/n\s+total_tok\s+work_tok\s+coord_tok\s+coord_share\s+cost_usd\s+AIR\s+esc_rate\s+pass_err\s+false_acc_verified\s+wall_s\s+aborted$/,
    );
    expect(lines[2]?.split(/\s+/)).toEqual(["swarm-jev/warm", "yes", "0.750", "3/4", "1000", "600", "400", "0.400", "0.0123", "3.000", "0.100", "0.125", "0.500", "2.5", "-"]);
    expect(lines[3]?.split(/\s+/).slice(-5)).toEqual(["-", "-", "-", "2.5", "budget"]);
  });

  it("marks canary-only accuracy for research runs", () => {
    const config = { ...DEFAULT_CONFIG, taskSource: { kind: "research" as const, idea: "x", claims: 5, canaries: 4 } };
    const out = formatTable([{ label: "swarm-jev", summary: { ...run, config, metrics: { ...metrics, accuracyApplicable: false } } }]);
    expect(out).toContain("0.750*");
    expect(out.split("\n")[2]?.split(/\s+/)[3]).toBe("3/4");
    expect(out).toMatch(/canary claims only/);
  });
});
