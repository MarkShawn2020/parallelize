import { describe, expect, it } from "vitest";
import type { CalibrationSample } from "../core/types";
import { brierScore, calibrationBins, groupCalibration } from "./calibration";

const s = (predicted: number, outcome: boolean, key = "verify"): CalibrationSample => ({ key, predicted, outcome });

describe("calibrationBins", () => {
  it("bins equal-width over [0, 1] with the last bin inclusive of 1", () => {
    const bins = calibrationBins([s(0.05, false), s(0.15, true), s(0.9, true), s(1, false), s(0.8, true)], 5);
    expect(bins.map((b) => [b.lo, b.hi])).toEqual([
      [0, 0.2],
      [0.2, 0.4],
      [0.4, 0.6],
      [0.6, 0.8],
      [0.8, 1],
    ]);
    expect(bins.map((b) => b.count)).toEqual([2, 0, 0, 0, 3]);
    expect(bins[0]?.meanPredicted).toBeCloseTo(0.1);
    expect(bins[0]?.observedRate).toBeCloseTo(0.5);
    expect(bins[4]?.meanPredicted).toBeCloseTo(0.9);
    expect(bins[4]?.observedRate).toBeCloseTo(2 / 3);
  });

  it("reports empty bins as NaN-free zeros", () => {
    const bins = calibrationBins([], 4);
    expect(bins).toHaveLength(4);
    for (const b of bins) {
      expect(b).toMatchObject({ count: 0, meanPredicted: 0, observedRate: 0 });
    }
  });

  it("clamps out-of-range predictions and skips non-finite ones", () => {
    const bins = calibrationBins([s(-0.3, false), s(1.7, true), s(Number.NaN, true)], 2);
    expect(bins.map((b) => b.count)).toEqual([1, 1]);
  });
});

describe("groupCalibration", () => {
  it("bins each key separately", () => {
    const groups = groupCalibration([s(0.9, true, "verify"), s(0.1, false, "claim"), s(0.7, true, "claim")], 2);
    expect(Object.keys(groups).sort()).toEqual(["claim", "verify"]);
    expect(groups.claim?.map((b) => b.count)).toEqual([1, 1]);
    expect(groups.verify?.map((b) => b.count)).toEqual([0, 1]);
  });

  it("defaults to five bins", () => {
    expect(groupCalibration([s(0.5, true)]).verify).toHaveLength(5);
  });
});

describe("brierScore", () => {
  it("is 0 for no samples and the mean squared error otherwise", () => {
    expect(brierScore([])).toBe(0);
    expect(brierScore([s(1, true), s(0, false)])).toBe(0);
    expect(brierScore([s(0.8, true), s(0.4, false)])).toBeCloseTo((0.04 + 0.16) / 2);
  });
});
