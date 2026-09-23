import { hashString, seededShuffle, sleep, unit } from "../core/rng";
import { BudgetExceededError, QK } from "../core/types";
import type {
  Blackboard,
  CellState,
  EventBus,
  Gene,
  Judge,
  Lineage,
  LLM,
  Proposal,
  PublicTask,
  RunConfig,
  SwarmEvent,
  TaskEntry,
} from "../core/types";
import { extractFinalAnswer, normalizeAnswer } from "../tasks/check";
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
  SOLVE_SYSTEM,
  VERIFY_QUESTION,
} from "./cell";
import { adoptCopy, createGene } from "./genes";
import { resolveAfterProposal } from "./resolve";
import { buildTopology } from "./topology";

/** A SwarmEvent without the envelope fields the emitter fills in. */
export type EventBody = {
  [K in SwarmEvent["type"]]: Omit<Extract<SwarmEvent, { type: K }>, "runId" | "at">;
}[SwarmEvent["type"]];

export interface SwarmDeps {
  runId: string;
  config: RunConfig;
  tasks: PublicTask[];
  /** Metered. */
  llm: LLM;
  /** Metered and observed (swarm-llm) or escalating (swarm-jev). */
  judge: Judge;
  bus: EventBus;
  lineage: Lineage;
  board: Blackboard;
  now?: () => number;
  /** Display-only ground-truth check injected by the runner; it never feeds a decision. */
  isCorrect?: (taskId: string, answer: string) => boolean;
}

const MAX_ATTEMPTS = 4;
const TICK_MS = 250;
const IDLE_MS = 150;
const RACE_BACKOFF_MS = 50;
const ERROR_BACKOFF_MS = 500;
const ECHO_SOLVES = 2;
const DECLINES_BEFORE_FORCE = 3;
const ADOPT_THRESHOLD = 0.5;
const STOP_GRACE_MS = 1000;
// Jev accepts at most 255 choice criteria, and the claim question always adds the "none" key.
const MAX_CANDIDATES = 254;

const taskNode = (taskId: string): string => `task:${taskId}`;
const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Self-organising swarm: no scheduler assigns work. Each cell pulls from the blackboard, asks its
 * judge the closed-form coordination questions, and uses the LLM only to solve and distil genes.
 */
export class Swarm {
  private readonly runId: string;
  private readonly config: RunConfig;
  private readonly llm: LLM;
  private readonly judge: Judge;
  private readonly bus: EventBus;
  private readonly lineage: Lineage;
  private readonly board: Blackboard;
  private readonly now: () => number;
  private readonly isCorrect: (taskId: string, answer: string) => boolean;
  private readonly cells = new Map<string, Cell>();
  /** taskId -> remaining solves that will be shown the first proposal (injected echo). */
  private readonly echoMarks = new Map<string, number>();
  /** proposalId -> gene the solver used, credited once the task is accepted. */
  private readonly proposalGene = new Map<string, string>();
  private readonly background = new Set<Promise<void>>();
  private readonly counters = { reopened: 0, echoAlarms: 0, genesAdopted: 0 };
  private seq = 0;
  private started = false;
  private stopped = false;
  private reason: string | undefined;
  private resolveFinished: () => void = () => {};
  private readonly finished: Promise<void>;

  constructor(deps: SwarmDeps) {
    this.runId = deps.runId;
    this.config = deps.config;
    this.llm = deps.llm;
    this.judge = deps.judge;
    this.bus = deps.bus;
    this.lineage = deps.lineage;
    this.board = deps.board;
    this.now = deps.now ?? Date.now;
    this.isCorrect = deps.isCorrect ?? (() => false);
    this.finished = new Promise((resolve) => {
      this.resolveFinished = resolve;
    });

    const at = this.now();
    for (const t of deps.tasks) {
      if (!this.lineage.get(taskNode(t.id))) this.lineage.add({ id: taskNode(t.id), kind: "task", taskId: t.id, parents: [], at });
    }
    const ids = Array.from({ length: deps.config.cells }, (_, i) => `c${String(i + 1).padStart(2, "0")}`);
    const topology = buildTopology(ids, deps.config.topology, deps.config.seed);
    for (const id of ids) this.cells.set(id, new Cell(id, topology.get(id) ?? [], deps.config.geneCapacity));
  }

  /** Resolves when every task is settled, stop() is called, the wall clock or budget runs out, or every cell is dead. */
  async start(): Promise<void> {
    if (this.started) throw new Error("swarm already started");
    this.started = true;
    for (const c of this.cells.values()) this.emit({ type: "cell.spawned", cellId: c.id, neighbors: c.neighbors });

    const ticker = setInterval(() => this.tick(), TICK_MS);
    const wall = setTimeout(() => this.stop("wall-clock"), this.config.maxWallMs);
    const loops = [...this.cells.values()].map((c) => this.runCell(c));
    this.tick();
    await this.finished;
    clearInterval(ticker);
    clearTimeout(wall);
    await settleWithin([...loops, ...this.background], STOP_GRACE_MS);
  }

  stop(reason = "stopped"): void {
    if (this.stopped) return;
    this.stopped = true;
    this.reason = reason;
    this.resolveFinished();
  }

  kill(cellId?: string): string {
    const alive = this.aliveCells();
    if (alive.length === 0) throw new Error("no live cells to kill");
    let target: Cell | undefined;
    if (cellId !== undefined) {
      target = this.cells.get(cellId);
      if (!target) throw new Error(`unknown cell ${cellId}`);
      if (!target.alive) throw new Error(`cell ${cellId} is already dead`);
    } else {
      // Prefer a cell holding a claim so the kill demonstrates lease-based recovery.
      const busy = alive.filter((c) => c.taskId !== undefined);
      const pool = busy.length > 0 ? busy : alive;
      target = pool[Math.floor(unit(this.runId, "kill", this.seq++) * pool.length)] ?? alive[0];
    }
    if (!target) throw new Error("no live cells to kill");
    target.alive = false;
    target.state = "dead";
    this.emit({ type: "cell.killed", cellId: target.id });
    this.emit({ type: "cell.state", cellId: target.id, state: "dead" });
    return target.id;
  }

  injectEcho(taskId?: string): string {
    const entry = taskId !== undefined ? this.board.get(taskId) : this.echoCandidate();
    if (!entry) throw new Error(taskId !== undefined ? `unknown task ${taskId}` : "no task available for echo injection");
    if (entry.status === "accepted" || entry.status === "failed") throw new Error(`task ${entry.task.id} is already settled`);
    const id = entry.task.id;
    this.echoMarks.set(id, ECHO_SOLVES);
    const first = entry.proposals[0];
    if (first && entry.status !== "verifying") {
      this.board.requestVerification(id);
      this.emit({ type: "task.verifying", taskId: id, cellId: first.cellId });
    }
    this.log(
      "info",
      first
        ? `echo injected on ${id}: the next ${ECHO_SOLVES} solvers see ${first.cellId}'s answer`
        : `echo injected on ${id}: once it has a proposal, the next ${ECHO_SOLVES} solvers see it`,
    );
    return id;
  }

  aliveCount(): number {
    return this.aliveCells().length;
  }

  stats(): { reopened: number; echoAlarms: number; genesAdopted: number } {
    return { ...this.counters };
  }

  abortReason(): string | undefined {
    return this.reason;
  }

  // ---------------------------------------------------------------- shared housekeeping

  private tick(): void {
    if (this.stopped) return;
    this.sweep();
    if (this.board.done()) {
      this.finish();
      return;
    }
    const alive = this.aliveCells();
    if (alive.length === 0) {
      this.stop("all cells dead");
      return;
    }
    // A task whose every live cell already proposed can never get an independent verifier.
    for (const e of this.board.claimable(this.now())) {
      if (e.proposals.length > 0 && alive.every((c) => e.proposers.includes(c.id))) this.resolve(e.task.id, false);
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
    return !this.stopped && cell.alive && !this.board.done();
  }

  private aliveCells(): Cell[] {
    return [...this.cells.values()].filter((c) => c.alive);
  }

  private canVerify(entry: TaskEntry): boolean {
    return this.aliveCells().some((c) => !entry.proposers.includes(c.id));
  }

  private emit(body: EventBody): void {
    this.bus.emit({ ...body, runId: this.runId, at: this.now() } as SwarmEvent);
  }

  private log(level: "info" | "warn" | "error", message: string): void {
    this.emit({ type: "log", level, message });
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
    const claimable = this.board.claimable(this.now()).filter((e) => !e.proposers.includes(cell.id));
    if (claimable.length === 0) {
      this.setState(cell, "idle");
      await sleep(IDLE_MS + Math.floor(50 * unit(cell.id, "idle", cell.ticks++)));
      return;
    }
    // Same window for everyone (board priority), shuffled per cell so ties do not herd cells onto one task.
    const window = claimable.slice(0, Math.min(this.config.claimCandidates, MAX_CANDIDATES));
    const candidates = seededShuffle(window, hashString(`${this.runId}|${cell.id}|${cell.ticks++}`));
    const ids = candidates.map((e) => e.task.id);

    this.setState(cell, "claiming");
    const r = await this.judge.ask({
      state: buildClaimState(cell),
      questions: { [QK.claim]: claimQuestion(candidates) },
      meta: { runId: this.runId, purpose: "claim", cellId: cell.id },
    });
    if (!this.isActive(cell)) return;

    let order = claimOrder(r.answers[QK.claim], ids);
    if (order.length === 0) {
      cell.declines++;
      if (cell.declines < DECLINES_BEFORE_FORCE) {
        this.setState(cell, "idle");
        await sleep(IDLE_MS);
        return;
      }
      // A judge that keeps declining must not stall the swarm: fall back to board priority.
      order = window.map((e) => e.task.id);
    }
    cell.declines = 0;

    for (const taskId of order) {
      if (this.board.claim(taskId, cell.id, this.now())) {
        await this.work(cell, taskId);
        return;
      }
    }
    await sleep(RACE_BACKOFF_MS);
  }

  private async work(cell: Cell, taskId: string): Promise<void> {
    const entry = this.board.get(taskId);
    if (!entry) return;
    cell.taskId = taskId;
    this.emit({ type: "task.claimed", taskId, cellId: cell.id });
    this.setState(cell, entry.status === "verifying" ? "verifying" : "solving", taskId);

    const renew = setInterval(
      () => {
        // A dead cell must stop renewing: recovery relies on its lease running out.
        if (cell.alive && !this.stopped) this.board.renew(taskId, cell.id, this.now());
      },
      Math.max(50, Math.floor(this.config.leaseMs / 3)),
    );
    try {
      await this.solveAndResolve(cell, entry);
    } catch (err) {
      this.board.release(taskId, cell.id);
      throw err;
    } finally {
      clearInterval(renew);
      cell.taskId = undefined;
    }
  }

  /** The cell still owns the task: alive, not stopped, lease live (renewing it as a side effect). */
  private holds(cell: Cell, taskId: string): boolean {
    return cell.alive && !this.stopped && this.board.renew(taskId, cell.id, this.now());
  }

  private takeEcho(entry: TaskEntry): Proposal | undefined {
    const left = this.echoMarks.get(entry.task.id) ?? 0;
    const first = entry.proposals.find((p) => normalizeAnswer(p.answer) !== "");
    if (left <= 0 || !first) return undefined;
    this.echoMarks.set(entry.task.id, left - 1);
    return first;
  }

  private async solveAndResolve(cell: Cell, entry: TaskEntry): Promise<void> {
    const { task } = entry;
    const meta = { runId: this.runId, cellId: cell.id, taskId: task.id };
    const gene = cell.pool.best(task.domain);
    const teammate = this.takeEcho(entry);

    const r = await this.llm.complete({
      messages: [
        { role: "system", content: SOLVE_SYSTEM },
        { role: "user", content: buildSolvePrompt(task, gene, teammate) },
      ],
      maxTokens: 600,
      meta: { ...meta, purpose: "solve" },
    });
    if (!this.holds(cell, task.id)) return;

    const answer = extractFinalAnswer(r.text);
    const summary = methodSummary(r.text);
    const proposalId = this.nextId("p");
    const saw = teammate ? [teammate.id] : [];
    const at = this.now();
    this.lineage.add({ id: proposalId, kind: "proposal", cellId: cell.id, taskId: task.id, parents: [taskNode(task.id), ...saw], at });
    this.board.propose({ id: proposalId, taskId: task.id, cellId: cell.id, answer, summary, at });
    if (gene) this.proposalGene.set(proposalId, gene.id);
    cell.recordAttempt(task.domain);
    this.emit({ type: "task.proposed", taskId: task.id, cellId: cell.id, proposalId, sawProposals: saw });

    let needsVerification = false;
    if ((this.board.get(task.id)?.proposals.length ?? 0) === 1) {
      const v = await this.judge.ask({
        state: buildVerifyState(task, answer, summary),
        questions: { [QK.verify]: VERIFY_QUESTION },
        meta: { ...meta, purpose: "verify" },
      });
      if (!this.holds(cell, task.id)) return;
      const a = v.answers[QK.verify];
      needsVerification = (a?.type === "noul" && a.noul >= this.config.verifyThreshold) || this.echoMarks.has(task.id);
    }
    this.resolve(task.id, needsVerification, cell);
  }

  private resolve(taskId: string, needsVerification: boolean, cell?: Cell): void {
    const entry = this.board.get(taskId);
    if (!entry) return;
    const res = resolveAfterProposal(entry, this.lineage, {
      needsVerification,
      maxAttempts: this.canVerify(entry) ? MAX_ATTEMPTS : 0,
      normalize: normalizeAnswer,
    });
    const handoff = cell?.id ?? entry.proposers.at(-1) ?? "";
    switch (res.kind) {
      case "accept":
        this.board.accept(taskId, res.answer, res.proposalIds, res.independentSources);
        this.emit({
          type: "task.accepted",
          taskId,
          answer: res.answer,
          independentSources: res.independentSources,
          correct: this.isCorrect(taskId, res.answer),
        });
        this.onAccepted(entry, res.answer, res.independentSources);
        if (this.board.done()) this.finish();
        return;
      case "echo":
        this.counters.echoAlarms++;
        this.emit({
          type: "echo.detected",
          taskId,
          proposalIds: res.proposalIds,
          agreeing: res.agreeing,
          independentSources: res.independentSources,
        });
        this.board.requestVerification(taskId);
        this.emit({ type: "task.verifying", taskId, cellId: handoff });
        return;
      case "verify":
        this.board.requestVerification(taskId);
        this.emit({ type: "task.verifying", taskId, cellId: handoff });
        return;
      case "wait":
        if (cell) this.board.release(taskId, cell.id);
        return;
      case "fail":
        this.board.fail(taskId);
        this.emit({ type: "task.failed", taskId });
        if (this.board.done()) this.finish();
        return;
    }
  }

  // ---------------------------------------------------------------- genes

  private onAccepted(entry: TaskEntry, answer: string, independentSources: number): void {
    const { domain, id: taskId } = entry.task;
    for (const p of entry.proposals) {
      const cell = this.cells.get(p.cellId);
      if (!cell) continue;
      const won = normalizeAnswer(p.answer) === answer;
      const geneId = this.proposalGene.get(p.id);
      if (geneId !== undefined) cell.pool.record(geneId, won);
      if (!won) continue;
      const firstWin = cell.recordWin(domain);
      if (!cell.alive) continue;
      if (independentSources >= 2 || (firstWin && !cell.pool.best(domain))) {
        cell.pendingGenes.push({ proposalId: p.id, taskId, domain, summary: p.summary });
      }
      if (cell.acceptedTotal % this.config.gossipEvery === 0) cell.gossipDue = true;
    }
  }

  private async flushGenes(cell: Cell): Promise<void> {
    while (cell.pendingGenes.length > 0 && this.isActive(cell)) {
      const job = cell.pendingGenes.shift();
      if (!job) return;
      const r = await this.llm.complete({
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
      const id = this.nextId("g");
      const at = this.now();
      this.lineage.add({ id, kind: "gene", cellId: cell.id, taskId: job.taskId, parents: [job.proposalId], at });
      const gene = createGene({ id, domain: job.domain, text, origin: cell.id, lineageId: id, now: at });
      this.emit({ type: "gene.created", geneId: id, cellId: cell.id, domain: job.domain, text });
      this.addGene(cell, gene);
    }
  }

  private addGene(cell: Cell, gene: Gene): void {
    const evicted = cell.pool.add(gene);
    if (evicted) this.emit({ type: "gene.forgotten", geneId: evicted.id, cellId: cell.id });
  }

  private maybeGossip(cell: Cell): void {
    if (!cell.gossipDue) return;
    cell.gossipDue = false;
    const gene = cell.pool.best();
    if (!gene) return;
    this.setState(cell, "gossiping");
    // Fire-and-forget: adoption decisions run on the receivers' side, off the sender's work loop.
    this.track(
      this.gossip(cell, gene).catch((err: unknown) => {
        this.handleError(cell, err);
      }),
    );
  }

  private async gossip(sender: Cell, gene: Gene): Promise<void> {
    for (const receiverId of sender.neighbors) {
      if (this.stopped || !sender.alive) return;
      const receiver = this.cells.get(receiverId);
      if (!receiver?.alive || receiver.pool.has(gene.id) || receiver.evaluatedGenes.has(gene.id)) continue;
      // Marked before the decision so concurrent gossip from two senders is judged once.
      receiver.evaluatedGenes.add(gene.id);

      const messageId = this.nextId("m");
      this.lineage.add({ id: messageId, kind: "message", cellId: sender.id, parents: [gene.lineageId], at: this.now() });
      this.emit({ type: "gene.gossiped", geneId: gene.id, fromCell: sender.id, toCell: receiver.id });
      if (this.lineage.isRecollision(messageId, receiver.id)) {
        this.emit({ type: "gene.rejected", geneId: gene.id, cellId: receiver.id, reason: "recollision" });
        continue;
      }

      const r = await this.judge.ask({
        state: buildAdoptState(receiver, gene, sender.pool.fitness(gene)),
        questions: { [QK.adopt]: adoptQuestion(gene.domain) },
        meta: { runId: this.runId, purpose: "adopt", cellId: receiver.id },
      });
      if (this.stopped || !receiver.alive) return;
      const a = r.answers[QK.adopt];
      if (a?.type === "noul" && a.noul >= ADOPT_THRESHOLD && !receiver.pool.has(gene.id)) {
        this.counters.genesAdopted++;
        this.emit({ type: "gene.adopted", geneId: gene.id, cellId: receiver.id });
        this.addGene(receiver, adoptCopy(gene, this.now()));
      } else {
        this.emit({ type: "gene.rejected", geneId: gene.id, cellId: receiver.id, reason: "judge" });
      }
    }
  }

  private echoCandidate(): TaskEntry | undefined {
    const all = this.board.all();
    const live = (e: TaskEntry) => e.status !== "accepted" && e.status !== "failed";
    return all.find((e) => live(e) && e.proposals.length === 1) ?? all.find((e) => e.status === "open" && e.proposals.length === 0);
  }
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
