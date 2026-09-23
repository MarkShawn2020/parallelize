import { describe, expect, it } from "vitest";
import { confidenceOf, describeAnswer } from "./confidence";

describe("confidenceOf", () => {
  it("maps noul distance from 0.5 onto [0, 1]", () => {
    expect(confidenceOf({ type: "noul", noul: 0.5 })).toBe(0);
    expect(confidenceOf({ type: "noul", noul: 1 })).toBe(1);
    expect(confidenceOf({ type: "noul", noul: 0 })).toBe(1);
    expect(confidenceOf({ type: "noul", noul: 0.8 })).toBeCloseTo(0.6);
    expect(confidenceOf({ type: "noul", noul: 0.2 })).toBeCloseTo(0.6);
  });

  it("clamps choice and score confidence, treating NaN as unconfident", () => {
    expect(confidenceOf({ type: "choice", choice: "a", probabilities: { a: 1 }, confidence: 1.4 })).toBe(1);
    expect(confidenceOf({ type: "score", score: 2, confidence: -0.2 })).toBe(0);
    expect(confidenceOf({ type: "score", score: 2, confidence: 0.7 })).toBe(0.7);
    expect(confidenceOf({ type: "score", score: 2, confidence: Number.NaN })).toBe(0);
  });
});

describe("describeAnswer", () => {
  it("renders short human forms", () => {
    expect(describeAnswer({ type: "noul", noul: 0.91 })).toBe("yes 0.91");
    expect(describeAnswer({ type: "noul", noul: 0.12 })).toBe("no 0.12");
    expect(describeAnswer({ type: "noul", noul: 0.5 })).toBe("yes 0.50");
    expect(describeAnswer({ type: "choice", choice: "t3", probabilities: { t3: 0.88 }, confidence: 0.88 })).toBe(
      "t3 0.88",
    );
    expect(describeAnswer({ type: "score", score: 1.2, confidence: 0.7 })).toBe("score 1.2 (0.70)");
    expect(describeAnswer({ type: "score", score: 2, confidence: 0.7 })).toBe("score 2 (0.70)");
  });
});
