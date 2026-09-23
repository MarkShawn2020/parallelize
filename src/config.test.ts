import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, parseRunConfig, providerEnv } from "./config";

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
