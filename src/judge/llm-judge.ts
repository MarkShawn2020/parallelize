import type { Answer, Judge, JudgeRequest, JudgeResult, LLM, Question, Tier } from "../core/types";
import { clamp01 } from "./confidence";

export const JUDGE_SYSTEM_PROMPT = "You are a decision function. Reply with ONLY a JSON object, no prose.";

const OUTPUT_SCHEMA =
  '{"<name>": {"type":"noul","noul":<probability 0..1 that the statement holds>}' +
  ' | {"type":"choice","choice":"<one criteria key>","probabilities":{"<key>":p,...},"confidence":<0..1>}' +
  ' | {"type":"score","score":<level index 0..n-1>,"confidence":<0..1>}}';

export interface LLMJudgeOptions {
  llm: LLM;
  maxTokens?: number;
}

/** System 2: a chat LLM answering in Jev's wire format. */
export class LLMJudge implements Judge {
  readonly id: string;
  readonly tier: Tier = "system2";
  readonly simulated: boolean;
  private readonly llm: LLM;
  private readonly maxTokens: number | undefined;

  constructor(opts: LLMJudgeOptions) {
    this.llm = opts.llm;
    this.maxTokens = opts.maxTokens;
    this.id = `llm-judge:${opts.llm.id}`;
    this.simulated = opts.llm.simulated;
  }

  async ask(req: JudgeRequest): Promise<JudgeResult> {
    const n = Object.keys(req.questions).length;
    const r = await this.llm.complete({
      messages: [
        { role: "system", content: JUDGE_SYSTEM_PROMPT },
        { role: "user", content: buildJudgePrompt(req) },
      ],
      json: true,
      temperature: 0,
      maxTokens: this.maxTokens ?? 120 * n + 200,
      meta: req.meta,
    });
    return {
      answers: parseJudgeAnswers(r.text, req.questions),
      usage: r.usage,
      latencyMs: r.latencyMs,
      model: r.model,
    };
  }
}

export function buildJudgePrompt(req: JudgeRequest): string {
  const names = Object.keys(req.questions);
  const questions = Object.entries(req.questions).map(([name, q]) => describeQuestion(name, q));
  return [
    req.state,
    "",
    "QUESTIONS",
    ...questions,
    "",
    "OUTPUT SCHEMA",
    OUTPUT_SCHEMA,
    `Required keys: ${names.map((n) => JSON.stringify(n)).join(", ")}`,
  ].join("\n");
}

function describeQuestion(name: string, q: Question): string {
  const head = `${JSON.stringify(name)} (${q.type}): ${q.instructions}`;
  switch (q.type) {
    case "noul":
      return head;
    case "choice":
      return [head, "  criteria:", ...Object.entries(q.criteria).map(([k, v]) => `    ${k}: ${v}`)].join("\n");
    case "score":
      return [head, "  levels:", ...q.criteria.map((c, i) => `    ${i}: ${c}`)].join("\n");
  }
}

/** Never throws: a key that cannot be read becomes a neutral answer. */
export function parseJudgeAnswers(text: string, questions: Record<string, Question>): Record<string, Answer> {
  const obj = firstJsonObject(text) ?? {};
  return Object.fromEntries(
    Object.entries(questions).map(([k, q]) => [k, parseAnswer(obj[k], q) ?? neutralAnswer(q)]),
  );
}

/** First balanced {...} that parses as a JSON object; tolerates code fences and prose. */
export function firstJsonObject(text: string): Record<string, unknown> | undefined {
  let start = text.indexOf("{");
  while (start !== -1) {
    const end = balancedEnd(text, start);
    let next = start + 1;
    if (end !== -1) {
      try {
        const v: unknown = JSON.parse(text.slice(start, end + 1));
        if (isRecord(v)) return v;
      } catch {
        // Skip the whole span: its inner objects are fragments, not the answer.
      }
      next = end + 1;
    }
    start = text.indexOf("{", next);
  }
  return undefined;
}

function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

function parseAnswer(raw: unknown, q: Question): Answer | undefined {
  const rec = isRecord(raw) ? raw : undefined;
  switch (q.type) {
    case "noul": {
      const p = num(raw) ?? num(rec?.noul);
      return p === undefined ? undefined : { type: "noul", noul: clamp01(p) };
    }
    case "score": {
      const s = num(raw) ?? num(rec?.score);
      if (s === undefined) return undefined;
      const confidence = num(rec?.confidence);
      return {
        type: "score",
        score: Math.min(Math.max(s, 0), Math.max(0, q.criteria.length - 1)),
        confidence: confidence === undefined ? 0.5 : clamp01(confidence),
      };
    }
    case "choice":
      return parseChoice(raw, rec, Object.keys(q.criteria));
  }
}

function parseChoice(
  raw: unknown,
  rec: Record<string, unknown> | undefined,
  keys: string[],
): Answer | undefined {
  const given = typeof raw === "string" ? raw : typeof rec?.choice === "string" ? rec.choice : undefined;
  const rawProbs = isRecord(rec?.probabilities) ? rec.probabilities : {};
  const provided = keys.map((k) => Math.max(0, num(rawProbs[k]) ?? 0));
  const valid = given !== undefined && keys.includes(given);
  if (!valid && !provided.some((p) => p > 0)) return undefined;

  const probabilities = normalize(keys, provided);
  const choice = valid ? given : argmax(keys, probabilities);
  const stated = num(rec?.confidence);
  const confidence = valid && stated !== undefined ? clamp01(stated) : (probabilities[choice] ?? 0);
  return { type: "choice", choice, probabilities, confidence };
}

function neutralAnswer(q: Question): Answer {
  switch (q.type) {
    case "noul":
      return { type: "noul", noul: 0.5 };
    case "choice": {
      const keys = Object.keys(q.criteria);
      return { type: "choice", choice: keys[0] ?? "", probabilities: normalize(keys, []), confidence: 0 };
    }
    case "score":
      return { type: "score", score: Math.max(0, Math.floor((q.criteria.length - 1) / 2)), confidence: 0 };
  }
}

/** Uniform when nothing positive was provided. */
function normalize(keys: string[], values: number[]): Record<string, number> {
  const sum = values.reduce((a, b) => a + b, 0);
  return Object.fromEntries(keys.map((k, i) => [k, sum > 0 ? (values[i] ?? 0) / sum : 1 / keys.length]));
}

function argmax(keys: string[], probabilities: Record<string, number>): string {
  let best = keys[0] ?? "";
  for (const k of keys) if ((probabilities[k] ?? 0) > (probabilities[best] ?? 0)) best = k;
  return best;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
