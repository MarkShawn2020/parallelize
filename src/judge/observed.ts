import { BudgetExceededError } from "../core/types";
import type { Answer, Decision, Judge, JudgeRequest, JudgeResult, Question, Tier, Usage } from "../core/types";
import { confidenceOf } from "./confidence";

export interface DecisionHooks {
  onDecision?: (d: Decision) => void;
  now?: () => number;
  newId?: () => string;
}

/** Answer used when the deciding judge failed (see conservativeAnswer in ./dispute). */
export type FallbackAnswer = (key: string, q: Question) => Answer;

export const FALLBACK_MODEL = "fallback";

// Module-wide so ids stay unique when several judges (e.g. one per cell) share a run.
let seq = 0;
export function nextDecisionId(): string {
  seq += 1;
  return String(seq);
}

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: a.costUsd + b.costUsd,
  };
}

export function shareUsage(u: Usage, n: number): Usage {
  const d = Math.max(1, n);
  return { inputTokens: u.inputTokens / d, outputTokens: u.outputTokens / d, costUsd: u.costUsd / d };
}

/** A cost cap is a stop signal, not an outage to route around. */
export function rethrowIfBudget(err: unknown): void {
  if (err instanceof BudgetExceededError) throw err;
}

export interface ObservedJudgeOptions extends DecisionHooks {
  /** Without it, inner failures propagate. */
  fallback?: FallbackAnswer;
}

/** Passes calls through and logs one Decision per key, so swarm-llm and swarm-jev log alike. */
export class ObservedJudge implements Judge {
  readonly id: string;
  readonly tier: Tier;
  readonly simulated: boolean;
  private readonly onDecision: (d: Decision) => void;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly fallback: FallbackAnswer | undefined;

  constructor(
    private readonly inner: Judge,
    opts: ObservedJudgeOptions = {},
  ) {
    this.id = inner.id;
    this.tier = inner.tier;
    this.simulated = inner.simulated;
    this.onDecision = opts.onDecision ?? (() => {});
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? nextDecisionId;
    this.fallback = opts.fallback;
  }

  async ask(req: JudgeRequest): Promise<JudgeResult> {
    let r: JudgeResult;
    let fellBack = false;
    try {
      r = await this.inner.ask(req);
    } catch (err) {
      rethrowIfBudget(err);
      if (!this.fallback) throw err;
      r = this.fallbackResult(req, this.fallback);
      fellBack = true;
    }
    const answered = Object.keys(req.questions).filter((k) => r.answers[k] !== undefined);
    const usage = shareUsage(r.usage, answered.length);
    for (const key of answered) {
      const answer = r.answers[key]!;
      this.onDecision({
        id: this.newId(),
        runId: req.meta.runId,
        cellId: req.meta.cellId,
        taskId: req.meta.taskId,
        key,
        tier: this.inner.tier,
        escalated: false,
        answer,
        // A default is not a judgment; confidence 0 keeps it out of any confidence-gated logic.
        confidence: fellBack ? 0 : confidenceOf(answer),
        latencyMs: r.latencyMs,
        usage,
        precedentsUsed: 0,
        ...(fellBack ? { fallback: true } : {}),
        at: this.now(),
      });
    }
    return r;
  }

  private fallbackResult(req: JudgeRequest, fallback: FallbackAnswer): JudgeResult {
    const answers = Object.fromEntries(Object.entries(req.questions).map(([k, q]) => [k, fallback(k, q)]));
    return { answers, usage: ZERO_USAGE, latencyMs: 0, model: FALLBACK_MODEL };
  }
}
