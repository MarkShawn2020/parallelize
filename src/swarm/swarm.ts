import { hashString, seededShuffle, sleep, unit } from "../core/rng";
import { BudgetExceededError, QK } from "../core/types";
import type {
  AgentRegistry,
  Answer,
  Blackboard,
  CallMeta,
  CapabilityCard,
  CellState,
  Domain,
  EventBus,
  ExperienceLibrary,
  Gene,
  Judge,
  LibraryGene,
  Lineage,
  LLM,
  Proposal,
  ProtocolMessage,
  PublicTask,
  Question,
  RunConfig,
  SwarmEvent,
  TaskEntry,
  TrustLedger,
} from "../core/types";
import { buildDisputeState, disputeQuestion, disputeWinner } from "../judge/dispute";
import { createCellHandle, taskNodeId } from "../protocol/handle";
import type { CellHandle, TaskView } from "../protocol/handle";
import { BROADCAST, createMessage, SERVICE } from "../protocol/messages";
import { MemoryRegistry, shortModel, smoothedRate } from "../protocol/registry";
import { extractFinalAnswer, normalizeAnswer } from "../tasks/check";
import { corruptAnswer, forgedProposalAttempt, poisonedGene } from "./adversary";
import {
  adoptQuestion,
  buildAdoptState,
  buildClaimState,
  buildGenePrompt,
  buildSolvePrompt,
  buildVerifyState,
  Cell,
  claimOrder,
  claimQuestion,
  GENE_SYSTEM,
  geneText,
  methodSummary,
  ruleClaimOrder,
  SOLVE_SYSTEM,
  VERIFY_QUESTION,
} from "./cell";
import { adoptCopy, createGene, provenGeneBlocks } from "./genes";
import { disputeVerdictConfirmed, isDisagreement, resolveAfterProposal, scoreGroups, verifyVerdictConfirmed } from "./resolve";
import type { Resolution, ScoredGroup } from "./resolve";
import { sanitizeGeneText } from "./sanitize";
import { buildTopology } from "./topology";
import { BetaTrust, reviewReason, shouldQuarantine } from "./trust";

/** A SwarmEvent without the envelope fields the emitter fills in. */
export type EventBody = {
  [K in SwarmEvent["type"]]: Omit<Extract<SwarmEvent, { type: K }>, "runId" | "at">;
}[SwarmEvent["type"]];

/** The run layer adapts EvoMapClient.search + hitToLibraryGene to this; it must never throw for "no hits". */
export interface EvoMapLookup {
  /** `domain` is the stuck task's: EvoMap hits carry none, and the swarm files adopted genes under it. */
  search(query: string, domain: Domain): Promise<LibraryGene[]>;
}

export interface SwarmDeps {
  runId: string;
  config: RunConfig;
  tasks: PublicTask[];
  /** Metered. The LLM of every cell that has no model-specific one. */
  llm: LLM;
  /** Metered LLM for a model name; used for config.cellModels (round-robin at start). */
  llmFor?: (model: string) => LLM;
  /** Card label of `llm` (default: llm.id). */
  defaultModel?: string;
  /**
   * Required by swarm-llm (observed System 2) and swarm-jev (escalating). Never called by swarm-rules or
   * swarm-solo. For precedent confirmation it must report its Decisions as judge.decision events on `bus`
   * synchronously, before ask() resolves (run.ts's onDecision does).
   */
  judge?: Judge;
  bus: EventBus;
  lineage: Lineage;
  board: Blackboard;
  registry?: AgentRegistry;
  trust?: TrustLedger;
  /** Read-only here: searched when a task is stuck. The run layer loads and publishes it. */
  library?: ExperienceLibrary;
  evomap?: EvoMapLookup;
  /** Library genes to seed cells with at start (config.inherit); ignored by swarm-solo. */
  inheritedGenes?: LibraryGene[];
  /** Routes a pending precedent's outcome to the PrecedentStore (confirm / reject). */
  onPrecedentOutcome?: (precedentId: string, confirmed: boolean) => void;
  /** Label only: the fault switch itself wraps the providers. */
  jevDown?: () => boolean;
  /** Research runs pass extractVerdict / normalizeResearchAnswer. */
  extract?: (text: string) => string;
  normalize?: (s: string) => string;
  now?: () => number;
  /** Display-only ground-truth check injected by the runner; it never feeds a decision. */
  isCorrect?: (taskId: string, answer: string) => boolean;
}

export interface SwarmStats {
  reopened: number;
  echoAlarms: number;
  genesAdopted: number;
  quarantined: number;
  libraryHits: number;
  inheritedGenes: number;
}

type ReviewTag = "judge" | "probation" | "audit" | "trust" | "echo" | "dispute";

interface EchoMark {
  /** Solves left that see the first proposal when no cells were named. */
  left: number;
  cells?: Set<string>;
  /** When the named cells' reservation started (first proposal present). */
  since?: number;
}

interface GeneInfo {
  gene: Gene;
  library?: LibraryGene;
  independentSources?: number;
}

const MAX_ATTEMPTS = 4;
const TICK_MS = 250;
const IDLE_MS = 150;
const RACE_BACKOFF_MS = 50;
const ERROR_BACKOFF_MS = 500;
const ECHO_SOLVES = 2;
// Named echo cells get the task to themselves for a while, so the echo shows up on stage within seconds.
const ECHO_RESERVE_MS = 5000;
const DECLINES_BEFORE_FORCE = 3;
const ADOPT_THRESHOLD = 0.5;

const DISPUTE_MIN_CONFIDENCE = 0.6;
const HEARTBEAT_MS = 5000;
const LIBRARY_K = 3;
const EVOMAP_PROMPT_CHARS = 80;
const INHERIT_PER_DOMAIN = 2;
const TITLE_CHARS = 60;
const SPAWN_LINKS = 2;
const STOP_GRACE_MS = 1000;
// Jev accepts at most 255 choice criteria, and the claim question always adds the "none" key.
const MAX_CANDIDATES = 254;

const DOMAIN_KEYWORDS: Record<Domain, string> = {
  arithmetic: "verify multi-step arithmetic by recomputing",
  rates: "rate time distance work problem units",
  logic: "logic puzzle case elimination",
  gsm8k: "grade school math word problem step by step",
  research: "evaluate a factual claim against evidence",
};

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const isTerminal = (e: TaskEntry): boolean => e.status === "accepted" || e.status === "failed";
const clip = (s: string, n: number): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};
// Origins from earlier runs name cells of those runs; prefixing keeps them from matching this run's cells.
const toGene = (g: LibraryGene, lineageId: string, now: number): Gene =>
  createGene({ id: g.id, domain: g.domain, text: g.text, origin: g.source === "evomap" ? "evomap" : `library:${g.origin}`, lineageId, now });

/**
 * Self-organising swarm: no scheduler assigns work. Cells claim by a zero-token rule through a
 * permission-scoped handle; the swarm acts only as the shared services (board, registry, library):
 * it reviews, accepts, raises echo alarms and quarantines. A judge answers only what rules cannot:
 * verify, adopt, dispute.
 */
export class Swarm {
  private readonly runId: string;
  private readonly config: RunConfig;
  private readonly tasks: PublicTask[];
  private readonly defaultLLM: LLM;
  private readonly llmFor: ((model: string) => LLM) | undefined;
  private readonly defaultModel: string;
  private readonly judge: Judge | undefined;
  private readonly bus: EventBus;
  private readonly lineage: Lineage;
  private readonly board: Blackboard;
  private readonly registry: AgentRegistry;
  private readonly trust: TrustLedger;
  private readonly library: ExperienceLibrary | undefined;
  private readonly evomap: EvoMapLookup | undefined;
  private readonly onPrecedentOutcome: (precedentId: string, confirmed: boolean) => void;
  private readonly jevDown: (() => boolean) | undefined;
  private readonly extract: (text: string) => string;
  private readonly normalize: (s: string) => string;
  private readonly now: () => number;
  private readonly isCorrect: (taskId: string, answer: string) => boolean;
  private readonly usesJudge: boolean;
  /** swarm-solo is the "sum of singles": no review, no genes, no library. */
  private readonly learns: boolean;
  private readonly reviews: boolean;
  private readonly tag: string;

  private readonly cells = new Map<string, Cell>();
  private readonly handles = new Map<string, CellHandle>();
  private readonly llms = new Map<string, LLM>();
  private readonly echo = new Map<string, EchoMark>();
  /** proposalId -> gene the solver used, credited once the task is accepted. */
  private readonly proposalGene = new Map<string, string>();
  private readonly genes = new Map<string, GeneInfo>();
  private readonly geneEvidence = new Map<string, { wins: number; trials: number }>();
  private readonly poisonGenes = new Set<string>();
  private readonly penalizedGenes = new Set<string>();
  private readonly inheritSelection: LibraryGene[];
  private readonly reviewed = new Set<string>();
  private readonly failedReviews = new Map<string, number>();
  private readonly consulted = new Set<string>();
  private readonly linked = new Set<string>();
  /** "key|cellId|taskId" -> pending precedent ids reported by the judge, oldest first. */
  private readonly pendingDecisions = new Map<string, string[]>();
  private readonly verifyVerdicts = new Map<string, { id: string; reSolve: boolean; answer: string }>();
  private readonly disputeVerdicts = new Map<string, Array<{ id: string; chosen?: string; candidates: string[] }>>();
  /** "cellId|geneId" -> adopt precedent, settled by the gene's next use. */
  private readonly adoptVerdicts = new Map<string, string>();
  private readonly background = new Set<Promise<void>>();
  private readonly counters: SwarmStats = { reopened: 0, echoAlarms: 0, genesAdopted: 0, quarantined: 0, libraryHits: 0, inheritedGenes: 0 };
  private seq = 0;
  private lastJevDown = false;
  private started = false;
  private stopped = false;
  private reason: string | undefined;
  private resolveFinished: () => void = () => {};
  private readonly finished: Promise<void>;

  constructor(deps: SwarmDeps) {
    const { config } = deps;
    this.runId = deps.runId;
    this.config = config;
    this.tasks = deps.tasks;
    this.defaultLLM = deps.llm;
    this.llmFor = deps.llmFor;
    this.defaultModel = deps.defaultModel ?? deps.llm.id;
    this.usesJudge = config.mode === "swarm-llm" || config.mode === "swarm-jev";
    if (this.usesJudge && !deps.judge) throw new Error(`${config.mode} needs a judge`);
    this.judge = this.usesJudge ? deps.judge : undefined;
    this.learns = config.mode !== "swarm-solo";
    this.reviews = config.mode !== "swarm-solo";
    this.bus = deps.bus;
    this.lineage = deps.lineage;
    this.board = deps.board;
    this.registry = deps.registry ?? new MemoryRegistry();
    this.trust = deps.trust ?? new BetaTrust();
    this.library = this.learns ? deps.library : undefined;
    this.evomap = this.learns && config.evomapLookup ? deps.evomap : undefined;
    this.onPrecedentOutcome = deps.onPrecedentOutcome ?? (() => {});
    this.jevDown = deps.jevDown;
    this.extract = deps.extract ?? extractFinalAnswer;
    this.normalize = deps.normalize ?? normalizeAnswer;
    this.now = deps.now ?? Date.now;
    this.isCorrect = deps.isCorrect ?? (() => false);
    this.tag = hashString(deps.runId).toString(36).slice(0, 4);
    this.inheritSelection = this.learns ? selectInherited(deps.inheritedGenes ?? [], deps.tasks) : [];
    this.finished = new Promise((resolve) => {
      this.resolveFinished = resolve;
    });

    const at = this.now();
    for (const t of deps.tasks) {
      if (!this.lineage.get(taskNodeId(t.id))) this.lineage.add({ id: taskNodeId(t.id), kind: "task", taskId: t.id, parents: [], at });
    }
    const ids = Array.from({ length: config.cells }, (_, i) => cellName(i + 1));
    const topology = buildTopology(ids, config.topology, config.seed);
    ids.forEach((id, i) => {
      const model = config.cellModels.length > 0 ? (config.cellModels[i % config.cellModels.length] ?? this.defaultModel) : this.defaultModel;
      const llm = config.cellModels.length > 0 && this.llmFor ? this.llmFor(model) : this.defaultLLM;
      this.addCell(id, topology.get(id) ?? [], model, llm);
    });
  }

  /** Resolves when every task is settled, stop() is called, the wall clock or budget runs out, or no cell can work. */
  async start(): Promise<void> {
    if (this.started) throw new Error("swarm already started");
    this.started = true;
    const unsubscribe = this.bus.on((e) => this.observe(e));
    for (const c of this.cells.values()) this.emit({ type: "cell.spawned", cellId: c.id, neighbors: [...c.neighbors] });
    for (const c of this.cells.values()) this.join(c);
    if (this.inheritSelection.length > 0) {
      this.counters.inheritedGenes = this.inheritSelection.length;
      this.log("info", `inherited ${this.inheritSelection.length} genes from the experience library`);
    }

    const ticker = setInterval(() => this.tick(), TICK_MS);
    const wall = setTimeout(() => this.stop("wall-clock"), this.config.maxWallMs);
    for (const c of this.cells.values()) this.track(this.runCell(c));
    this.tick();
    await this.finished;
    clearInterval(ticker);
    clearTimeout(wall);
    await settleWithin([...this.background], STOP_GRACE_MS);
    unsubscribe();
  }

  stop(reason = "stopped"): void {
    if (this.stopped) return;
    this.stopped = true;
    this.reason = reason;
    this.resolveFinished();
  }

  kill(cellId?: string): string {
    const alive = [...this.cells.values()].filter((c) => c.alive);
    if (alive.length === 0) throw new Error("no live cells to kill");
    let target: Cell | undefined;
    if (cellId !== undefined) {
      target = this.cells.get(cellId);
      if (!target) throw new Error(`unknown cell ${cellId}`);
      if (!target.alive) throw new Error(`cell ${cellId} is already dead`);
    } else {
      // Prefer a cell holding a claim so the kill demonstrates lease-based recovery.
      const working = alive.filter((c) => c.working);
      const busy = working.filter((c) => c.taskId !== undefined);
      const pool = busy.length > 0 ? busy : working.length > 0 ? working : alive;
      target = pool[Math.floor(unit(this.runId, "kill", this.seq++) * pool.length)] ?? alive[0];
    }
    if (!target) throw new Error("no live cells to kill");
    target.alive = false;
    target.state = "dead";
    this.emit({ type: "cell.killed", cellId: target.id });
    this.emit({ type: "cell.state", cellId: target.id, state: "dead" });
    this.publishCard(target, { status: "dead" });
    return target.id;
  }

  /**
   * Forces false consensus on one task. With cellIds, exactly those cells see the first proposal (and
   * get the task reserved for a few seconds); without, the next two solvers do.
   */
  injectEcho(taskId?: string, cellIds: string[] = []): string {
    for (const id of cellIds) {
      const c = this.cells.get(id);
      if (!c) throw new Error(`unknown cell ${id}`);
      if (!c.working) throw new Error(`cell ${id} is not active`);
    }
    const entry = taskId !== undefined ? this.board.get(taskId) : this.echoCandidate(cellIds);
    if (!entry) throw new Error(taskId !== undefined ? `unknown task ${taskId}` : "no task available for echo injection");
    if (isTerminal(entry)) throw new Error(`task ${entry.task.id} is already settled`);
    const id = entry.task.id;
    const targets = cellIds.filter((c) => !entry.proposers.includes(c));
    if (cellIds.length > 0 && targets.length === 0) throw new Error(`the selected cells already proposed on ${id}`);

    const first = this.validProposals(entry).find((p) => this.normalize(p.answer) !== "");
    this.echo.set(
      id,
      targets.length > 0
        ? { left: targets.length, cells: new Set(targets), ...(first ? { since: this.now() } : {}) }
        : { left: ECHO_SOLVES },
    );
    if (first && entry.status !== "verifying") this.requestReview(id, first.cellId, "echo", false);
    const who = targets.length > 0 ? targets.join(", ") : `the next ${ECHO_SOLVES} solvers`;
    this.log("info", first ? `echo injected on ${id}: ${who} see ${first.cellId}'s answer` : `echo injected on ${id}: once it has a proposal, ${who} see it`);
    return id;
  }

  /** Plug-and-play: a new cell with its own model joins the running swarm, announces itself and starts claiming. */
  spawn(opts: { model: string; llm: LLM }): string {
    if (!this.started || this.stopped) throw new Error("swarm is not running");
    const id = cellName(Math.max(0, ...[...this.cells.keys()].map((k) => Number(k.slice(1)) || 0)) + 1);
    const working = this.workingCells();
    const neighbors = pickLinks(working.map((c) => c.id), SPAWN_LINKS, unit(this.runId, "spawn", id));
    for (const n of neighbors) this.cells.get(n)?.neighbors.push(id);
    const cell = this.addCell(id, neighbors, opts.model, opts.llm);
    this.emit({ type: "cell.spawned", cellId: id, neighbors: [...neighbors] });
    this.join(cell);

    const peers = this.registry.discover({ exclude: [id], limit: SPAWN_LINKS + 1 }).map((c) => c.agentId);
    this.message({ type: "DISCOVER", from: SERVICE.registry, to: id, body: { limit: SPAWN_LINKS + 1, exclude: [id], agents: peers } });
    for (const p of peers) this.link(id, p, "discover");
    this.log("info", `${id} joined with ${shortModel(opts.model)}`);
    this.track(this.runCell(cell));
    return id;
  }

  /** Demo: the cell turns adversarial. Only the dashboard is told; the swarm must catch it from behaviour. */
  compromise(cellId?: string): string {
    const working = this.workingCells();
    let target: Cell | undefined;
    if (cellId !== undefined) {
      target = this.cells.get(cellId);
      if (!target) throw new Error(`unknown cell ${cellId}`);
      if (!target.working) throw new Error(`cell ${cellId} is not active`);
    } else {
      const honest = working.filter((c) => !c.compromised);
      const pool = honest.length > 0 ? honest : working;
      target = pool[Math.floor(unit(this.runId, "compromise", this.seq++) * pool.length)];
    }
    if (!target) throw new Error("no active cell to compromise");
    if (!target.compromised) {
      target.compromised = true;
      this.emit({ type: "cell.compromised", cellId: target.id });
    }
    return target.id;
  }

  /** Cells that can still work (alive and not quarantined). */
  aliveCount(): number {
    return this.workingCells().length;
  }

  stats(): SwarmStats {
    return { ...this.counters };
  }

  cards(): CapabilityCard[] {
    return this.registry.list();
  }

  abortReason(): string | undefined {
    return this.reason;
  }

  /**
   * Genes created or used in this run with THIS run's evidence (deltas, as the library merge expects).
   * Poisoned genes and genes from quarantined cells are left out; callers may drop zero-trial genes.
   */
  experience(): LibraryGene[] {
    const out: LibraryGene[] = [];
    for (const [id, info] of this.genes) {
      if (this.poisonGenes.has(id) || this.cells.get(info.gene.origin)?.quarantined) continue;
      const ev = this.geneEvidence.get(id) ?? { wins: 0, trials: 0 };
      const sources = info.independentSources !== undefined ? { independentSources: info.independentSources } : {};
      out.push(
        info.library
          ? { ...info.library, wins: ev.wins, trials: ev.trials, evidence: { ...ev } }
          : { ...info.gene, wins: ev.wins, trials: ev.trials, source: "local", runId: this.runId, evidence: { ...ev, ...sources } },
      );
    }
    return out;
  }

  // ---------------------------------------------------------------- services: bookkeeping

  private addCell(id: string, neighbors: string[], model: string, llm: LLM): Cell {
    const cell = new Cell(id, neighbors, this.config.geneCapacity, model);
    this.cells.set(id, cell);
    this.llms.set(id, llm);
    this.handles.set(
      id,
      createCellHandle({
        agentId: id,
        runId: this.runId,
        board: this.board,
        registry: this.registry,
        lineage: this.lineage,
        emit: (e) => this.bus.emit(e),
        now: this.now,
        isRevoked: () => !cell.working,
        nextId: (prefix) => this.nextId(prefix),
      }),
    );
    this.seedInherited(cell);
    return cell;
  }

  private handleOf(cell: Cell): CellHandle {
    const h = this.handles.get(cell.id);
    if (!h) throw new Error(`no handle for ${cell.id}`);
    return h;
  }

  private llmOf(cell: Cell): LLM {
    return this.llms.get(cell.id) ?? this.defaultLLM;
  }

  private join(cell: Cell): void {
    const at = this.now();
    cell.lastBeat = at;
    this.handleOf(cell).announce({
      agentId: cell.id,
      model: cell.model,
      domains: {},
      genes: cell.geneGists(),
      trust: this.trust.get(cell.id),
      status: "active",
      joinedAt: at,
      lastSeen: at,
    });
  }

  /** The registry owns trust, status and domains; the swarm writes them as that service. */
  private publishCard(cell: Cell, extra: Partial<Pick<CapabilityCard, "status">> = {}): void {
    const card = this.registry.update(cell.id, {
      domains: cell.cardDomains(),
      genes: cell.geneGists(),
      trust: this.trust.get(cell.id),
      lastSeen: this.now(),
      ...extra,
    });
    if (card) this.emit({ type: "cell.card", card });
  }

  private observe(e: SwarmEvent): void {
    if (e.type !== "judge.decision" || e.runId !== this.runId || e.decision.precedentId === undefined) return;
    const d = e.decision;
    const key = decisionKey(d.key, d.cellId, d.taskId);
    const queue = this.pendingDecisions.get(key);
    if (queue) queue.push(e.decision.precedentId as string);
    else this.pendingDecisions.set(key, [e.decision.precedentId as string]);
  }

  private takePrecedent(key: string, meta: CallMeta): string | undefined {
    const k = decisionKey(key, meta.cellId, meta.taskId);
    const queue = this.pendingDecisions.get(k);
    const id = queue?.shift();
    if (queue && queue.length === 0) this.pendingDecisions.delete(k);
    return id;
  }

  private async ask(key: string, question: Question, state: string, meta: CallMeta): Promise<{ answer?: Answer; precedentId?: string }> {
    if (!this.judge) return {};
    const r = await this.judge.ask({ state, questions: { [key]: question }, meta });
    const answer = r.answers[key];
    const precedentId = this.takePrecedent(key, meta);
    return { ...(answer ? { answer } : {}), ...(precedentId !== undefined ? { precedentId } : {}) };
  }

  private tick(): void {
    if (this.stopped) return;
    this.sweep();
    if (this.board.done()) {
      this.finish();
      return;
    }
    const working = this.workingCells();
    if (working.length === 0) {
      this.stop("all cells dead");
      return;
    }
    // A task whose every working cell already proposed can never get an independent verifier.
    for (const e of this.board.claimable(this.now())) {
      if (e.proposals.length > 0 && working.every((c) => e.proposers.includes(c.id))) this.resolveExhausted(e.task.id);
    }
    const at = this.now();
    for (const c of working) {
      if (at - c.lastBeat < HEARTBEAT_MS) continue;
      c.lastBeat = at;
      this.handleOf(c).heartbeat(c.taskId !== undefined ? { state: c.state, taskId: c.taskId } : { state: c.state });
    }
    const down = this.jevDown?.() ?? false;
    if (down !== this.lastJevDown) {
      this.lastJevDown = down;
      this.log("warn", down ? "Jev offline: System-1 judgments degrade to System 2" : "Jev back online: System 1 answers first again");
    }
  }

  /** Reopens expired leases. Cells also call it before claiming, so every recovery is counted. */
  private sweep(): void {
    const holders = new Map<string, string>();
    for (const e of this.board.all()) if (e.claimedBy !== undefined) holders.set(e.task.id, e.claimedBy);
    for (const taskId of this.board.sweep(this.now())) {
      this.counters.reopened++;
      const previousCell = holders.get(taskId);
      this.emit(previousCell ? { type: "task.reopened", taskId, previousCell } : { type: "task.reopened", taskId });
    }
  }

  private finish(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.resolveFinished();
  }

  private isActive(cell: Cell): boolean {
    return !this.stopped && cell.working && !this.board.done();
  }

  private workingCells(): Cell[] {
    return [...this.cells.values()].filter((c) => c.working);
  }

  private canVerify(entry: TaskEntry): boolean {
    return this.workingCells().some((c) => !entry.proposers.includes(c.id));
  }

  /** Proposals from quarantined cells carry no weight in any resolution. */
  private validProposals(entry: TaskEntry): Proposal[] {
    return entry.proposals.filter((p) => !this.cells.get(p.cellId)?.quarantined);
  }

  private emit(body: EventBody): void {
    this.bus.emit({ ...body, runId: this.runId, at: this.now() } as SwarmEvent);
  }

  private message(p: Omit<Parameters<typeof createMessage>[0], "runId" | "at">): ProtocolMessage {
    const message = createMessage({ ...p, runId: this.runId, at: this.now() });
    this.emit({ type: "protocol.message", message });
    return message;
  }

  private log(level: "info" | "warn" | "error", message: string): void {
    this.emit({ type: "log", level, message });
  }

  private link(from: string, to: string, reason: "gossip" | "review" | "discover"): void {
    if (reason === "discover") {
      const pair = from < to ? `${from}|${to}` : `${to}|${from}`;
      if (this.linked.has(pair)) return;
      this.linked.add(pair);
    }
    this.emit({ type: "link.formed", from, to, reason });
  }

  private setState(cell: Cell, state: CellState, taskId?: string): void {
    if (!cell.alive || (cell.state === state && cell.taskId === taskId)) return;
    cell.state = state;
    this.emit(taskId !== undefined ? { type: "cell.state", cellId: cell.id, state, taskId } : { type: "cell.state", cellId: cell.id, state });
  }

  private nextId(prefix: string): string {
    this.seq++;
    return `${prefix}${String(this.seq).padStart(4, "0")}`;
  }

  /** Gene ids outlive the run in the experience library, so they carry a run tag. */
  private geneId(): string {
    return `${this.nextId("g")}-${this.tag}`;
  }

  private track(p: Promise<void>): void {
    this.background.add(p);
    void p.finally(() => this.background.delete(p));
  }

  /** false = the swarm must stop. */
  private handleError(cell: Cell, err: unknown): boolean {
    if (err instanceof BudgetExceededError) {
      this.log("warn", `budget reached: ${err.message}`);
      this.stop("budget");
      return false;
    }
    if (!this.stopped) this.log("warn", `${cell.id}: ${errorMessage(err)}`);
    return true;
  }

  // ---------------------------------------------------------------- cell loop

  private async runCell(cell: Cell): Promise<void> {
    while (this.isActive(cell)) {
      try {
        await this.flushGenes(cell);
        if (!this.isActive(cell)) break;
        this.maybeGossip(cell);
        await this.step(cell);
      } catch (err) {
        if (!this.handleError(cell, err)) break;
        await sleep(ERROR_BACKOFF_MS);
      }
    }
  }

  private async step(cell: Cell): Promise<void> {
    this.sweep();
    if (cell.compromised && !cell.forgeryTried) this.tryForgery(cell);
    const { views, preferred } = this.claimableFor(cell);
    if (views.length === 0) {
      this.setState(cell, "idle");
      await sleep(IDLE_MS + Math.floor(50 * unit(cell.id, "idle", cell.ticks++)));
      return;
    }
    const order = this.config.claimPolicy === "judge" && this.judge ? await this.judgeClaimOrder(cell, views) : this.ruleOrder(cell, views, preferred);
    if (!this.isActive(cell)) return;
    if (order.length === 0) {
      this.setState(cell, "idle");
      await sleep(IDLE_MS);
      return;
    }
    const handle = this.handleOf(cell);
    for (const { taskId, rule } of order) {
      if (handle.claim(taskId, rule)) {
        await this.work(cell, taskId);
        return;
      }
    }
    await sleep(RACE_BACKOFF_MS);
  }

  /** The handle's public view minus tasks reserved for other cells' echo; tasks reserved for this cell are preferred. */
  private claimableFor(cell: Cell): { views: TaskView[]; preferred: Set<string> } {
    const preferred = new Set<string>();
    const views = this.handleOf(cell)
      .claimable()
      .filter((v) => {
        const reserved = this.echoReservation(v.task.id);
        if (!reserved) return true;
        if (reserved.has(cell.id)) preferred.add(v.task.id);
        return reserved.has(cell.id);
      });
    return { views, preferred };
  }

  private echoReservation(taskId: string): Set<string> | undefined {
    const mark = this.echo.get(taskId);
    if (!mark?.cells || mark.since === undefined || this.now() - mark.since >= ECHO_RESERVE_MS) return undefined;
    const entry = this.board.get(taskId);
    const pending = [...mark.cells].filter((id) => this.cells.get(id)?.working && !entry?.proposers.includes(id));
    return pending.length > 0 ? new Set(pending) : undefined;
  }

  private ruleOrder(cell: Cell, views: TaskView[], preferred: Set<string>): Array<{ taskId: string; rule: string }> {
    return ruleClaimOrder(views, {
      model: cell.model,
      modelOf: (id) => this.cells.get(id)?.model,
      rate: (d) => cell.rate(d),
      preferred,
      seed: hashString(`${this.runId}|${cell.id}|${cell.ticks++}`),
    });
  }

  /** The round-1 claim, kept as the claimPolicy "judge" ablation. */
  private async judgeClaimOrder(cell: Cell, views: TaskView[]): Promise<Array<{ taskId: string; rule: string }>> {
    // Same window for everyone (board priority), shuffled per cell so ties do not herd cells onto one task.
    const window = views.slice(0, Math.min(this.config.claimCandidates, MAX_CANDIDATES));
    const candidates = seededShuffle(window, hashString(`${this.runId}|${cell.id}|${cell.ticks++}`));
    const ids = candidates.map((v) => v.task.id);
    this.setState(cell, "claiming");
    const { answer } = await this.ask(QK.claim, claimQuestion(candidates), buildClaimState(cell), { runId: this.runId, purpose: "claim", cellId: cell.id });
    let order = claimOrder(answer, ids);
    if (order.length === 0) {
      cell.declines++;
      if (cell.declines < DECLINES_BEFORE_FORCE) return [];
      // A judge that keeps declining must not stall the swarm: fall back to board priority.
      order = window.map((v) => v.task.id);
    }
    cell.declines = 0;
    return order.map((taskId) => ({ taskId, rule: "judge" }));
  }

  private tryForgery(cell: Cell): void {
    const at = this.now();
    const leased = this.board
      .all()
      .filter((e) => !isTerminal(e) && e.claimedBy !== undefined && e.claimedBy !== cell.id && (e.leaseUntil ?? 0) > at)
      .map((e) => e.task.id);
    const target = forgedProposalAttempt(leased, `${cell.id}:forge`);
    if (target === undefined) return;
    cell.forgeryTried = true;
    this.handleOf(cell).propose({ taskId: target, answer: corruptAnswer("0", cell.id), summary: "trust me", sawProposalIds: [] });
  }

  private async work(cell: Cell, taskId: string): Promise<void> {
    const entry = this.board.get(taskId);
    if (!entry) return;
    cell.taskId = taskId;
    this.setState(cell, entry.proposals.length > 0 ? "verifying" : "solving", taskId);
    const handle = this.handleOf(cell);
    const renew = setInterval(
      () => {
        // A dead cell must stop renewing: recovery relies on its lease running out.
        if (cell.working && !this.stopped) handle.renew(taskId);
      },
      Math.max(50, Math.floor(this.config.leaseMs / 3)),
    );
    try {
      await this.solveAndResolve(cell, entry);
    } catch (err) {
      // Service-side cleanup, so it also works for a cell that died or was cut off mid-call.
      this.board.release(taskId, cell.id);
      throw err;
    } finally {
      clearInterval(renew);
      cell.taskId = undefined;
    }
  }

  /** The cell still owns the task: alive, not stopped, lease live (renewing it as a side effect). */
  private holds(cell: Cell, taskId: string): boolean {
    return cell.alive && !this.stopped && this.handleOf(cell).renew(taskId);
  }

  private takeEcho(entry: TaskEntry, cell: Cell): Proposal | undefined {
    const mark = this.echo.get(entry.task.id);
    const first = this.validProposals(entry).find((p) => this.normalize(p.answer) !== "" && p.cellId !== cell.id);
    if (!mark || !first) return undefined;
    if (mark.cells) {
      if (!mark.cells.delete(cell.id)) return undefined;
      return first;
    }
    if (mark.left <= 0) return undefined;
    mark.left--;
    return first;
  }

  private async solveAndResolve(cell: Cell, entry: TaskEntry): Promise<void> {
    const { task } = entry;
    const meta = { runId: this.runId, cellId: cell.id, taskId: task.id };
    const stuck = this.learns && (this.failedReviews.get(task.id) ?? 0) >= this.config.stuckAfter && !this.consulted.has(task.id);
    const libraryGene = stuck ? await this.consultLibrary(cell, task) : undefined;
    if (stuck && !this.holds(cell, task.id)) return;
    const gene = libraryGene ?? (this.learns ? cell.pool.best(task.domain) : undefined);
    const teammate = this.takeEcho(entry, cell);

    const r = await this.llmOf(cell).complete({
      messages: [
        { role: "system", content: SOLVE_SYSTEM },
        { role: "user", content: buildSolvePrompt(task, gene, teammate) },
      ],
      maxTokens: 600,
      meta: { ...meta, purpose: "solve" },
    });
    if (!this.holds(cell, task.id)) return;

    const honest = this.extract(r.text);
    const answer = cell.compromised ? corruptAnswer(honest, `${cell.id}:${task.id}`) : honest;
    const proposal = this.handleOf(cell).propose({
      taskId: task.id,
      answer,
      summary: methodSummary(r.text),
      sawProposalIds: teammate ? [teammate.id] : [],
    });
    if (!proposal) return;
    if (gene) this.proposalGene.set(proposal.id, gene.id);
    cell.recordAttempt(task.domain);
    this.publishCard(cell);
    if (cell.compromised) cell.gossipDue = true;

    const latest = this.board.get(task.id);
    if (!latest) return;
    const mark = this.echo.get(task.id);
    if (mark?.cells && mark.since === undefined) mark.since = this.now();
    const first = latest.proposals[0];
    if (first && first.cellId !== cell.id) this.link(first.cellId, cell.id, "review");

    const valid = this.validProposals(latest);
    let forced: ReviewTag | null = null;
    if (valid.length === 1) {
      forced = await this.reviewNeed(cell, task, proposal);
      if (!this.holds(cell, task.id)) return;
    }
    await this.settle(cell, task.id, forced);
  }

  /** Rules first (zero tokens); only a proposal no rule catches reaches the verify judgment. */
  private async reviewNeed(cell: Cell, task: PublicTask, proposal: Proposal): Promise<ReviewTag | null> {
    if (!this.reviews) return null;
    if (this.echo.has(task.id)) return "echo";
    const rule = reviewReason({
      judged: this.trust.judged(cell.id),
      trust: this.trust.get(cell.id),
      probation: this.config.probation,
      reviewTrust: this.config.reviewTrust,
      auditDraw: unit(this.runId, task.id, "audit"),
      auditRate: this.config.auditRate,
    });
    if (rule) return rule === "low-trust" ? "trust" : rule;
    if (!this.usesJudge) return null;
    const { answer, precedentId } = await this.ask(QK.verify, VERIFY_QUESTION, buildVerifyState(task, proposal.answer, proposal.summary), {
      runId: this.runId,
      purpose: "verify",
      cellId: cell.id,
      taskId: task.id,
    });
    const reSolve = answer?.type === "noul" && answer.noul >= this.config.verifyThreshold;
    if (precedentId !== undefined) this.verifyVerdicts.set(task.id, { id: precedentId, reSolve, answer: this.normalize(proposal.answer) });
    return reSolve ? "judge" : null;
  }

  private async settle(cell: Cell, taskId: string, forced: ReviewTag | null): Promise<void> {
    const entry = this.board.get(taskId);
    if (!entry || isTerminal(entry)) return;
    const valid = this.validProposals(entry);
    const res = resolveAfterProposal({ ...entry, proposals: valid }, this.lineage, {
      needsVerification: forced !== null,
      maxAttempts: this.canVerify(entry) ? MAX_ATTEMPTS : 0,
      normalize: this.normalize,
    });
    if (this.usesJudge && res.kind !== "echo") {
      const groups = scoreGroups(valid, this.lineage, this.normalize);
      if (isDisagreement(groups)) {
        const winner = await this.dispute(cell, entry.task, groups);
        if (!this.holds(cell, taskId)) return;
        if (winner) {
          this.acceptTask(taskId, winner.answer, winner.proposals.map((p) => p.id), winner.sources);
          return;
        }
        // Past the attempts cap the plurality stands; before it, ask for another independent solve.
        if (res.kind !== "accept") {
          this.requestReview(taskId, cell.id, "dispute", true);
          return;
        }
      }
    }
    this.apply(taskId, res, cell.id, forced, valid.length);
  }

  private resolveExhausted(taskId: string): void {
    const entry = this.board.get(taskId);
    if (!entry) return;
    const valid = this.validProposals(entry);
    const res = resolveAfterProposal({ ...entry, proposals: valid }, this.lineage, { needsVerification: false, maxAttempts: 0, normalize: this.normalize });
    this.apply(taskId, res, entry.proposers.at(-1) ?? "", null, valid.length);
  }

  private apply(taskId: string, res: Resolution, handoff: string, forced: ReviewTag | null, validCount: number): void {
    switch (res.kind) {
      case "accept":
        this.acceptTask(taskId, res.answer, res.proposalIds, res.independentSources);
        return;
      case "echo":
        this.counters.echoAlarms++;
        this.emit({ type: "echo.detected", taskId, proposalIds: res.proposalIds, agreeing: res.agreeing, independentSources: res.independentSources });
        this.message({
          type: "ECHO_ALARM",
          from: SERVICE.board,
          to: BROADCAST,
          parents: res.proposalIds,
          body: { taskId, proposalIds: res.proposalIds, agreeing: res.agreeing, independentSources: res.independentSources },
        });
        this.requestReview(taskId, handoff, "echo", true);
        return;
      case "verify":
        this.requestReview(taskId, handoff, forced ?? (validCount >= 2 ? "dispute" : "judge"), validCount >= 2);
        return;
      case "wait": {
        const cell = this.cells.get(handoff);
        if (cell) this.handleOf(cell).release(taskId);
        return;
      }
      case "fail":
        this.failTask(taskId);
        return;
    }
  }

  private requestReview(taskId: string, handoff: string, reason: ReviewTag, failedReview: boolean): void {
    const entry = this.board.get(taskId);
    if (!entry || isTerminal(entry)) return;
    this.board.requestVerification(taskId);
    this.reviewed.add(taskId);
    if (failedReview) this.failedReviews.set(taskId, (this.failedReviews.get(taskId) ?? 0) + 1);
    this.emit({ type: "task.verifying", taskId, cellId: handoff });
    const last = entry.proposals.at(-1);
    this.message({
      type: "REVIEW_REQUEST",
      from: SERVICE.board,
      to: BROADCAST,
      parents: last ? [last.id] : [taskNodeId(taskId)],
      body: last ? { taskId, reason, proposalId: last.id } : { taskId, reason },
    });
  }

  private async dispute(cell: Cell, task: PublicTask, groups: ScoredGroup[]): Promise<ScoredGroup | undefined> {
    const candidates = groups.map((g, i) => ({ key: `a${i + 1}`, answer: g.answer, summary: g.proposals[0]?.summary ?? "" }));
    const { answer, precedentId } = await this.ask(QK.dispute, disputeQuestion(candidates), buildDisputeState(task), {
      runId: this.runId,
      purpose: "adjudicate",
      cellId: cell.id,
      taskId: task.id,
    });
    if (precedentId !== undefined) {
      const chosen = answer?.type === "choice" ? candidates.find((c) => c.key === answer.choice)?.answer : undefined;
      const list = this.disputeVerdicts.get(task.id) ?? [];
      list.push({ id: precedentId, ...(chosen !== undefined ? { chosen } : {}), candidates: groups.map((g) => g.answer) });
      this.disputeVerdicts.set(task.id, list);
    }
    const win = disputeWinner(answer, candidates, DISPUTE_MIN_CONFIDENCE);
    this.log("info", `dispute on ${task.id}: ${groups.map((g) => g.answer).join(" vs ")} -> ${win ?? "unclear, another solve"}`);
    return win === undefined ? undefined : groups.find((g) => g.answer === win);
  }

  private acceptTask(taskId: string, answer: string, proposalIds: string[], independentSources: number): void {
    const entry = this.board.get(taskId);
    if (!entry || isTerminal(entry)) return;
    this.board.accept(taskId, answer, proposalIds, independentSources);
    this.emit({ type: "task.accepted", taskId, answer, independentSources, correct: this.isCorrect(taskId, answer) });
    this.message({ type: "ACCEPT", from: SERVICE.board, to: BROADCAST, parents: proposalIds, body: { taskId, answer, proposalIds, independentSources } });
    this.onAccepted(entry, answer, independentSources);
    this.settleVerdicts(taskId, answer);
    if (this.board.done()) this.finish();
  }

  private failTask(taskId: string): void {
    const entry = this.board.get(taskId);
    if (!entry || isTerminal(entry)) return;
    this.board.fail(taskId);
    this.emit({ type: "task.failed", taskId });
    this.settleVerdicts(taskId, undefined);
    if (this.board.done()) this.finish();
  }

  private settleVerdicts(taskId: string, accepted: string | undefined): void {
    const v = this.verifyVerdicts.get(taskId);
    if (v) {
      this.verifyVerdicts.delete(taskId);
      this.onPrecedentOutcome(v.id, verifyVerdictConfirmed(v, accepted));
    }
    for (const d of this.disputeVerdicts.get(taskId) ?? []) this.onPrecedentOutcome(d.id, disputeVerdictConfirmed(d, accepted));
    this.disputeVerdicts.delete(taskId);
  }

  // ---------------------------------------------------------------- trust and quarantine

  private onAccepted(entry: TaskEntry, answer: string, independentSources: number): void {
    const { domain, id: taskId } = entry.task;
    const valid = this.validProposals(entry);
    // Only a task that more than one cell answered says anything about a cell's reliability.
    const judged = new Set(valid.map((p) => p.cellId)).size >= 2;
    const verified = independentSources >= 2 || this.reviewed.has(taskId);
    for (const p of valid) {
      const cell = this.cells.get(p.cellId);
      if (!cell) continue;
      const won = this.normalize(p.answer) === answer;
      const geneId = this.proposalGene.get(p.id);
      if (geneId !== undefined) this.creditGene(cell, geneId, won);
      if (won) {
        cell.recordWin(domain);
        const distil = this.learns && verified && cell.working && !cell.compromised && (independentSources >= 2 || !cell.pool.best(domain));
        if (distil) cell.pendingGenes.push({ proposalId: p.id, taskId, domain, summary: p.summary, independentSources });
        if (cell.acceptedTotal % this.config.gossipEvery === 0) cell.gossipDue = true;
      }
      if (judged) this.recordTrust(cell, won, `disagreed with the accepted answer on ${taskId}`);
      else this.publishCard(cell);
    }
  }

  private recordTrust(cell: Cell, agreed: boolean, why: string): void {
    const trust = this.trust.record(cell.id, agreed);
    this.publishCard(cell);
    if (cell.quarantined) return;
    const judged = this.trust.judged(cell.id);
    if (!shouldQuarantine({ judged, trust, probation: this.config.probation, quarantineTrust: this.config.quarantineTrust })) return;
    this.quarantine(cell, trust, `trust ${trust.toFixed(2)} < ${this.config.quarantineTrust} after ${judged} judged (last: ${why})`);
  }

  private quarantine(cell: Cell, trust: number, reason: string): void {
    cell.quarantined = true;
    cell.gossipDue = false;
    cell.pendingGenes.length = 0;
    this.counters.quarantined++;
    this.publishCard(cell, { status: "quarantined" });
    this.emit({ type: "cell.quarantined", cellId: cell.id, trust, reason });
    this.message({ type: "QUARANTINE", from: SERVICE.registry, to: BROADCAST, body: { agentId: cell.id, trust, reason } });
    // The board takes back its leases at once instead of waiting for them to expire.
    for (const e of this.board.all()) {
      if (e.claimedBy !== cell.id || isTerminal(e)) continue;
      this.board.release(e.task.id, cell.id);
      this.counters.reopened++;
      this.emit({ type: "task.reopened", taskId: e.task.id, previousCell: cell.id });
    }
    this.setState(cell, "idle");
  }

  // ---------------------------------------------------------------- genes

  private creditGene(cell: Cell, geneId: string, won: boolean): void {
    cell.pool.record(geneId, won);
    const ev = this.geneEvidence.get(geneId) ?? { wins: 0, trials: 0 };
    this.geneEvidence.set(geneId, { wins: ev.wins + (won ? 1 : 0), trials: ev.trials + 1 });
    const key = `${cell.id}|${geneId}`;
    const precedentId = this.adoptVerdicts.get(key);
    if (precedentId !== undefined) {
      this.adoptVerdicts.delete(key);
      this.onPrecedentOutcome(precedentId, won);
    }
  }

  private async flushGenes(cell: Cell): Promise<void> {
    while (cell.pendingGenes.length > 0 && this.isActive(cell)) {
      const job = cell.pendingGenes.shift();
      if (!job) return;
      const r = await this.llmOf(cell).complete({
        messages: [
          { role: "system", content: GENE_SYSTEM },
          { role: "user", content: buildGenePrompt(job.domain, job.summary) },
        ],
        maxTokens: 120,
        meta: { runId: this.runId, purpose: "gene", cellId: cell.id, taskId: job.taskId },
      });
      if (!this.isActive(cell)) return;
      const text = geneText(r.text);
      if (!text) continue;
      const id = this.geneId();
      const at = this.now();
      this.lineage.add({ id, kind: "gene", cellId: cell.id, taskId: job.taskId, parents: [job.proposalId], at });
      const gene = createGene({ id, domain: job.domain, text, origin: cell.id, lineageId: id, now: at });
      this.genes.set(id, { gene, independentSources: job.independentSources });
      this.emit({ type: "gene.created", geneId: id, cellId: cell.id, domain: job.domain, text });
      this.addGene(cell, gene);
    }
  }

  private addGene(cell: Cell, gene: Gene): void {
    const evicted = cell.pool.add(gene);
    if (evicted) this.emit({ type: "gene.forgotten", geneId: evicted.id, cellId: cell.id });
    this.publishCard(cell);
  }

  private maybeGossip(cell: Cell): void {
    if (!cell.gossipDue || !this.learns) return;
    cell.gossipDue = false;
    const gene = cell.compromised ? this.poisonGene(cell) : cell.pool.list().find((g) => !this.cells.get(g.origin)?.quarantined);
    if (!gene) return;
    this.setState(cell, "gossiping");
    // Fire-and-forget: adoption decisions run on the receivers' side, off the sender's work loop.
    this.track(
      this.gossip(cell, gene).catch((err: unknown) => {
        this.handleError(cell, err);
      }),
    );
  }

  private poisonGene(cell: Cell): Gene {
    const domain = cell.lastDomain ?? this.tasks[0]?.domain ?? "arithmetic";
    const id = this.geneId();
    const at = this.now();
    const text = poisonedGene(domain, `${cell.id}:${id}`);
    this.lineage.add({ id, kind: "gene", cellId: cell.id, parents: [], at });
    const gene = createGene({ id, domain, text, origin: cell.id, lineageId: id, now: at });
    this.poisonGenes.add(id);
    this.genes.set(id, { gene });
    this.emit({ type: "gene.created", geneId: id, cellId: cell.id, domain, text });
    return gene;
  }

  /** Trusted active peers that need the gene most (lowest record in its domain); topology neighbours as fallback. */
  private gossipTargets(sender: Cell, gene: Gene): string[] {
    const fanout = Math.max(2, sender.neighbors.length);
    const rate = (c: CapabilityCard): number => smoothedRate(c.domains[gene.domain]);
    const found = this.registry
      .discover({ domain: gene.domain, exclude: [sender.id], limit: this.cells.size })
      .filter((c) => this.cells.get(c.agentId)?.working && this.trust.get(c.agentId) >= this.config.reviewTrust)
      .sort((a, b) => rate(a) - rate(b) || b.trust - a.trust || (a.agentId < b.agentId ? -1 : 1))
      .slice(0, fanout)
      .map((c) => c.agentId);
    this.message({
      type: "DISCOVER",
      from: SERVICE.registry,
      to: sender.id,
      body: { domain: gene.domain, limit: fanout, exclude: [sender.id], agents: found },
    });
    return found.length > 0 ? found : sender.neighbors.filter((id) => this.cells.get(id)?.working);
  }

  private async gossip(sender: Cell, gene: Gene): Promise<void> {
    for (const receiverId of this.gossipTargets(sender, gene)) {
      if (this.stopped || !sender.working) return;
      const receiver = this.cells.get(receiverId);
      if (!receiver?.working || receiver.pool.has(gene.id) || receiver.evaluatedGenes.has(gene.id)) continue;
      // Marked before the decision so concurrent gossip from two senders is judged once.
      receiver.evaluatedGenes.add(gene.id);
      if (!sender.neighbors.includes(receiver.id)) this.link(sender.id, receiver.id, "discover");
      const offerId = this.handleOf(sender).offerGene(receiver.id, gene);
      if (offerId === undefined) return;
      this.link(sender.id, receiver.id, "gossip");
      await this.evaluateGene(receiver, gene, { sender, offerId, fitness: sender.pool.fitness(gene) });
    }
  }

  /**
   * Receiver-side gate for a gene from a peer or the library: recollision, prompt-injection screening,
   * sender trust, then the adopt judgment (or the rule in swarm-rules). Returns the adopted copy.
   */
  private async evaluateGene(
    receiver: Cell,
    gene: Gene,
    from: { sender?: Cell; offerId?: string; fitness: number },
  ): Promise<Gene | undefined> {
    const to = from.sender?.id ?? SERVICE.library;
    const reject = (reason: "judge" | "recollision" | "sanitize" | "untrusted" | "rule", extra: Record<string, unknown> = {}): undefined => {
      this.emit({ type: "gene.rejected", geneId: gene.id, cellId: receiver.id, reason });
      this.message({ type: "GENE_REJECT", from: receiver.id, to, body: { geneId: gene.id, reason, ...extra } });
      return undefined;
    };
    if (from.offerId !== undefined && this.lineage.isRecollision(from.offerId, receiver.id)) return reject("recollision");

    const clean = sanitizeGeneText(gene.text);
    if (clean.suspicious) {
      this.log("warn", `${receiver.id} rejected gene ${gene.id} from ${to}: sanitize (${clean.reasons.join(", ")})`);
      const sender = from.sender;
      if (sender && !this.penalizedGenes.has(gene.id)) {
        this.penalizedGenes.add(gene.id);
        this.recordTrust(sender, false, `injection-shaped gene ${gene.id}`);
      }
      return reject("sanitize", { sanitize: clean.reasons });
    }
    if (from.sender && this.trust.get(from.sender.id) < this.config.reviewTrust) return reject("untrusted");
    if (from.sender) {
      const held = receiver.pool.best(gene.domain);
      if (provenGeneBlocks(held, from.fitness)) return reject("rule", { held: held?.id });
    }

    const offered: Gene = { ...gene, text: clean.text };
    let adopt = true;
    if (this.usesJudge) {
      const { answer, precedentId } = await this.ask(QK.adopt, adoptQuestion(offered.domain), buildAdoptState(receiver, offered, from.fitness), {
        runId: this.runId,
        purpose: "adopt",
        cellId: receiver.id,
      });
      adopt = answer?.type === "noul" && answer.noul >= ADOPT_THRESHOLD;
      if (adopt && precedentId !== undefined) this.adoptVerdicts.set(`${receiver.id}|${gene.id}`, precedentId);
    }
    if (this.stopped || !receiver.working) return undefined;
    if (!adopt || receiver.pool.has(gene.id)) return reject("judge");
    this.counters.genesAdopted++;
    this.emit({ type: "gene.adopted", geneId: gene.id, cellId: receiver.id });
    this.message({ type: "GENE_ADOPT", from: receiver.id, to, parents: [gene.lineageId], body: { geneId: gene.id, domain: gene.domain } });
    const copy = adoptCopy(offered, this.now());
    this.addGene(receiver, copy);
    return copy;
  }

  // ---------------------------------------------------------------- library and EvoMap

  private libraryNode(g: LibraryGene): string {
    const id = `lib:${g.id}`;
    if (!this.lineage.get(id)) this.lineage.add({ id, kind: "gene", parents: [], at: this.now() });
    return id;
  }

  private seedInherited(cell: Cell): void {
    for (const g of this.inheritSelection) {
      if (cell.pool.list().length >= this.config.geneCapacity) return;
      const clean = sanitizeGeneText(g.text);
      if (clean.suspicious) continue;
      const gene = toGene({ ...g, text: clean.text }, this.libraryNode(g), this.now());
      if (!this.genes.has(g.id)) this.genes.set(g.id, { gene, library: g });
      cell.pool.add(gene);
    }
  }

  /** A stuck task's next solver asks the local library, then EvoMap, and adopts at most one gene for this solve. */
  private async consultLibrary(cell: Cell, task: PublicTask): Promise<Gene | undefined> {
    this.consulted.add(task.id);
    const sources: Array<{ source: "local" | "evomap"; fetch: () => Promise<LibraryGene[]> }> = [];
    const library = this.library;
    const evomap = this.evomap;
    if (library) sources.push({ source: "local", fetch: async () => library.search(task.domain, LIBRARY_K) });
    if (evomap) {
      const query = `${DOMAIN_KEYWORDS[task.domain]} ${clip(task.prompt, EVOMAP_PROMPT_CHARS)}`;
      sources.push({ source: "evomap", fetch: () => evomap.search(query, task.domain) });
    }
    for (const { source, fetch } of sources) {
      this.message({ type: "LIBRARY_QUERY", from: cell.id, to: SERVICE.library, parents: [taskNodeId(task.id)], body: { taskId: task.id, domain: task.domain, k: LIBRARY_K, source } });
      let found: LibraryGene[] = [];
      try {
        found = (await fetch()).slice(0, LIBRARY_K);
      } catch (err) {
        if (err instanceof BudgetExceededError) throw err;
        this.log("warn", `${source} lookup failed: ${errorMessage(err)}`);
      }
      if (!this.isActive(cell)) return undefined;
      const geneIds = found.map((g) => g.id);
      const titles = found.map((g) => clip(g.text, TITLE_CHARS));
      this.message({ type: "LIBRARY_RESULT", from: SERVICE.library, to: cell.id, body: { taskId: task.id, source, geneIds, titles } });
      if (found.length === 0) continue;
      this.counters.libraryHits++;
      this.emit({ type: "library.hit", cellId: cell.id, taskId: task.id, source, geneIds, titles });
      for (const g of found) {
        if (cell.pool.has(g.id)) return cell.pool.list().find((x) => x.id === g.id);
        const gene = toGene(g, this.libraryNode(g), this.now());
        const adopted = await this.evaluateGene(cell, gene, { fitness: smoothedRate(g.evidence) });
        if (!this.isActive(cell)) return undefined;
        if (adopted) {
          if (!this.genes.has(g.id)) this.genes.set(g.id, { gene: adopted, library: g });
          return adopted;
        }
      }
    }
    return undefined;
  }

  private echoCandidate(targets: string[]): TaskEntry | undefined {
    const all = this.board.all().filter((e) => !isTerminal(e));
    const lone = (e: TaskEntry) => {
      const valid = this.validProposals(e);
      return valid.length === 1 && !targets.includes(valid[0]?.cellId ?? "") && !targets.includes(e.claimedBy ?? "");
    };
    return all.find(lone) ?? all.find((e) => e.status === "open" && e.proposals.length === 0);
  }
}

const cellName = (n: number): string => `c${String(n).padStart(2, "0")}`;

const decisionKey = (key: string, cellId?: string, taskId?: string): string => `${key}|${cellId ?? ""}|${taskId ?? ""}`;

/** Best 1-2 library genes per task domain, best first per rank so a small pool still covers every domain. */
function selectInherited(genes: readonly LibraryGene[], tasks: readonly PublicTask[]): LibraryGene[] {
  const domains = [...new Set(tasks.map((t) => t.domain))];
  const ranked = new Map(
    domains.map((d) => [
      d,
      genes
        .filter((g) => g.domain === d)
        .sort((a, b) => smoothedRate(b.evidence) - smoothedRate(a.evidence) || b.evidence.trials - a.evidence.trials || a.id.localeCompare(b.id)),
    ]),
  );
  const out: LibraryGene[] = [];
  for (let rank = 0; rank < INHERIT_PER_DOMAIN; rank++) {
    for (const d of domains) {
      const g = ranked.get(d)?.[rank];
      if (g) out.push(g);
    }
  }
  return out;
}

/** The newest cell plus seeded picks, so a joiner is linked to a stable part of the graph. */
function pickLinks(ids: string[], n: number, draw: number): string[] {
  if (ids.length <= n) return [...ids];
  const out = [ids[ids.length - 1] as string];
  const rest = ids.slice(0, -1);
  let i = Math.floor(draw * rest.length);
  while (out.length < n && rest.length > 0) {
    out.push(rest.splice(i % rest.length, 1)[0] as string);
    i += 1;
  }
  return out;
}

/** Waits for the promises, but never longer than ms (in-flight provider calls are left to finish on their own). */
async function settleWithin(promises: Promise<unknown>[], ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  await Promise.race([Promise.allSettled(promises), timeout]);
  clearTimeout(timer);
}
