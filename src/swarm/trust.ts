import type { TrustLedger } from "../core/types";

/**
 * Beta-Bernoulli trust with a mildly optimistic prior: a fresh agent starts at 2/3, so it is neither
 * quarantined on its first miss nor trusted enough to skip probation.
 */
export class BetaTrust implements TrustLedger {
  readonly #priorAgree: number;
  readonly #priorDisagree: number;
  readonly #stats = new Map<string, { agreed: number; judged: number }>();

  constructor(opts: { priorAgree?: number; priorDisagree?: number } = {}) {
    this.#priorAgree = opts.priorAgree ?? 2;
    this.#priorDisagree = opts.priorDisagree ?? 1;
  }

  get(agentId: string): number {
    const s = this.#stats.get(agentId) ?? { agreed: 0, judged: 0 };
    return (s.agreed + this.#priorAgree) / (s.judged + this.#priorAgree + this.#priorDisagree);
  }

  judged(agentId: string): number {
    return this.#stats.get(agentId)?.judged ?? 0;
  }

  record(agentId: string, agreed: boolean): number {
    const s = this.#stats.get(agentId) ?? { agreed: 0, judged: 0 };
    this.#stats.set(agentId, { agreed: s.agreed + (agreed ? 1 : 0), judged: s.judged + 1 });
    return this.get(agentId);
  }
}

export type ReviewReason = "probation" | "low-trust" | "audit";

/** Why a proposal must be independently re-solved regardless of what System 1 thinks; null if none. */
export function reviewReason(p: {
  judged: number;
  trust: number;
  probation: number;
  reviewTrust: number;
  auditDraw: number;
  auditRate: number;
}): ReviewReason | null {
  if (p.judged < p.probation) return "probation";
  if (p.trust < p.reviewTrust) return "low-trust";
  if (p.auditDraw < p.auditRate) return "audit";
  return null;
}

/** Only after probation: a new agent's early misses are expected noise, not evidence of compromise. */
export function shouldQuarantine(p: { judged: number; trust: number; probation: number; quarantineTrust: number }): boolean {
  return p.judged >= p.probation && p.trust < p.quarantineTrust;
}
