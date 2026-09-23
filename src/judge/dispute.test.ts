import { describe, expect, it } from "vitest";
import { MARK, QK, UNCLEAR_CHOICE } from "../core/types";
import type { Answer, Question } from "../core/types";
import {
  buildDisputeState,
  conservativeAnswer,
  DISPUTE_INSTRUCTIONS,
  disputeCandidates,
  disputeQuestion,
  disputeWinner,
  UNCLEAR_CRITERION,
} from "./dispute";

const candidates = [
  { key: "a1", answer: "42", summary: "six times seven" },
  { key: "a2", answer: "48", summary: "eight\n  times six" },
];
const pick = (c: string, confidence: number): Answer => ({ type: "choice", choice: c, probabilities: { [c]: confidence }, confidence });

describe("disputeQuestion", () => {
  it("offers each candidate plus an unclear option", () => {
    expect(disputeQuestion(candidates)).toEqual({
      type: "choice",
      instructions: DISPUTE_INSTRUCTIONS,
      criteria: {
        a1: "answer 42: six times seven",
        a2: "answer 48: eight times six",
        [UNCLEAR_CHOICE]: UNCLEAR_CRITERION,
      },
    });
    expect(UNCLEAR_CRITERION).toBe("neither is clearly right; another independent solve is needed");
  });

  it("clips long summaries to 120 characters", () => {
    const q = disputeQuestion([{ key: "a1", answer: "7", summary: "x".repeat(300) }]);
    const text = q.type === "choice" ? (q.criteria.a1 ?? "") : "";
    const summary = text.slice("answer 7: ".length);
    expect(summary).toHaveLength(120);
    expect(summary.endsWith("…")).toBe(true);
  });
});

describe("disputeCandidates", () => {
  it("keys one candidate per distinct answer, keeping the first method", () => {
    expect(
      disputeCandidates([
        { answer: "42", summary: "first" },
        { answer: "48", summary: "other" },
        { answer: "42", summary: "second" },
      ]),
    ).toEqual([
      { key: "a1", answer: "42", summary: "first" },
      { key: "a2", answer: "48", summary: "other" },
    ]);
  });
});

describe("buildDisputeState", () => {
  it("carries the domain line and the problem", () => {
    expect(buildDisputeState({ id: "t1", domain: "rates", prompt: "A train goes 60 km in 1 h." })).toBe(
      `${MARK.domain} rates\nPROBLEM: A train goes 60 km in 1 h.`,
    );
  });
});

describe("disputeWinner", () => {
  it("returns the chosen candidate's answer at or above the confidence bar", () => {
    expect(disputeWinner(pick("a2", 0.8), candidates, 0.8)).toBe("48");
    expect(disputeWinner(pick("a1", 0.95), candidates, 0.8)).toBe("42");
  });

  it("returns undefined below the bar, for unclear, unknown keys, or no answer", () => {
    expect(disputeWinner(pick("a2", 0.79), candidates, 0.8)).toBeUndefined();
    expect(disputeWinner(pick(UNCLEAR_CHOICE, 1), candidates, 0.5)).toBeUndefined();
    expect(disputeWinner(pick("a9", 1), candidates, 0.5)).toBeUndefined();
    expect(disputeWinner(undefined, candidates, 0.5)).toBeUndefined();
    expect(disputeWinner({ type: "noul", noul: 1 }, candidates, 0.5)).toBeUndefined();
  });
});

describe("conservativeAnswer", () => {
  const noulQ: Question = { type: "noul", instructions: "?" };

  it("always re-solves on verify and never adopts", () => {
    expect(conservativeAnswer(QK.verify, noulQ)).toEqual({ type: "noul", noul: 1 });
    expect(conservativeAnswer(QK.adopt, noulQ)).toEqual({ type: "noul", noul: 0 });
  });

  it("never settles a dispute", () => {
    const a = conservativeAnswer(QK.dispute, disputeQuestion(candidates));
    expect(a).toEqual({
      type: "choice",
      choice: UNCLEAR_CHOICE,
      probabilities: { a1: 1 / 3, a2: 1 / 3, [UNCLEAR_CHOICE]: 1 / 3 },
      confidence: 0,
    });
    expect(disputeWinner(a, candidates, 0)).toBeUndefined();
  });

  it("adds the unclear option when a dispute question lacks it", () => {
    const q: Question = { type: "choice", instructions: "?", criteria: { a1: "x" } };
    expect(conservativeAnswer(QK.dispute, q)).toMatchObject({ choice: UNCLEAR_CHOICE, probabilities: { a1: 0.5, [UNCLEAR_CHOICE]: 0.5 } });
  });

  it("is neutral for claim and unknown keys", () => {
    const claimQ: Question = { type: "choice", instructions: "?", criteria: { t1: "a", t2: "b", none: "c", t4: "d" } };
    expect(conservativeAnswer(QK.claim, claimQ)).toEqual({
      type: "choice",
      choice: "t1",
      probabilities: { t1: 0.25, t2: 0.25, none: 0.25, t4: 0.25 },
      confidence: 0,
    });
    expect(conservativeAnswer("other", noulQ)).toEqual({ type: "noul", noul: 0.5 });
    expect(conservativeAnswer("other", { type: "score", instructions: "?", criteria: ["lo", "mid", "hi"] })).toEqual({
      type: "score",
      score: 1,
      confidence: 0,
    });
  });
});
