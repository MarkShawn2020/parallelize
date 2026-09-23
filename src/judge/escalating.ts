import type { Answer, Decision, Judge, JudgeRequest, JudgeResult, PrecedentStore, Question, Tier } from "../core/types";
import { confidenceOf } from "./confidence";
import { addUsage, FALLBACK_MODEL, nextDecisionId, rethrowIfBudget, shareUsage, ZERO_USAGE } from "./observed";
import type { DecisionHooks, FallbackAnswer } from "./observed";
import { formatPrecedents } from "./precedents";

export interface GuardOptions {
  /** Escalated System-1 answers per key that must exist before the key can be guarded. */
  window: number;
  /** Guard a key once System 1 disagreed with System 2 on more than this share of the last window. */
  maxDisagreement: number;
  /** Fires once per key, when it becomes guarded. */
  onGuard?: (key: string, disagreement: number) => void;
}

export interface EscalatingJudgeOptions extends DecisionHooks {
  s1: Judge;
  s2: Judge;
  threshold: number;
  precedents: PrecedentStore;
  precedentsPerKey?: number;
  guard?: GuardOptions;
  /** Without it, System-2 failures propagate. */
  fallback?: FallbackAnswer;
}

/**
 * System 1 answers first; keys below the confidence threshold go to System 2, whose verdicts
 * become pending precedents that System 1 sees once the swarm confirms them (strategy compression).
 * Keys where System 1 keeps contradicting System 2 are guarded: they skip System 1 entirely.
 */
export class EscalatingJudge implements Judge {
  readonly id: string;
  readonly tier: Tier = "system1";
  readonly simulated: boolean;
  private readonly s1: Judge;
  private readonly s2: Judge;
  private readonly threshold: number;
  private readonly precedents: PrecedentStore;
  private readonly perKey: number;
  private readonly guard: CalibrationGuard | undefined;
  private readonly fallback: FallbackAnswer | undefined;
  private readonly onDecision: (d: Decision) => void;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(opts: EscalatingJudgeOptions) {
    this.s1 = opts.s1;
    this.s2 = opts.s2;
    this.id = `${opts.s1.id}>${opts.s2.id}`;
    this.simulated = opts.s1.simulated && opts.s2.simulated;
    this.threshold = opts.threshold;
    this.precedents = opts.precedents;
    this.perKey = opts.precedentsPerKey ?? 4;
    this.guard = opts.guard ? new CalibrationGuard(opts.guard) : undefined;
    this.fallback = opts.fallback;
    this.onDecision = opts.onDecision ?? (() => {});
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? nextDecisionId;
  }

  isGuarded(key: string): boolean {
    return this.guard?.isGuarded(key) ?? false;
  }

  async ask(req: JudgeRequest): Promise<JudgeResult> {
    const keys = Object.keys(req.questions);
    const guarded = new Set(keys.filter((k) => this.isGuarded(k)));
    const s1Keys = keys.filter((k) => !guarded.has(k));
    const included = s1Keys.flatMap((k) => this.precedents.relevant(k, this.perKey));
    const block = formatPrecedents(included);

    const r1 =
      s1Keys.length > 0
        ? await this.askSystem1({
            state: block ? `${req.state}\n\n${block}` : req.state,
            questions: pick(req.questions, s1Keys),
            meta: req.meta,
          })
        : undefined;
    const escalated = keys.filter((k) => guarded.has(k) || this.needsSystem2(r1?.answers[k]));

    let r2: JudgeResult | undefined;
    let fallbacks: Record<string, Answer> | undefined;
    const precedentIds = new Map<string, string>();
    if (escalated.length > 0) {
      const questions = pick(req.questions, escalated);
      try {
        r2 = await this.s2.ask({ state: req.state, questions, meta: req.meta });
      } catch (err) {
        rethrowIfBudget(err);
        const fallback = this.fallback;
        if (!fallback) throw err;
        fallbacks = Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, fallback(k, q)]));
      }
      for (const key of escalated) {
        const verdict = r2?.answers[key];
        if (!verdict) continue;
        precedentIds.set(key, this.precedents.propose({ key, state: req.state, verdict, at: this.now() }));
        const s1Answer = r1?.answers[key];
        if (s1Answer && !guarded.has(key)) this.guard?.record(key, !sameVerdict(s1Answer, verdict));
      }
    }

    const isEscalated = new Set(escalated);
    const r1Share = r1 ? shareUsage(r1.usage, countAnswered(r1, s1Keys)) : ZERO_USAGE;
    const r2Share = r2 ? shareUsage(r2.usage, countAnswered(r2, escalated)) : ZERO_USAGE;
    const answers: Record<string, Answer> = {};
    for (const key of keys) {
      const esc = isEscalated.has(key);
      const fallbackAnswer = fallbacks?.[key];
      const answer = fallbackAnswer ?? (esc ? r2?.answers[key] : undefined) ?? r1?.answers[key];
      if (!answer) continue;
      answers[key] = answer;
      const s1Usage = r1?.answers[key] ? r1Share : ZERO_USAGE;
      const precedentId = precedentIds.get(key);
      this.onDecision({
        id: this.newId(),
        runId: req.meta.runId,
        cellId: req.meta.cellId,
        taskId: req.meta.taskId,
        key,
        tier: esc ? "system2" : "system1",
        escalated: esc,
        answer,
        // A default is not a judgment; confidence 0 keeps it out of any confidence-gated logic.
        confidence: fallbackAnswer ? 0 : confidenceOf(answer),
        latencyMs: (r1?.latencyMs ?? 0) + (esc ? (r2?.latencyMs ?? 0) : 0),
        usage: esc ? addUsage(s1Usage, r2Share) : s1Usage,
        precedentsUsed: guarded.has(key) ? 0 : included.length,
        ...(precedentId !== undefined ? { precedentId } : {}),
        ...(fallbackAnswer ? { fallback: true } : {}),
        ...(guarded.has(key) ? { guarded: true } : {}),
        at: this.now(),
      });
    }

    const m2 = r2?.model ?? (fallbacks ? FALLBACK_MODEL : undefined);
    return {
      answers,
      usage: addUsage(r1?.usage ?? ZERO_USAGE, r2?.usage ?? ZERO_USAGE),
      latencyMs: (r1?.latencyMs ?? 0) + (r2?.latencyMs ?? 0),
      model: r1 && m2 ? `${r1.model}+${m2}` : (m2 ?? r1?.model ?? this.id),
    };
  }

  /** undefined means System 1 failed; every key then escalates so the demo keeps running. */
  private async askSystem1(req: JudgeRequest): Promise<JudgeResult | undefined> {
    try {
      return await this.s1.ask(req);
    } catch (err) {
      rethrowIfBudget(err);
      return undefined;
    }
  }

  private needsSystem2(a: Answer | undefined): boolean {
    return a === undefined || confidenceOf(a) < this.threshold;
  }
}

/** Same side of 0.5 for noul, same pick for choice, within half a level for score. */
export function sameVerdict(a: Answer, b: Answer): boolean {
  if (a.type === "noul" && b.type === "noul") return (a.noul >= 0.5) === (b.noul >= 0.5);
  if (a.type === "choice" && b.type === "choice") return a.choice === b.choice;
  if (a.type === "score" && b.type === "score") return Math.abs(a.score - b.score) < 0.5;
  return false;
}

/** Per-key rolling record of System-1 vs System-2 disagreement on escalated questions. */
class CalibrationGuard {
  private readonly disagreements = new Map<string, boolean[]>();
  private readonly guarded = new Set<string>();
  private readonly window: number;
  private readonly maxDisagreement: number;
  private readonly onGuard: (key: string, disagreement: number) => void;

  constructor(opts: GuardOptions) {
    this.window = Math.max(1, Math.floor(opts.window));
    this.maxDisagreement = opts.maxDisagreement;
    this.onGuard = opts.onGuard ?? (() => {});
  }

  isGuarded(key: string): boolean {
    return this.guarded.has(key);
  }

  record(key: string, disagreed: boolean): void {
    const recent = this.disagreements.get(key) ?? [];
    recent.push(disagreed);
    if (recent.length > this.window) recent.shift();
    this.disagreements.set(key, recent);
    if (recent.length < this.window) return;
    const share = recent.filter(Boolean).length / recent.length;
    if (share <= this.maxDisagreement) return;
    this.guarded.add(key);
    this.disagreements.delete(key);
    this.onGuard(key, share);
  }
}

function pick(qs: Record<string, Question>, keys: string[]): Record<string, Question> {
  return Object.fromEntries(keys.map((k) => [k, qs[k]!]));
}

function countAnswered(r: JudgeResult, keys: string[]): number {
  return keys.filter((k) => r.answers[k] !== undefined).length;
}
