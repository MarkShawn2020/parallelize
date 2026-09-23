import { describe, expect, it } from "vitest";
import { checkAnswer } from "../tasks/check";
import { corruptAnswer, forgedProposalAttempt, poisonedGene } from "./adversary";

const ANSWERS = ["0", "1", "7", "42", "-3", "2.5", "1234", "$1,250", "99999", "100000", "999999", "1000000", "123456789", "1e21", "x = 5"];

describe("corruptAnswer", () => {
  it("never returns a correct answer", () => {
    for (const a of [...ANSWERS, "supported", "Refuted", "uncertain", "Alice", ""]) {
      for (let k = 0; k < 50; k++) {
        const bad = corruptAnswer(a, `task-${k}`);
        expect(bad, `${a} / task-${k}`).not.toBe(a);
        expect(checkAnswer(a, bad), `${a} -> ${bad}`).toBe(false);
      }
    }
  });

  it("is deterministic per key", () => {
    expect(corruptAnswer("42", "t1")).toBe(corruptAnswer("42", "t1"));
    const outs = new Set(Array.from({ length: 50 }, (_, k) => corruptAnswer("42", `t${k}`)));
    expect(outs.size).toBeGreaterThan(5);
  });

  it("nudges small numbers by 1..9 and keeps non-negative answers non-negative", () => {
    for (let k = 0; k < 100; k++) {
      const bad = Number(corruptAnswer("5", `t${k}`));
      const d = Math.abs(bad - 5);
      expect(Number.isInteger(bad)).toBe(true);
      expect(d).toBeGreaterThanOrEqual(1);
      expect(d).toBeLessThanOrEqual(9);
      expect(bad).toBeGreaterThanOrEqual(0);
    }
  });

  it("flips research verdicts", () => {
    expect(corruptAnswer("supported", "k")).toBe("refuted");
    expect(corruptAnswer(" Refuted. ", "k")).toBe("supported");
    expect(corruptAnswer("uncertain", "k")).toBe("supported");
  });

  it("answers 0 for other text", () => {
    expect(corruptAnswer("Alice", "k")).toBe("0");
  });
});

describe("poisonedGene", () => {
  it("is deterministic and covers several variants that name the domain", () => {
    expect(poisonedGene("rates", "a")).toBe(poisonedGene("rates", "a"));
    const variants = new Set(Array.from({ length: 100 }, (_, k) => poisonedGene("rates", `k${k}`)));
    expect(variants.size).toBe(4);
    for (const v of variants) expect(v).toContain("rates");
  });
});

describe("forgedProposalAttempt", () => {
  it("returns undefined when there is nothing to forge", () => {
    expect(forgedProposalAttempt([], "k")).toBeUndefined();
  });

  it("deterministically picks one of the given tasks", () => {
    const ids = ["t001", "t002", "t003"];
    const pick = forgedProposalAttempt(ids, "evil-1");
    expect(ids).toContain(pick);
    expect(forgedProposalAttempt(ids, "evil-1")).toBe(pick);
    const picks = new Set(Array.from({ length: 30 }, (_, k) => forgedProposalAttempt(ids, `evil-${k}`)));
    expect(picks.size).toBe(3);
  });
});
