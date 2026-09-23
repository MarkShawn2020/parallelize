import type { Answer, Judge, JudgeRequest, JudgeResult, Question, Usage } from "../core/types";
import { ProviderError, isNum, isObject, postJson, snippet } from "./http";
import type { Semaphore } from "./limiter";

export interface JevJudgeOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  retries?: number;
  limiter?: Semaphore;
}

const MAX_CHOICE_CRITERIA = 255;
// Jev's context is 32k tokens and quality decays well before that, so long states keep head and tail.
const MAX_STATE_CHARS = 90_000;
const KEEP_HEAD_CHARS = 60_000;
const KEEP_TAIL_CHARS = 29_000;
const INPUT_USD_PER_TOKEN = 0.042e-6;

export class JevJudge implements Judge {
  readonly id: string;
  readonly tier = "system1" as const;
  readonly simulated = false;
  readonly #opts: JevJudgeOptions;

  constructor(opts: JevJudgeOptions) {
    this.#opts = opts;
    this.id = `jev:${opts.model}`;
  }

  async ask(req: JudgeRequest): Promise<JudgeResult> {
    for (const [key, q] of Object.entries(req.questions)) {
      if (q.type === "choice") {
        const k = Object.keys(q.criteria).length;
        if (k < 1 || k > MAX_CHOICE_CRITERIA) {
          throw new ProviderError(`Jev choice question "${key}" needs 1..${MAX_CHOICE_CRITERIA} criteria, got ${k}`);
        }
      }
    }
    const body = { model: this.#opts.model, state: fitState(req.state), questions: req.questions };
    const call = async () => {
      const started = performance.now();
      const raw = await postJson(`${this.#opts.baseUrl.replace(/\/+$/, "")}/systemone`, body, {
        headers: {
          Authorization: `Bearer ${this.#opts.apiKey}`,
          "Content-Type": "application/json",
          "X-Title": "parallelize",
        },
        timeoutMs: this.#opts.timeoutMs ?? 30_000,
        retries: this.#opts.retries ?? 2,
      });
      return { raw, latencyMs: performance.now() - started };
    };
    const { raw, latencyMs } = this.#opts.limiter ? await this.#opts.limiter.run(call) : await call();
    return { ...parseJevResponse(raw, req.questions, this.#opts.model), latencyMs };
  }
}

export function fitState(state: string): string {
  if (state.length <= MAX_STATE_CHARS) return state;
  return `${state.slice(0, KEEP_HEAD_CHARS)}\n…\n${state.slice(-KEEP_TAIL_CHARS)}`;
}

export function parseJevResponse(
  raw: unknown,
  questions: Record<string, Question>,
  fallbackModel: string,
): Omit<JudgeResult, "latencyMs"> {
  if (!isObject(raw) || !isObject(raw.answers)) throw unusable(raw, "response has no answers object");
  const got = raw.answers;
  const answers: Record<string, Answer> = {};
  for (const [key, q] of Object.entries(questions)) {
    const a = got[key];
    if (!isObject(a) || a.type !== q.type) throw unusable(raw, `answer "${key}" is missing or not of type ${q.type}`);
    answers[key] = parseAnswer(raw, key, q, a);
  }
  return {
    answers,
    usage: parseUsage(raw.usage),
    model: typeof raw.model === "string" && raw.model !== "" ? raw.model : fallbackModel,
  };
}

function parseAnswer(raw: unknown, key: string, q: Question, a: Record<string, unknown>): Answer {
  switch (q.type) {
    case "noul": {
      if (!isNum(a.noul)) throw unusable(raw, `answer "${key}" has no numeric noul`);
      return { type: "noul", noul: clamp01(a.noul) };
    }
    case "choice": {
      const keys = Object.keys(q.criteria);
      const probs = readProbabilities(a.probabilities, keys);
      const choice =
        typeof a.choice === "string" && keys.includes(a.choice) ? a.choice : probs ? argmax(probs, keys) : undefined;
      if (choice === undefined) throw unusable(raw, `answer "${key}" chose outside the criteria and has no probabilities`);
      const confidence = isNum(a.confidence) ? clamp01(a.confidence) : probs ? Math.max(...Object.values(probs)) : undefined;
      if (confidence === undefined) throw unusable(raw, `answer "${key}" has neither confidence nor probabilities`);
      const probabilities = probs ?? Object.fromEntries(keys.map((k) => [k, k === choice ? confidence : 0]));
      return { type: "choice", choice, probabilities, confidence };
    }
    case "score": {
      if (!isNum(a.score)) throw unusable(raw, `answer "${key}" has no numeric score`);
      const probs = readProbabilities(a.probabilities);
      const confidence = isNum(a.confidence) ? clamp01(a.confidence) : probs ? Math.max(...Object.values(probs)) : undefined;
      if (confidence === undefined) throw unusable(raw, `answer "${key}" has neither confidence nor probabilities`);
      return probs ? { type: "score", score: a.score, confidence, probabilities: probs } : { type: "score", score: a.score, confidence };
    }
  }
}

function parseUsage(u: unknown): Usage {
  const usage = isObject(u) ? u : {};
  const inputTokens = isNum(usage.input_tokens) ? usage.input_tokens : 0;
  const outputTokens = isNum(usage.output_tokens) ? usage.output_tokens : 0;
  // Jev bills input tokens only.
  const costUsd = isNum(usage.cost) ? usage.cost : inputTokens * INPUT_USD_PER_TOKEN;
  return { inputTokens, outputTokens, costUsd };
}

/** Probabilities restricted to `keys` (all reported keys when omitted); undefined when none are usable. */
function readProbabilities(p: unknown, keys?: string[]): Record<string, number> | undefined {
  if (!isObject(p)) return undefined;
  const out: Record<string, number> = {};
  let usable = false;
  for (const k of keys ?? Object.keys(p)) {
    const v = p[k];
    if (isNum(v)) {
      out[k] = clamp01(v);
      usable = true;
    } else if (keys) {
      out[k] = 0;
    }
  }
  return usable ? out : undefined;
}

function argmax(probs: Record<string, number>, keys: string[]): string | undefined {
  let best: string | undefined;
  for (const k of keys) if (best === undefined || (probs[k] ?? 0) > (probs[best] ?? 0)) best = k;
  return best;
}

function unusable(raw: unknown, why: string): ProviderError {
  return new ProviderError(`Jev response unusable: ${why}`, { bodySnippet: snippet(raw) });
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}
