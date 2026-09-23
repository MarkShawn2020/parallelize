import { hashString, seededShuffle } from "../core/rng";
import { MARK } from "../core/types";
import type { LLM, ResearchVerdict, Task, TaskSource } from "../core/types";
import { normalizeAnswer } from "./check";

export const RESEARCH_VERDICTS = ["supported", "refuted", "uncertain"] as const;

const CLAIM_MAX_CHARS = 160;
const CLAIM_MARK = "CLAIM:";
const REPLY_LEAD = "Reply with one line";

interface Canary {
  zh: string;
  en: string;
  truth: "supported" | "refuted";
}

const CANARIES: readonly Canary[] = [
  { truth: "supported", zh: "水在标准大气压下100摄氏度沸腾", en: "Water boils at 100 degrees Celsius at standard atmospheric pressure." },
  { truth: "supported", zh: "地球绕太阳公转一周大约需要365天", en: "The Earth takes about 365 days to orbit the Sun once." },
  { truth: "supported", zh: "光在真空中的传播速度约为每秒30万公里", en: "Light travels at about 300,000 kilometres per second in a vacuum." },
  { truth: "supported", zh: "成年人的骨骼通常由206块骨头组成", en: "An adult human skeleton usually has 206 bones." },
  { truth: "supported", zh: "珠穆朗玛峰是世界上海拔最高的山峰", en: "Mount Everest is the highest mountain above sea level." },
  { truth: "supported", zh: "铜是良好的电导体", en: "Copper is a good conductor of electricity." },
  { truth: "supported", zh: "太平洋是地球上面积最大的海洋", en: "The Pacific is the largest ocean on Earth." },
  { truth: "refuted", zh: "长城在月球上肉眼可见", en: "The Great Wall of China is visible from the Moon with the naked eye." },
  { truth: "refuted", zh: "太阳绕着地球公转", en: "The Sun orbits the Earth." },
  { truth: "refuted", zh: "人类只使用了大脑的10%", en: "Humans use only 10% of their brains." },
  { truth: "refuted", zh: "蝙蝠是完全失明的", en: "Bats are completely blind." },
  { truth: "refuted", zh: "闪电从不会两次击中同一个地方", en: "Lightning never strikes the same place twice." },
  { truth: "refuted", zh: "金鱼的记忆只有3秒", en: "Goldfish have a memory span of only three seconds." },
  { truth: "refuted", zh: "月球自己会发光", en: "The Moon produces its own light." },
];

export const MAX_CANARIES = CANARIES.length;

const SYNONYMS: ReadonlyArray<readonly [string, ResearchVerdict]> = [
  ["supported", "supported"],
  ["supports", "supported"],
  ["support", "supported"],
  ["true", "supported"],
  ["refuted", "refuted"],
  ["refutes", "refuted"],
  ["refute", "refuted"],
  ["false", "refuted"],
  ["uncertain", "uncertain"],
  ["unknown", "uncertain"],
  ["unclear", "uncertain"],
  ["支持", "supported"],
  ["成立", "supported"],
  ["正确", "supported"],
  ["反驳", "refuted"],
  ["不成立", "refuted"],
  ["错误", "refuted"],
  ["不正确", "refuted"],
  ["不支持", "refuted"],
  ["不确定", "uncertain"],
  ["未知", "uncertain"],
];
const EXACT = new Map(SYNONYMS);
const LEADING_WORD = /^[a-z]+/;

/** Maps a model's verdict (English or Chinese, possibly decorated) to one of RESEARCH_VERDICTS. */
export function normalizeVerdict(s: string): ResearchVerdict | undefined {
  const t = s
    .trim()
    .toLowerCase()
    .replace(/^[\s*_`"'“”‘’([【「]+|[\s*_`"'“”‘’)\]】」.。!！,，;；:：]+$/g, "");
  const exact = EXACT.get(t);
  if (exact) return exact;
  const word = LEADING_WORD.exec(t)?.[0];
  if (word !== undefined) return EXACT.get(word);
  return SYNONYMS.find(([k]) => t.startsWith(k))?.[1];
}

/**
 * The verdict on the last ANSWER line, or "" when it is not a verdict. Research runs need this instead of
 * extractFinalAnswer, which would return the number inside "ANSWER: supported (42% of owners ...)".
 */
export function extractVerdict(text: string): string {
  const lines = text.split(/\r?\n/);
  const marker = MARK.answer.toLowerCase();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    const at = line.toLowerCase().lastIndexOf(marker);
    if (at < 0) continue;
    const rest = line.slice(at + marker.length).trim() || (lines.slice(i + 1).find((l) => l.trim()) ?? "");
    return normalizeVerdict(rest) ?? "";
  }
  return "";
}

/** Consensus key for research answers: verdict synonyms collapse to one value, anything else stays comparable. */
export function normalizeResearchAnswer(s: string): string {
  return normalizeVerdict(s) ?? normalizeAnswer(s);
}

export function isCanaryTask(t: Task): boolean {
  return t.answer !== "";
}

export function researchPrompt(claim: string): string {
  return (
    `Assess this claim with your knowledge. ${CLAIM_MARK} ${claim}\n` +
    `${REPLY_LEAD} '${MARK.method} <evidence or reasoning, max 40 words>' and a final line '${MARK.answer} supported|refuted|uncertain'.`
  );
}

/** The claim inside a research prompt, also when batching collapsed its newlines. */
export function claimText(prompt: string): string {
  const at = prompt.indexOf(CLAIM_MARK);
  if (at < 0) return prompt.trim();
  const rest = prompt.slice(at + CLAIM_MARK.length);
  const end = rest.search(new RegExp(`\\n|\\s${REPLY_LEAD}`));
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

export function ideaLanguage(idea: string): "zh" | "en" {
  return /[\u3400-\u9fff]/.test(idea) ? "zh" : "en";
}

export function plannerPrompt(idea: string, claims: number): string {
  return [
    `Decompose the idea below into exactly ${claims} short, independently checkable, falsifiable claims that together decide whether the idea is worth pursuing.`,
    "Cover market demand, technical feasibility, prior art and cost.",
    `Each claim must be at most ${CLAIM_MAX_CHARS} characters and written in the same language as the idea.`,
    `Reply with JSON only: {"claims": ["...", "..."]}`,
    "",
    `IDEA: ${idea}`,
  ].join("\n");
}

/** Parses the planner reply: the first balanced JSON object with a "claims" array, else the first JSON array. */
export function parseClaims(text: string): string[] {
  const obj = firstJson(text, "{");
  const list = isRecord(obj) && Array.isArray(obj.claims) ? obj.claims : firstJson(text, "[");
  const claims = Array.isArray(list)
    ? [
        ...new Set(
          list
            .filter((c): c is string => typeof c === "string")
            .map((c) => c.replace(/\s+/g, " ").trim().slice(0, CLAIM_MAX_CHARS))
            .filter((c) => c !== ""),
        ),
      ]
    : [];
  if (claims.length === 0) {
    const snippet = text.replace(/\s+/g, " ").trim().slice(0, 120);
    throw new Error(`research planner: no claims found in the reply (expected {"claims": [...]}); got: ${snippet || "<empty>"}`);
  }
  return claims;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function firstJson(text: string, open: "{" | "["): unknown {
  const close = open === "{" ? "}" : "]";
  for (let start = text.indexOf(open); start >= 0; start = text.indexOf(open, start + 1)) {
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
      else if (c === open) depth++;
      else if (c === close && --depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  return undefined;
}

/** Balanced true/false canaries in the idea's language; which side gets the odd one depends on the seed. */
export function pickCanaries(idea: string, count: number, seed: number): Array<{ claim: string; truth: "supported" | "refuted" }> {
  const lang = ideaLanguage(idea);
  const side = (truth: Canary["truth"]) =>
    seededShuffle(
      CANARIES.filter((c) => c.truth === truth),
      hashString(`canary:${truth}:${seed}`),
    );
  const [first, second] = hashString(`canary-side:${seed}`) % 2 === 0 ? [side("supported"), side("refuted")] : [side("refuted"), side("supported")];
  const picked = [...first.slice(0, Math.ceil(count / 2)), ...second.slice(0, Math.floor(count / 2))];
  return seededShuffle(picked, hashString(`canary-order:${seed}`)).map((c) => ({ claim: c[lang], truth: c.truth }));
}

export interface ResearchSourceOptions {
  llm: LLM;
  runId: string;
  idea: string;
  claims: number;
  canaries: number;
}

export class ResearchTaskSource implements TaskSource {
  readonly #opts: ResearchSourceOptions;

  constructor(opts: ResearchSourceOptions) {
    if (!opts.idea.trim()) throw new Error("research: the idea is empty");
    if (!Number.isInteger(opts.claims) || opts.claims < 1) throw new RangeError(`research: claims must be a positive integer, got ${opts.claims}`);
    if (!Number.isInteger(opts.canaries) || opts.canaries < 0 || opts.canaries > MAX_CANARIES) {
      throw new RangeError(`research: canaries must be an integer in [0, ${MAX_CANARIES}], got ${opts.canaries}`);
    }
    this.#opts = opts;
  }

  // `n` is ignored: the planner defines the task count (claims + canaries), so the idea sets its own scope.
  async load(_n: number, seed: number): Promise<Task[]> {
    const { llm, runId, idea, claims, canaries } = this.#opts;
    const r = await llm.complete({
      messages: [
        { role: "system", content: "You are a research planner. Reply with JSON only." },
        { role: "user", content: plannerPrompt(idea.trim(), claims) },
      ],
      json: true,
      temperature: 0,
      maxTokens: 1200,
      meta: { runId, purpose: "plan" },
    });
    const ideaClaims = parseClaims(r.text).slice(0, claims).map((claim) => ({ claim, truth: "" }));
    const canaryClaims = pickCanaries(idea, canaries, seed);
    const total = ideaClaims.length + canaryClaims.length;
    const canarySlots = new Set(seededShuffle([...Array(total).keys()], hashString(`canary-slots:${seed}`)).slice(0, canaryClaims.length));
    const width = Math.max(2, String(total).length);
    let nextIdea = 0;
    let nextCanary = 0;
    return Array.from({ length: total }, (_, i): Task => {
      const item = canarySlots.has(i) ? canaryClaims[nextCanary++] : ideaClaims[nextIdea++];
      return { id: `r${String(i + 1).padStart(width, "0")}`, domain: "research", prompt: researchPrompt(item!.claim), answer: item!.truth };
    });
  }
}
