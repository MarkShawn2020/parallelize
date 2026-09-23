import { sleep, unit } from "../core/rng";
import type {
  Answer,
  Domain,
  Judge,
  JudgeRequest,
  JudgeResult,
  LLM,
  LLMRequest,
  LLMResult,
  Question,
  Task,
  Tier,
  Usage,
} from "../core/types";
import { MARK, NONE_CHOICE, QK, UNCLEAR_CHOICE } from "../core/types";
import { RESEARCH_VERDICTS, claimText, ideaLanguage } from "../tasks/research";

const DOMAINS: readonly Domain[] = ["arithmetic", "rates", "logic", "gsm8k", "research"];

type Draw = (...salt: Array<string | number>) => number;

export class MockOracle {
  readonly #tasks = new Map<string, Task>();

  constructor(tasks: Task[]) {
    for (const t of tasks) this.#tasks.set(t.id, t);
  }

  answer(taskId: string): string | undefined {
    return this.#tasks.get(taskId)?.answer;
  }

  domain(taskId: string): Domain | undefined {
    return this.#tasks.get(taskId)?.domain;
  }

  /** What the simulated world treats as correct: the answer, or a fixed latent verdict for idea claims (no ground truth). */
  truth(taskId: string): string | undefined {
    const t = this.#tasks.get(taskId);
    if (t === undefined) return undefined;
    return t.domain === "research" && t.answer === "" ? latentVerdict(claimText(t.prompt)) : t.answer;
  }
}

/** Deterministic per claim: about 60% supported, 25% refuted, 15% uncertain. */
export function latentVerdict(claim: string): string {
  const u = unit("research-truth", claim);
  return u < 0.6 ? "supported" : u < 0.85 ? "refuted" : "uncertain";
}

/**
 * Counts calls per (purpose, task or cell) rather than globally, so the k-th solve of a task draws
 * the same numbers however concurrent cells interleave: runs stay reproducible, retries still differ.
 */
class CallCounter {
  readonly #counts = new Map<string, number>();

  next(scope: string): number {
    const n = this.#counts.get(scope) ?? 0;
    this.#counts.set(scope, n + 1);
    return n;
  }
}

// ---------------------------------------------------------------- MockLLM

export interface MockLLMOptions {
  oracle: MockOracle;
  seed: number;
  /** Inclusive range; [0, 0] disables sleeping. */
  latencyMs?: [number, number];
  accuracy?: Partial<Record<Domain, number>>;
}

/** Default MockLLM latency range; the provider stack stretches it by RunConfig.simPace. */
export const MOCK_LLM_LATENCY_MS: readonly [number, number] = [60, 180];

const DEFAULT_ACCURACY: Record<Domain, number> = { arithmetic: 0.93, rates: 0.85, logic: 0.8, gsm8k: 0.85, research: 0.9 };
const STRATEGY_BONUS = 0.05;
const TEAMMATE_COPY = 0.8;
// EvoMap measured 55.5% of answers surviving a coordinator's summary merge.
const MERGE_RETENTION = 0.555;

const METHODS: Record<Domain, string> = {
  arithmetic: "evaluated the expression with operator precedence, then rechecked the last step",
  rates: "set up rate x time = amount and solved for the unknown",
  logic: "enumerated the cases and eliminated the contradictory ones",
  gsm8k: "tracked each quantity step by step and summed the result",
  research: "weighed the claim against well-known facts and prior evidence",
};

const PLAN_CLAIMS: Record<"zh" | "en", readonly string[]> = {
  en: [
    "Target users will pay for a solution to this problem.",
    "The core technology this idea needs is available today.",
    "No existing product already solves this problem well.",
    "A usable MVP can be built within three months.",
    "Running cost per user stays below expected revenue per user.",
    "Regulation does not block this idea in its main market.",
    "Target users can be reached through existing channels at low cost.",
    "The idea keeps a defensible advantage over likely competitors.",
  ],
  zh: [
    "目标用户愿意为解决这个问题付费",
    "实现该想法所需的核心技术目前已经成熟",
    "市面上还没有产品很好地解决这个问题",
    "三个月内可以做出可用的 MVP",
    "每位用户的运行成本低于预期收入",
    "主要市场的监管不会阻止该想法落地",
    "可以通过现有渠道低成本触达目标用户",
    "相对潜在竞争者，该想法具备可防守的优势",
  ],
};

const STRATEGIES = [
  "restate the question as one equation before computing, then substitute the result back to check it.",
  "work in small steps, write down every intermediate value, and recompute the final step.",
  "estimate the magnitude first and reject any answer far from the estimate.",
  "list the given quantities with units and make sure the result has the units the question asks for.",
] as const;

/** Single-context accuracy as a function of batch size (EvoMap: ~0.45 at n=128, ~0.21 at n=160). */
export function singleContextAccuracy(n: number): number {
  return n <= 64 ? 0.93 : Math.max(0.15, 0.93 - 0.0075 * (n - 64));
}

export class MockLLM implements LLM {
  readonly id = "mock-llm";
  readonly simulated = true;
  readonly #oracle: MockOracle;
  readonly #seed: number;
  readonly #latency: [number, number];
  readonly #accuracy: Record<Domain, number>;
  readonly #calls = new CallCounter();

  constructor(opts: MockLLMOptions) {
    this.#oracle = opts.oracle;
    this.#seed = opts.seed;
    this.#latency = opts.latencyMs ?? [...MOCK_LLM_LATENCY_MS];
    this.#accuracy = { ...DEFAULT_ACCURACY, ...opts.accuracy };
  }

  async complete(req: LLMRequest): Promise<LLMResult> {
    const { purpose, taskId, cellId } = req.meta;
    const scope = taskId ?? cellId ?? "";
    const call = this.#calls.next(`${purpose}|${scope}`);
    const draw: Draw = (...salt) => unit(this.#seed, "llm", purpose, scope, call, ...salt);

    const text = this.#respond(req, draw);
    const latencyMs = pickLatency(this.#latency, draw("latency"));
    await sleep(latencyMs);

    const promptChars = req.messages.reduce((sum, m) => sum + m.content.length, 0);
    const inputTokens = Math.ceil(promptChars / 4);
    const outputTokens = Math.ceil(text.length / 4);
    const usage: Usage = { inputTokens, outputTokens, costUsd: inputTokens * 1e-6 + outputTokens * 5e-6 };
    return { text, usage, latencyMs, model: this.id };
  }

  #respond(req: LLMRequest, draw: Draw): string {
    const prompt = req.messages.map((m) => m.content).join("\n");
    // Batched prompts may carry format examples in the system message; only user lines are tasks.
    const userPrompt = req.messages
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join("\n");
    const { taskId } = req.meta;

    switch (req.meta.purpose) {
      case "solve": {
        const s = this.#solve(taskId, prompt, draw);
        return `${MARK.method} ${s.method}\n${MARK.answer} ${s.answer}`;
      }
      case "report": {
        const s = this.#solve(taskId, prompt, draw);
        return `${MARK.taskId} ${taskId ?? "unknown"} report: ${s.method} ${MARK.answer} ${s.answer}`;
      }
      case "single":
        return this.#single(userPrompt, draw);
      case "plan":
        return planResponse(prompt);
      case "merge":
        return this.#merge(userPrompt, draw);
      case "gene": {
        const domain = tokenAfter(prompt, MARK.domain) ?? "arithmetic";
        const strategy = STRATEGIES[Math.floor(draw("gene") * STRATEGIES.length)] ?? STRATEGIES[0];
        return `Strategy for ${domain}: ${strategy}`;
      }
      default:
        if (req.json) return "{}";
        return `${MARK.answer} ${tokenAfter(prompt, MARK.answer) ?? "unknown"}`;
    }
  }

  #solve(taskId: string | undefined, prompt: string, draw: Draw): { method: string; answer: string } {
    const teammate = teammateAnswer(prompt);
    if (teammate !== undefined && draw("copy") < TEAMMATE_COPY) {
      return { method: "checked the teammate's result and agreed with it", answer: teammate };
    }
    const correct = taskId === undefined ? undefined : this.#oracle.answer(taskId);
    const domain = (taskId === undefined ? undefined : this.#oracle.domain(taskId)) ?? promptDomain(prompt) ?? "arithmetic";
    const p = this.#accuracy[domain] + (prompt.includes(MARK.strategy) ? STRATEGY_BONUS : 0);
    if (domain === "research") {
      const truth = (taskId === undefined ? undefined : this.#oracle.truth(taskId)) ?? latentVerdict(claimText(prompt));
      return { method: METHODS.research, answer: verdictAttempt(truth, p, draw) };
    }
    return { method: METHODS[domain], answer: attempt(correct, p, draw) };
  }

  #single(userPrompt: string, draw: Draw): string {
    const ids = batchedTaskIds(userPrompt);
    const p = singleContextAccuracy(ids.length);
    return ids
      .map((id) => {
        const answer =
          this.#oracle.domain(id) === "research"
            ? verdictAttempt(this.#oracle.truth(id) ?? "uncertain", p, draw, id)
            : attempt(this.#oracle.answer(id), p, draw, id);
        return `${MARK.taskId} ${id}: ${MARK.answer} ${answer}`;
      })
      .join("\n");
  }

  #merge(userPrompt: string, draw: Draw): string {
    return [...reportedAnswers(userPrompt)]
      .map(([id, value]) => {
        const kept = draw("keep", id) < MERGE_RETENTION ? value : wrongAnswer(value, draw, id);
        return `${MARK.taskId} ${id}: ${MARK.answer} ${kept}`;
      })
      .join("\n");
  }
}

/** Planner reply with the "exactly N" claims the prompt asks for, in the idea's language. */
function planResponse(prompt: string): string {
  const n = Math.min(50, Math.max(1, Number(/exactly\s+(\d+)/i.exec(prompt)?.[1] ?? 5)));
  const lang = ideaLanguage(prompt);
  const claims = Array.from(
    { length: n },
    (_, i) => PLAN_CLAIMS[lang][i] ?? (lang === "zh" ? `关于该想法的第 ${i + 1} 条论断成立` : `Claim ${i + 1} about the idea holds.`),
  );
  return JSON.stringify({ claims });
}

function verdictAttempt(truth: string, p: number, draw: Draw, salt: string | number = ""): string {
  if (draw("correct", salt) < p) return truth;
  const others = RESEARCH_VERDICTS.filter((v) => v !== truth);
  return others[Math.floor(draw("wrong", salt) * others.length)] ?? "uncertain";
}

function attempt(correct: string | undefined, p: number, draw: Draw, salt: string | number = ""): string {
  if (correct === undefined) return "unknown";
  return draw("correct", salt) < p ? correct : wrongAnswer(correct, draw, salt);
}

/** A nonzero offset in [-9, 9] for numeric answers; non-numeric answers degrade to "unknown". */
function wrongAnswer(correct: string, draw: Draw, salt: string | number): string {
  if (!/^-?\d+(\.\d+)?$/.test(correct)) return "unknown";
  const offset = (1 + Math.floor(draw("offset", salt) * 9)) * (draw("sign", salt) < 0.5 ? -1 : 1);
  const decimals = correct.split(".")[1]?.length ?? 0;
  const value = Number(correct) + offset;
  return decimals > 0 ? value.toFixed(decimals) : String(value);
}

function batchedTaskIds(text: string): string[] {
  const ids: string[] = [];
  const re = new RegExp(`^\\s*${escapeRe(MARK.taskId)}\\s+([^\\s:]+):[ \\t]*(.*)$`, "gm");
  for (const m of text.matchAll(re)) {
    const id = m[1];
    // Lines already carrying an answer are format examples, not problems.
    if (id === undefined || (m[2] ?? "").startsWith(MARK.answer) || ids.includes(id)) continue;
    ids.push(id);
  }
  return ids;
}

function reportedAnswers(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = new RegExp(`^\\s*${escapeRe(MARK.taskId)}\\s+(\\S+)\\s+report:(.*)$`, "gm");
  for (const m of text.matchAll(re)) {
    const id = m[1];
    if (id === undefined || out.has(id)) continue;
    const body = m[2] ?? "";
    const at = body.lastIndexOf(MARK.answer);
    out.set(id, (at >= 0 ? firstToken(body.slice(at + MARK.answer.length)) : undefined) ?? "unknown");
  }
  return out;
}

function teammateAnswer(prompt: string): string | undefined {
  const line = prompt.split("\n").find((l) => l.trimStart().startsWith(MARK.teammate));
  if (line === undefined) return undefined;
  let rest = line.trimStart().slice(MARK.teammate.length).trim();
  if (rest.startsWith(MARK.answer)) rest = rest.slice(MARK.answer.length);
  return firstToken(rest);
}

function promptDomain(prompt: string): Domain | undefined {
  const d = tokenAfter(prompt, MARK.domain);
  return DOMAINS.find((x) => x === d);
}

// ---------------------------------------------------------------- MockJudge

export interface MockJudgeOptions {
  tier: Tier;
  seed: number;
  oracle?: MockOracle;
  /** Inclusive range; [0, 0] disables sleeping. */
  latencyMs?: [number, number];
}

const TIER_PROFILE: Record<
  Tier,
  { latency: [number, number]; inPerQuestion: number; outPerQuestion: number; cost: (inp: number, out: number) => number }
> = {
  // Jev pricing: input tokens only.
  system1: { latency: [70, 300], inPerQuestion: 40, outPerQuestion: 0, cost: (inp) => inp * 0.042e-6 },
  system2: { latency: [600, 1500], inPerQuestion: 150, outPerQuestion: 60, cost: (inp, out) => inp * 1e-6 + out * 5e-6 },
};

/** Default MockJudge latency range for a tier; the provider stack stretches it by RunConfig.simPace. */
export const mockJudgeLatencyMs = (tier: Tier): readonly [number, number] => TIER_PROFILE[tier].latency;

export class MockJudge implements Judge {
  readonly id: string;
  readonly tier: Tier;
  readonly simulated = true;
  readonly #seed: number;
  readonly #oracle: MockOracle | undefined;
  readonly #latency: [number, number];
  readonly #calls = new CallCounter();

  constructor(opts: MockJudgeOptions) {
    this.tier = opts.tier;
    this.id = `mock-judge:${opts.tier}`;
    this.#seed = opts.seed;
    this.#oracle = opts.oracle;
    this.#latency = opts.latencyMs ?? TIER_PROFILE[opts.tier].latency;
  }

  async ask(req: JudgeRequest): Promise<JudgeResult> {
    const { purpose, taskId, cellId } = req.meta;
    const scope = taskId ?? cellId ?? "";
    const call = this.#calls.next(`${purpose}|${scope}`);
    const draw: Draw = (...salt) => unit(this.#seed, "judge", this.tier, purpose, scope, call, ...salt);
    const { head, precedents } = splitPrecedents(req.state);

    const answers: Record<string, Answer> = {};
    for (const [key, q] of Object.entries(req.questions)) {
      answers[key] = this.#answer(key, q, head, precedents, taskId, (...salt) => draw(key, ...salt));
    }

    const latencyMs = pickLatency(this.#latency, draw("latency"));
    await sleep(latencyMs);

    const profile = TIER_PROFILE[this.tier];
    const n = Object.keys(req.questions).length;
    const inputTokens = Math.ceil(req.state.length / 4) + profile.inPerQuestion * n;
    const outputTokens = profile.outPerQuestion * n;
    const usage: Usage = { inputTokens, outputTokens, costUsd: profile.cost(inputTokens, outputTokens) };
    return { answers, usage, latencyMs, model: this.id };
  }

  #answer(key: string, q: Question, head: string, precedents: number, taskId: string | undefined, draw: Draw): Answer {
    if (key === QK.claim && q.type === "choice") return this.#claim(q.criteria, head, precedents, draw);
    if (key === QK.verify && q.type === "noul") return { type: "noul", noul: this.#verify(head, precedents, taskId, draw) };
    if (key === QK.adopt && q.type === "noul") return { type: "noul", noul: this.#adopt(precedents, draw) };
    if (key === QK.dispute && q.type === "choice") return this.#dispute(q.criteria, precedents, taskId, draw);
    return uninformed(q);
  }

  /** Criteria keys are distinct candidate answers ("answer <value>: <summary>") plus UNCLEAR_CHOICE. */
  #dispute(criteria: Record<string, string>, precedents: number, taskId: string | undefined, draw: Draw): Answer {
    const keys = Object.keys(criteria);
    const fallback = keys.includes(UNCLEAR_CHOICE) ? UNCLEAR_CHOICE : (keys[0] ?? UNCLEAR_CHOICE);
    const correct = taskId === undefined ? undefined : this.#oracle?.truth(taskId);
    if (correct === undefined || correct === "") return choiceAnswer(keys, fallback, keys.length > 0 ? 1 / keys.length : 0);
    const match = keys.find((k) => k !== UNCLEAR_CHOICE && sameAnswer(disputedValue(criteria[k] ?? "") ?? "", correct));
    const chosen = match ?? UNCLEAR_CHOICE;
    if (!keys.includes(chosen)) return choiceAnswer(keys, fallback, 1 / keys.length);
    const raw =
      this.tier === "system1" ? Math.min(0.95, 0.6 + 0.08 * precedents + noise(draw, 0.1 * 0.85 ** precedents)) : 0.9;
    return choiceAnswer(keys, chosen, keys.length <= 1 ? 1 : Math.max(1 / keys.length, raw));
  }

  #adopt(precedents: number, draw: Draw): number {
    if (this.tier === "system2") return clamp01(0.65 + noise(draw, 0.05));
    // Like claim and verify, System 1 grows surer as consistent System-2 precedents accumulate.
    const p = Math.min(precedents, 4);
    return clamp01(0.65 + 0.07 * p + noise(draw, 0.15 * 0.85 ** p));
  }

  #claim(criteria: Record<string, string>, head: string, precedents: number, draw: Draw): Answer {
    const keys = Object.keys(criteria);
    const candidates = keys.filter((k) => k !== NONE_CHOICE);
    const profile = parseProfile(head);
    let best = candidates[0] ?? keys[0] ?? NONE_CHOICE;
    let bestRate = -1;
    for (const k of candidates) {
      const rate = smoothedRate(criteria[k] ?? "", profile);
      if (rate > bestRate) {
        best = k;
        bestRate = rate;
      }
    }
    const raw =
      this.tier === "system1"
        ? Math.min(0.95, 0.55 + 0.1 * Math.min(precedents, 4) + noise(draw, 0.1))
        : 0.85 + noise(draw, 0.03);
    // The chosen key must remain the argmax of the distribution.
    const confidence = keys.length <= 1 ? 1 : Math.max(1 / keys.length, raw);
    return choiceAnswer(keys, best, confidence);
  }

  #verify(head: string, precedents: number, taskId: string | undefined, draw: Draw): number {
    const proposed = tokenAfter(head, MARK.answer);
    const correct = taskId === undefined ? undefined : this.#oracle?.truth(taskId);
    if (proposed === undefined || correct === undefined) return 0.35;
    const wrong = !sameAnswer(proposed, correct);
    const base = wrong ? Math.min(0.92, 0.72 + 0.05 * precedents) : Math.max(0.06, 0.22 - 0.03 * precedents);
    const amplitude = this.tier === "system1" ? Math.max(0.05, 0.2 * 0.85 ** precedents) : 0.08;
    return clamp01(base + noise(draw, amplitude));
  }
}

/** Splits judge state at the precedents header and counts the "- " lines after it. */
function splitPrecedents(state: string): { head: string; precedents: number } {
  const lines = state.split("\n");
  const at = lines.findIndex((l) => l.trimStart().startsWith(MARK.precedents));
  if (at < 0) return { head: state, precedents: 0 };
  const precedents = lines.slice(at + 1).filter((l) => l.trimStart().startsWith("- ")).length;
  return { head: lines.slice(0, at).join("\n"), precedents };
}

function parseProfile(head: string): Map<string, { wins: number; trials: number }> {
  const out = new Map<string, { wins: number; trials: number }>();
  const line = head.split("\n").find((l) => l.trimStart().startsWith(MARK.profile));
  if (line === undefined) return out;
  for (const m of line.matchAll(/([\w-]+)\s+(\d+)\s*\/\s*(\d+)/g)) {
    if (m[1] !== undefined) out.set(m[1].toLowerCase(), { wins: Number(m[2]), trials: Number(m[3]) });
  }
  return out;
}

function smoothedRate(description: string, profile: Map<string, { wins: number; trials: number }>): number {
  const domain = mentionedDomain(description, [...new Set([...DOMAINS, ...profile.keys()])]);
  const stats = (domain === undefined ? undefined : profile.get(domain)) ?? { wins: 0, trials: 0 };
  return (stats.wins + 1) / (stats.trials + 2);
}

function mentionedDomain(description: string, names: string[]): string | undefined {
  const tagged = tokenAfter(description, MARK.domain)?.toLowerCase();
  if (tagged !== undefined && names.includes(tagged)) return tagged;
  let found: string | undefined;
  let foundAt = Infinity;
  for (const name of names) {
    const at = description.search(new RegExp(`\\b${escapeRe(name)}\\b`, "i"));
    if (at >= 0 && at < foundAt) {
      found = name;
      foundAt = at;
    }
  }
  return found;
}

function disputedValue(description: string): string | undefined {
  return /\banswer\s+(.+?):(?=\s|$)/i.exec(description)?.[1]?.trim();
}

function choiceAnswer(keys: string[], chosen: string, confidence: number): Answer {
  const rest = keys.length > 1 ? (1 - confidence) / (keys.length - 1) : 0;
  const probabilities = Object.fromEntries(keys.map((k) => [k, k === chosen ? confidence : rest]));
  return { type: "choice", choice: chosen, probabilities, confidence };
}

function uninformed(q: Question): Answer {
  switch (q.type) {
    case "noul":
      return { type: "noul", noul: 0.5 };
    case "choice": {
      const keys = Object.keys(q.criteria);
      return choiceAnswer(keys, keys[0] ?? NONE_CHOICE, keys.length > 0 ? 1 / keys.length : 0);
    }
    case "score":
      return { type: "score", score: Math.floor(Math.max(0, q.criteria.length - 1) / 2), confidence: 0.5 };
  }
}

function sameAnswer(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().toLowerCase().replace(/[.,;]+$/, "").replace(/^\$/, "").replaceAll(",", "");
  const x = norm(a);
  const y = norm(b);
  const nx = Number(x);
  const ny = Number(y);
  if (x !== "" && y !== "" && Number.isFinite(nx) && Number.isFinite(ny)) return Math.abs(nx - ny) < 1e-9;
  return x === y;
}

// ---------------------------------------------------------------- shared helpers

function tokenAfter(text: string, marker: string): string | undefined {
  const at = text.indexOf(marker);
  if (at < 0) return undefined;
  const rest = text.slice(at + marker.length);
  return firstToken(rest.split("\n")[0] ?? "");
}

function firstToken(text: string): string | undefined {
  const token = text.trim().split(/\s+/)[0];
  return token === undefined || token === "" ? undefined : token;
}

function pickLatency([lo, hi]: [number, number], u: number): number {
  return Math.round(lo + (hi - lo) * u);
}

function noise(draw: Draw, amplitude: number): number {
  return (draw("noise") * 2 - 1) * amplitude;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
