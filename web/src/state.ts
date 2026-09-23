import type {
  CapabilityCard,
  CellState,
  Decision,
  Domain,
  LiveMetrics,
  Mode,
  ProtocolMessage,
  ProtocolType,
  ResearchReport,
  RunConfig,
  RunSummary,
  SwarmEvent,
  TaskStatus,
} from "../../src/core/types";

const REJECT_REASON: Record<string, string> = {
  judge: "判定 judge",
  recollision: "回流 recollision",
  sanitize: "注入过滤 sanitize",
  untrusted: "发送方不可信 untrusted",
  rule: "已有验证过的同类 Gene rule",
};

export const CAP = {
  history: 600,
  decisions: 200,
  feed: 120,
  particles: 50,
  echoes: 50,
  protocol: 200,
  hits: 50,
  alarms: 50,
  genes: 100,
} as const;

/** A cell spawned this long after run.started joined at runtime (plug-and-play), not in the initial burst. */
export const LATE_JOIN_MS = 1500;

type Ev<T extends SwarmEvent["type"]> = Extract<SwarmEvent, { type: T }>;
type Body<T extends SwarmEvent["type"]> = Omit<Ev<T>, "type" | "runId">;

export type LibrarySource = "local" | "evomap";
export type LinkReason = Ev<"link.formed">["reason"];
export type ParticleKind = "gene" | "review";

export interface TaskView {
  id: string;
  domain: Domain;
  prompt: string;
  status: TaskStatus;
  claimedBy?: string;
  /** Cells that proposed an answer; a reopened task with proposals goes back to verifying. */
  proposers: string[];
  correct?: boolean;
  independentSources?: number;
  /** Where a stuck solver found help; EvoMap wins over local once seen. */
  hit?: LibrarySource;
  hitTitles?: string[];
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
  spawnedAt: number;
  /** Joined a running swarm (runtime spawn) rather than at start. */
  late: boolean;
  quarantined: boolean;
  /** Demo ground truth only; the swarm itself is never told. */
  compromised: boolean;
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
  kind: ParticleKind;
}

export interface LinkView {
  a: string;
  b: string;
  counts: Record<LinkReason, number>;
  total: number;
}

export interface GeneView {
  id: string;
  cellId: string;
  domain: Domain;
  text: string;
  at: number;
  gossiped: number;
  adoptedBy: string[];
  rejectedBy: string[];
}

export type QuarantineAlarm = Body<"cell.quarantined">;
export type Denial = Body<"permission.denied">;
export type GuardAlarm = Body<"judge.guard">;
export type Compromise = Body<"cell.compromised">;
export type LibraryHit = Body<"library.hit">;
export type LibraryPublished = Body<"library.published">;

export interface LibraryView {
  loaded: { genes: number; precedents: number } | null;
  hits: LibraryHit[];
  published: LibraryPublished | null;
}

export interface RunView {
  runId: string | null;
  mode: Mode | null;
  simulated: boolean;
  config: RunConfig | null;
  startedAt: number | null;
  tasks: Record<string, TaskView>;
  cells: Record<string, CellView>;
  cards: Record<string, CapabilityCard>;
  metrics: LiveMetrics | null;
  metricsHistory: LiveMetrics[];
  decisions: Decision[];
  feed: FeedLine[];
  echoAlarms: EchoAlarm[];
  particles: Particle[];
  links: Record<string, LinkView>;
  genes: GeneView[];
  /** Oldest first, heartbeats excluded. */
  protocol: ProtocolMessage[];
  protocolCounts: Partial<Record<ProtocolType, number>>;
  quarantines: QuarantineAlarm[];
  compromises: Compromise[];
  denials: Denial[];
  guards: GuardAlarm[];
  faults: { jev: boolean; llm: boolean };
  library: LibraryView;
  report: ResearchReport | null;
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
  cards: {},
  metrics: null,
  metricsHistory: [],
  decisions: [],
  feed: [],
  echoAlarms: [],
  particles: [],
  links: {},
  genes: [],
  protocol: [],
  protocolCounts: {},
  quarantines: [],
  compromises: [],
  denials: [],
  guards: [],
  faults: { jev: false, llm: false },
  library: { loaded: null, hits: [], published: null },
  report: null,
  summary: null,
  seq: 0,
};

export function reduce(s: RunView, e: SwarmEvent): RunView {
  if (e.type === "run.started") return startRun(e);
  if (e.runId !== s.runId) return s;

  switch (e.type) {
    case "run.finished": {
      const m = e.summary.metrics;
      const accuracy = m.accuracyApplicable === false ? "准确率 N/A" : `准确率 ${(m.accuracy * 100).toFixed(1)}%`;
      const text = e.summary.aborted
        ? `中止 Aborted · ${e.summary.aborted}`
        : `完成 Finished · ${accuracy} · AIR ${m.air.toFixed(2)}`;
      return log({ ...s, summary: e.summary, metrics: m }, e.at, e.summary.aborted ? "warn" : "ok", text);
    }
    case "cell.spawned": {
      const late = s.startedAt !== null && e.at - s.startedAt > LATE_JOIN_MS;
      const next = {
        ...s,
        cells: {
          ...s.cells,
          [e.cellId]: {
            id: e.cellId,
            state: "idle",
            neighbors: e.neighbors,
            alive: true,
            solved: 0,
            genes: 0,
            spawnedAt: e.at,
            late,
            quarantined: false,
            compromised: false,
          } satisfies CellView,
        },
      };
      return late ? log(next, e.at, "ok", `加入 Joined ${e.cellId} · 即插即用 plug-and-play`) : next;
    }
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
    case "gene.created": {
      const gene: GeneView = {
        id: e.geneId,
        cellId: e.cellId,
        domain: e.domain,
        text: e.text,
        at: e.at,
        gossiped: 0,
        adoptedBy: [],
        rejectedBy: [],
      };
      return log(
        patchCell({ ...s, genes: capPush(s.genes, gene, CAP.genes) }, e.cellId, (c) => ({ ...c, genes: c.genes + 1 })),
        e.at,
        "gene",
        `基因生成 Gene ${e.geneId} ← ${e.cellId} · ${e.domain}`,
      );
    }
    case "gene.gossiped":
      return patchGene(
        { ...s, particles: capPush(s.particles, { from: e.fromCell, to: e.toCell, at: e.at, kind: "gene" }, CAP.particles) },
        e.geneId,
        (g) => ({ ...g, gossiped: g.gossiped + 1 }),
      );
    case "gene.adopted":
      return log(
        patchGene(
          patchCell(s, e.cellId, (c) => ({ ...c, genes: c.genes + 1 })),
          e.geneId,
          (g) => (g.adoptedBy.includes(e.cellId) ? g : { ...g, adoptedBy: [...g.adoptedBy, e.cellId] }),
        ),
        e.at,
        "gene",
        `基因采纳 Adopted ${e.geneId} → ${e.cellId}`,
      );
    case "gene.rejected":
      return log(
        patchGene(s, e.geneId, (g) =>
          g.rejectedBy.includes(e.cellId) ? g : { ...g, rejectedBy: [...g.rejectedBy, e.cellId] },
        ),
        e.at,
        "info",
        `基因拒收 Rejected ${e.geneId} @ ${e.cellId} · ${REJECT_REASON[e.reason]}`,
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
      return {
        ...s,
        metrics: e.metrics,
        metricsHistory: pushHistory(s.metricsHistory, e.metrics),
        faults:
          typeof e.metrics.jevDown !== "boolean" || e.metrics.jevDown === s.faults.jev
            ? s.faults
            : { ...s.faults, jev: e.metrics.jevDown },
      };
    case "log":
      return log(s, e.at, e.level === "error" ? "danger" : e.level === "warn" ? "warn" : "info", e.message);
    case "protocol.message": {
      const type = e.message.type;
      const protocolCounts = { ...s.protocolCounts, [type]: (s.protocolCounts[type] ?? 0) + 1 };
      // Heartbeats would evict every informative message from the capped trace; they are only counted.
      if (type === "HEARTBEAT") return { ...s, protocolCounts };
      return { ...s, protocolCounts, protocol: capPush(s.protocol, e.message, CAP.protocol) };
    }
    case "cell.card": {
      const next = { ...s, cards: { ...s.cards, [e.card.agentId]: e.card } };
      return e.card.status === "quarantined"
        ? patchCell(next, e.card.agentId, (c) => (c.quarantined ? c : { ...c, quarantined: true }))
        : next;
    }
    case "cell.quarantined":
      return log(
        patchCell({ ...s, quarantines: capPush(s.quarantines, body(e), CAP.alarms) }, e.cellId, (c) => ({
          ...c,
          quarantined: true,
        })),
        e.at,
        "danger",
        `隔离 Quarantined ${e.cellId} · 信任 trust ${e.trust.toFixed(2)} · ${e.reason}`,
      );
    case "cell.compromised":
      return log(
        patchCell({ ...s, compromises: capPush(s.compromises, body(e), CAP.alarms) }, e.cellId, (c) => ({
          ...c,
          compromised: true,
        })),
        e.at,
        "danger",
        `入侵 GHOST HACKED ${e.cellId} · 蜂群未被告知 swarm not told`,
      );
    case "permission.denied":
      return log(
        { ...s, denials: capPush(s.denials, body(e), CAP.alarms) },
        e.at,
        "danger",
        `越权拒绝 DENIED ${e.cellId} · ${e.action} · ${e.reason}`,
      );
    case "provider.fault":
      return log(
        { ...s, faults: { ...s.faults, [e.provider]: e.down } },
        e.at,
        e.down ? "warn" : "ok",
        e.provider === "jev"
          ? e.down
            ? "System 1 离线 Jev down → 降级 System 2"
            : "System 1 恢复 Jev back online"
          : e.down
            ? "System 2 离线 LLM down → 保守默认 conservative defaults"
            : "System 2 恢复 LLM back online",
      );
    case "judge.guard":
      return log(
        { ...s, guards: capPush(s.guards, body(e), CAP.alarms) },
        e.at,
        "warn",
        `校准守卫 Guard ${e.key} · 分歧 ${(e.disagreement * 100).toFixed(0)}% / ${e.window} → System 2`,
      );
    case "library.loaded":
      return log(
        { ...s, library: { ...s.library, loaded: { genes: e.genes, precedents: e.precedents } } },
        e.at,
        "gene",
        `继承经验 Library loaded · ${e.genes} genes · ${e.precedents} precedents`,
      );
    case "library.hit": {
      const withHit = patchTask(s, e.taskId, (t) => ({
        ...t,
        hit: t.hit === "evomap" ? "evomap" : e.source,
        hitTitles: [...new Set([...(t.hitTitles ?? []), ...e.titles])],
      }));
      return log(
        { ...withHit, library: { ...s.library, hits: capPush(s.library.hits, body(e), CAP.hits) } },
        e.at,
        "gene",
        `经验命中 ${e.source === "evomap" ? "EvoMap" : "本地 local"} hit · ${e.taskId} @ ${e.cellId} · ${e.titles.join(" / ")}`,
      );
    }
    case "library.published": {
      const passed = e.gate.filter((g) => g.passed).length;
      return log(
        { ...s, library: { ...s.library, published: body(e) } },
        e.at,
        "ok",
        `经验沉淀 Published · ${e.genes} genes · 验证门 gate ${passed}/${e.gate.length}${e.evomap ? ` · EvoMap ${e.evomap.status}` : ""}`,
      );
    }
    case "link.formed": {
      const [a, b] = e.from < e.to ? [e.from, e.to] : [e.to, e.from];
      const key = `${a}~${b}`;
      const prev = s.links[key] ?? { a, b, counts: { gossip: 0, review: 0, discover: 0 }, total: 0 };
      const link: LinkView = {
        ...prev,
        counts: { ...prev.counts, [e.reason]: prev.counts[e.reason] + 1 },
        total: prev.total + 1,
      };
      // Gossip already travels as a gene particle via gene.gossiped.
      const particles =
        e.reason === "review"
          ? capPush<Particle>(s.particles, { from: e.from, to: e.to, at: e.at, kind: "review" }, CAP.particles)
          : s.particles;
      return { ...s, particles, links: { ...s.links, [key]: link } };
    }
    case "research.report":
      return log(
        { ...s, report: e.report },
        e.at,
        "ok",
        `研究报告 Report · ${e.report.recommendation} · 金丝雀 canary ${e.report.canaryPassed}/${e.report.canaryTotal}`,
      );
    default:
      // Unknown event types from a newer server are ignored.
      return s;
  }
}

function startRun(e: Ev<"run.started">): RunView {
  const tasks: Record<string, TaskView> = {};
  for (const t of e.tasks) tasks[t.id] = { id: t.id, domain: t.domain, prompt: t.prompt, status: "open", proposers: [] };
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

function body<T extends SwarmEvent>(e: T): Omit<T, "type" | "runId"> {
  const { type: _type, runId: _runId, ...rest } = e;
  return rest;
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

function patchGene(s: RunView, id: string, fn: (g: GeneView) => GeneView): RunView {
  const i = s.genes.findIndex((g) => g.id === id);
  const g = s.genes[i];
  if (!g) return s;
  const genes = s.genes.slice();
  genes[i] = fn(g);
  return { ...s, genes };
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
