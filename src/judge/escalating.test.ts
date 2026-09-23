import { describe, expect, it } from "vitest";
import { BudgetExceededError, MARK } from "../core/types";
import type { Answer, CallMeta, Decision, Judge, JudgeRequest, JudgeResult, Question, Tier, Usage } from "../core/types";
import { EscalatingJudge } from "./escalating";
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

function setup(opts: { s1: Judge; s2?: FakeJudge; threshold?: number; precedentsPerKey?: number }) {
  const decisions: Decision[] = [];
  const precedents = new MemoryPrecedentStore();
  const s2 = opts.s2 ?? new FakeJudge("s2", "system2", () => ({ verify: noul(0.05) }), S2_USAGE, 900);
  let clock = 1000;
  let id = 0;
  const judge = new EscalatingJudge({
    s1: opts.s1,
    s2,
    threshold: opts.threshold ?? 0.6,
    precedents,
    precedentsPerKey: opts.precedentsPerKey,
    onDecision: (d) => decisions.push(d),
    now: () => clock++,
    newId: () => `d${++id}`,
  });
  return { judge, s2, decisions, precedents };
}

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
    expect(decisions).toEqual([
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
    expect(byKey.verify).toMatchObject({ tier: "system2", escalated: true, latencyMs: 970, answer: noul(0.05) });
    expect(byKey.verify?.confidence).toBeCloseTo(0.9);
    expect(byKey.verify?.usage).toEqual({ inputTokens: 450, outputTokens: 60, costUsd: 0.0041 });

    expect(precedents.size()).toBe(1);
    expect(precedents.relevant("verify", 1)[0]).toMatchObject({ key: "verify", state: "STATE", verdict: noul(0.05) });
  });

  it("escalates keys System 1 left unanswered", async () => {
    const s1 = new FakeJudge("s1", "system1", () => ({}), S1_USAGE, 70);
    const { judge, s2, decisions } = setup({ s1 });
    const r = await judge.ask({ state: "S", questions: { verify: verifyQ }, meta });
    expect(s2.calls).toHaveLength(1);
    expect(r.answers.verify).toEqual(noul(0.05));
    expect(decisions[0]).toMatchObject({ tier: "system2", escalated: true, usage: S2_USAGE });
  });

  it("feeds System-2 verdicts back to System 1 as precedents, so escalations fall", async () => {
    // Stands in for Jev learning from precedents: confident once it has seen one.
    const s1 = new FakeJudge(
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
    const { judge, s2, decisions } = setup({ s1 });

    await judge.ask({ state: "DOMAIN: logic\nANSWER: 7", questions: { verify: verifyQ }, meta });
    await judge.ask({ state: "DOMAIN: logic\nANSWER: 9", questions: { verify: verifyQ }, meta });

    expect(s2.calls).toHaveLength(1);
    expect(s1.calls[0]?.state).toBe("DOMAIN: logic\nANSWER: 7");
    expect(s1.calls[1]?.state).toBe(
      `DOMAIN: logic\nANSWER: 9\n\n${MARK.precedents}\n- [verify] DOMAIN: logic ANSWER: 7 => no 0.05`,
    );
    expect(s2.calls[0]?.state).not.toContain(MARK.precedents);
    expect(decisions.map((d) => [d.tier, d.precedentsUsed])).toEqual([
      ["system2", 0],
      ["system1", 1],
    ]);
  });

  it("includes at most precedentsPerKey precedents, only for asked keys", async () => {
    const s1 = new FakeJudge("s1", "system1", () => ({ verify: noul(0.95) }), S1_USAGE, 70);
    const { judge, decisions, precedents } = setup({ s1, precedentsPerKey: 2 });
    for (let i = 1; i <= 5; i++) precedents.add({ key: "verify", state: `v${i}`, verdict: noul(0.9), at: i });
    precedents.add({ key: "claim", state: "c1", verdict: choice("t1", 0.9), at: 6 });

    await judge.ask({ state: "S", questions: { verify: verifyQ }, meta });

    const state = s1.calls[0]?.state ?? "";
    expect(state).toBe(`S\n\n${MARK.precedents}\n- [verify] v4 => yes 0.90\n- [verify] v5 => yes 0.90`);
    expect(decisions[0]?.precedentsUsed).toBe(2);
  });

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
    expect(precedents.size()).toBe(2);
  });

  it("rethrows System-2 failures", async () => {
    const s1 = new FakeJudge("s1", "system1", () => ({ verify: noul(0.5) }), S1_USAGE, 70);
    const s2 = new FailingJudge("s2", new Error("503"));
    const judge = new EscalatingJudge({ s1, s2, threshold: 0.6, precedents: new MemoryPrecedentStore() });
    await expect(judge.ask({ state: "S", questions: { verify: verifyQ }, meta })).rejects.toThrow("503");
  });

  it("does not route around the cost cap", async () => {
    const s1 = new FailingJudge("s1", new BudgetExceededError(1, 1));
    const { judge, s2 } = setup({ s1 });
    await expect(judge.ask({ state: "S", questions: { verify: verifyQ }, meta })).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    expect(s2.calls).toHaveLength(0);
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
      await judge.ask({ state: "S", questions: { verify: verifyQ }, meta });
    }
    expect(new Set(ids).size).toBe(2);
  });
});
