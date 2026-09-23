import type { Lineage, Proposal, TaskEntry } from "../core/types";

export type Resolution =
  | { kind: "accept"; answer: string; proposalIds: string[]; independentSources: number }
  | { kind: "verify" }
  | { kind: "echo"; answer: string; proposalIds: string[]; agreeing: number; independentSources: number }
  | { kind: "wait" }
  | { kind: "fail" };

export interface ResolveOptions {
  /** From the verify judge; only meaningful for the first proposal. */
  needsVerification: boolean;
  maxAttempts: number;
  normalize: (s: string) => string;
}

interface Group {
  answer: string;
  proposals: Proposal[];
}

/** Groups by normalized answer in first-appearance order; empty answers carry no evidence. */
function groupProposals(proposals: Proposal[], normalize: (s: string) => string): Group[] {
  const groups = new Map<string, Group>();
  for (const p of proposals) {
    const answer = normalize(p.answer);
    if (answer === "") continue;
    const g = groups.get(answer);
    if (g) g.proposals.push(p);
    else groups.set(answer, { answer, proposals: [p] });
  }
  return [...groups.values()];
}

const accept = (g: Group, independentSources: number): Resolution => ({
  kind: "accept",
  answer: g.answer,
  proposalIds: g.proposals.map((p) => p.id),
  independentSources,
});

/**
 * Consensus counts independent evidence, not votes: agreeing proposals that share a lineage root
 * (one solver copied another) are one source, which is how false consensus (echo) is caught.
 */
export function resolveAfterProposal(entry: TaskEntry, lineage: Lineage, opts: ResolveOptions): Resolution {
  const groups = groupProposals(entry.proposals, opts.normalize);
  const exhausted = entry.attempts >= opts.maxAttempts;
  if (groups.length === 0) return exhausted ? { kind: "fail" } : { kind: "verify" };

  const [first] = groups;
  if (entry.proposals.length === 1 && first) {
    return opts.needsVerification && !exhausted ? { kind: "verify" } : accept(first, 1);
  }

  let best: (Group & { sources: number }) | undefined;
  for (const g of groups) {
    const sources = lineage.independentSources(g.proposals.map((p) => p.id));
    // Strict comparisons keep the earliest group on a full tie.
    if (!best || sources > best.sources || (sources === best.sources && g.proposals.length > best.proposals.length)) {
      best = { ...g, sources };
    }
  }
  if (!best) return { kind: "verify" };
  if (best.sources >= 2 || exhausted) return accept(best, best.sources);
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
