// Shared contract for every module. Change only with the integrator's agreement:
// parallel implementers code against this file.

// ---------------------------------------------------------------- run setup

/**
 * single: one context for all tasks. single-vote: each task solved independently k times, majority vote,
 * k sized to a token budget (the fair "same budget" baseline). subagent: workers + lossy coordinator merge.
 * swarm-llm / swarm-jev: judgment coordination by LLM vs Jev+escalation. swarm-rules: fixed rules, no judge.
 * swarm-solo: parallel claim + deterministic merge only (review and gene exchange off) = the "sum of singles".
 */
export type Mode = "single" | "single-vote" | "subagent" | "swarm-llm" | "swarm-jev" | "swarm-rules" | "swarm-solo";
export const MODES: readonly Mode[] = ["single", "single-vote", "subagent", "swarm-llm", "swarm-jev", "swarm-rules", "swarm-solo"];
export const SWARM_MODES: readonly Mode[] = ["swarm-llm", "swarm-jev", "swarm-rules", "swarm-solo"];

export type Domain = "arithmetic" | "rates" | "logic" | "gsm8k" | "research";

export type TaskSourceConfig =
  | { kind: "synthetic"; difficulty?: "normal" | "hard" }
  | { kind: "gsm8k"; path: string }
  /** An idea decomposed by an LLM planner into verifiable claims, plus canary claims of known truth. */
  | { kind: "research"; idea: string; claims: number; canaries: number };

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
  /** Model for System-2 judgments (review, adoption, disputes); empty: the solving model. Solving is unchanged. */
  judgeModel: string;
  /**
   * Multiplier applied to simulated provider latency (1 = default fast simulation; e.g. 10 makes mock LLM
   * solves ~0.6-1.8 s). Real providers ignore it.
   */
  /**
   * Reasoning pass of real LLM calls. off: answer directly (fast, error-prone individuals: the setting where
   * collaboration has room to matter); low: a short reasoning pass; default: whatever the model does.
   */
  llmReasoning: "default" | "off" | "low";
  simPace: number;
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
  /** rule: zero-token atomic claim by priority (default). judge: ask the judge which task to claim. */
  claimPolicy: "rule" | "judge";
  /** Probability that a lone low-risk proposal is still re-solved (random audit). */
  auditRate: number;
  /** A cell's first N proposals are always reviewed (probation). */
  probation: number;
  /** Proposals from cells below this trust are always reviewed. */
  reviewTrust: number;
  /** Below this trust, after >= probation judged proposals, a cell is quarantined. */
  quarantineTrust: number;
  /** Failed reviews on one task before it counts as stuck (triggers library / EvoMap lookup). */
  stuckAfter: number;
  /** Calibration guard: rolling window of escalated System-1 answers per key... */
  guardWindow: number;
  /** ...if System 1 disagreed with System 2 on more than this share, the key goes straight to System 2. */
  guardMaxDisagreement: number;
  /** Load the persistent experience library at start and publish verified experience at the end. */
  inherit: boolean;
  /** Search EvoMap's public gene catalog when a task is stuck. */
  evomapLookup: boolean;
  /** Publish genes that pass the holdout gate to EvoMap as Gene+Capsule+EvolutionEvent bundles. */
  evomapPublish: boolean;
  /** Fresh tasks per holdout A/B run for the publish gate. */
  publishGateTasks: number;
  /** Minimum extra correct answers (with gene minus without) required to publish. */
  publishGateMinDelta: number;
  /** LLM model per cell, assigned round-robin; empty means the default LLM_MODEL. */
  cellModels: string[];
  /** single-vote: target total tokens; 0 means a fixed k of 5 samples per task. */
  voteBudgetTokens: number;
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
  | "adjudicate"
  | "plan";
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

export const QK = { claim: "claim", verify: "verify", adopt: "adopt", dispute: "dispute" } as const;
/** Choice key a dispute decision uses when neither proposed answer is clearly right. */
export const UNCLEAR_CHOICE = "unclear";
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
  /** Pending precedent created by this System-2 verdict (confirmed or rejected once the outcome is known). */
  precedentId?: string;
  /** System 2 failed and a conservative default was used. */
  fallback?: boolean;
  /** System 1 was skipped because the calibration guard routed this key to System 2. */
  guarded?: boolean;
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
  /** Adds an unconfirmed precedent; relevant() ignores it until confirm(). Returns its id. */
  propose(p: Precedent): string;
  confirm(id: string): void;
  reject(id: string): void;
  /** Confirmed precedents, oldest first (for persisting to the experience library). */
  all(): Precedent[];
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
  /** Among non-escalated System-1 "no review needed" verify decisions: share whose answer was actually wrong. */
  passThroughErrorRate: number;
  /** Accepted answers that are wrong / accepted. */
  falseAcceptRate: number;
  /** Among accepted answers with >= 2 independent sources: share that are wrong (correlated errors). */
  falseAcceptVerifiedRate: number;
  coordinationShare: number;
  quarantined: number;
  libraryHits: number;
  inheritedGenes: number;
  jevDown: boolean;
  /** False for research runs: only canary claims have ground truth. */
  accuracyApplicable: boolean;
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
  | (Base & {
      type: "gene.rejected";
      geneId: string;
      cellId: string;
      /** rule: the receiver already holds a proven gene for the domain, so no judgment was spent. */
      reason: "judge" | "recollision" | "sanitize" | "untrusted" | "rule";
    })
  | (Base & { type: "gene.forgotten"; geneId: string; cellId: string })
  | (Base & { type: "echo.detected"; taskId: string; proposalIds: string[]; agreeing: number; independentSources: number })
  | (Base & { type: "metrics"; metrics: LiveMetrics })
  | (Base & { type: "log"; level: "info" | "warn" | "error"; message: string })
  | (Base & { type: "protocol.message"; message: ProtocolMessage })
  | (Base & { type: "cell.card"; card: CapabilityCard })
  | (Base & { type: "cell.quarantined"; cellId: string; trust: number; reason: string })
  /** Demo ground truth for the dashboard; the swarm itself is never told. */
  | (Base & { type: "cell.compromised"; cellId: string })
  | (Base & { type: "permission.denied"; cellId: string; action: string; reason: string })
  | (Base & { type: "provider.fault"; provider: "jev" | "llm"; down: boolean })
  | (Base & { type: "judge.guard"; key: string; disagreement: number; window: number })
  | (Base & { type: "library.loaded"; genes: number; precedents: number })
  | (Base & { type: "library.hit"; cellId: string; taskId: string; source: "local" | "evomap"; geneIds: string[]; titles: string[] })
  | (Base & {
      type: "library.published";
      genes: number;
      precedents: number;
      gate: Array<{ geneId: string; withGene: number; withoutGene: number; tasks: number; passed: boolean }>;
      evomap?: { assetIds: string[]; urls: string[]; status: string };
    })
  | (Base & { type: "link.formed"; from: string; to: string; reason: "gossip" | "review" | "discover" })
  | (Base & { type: "research.report"; report: ResearchReport })

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

// ---------------------------------------------------------------- v2: protocol, registry, trust, library, research

/** What an agent publishes about itself so others can discover it. No central scheduler reads this. */
export interface CapabilityCard {
  agentId: string;
  model: string;
  domains: Partial<Record<Domain, { wins: number; trials: number }>>;
  /** Short gists of the strategy genes it holds. */
  genes: string[];
  trust: number;
  status: "active" | "quarantined" | "dead";
  joinedAt: number;
  lastSeen: number;
}

export type ProtocolType =
  | "ANNOUNCE"
  | "HEARTBEAT"
  | "DISCOVER"
  | "CLAIM"
  | "PROPOSE"
  | "REVIEW_REQUEST"
  | "ACCEPT"
  | "ECHO_ALARM"
  | "GENE_OFFER"
  | "GENE_ADOPT"
  | "GENE_REJECT"
  | "LIBRARY_QUERY"
  | "LIBRARY_RESULT"
  | "QUARANTINE"
  | "DENIED";

/** Transport-agnostic envelope; the in-process bus and a future WebSocket binding carry the same JSON. */
export interface ProtocolMessage {
  v: 1;
  id: string;
  runId: string;
  type: ProtocolType;
  from: string;
  /** An agent id, "*" (broadcast), or a shared service: "board" | "registry" | "library". */
  to: string;
  /** Lineage node ids this message is derived from. */
  parents: string[];
  at: number;
  body: Record<string, unknown>;
}

export interface AgentRegistry {
  announce(card: CapabilityCard): void;
  update(agentId: string, patch: Partial<Omit<CapabilityCard, "agentId">>): CapabilityCard | undefined;
  get(agentId: string): CapabilityCard | undefined;
  list(): CapabilityCard[];
  /** Active cards ranked by smoothed win rate in the domain (if given), then trust; excludes ids. */
  discover(q: { domain?: Domain; exclude?: string[]; limit: number }): CapabilityCard[];
}

export interface TrustLedger {
  get(agentId: string): number;
  judged(agentId: string): number;
  /** Records whether the agent's proposal agreed with the accepted answer; returns the new trust. */
  record(agentId: string, agreed: boolean): number;
}

export interface LibraryGene extends Gene {
  source: "local" | "evomap";
  runId?: string;
  /** EvoMap asset id when the gene came from (or was published to) EvoMap. */
  assetId?: string;
  evidence: { wins: number; trials: number; independentSources?: number };
}

export interface ExperienceLibrary {
  load(): Promise<{ genes: number; precedents: number }>;
  genes(domain?: Domain): LibraryGene[];
  precedents(): Precedent[];
  /** Best genes for a domain by evidence (smoothed win rate), at most k. */
  search(domain: Domain, k: number): LibraryGene[];
  publish(genes: LibraryGene[], precedents: Precedent[]): Promise<{ genes: number; precedents: number }>;
  reset(): Promise<void>;
  stats(): { genes: number; precedents: number };
}

export type ResearchVerdict = "supported" | "refuted" | "uncertain";

export interface ResearchClaimResult {
  taskId: string;
  claim: string;
  /** Known truth for canary claims; absent for claims derived from the idea. */
  canary?: ResearchVerdict;
  verdict: ResearchVerdict | "unresolved";
  independentSources: number;
  proposals: number;
  dissent: number;
}

export interface ResearchReport {
  idea: string;
  claims: ResearchClaimResult[];
  canaryPassed: number;
  canaryTotal: number;
  recommendation: "continue" | "abandon" | "inconclusive";
  /** The deterministic rule that produced the recommendation, in plain words. */
  rule: string;
}
