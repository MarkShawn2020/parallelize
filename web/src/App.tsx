import { useState } from "react";
import { errorText, kill } from "./api";
import { CompareTable } from "./components/CompareTable";
import { ControlBar } from "./components/ControlBar";
import { DecisionStream } from "./components/DecisionStream";
import { EchoBanner } from "./components/EchoBanner";
import { EventFeed } from "./components/EventFeed";
import { MetricsPanel } from "./components/MetricsPanel";
import { SwarmGraph } from "./components/SwarmGraph";
import { TaskGrid } from "./components/TaskGrid";
import { TokenChart } from "./components/TokenChart";
import { fmtClock } from "./format";
import { MODE_LABEL } from "./labels";
import { useRunStream, type ConnectionStatus } from "./useRunStream";

const GRAPH_HEIGHT = 340;
const CHART_HEIGHT = 170;

const STATUS: Record<ConnectionStatus, { label: string; dot: string }> = {
  live: { label: "在线 LIVE", dot: "bg-accent animate-pulse" },
  connecting: { label: "连接中 CONNECTING", dot: "bg-warn" },
  offline: { label: "离线 OFFLINE · 重连 retrying", dot: "bg-danger" },
};

export default function App() {
  const { view, status } = useRunStream();
  const [killError, setKillError] = useState<string | null>(null);
  const running = view.runId !== null && view.summary === null;
  const cells = Object.values(view.cells);
  const liveCells = cells.filter((c) => c.alive).length;
  const conn = STATUS[status];
  const online = status === "live";

  const killCell = (cellId: string) => {
    if (!view.runId) return;
    setKillError(null);
    kill(view.runId, cellId).catch((e: unknown) => setKillError(`击杀 kill ${cellId}: ${errorText(e)}`));
  };

  const graphEmpty = view.runId
    ? view.mode === "single" || view.mode === "subagent"
      ? "此模式无蜂群单元 No swarm cells in this mode"
      : "等待单元 Awaiting cells"
    : "等待运行 Awaiting run";

  return (
    <div className="mx-auto flex min-h-screen max-w-[1920px] flex-col gap-2 p-2">
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 border border-grid bg-panel/90 px-3 py-2">
        <h1 className="font-display text-2xl font-semibold tracking-[0.18em]">
          <span className="text-accent">並列化</span> <span className="text-fg">PARALLELIZE</span>{" "}
          <span className="text-muted">· SECTION 9</span>
        </h1>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm tabular-nums">
          {view.mode && (
            <span>
              <span className="text-muted">模式 Mode</span> <span className="text-fg">{MODE_LABEL[view.mode]}</span>
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

      <ControlBar runId={view.runId} running={running} simulated={view.simulated} liveCells={liveCells} online={online} />
      {killError && (
        <div role="alert" className="border border-danger/60 px-3 py-1 text-xs text-danger">
          {killError}
        </div>
      )}

      <main className="grid min-h-0 flex-1 grid-cols-1 gap-2 xl:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-2 xl:col-span-2">
          <SwarmGraph
            cells={view.cells}
            particles={view.particles}
            height={GRAPH_HEIGHT}
            canKill={running}
            onKill={killCell}
            emptyText={graphEmpty}
          />
          <TokenChart history={view.metricsHistory} height={CHART_HEIGHT} />
          <DecisionStream decisions={view.decisions} />
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <MetricsPanel metrics={view.metrics} cellsTotal={cells.length} />
          <TaskGrid tasks={view.tasks} />
          <EchoBanner alarms={view.echoAlarms} />
          <EventFeed feed={view.feed} startedAt={view.startedAt} className="max-h-[420px] min-h-[160px] flex-1 xl:max-h-none xl:basis-0" />
        </div>
      </main>

      <CompareTable refreshKey={`${online}:${view.summary?.runId ?? ""}`} className="max-h-[260px] xl:max-h-[210px]" />
    </div>
  );
}
