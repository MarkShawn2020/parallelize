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
import { fmtClock, truncate } from "./format";
import { DENY_ACTION_ZH, DOMAIN_ZH, JUDGE_KEY_ZH, REC_ZH, REJECT_ZH, denyReason, family, taskName } from "./stageText";

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
  story: 40,
  faultLog: 40,
  latencies: 500,
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

export type StoryTone = "info" | "ok" | "warn" | "danger" | "gene" | "s2";

export interface StoryLine {
  id: number;
  at: number;
  tone: StoryTone;
  /** Full narration line for the stage view. */
  text: string;
  /** Set for faults; the line is also appended to faultLog. */
  short?: string;
  /** Lines with the same key are updated in place (moved to newest, id kept). */
  key?: string;
  taskId?: string;
}

export interface Tally {
  jevCalls: number;
  jevCostUsd: number;
  s1Latencies: number[];
  reviews: number;
  gossiped: number;
  poisonBlocked: number;
  takeovers: number;
}

interface StoryPending {
  reopened: Record<string, { prev?: string; at: number }>;
  echo: Record<string, number>;
  verifier: Record<string, string>;
  killedAt: Record<string, number>;
  /** Throttle clocks per routine line kind, in event time. */
  lastAt: Record<string, number>;
  /** Repeat counts behind keyed lines ("deny:c3", "poison:c3"); the capped alarm lists cannot count past their cap. */
  counts: Record<string, number>;
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
  /** Stage narration, oldest first. */
  story: StoryLine[];
  /** Every fault line of the run, oldest first; survives the end of the run. */
  faultLog: StoryLine[];
  /** Counters accumulated here because the lists they derive from are capped. */
  tally: Tally;
  pending: StoryPending;
  /** Monotonic feed and story line id, used as a stable React key. */
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
  story: [],
  faultLog: [],
  tally: { jevCalls: 0, jevCostUsd: 0, s1Latencies: [], reviews: 0, gossiped: 0, poisonBlocked: 0, takeovers: 0 },
  pending: { reopened: {}, echo: {}, verifier: {}, killedAt: {}, lastAt: {}, counts: {} },
  seq: 0,
};

export function reduce(s: RunView, e: SwarmEvent): RunView {
  if (e.type === "run.started") return startRun(e);
  if (e.runId !== s.runId) return s;
  return narrate(apply(s, e), e);
}

function apply(s: RunView, e: SwarmEvent): RunView {
  switch (e.type) {
    case "run.finished": {
      const m = e.summary.metrics;
      const accuracy = m.accuracyApplicable === false ? "准确率 N/A" : `准确率 ${(m.accuracy * 100).toFixed(1)}%`;
      const text = e.summary.aborted
        ? `中止 Aborted · ${e.summary.aborted}`
        : `完成 Finished · ${accuracy}`;
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
  const n = e.tasks.length;
  const src = e.config.taskSource;
  const opening =
    src.kind === "research"
      ? `点子拆成 ${n} 条论断放上黑板，${e.config.cells} 个 Agent 各自核查，没有指挥官`
      : `${e.config.cells} 个 Agent 开跑：${n} 道${src.kind === "synthetic" && src.difficulty === "hard" ? "困难" : "普通"}数学题放上黑板，谁有空谁去领，没有指挥官`;
  return story(log(view, e.at, "info", text), e.at, "info", opening);
}

// ---------------------------------------------------------------- stage narration

interface StoryOpts {
  short?: string;
  key?: string;
  taskId?: string;
  /** [kind, ms]: skip a new line if the last line of this kind is younger than ms (event time). */
  throttle?: readonly [string, number];
}

const THROTTLE = {
  review: ["review", 4000],
  dispute: ["dispute", 4000],
  gene: ["gene", 5000],
  failed: ["failed", 3000],
} as const;

function story(s: RunView, at: number, tone: StoryTone, text: string, opts: StoryOpts = {}): RunView {
  const { short, key, taskId, throttle } = opts;
  const i = key === undefined ? -1 : s.story.findIndex((l) => l.key === key);
  const old = s.story[i];
  let pending = s.pending;
  // Fault lines and in-place updates are never throttled.
  if (!old && throttle && short === undefined) {
    const [kind, ms] = throttle;
    const last = pending.lastAt[kind];
    if (last !== undefined && at - last < ms) return s;
    pending = { ...pending, lastAt: { ...pending.lastAt, [kind]: at } };
  }
  const seq = old ? s.seq : s.seq + 1;
  const line: StoryLine = {
    id: old?.id ?? seq,
    at,
    tone,
    text,
    ...(short !== undefined ? { short } : {}),
    ...(key !== undefined ? { key } : {}),
    ...(taskId !== undefined ? { taskId } : {}),
  };
  let faultLog = s.faultLog;
  if (short !== undefined) {
    // A keyed rewrite (a joiner's model family arriving) corrects its fault entry where it stands.
    faultLog =
      old && faultLog.some((l) => l.id === old.id)
        ? faultLog.map((l) => (l.id === old.id ? { ...l, text, short } : l))
        : capPush(faultLog, line, CAP.faultLog);
  }
  const rest = old ? s.story.filter((_, j) => j !== i) : s.story;
  return { ...s, seq, pending, faultLog, story: capPush(rest, line, CAP.story) };
}

function withPending(s: RunView, patch: Partial<StoryPending>): RunView {
  return { ...s, pending: { ...s.pending, ...patch } };
}

function withTally(s: RunView, patch: Partial<Tally>): RunView {
  return { ...s, tally: { ...s.tally, ...patch } };
}

function omit<V>(rec: Record<string, V>, key: string): Record<string, V> {
  if (!(key in rec)) return rec;
  const { [key]: _drop, ...rest } = rec;
  return rest;
}

function count(s: RunView, key: string): [RunView, number] {
  const k = (s.pending.counts[key] ?? 0) + 1;
  return [withPending(s, { counts: { ...s.pending.counts, [key]: k } }), k];
}

/** "9.3" under ten seconds, whole seconds above. */
function secs(ms: number): string {
  const x = Math.max(0, ms) / 1000;
  return String(x < 10 ? Math.round(x * 10) / 10 : Math.round(x));
}

function joinText(cellId: string, fam: string): { text: string; short: string } {
  const tag = fam ? `（${fam}）` : "";
  return {
    text: `新 Agent ${cellId} 加入${tag}：亮出能力卡就开始领任务，没改代码、没重启`,
    short: `${cellId}${tag} 加入`,
  };
}

/** A different cell picking up a task that went back to the board. */
function takeover(s: RunView, at: number, taskId: string, cellId: string): RunView {
  const r = s.pending.reopened[taskId];
  if (!r) return s;
  const next = withPending(s, { reopened: omit(s.pending.reopened, taskId) });
  if (cellId === r.prev) return next;
  const t = taskName(taskId);
  const killedAt = r.prev !== undefined ? s.pending.killedAt[r.prev] : undefined;
  const wait = secs(at - (killedAt ?? r.at));
  const since = killedAt !== undefined ? `距 ${r.prev} 掉线 ${wait} 秒` : `距退回黑板 ${wait} 秒`;
  return story(withTally(next, { takeovers: s.tally.takeovers + 1 }), at, "ok", `${t} 由 ${cellId} 接手，${since}`, {
    short: `${t} 由 ${cellId} 接手（${wait} 秒）`,
    taskId,
  });
}

function settle(s: RunView, taskId: string): RunView {
  const p = s.pending;
  return withPending(s, { reopened: omit(p.reopened, taskId), echo: omit(p.echo, taskId), verifier: omit(p.verifier, taskId) });
}

/** Stage-view layer on top of the engineering reducer: story, fault log and tallies. Reads the post-event state. */
function narrate(s: RunView, e: SwarmEvent): RunView {
  switch (e.type) {
    case "run.finished": {
      const m = e.summary.metrics;
      if (e.summary.aborted) return story(s, e.at, "warn", `本轮已停止：已收下 ${m.accepted} 题，答对 ${m.correct} 题`);
      const tail = `用时 ${fmtClock(m.elapsedMs)}，花费 $${m.costUsd.toFixed(2)}${e.summary.simulated ? "（离线模拟，不作为成绩）" : ""}`;
      const head = m.accuracyApplicable === false ? `核查 ${m.tasksTotal} 条论断` : `${m.tasksTotal} 题答对 ${m.correct} 题`;
      return story(s, e.at, "ok", `本轮结束：${head}，${tail}`);
    }
    case "cell.spawned": {
      if (!s.cells[e.cellId]?.late) return s;
      const { text, short } = joinText(e.cellId, family(s.cards[e.cellId]?.model));
      return story(s, e.at, "ok", text, { short, key: `join:${e.cellId}` });
    }
    case "cell.card": {
      const id = e.card.agentId;
      const fam = family(e.card.model);
      const old = s.story.find((l) => l.key === `join:${id}`);
      if (!fam || !old || old.text.includes(`（${fam}）`)) return s;
      const { text, short } = joinText(id, fam);
      return story(s, old.at, old.tone, text, { short, key: `join:${id}` });
    }
    case "cell.killed": {
      const lease = s.config ? `（约 ${secs(s.config.leaseMs)} 秒）` : "";
      return story(
        withPending(s, { killedAt: { ...s.pending.killedAt, [e.cellId]: e.at } }),
        e.at,
        "danger",
        `${e.cellId} 被拔掉了。它手上的任务租约到期${lease}后会退回黑板`,
        { short: `${e.cellId} 被拔掉` },
      );
    }
    case "task.claimed": {
      const t = s.tasks[e.taskId];
      if (!t || isSettled(t) || t.proposers.includes(e.cellId)) return s;
      // The board emits task.verifying only for the proposer handing off; whoever then claims a verifying task is its verifier.
      const next =
        t.status === "verifying" ? withPending(s, { verifier: { ...s.pending.verifier, [e.taskId]: e.cellId } }) : s;
      return takeover(next, e.at, e.taskId, e.cellId);
    }
    case "task.verifying": {
      const t = s.tasks[e.taskId];
      if (!t || isSettled(t) || t.proposers.includes(e.cellId)) return s;
      return takeover(withPending(s, { verifier: { ...s.pending.verifier, [e.taskId]: e.cellId } }), e.at, e.taskId, e.cellId);
    }
    case "task.reopened": {
      const t = s.tasks[e.taskId];
      if (!t || isSettled(t)) return s;
      const name = taskName(e.taskId);
      const reopened = { ...s.pending.reopened, [e.taskId]: { ...(e.previousCell ? { prev: e.previousCell } : {}), at: e.at } };
      return story(
        withPending(s, { reopened }),
        e.at,
        "warn",
        `${name} 退回黑板${e.previousCell ? `（原来在 ${e.previousCell} 手里）` : ""}`,
        { short: `${name} 退回黑板`, taskId: e.taskId },
      );
    }
    case "task.accepted": {
      const name = taskName(e.taskId);
      const verifier = s.pending.verifier[e.taskId];
      const echoed = s.pending.echo[e.taskId] !== undefined;
      const next = settle(s, e.taskId);
      if (echoed && e.independentSources < 2) {
        // Never call a one-source accept "independently verified"; say what actually happened.
        return story(next, e.at, "warn", `${name} 没等到第二个独立来源，按现有答案收下（只有 1 个出处）`, {
          short: `${name} 只有 1 个出处就收下`,
          taskId: e.taskId,
        });
      }
      if (echoed) {
        const who = verifier ?? "另一个 Agent";
        return story(
          next,
          e.at,
          "ok",
          `${name} 重新复核：${who} 没看过原答案，独立做出结果 → ${e.independentSources} 个独立来源，收下`,
          { short: `${name} 由 ${who} 独立复核通过`, taskId: e.taskId },
        );
      }
      if (e.independentSources < 2 || verifier === undefined) return next;
      const original = s.tasks[e.taskId]?.proposers.find((p) => p !== verifier);
      const sources = e.independentSources === 2 ? "两个独立来源" : `${e.independentSources} 个独立来源`;
      return story(
        next,
        e.at,
        "ok",
        `${name}：${verifier} 独立重做，和 ${original ? `${original} ` : "原来"}的答案一致 → ${sources}，收下`,
        { taskId: e.taskId, throttle: THROTTLE.review },
      );
    }
    case "task.failed":
      return story(settle(s, e.taskId), e.at, "warn", `${taskName(e.taskId)} 没能收下（多次复核都没过）`, {
        taskId: e.taskId,
        throttle: THROTTLE.failed,
      });
    case "judge.decision": {
      const d = e.decision;
      let next = s;
      // While Jev is switched off every decision escalates without Jev being asked, so it does not count as a Jev call.
      if (d.tier === "system1" || (d.escalated && !d.guarded && !s.faults.jev)) {
        const t = s.tally;
        next = withTally(
          s,
          d.tier === "system1"
            ? {
                jevCalls: t.jevCalls + 1,
                jevCostUsd: t.jevCostUsd + d.usage.costUsd,
                s1Latencies: capPush(t.s1Latencies, d.latencyMs, CAP.latencies),
              }
            : { jevCalls: t.jevCalls + 1 },
        );
      }
      if (d.fallback) {
        // During a known LLM outage every System-2 call falls back; the outage line already says so.
        if (s.faults.llm) return next;
        return story(next, e.at, "warn", "大模型也没给出结果 → 按保守规则处理：不收经验、必须复核", {
          short: "大模型未响应 → 保守规则",
        });
      }
      if (d.key !== "dispute" || d.tier !== "system2") return next;
      const head = `${d.taskId ? `${taskName(d.taskId)} ` : ""}两个答案对不上`;
      // Neither a guarded key nor a Jev outage involves Jev being unsure, so those lines do not say it was.
      const text = d.guarded
        ? `${head} → 这类判断已直接交给大模型`
        : s.faults.jev
          ? `${head} → 交给大模型裁决`
          : `${head}，Jev 拿不准 → 交给大模型裁决`;
      return story(next, e.at, "s2", text, {
        ...(d.taskId ? { taskId: d.taskId } : {}),
        throttle: THROTTLE.dispute,
      });
    }
    case "link.formed":
      return e.reason === "review" ? withTally(s, { reviews: s.tally.reviews + 1 }) : s;
    case "gene.gossiped":
      return withTally(s, { gossiped: s.tally.gossiped + 1 });
    case "gene.adopted": {
      const g = s.genes.find((x) => x.id === e.geneId);
      if (!g) return s;
      const what = `${g.cellId} 的${DOMAIN_ZH[g.domain]}经验`;
      const text = g.adoptedBy.length <= 1 ? `${what}，被 ${e.cellId} 收下了` : `${what}，已被 ${g.adoptedBy.length} 个邻居收下`;
      return story(s, e.at, "gene", text, { key: `gene:${g.id}`, throttle: THROTTLE.gene });
    }
    case "gene.rejected": {
      const sender = s.genes.find((x) => x.id === e.geneId)?.cellId;
      // "untrusted" only means the sender's trust is low; an honest unlucky cell must not be called a poisoner on stage.
      const poison = (sender !== undefined && s.cells[sender]?.compromised === true) || e.reason === "sanitize";
      if (!poison) return s;
      const counted = withTally(s, { poisonBlocked: s.tally.poisonBlocked + 1 });
      if (sender === undefined) return counted;
      const [next, k] = count(counted, `poison:${sender}`);
      const opts = { key: `poison:${sender}` };
      return k === 1
        ? story(next, e.at, "danger", `${e.cellId} 拒收了 ${sender} 发来的 Gene：${REJECT_ZH[e.reason] ?? "内容可疑"}`, {
            ...opts,
            short: `邻居开始拒收 ${sender} 的毒 Gene`,
          })
        : story(next, e.at, "danger", `${sender} 发的毒 Gene 已被邻居拒收 ${k} 次`, opts);
    }
    case "echo.detected": {
      const name = taskName(e.taskId);
      // Whoever verified before the alarm saw the echoed answer; only the next claimant counts as independent.
      const pending = withPending(s, { echo: { ...s.pending.echo, [e.taskId]: e.at }, verifier: omit(s.pending.verifier, e.taskId) });
      // Every further copy re-fires the alarm on the same task; one line updated in place keeps other faults in view.
      const [next, k] = count(pending, `echo:${e.taskId}`);
      return story(
        next,
        e.at,
        "danger",
        `回声警报：${name} 有 ${e.agreeing} 份一样的答案，但只有 ${e.independentSources} 个出处 → 虚假共识，退回黑板，只让没看过答案的 Agent 复核`,
        { key: `echo:${e.taskId}`, taskId: e.taskId, ...(k === 1 ? { short: `${name} 回声警报：${e.agreeing} 份答案 ${e.independentSources} 个出处` } : {}) },
      );
    }
    case "cell.compromised":
      return story(s, e.at, "danger", `${e.cellId} 被入侵：开始交错答案、发毒 Gene。蜂群没被告知，只能靠复核发现`, {
        short: `${e.cellId} 被入侵`,
      });
    case "cell.quarantined": {
      const trust = e.trust.toFixed(2);
      const below = s.config ? `（低于 ${s.config.quarantineTrust}）` : " ";
      return story(s, e.at, "danger", `${e.cellId} 信誉降到 ${trust}${below}→ 已隔离，它手上的任务退回黑板`, {
        short: `${e.cellId} 被隔离（信誉 ${trust}）`,
      });
    }
    case "permission.denied": {
      // A killed or lease-expired honest cell also gets denied; only the hacked cell's attempts are misbehaviour.
      if (s.cells[e.cellId]?.compromised !== true) return s;
      const [next, k] = count(s, `deny:${e.cellId}`);
      const text = `${e.cellId} 想${DENY_ACTION_ZH[e.action] ?? "越权操作"}，被拦下：${denyReason(e.reason)}${k > 1 ? ` ×${k}` : ""}`;
      return story(next, e.at, "danger", text, {
        key: `deny:${e.cellId}`,
        ...(k === 1 ? { short: `${e.cellId} 越权操作被拦下` } : {}),
      });
    }
    case "provider.fault":
      if (e.provider === "jev") {
        return e.down
          ? story(s, e.at, "warn", "Jev 断开 → 所有判断改由大模型来做：慢一点、贵一点，但不停", {
              short: "Jev 断开 → 改由大模型判断，没有停机",
            })
          : story(s, e.at, "ok", "Jev 恢复，判断重新走快速通道", { short: "Jev 恢复" });
      }
      return e.down
        ? story(s, e.at, "warn", "大模型断开 → 按保守规则处理：不收经验、必须复核、任务回黑板", {
            short: "大模型断开 → 保守规则",
          })
        : story(s, e.at, "ok", "大模型恢复", { short: "大模型恢复" });
    case "judge.guard": {
      const what = JUDGE_KEY_ZH[e.key] ?? e.key;
      return story(
        s,
        e.at,
        "warn",
        `Jev 在「${what}」上，最近 ${e.window} 次有 ${Math.round(e.disagreement * e.window)} 次和大模型不一致 → 这一类判断自动交还大模型`,
        { short: `Jev 在「${what}」上不准 → 交还大模型` },
      );
    }
    case "library.hit": {
      const name = taskName(e.taskId);
      const first = e.titles[0];
      const title = first ? `《${truncate(first, 24)}》` : "";
      return e.source === "evomap"
        ? story(s, e.at, "gene", `${name} 卡住了 → ${e.cellId} 去 EvoMap 找到别人的经验${title}：先过滤，复核通过才算数`, {
            short: `${name} 用上 EvoMap 的经验`,
            taskId: e.taskId,
          })
        : story(s, e.at, "gene", `${name} 卡住了 → ${e.cellId} 在本地经验库找到${title || "经验"}`, { taskId: e.taskId });
    }
    case "library.loaded":
      return story(s, e.at, "gene", `继承上一轮的经验：${e.genes} 条 Gene、${e.precedents} 条判例`);
    case "library.published": {
      // `genes` counts what went into the local library; EvoMap only received the assets it acknowledged.
      const sent = e.evomap?.assetIds.length ?? 0;
      if (sent === 0) return story(s, e.at, "ok", `验证有效的经验存进本地经验库：${e.genes} 条`);
      const passed = e.gate.filter((g) => g.passed).length;
      return story(s, e.at, "ok", `验证有效的经验已发回 EvoMap：${sent} 条（新题 A/B 过门 ${passed}/${e.gate.length}）`, {
        short: `经验发回 EvoMap ${sent} 条`,
      });
    }
    case "research.report":
      return story(
        s,
        e.at,
        "ok",
        `点子验证完成：结论${REC_ZH[e.report.recommendation]} · 金丝雀 ${e.report.canaryPassed}/${e.report.canaryTotal} 判对`,
      );
    default:
      return s;
  }
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
