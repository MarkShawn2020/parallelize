import type {
  CellState,
  Decision,
  Domain,
  LiveMetrics,
  Mode,
  RunConfig,
  RunSummary,
  SwarmEvent,
  TaskStatus,
} from "../../src/core/types";

export const CAP = { history: 600, decisions: 200, feed: 120, particles: 50, echoes: 50 } as const;

export interface TaskView {
  id: string;
  domain: Domain;
  status: TaskStatus;
  claimedBy?: string;
  /** Cells that proposed an answer; a reopened task with proposals goes back to verifying. */
  proposers: string[];
  correct?: boolean;
  independentSources?: number;
}

export interface CellView {
  id: string;
  state: CellState;
  neighbors: string[];
  alive: boolean;
  /** Proposals this cell produced. */
  solved: number;
  genes: number;
  taskId?: string;
}

export type FeedKind = "info" | "ok" | "warn" | "danger" | "gene";

export interface FeedLine {
  id: number;
  at: number;
  kind: FeedKind;
  text: string;
}

export interface EchoAlarm {
  taskId: string;
  agreeing: number;
  independentSources: number;
  at: number;
}

export interface Particle {
  from: string;
  to: string;
  at: number;
}

export interface RunView {
  runId: string | null;
  mode: Mode | null;
  simulated: boolean;
  config: RunConfig | null;
  startedAt: number | null;
  tasks: Record<string, TaskView>;
  cells: Record<string, CellView>;
  metrics: LiveMetrics | null;
  metricsHistory: LiveMetrics[];
  decisions: Decision[];
  feed: FeedLine[];
  echoAlarms: EchoAlarm[];
  particles: Particle[];
  summary: RunSummary | null;
  /** Monotonic feed line id, used as a stable React key. */
  seq: number;
}

export const initialRunView: RunView = {
  runId: null,
  mode: null,
  simulated: false,
  config: null,
  startedAt: null,
  tasks: {},
  cells: {},
  metrics: null,
  metricsHistory: [],
  decisions: [],
  feed: [],
  echoAlarms: [],
  particles: [],
  summary: null,
  seq: 0,
};

export function reduce(s: RunView, e: SwarmEvent): RunView {
  if (e.type === "run.started") return startRun(e);
  if (e.runId !== s.runId) return s;

  switch (e.type) {
    case "run.finished": {
      const m = e.summary.metrics;
      const text = e.summary.aborted
        ? `中止 Aborted · ${e.summary.aborted}`
        : `完成 Finished · 准确率 ${(m.accuracy * 100).toFixed(1)}% · AIR ${m.air.toFixed(2)}`;
      return log({ ...s, summary: e.summary, metrics: m }, e.at, e.summary.aborted ? "warn" : "ok", text);
    }
    case "cell.spawned":
      return {
        ...s,
        cells: {
          ...s.cells,
          [e.cellId]: { id: e.cellId, state: "idle", neighbors: e.neighbors, alive: true, solved: 0, genes: 0 },
        },
      };
    case "cell.state":
      // Dead is sticky: a killed cell's in-flight work may still report state afterwards.
      return patchCell(s, e.cellId, (c) =>
        c.alive ? { ...c, state: e.state, alive: e.state !== "dead", taskId: e.taskId } : c,
      );
    case "cell.killed":
      return log(
        patchCell(s, e.cellId, (c) => ({ ...c, state: "dead", alive: false, taskId: undefined })),
        e.at,
        "danger",
        `阵亡 Killed ${e.cellId}`,
      );
    case "task.claimed":
      return patchTask(s, e.taskId, (t) =>
        isSettled(t) ? t : { ...t, status: t.status === "verifying" ? "verifying" : "claimed", claimedBy: e.cellId },
      );
    case "task.reopened":
      return log(
        patchTask(s, e.taskId, (t) =>
          isSettled(t) ? t : { ...t, status: t.proposers.length > 0 ? "verifying" : "open", claimedBy: undefined },
        ),
        e.at,
        "warn",
        `回收 Reopened ${e.taskId}${e.previousCell ? ` ← ${e.previousCell}` : ""}`,
      );
    case "task.proposed":
      return patchCell(
        patchTask(s, e.taskId, (t) =>
          t.proposers.includes(e.cellId) ? t : { ...t, proposers: [...t.proposers, e.cellId] },
        ),
        e.cellId,
        (c) => ({ ...c, solved: c.solved + 1 }),
      );
    case "task.verifying":
      // A proposer reporting verifying is handing the task off; anyone else is the verifier holding it.
      return patchTask(s, e.taskId, (t) =>
        isSettled(t)
          ? t
          : { ...t, status: "verifying", claimedBy: t.proposers.includes(e.cellId) ? undefined : e.cellId },
      );
    case "task.accepted":
      return patchTask(s, e.taskId, (t) => ({
        ...t,
        status: "accepted",
        claimedBy: undefined,
        correct: e.correct,
        independentSources: e.independentSources,
      }));
    case "task.failed":
      return log(
        patchTask(s, e.taskId, (t) => ({ ...t, status: "failed", claimedBy: undefined })),
        e.at,
        "danger",
        `失败 Failed ${e.taskId}`,
      );
    case "judge.decision":
      return { ...s, decisions: capPush(s.decisions, e.decision, CAP.decisions) };
    case "gene.created":
      return log(
        patchCell(s, e.cellId, (c) => ({ ...c, genes: c.genes + 1 })),
        e.at,
        "gene",
        `基因生成 Gene ${e.geneId} ← ${e.cellId} · ${e.domain}`,
      );
    case "gene.gossiped":
      return { ...s, particles: capPush(s.particles, { from: e.fromCell, to: e.toCell, at: e.at }, CAP.particles) };
    case "gene.adopted":
      return log(
        patchCell(s, e.cellId, (c) => ({ ...c, genes: c.genes + 1 })),
        e.at,
        "gene",
        `基因采纳 Adopted ${e.geneId} → ${e.cellId}`,
      );
    case "gene.rejected":
      return log(
        s,
        e.at,
        "info",
        `基因拒收 Rejected ${e.geneId} @ ${e.cellId} · ${e.reason === "recollision" ? "回流 recollision" : "判定 judge"}`,
      );
    case "gene.forgotten":
      return patchCell(s, e.cellId, (c) => ({ ...c, genes: Math.max(0, c.genes - 1) }));
    case "echo.detected":
      return log(
        {
          ...s,
          echoAlarms: capPush(
            s.echoAlarms,
            { taskId: e.taskId, agreeing: e.agreeing, independentSources: e.independentSources, at: e.at },
            CAP.echoes,
          ),
        },
        e.at,
        "danger",
        `回声警报 Echo ${e.taskId} · ${e.agreeing} 一致 agreeing / ${e.independentSources} 独立来源 independent`,
      );
    case "metrics":
      return { ...s, metrics: e.metrics, metricsHistory: pushHistory(s.metricsHistory, e.metrics) };
    case "log":
      return log(s, e.at, e.level === "error" ? "danger" : e.level === "warn" ? "warn" : "info", e.message);
  }
}

function startRun(e: Extract<SwarmEvent, { type: "run.started" }>): RunView {
  const tasks: Record<string, TaskView> = {};
  for (const t of e.tasks) tasks[t.id] = { id: t.id, domain: t.domain, status: "open", proposers: [] };
  const view: RunView = {
    ...initialRunView,
    runId: e.runId,
    mode: e.mode,
    simulated: e.simulated,
    config: e.config,
    startedAt: e.at,
    tasks,
  };
  const text = `启动 Run ${e.runId} · ${e.mode} · ${e.tasks.length} tasks${e.simulated ? " · SIMULATION" : ""}`;
  return log(view, e.at, "info", text);
}

function isSettled(t: TaskView): boolean {
  return t.status === "accepted" || t.status === "failed";
}

function patchTask(s: RunView, id: string, fn: (t: TaskView) => TaskView): RunView {
  const t = s.tasks[id];
  return t ? { ...s, tasks: { ...s.tasks, [id]: fn(t) } } : s;
}

function patchCell(s: RunView, id: string, fn: (c: CellView) => CellView): RunView {
  const c = s.cells[id];
  return c ? { ...s, cells: { ...s.cells, [id]: fn(c) } } : s;
}

function log(s: RunView, at: number, kind: FeedKind, text: string): RunView {
  const seq = s.seq + 1;
  return { ...s, seq, feed: capPush(s.feed, { id: seq, at, kind, text }, CAP.feed) };
}

function capPush<T>(list: readonly T[], item: T, cap: number): T[] {
  const out = list.length >= cap ? list.slice(list.length - cap + 1) : list.slice();
  out.push(item);
  return out;
}

// Halve instead of dropping the oldest points: the early part of the curve is where
// escalations are highest, which is the trend the chart exists to show.
function pushHistory(list: readonly LiveMetrics[], m: LiveMetrics): LiveMetrics[] {
  const out = list.length >= CAP.history ? list.filter((_, i) => i % 2 === 0) : list.slice();
  out.push(m);
  return out;
}
