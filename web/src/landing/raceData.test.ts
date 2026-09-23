import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EVIDENCE_ROWS } from "../evidence";
import { SQ, laneAt, mcnemar, outcomes, type RaceData } from "./raceData";

const data = JSON.parse(readFileSync(join(__dirname, "../../public/race/hard-96.json"), "utf8")) as RaceData;
const n = data.ids.length;

describe("race replay data", () => {
  it("ends on the same numbers as the evidence page", () => {
    for (const run of Object.values(data.runs)) {
      const row = EVIDENCE_ROWS.find((r) => r.runId === run.runId);
      expect(row, run.runId).toBeDefined();
      const end = laneAt(run, data.judgeKeys, n, Infinity);
      expect(end.correct).toBe(row?.correct);
      expect(end.done).toBe(n);
      expect(end.costUsd).toBeCloseTo(row?.costUsd ?? 0, 4);
      expect(end.finished).toBe(true);
    }
  });

  it("counts who made each judgment in the Jev swarm", () => {
    const jev = data.runs["swarm-jev"];
    if (!jev) throw new Error("no swarm-jev run");
    const end = laneAt(jev, data.judgeKeys, n, Infinity);
    expect(end.total.jev + end.total.llm).toBe(jev.judge.length);
    expect(end.judges.adopt.jev).toBeGreaterThan(end.judges.adopt.llm);
    expect(end.guard?.[1]).toBe("verify");
  });

  it("shows the one-context baseline as all in progress until it hands in", () => {
    const single = data.runs.single;
    if (!single) throw new Error("no single run");
    expect(laneAt(single, data.judgeKeys, n, 0).squares.every((q) => q === SQ.idle)).toBe(true);
    const mid = laneAt(single, data.judgeKeys, n, single.durationMs / 2);
    expect(mid.squares.every((q) => q === SQ.working)).toBe(true);
    expect(mid.done).toBe(0);
  });

  it("reproduces the paired test against the rule swarm", () => {
    const jev = data.runs["swarm-jev"];
    const rules = data.runs["swarm-rules"];
    if (!jev || !rules) throw new Error("missing run");
    const r = mcnemar(outcomes(jev, n), outcomes(rules, n));
    expect([r.onlyA, r.onlyB]).toEqual([9, 5]);
    expect(r.p).toBeCloseTo(0.424, 3);
  });
});
