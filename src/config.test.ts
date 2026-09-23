import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, parseRunConfig, providerEnv, SPAWN_MODELS } from "./config";

describe("parseRunConfig", () => {
  it("merges a minimal request over the defaults", () => {
    expect(parseRunConfig({ mode: "single" })).toEqual({ ...DEFAULT_CONFIG, mode: "single" });
  });

  it("rejects a missing or unknown mode and non-object bodies", () => {
    expect(() => parseRunConfig({})).toThrow(/mode must be one of/);
    expect(() => parseRunConfig({ mode: "swarm" })).toThrow(/mode must be one of/);
    expect(() => parseRunConfig(null)).toThrow(/JSON object/);
    expect(() => parseRunConfig([])).toThrow(/JSON object/);
  });

  it("clamps numbers into range and rounds integer fields", () => {
    const cfg = parseRunConfig({
      mode: "swarm-jev",
      n: 9999,
      cells: 0,
      escalationThreshold: 1.7,
      verifyThreshold: -1,
      leaseMs: 10,
      maxCostUsd: 500,
      llmConcurrency: 3.6,
      judgeConcurrency: 999,
      geneCapacity: 0,
      gossipEvery: 1000,
      claimCandidates: 400,
    });
    expect(cfg).toMatchObject({
      n: 512,
      cells: 1,
      escalationThreshold: 1,
      verifyThreshold: 0,
      leaseMs: 500,
      maxCostUsd: 50,
      llmConcurrency: 4,
      judgeConcurrency: 64,
      geneCapacity: 1,
      gossipEvery: 100,
      claimCandidates: 255,
    });
  });

  it("rejects non-numeric numbers and unknown enum values", () => {
    expect(() => parseRunConfig({ mode: "single", n: "10" })).toThrow(/n must be a finite number/);
    expect(() => parseRunConfig({ mode: "single", cells: Number.NaN })).toThrow(/cells/);
    expect(() => parseRunConfig({ mode: "single", judge: "gpt" })).toThrow(/judge must be one of/);
    expect(() => parseRunConfig({ mode: "single", llm: "anthropic" })).toThrow(/llm must be one of/);
    expect(() => parseRunConfig({ mode: "single", topology: "star" })).toThrow(/topology/);
  });

  it("shortens the lease for simulated runs unless the caller set one", () => {
    expect(parseRunConfig({ mode: "swarm-jev", llm: "mock" }).leaseMs).toBe(3000);
    expect(parseRunConfig({ mode: "swarm-jev", llm: "mock", leaseMs: 9000 }).leaseMs).toBe(9000);
    expect(parseRunConfig({ mode: "swarm-jev" }).leaseMs).toBe(30_000);
  });

  it("ships round-2 defaults: rule claims, review, quarantine, guard and everything external off", () => {
    expect(DEFAULT_CONFIG).toMatchObject({
      claimPolicy: "rule",
      auditRate: 0.1,
      probation: 2,
      reviewTrust: 0.55,
      quarantineTrust: 0.35,
      stuckAfter: 2,
      guardWindow: 8,
      guardMaxDisagreement: 0.5,
      inherit: false,
      evomapLookup: false,
      evomapPublish: false,
      publishGateTasks: 8,
      publishGateMinDelta: 1,
      cellModels: [],
      voteBudgetTokens: 0,
    });
  });

  it("clamps the round-2 numbers and checks booleans and the claim policy", () => {
    const cfg = parseRunConfig({
      mode: "swarm-jev",
      auditRate: 2,
      probation: -3,
      reviewTrust: 1.5,
      quarantineTrust: -1,
      stuckAfter: 0,
      guardWindow: 1,
      guardMaxDisagreement: 7,
      publishGateTasks: 1000,
      publishGateMinDelta: 0,
      voteBudgetTokens: -5,
      inherit: true,
      evomapLookup: true,
      evomapPublish: false,
      claimPolicy: "judge",
    });
    expect(cfg).toMatchObject({
      auditRate: 1,
      probation: 0,
      reviewTrust: 1,
      quarantineTrust: 0,
      stuckAfter: 1,
      guardWindow: 2,
      guardMaxDisagreement: 1,
      publishGateTasks: 64,
      publishGateMinDelta: 1,
      voteBudgetTokens: 0,
      inherit: true,
      evomapLookup: true,
      evomapPublish: false,
      claimPolicy: "judge",
    });
    expect(() => parseRunConfig({ mode: "single", inherit: "yes" })).toThrow(/inherit must be true or false/);
    expect(() => parseRunConfig({ mode: "single", evomapPublish: 1 })).toThrow(/evomapPublish/);
    expect(() => parseRunConfig({ mode: "single", claimPolicy: "llm" })).toThrow(/claimPolicy must be one of/);
  });

  it("accepts up to 8 model ids per cell and rejects anything else", () => {
    expect(parseRunConfig({ mode: "swarm-rules", cellModels: [...SPAWN_MODELS] }).cellModels).toEqual([...SPAWN_MODELS]);
    expect(parseRunConfig({ mode: "swarm-rules", cellModels: [] }).cellModels).toEqual([]);
    for (const bad of ["x", ["ok/model", ""], ["has space"], ["a;rm"], ["m".repeat(81)], Array(9).fill("a/b"), [42]]) {
      expect(() => parseRunConfig({ mode: "swarm-rules", cellModels: bad })).toThrow(/cellModels/);
    }
    // The defaults must not share one mutable array between runs.
    expect(parseRunConfig({ mode: "single" }).cellModels).not.toBe(DEFAULT_CONFIG.cellModels);
  });

  it("validates research ideas and sizes the run from claims plus canaries", () => {
    const cfg = parseRunConfig({ mode: "swarm-jev", n: 99, taskSource: { kind: "research", idea: "  用 AI 帮猫咖排班  ", claims: 20, canaries: -1 } });
    expect(cfg.taskSource).toEqual({ kind: "research", idea: "用 AI 帮猫咖排班", claims: 10, canaries: 0 });
    expect(cfg.n).toBe(10);
    expect(parseRunConfig({ mode: "single", taskSource: { kind: "research", idea: "x" } }).taskSource).toEqual({ kind: "research", idea: "x", claims: 6, canaries: 2 });
    expect(parseRunConfig({ mode: "single", taskSource: { kind: "research", idea: "x", claims: 1, canaries: 9 } }).taskSource).toMatchObject({ claims: 3, canaries: 6 });
    expect(() => parseRunConfig({ mode: "single", taskSource: { kind: "research", idea: "  " } })).toThrow(/taskSource.idea/);
    expect(() => parseRunConfig({ mode: "single", taskSource: { kind: "research", idea: "字".repeat(501) } })).toThrow(/at most 500/);
    expect(parseRunConfig({ mode: "single", taskSource: { kind: "research", idea: "字".repeat(500) } }).taskSource.kind).toBe("research");
    expect(() => parseRunConfig({ mode: "single", taskSource: { kind: "research", idea: "x", claims: "5" } })).toThrow(/claims/);
  });

  it("keeps gsm8k paths inside data/", () => {
    expect(parseRunConfig({ mode: "single", taskSource: { kind: "gsm8k", path: "gsm8k/test.jsonl" } }).taskSource).toEqual({
      kind: "gsm8k",
      path: "data/gsm8k/test.jsonl",
    });
    expect(parseRunConfig({ mode: "single", taskSource: { kind: "gsm8k", path: "data/x.jsonl" } }).taskSource).toEqual({
      kind: "gsm8k",
      path: "data/x.jsonl",
    });
    for (const path of ["/etc/passwd", "../secret.jsonl", "data/../../x", "C:\\x.jsonl", "", 42]) {
      expect(() => parseRunConfig({ mode: "single", taskSource: { kind: "gsm8k", path } })).toThrow(/taskSource.path/);
    }
    expect(() => parseRunConfig({ mode: "single", taskSource: { kind: "csv" } })).toThrow(/taskSource.kind/);
    expect(parseRunConfig({ mode: "single", taskSource: { kind: "synthetic" } }).taskSource).toEqual({ kind: "synthetic" });
  });

  it("accepts a synthetic difficulty and leaves it out when absent", () => {
    expect(parseRunConfig({ mode: "single", taskSource: { kind: "synthetic", difficulty: "hard" } }).taskSource).toEqual({
      kind: "synthetic",
      difficulty: "hard",
    });
    expect(parseRunConfig({ mode: "single", taskSource: { kind: "synthetic", difficulty: "normal" } }).taskSource).toEqual({
      kind: "synthetic",
      difficulty: "normal",
    });
    expect(parseRunConfig({ mode: "single", taskSource: { kind: "synthetic" } }).taskSource).not.toHaveProperty("difficulty");
    expect(DEFAULT_CONFIG.taskSource).toEqual({ kind: "synthetic" });
    for (const difficulty of ["extreme", "HARD", "", 2, null]) {
      expect(() => parseRunConfig({ mode: "single", taskSource: { kind: "synthetic", difficulty } })).toThrow(/taskSource.difficulty/);
    }
  });
});

describe("providerEnv", () => {
  it("uses defaults and falls back to the OpenRouter key", () => {
    const env = providerEnv({ OPENROUTER_API_KEY: "or-key", LLM_API_KEY: "" });
    expect(env.llm).toEqual({ baseUrl: "https://openrouter.ai/api/v1", apiKey: "or-key", model: "anthropic/claude-haiku-4.5" });
    expect(env.jev).toEqual({ baseUrl: "https://openrouter.ai/api/v1", apiKey: "or-key", model: "typesafe/jev-1.13" });
  });

  it("prefers the specific keys and settings", () => {
    const env = providerEnv({
      OPENROUTER_API_KEY: "or",
      LLM_API_KEY: "llm",
      JEV_API_KEY: "jev",
      LLM_MODEL: "m",
      JEV_BASE_URL: "https://api.typesafe.ai/v1",
    });
    expect(env.llm.apiKey).toBe("llm");
    expect(env.llm.model).toBe("m");
    expect(env.jev.apiKey).toBe("jev");
    expect(env.jev.baseUrl).toBe("https://api.typesafe.ai/v1");
  });

  it("reports no key when none is configured", () => {
    const env = providerEnv({});
    expect(env.llm.apiKey).toBeUndefined();
    expect(env.jev.apiKey).toBeUndefined();
  });
});
