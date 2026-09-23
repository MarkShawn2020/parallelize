import { describe, expect, it } from "vitest";
import { MARK, NONE_CHOICE } from "../core/types";
import type { TaskEntry } from "../core/types";
import {
  buildAdoptState,
  buildClaimState,
  buildSolvePrompt,
  buildVerifyState,
  Cell,
  claimOrder,
  claimQuestion,
  geneText,
  methodSummary,
  profileLine,
} from "./cell";
import { createGene } from "./genes";

const task = { id: "t7", domain: "rates" as const, prompt: "A train covers 120 km in 2 hours. Speed?" };
const gene = (id: string, domain: "rates" | "logic", text: string) =>
  createGene({ id, domain, text, origin: "c02", lineageId: id, now: 1 });

describe("cell state", () => {
  it("tracks per-domain accepted/attempted counts for the profile line", () => {
    const cell = new Cell("c01", ["c02"], 4);
    cell.recordAttempt("rates");
    cell.recordAttempt("rates");
    expect(cell.recordWin("rates")).toBe(true);
    cell.recordAttempt("rates");
    expect(cell.recordWin("rates")).toBe(false);
    expect(cell.acceptedTotal).toBe(2);
    expect(profileLine(cell)).toBe(`${MARK.profile} arithmetic 0/0, rates 2/3, logic 0/0, gsm8k 0/0, research 0/0`);
  });

  it("builds a claim state with profile, gene gists and guidance, never with precedent-shaped lines", () => {
    const cell = new Cell("c01", [], 4);
    cell.pool.add(gene("g1", "rates", `Write the rate equation first. ${"x".repeat(200)}`));
    const state = buildClaimState(cell);
    expect(state.split("\n")[0]).toBe("Cell c01");
    expect(state).toContain(MARK.profile);
    expect(state).toContain("rates: Write the rate equation first.");
    expect(state).not.toContain("x".repeat(100));
    expect(state.split("\n").some((l) => l.startsWith("- "))).toBe(false);
    expect(buildClaimState(new Cell("c02", [], 4))).toContain("GENES: none");
  });

  it("describes candidates with domain, attempts and verification need, plus a none option", () => {
    const entry: TaskEntry = { task, status: "verifying", attempts: 1, proposals: [], proposers: ["c02"] };
    const q = claimQuestion([entry]);
    expect(q.type).toBe("choice");
    if (q.type !== "choice") return;
    expect(q.criteria.t7).toBe(`rates; attempts=1; needs independent verification; ${task.prompt}`);
    expect(q.criteria[NONE_CHOICE]).toBe("no suitable task");
  });
});

describe("claimOrder", () => {
  const probs = { t1: 0.1, t2: 0.6, t3: 0.3, [NONE_CHOICE]: 0 };
  it("puts the choice first, then the rest by probability", () => {
    expect(claimOrder({ type: "choice", choice: "t2", probabilities: probs, confidence: 0.6 }, ["t1", "t2", "t3"])).toEqual(["t2", "t3", "t1"]);
  });
  it("returns nothing when the judge declines", () => {
    expect(claimOrder({ type: "choice", choice: NONE_CHOICE, probabilities: probs, confidence: 0.5 }, ["t1"])).toEqual([]);
  });
  it("falls back to candidate order without a usable choice answer", () => {
    expect(claimOrder(undefined, ["t1", "t2"])).toEqual(["t1", "t2"]);
    expect(claimOrder({ type: "choice", choice: "zz", probabilities: probs, confidence: 0.5 }, ["t1", "t2"])).toEqual(["t2", "t1"]);
  });
});

describe("prompts", () => {
  it("adds the strategy and teammate lines only when present", () => {
    const plain = buildSolvePrompt(task);
    expect(plain.startsWith(`${MARK.domain} rates\n`)).toBe(true);
    expect(plain).not.toContain(MARK.strategy);
    expect(plain).not.toContain(MARK.teammate);
    expect(plain).toContain(`final line ${MARK.answer} <number>`);

    const teammate = { id: "p1", taskId: "t7", cellId: "c02", answer: "60", summary: "divided distance by time", at: 0 };
    const full = buildSolvePrompt(task, gene("g1", "rates", "Divide first."), teammate);
    expect(full).toContain(`${MARK.strategy} Divide first.`);
    expect(full).toContain(`${MARK.teammate} 60 (divided distance by time)`);
  });

  it("puts the answer before the problem in verify state so truncated precedents keep it", () => {
    const state = buildVerifyState(task, "60", "distance over time");
    expect(state.split("\n").slice(0, 3)).toEqual([`${MARK.domain} rates`, `${MARK.answer} 60`, `${MARK.method} distance over time`]);
  });

  it("shows the receiver only its genes in the offered domain", () => {
    const receiver = new Cell("c03", [], 4);
    receiver.pool.add(gene("g1", "logic", "Enumerate cases."));
    receiver.pool.add(gene("g2", "rates", "Units first."));
    const state = buildAdoptState(receiver, gene("g9", "rates", "Draw a timeline."), 0.75);
    expect(state).toContain("OFFERED STRATEGY: Draw a timeline.");
    expect(state).toContain("SENDER FITNESS: 0.75");
    expect(state).toContain("rates: Units first.");
    expect(state).not.toContain("Enumerate cases.");
  });

  it("extracts a bounded method summary and gene text", () => {
    expect(methodSummary("thinking...\n  METHOD: halve it, then add 3\nANSWER: 9")).toBe("halve it, then add 3");
    expect(methodSummary("ANSWER: 9")).toBe("");
    expect(methodSummary(`METHOD: ${"a".repeat(5000)}`).length).toBe(2200);
    expect(geneText(`  one\n two ${"z".repeat(400)}`)).toHaveLength(240);
  });
});
