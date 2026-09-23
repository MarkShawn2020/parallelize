import { createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { PROJECT_ROOT } from "./config";
import { InMemoryBlackboard } from "./core/blackboard";
import { createRunId } from "./core/events";
import { MemoryLedger } from "./core/ledger";
import { LineageGraph } from "./core/lineage";
import { computeMetrics } from "./core/metrics";
import type { AcceptedTask } from "./core/metrics";
import { BudgetExceededError, QK, SWARM_MODES } from "./core/types";
import type {
  Blackboard,
  CalibrationSample,
  Decision,
  EventBus,
  LedgerEntry,
  LibraryGene,
  LiveMetrics,
  LLM,
  Precedent,
  PublicTask,
  RunConfig,
  RunSummary,
  SwarmEvent,
  Task,
} from "./core/types";
import { groupCalibration } from "./judge/calibration";
import { freshTasks, gateAndPublish, publishCandidates } from "./modes/evomap-publish";
import type { PublishOutcome } from "./modes/evomap-publish";
import { buildResearchReport, entriesFromAnswers, reportMarkdown } from "./modes/report";
import { NUMBER_FORMAT, runSingle } from "./modes/single";
import type { AnswerFormat } from "./modes/single";
import { runSingleVote } from "./modes/single-vote";
import { runSubagent } from "./modes/subagent";
import { FileExperienceLibrary } from "./protocol/library";
import { EvoMapClient, hitToLibraryGene } from "./providers/evomap";
import { ProviderStack } from "./providers/stack";
import { geneFitness } from "./swarm/genes";
import { Swarm } from "./swarm/swarm";
import type { EventBody, EvoMapLookup, SwarmStats } from "./swarm/swarm";
import { checkAnswer, createTaskSource, extractVerdict, isCanaryTask, normalizeAnswer, normalizeResearchAnswer } from "./tasks";

export interface RunHandle {
  runId: string;
  config: RunConfig;
  simulated: boolean;
  /** Never rejects: failures end the run with summary.aborted set. */
  done: Promise<RunSummary>;
  stop(): void;
  kill(cellId?: string): string;
  injectEcho(taskId?: string, cellIds?: string[]): string;
  /** Plug-and-play: a new cell (default model unless given) joins the running swarm. */
  spawn(model?: string): { cellId: string; model: string };
  compromise(cellId?: string): string;
  setFault(provider: "jev" | "llm", down: boolean): void;
  /** Every cell the swarm has spawned, alive or not. */
  cellIds(): string[];
}

export interface StartRunOptions {
  bus: EventBus;
  runsDir: string;
  now?: () => number;
  /** Overrides the latency range of every simulated provider (tests use [0, 0]); wins over config.simPace. */
  mockLatencyMs?: [number, number];
  /** Experience library directory; default `<runsDir>/library`. */
  libraryDir?: string;
  /** EvoMap client for stuck-task lookup and publishing; default one shared client per process. */
  evomap?: EvoMapClient;
}

const METRICS_EVERY_MS = 500;
// Genes are deposited in the local library only with some evidence behind them.
const LIBRARY_MIN_TRIALS = 2;
const LIBRARY_MIN_FITNESS = 0.6;
const EVOMAP_HITS = 3;
const EVOMAP_MIN_GDI = 20;
const RESEARCH_FORMAT: AnswerFormat = { hint: "supported|refuted|uncertain", extract: extractVerdict };
const NO_STATS: SwarmStats = { reopened: 0, echoAlarms: 0, genesAdopted: 0, quarantined: 0, libraryHits: 0, inheritedGenes: 0 };

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// EvoMap rate-limits per IP and the client caches per query, so every run in the process shares one.
let sharedEvoMap: EvoMapClient | undefined;

async function loadTasks(config: RunConfig, planner: { llm: LLM; runId: string }): Promise<Task[]> {
  const src = config.taskSource;
  const source =
    src.kind === "gsm8k" && !isAbsolute(src.path)
      ? createTaskSource({ kind: "gsm8k", path: resolve(PROJECT_ROOT, src.path) })
      : createTaskSource(src, planner);
  return source.load(config.n, config.seed);
}

class JsonlWriter {
  private readonly stream: WriteStream;
  private failed = false;

  constructor(path: string, onError: (err: Error) => void) {
    this.stream = createWriteStream(path, { flags: "a" });
    this.stream.on("error", (err) => {
      if (this.failed) return;
      this.failed = true;
      onError(err);
    });
  }

  write(value: unknown): void {
    if (!this.failed) this.stream.write(`${JSON.stringify(value)}\n`);
  }

  close(): Promise<void> {
    return new Promise((done) => {
      if (this.stream.closed) return done();
      this.stream.once("close", () => done());
      this.stream.end();
    });
  }
}

type Grader = { graded: (taskId: string) => boolean; isCorrect: (taskId: string, answer: string) => boolean };

const proposalOf = (board: Blackboard, taskId: string, cellId: string | undefined) =>
  cellId === undefined ? undefined : board.get(taskId)?.proposals.filter((p) => p.cellId === cellId).at(-1);

/** Outcomes are joined after the run from ground truth; they never reach a decision. */
function calibrationSamples(decisions: Decision[], board: Blackboard, g: Grader): CalibrationSample[] {
  const samples: CalibrationSample[] = [];
  for (const d of decisions) {
    // A fallback is a fixed default, not a prediction.
    if (d.fallback) continue;
    if (d.key === QK.verify && d.answer.type === "noul" && d.taskId !== undefined && g.graded(d.taskId)) {
      const p = proposalOf(board, d.taskId, d.cellId);
      if (p) samples.push({ key: QK.verify, predicted: d.answer.noul, outcome: !g.isCorrect(d.taskId, p.answer) });
    } else if (d.key === QK.claim && d.answer.type === "choice" && g.graded(d.answer.choice)) {
      const taskId = d.answer.choice;
      const p = proposalOf(board, taskId, d.cellId);
      if (p) samples.push({ key: QK.claim, predicted: d.answer.probabilities[taskId] ?? d.answer.confidence, outcome: g.isCorrect(taskId, p.answer) });
    }
  }
  return samples;
}

/** System 1 said "no review needed" on its own: was the proposal it waved through actually wrong? */
function passThroughSamples(decisions: Decision[], board: Blackboard, g: Grader, verifyThreshold: number): boolean[] {
  const out: boolean[] = [];
  for (const d of decisions) {
    if (d.key !== QK.verify || d.tier !== "system1" || d.escalated || d.answer.type !== "noul" || d.answer.noul >= verifyThreshold) continue;
    if (d.taskId === undefined || !g.graded(d.taskId)) continue;
    const p = proposalOf(board, d.taskId, d.cellId);
    if (p) out.push(!g.isCorrect(d.taskId, p.answer));
  }
  return out;
}

const precedentKey = (p: Precedent): string => `${p.key}␟${p.state}␟${p.at}`;

type Outcome = { kind: "answers"; answers: Map<string, string> } | { kind: "aborted"; reason: string };

export async function startRun(config: RunConfig, opts: StartRunOptions): Promise<RunHandle> {
  const now = opts.now ?? Date.now;
  const runId = createRunId(config.mode, now());
  const research = config.taskSource.kind === "research" ? config.taskSource : undefined;
  const format = research ? RESEARCH_FORMAT : NUMBER_FORMAT;
  const normalize = research ? normalizeResearchAnswer : normalizeAnswer;
  const emit = (body: EventBody): void => opts.bus.emit({ ...body, runId, at: now() } as SwarmEvent);
  const ledger = new MemoryLedger();
  const decisions: Decision[] = [];
  let ledgerLog: JsonlWriter | undefined;

  const stack = new ProviderStack({
    config,
    ledger,
    meter: { maxCostUsd: config.maxCostUsd, now, onEntry: (e: LedgerEntry) => ledgerLog?.write(e) },
    ...(opts.mockLatencyMs ? { mockLatencyMs: opts.mockLatencyMs } : {}),
  });
  const tasks = await loadTasks(config, { llm: stack.planner(), runId });
  stack.useTasks(tasks);
  const truth = new Map(tasks.map((t) => [t.id, t.answer]));
  const publicTasks: PublicTask[] = tasks.map((t) => ({ id: t.id, domain: t.domain, prompt: t.prompt }));
  // Research: only canary claims have ground truth, so only they are scored.
  const gradedIds = research ? new Set(tasks.filter(isCanaryTask).map((t) => t.id)) : undefined;
  const grader: Grader = {
    graded: (taskId) => (gradedIds ? gradedIds.has(taskId) : truth.has(taskId)),
    isCorrect: (taskId, answer) => {
      const expected = truth.get(taskId);
      if (expected === undefined || (gradedIds && !gradedIds.has(taskId))) return false;
      return research ? normalize(answer) === normalize(expected) : checkAnswer(expected, answer);
    },
  };

  const library = config.inherit ? new FileExperienceLibrary(opts.libraryDir ?? join(opts.runsDir, "library")) : undefined;
  const loaded = library ? await library.load() : undefined;
  const inheritedPrecedents = new Set<string>();
  for (const p of library?.precedents() ?? []) {
    stack.precedents.add(p);
    inheritedPrecedents.add(precedentKey(p));
  }
  const evomap = (): EvoMapClient => opts.evomap ?? (sharedEvoMap ??= new EvoMapClient());
  const lookup: EvoMapLookup | undefined = config.evomapLookup
    ? {
        search: async (query, domain) => {
          const client = evomap();
          const hits = await client.search(query, { limit: EVOMAP_HITS, minGdi: EVOMAP_MIN_GDI });
          if (hits.length === 0 && client.lastError) emit({ type: "log", level: "warn", message: `EvoMap search failed: ${client.lastError}` });
          return hits.map((h) => hitToLibraryGene(h, domain, now()));
        },
      }
    : undefined;

  const dir = join(opts.runsDir, runId);
  await mkdir(dir, { recursive: true });
  const persistError = (what: string) => (err: Error) => emit({ type: "log", level: "error", message: `cannot write ${what}: ${err.message}` });
  const eventLog = new JsonlWriter(join(dir, "events.jsonl"), persistError("events.jsonl"));
  ledgerLog = new JsonlWriter(join(dir, "ledger.jsonl"), persistError("ledger.jsonl"));
  // The research planner ran before the log existed.
  for (const e of ledger.entries()) ledgerLog.write(e);

  const accepted = new Map<string, AcceptedTask>();
  const unsubscribe = opts.bus.on((e) => {
    if (e.runId !== runId) return;
    eventLog.write(e);
    if (e.type === "task.accepted") accepted.set(e.taskId, { correct: e.correct, independentSources: e.independentSources });
  });

  const board = new InMemoryBlackboard(publicTasks, { leaseMs: config.leaseMs });
  const judge = stack.judge({
    onDecision: (d) => {
      decisions.push(d);
      emit({ type: "judge.decision", decision: d });
    },
    onGuard: (key, disagreement) => emit({ type: "judge.guard", key, disagreement, window: config.guardWindow }),
  });
  const swarm = SWARM_MODES.includes(config.mode)
    ? new Swarm({
        runId,
        config,
        tasks: publicTasks,
        llm: stack.llm(),
        llmFor: (model) => stack.llm(model),
        defaultModel: stack.defaultModel,
        ...(judge ? { judge } : {}),
        bus: opts.bus,
        lineage: new LineageGraph(),
        board,
        ...(library ? { library, inheritedGenes: library.genes() } : {}),
        ...(lookup ? { evomap: lookup } : {}),
        onPrecedentOutcome: (id, confirmed) => (confirmed ? stack.precedents.confirm(id) : stack.precedents.reject(id)),
        jevDown: () => stack.switches.jev.down,
        extract: format.extract,
        normalize,
        now,
        isCorrect: grader.isCorrect,
      })
    : undefined;
  let requestStop: (reason: string) => void = () => {};
  const stopRequested = new Promise<string>((resolveStop) => {
    requestStop = resolveStop;
  });

  /** Baseline modes produce all answers at once; each becomes a single-source acceptance. */
  const publishAnswers = (answers: Map<string, string>): void => {
    for (const t of publicTasks) {
      const answer = answers.get(t.id);
      if (answer === undefined) emit({ type: "task.failed", taskId: t.id });
      else emit({ type: "task.accepted", taskId: t.id, answer, independentSources: 1, correct: grader.isCorrect(t.id, answer) });
    }
  };

  const baseline = async (): Promise<Map<string, string>> => {
    const llm = stack.llm();
    switch (config.mode) {
      case "single":
        return runSingle({ runId, tasks: publicTasks, llm, format });
      case "subagent":
        return runSubagent({ runId, tasks: publicTasks, llm, concurrency: config.llmConcurrency, format });
      default: {
        const r = await runSingleVote({
          runId,
          tasks: publicTasks,
          llm,
          budgetTokens: config.voteBudgetTokens,
          concurrency: config.llmConcurrency,
          normalize,
          extract: format.extract,
        });
        emit({ type: "log", level: "info", message: `single-vote: ${r.k} samples per task (${r.samples} total), majority vote` });
        return r.answers;
      }
    }
  };

  /** Deposit verified experience locally and (when enabled) gate + publish the best genes to EvoMap. */
  const settleExperience = async (aborted: string | undefined): Promise<void> => {
    if (!swarm || (!library && !config.evomapPublish)) return;
    const experience = swarm.experience();
    let outcome: PublishOutcome | undefined;
    if (config.evomapPublish && aborted === undefined) {
      const exclude = new Set(tasks.map((t) => t.prompt));
      const src = config.taskSource;
      const gsm8kPath = src.kind === "gsm8k" ? resolve(PROJECT_ROOT, src.path) : undefined;
      outcome = await gateAndPublish({
        runId,
        candidates: publishCandidates(experience),
        holdout: async (gene, i) => {
          const fresh = await freshTasks({
            domain: gene.domain,
            count: config.publishGateTasks,
            seed: config.seed + 1000 + i,
            exclude,
            ...(gsm8kPath ? { gsm8kPath } : {}),
            ...(src.kind === "synthetic" && src.difficulty ? { difficulty: src.difficulty } : {}),
          });
          return { tasks: fresh, llm: stack.holdoutLLM(fresh) };
        },
        minDelta: config.publishGateMinDelta,
        concurrency: config.llmConcurrency,
        client: evomap(),
        modelName: stack.defaultModel,
        send: !stack.simulated,
        log: (level, message) => emit({ type: "log", level, message }),
      });
    }
    let genes: LibraryGene[] = [];
    let precedents: Precedent[] = [];
    if (library) {
      genes = experience
        .filter((g) => g.trials >= LIBRARY_MIN_TRIALS && geneFitness(g) >= LIBRARY_MIN_FITNESS)
        .map((g) => {
          const assetId = outcome?.published.get(g.id);
          return assetId === undefined ? g : { ...g, assetId };
        });
      precedents = stack.precedents.all().filter((p) => !inheritedPrecedents.has(precedentKey(p)));
      try {
        await library.publish(genes, precedents);
      } catch (err) {
        emit({ type: "log", level: "error", message: `cannot write the experience library: ${errorMessage(err)}` });
      }
    }
    const evomapField = config.evomapPublish ? (outcome?.evomap ?? { assetIds: [], urls: [], status: `skipped: run ${aborted}` }) : undefined;
    emit({
      type: "library.published",
      genes: genes.length,
      precedents: precedents.length,
      gate: outcome?.gate ?? [],
      ...(evomapField ? { evomap: evomapField } : {}),
    });
  };

  const execute = async (): Promise<RunSummary> => {
    const startedAt = now();
    const snapshot = (): LiveMetrics => {
      const stats = swarm?.stats() ?? NO_STATS;
      return computeMetrics({
        tasksTotal: tasks.length,
        accepted,
        ...(gradedIds ? { graded: gradedIds } : {}),
        ledger,
        decisions,
        passThrough: passThroughSamples(decisions, board, grader, config.verifyThreshold),
        cellsAlive: swarm?.aliveCount() ?? 0,
        reopened: stats.reopened,
        echoAlarms: stats.echoAlarms,
        genesAdopted: stats.genesAdopted,
        quarantined: stats.quarantined,
        libraryHits: stats.libraryHits,
        inheritedGenes: stats.inheritedGenes,
        jevDown: stack.switches.jev.down,
        accuracyApplicable: !research,
        startedAt,
        now: now(),
      });
    };

    emit({ type: "run.started", mode: config.mode, config, simulated: stack.simulated, tasks: publicTasks });
    if (loaded) emit({ type: "library.loaded", genes: loaded.genes, precedents: loaded.precedents });
    const metricsTimer = setInterval(() => emit({ type: "metrics", metrics: snapshot() }), METRICS_EVERY_MS);
    let aborted: string | undefined;
    let answers: Map<string, string> | undefined;
    try {
      if (swarm) {
        await swarm.start();
        aborted = swarm.abortReason();
      } else {
        const outcome = await raceStop(baseline(), stopRequested, config.maxWallMs);
        if (outcome.kind === "aborted") aborted = outcome.reason;
        else {
          answers = outcome.answers;
          publishAnswers(answers);
        }
      }
      await settleExperience(aborted);
    } catch (err) {
      aborted = err instanceof BudgetExceededError ? "budget" : `error: ${errorMessage(err)}`;
      emit({ type: "log", level: err instanceof BudgetExceededError ? "warn" : "error", message: errorMessage(err) });
    } finally {
      clearInterval(metricsTimer);
    }

    if (research) {
      const entries = swarm ? board.all() : entriesFromAnswers(publicTasks, answers ?? new Map());
      const report = buildResearchReport({ idea: research.idea, tasks, entries, normalize });
      emit({ type: "research.report", report });
      try {
        await writeFile(join(dir, "report.md"), reportMarkdown(report));
      } catch (err) {
        emit({ type: "log", level: "error", message: `cannot write report.md: ${errorMessage(err)}` });
      }
    }

    const metrics = snapshot();
    emit({ type: "metrics", metrics });
    const summary: RunSummary = {
      runId,
      mode: config.mode,
      config,
      simulated: stack.simulated,
      metrics,
      byPurpose: ledger.byPurpose(),
      calibration: swarm ? groupCalibration(calibrationSamples(decisions, board, grader)) : {},
      startedAt,
      finishedAt: now(),
    };
    if (aborted !== undefined) summary.aborted = aborted;
    try {
      await writeFile(join(dir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    } catch (err) {
      emit({ type: "log", level: "error", message: `cannot write summary.json: ${errorMessage(err)}` });
    }
    emit({ type: "run.finished", summary });
    unsubscribe();
    await Promise.all([eventLog.close(), ledgerLog?.close()]);
    return summary;
  };

  const needSwarm = (what: string): Swarm => {
    if (!swarm) throw new Error(`${what} needs a swarm mode; this run is ${config.mode}`);
    return swarm;
  };
  return {
    runId,
    config,
    simulated: stack.simulated,
    done: execute(),
    stop: () => (swarm ? swarm.stop("stopped") : requestStop("stopped")),
    kill: (cellId) => needSwarm("kill").kill(cellId),
    injectEcho: (taskId, cellIds) => needSwarm("echo injection").injectEcho(taskId, cellIds),
    spawn: (model = stack.defaultModel) => ({ cellId: needSwarm("spawn").spawn({ model, llm: stack.llm(model) }), model }),
    compromise: (cellId) => needSwarm("compromise").compromise(cellId),
    setFault: (provider, down) => {
      stack.switches[provider].set(down);
      emit({ type: "provider.fault", provider, down });
    },
    cellIds: () => swarm?.cards().map((c) => c.agentId) ?? [],
  };
}

/** Baseline calls cannot be cancelled mid-flight; stop and the wall clock end the run without their answers. */
async function raceStop(work: Promise<Map<string, string>>, stop: Promise<string>, maxWallMs: number): Promise<Outcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wall = new Promise<Outcome>((done) => {
    timer = setTimeout(() => done({ kind: "aborted", reason: "wall-clock" }), maxWallMs);
  });
  try {
    return await Promise.race([
      work.then((answers): Outcome => ({ kind: "answers", answers })),
      stop.then((reason): Outcome => ({ kind: "aborted", reason })),
      wall,
    ]);
  } finally {
    clearTimeout(timer);
    // A late rejection after losing the race must not surface as an unhandled rejection.
    work.catch(() => {});
  }
}
