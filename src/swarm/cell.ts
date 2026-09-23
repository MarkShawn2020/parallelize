import { MARK, NONE_CHOICE, SUMMARY_TOKEN_BUDGET } from "../core/types";
import type { Answer, CellState, Domain, Gene, Proposal, PublicTask, Question, TaskEntry } from "../core/types";
import { MemoryGenePool } from "./genes";

const DOMAINS: readonly Domain[] = ["arithmetic", "rates", "logic", "gsm8k"];
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
}

/** A cell's private state. Cells share nothing but the blackboard, lineage and gossip. */
export class Cell {
  readonly pool: MemoryGenePool;
  alive = true;
  state: CellState = "idle";
  taskId: string | undefined;
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
    readonly neighbors: string[],
    geneCapacity: number,
  ) {
    this.pool = new MemoryGenePool({ capacity: geneCapacity });
  }

  recordAttempt(domain: Domain): void {
    this.record[domain].attempted++;
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

// Gene lines deliberately avoid a "- " prefix: that shape is reserved for precedent lines.
function geneBlock(genes: Gene[]): string[] {
  const gist = (g: Gene) => (g.text.length > GENE_GIST_CHARS ? `${g.text.slice(0, GENE_GIST_CHARS - 1)}…` : g.text);
  return genes.length === 0 ? ["GENES: none"] : ["GENES:", ...genes.map((g) => `${g.domain}: ${gist(g)}`)];
}

export function buildClaimState(cell: Cell): string {
  return [`Cell ${cell.id}`, profileLine(cell), ...geneBlock(cell.pool.list()), CLAIM_GUIDANCE].join("\n");
}

export function claimQuestion(entries: TaskEntry[]): Question {
  const criteria: Record<string, string> = {};
  for (const e of entries) {
    const needsVerify = e.status === "verifying" || e.proposals.length > 0;
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
  lines.push(
    "",
    task.prompt,
    "",
    `Reply with one line starting with ${MARK.method} (max 30 words) and a final line ${MARK.answer} <number>.`,
  );
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
