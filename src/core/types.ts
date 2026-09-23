// Shared contract for every module. Change only with the integrator's agreement:
// parallel implementers code against this file.

// ---------------------------------------------------------------- run setup

export type Mode = "single" | "subagent" | "swarm-llm" | "swarm-jev";
export const MODES: readonly Mode[] = ["single", "subagent", "swarm-llm", "swarm-jev"];

export type Domain = "arithmetic" | "rates" | "logic" | "gsm8k";

export type TaskSourceConfig = { kind: "synthetic" } | { kind: "gsm8k"; path: string };

export interface RunConfig {
  mode: Mode;
  n: number;
  cells: number;
  seed: number;
  taskSource: TaskSourceConfig;
  /** System-1 provider for swarm-jev; ignored by other modes. */
  judge: "jev" | "mock";
  /** System-2 provider for every mode. */
  llm: "openrouter" | "mock";
  /** Below this confidence a System-1 answer is escalated to System 2. */
  escalationThreshold: number;
  /** noul probability at or above which a proposal needs an independent re-solve. */
  verifyThreshold: number;
  leaseMs: number;
  maxCostUsd: number;
  maxWallMs: number;
  llmConcurrency: number;
  judgeConcurrency: number;
  topology: "ring" | "small-world";
  geneCapacity: number;
  /** A cell gossips its best gene after this many accepted solves. */
  gossipEvery: number;
  /** Candidate tasks shown to a cell per claim decision (Jev choice supports <= 255). */
  claimCandidates: number;
}

// ---------------------------------------------------------------- tasks

/** `answer` is ground truth. Only the runner may read it, and only for metrics. */
export interface Task {
  id: string;
  domain: Domain;
  prompt: string;
  answer: string;
}
export type PublicTask = Omit<Task, "answer">;

export interface TaskSource {
  load(n: number, seed: number): Promise<Task[]>;
}

// ---------------------------------------------------------------- providers

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/**
 * work: solve | single | report.  coordination: everything else.
 * The split drives the "coordination tokens" metric, so every call must carry one.
 */
export type Purpose =
  | "solve"
  | "single"
  | "report"
  | "merge"
  | "claim"
  | "verify"
  | "adopt"
  | "gene"
  | "adjudicate";
export const WORK_PURPOSES: readonly Purpose[] = ["solve", "single", "report"];

export interface CallMeta {
  runId: string;
  purpose: Purpose;
  cellId?: string;
  taskId?: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMRequest {
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  json?: boolean;
  meta: CallMeta;
}

export interface LLMResult {
  text: string;
  usage: Usage;
  latencyMs: number;
  model: string;
}

export interface LLM {
  readonly id: string;
  readonly simulated: boolean;
  complete(req: LLMRequest): Promise<LLMResult>;
}

/** Jev systemone question primitives, mirrored 1:1 so any Judge speaks Jev's wire format. */
export type Question =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export type Answer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; confidence: number; probabilities?: Record<string, number> };

export interface JudgeRequest {
  state: string;
  questions: Record<string, Question>;
  meta: CallMeta;
}

export interface JudgeResult {
  answers: Record<string, Answer>;
  usage: Usage;
  latencyMs: number;
  model: string;
}

export type Tier = "system1" | "system2";

export interface Judge {
  readonly id: string;
  readonly tier: Tier;
  readonly simulated: boolean;
  ask(req: JudgeRequest): Promise<JudgeResult>;
}

// ---------------------------------------------------------------- prompt conventions
// Mock providers parse these markers, so producers and consumers must use the constants.

export const QK = { claim: "claim", verify: "verify", adopt: "adopt" } as const;
export const MARK = {
  /** Line prefix carrying a proposed answer inside judge state or LLM output. */
  answer: "ANSWER:",
  /** Line prefix carrying a one-line method summary in LLM solve output. */
  method: "METHOD:",
  /** Line prefix naming the task domain inside judge state and solve prompts. */
  domain: "DOMAIN:",
  /** Line prefix carrying the cell's per-domain record inside claim state. */
  profile: "PROFILE:",
  /** Header before adopted strategy genes in a solve prompt. */
  strategy: "STRATEGY:",
  /** Header before a teammate's answer shown to a solver (echo path). */
  teammate: "TEAMMATE ANSWERED:",
  /** Header before System-2 precedents appended to System-1 state. */
  precedents: "PRECEDENTS:",
  /** Line prefix for a task id inside batched prompts (single / subagent). */
  taskId: "TASK",
} as const;
/** Choice key a claim decision uses to decline every candidate. */
export const NONE_CHOICE = "none";
/** Cells exchange bounded summaries, never full transcripts (EvoMap: ~550 tokens). */
export const SUMMARY_TOKEN_BUDGET = 550;

// ---------------------------------------------------------------- decisions

export interface Decision {
  id: string;
  runId: string;
  cellId?: string;
  taskId?: string;
  key: string;
  tier: Tier;
  escalated: boolean;
  answer: Answer;
  confidence: number;
  latencyMs: number;
  usage: Usage;
  precedentsUsed: number;
  at: number;
}

export interface Precedent {
  key: string;
  state: string;
  verdict: Answer;
  at: number;
}

export interface PrecedentStore {
  add(p: Precedent): void;
  /** Most recent k precedents for this key, newest last. */
  relevant(key: string, k: number): Precedent[];
  size(key?: string): number;
}

/** Outcome known only after the fact (acceptance or ground truth), used for calibration plots. */
export interface CalibrationSample {
  key: string;
  predicted: number;
  outcome: boolean;
}

export interface CalibrationBin {
  lo: number;
  hi: number;
  count: number;
  meanPredicted: number;
  observedRate: number;
}

// ---------------------------------------------------------------- blackboard

export type TaskStatus = "open" | "claimed" | "verifying" | "accepted" | "failed";

export interface Proposal {
  /** Also the lineage node id. */
  id: string;
  taskId: string;
  cellId: string;
  answer: string;
  summary: string;
  at: number;
}

export interface TaskEntry {
  task: PublicTask;
  status: TaskStatus;
  claimedBy?: string;
  leaseUntil?: number;
  attempts: number;
  proposals: Proposal[];
  /** Cells that already proposed; a verifier must not be one of them. */
  proposers: string[];
  acceptedAnswer?: string;
  acceptedProposalIds?: string[];
  independentSources?: number;
}

export interface Blackboard {
  /** Entries claimable now: status open, or verifying with no active claim. */
  claimable(now: number): TaskEntry[];
  get(taskId: string): TaskEntry | undefined;
  all(): TaskEntry[];
  /**
   * Atomic. Succeeds on an open task, on a verifying task with no live lease whose proposers
   * exclude this cell, or on a task whose lease has expired. Increments attempts on success.
   */
  claim(taskId: string, cellId: string, now: number): boolean;
  renew(taskId: string, cellId: string, now: number): boolean;
  /** Drops the cell's claim: claimed -> open (or verifying if proposals exist); verifying stays verifying. */
  release(taskId: string, cellId: string): void;
  /**
   * Records a proposal and adds the cell to proposers. The proposer KEEPS its lease until it calls
   * accept, requestVerification or release, so a cell dying mid-decision still lets sweep() recover the task.
   */
  propose(p: Proposal): void;
  /** Moves the task to verifying and clears the claim so a different cell re-solves it. */
  requestVerification(taskId: string): void;
  accept(taskId: string, answer: string, proposalIds: string[], independentSources: number): void;
  fail(taskId: string): void;
  /**
   * Clears expired leases: claimed -> open (or verifying if proposals exist); verifying stays verifying.
   * Returns the affected task ids.
   */
  sweep(now: number): string[];
  done(): boolean;
  /** Deterministic merge keyed by task id; no LLM rewrites answers. */
  results(): Map<string, string>;
}

// ---------------------------------------------------------------- lineage

export type NodeKind = "task" | "proposal" | "gene" | "message";

export interface LineageNode {
  id: string;
  kind: NodeKind;
  cellId?: string;
  taskId?: string;
  /**
   * For a proposal: the task node plus any other proposals it SAW before answering.
   * Genes a solver used are NOT parents: strategies are not evidence about an answer.
   */
  parents: string[];
  at: number;
}

export interface Lineage {
  /** Throws if any parent is unknown, which keeps the graph acyclic by construction. */
  add(node: LineageNode): void;
  get(id: string): LineageNode | undefined;
  /**
   * Original evidence sources. A node with no cell-produced parents is its own root;
   * otherwise its roots are the union of its cell-produced parents' roots. Task nodes never count.
   */
  roots(id: string): Set<string>;
  /** Groups ids whose root sets intersect (transitively) and returns the group count. */
  independentSources(ids: string[]): number;
  /** True if some proper ancestor of `id` was produced by `cellId` (information returning home). */
  isRecollision(id: string, cellId: string): boolean;
}

// ---------------------------------------------------------------- genes

export interface Gene {
  id: string;
  kind: "solve";
  domain: Domain;
  text: string;
  origin: string;
  /** Lineage node id of the gene. */
  lineageId: string;
  wins: number;
  trials: number;
  createdAt: number;
}

export interface GenePool {
  list(): Gene[];
  has(id: string): boolean;
  /** Adds (or keeps) a gene; if over capacity, evicts the lowest-fitness gene and returns it. */
  add(g: Gene): Gene | undefined;
  best(domain?: Domain): Gene | undefined;
  record(geneId: string, success: boolean): void;
  fitness(g: Gene): number;
}

// ---------------------------------------------------------------- ledger

export type ProviderKind = "jev" | "llm" | "mock-llm" | "mock-judge";

export interface LedgerEntry {
  runId: string;
  at: number;
  provider: ProviderKind;
  model: string;
  purpose: Purpose;
  tier?: Tier;
  cellId?: string;
  taskId?: string;
  usage: Usage;
  latencyMs: number;
}

export interface Totals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  latencyMs: number;
}

export interface Ledger {
  record(e: LedgerEntry): void;
  entries(): LedgerEntry[];
  totals(filter?: (e: LedgerEntry) => boolean): Totals;
  byPurpose(): Partial<Record<Purpose, Totals>>;
}

// ---------------------------------------------------------------- metrics & events

export type CellState = "idle" | "claiming" | "solving" | "verifying" | "gossiping" | "dead";

export interface LiveMetrics {
  tasksTotal: number;
  accepted: number;
  correct: number;
  /** correct / tasksTotal (unaccepted tasks count as wrong). */
  accuracy: number;
  totalTokens: number;
  workTokens: number;
  coordinationTokens: number;
  costUsd: number;
  /** Agent Intelligence Ratio: correct answers per 1k total tokens. */
  air: number;
  s1Decisions: number;
  s2Decisions: number;
  /** Share of decisions that ended at System 2 (escalated or System-2-only). */
  escalationRate: number;
  meanJudgeLatencyMs: number;
  cellsAlive: number;
  reopened: number;
  echoAlarms: number;
  genesAdopted: number;
  elapsedMs: number;
}

export interface RunSummary {
  runId: string;
  mode: Mode;
  config: RunConfig;
  simulated: boolean;
  metrics: LiveMetrics;
  byPurpose: Partial<Record<Purpose, Totals>>;
  calibration: Record<string, CalibrationBin[]>;
  startedAt: number;
  finishedAt: number;
  aborted?: string;
}

interface Base {
  runId: string;
  at: number;
}

export type SwarmEvent =
  | (Base & { type: "run.started"; mode: Mode; config: RunConfig; simulated: boolean; tasks: PublicTask[] })
  | (Base & { type: "run.finished"; summary: RunSummary })
  | (Base & { type: "cell.spawned"; cellId: string; neighbors: string[] })
  | (Base & { type: "cell.state"; cellId: string; state: CellState; taskId?: string })
  | (Base & { type: "cell.killed"; cellId: string })
  | (Base & { type: "task.claimed"; taskId: string; cellId: string })
  | (Base & { type: "task.reopened"; taskId: string; previousCell?: string })
  | (Base & { type: "task.proposed"; taskId: string; cellId: string; proposalId: string; sawProposals: string[] })
  | (Base & { type: "task.verifying"; taskId: string; cellId: string })
  | (Base & {
      type: "task.accepted";
      taskId: string;
      answer: string;
      independentSources: number;
      /** Display-only: computed by the runner from ground truth after acceptance. */
      correct: boolean;
    })
  | (Base & { type: "task.failed"; taskId: string })
  | (Base & { type: "judge.decision"; decision: Decision })
  | (Base & { type: "gene.created"; geneId: string; cellId: string; domain: Domain; text: string })
  | (Base & { type: "gene.gossiped"; geneId: string; fromCell: string; toCell: string })
  | (Base & { type: "gene.adopted"; geneId: string; cellId: string })
  | (Base & { type: "gene.rejected"; geneId: string; cellId: string; reason: "judge" | "recollision" })
  | (Base & { type: "gene.forgotten"; geneId: string; cellId: string })
  | (Base & { type: "echo.detected"; taskId: string; proposalIds: string[]; agreeing: number; independentSources: number })
  | (Base & { type: "metrics"; metrics: LiveMetrics })
  | (Base & { type: "log"; level: "info" | "warn" | "error"; message: string });

export type SwarmEventType = SwarmEvent["type"];

export interface EventBus {
  emit(e: SwarmEvent): void;
  on(fn: (e: SwarmEvent) => void): () => void;
}

/** Thrown by metered providers once the run's cost cap is reached. */
export class BudgetExceededError extends Error {
  constructor(public readonly spentUsd: number, public readonly capUsd: number) {
    super(`cost cap reached: $${spentUsd.toFixed(4)} >= $${capUsd.toFixed(2)}`);
    this.name = "BudgetExceededError";
  }
}
