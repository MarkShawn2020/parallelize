import type { Decision, Judge, JudgeRequest, JudgeResult, Tier, Usage } from "../core/types";
import { confidenceOf } from "./confidence";

export interface DecisionHooks {
  onDecision?: (d: Decision) => void;
  now?: () => number;
  newId?: () => string;
}

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

/** Passes calls through and logs one Decision per key, so swarm-llm and swarm-jev log alike. */
export class ObservedJudge implements Judge {
  readonly id: string;
  readonly tier: Tier;
  readonly simulated: boolean;
  private readonly onDecision: (d: Decision) => void;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(
    private readonly inner: Judge,
    opts: DecisionHooks = {},
  ) {
    this.id = inner.id;
    this.tier = inner.tier;
    this.simulated = inner.simulated;
    this.onDecision = opts.onDecision ?? (() => {});
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? nextDecisionId;
  }

  async ask(req: JudgeRequest): Promise<JudgeResult> {
    const r = await this.inner.ask(req);
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
        confidence: confidenceOf(answer),
        latencyMs: r.latencyMs,
        usage,
        precedentsUsed: 0,
        at: this.now(),
      });
    }
    return r;
  }
}
