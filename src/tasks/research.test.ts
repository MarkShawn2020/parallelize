import { describe, expect, it } from "vitest";
import type { LLM, LLMRequest, Task } from "../core/types";
import { MARK } from "../core/types";
import {
  MAX_CANARIES,
  RESEARCH_VERDICTS,
  ResearchTaskSource,
  claimText,
  extractVerdict,
  ideaLanguage,
  isCanaryTask,
  normalizeResearchAnswer,
  normalizeVerdict,
  parseClaims,
  pickCanaries,
  researchPrompt,
} from "./research";

const CJK = /[\u3400-\u9fff]/;

function plannerLLM(reply: string, seen: LLMRequest[] = []): LLM {
  return {
    id: "fake",
    simulated: true,
    async complete(req) {
      seen.push(req);
      return { text: reply, usage: { inputTokens: 10, outputTokens: 10, costUsd: 0 }, latencyMs: 0, model: "fake" };
    },
  };
}

const sixClaims = JSON.stringify({ claims: ["c1", "c2", "c3", "c4", "c5", "c6"] });
const load = (idea: string, seed: number, opts: { claims?: number; canaries?: number; reply?: string } = {}) =>
  new ResearchTaskSource({
    llm: plannerLLM(opts.reply ?? sixClaims),
    runId: "run",
    idea,
    claims: opts.claims ?? 6,
    canaries: opts.canaries ?? 4,
  }).load(999, seed);

describe("parseClaims", () => {
  it("reads a claims object, a bare array and a fenced reply", () => {
    expect(parseClaims('{"claims": ["a", "b"]}')).toEqual(["a", "b"]);
    expect(parseClaims('["a", "b"]')).toEqual(["a", "b"]);
    expect(parseClaims('Here you go:\n```json\n{"claims": ["a", "b"]}\n```\nGood luck.')).toEqual(["a", "b"]);
  });

  it("finds the first balanced object even with braces inside strings or prose before it", () => {
    expect(parseClaims('Note {not json} then {"claims": ["uses {braces} and \\"quotes\\"", "b"]}')).toEqual([
      'uses {braces} and "quotes"',
      "b",
    ]);
    expect(parseClaims('{"items": 1} and later ["x", "y"]')).toEqual(["x", "y"]);
  });

  it("trims, dedupes, drops non-strings and caps each claim at 160 chars", () => {
    const long = "x".repeat(300);
    expect(parseClaims(JSON.stringify({ claims: ["  a\n b ", "a b", 3, "", long] }))).toEqual(["a b", "x".repeat(160)]);
  });

  it("throws a clear error on garbage or an empty list", () => {
    expect(() => parseClaims("I cannot help with that.")).toThrow(/research planner: no claims found/);
    expect(() => parseClaims('{"claims": []}')).toThrow(/no claims found/);
    expect(() => parseClaims("")).toThrow(/<empty>/);
  });
});

describe("normalizeVerdict", () => {
  it("accepts English verdicts with decoration", () => {
    expect(normalizeVerdict("supported")).toBe("supported");
    expect(normalizeVerdict("**Refuted.**")).toBe("refuted");
    expect(normalizeVerdict(" Uncertain ")).toBe("uncertain");
    expect(normalizeVerdict("supported by census data")).toBe("supported");
    expect(normalizeVerdict("unknown")).toBe("uncertain");
  });

  it("accepts Chinese verdicts", () => {
    for (const s of ["支持", "成立", "正确", "支持。"]) expect(normalizeVerdict(s)).toBe("supported");
    for (const s of ["反驳", "不成立", "错误", "不正确"]) expect(normalizeVerdict(s)).toBe("refuted");
    for (const s of ["不确定", "未知"]) expect(normalizeVerdict(s)).toBe("uncertain");
  });

  it("rejects anything else, including negated English", () => {
    for (const s of ["", "maybe", "not supported", "unsupported", "42"]) expect(normalizeVerdict(s)).toBeUndefined();
  });

  it("extracts the verdict from the last ANSWER line without grabbing numbers", () => {
    expect(extractVerdict(`${MARK.method} census data\n${MARK.answer} supported (42% of owners pay)`)).toBe("supported");
    expect(extractVerdict(`${MARK.answer} refuted\n${MARK.answer} 不确定`)).toBe("uncertain");
    expect(extractVerdict(`answer:\n反驳`)).toBe("refuted");
    expect(extractVerdict(`${MARK.answer} partially true`)).toBe("");
    expect(extractVerdict("it costs 300 dollars")).toBe("");
  });

  it("collapses synonyms into one consensus key and leaves other answers comparable", () => {
    expect(normalizeResearchAnswer("支持")).toBe(normalizeResearchAnswer("Supported."));
    expect(normalizeResearchAnswer("42.")).toBe("42");
    expect(RESEARCH_VERDICTS).toEqual(["supported", "refuted", "uncertain"]);
  });
});

describe("research prompts", () => {
  it("round-trips the claim through the prompt, also when batching collapses newlines", () => {
    const prompt = researchPrompt("AI tutors raise test scores");
    expect(prompt).toContain(`${MARK.method} <evidence or reasoning, max 40 words>`);
    expect(prompt).toContain(`${MARK.answer} supported|refuted|uncertain`);
    expect(claimText(prompt)).toBe("AI tutors raise test scores");
    expect(claimText(prompt.replace(/\s+/g, " "))).toBe("AI tutors raise test scores");
    expect(claimText("plain text")).toBe("plain text");
  });

  it("detects the idea's language", () => {
    expect(ideaLanguage("做一个 AI 宠物医生")).toBe("zh");
    expect(ideaLanguage("An AI vet for pets")).toBe("en");
  });
});

describe("pickCanaries", () => {
  it("balances true and false canaries and gives the odd one to a seed-chosen side", () => {
    const four = pickCanaries("idea", 4, 1);
    expect(four.filter((c) => c.truth === "supported")).toHaveLength(2);
    const sides = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((seed) => pickCanaries("idea", 3, seed).filter((c) => c.truth === "supported").length));
    expect([...sides].sort()).toEqual([1, 2]);
    expect(new Set(pickCanaries("idea", MAX_CANARIES, 3).map((c) => c.claim)).size).toBe(MAX_CANARIES);
  });

  it("matches the idea's language", () => {
    expect(pickCanaries("开一家无人咖啡店", 6, 1).every((c) => CJK.test(c.claim))).toBe(true);
    expect(pickCanaries("Open a robot coffee shop", 6, 1).some((c) => CJK.test(c.claim))).toBe(false);
  });
});

describe("ResearchTaskSource", () => {
  it("asks the planner once with the plan purpose and exact settings", async () => {
    const seen: LLMRequest[] = [];
    await new ResearchTaskSource({ llm: plannerLLM(sixClaims, seen), runId: "run-7", idea: "A pet vet app", claims: 6, canaries: 2 }).load(3, 1);
    expect(seen).toHaveLength(1);
    const req = seen[0] as LLMRequest;
    expect(req.meta).toEqual({ runId: "run-7", purpose: "plan" });
    expect(req).toMatchObject({ json: true, temperature: 0, maxTokens: 1200 });
    const user = req.messages.find((m) => m.role === "user")?.content ?? "";
    expect(user).toContain("exactly 6");
    expect(user).toContain("IDEA: A pet vet app");
    expect(user).toContain('{"claims"');
  });

  it("builds claims + canaries, ignoring n, with research ids, prompts and answers", async () => {
    const tasks = await load("A pet vet app", 5);
    expect(tasks.map((t) => t.id)).toEqual(["r01", "r02", "r03", "r04", "r05", "r06", "r07", "r08", "r09", "r10"]);
    expect(tasks.every((t) => t.domain === "research")).toBe(true);
    const ideas = tasks.filter((t) => !isCanaryTask(t));
    const canaries = tasks.filter(isCanaryTask);
    expect(ideas.map((t) => claimText(t.prompt))).toEqual(["c1", "c2", "c3", "c4", "c5", "c6"]);
    expect(ideas.every((t) => t.answer === "")).toBe(true);
    expect(canaries.map((t) => t.answer).sort()).toEqual(["refuted", "refuted", "supported", "supported"]);
    for (const t of tasks) expect(t.prompt).toBe(researchPrompt(claimText(t.prompt)));
  });

  it("interleaves canaries deterministically per seed", async () => {
    const positions = async (seed: number) => (await load("A pet vet app", seed)).flatMap((t, i) => (isCanaryTask(t) ? [i] : []));
    expect(await positions(3)).toEqual(await positions(3));
    expect(await load("A pet vet app", 3)).toEqual(await load("A pet vet app", 3));
    const layouts = new Set(await Promise.all([1, 2, 3, 4, 5].map(async (s) => (await positions(s)).join(","))));
    expect(layouts.size).toBeGreaterThan(1);
  });

  it("uses canaries in the idea's language", async () => {
    const zh = (await load("做一个宠物医生 App", 1)).filter(isCanaryTask);
    expect(zh.every((t) => CJK.test(claimText(t.prompt)))).toBe(true);
    const en = (await load("A pet vet app", 1)).filter(isCanaryTask);
    expect(en.some((t) => CJK.test(claimText(t.prompt)))).toBe(false);
  });

  it("keeps at most the requested claims and pads ids for large sets", async () => {
    const reply = JSON.stringify({ claims: Array.from({ length: 120 }, (_, i) => `claim ${i}`) });
    const tasks = await load("idea", 1, { claims: 100, canaries: 0, reply });
    expect(tasks).toHaveLength(100);
    expect(tasks[0]?.id).toBe("r001");
    expect(tasks.at(-1)?.id).toBe("r100");
  });

  it("fails loudly on an unparseable plan and validates its options", async () => {
    await expect(load("idea", 1, { reply: "no json here" })).rejects.toThrow(/research planner/);
    const llm = plannerLLM(sixClaims);
    expect(() => new ResearchTaskSource({ llm, runId: "r", idea: "  ", claims: 3, canaries: 1 })).toThrow(/empty/);
    expect(() => new ResearchTaskSource({ llm, runId: "r", idea: "x", claims: 0, canaries: 1 })).toThrow(RangeError);
    expect(() => new ResearchTaskSource({ llm, runId: "r", idea: "x", claims: 3, canaries: MAX_CANARIES + 1 })).toThrow(RangeError);
  });

  it("marks canaries by their known answer", () => {
    const t = (answer: string): Task => ({ id: "r01", domain: "research", prompt: researchPrompt("x"), answer });
    expect(isCanaryTask(t("supported"))).toBe(true);
    expect(isCanaryTask(t(""))).toBe(false);
  });
});
