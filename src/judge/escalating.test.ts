import { describe, expect, it } from "vitest";
import { BudgetExceededError, MARK, QK, UNCLEAR_CHOICE } from "../core/types";
import type { Answer, CallMeta, Decision, Judge, JudgeRequest, JudgeResult, Question, Tier, Usage } from "../core/types";
import { conservativeAnswer } from "./dispute";
import { EscalatingJudge, sameVerdict } from "./escalating";
import type { EscalatingJudgeOptions } from "./escalating";
import { MemoryPrecedentStore } from "./precedents";

type Responder = (req: JudgeRequest) => Record<string, Answer>;

class FakeJudge implements Judge {
  readonly calls: JudgeRequest[] = [];
  constructor(
    readonly id: string,
    readonly tier: Tier,
    private readonly respond: Responder,
    private readonly usage: Usage,
    private readonly latencyMs: number,
    readonly simulated = true,
  ) {}

  async ask(req: JudgeRequest): Promise<JudgeResult> {
    this.calls.push(req);
    return { answers: this.respond(req), usage: this.usage, latencyMs: this.latencyMs, model: `${this.id}-model` };
  }
}

class FailingJudge implements Judge {
  readonly tier: Tier = "system1";
  readonly simulated = true;
  calls = 0;
  constructor(
    readonly id: string,
    private readonly err: Error,
  ) {}
  async ask(): Promise<JudgeResult> {
    this.calls += 1;
    throw this.err;
  }
}

const S1_USAGE: Usage = { inputTokens: 100, outputTokens: 0, costUsd: 0.0002 };
const S2_USAGE: Usage = { inputTokens: 400, outputTokens: 60, costUsd: 0.004 };
const meta: CallMeta = { runId: "r1", purpose: "verify", cellId: "c1", taskId: "t1" };
const verifyQ: Question = { type: "noul", instructions: "Does this answer need an independent re-solve?" };
const claimQ: Question = { type: "choice", instructions: "Pick a task", criteria: { t1: "task 1", none: "decline" } };
const noul = (p: number): Answer => ({ type: "noul", noul: p });
const choice = (c: string, confidence: number): Answer => ({
  type: "choice",
  choice: c,
  probabilities: { t1: c === "t1" ? confidence : 1 - confidence, none: c === "none" ? confidence : 1 - confidence },
  confidence,
});

type SetupOptions<S extends Judge> = Partial<Omit<EscalatingJudgeOptions, "s1" | "s2">> & { s1: Judge; s2?: S };

// Without opts.s2, S defaults to FakeJudge so tests can inspect the default System 2's calls.
function setup<S extends Judge = FakeJudge>(opts: SetupOptions<S>) {
  const decisions: Decision[] = [];
  const precedents = new MemoryPrecedentStore();
  const s2 = (opts.s2 ?? new FakeJudge("s2", "system2", () => ({ verify: noul(0.05) }), S2_USAGE, 900)) as S;
  let clock = 1000;
  let id = 0;
  const judge = new EscalatingJudge({
    threshold: 0.6,
    precedents,
    onDecision: (d) => decisions.push(d),
    now: () => clock++,
    newId: () => `d${++id}`,
    ...opts,
    s2,
  });
  return { judge, s2, decisions, precedents };
}

/** Answers verify with the next queued noul, so a test scripts System 1 call by call. */
function scriptedS1(nouls: number[]): FakeJudge {
  let i = 0;
  return new FakeJudge("s1", "system1", () => ({ verify: noul(nouls[i++] ?? 0.5) }), S1_USAGE, 70);
}

const askVerify = (judge: Judge, state = "S") => judge.ask({ state, questions: { verify: verifyQ }, meta });

describe("EscalatingJudge", () => {
  it("identifies itself as a System-1 composite", () => {
    const s1 = new FakeJudge("jev", "system1", () => ({}), S1_USAGE, 70);
    const s2 = new FakeJudge("llm", "system2", () => ({}), S2_USAGE, 900);
    const both = new EscalatingJudge({ s1, s2, threshold: 0.5, precedents: new MemoryPrecedentStore() });
    expect(both.id).toBe("jev>llm");
    expect(both.tier).toBe("system1");
    expect(both.simulated).toBe(true);
    const real = new FakeJudge("jev", "system1", () => ({}), S1_USAGE, 70, false);
    expect(new EscalatingJudge({ s1: real, s2, threshold: 0.5, precedents: new MemoryPrecedentStore() }).simulated).toBe(
      false,
    );
  });

  it("stays at System 1 when confidence meets the threshold", async () => {
    const s1 = new FakeJudge("s1", "system1", () => ({ verify: noul(0.75) }), S1_USAGE, 70);
    const { judge, s2, decisions, precedents } = setup({ s1, threshold: 0.5 });
    const r = await judge.ask({ state: "ANSWER: 42", questions: { verify: verifyQ }, meta });

    expect(s2.calls).toHaveLength(0);
    expect(r).toEqual({ answers: { verify: noul(0.75) }, usage: S1_USAGE, latencyMs: 70, model: "s1-model" });
    expect(precedents.size()).toBe(0);
    expect(precedents.pendingSize()).toBe(0);
    expect(decisions).toStrictEqual([
      {
        id: "d1",
        runId: "r1",
        cellId: "c1",
        taskId: "t1",
        key: "verify",
        tier: "system1",
        escalated: false,
        answer: noul(0.75),
        confidence: 0.5,
        latencyMs: 70,
        usage: S1_USAGE,
        precedentsUsed: 0,
        at: 1000,
      },
    ]);
  });

  it("escalates only the keys below the threshold, with the original state", async () => {
    const s1 = new FakeJudge("s1", "system1", () => ({ verify: noul(0.55), claim: choice("t1", 0.9) }), S1_USAGE, 70);
    const { judge, s2, decisions, precedents } = setup({ s1 });
    const r = await judge.ask({ state: "STATE", questions: { claim: claimQ, verify: verifyQ }, meta });

    expect(s2.calls).toHaveLength(1);
    expect(s2.calls[0]).toEqual({ state: "STATE", questions: { verify: verifyQ }, meta });
    expect(r.answers).toEqual({ claim: choice("t1", 0.9), verify: noul(0.05) });
    expect(r.usage).toEqual({ inputTokens: 500, outputTokens: 60, costUsd: 0.0042 });
    expect(r.latencyMs).toBe(970);
    expect(r.model).toBe("s1-model+s2-model");

    const byKey = Object.fromEntries(decisions.map((d) => [d.key, d]));
    expect(byKey.claim).toMatchObject({ tier: "system1", escalated: false, latencyMs: 70, confidence: 0.9 });
    expect(byKey.claim?.usage).toEqual({ inputTokens: 50, outputTokens: 0, costUsd: 0.0001 });
    expect(byKey.claim?.precedentId).toBeUndefined();
    expect(byKey.verify).toMatchObject({ tier: "system2", escalated: true, latencyMs: 970, answer: noul(0.05) });
    expect(byKey.verify?.confidence).toBeCloseTo(0.9);
    expect(byKey.verify?.usage).toEqual({ inputTokens: 450, outputTokens: 60, costUsd: 0.0041 });

    // The verdict is pending until the swarm confirms the outcome.
    expect(precedents.size()).toBe(0);
    expect(precedents.pendingSize()).toBe(1);
    precedents.confirm(byKey.verify?.precedentId ?? "");
    expect(precedents.relevant("verify", 1)[0]).toMatchObject({ key: "verify", state: "STATE", verdict: noul(0.05) });
  });

  it("escalates keys System 1 left unanswered", async () => {
    const s1 = new FakeJudge("s1", "system1", () => ({}), S1_USAGE, 70);
    const { judge, s2, decisions } = setup({ s1 });
    const r = await askVerify(judge);
    expect(s2.calls).toHaveLength(1);
    expect(r.answers.verify).toEqual(noul(0.05));
    expect(decisions[0]).toMatchObject({ tier: "system2", escalated: true, usage: S2_USAGE });
  });

  describe("precedents", () => {
    // Stands in for Jev learning from precedents: confident once it has seen one.
    const learner = () =>
      new FakeJudge(
        "s1",
        "system1",
        (req) => {
          const after = req.state.split(`${MARK.precedents}\n`)[1] ?? "";
          const seen = after.split("\n").filter((l) => l.startsWith("- ")).length;
          return { verify: noul(seen > 0 ? 0.1 : 0.5) };
        },
        S1_USAGE,
        70,
      );

    it("feeds confirmed System-2 verdicts back to System 1, so escalations fall", async () => {
      const s1 = learner();
      const { judge, s2, decisions, precedents } = setup({ s1 });

      await askVerify(judge, "DOMAIN: logic\nANSWER: 7");
      precedents.confirm(decisions[0]?.precedentId ?? "");
      await askVerify(judge, "DOMAIN: logic\nANSWER: 9");

      expect(s2.calls).toHaveLength(1);
      expect(s1.calls[0]?.state).toBe("DOMAIN: logic\nANSWER: 7");
      expect(s1.calls[1]?.state).toBe(
        `DOMAIN: logic\nANSWER: 9\n\n${MARK.precedents}\n- [verify] DOMAIN: logic ANSWER: 7 => no 0.05`,
      );
      expect(s2.calls[0]?.state).not.toContain(MARK.precedents);
      expect(decisions.map((d) => [d.tier, d.precedentsUsed, d.precedentId])).toEqual([
        ["system2", 0, "p1"],
        ["system1", 1, undefined],
      ]);
    });

    it("hides pending verdicts from System 1", async () => {
      const s1 = learner();
      const { judge, s2, decisions } = setup({ s1 });
      await askVerify(judge, "A");
      await askVerify(judge, "B");
      expect(s1.calls[1]?.state).toBe("B");
      expect(s2.calls).toHaveLength(2);
      expect(decisions.map((d) => d.precedentId)).toEqual(["p1", "p2"]);
    });

    it("never shows rejected verdicts to System 1", async () => {
      const s1 = learner();
      const { judge, decisions, precedents } = setup({ s1 });
      await askVerify(judge, "A");
      precedents.reject(decisions[0]?.precedentId ?? "");
      precedents.confirm(decisions[0]?.precedentId ?? "");
      await askVerify(judge, "B");
      expect(s1.calls[1]?.state).toBe("B");
      expect(precedents.size()).toBe(0);
    });

    it("includes at most precedentsPerKey precedents, only for asked keys", async () => {
      const s1 = new FakeJudge("s1", "system1", () => ({ verify: noul(0.95) }), S1_USAGE, 70);
      const { judge, decisions, precedents } = setup({ s1, precedentsPerKey: 2 });
      for (let i = 1; i <= 5; i++) precedents.add({ key: "verify", state: `v${i}`, verdict: noul(0.9), at: i });
      precedents.add({ key: "claim", state: "c1", verdict: choice("t1", 0.9), at: 6 });

      await askVerify(judge);

      const state = s1.calls[0]?.state ?? "";
      expect(state).toBe(`S\n\n${MARK.precedents}\n- [verify] v4 => yes 0.90\n- [verify] v5 => yes 0.90`);
      expect(decisions[0]?.precedentsUsed).toBe(2);
    });
  });

  describe("failures", () => {
    it("escalates every key to System 2 when System 1 throws", async () => {
      const s1 = new FailingJudge("s1", new Error("ECONNRESET"));
      const s2 = new FakeJudge(
        "s2",
        "system2",
        () => ({ verify: noul(0.9), claim: choice("none", 0.8) }),
        S2_USAGE,
        900,
      );
      const { judge, decisions, precedents } = setup({ s1, s2 });
      const r = await judge.ask({ state: "S", questions: { verify: verifyQ, claim: claimQ }, meta });

      expect(s2.calls[0]?.questions).toEqual({ verify: verifyQ, claim: claimQ });
      expect(r).toMatchObject({ usage: S2_USAGE, latencyMs: 900, model: "s2-model" });
      expect(decisions.map((d) => [d.key, d.tier, d.escalated, d.latencyMs])).toEqual([
        ["verify", "system2", true, 900],
        ["claim", "system2", true, 900],
      ]);
      expect(decisions.every((d) => d.precedentId !== undefined && d.fallback === undefined)).toBe(true);
      expect(precedents.pendingSize()).toBe(2);
    });

    it("rethrows System-2 failures without a fallback", async () => {
      const s1 = new FakeJudge("s1", "system1", () => ({ verify: noul(0.5) }), S1_USAGE, 70);
      const s2 = new FailingJudge("s2", new Error("503"));
      const judge = new EscalatingJudge({ s1, s2, threshold: 0.6, precedents: new MemoryPrecedentStore() });
      await expect(askVerify(judge)).rejects.toThrow("503");
    });

    it("uses fallback answers for escalated keys when System 2 throws, writing no precedent", async () => {
      const s1 = new FakeJudge("s1", "system1", () => ({ verify: noul(0.5), claim: choice("t1", 0.9) }), S1_USAGE, 70);
      const s2 = new FailingJudge("s2", new Error("503"));
      const { judge, decisions, precedents } = setup({ s1, s2, fallback: conservativeAnswer });
      const r = await judge.ask({ state: "S", questions: { verify: verifyQ, claim: claimQ }, meta });

      expect(r).toEqual({
        answers: { verify: noul(1), claim: choice("t1", 0.9) },
        usage: S1_USAGE,
        latencyMs: 70,
        model: "s1-model+fallback",
      });
      const byKey = Object.fromEntries(decisions.map((d) => [d.key, d]));
      expect(byKey.verify).toMatchObject({ tier: "system2", escalated: true, fallback: true, confidence: 0, latencyMs: 70 });
      expect(byKey.verify?.precedentId).toBeUndefined();
      expect(byKey.verify?.usage).toEqual({ inputTokens: 50, outputTokens: 0, costUsd: 0.0001 });
      expect(byKey.claim).toMatchObject({ tier: "system1", escalated: false, confidence: 0.9 });
      expect(byKey.claim?.fallback).toBeUndefined();
      expect(precedents.pendingSize()).toBe(0);
      expect(precedents.size()).toBe(0);
    });

    it("falls back for every key when both systems fail", async () => {
      const s1 = new FailingJudge("s1", new Error("jev down"));
      const s2 = new FailingJudge("s2", new Error("llm down"));
      const disputeQ: Question = { type: "choice", instructions: "?", criteria: { a1: "x", a2: "y", [UNCLEAR_CHOICE]: "?" } };
      const { judge, decisions } = setup({ s1, s2, fallback: conservativeAnswer });
      const r = await judge.ask({ state: "S", questions: { [QK.adopt]: verifyQ, [QK.dispute]: disputeQ }, meta });

      expect(r.model).toBe("fallback");
      expect(r.usage).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
      expect(r.answers[QK.adopt]).toEqual(noul(0));
      expect(r.answers[QK.dispute]).toMatchObject({ type: "choice", choice: UNCLEAR_CHOICE, confidence: 0 });
      expect(decisions.map((d) => [d.key, d.fallback, d.escalated])).toEqual([
        [QK.adopt, true, true],
        [QK.dispute, true, true],
      ]);
    });

    it("does not route around the cost cap at System 1", async () => {
      const s1 = new FailingJudge("s1", new BudgetExceededError(1, 1));
      const { judge, s2 } = setup({ s1, fallback: conservativeAnswer });
      await expect(askVerify(judge)).rejects.toBeInstanceOf(BudgetExceededError);
      expect(s2.calls).toHaveLength(0);
    });

    it("rethrows a System-2 budget error even with a fallback", async () => {
      const s1 = new FakeJudge("s1", "system1", () => ({ verify: noul(0.5) }), S1_USAGE, 70);
      const s2 = new FailingJudge("s2", new BudgetExceededError(2, 1));
      const { judge, decisions } = setup({ s1, s2, fallback: conservativeAnswer });
      await expect(askVerify(judge)).rejects.toBeInstanceOf(BudgetExceededError);
      expect(decisions).toEqual([]);
    });
  });

  describe("calibration guard", () => {
    // System 1 leans "yes" at low confidence while System 2 says a firm "no": a disagreement.
    const disagreeing = () => new FakeJudge("s1", "system1", () => ({ verify: noul(0.55) }), S1_USAGE, 70);

    it("guards a key after the window fills with disagreement and then skips System 1 for it", async () => {
      const guards: Array<[string, number]> = [];
      const s1 = disagreeing();
      const { judge, s2, decisions } = setup({
        s1,
        guard: { window: 3, maxDisagreement: 0.5, onGuard: (k, d) => guards.push([k, d]) },
      });

      for (let i = 0; i < 2; i++) await askVerify(judge);
      expect(judge.isGuarded("verify")).toBe(false);
      await askVerify(judge);
      expect(judge.isGuarded("verify")).toBe(true);
      expect(guards).toEqual([["verify", 1]]);

      await askVerify(judge);
      await askVerify(judge);
      expect(s1.calls).toHaveLength(3);
      expect(s2.calls).toHaveLength(5);
      expect(guards).toHaveLength(1);
      expect(decisions.slice(0, 3).every((d) => d.guarded === undefined)).toBe(true);
      expect(decisions[3]).toMatchObject({
        tier: "system2",
        escalated: true,
        guarded: true,
        precedentsUsed: 0,
        latencyMs: 900,
        usage: S2_USAGE,
      });
      expect(decisions[3]?.precedentId).toBeDefined();
    });

    it("sends only unguarded keys to System 1 in a mixed request", async () => {
      const s1 = new FakeJudge("s1", "system1", () => ({ verify: noul(0.55), claim: choice("t1", 0.9) }), S1_USAGE, 70);
      const { judge, precedents } = setup({ s1, guard: { window: 1, maxDisagreement: 0 } });
      await askVerify(judge);
      expect(judge.isGuarded("verify")).toBe(true);
      precedents.add({ key: "verify", state: "old", verdict: noul(0.1), at: 1 });

      const r = await judge.ask({ state: "S", questions: { verify: verifyQ, claim: claimQ }, meta });
      expect(s1.calls[1]?.questions).toEqual({ claim: claimQ });
      expect(s1.calls[1]?.state).toBe("S");
      expect(r.answers).toEqual({ verify: noul(0.05), claim: choice("t1", 0.9) });
      expect(r.usage).toEqual({ inputTokens: 500, outputTokens: 60, costUsd: 0.0042 });
    });

    it("counts only the last window and requires strictly more than the limit", async () => {
      // Agree (0.45 vs 0.05), agree, disagree, disagree: 2/4 = 0.5 is not above 0.5.
      const s1 = scriptedS1([0.45, 0.45, 0.55, 0.55, 0.55]);
      const { judge } = setup({ s1, guard: { window: 4, maxDisagreement: 0.5 } });
      for (let i = 0; i < 4; i++) await askVerify(judge);
      expect(judge.isGuarded("verify")).toBe(false);
      // The oldest agreement leaves the window: 3/4 disagree.
      await askVerify(judge);
      expect(judge.isGuarded("verify")).toBe(true);
    });

    it("never guards a key where System 1 agrees with System 2", async () => {
      const s1 = new FakeJudge("s1", "system1", () => ({ verify: noul(0.45) }), S1_USAGE, 70);
      const { judge, decisions } = setup({ s1, guard: { window: 2, maxDisagreement: 0 } });
      for (let i = 0; i < 5; i++) await askVerify(judge);
      expect(judge.isGuarded("verify")).toBe(false);
      expect(s1.calls).toHaveLength(5);
      expect(decisions.every((d) => d.guarded === undefined)).toBe(true);
    });

    it("takes no sample when System 1 failed or stayed confident", async () => {
      const s1 = new FailingJudge("s1", new Error("down"));
      const { judge } = setup({ s1, guard: { window: 1, maxDisagreement: 0 } });
      await askVerify(judge);
      expect(judge.isGuarded("verify")).toBe(false);

      const confident = new FakeJudge("s1", "system1", () => ({ verify: noul(0.95) }), S1_USAGE, 70);
      const other = setup({ s1: confident, guard: { window: 1, maxDisagreement: 0 } });
      await askVerify(other.judge);
      expect(other.judge.isGuarded("verify")).toBe(false);
    });

    it("falls back for a guarded key when System 2 is down", async () => {
      const s1 = disagreeing();
      let down = false;
      const s2 = new FakeJudge(
        "s2",
        "system2",
        () => {
          if (down) throw new Error("503");
          return { verify: noul(0.05) };
        },
        S2_USAGE,
        900,
      );
      const { judge, decisions } = setup({ s1, s2, fallback: conservativeAnswer, guard: { window: 1, maxDisagreement: 0 } });
      await askVerify(judge);
      down = true;
      const r = await askVerify(judge);
      expect(r.answers.verify).toEqual(noul(1));
      expect(decisions[1]).toMatchObject({ guarded: true, fallback: true, confidence: 0 });
      expect(s1.calls).toHaveLength(1);
    });
  });

  it("gives decisions unique default ids across instances", async () => {
    const ids: string[] = [];
    const s1 = new FakeJudge("s1", "system1", () => ({ verify: noul(0.95) }), S1_USAGE, 70);
    const s2 = new FakeJudge("s2", "system2", () => ({}), S2_USAGE, 900);
    for (let i = 0; i < 2; i++) {
      const judge = new EscalatingJudge({
        s1,
        s2,
        threshold: 0.5,
        precedents: new MemoryPrecedentStore(),
        onDecision: (d) => ids.push(d.id),
      });
      await askVerify(judge);
    }
    expect(new Set(ids).size).toBe(2);
  });
});

describe("sameVerdict", () => {
  it("compares noul by side of 0.5", () => {
    expect(sameVerdict(noul(0.55), noul(0.99))).toBe(true);
    expect(sameVerdict(noul(0.5), noul(0.49))).toBe(false);
    expect(sameVerdict(noul(0.1), noul(0.4))).toBe(true);
  });

  it("compares choice by pick and score within half a level", () => {
    expect(sameVerdict(choice("t1", 0.3), choice("t1", 0.9))).toBe(true);
    expect(sameVerdict(choice("t1", 0.9), choice("none", 0.9))).toBe(false);
    expect(sameVerdict({ type: "score", score: 2, confidence: 1 }, { type: "score", score: 2.4, confidence: 1 })).toBe(true);
    expect(sameVerdict({ type: "score", score: 2, confidence: 1 }, { type: "score", score: 2.5, confidence: 1 })).toBe(false);
  });

  it("treats mismatched types as disagreement", () => {
    expect(sameVerdict(noul(0.9), choice("t1", 0.9))).toBe(false);
  });
});
