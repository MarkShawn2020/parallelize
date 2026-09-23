import { createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { PROJECT_ROOT, providerEnv } from "./config";
import { InMemoryBlackboard } from "./core/blackboard";
import { createRunId } from "./core/events";
import { MemoryLedger, meterJudge, meterLLM } from "./core/ledger";
import type { MeterOptions } from "./core/ledger";
import { LineageGraph } from "./core/lineage";
import { computeMetrics } from "./core/metrics";
import { BudgetExceededError, QK } from "./core/types";
import type {
  Blackboard,
  CalibrationSample,
  Decision,
  EventBus,
  Judge,
  LedgerEntry,
  LiveMetrics,
  LLM,
  PublicTask,
  RunConfig,
  RunSummary,
  SwarmEvent,
  Task,
} from "./core/types";
import { groupCalibration } from "./judge/calibration";
import { EscalatingJudge } from "./judge/escalating";
import { LLMJudge } from "./judge/llm-judge";
import { ObservedJudge } from "./judge/observed";
import { MemoryPrecedentStore } from "./judge/precedents";
import { runSingle } from "./modes/single";
import { runSubagent } from "./modes/subagent";
import { JevJudge } from "./providers/jev";
import { Semaphore } from "./providers/limiter";
import { MockJudge, MockLLM, MockOracle } from "./providers/mock";
import { OpenAICompatLLM } from "./providers/openai-llm";
import { Swarm } from "./swarm/swarm";
import type { EventBody } from "./swarm/swarm";
import { checkAnswer, createTaskSource } from "./tasks";

export interface RunHandle {
  runId: string;
  config: RunConfig;
  simulated: boolean;
  /** Never rejects: failures end the run with summary.aborted set. */
  done: Promise<RunSummary>;
  stop(): void;
  kill(cellId?: string): string;
  injectEcho(taskId?: string): string;
}

export interface StartRunOptions {
  bus: EventBus;
  runsDir: string;
  now?: () => number;
  /** Overrides the latency range of every simulated provider (tests use [0, 0]). */
  mockLatencyMs?: [number, number];
}

const METRICS_EVERY_MS = 500;
// Precedents are appended to every System-1 state, so they must stay short or System 1 stops being cheap.
const PRECEDENT_STATE_CHARS = 120;
const PRECEDENTS_PER_KEY = 3;

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function requireKey(key: string | undefined, names: string): string {
  if (!key) throw new Error(`${names} is not set; add it to .env or use the mock provider`);
  return key;
}

interface ProviderContext {
  config: RunConfig;
  oracle: MockOracle;
  meter: Omit<MeterOptions, "provider">;
  ledger: MemoryLedger;
  onDecision: (d: Decision) => void;
  mockLatencyMs: [number, number] | undefined;
}

function buildProviders(ctx: ProviderContext): { llm: LLM; judge?: Judge; simulated: boolean } {
  const { config, oracle, ledger, meter, onDecision } = ctx;
  const env = providerEnv();
  const latency = ctx.mockLatencyMs ? { latencyMs: ctx.mockLatencyMs } : {};
  const llmMock = config.llm === "mock";

  const rawLLM: LLM = llmMock
    ? new MockLLM({ oracle, seed: config.seed, ...latency })
    : new OpenAICompatLLM({
        baseUrl: env.llm.baseUrl,
        apiKey: requireKey(env.llm.apiKey, "LLM_API_KEY or OPENROUTER_API_KEY"),
        model: env.llm.model,
        limiter: new Semaphore(config.llmConcurrency),
      });
  const llm = meterLLM(rawLLM, ledger, { ...meter, provider: llmMock ? "mock-llm" : "llm" });
  // LLMJudge calls go through the metered LLM, so they must not be metered a second time.
  const system2 = (): Judge =>
    llmMock
      ? meterJudge(new MockJudge({ tier: "system2", seed: config.seed, oracle, ...latency }), ledger, { ...meter, provider: "mock-judge" })
      : new LLMJudge({ llm });

  switch (config.mode) {
    case "single":
    case "subagent":
      return { llm, simulated: llmMock };
    case "swarm-llm":
      return { llm, judge: new ObservedJudge(system2(), { onDecision }), simulated: llmMock };
    case "swarm-jev": {
      const judgeMock = config.judge === "mock";
      const rawS1: Judge = judgeMock
        ? new MockJudge({ tier: "system1", seed: config.seed, oracle, ...latency })
        : new JevJudge({
            baseUrl: env.jev.baseUrl,
            apiKey: requireKey(env.jev.apiKey, "JEV_API_KEY or OPENROUTER_API_KEY"),
            model: env.jev.model,
            limiter: new Semaphore(config.judgeConcurrency),
          });
      const judge = new EscalatingJudge({
        s1: meterJudge(rawS1, ledger, { ...meter, provider: judgeMock ? "mock-judge" : "jev" }),
        s2: system2(),
        threshold: config.escalationThreshold,
        precedents: new MemoryPrecedentStore({ maxStateChars: PRECEDENT_STATE_CHARS }),
        precedentsPerKey: PRECEDENTS_PER_KEY,
        onDecision,
      });
      return { llm, judge, simulated: llmMock || judgeMock };
    }
  }
}

async function loadTasks(config: RunConfig): Promise<Task[]> {
  const src = config.taskSource;
  const source =
    src.kind === "gsm8k" && !isAbsolute(src.path)
      ? createTaskSource({ kind: "gsm8k", path: resolve(PROJECT_ROOT, src.path) })
      : createTaskSource(src);
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

/** Outcomes are joined after the run from ground truth; they never reach a decision. */
function calibrationSamples(
  decisions: Decision[],
  board: Blackboard,
  isCorrect: (taskId: string, answer: string) => boolean,
): CalibrationSample[] {
  const proposalOf = (taskId: string, cellId: string | undefined) =>
    cellId === undefined ? undefined : board.get(taskId)?.proposals.find((p) => p.cellId === cellId);
  const samples: CalibrationSample[] = [];
  for (const d of decisions) {
    if (d.key === QK.verify && d.answer.type === "noul" && d.taskId !== undefined) {
      const p = proposalOf(d.taskId, d.cellId);
      if (p) samples.push({ key: QK.verify, predicted: d.answer.noul, outcome: !isCorrect(d.taskId, p.answer) });
    } else if (d.key === QK.claim && d.answer.type === "choice") {
      const taskId = d.answer.choice;
      const p = proposalOf(taskId, d.cellId);
      if (p) {
        const predicted = d.answer.probabilities[taskId] ?? d.answer.confidence;
        samples.push({ key: QK.claim, predicted, outcome: isCorrect(taskId, p.answer) });
      }
    }
  }
  return samples;
}

type Outcome = { kind: "answers"; answers: Map<string, string> } | { kind: "aborted"; reason: string };

export async function startRun(config: RunConfig, opts: StartRunOptions): Promise<RunHandle> {
  const now = opts.now ?? Date.now;
  const tasks = await loadTasks(config);
  const truth = new Map(tasks.map((t) => [t.id, t.answer]));
  const publicTasks: PublicTask[] = tasks.map((t) => ({ id: t.id, domain: t.domain, prompt: t.prompt }));
  const isCorrect = (taskId: string, answer: string): boolean => {
    const expected = truth.get(taskId);
    return expected !== undefined && checkAnswer(expected, answer);
  };

  const runId = createRunId(config.mode, now());
  const emit = (body: EventBody): void => opts.bus.emit({ ...body, runId, at: now() } as SwarmEvent);
  const ledger = new MemoryLedger();
  const decisions: Decision[] = [];
  let ledgerLog: JsonlWriter | undefined;

  const { llm, judge, simulated } = buildProviders({
    config,
    oracle: new MockOracle(tasks),
    ledger,
    meter: { maxCostUsd: config.maxCostUsd, now, onEntry: (e: LedgerEntry) => ledgerLog?.write(e) },
    onDecision: (d) => {
      decisions.push(d);
      emit({ type: "judge.decision", decision: d });
    },
    mockLatencyMs: opts.mockLatencyMs,
  });

  const dir = join(opts.runsDir, runId);
  await mkdir(dir, { recursive: true });
  const persistError = (what: string) => (err: Error) => emit({ type: "log", level: "error", message: `cannot write ${what}: ${err.message}` });
  const eventLog = new JsonlWriter(join(dir, "events.jsonl"), persistError("events.jsonl"));
  ledgerLog = new JsonlWriter(join(dir, "ledger.jsonl"), persistError("ledger.jsonl"));

  const accepted = new Map<string, boolean>();
  const unsubscribe = opts.bus.on((e) => {
    if (e.runId !== runId) return;
    eventLog.write(e);
    if (e.type === "task.accepted") accepted.set(e.taskId, e.correct);
  });

  const board = new InMemoryBlackboard(publicTasks, { leaseMs: config.leaseMs });
  const swarm = judge
    ? new Swarm({ runId, config, tasks: publicTasks, llm, judge, bus: opts.bus, lineage: new LineageGraph(), board, now, isCorrect })
    : undefined;
  let requestStop: (reason: string) => void = () => {};
  const stopRequested = new Promise<string>((resolveStop) => {
    requestStop = resolveStop;
  });

  const execute = async (): Promise<RunSummary> => {
    const startedAt = now();
    const snapshot = (): LiveMetrics =>
      computeMetrics({
        tasksTotal: tasks.length,
        accepted,
        ledger,
        decisions,
        cellsAlive: swarm?.aliveCount() ?? 0,
        ...(swarm?.stats() ?? { reopened: 0, echoAlarms: 0, genesAdopted: 0 }),
        startedAt,
        now: now(),
      });

    emit({ type: "run.started", mode: config.mode, config, simulated, tasks: publicTasks });
    const metricsTimer = setInterval(() => emit({ type: "metrics", metrics: snapshot() }), METRICS_EVERY_MS);
    let aborted: string | undefined;
    try {
      if (swarm) {
        await swarm.start();
        aborted = swarm.abortReason();
      } else {
        const work =
          config.mode === "single"
            ? runSingle({ runId, tasks: publicTasks, llm })
            : runSubagent({ runId, tasks: publicTasks, llm, concurrency: config.llmConcurrency });
        const outcome = await raceStop(work, stopRequested, config.maxWallMs);
        if (outcome.kind === "aborted") aborted = outcome.reason;
        else publishAnswers(outcome.answers);
      }
    } catch (err) {
      aborted = err instanceof BudgetExceededError ? "budget" : `error: ${errorMessage(err)}`;
      emit({ type: "log", level: err instanceof BudgetExceededError ? "warn" : "error", message: errorMessage(err) });
    } finally {
      clearInterval(metricsTimer);
    }

    const metrics = snapshot();
    emit({ type: "metrics", metrics });
    const summary: RunSummary = {
      runId,
      mode: config.mode,
      config,
      simulated,
      metrics,
      byPurpose: ledger.byPurpose(),
      calibration: swarm ? groupCalibration(calibrationSamples(decisions, board, isCorrect)) : {},
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

  /** Baseline modes produce all answers at once; each becomes a single-source acceptance. */
  const publishAnswers = (answers: Map<string, string>): void => {
    for (const t of publicTasks) {
      const answer = answers.get(t.id);
      if (answer === undefined) emit({ type: "task.failed", taskId: t.id });
      else emit({ type: "task.accepted", taskId: t.id, answer, independentSources: 1, correct: isCorrect(t.id, answer) });
    }
  };

  const noSwarm = (what: string): Error => new Error(`${what} needs a swarm mode; this run is ${config.mode}`);
  return {
    runId,
    config,
    simulated,
    done: execute(),
    stop: () => (swarm ? swarm.stop("stopped") : requestStop("stopped")),
    kill: (cellId) => {
      if (!swarm) throw noSwarm("kill");
      return swarm.kill(cellId);
    },
    injectEcho: (taskId) => {
      if (!swarm) throw noSwarm("echo injection");
      return swarm.injectEcho(taskId);
    },
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
