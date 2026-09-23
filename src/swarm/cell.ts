import { seededShuffle } from "../core/rng";
import { MARK, NONE_CHOICE, SUMMARY_TOKEN_BUDGET } from "../core/types";
import type { Answer, CapabilityCard, CellState, Domain, Gene, Proposal, PublicTask, Question } from "../core/types";
import type { TaskView } from "../protocol/handle";
import { MemoryGenePool } from "./genes";

const DOMAINS: readonly Domain[] = ["arithmetic", "rates", "logic", "gsm8k", "research"];
const SUMMARY_MAX_CHARS = SUMMARY_TOKEN_BUDGET * 4;
const GENE_MAX_CHARS = 240;
const CRITERIA_PROMPT_CHARS = 140;
// Judge states are billed on every decision, so gene lines carry a gist, not the full strategy.
const GENE_GIST_CHARS = 80;

export const SOLVE_SYSTEM = "You solve exactly one problem. Be concise and exact.";
export const GENE_SYSTEM = "You distil reusable problem-solving strategies from solved problems.";
export const CLAIM_GUIDANCE =
  "Choose the task this cell is most likely to solve correctly. Prefer tasks that need independent verification.";

export interface GeneJob {
  proposalId: string;
  taskId: string;
  domain: Domain;
  summary: string;
  independentSources: number;
}

/** A cell's private state. Cells share nothing but the blackboard (through a handle), lineage and gossip. */
export class Cell {
  readonly pool: MemoryGenePool;
  alive = true;
  quarantined = false;
  /** Demo-only ground truth: the swarm's decisions never read it except to simulate the attacker. */
  compromised = false;
  forgeryTried = false;
  state: CellState = "idle";
  taskId: string | undefined;
  lastDomain: Domain | undefined;
  lastBeat = 0;
  acceptedTotal = 0;
  declines = 0;
  ticks = 0;
  gossipDue = false;
  readonly pendingGenes: GeneJob[] = [];
  /**
   * Genes this cell already judged as a receiver. Without it, an evicted gene keeps coming back
   * and every return costs another adopt decision. Own genes are not listed: recollision covers them.
   */
  readonly evaluatedGenes = new Set<string>();
  readonly record = Object.fromEntries(DOMAINS.map((d) => [d, { accepted: 0, attempted: 0 }])) as Record<
    Domain,
    { accepted: number; attempted: number }
  >;

  constructor(
    readonly id: string,
    /** Mutable: a runtime joiner links itself into existing cells' neighbourhoods. */
    readonly neighbors: string[],
    geneCapacity: number,
    readonly model = "",
  ) {
    this.pool = new MemoryGenePool({ capacity: geneCapacity });
  }

  /** Working = may still act: alive and not quarantined. */
  get working(): boolean {
    return this.alive && !this.quarantined;
  }

  recordAttempt(domain: Domain): void {
    this.record[domain].attempted++;
    this.lastDomain = domain;
  }

  /** Smoothed accepted/attempted rate in a domain, the Laplace prior discovery uses. */
  rate(domain: Domain): number {
    const r = this.record[domain];
    return (r.accepted + 1) / (r.attempted + 2);
  }

  cardDomains(): CapabilityCard["domains"] {
    const out: CapabilityCard["domains"] = {};
    for (const d of DOMAINS) {
      const r = this.record[d];
      if (r.attempted > 0) out[d] = { wins: r.accepted, trials: r.attempted };
    }
    return out;
  }

  geneGists(): string[] {
    return this.pool.list().map((g) => `${g.domain}: ${gist(g.text)}`);
  }

  /** Returns true when this is the cell's first accepted proposal in the domain. */
  recordWin(domain: Domain): boolean {
    this.record[domain].accepted++;
    this.acceptedTotal++;
    return this.record[domain].accepted === 1;
  }
}

export function profileLine(cell: Cell): string {
  const parts = DOMAINS.map((d) => `${d} ${cell.record[d].accepted}/${cell.record[d].attempted}`);
  return `${MARK.profile} ${parts.join(", ")}`;
}

const gist = (text: string): string => (text.length > GENE_GIST_CHARS ? `${text.slice(0, GENE_GIST_CHARS - 1)}…` : text);

// Gene lines deliberately avoid a "- " prefix: that shape is reserved for precedent lines.
function geneBlock(genes: Gene[]): string[] {
  return genes.length === 0 ? ["GENES: none"] : ["GENES:", ...genes.map((g) => `${g.domain}: ${gist(g.text)}`)];
}

export function buildClaimState(cell: Cell): string {
  return [`Cell ${cell.id}`, profileLine(cell), ...geneBlock(cell.pool.list()), CLAIM_GUIDANCE].join("\n");
}

const needsVerification = (v: TaskView): boolean => v.status === "verifying" || v.proposers.length > 0;

export type ClaimRule = "echo" | "orphan" | "verifying" | "domain";

export interface RuleClaimContext {
  model: string;
  /** Model of the cell that made the task's first proposal, if known. */
  modelOf: (cellId: string) => string | undefined;
  rate: (domain: Domain) => number;
  /** Tasks this cell was asked to look at (echo targets): always first. */
  preferred: ReadonlySet<string>;
  /** Open tasks whose holder died or was quarantined: next, so orphaned work is picked up in seconds, not at the end. */
  orphans?: ReadonlySet<string>;
  /** Per-cell seed, so ties do not herd every cell onto the same task. */
  seed: number;
}

/**
 * Zero-token claim order: echo targets, then orphaned tasks (a dead or quarantined holder's lease came
 * back), then tasks awaiting verification (a different model than the first proposer first, against
 * correlated errors), then open tasks by this cell's domain record, then fewest attempts; ties keep a
 * per-cell shuffle.
 */
export function ruleClaimOrder(views: readonly TaskView[], ctx: RuleClaimContext): Array<{ taskId: string; rule: ClaimRule }> {
  const tier = (v: TaskView): number => {
    if (ctx.preferred.has(v.task.id)) return 0;
    if (ctx.orphans?.has(v.task.id)) return 0.5;
    if (!needsVerification(v)) return 3;
    const first = v.proposers[0];
    const firstModel = first === undefined ? undefined : ctx.modelOf(first);
    return firstModel !== undefined && firstModel !== ctx.model ? 1 : 2;
  };
  return seededShuffle(views, ctx.seed)
    .map((v) => ({ v, tier: tier(v), rate: ctx.rate(v.task.domain) }))
    .sort((a, b) => a.tier - b.tier || (a.tier === 3 ? b.rate - a.rate : 0) || a.v.attempts - b.v.attempts)
    .map(({ v, tier: t }) => ({ taskId: v.task.id, rule: t === 0 ? "echo" : t === 0.5 ? "orphan" : t === 3 ? "domain" : "verifying" }));
}

export function claimQuestion(entries: readonly TaskView[]): Question {
  const criteria: Record<string, string> = {};
  for (const e of entries) {
    const needsVerify = needsVerification(e);
    const prompt = e.task.prompt.replace(/\s+/g, " ").slice(0, CRITERIA_PROMPT_CHARS);
    criteria[e.task.id] = `${e.task.domain}; attempts=${e.attempts}; ${needsVerify ? "needs independent verification" : "open"}; ${prompt}`;
  }
  criteria[NONE_CHOICE] = "no suitable task";
  return {
    type: "choice",
    instructions: `Which candidate task should this cell claim next? ${CLAIM_GUIDANCE} Choose "${NONE_CHOICE}" only if no task fits.`,
    criteria,
  };
}

/**
 * Candidate ids in the order the cell should try to claim them: the judge's choice first, then the
 * rest by its probabilities, so a lost race falls back without a second decision. Empty = declined.
 */
export function claimOrder(answer: Answer | undefined, candidateIds: string[]): string[] {
  if (answer?.type !== "choice") return candidateIds.slice();
  if (answer.choice === NONE_CHOICE) return [];
  const p = (id: string) => answer.probabilities[id] ?? 0;
  const rest = candidateIds.filter((id) => id !== answer.choice).sort((a, b) => p(b) - p(a));
  return candidateIds.includes(answer.choice) ? [answer.choice, ...rest] : rest;
}

export function buildSolvePrompt(task: PublicTask, gene?: Gene, teammate?: Proposal): string {
  const lines = [`${MARK.domain} ${task.domain}`];
  if (gene) lines.push(`${MARK.strategy} ${gene.text}`);
  if (teammate) lines.push(`${MARK.teammate} ${teammate.answer} (${teammate.summary})`);
  lines.push("", task.prompt);
  // Research prompts carry their own verdict-shaped reply format; a numeric tail would contradict it.
  if (task.domain !== "research") {
    lines.push("", `Reply with one line starting with ${MARK.method} (max 30 words) and a final line ${MARK.answer} <number>.`);
  }
  return lines.join("\n");
}

export function methodSummary(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trimStart().toUpperCase().startsWith(MARK.method));
  const body = line === undefined ? "" : line.trimStart().slice(MARK.method.length).trim();
  return body.slice(0, SUMMARY_MAX_CHARS);
}

export const VERIFY_QUESTION: Question = {
  type: "noul",
  instructions:
    "The proposed answer is likely wrong or the problem is tricky enough that an independent re-solve is warranted.",
};

/** Salient lines first: precedents keep only the head of a state, and it must still show the answer. */
export function buildVerifyState(task: PublicTask, answer: string, summary: string): string {
  return [`${MARK.domain} ${task.domain}`, `${MARK.answer} ${answer}`, `${MARK.method} ${summary}`, `PROBLEM: ${task.prompt}`].join("\n");
}

export function adoptQuestion(domain: Domain): Question {
  return {
    type: "noul",
    instructions: `Adopting this strategy would help this cell solve ${domain} problems more reliably.`,
  };
}

/** Only the receiver's genes for the offered domain matter: those are what the newcomer competes with. */
export function buildAdoptState(receiver: Cell, gene: Gene, senderFitness: number): string {
  return [
    `${MARK.domain} ${gene.domain}`,
    `OFFERED STRATEGY: ${gene.text}`,
    `SENDER FITNESS: ${senderFitness.toFixed(2)} (${gene.wins} wins / ${gene.trials} trials)`,
    `Cell ${receiver.id}`,
    profileLine(receiver),
    ...geneBlock(receiver.pool.list().filter((g) => g.domain === gene.domain)),
  ].join("\n");
}

export function buildGenePrompt(domain: Domain, summary: string): string {
  return [
    `${MARK.domain} ${domain}`,
    `${MARK.method} ${summary}`,
    `In one sentence (max 40 words), state a reusable strategy for solving ${domain} problems like this one. Reply with the strategy only.`,
  ].join("\n");
}

export function geneText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, GENE_MAX_CHARS);
}
