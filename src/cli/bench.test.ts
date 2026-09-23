import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config";
import type { LiveMetrics, RunSummary } from "../core/types";
import { buildConfigs, formatTable } from "./bench";

describe("buildConfigs", () => {
  it("expands --mode all into the four modes on identical settings", () => {
    const configs = buildConfigs({ n: "48", cells: "6", llm: "mock", judge: "mock", seed: "3" });
    expect(configs.map((c) => c.mode)).toEqual(["single", "subagent", "swarm-llm", "swarm-jev"]);
    for (const c of configs) expect(c).toMatchObject({ n: 48, cells: 6, llm: "mock", judge: "mock", seed: 3 });
  });

  it("validates arguments", () => {
    expect(() => buildConfigs({ mode: "swarm" })).toThrow(/--mode/);
    expect(() => buildConfigs({ n: "many" })).toThrow(/--n must be a number/);
    expect(() => buildConfigs({ source: "csv" })).toThrow(/--source/);
    expect(() => buildConfigs({ source: "gsm8k" })).toThrow(/--path/);
  });

  it("lets the local CLI load a gsm8k file from any path", () => {
    const [cfg] = buildConfigs({ mode: "single", source: "gsm8k", path: "test/fixtures/gsm8k-sample.jsonl" });
    expect(cfg?.taskSource).toEqual({ kind: "gsm8k", path: expect.stringMatching(/test\/fixtures\/gsm8k-sample\.jsonl$/) });
  });
});

describe("formatTable", () => {
  it("prints one fixed-width row per run", () => {
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
    const lines = formatTable([run, { ...run, mode: "single", metrics: { ...metrics, s1Decisions: 0, s2Decisions: 0 }, aborted: "budget" }]).split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^mode\s+sim\s+accuracy\s+correct\/n\s+total_tok\s+work_tok\s+coord_tok\s+cost_usd\s+AIR\s+esc_rate\s+wall_s\s+aborted$/);
    expect(lines[2]?.split(/\s+/)).toEqual(["swarm-jev", "yes", "0.750", "3/4", "1000", "600", "400", "0.0123", "3.000", "0.100", "2.5", "-"]);
    expect(lines[3]?.split(/\s+/).slice(-3)).toEqual(["-", "2.5", "budget"]);
  });
});
