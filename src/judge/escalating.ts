import { BudgetExceededError } from "../core/types";
import type {
  Answer,
  Decision,
  Judge,
  JudgeRequest,
  JudgeResult,
  PrecedentStore,
  Question,
  Tier,
} from "../core/types";
import { confidenceOf } from "./confidence";
import { addUsage, nextDecisionId, shareUsage, ZERO_USAGE } from "./observed";
import type { DecisionHooks } from "./observed";
import { formatPrecedents } from "./precedents";

export interface EscalatingJudgeOptions extends DecisionHooks {
  s1: Judge;
  s2: Judge;
  threshold: number;
  precedents: PrecedentStore;
  precedentsPerKey?: number;
}

/**
 * System 1 answers first; keys below the confidence threshold go to System 2, whose verdicts
 * become precedents in later System-1 state (strategy compression).
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
    this.onDecision = opts.onDecision ?? (() => {});
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? nextDecisionId;
  }

  async ask(req: JudgeRequest): Promise<JudgeResult> {
    const keys = Object.keys(req.questions);
    const included = keys.flatMap((k) => this.precedents.relevant(k, this.perKey));
    const block = formatPrecedents(included);
    const s1State = block ? `${req.state}\n\n${block}` : req.state;

    const r1 = await this.askSystem1({ ...req, state: s1State });
    const escalated = r1 ? keys.filter((k) => this.needsSystem2(r1.answers[k])) : keys;

    let r2: JudgeResult | undefined;
    if (escalated.length > 0) {
      r2 = await this.s2.ask({
        state: req.state,
        questions: pick(req.questions, escalated),
        meta: req.meta,
      });
      for (const key of escalated) {
        const verdict = r2.answers[key];
        if (verdict) this.precedents.add({ key, state: req.state, verdict, at: this.now() });
      }
    }

    const isEscalated = new Set(escalated);
    const r1Share = r1 ? shareUsage(r1.usage, countAnswered(r1, keys)) : ZERO_USAGE;
    const r2Share = r2 ? shareUsage(r2.usage, countAnswered(r2, escalated)) : ZERO_USAGE;
    const answers: Record<string, Answer> = {};
    for (const key of keys) {
      const esc = isEscalated.has(key);
      const answer = (esc ? r2?.answers[key] : undefined) ?? r1?.answers[key];
      if (!answer) continue;
      answers[key] = answer;
      const s1Usage = r1?.answers[key] ? r1Share : ZERO_USAGE;
      this.onDecision({
        id: this.newId(),
        runId: req.meta.runId,
        cellId: req.meta.cellId,
        taskId: req.meta.taskId,
        key,
        tier: esc ? "system2" : "system1",
        escalated: esc,
        answer,
        confidence: confidenceOf(answer),
        latencyMs: (r1?.latencyMs ?? 0) + (esc ? (r2?.latencyMs ?? 0) : 0),
        usage: esc ? addUsage(s1Usage, r2Share) : s1Usage,
        precedentsUsed: included.length,
        at: this.now(),
      });
    }

    return {
      answers,
      usage: addUsage(r1?.usage ?? ZERO_USAGE, r2?.usage ?? ZERO_USAGE),
      latencyMs: (r1?.latencyMs ?? 0) + (r2?.latencyMs ?? 0),
      model: r1 && r2 ? `${r1.model}+${r2.model}` : (r2?.model ?? r1?.model ?? this.id),
    };
  }

  /** undefined means System 1 failed; every key then escalates so the demo keeps running. */
  private async askSystem1(req: JudgeRequest): Promise<JudgeResult | undefined> {
    try {
      return await this.s1.ask(req);
    } catch (err) {
      // A cost cap is a stop signal, not an outage to route around.
      if (err instanceof BudgetExceededError) throw err;
      return undefined;
    }
  }

  private needsSystem2(a: Answer | undefined): boolean {
    return a === undefined || confidenceOf(a) < this.threshold;
  }
}

function pick(qs: Record<string, Question>, keys: string[]): Record<string, Question> {
  return Object.fromEntries(keys.map((k) => [k, qs[k]!]));
}

function countAnswered(r: JudgeResult, keys: string[]): number {
  return keys.filter((k) => r.answers[k] !== undefined).length;
}
