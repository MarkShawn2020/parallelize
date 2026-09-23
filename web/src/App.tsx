import { useEffect, useState } from "react";
import { SWARM_MODES } from "../../src/core/types";
import { errorText, kill } from "./api";
import { AlertRail } from "./components/AlertRail";
import { CompareTable } from "./components/CompareTable";
import { ControlBar } from "./components/ControlBar";
import { DecisionStream } from "./components/DecisionStream";
import { EchoBanner } from "./components/EchoBanner";
import { EventFeed } from "./components/EventFeed";
import { GeneCard, type GeneCardData } from "./components/GeneCard";
import { GeneChips } from "./components/GeneChips";
import { LibraryPanel } from "./components/LibraryPanel";
import { MetricsPanel } from "./components/MetricsPanel";
import { ProtocolTrace } from "./components/ProtocolTrace";
import { RegistryPanel } from "./components/RegistryPanel";
import { ResearchReport } from "./components/ResearchReport";
import { RuntimeBar } from "./components/RuntimeBar";
import { SidePanel, type SideTab, type TabSpec } from "./components/SidePanel";
import { SwarmGraph } from "./components/SwarmGraph";
import { TaskGrid } from "./components/TaskGrid";
import { TokenChart } from "./components/TokenChart";
import { fmtClock, fmtInt } from "./format";
import { MODE_LABEL } from "./labels";
import { toggleSelected } from "./selection";
import { useDefaults } from "./useDefaults";
import { useRunStream, type ConnectionStatus } from "./useRunStream";
import { useSavedReport } from "./useSavedReport";

const GRAPH_HEIGHT = 400;
const CHART_HEIGHT = 150;

const STATUS: Record<ConnectionStatus, { label: string; dot: string }> = {
  live: { label: "在线 LIVE", dot: "bg-accent animate-pulse" },
  connecting: { label: "连接中 CONNECTING", dot: "bg-warn" },
  offline: { label: "离线 OFFLINE · 重连 retrying", dot: "bg-danger" },
};

export default function App() {
  const { view, status } = useRunStream();
  const online = status === "live";
  const { defaults, error: defaultsError } = useDefaults(online);
  const [picked, setPicked] = useState<string[]>([]);
  const [focusTask, setFocusTask] = useState<string | null>(null);
  const [tab, setTab] = useState<SideTab>("events");
  const [gene, setGene] = useState<GeneCardData | null>(null);
  const [libraryEpoch, setLibraryEpoch] = useState(0);
  const [killError, setKillError] = useState<string | null>(null);

  const running = view.runId !== null && view.summary === null;
  const cells = Object.values(view.cells);
  const liveCells = cells.filter((c) => c.alive).length;
  const selected = picked.filter((id) => view.cells[id]?.alive);
  const conn = STATUS[status];
  const taskSource = view.config?.taskSource;
  const idea = taskSource?.kind === "research" ? taskSource.idea : null;
  const saved = useSavedReport(tab === "report" && !view.report && !idea);
  const shownSaved = view.report || idea ? null : saved;

  useEffect(() => {
    setPicked([]);
    setFocusTask(null);
    setKillError(null);
  }, [view.runId]);

  useEffect(() => {
    if (view.report) setTab("report");
  }, [view.report]);

  const toggleCell = (id: string) =>
    setPicked((prev) => {
      const live = prev.filter((x) => view.cells[x]?.alive);
      return view.cells[id]?.alive || live.includes(id) ? toggleSelected(live, id) : live;
    });
  const consumeSelection = (ids: string[]) => setPicked((prev) => prev.filter((x) => !ids.includes(x)));

  const killCell = (cellId: string) => {
    if (!view.runId) return;
    setKillError(null);
    kill(view.runId, cellId)
      .then(() => consumeSelection([cellId]))
      .catch((e: unknown) => setKillError(`杀节点 kill ${cellId}: ${errorText(e)}`));
  };

  const graphEmpty = view.runId
    ? view.mode && !SWARM_MODES.includes(view.mode)
      ? "此模式无蜂群单元 No swarm cells in this mode"
      : "等待单元 Awaiting cells"
    : "等待运行 Awaiting run";

  const cards = Object.values(view.cards);
  const protocolTotal = Object.values(view.protocolCounts).reduce((a, b) => a + (b ?? 0), 0);
  const quarantined = cells.filter((c) => c.quarantined).length;
  const tabs: TabSpec[] = [
    { id: "events", zh: "事件", en: "Events" },
    { id: "registry", zh: "注册表", en: "Registry", badge: cards.length ? String(cards.length) : undefined, alert: quarantined > 0 && tab !== "registry" },
    { id: "protocol", zh: "协议", en: "Protocol", badge: protocolTotal ? fmtInt(protocolTotal) : undefined },
    {
      id: "library",
      zh: "经验库",
      en: "Library",
      badge: view.library.hits.length ? String(view.library.hits.length) : undefined,
      alert: (view.library.hits.length > 0 || view.library.published !== null) && tab !== "library",
    },
    { id: "report", zh: "研究报告", en: "Report", alert: view.report !== null && tab !== "report" },
  ];

  const libraryKey = [
    online,
    view.runId,
    view.library.loaded ? 1 : 0,
    view.library.published ? 1 : 0,
    view.summary ? 1 : 0,
    libraryEpoch,
  ].join(":");

  return (
    <div className="mx-auto flex min-h-screen max-w-[1920px] flex-col gap-2 p-2">
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 border border-grid bg-panel/90 px-3 py-1.5">
        <h1 className="font-display text-2xl font-semibold tracking-[0.18em]">
          <span className="text-accent">並列化</span> <span className="text-fg">PARALLELIZE</span>{" "}
          <span className="text-muted">· SECTION 9</span>
        </h1>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm tabular-nums">
          {view.mode && (
            <span>
              <span className="text-muted">模式 Mode</span> <span className="text-fg">{MODE_LABEL[view.mode] ?? view.mode}</span>
              {idea && <span className="ml-2 bg-s1/20 px-1.5 text-xs text-s1">点子验证</span>}
              {view.config?.inherit && <span className="ml-1 bg-gene/20 px-1.5 text-xs text-gene">继承经验</span>}
            </span>
          )}
          {view.runId && (
            <span>
              <span className="text-muted">运行 Run</span> <span className="text-fg">{view.runId}</span>
              {view.summary && <span className="ml-2 text-ok">已完成 done</span>}
            </span>
          )}
          {view.metrics && (
            <span>
              <span className="text-muted">用时 T+</span> <span className="text-fg">{fmtClock(view.metrics.elapsedMs)}</span>
            </span>
          )}
          <span className="flex items-center gap-2">
            <span className={`size-2.5 rounded-full ${conn.dot}`} />
            <span className={status === "offline" ? "text-danger" : "text-muted"}>{conn.label}</span>
          </span>
        </div>
      </header>

      <ControlBar
        defaults={defaults}
        defaultsError={defaultsError}
        running={running}
        simulated={view.simulated}
        hasRun={view.runId !== null}
      />
      <RuntimeBar
        runId={view.runId}
        running={running}
        mode={view.mode}
        liveCells={liveCells}
        jevDown={view.faults.jev}
        selected={selected}
        models={defaults?.models ?? []}
        onConsumeSelection={consumeSelection}
        onLibraryReset={() => setLibraryEpoch((n) => n + 1)}
      />
      {killError && (
        <div role="alert" className="border border-danger/60 px-3 py-1 text-xs text-danger">
          {killError}
        </div>
      )}
      <AlertRail
        jevDown={running && view.faults.jev}
        llmDown={running && view.faults.llm}
        quarantines={view.quarantines}
        compromises={view.compromises}
        guards={view.guards}
        denials={view.denials}
      />

      <main className="grid min-h-0 flex-1 grid-cols-1 gap-2 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-2">
          <SwarmGraph
            cells={view.cells}
            cards={view.cards}
            links={view.links}
            particles={view.particles}
            height={GRAPH_HEIGHT}
            selected={selected}
            canAct={running}
            onToggle={toggleCell}
            onKill={killCell}
            emptyText={graphEmpty}
            overlay={view.genes.length > 0 ? <GeneChips genes={view.genes} max={3} onOpen={setGene} compact /> : undefined}
          />
          <TokenChart history={view.metricsHistory} height={CHART_HEIGHT} />
          <DecisionStream decisions={view.decisions} />
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <MetricsPanel metrics={view.metrics} cellsTotal={cells.length} />
          <TaskGrid tasks={view.tasks} focusTask={focusTask} onFocusTask={setFocusTask} />
          <EchoBanner alarms={view.echoAlarms} />
        </div>
        {/* On xl the side panel is absolutely placed so its content never grows the row; the other columns set the height. */}
        <div className="relative min-w-0">
          <SidePanel tabs={tabs} active={tab} onChange={setTab} className="h-[560px] xl:absolute xl:inset-0 xl:h-auto">
            {tab === "events" && <EventFeed feed={view.feed} startedAt={view.startedAt} />}
            {tab === "registry" && (
              <RegistryPanel
                cards={view.cards}
                cells={view.cells}
                selected={selected}
                reviewTrust={view.config?.reviewTrust}
                quarantineTrust={view.config?.quarantineTrust}
                onToggle={toggleCell}
              />
            )}
            {tab === "protocol" && <ProtocolTrace messages={view.protocol} counts={view.protocolCounts} startedAt={view.startedAt} />}
            {tab === "library" && (
              <LibraryPanel
                library={view.library}
                genes={view.genes}
                inherit={view.config?.inherit}
                inheritedGenes={view.metrics?.inheritedGenes}
                focusTask={focusTask}
                refreshKey={libraryKey}
                onFocusTask={setFocusTask}
                onOpenGene={setGene}
              />
            )}
            {tab === "report" && (
              <ResearchReport report={view.report ?? shownSaved?.report ?? null} savedRunId={shownSaved?.runId} idea={idea} tasks={view.tasks} />
            )}
          </SidePanel>
        </div>
      </main>

      <CompareTable refreshKey={`${online}:${view.summary?.runId ?? ""}`} className="max-h-[260px] xl:max-h-[220px]" />

      {gene && <GeneCard key={gene.id} gene={gene} onClose={() => setGene(null)} />}
    </div>
  );
}
