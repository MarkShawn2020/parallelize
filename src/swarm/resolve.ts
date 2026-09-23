import type { Lineage, Proposal, TaskEntry } from "../core/types";

export type Resolution =
  | { kind: "accept"; answer: string; proposalIds: string[]; independentSources: number }
  | { kind: "verify" }
  | { kind: "echo"; answer: string; proposalIds: string[]; agreeing: number; independentSources: number }
  | { kind: "wait" }
  | { kind: "fail" };

export interface ResolveOptions {
  /** From the review policy (rules, then the verify judge); only meaningful for a lone proposal. */
  needsVerification: boolean;
  maxAttempts: number;
  normalize: (s: string) => string;
}

export interface ScoredGroup {
  answer: string;
  proposals: Proposal[];
  /** Independent lineage roots among the group's proposals. */
  sources: number;
}

/** Groups by normalized answer in first-appearance order; empty answers carry no evidence. */
export function scoreGroups(proposals: readonly Proposal[], lineage: Lineage, normalize: (s: string) => string): ScoredGroup[] {
  const groups = new Map<string, Proposal[]>();
  for (const p of proposals) {
    const answer = normalize(p.answer);
    if (answer === "") continue;
    const g = groups.get(answer);
    if (g) g.push(p);
    else groups.set(answer, [p]);
  }
  return [...groups].map(([answer, ps]) => ({ answer, proposals: ps, sources: lineage.independentSources(ps.map((p) => p.id)) }));
}

/** Two or more distinct answers and none backed by two independent sources: a question for the dispute judge. */
export function isDisagreement(groups: readonly ScoredGroup[]): boolean {
  return groups.length >= 2 && groups.every((g) => g.sources < 2);
}

const accept = (g: ScoredGroup): Resolution => ({
  kind: "accept",
  answer: g.answer,
  proposalIds: g.proposals.map((p) => p.id),
  independentSources: g.sources,
});

/**
 * Consensus counts independent evidence, not votes: agreeing proposals that share a lineage root
 * (one solver copied another) are one source, which is how false consensus (echo) is caught.
 */
export function resolveAfterProposal(entry: TaskEntry, lineage: Lineage, opts: ResolveOptions): Resolution {
  const groups = scoreGroups(entry.proposals, lineage, opts.normalize);
  const exhausted = entry.attempts >= opts.maxAttempts;
  if (groups.length === 0) return exhausted ? { kind: "fail" } : { kind: "verify" };

  const [first] = groups;
  if (entry.proposals.length === 1 && first) {
    return opts.needsVerification && !exhausted ? { kind: "verify" } : accept({ ...first, sources: 1 });
  }

  let best: ScoredGroup | undefined;
  for (const g of groups) {
    // Strict comparisons keep the earliest group on a full tie.
    if (!best || g.sources > best.sources || (g.sources === best.sources && g.proposals.length > best.proposals.length)) best = g;
  }
  if (!best) return { kind: "verify" };
  if (best.sources >= 2 || exhausted) return accept(best);
  if (best.proposals.length >= 2) {
    return {
      kind: "echo",
      answer: best.answer,
      proposalIds: best.proposals.map((p) => p.id),
      agreeing: best.proposals.length,
      independentSources: best.sources,
    };
  }
  return { kind: "verify" };
}

/**
 * A verify verdict is confirmed by the outcome, never by itself: "re-solve" is right when the proposal
 * did not survive, "fine" is right when it was accepted unchanged. `accepted` undefined = the task failed.
 */
export function verifyVerdictConfirmed(v: { reSolve: boolean; answer: string }, accepted: string | undefined): boolean {
  if (accepted === undefined) return v.reSolve;
  return v.reSolve ? v.answer !== accepted : v.answer === accepted;
}

/**
 * A dispute pick is right when it is the answer finally accepted; "unclear" (chosen undefined) is right
 * only when none of the disputed answers was finally accepted.
 */
export function disputeVerdictConfirmed(d: { chosen?: string; candidates: readonly string[] }, accepted: string | undefined): boolean {
  if (d.chosen !== undefined) return d.chosen === accepted;
  return accepted === undefined || !d.candidates.includes(accepted);
}
