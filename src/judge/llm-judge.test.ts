import { describe, expect, it } from "vitest";
import type { CallMeta, LLM, LLMRequest, LLMResult, Question } from "../core/types";
import { firstJsonObject, JUDGE_SYSTEM_PROMPT, LLMJudge, parseJudgeAnswers } from "./llm-judge";

class FakeLLM implements LLM {
  readonly id = "fake/model";
  readonly requests: LLMRequest[] = [];
  constructor(
    private readonly text: string,
    readonly simulated = true,
  ) {}
  async complete(req: LLMRequest): Promise<LLMResult> {
    this.requests.push(req);
    return {
      text: this.text,
      usage: { inputTokens: 321, outputTokens: 45, costUsd: 0.003 },
      latencyMs: 1500,
      model: "fake/model-2026",
    };
  }
}

const meta: CallMeta = { runId: "r1", purpose: "adjudicate", cellId: "c2", taskId: "t7" };
const questions: Record<string, Question> = {
  verify: { type: "noul", instructions: "The proposed answer is likely wrong." },
  claim: { type: "choice", instructions: "Which task fits this cell?", criteria: { t1: "task one", t2: "task two", none: "decline" } },
  quality: { type: "score", instructions: "Rate the strategy.", criteria: ["bad", "ok", "good", "great"] },
};

describe("LLMJudge", () => {
  it("identifies as System 2 and mirrors the LLM's simulated flag", () => {
    const judge = new LLMJudge({ llm: new FakeLLM("{}", false) });
    expect([judge.id, judge.tier, judge.simulated]).toEqual(["llm-judge:fake/model", "system2", false]);
  });

  it("sends a JSON-mode prompt listing every question and the schema", async () => {
    const llm = new FakeLLM('{"verify":{"type":"noul","noul":0.8}}');
    const judge = new LLMJudge({ llm });
    const r = await judge.ask({ state: "DOMAIN: logic\nANSWER: 4", questions, meta });

    const req = llm.requests[0]!;
    expect(req).toMatchObject({ json: true, temperature: 0, maxTokens: 120 * 3 + 200, meta });
    expect(req.messages[0]).toEqual({ role: "system", content: JUDGE_SYSTEM_PROMPT });
    const user = req.messages[1]!;
    expect(user.role).toBe("user");
    expect(user.content.startsWith("DOMAIN: logic\nANSWER: 4\n\nQUESTIONS\n")).toBe(true);
    for (const text of ['"verify" (noul)', '"claim" (choice)', "t2: task two", '"quality" (score)', "3: great"]) {
      expect(user.content).toContain(text);
    }
    expect(user.content).toContain('{"type":"score","score":<level index 0..n-1>,"confidence":<0..1>}');
    expect(user.content).toContain('Required keys: "verify", "claim", "quality"');

    expect(r.usage).toEqual({ inputTokens: 321, outputTokens: 45, costUsd: 0.003 });
    expect(r.latencyMs).toBe(1500);
    expect(r.model).toBe("fake/model-2026");
    expect(r.answers.verify).toEqual({ type: "noul", noul: 0.8 });
  });

  it("honours an explicit maxTokens", async () => {
    const llm = new FakeLLM("{}");
    await new LLMJudge({ llm, maxTokens: 64 }).ask({ state: "S", questions, meta });
    expect(llm.requests[0]?.maxTokens).toBe(64);
  });
});

describe("parseJudgeAnswers", () => {
  it("reads JSON wrapped in code fences and prose", () => {
    const text = [
      "Sure! Here is my verdict:",
      "```json",
      JSON.stringify({
        verify: { type: "noul", noul: 0.12 },
        claim: { type: "choice", choice: "t2", probabilities: { t1: 0.1, t2: 0.8, none: 0.1 }, confidence: 0.8 },
        quality: { type: "score", score: 2, confidence: 0.7 },
      }),
      "```",
    ].join("\n");
    expect(parseJudgeAnswers(text, questions)).toEqual({
      verify: { type: "noul", noul: 0.12 },
      claim: { type: "choice", choice: "t2", probabilities: { t1: 0.1, t2: 0.8, none: 0.1 }, confidence: 0.8 },
      quality: { type: "score", score: 2, confidence: 0.7 },
    });
  });

  it("replaces an invalid choice with the argmax of the criteria probabilities", () => {
    const text = JSON.stringify({
      claim: { type: "choice", choice: "t9", probabilities: { t1: 0.2, t2: 0.5, t9: 0.9 }, confidence: 0.95 },
    });
    const claim = parseJudgeAnswers(text, questions).claim;
    expect(claim).toMatchObject({ type: "choice", choice: "t2" });
    if (claim?.type !== "choice") throw new Error("expected choice");
    expect(claim.probabilities.t1).toBeCloseTo(0.2 / 0.7);
    expect(claim.probabilities.t2).toBeCloseTo(0.5 / 0.7);
    expect(claim.probabilities.none).toBe(0);
    expect(claim.confidence).toBeCloseTo(0.5 / 0.7);
  });

  it("fills missing probability keys with 0 and renormalizes, uniform when all 0", () => {
    const partial = parseJudgeAnswers(
      JSON.stringify({ claim: { choice: "t1", probabilities: { t1: 3, t2: 1 }, confidence: 0.75 } }),
      questions,
    ).claim;
    expect(partial).toEqual({
      type: "choice",
      choice: "t1",
      probabilities: { t1: 0.75, t2: 0.25, none: 0 },
      confidence: 0.75,
    });

    const zeros = parseJudgeAnswers(JSON.stringify({ claim: { choice: "none", confidence: 0.9 } }), questions).claim;
    expect(zeros).toEqual({
      type: "choice",
      choice: "none",
      probabilities: { t1: 1 / 3, t2: 1 / 3, none: 1 / 3 },
      confidence: 0.9,
    });
  });

  it("clamps out-of-range noul and score values", () => {
    const answers = parseJudgeAnswers(
      '{"verify":{"type":"noul","noul":1.7},"quality":{"type":"score","score":9,"confidence":2}}',
      questions,
    );
    expect(answers.verify).toEqual({ type: "noul", noul: 1 });
    expect(answers.quality).toEqual({ type: "score", score: 3, confidence: 1 });
    expect(parseJudgeAnswers('{"quality":{"score":-2,"confidence":0.4}}', questions).quality).toEqual({
      type: "score",
      score: 0,
      confidence: 0.4,
    });
  });

  it("falls back to neutral answers for missing keys", () => {
    const answers = parseJudgeAnswers('{"verify":{"type":"noul","noul":0.3}}', questions);
    expect(answers.verify).toEqual({ type: "noul", noul: 0.3 });
    expect(answers.claim).toEqual({
      type: "choice",
      choice: "t1",
      probabilities: { t1: 1 / 3, t2: 1 / 3, none: 1 / 3 },
      confidence: 0,
    });
    expect(answers.quality).toEqual({ type: "score", score: 1, confidence: 0 });
  });

  it("returns all-neutral answers for garbage or truncated text", () => {
    const neutral = {
      verify: { type: "noul", noul: 0.5 },
      claim: { type: "choice", choice: "t1", probabilities: { t1: 1 / 3, t2: 1 / 3, none: 1 / 3 }, confidence: 0 },
      quality: { type: "score", score: 1, confidence: 0 },
    };
    expect(parseJudgeAnswers("I cannot decide this.", questions)).toEqual(neutral);
    expect(parseJudgeAnswers('{"verify": {"type": "noul", "noul": 0.9', questions)).toEqual(neutral);
    expect(parseJudgeAnswers('{"verify":{"noul":"high"},"claim":{"choice":"t9"},"quality":{}}', questions)).toEqual(
      neutral,
    );
  });

  it("accepts bare values and numeric strings", () => {
    const answers = parseJudgeAnswers('{"verify":0.25,"claim":"none","quality":{"score":"2"}}', questions);
    expect(answers.verify).toEqual({ type: "noul", noul: 0.25 });
    expect(answers.claim).toMatchObject({ choice: "none", confidence: 1 / 3 });
    expect(answers.quality).toEqual({ type: "score", score: 2, confidence: 0.5 });
  });
});

describe("firstJsonObject", () => {
  it("skips unparseable brace spans and respects braces inside strings", () => {
    expect(firstJsonObject('thinking {not json} then {"a":"x}{y","b":{"c":1}} trailing {"z":2}')).toEqual({
      a: "x}{y",
      b: { c: 1 },
    });
    expect(firstJsonObject("[1, 2]")).toBeUndefined();
  });
});
