import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { GeneCardData } from "../components/GeneCard";
import { GeneChips } from "../components/GeneChips";
import { SwarmGraph } from "../components/SwarmGraph";
import type { RunView, StoryLine } from "../state";
import { DOMAIN_ZH, taskName } from "../stageText";
import { useFlash } from "../useFlash";
import { FaultLog } from "./FaultLog";
import { IdleCard } from "./IdleCard";
import { ProtocolStrip } from "./ProtocolStrip";
import { Scoreboard } from "./Scoreboard";
import { StoryPanel } from "./StoryPanel";

interface Props {
  view: RunView;
  running: boolean;
  selected: string[];
  onToggle: (cellId: string) => void;
  onKill: (cellId: string) => void;
  onOpenGene: (gene: GeneCardData) => void;
  onEvidence: () => void;
}

const BANNER_MS = 8000;
// SwarmGraph's own title bar (h-11) and legend row (h-10); the canvas gets the rest of its grid cell.
const GRAPH_HEADER_REM = 2.75 + 2.5;

const BANNER_TONE: Record<StoryLine["tone"], string> = {
  danger: "border-danger bg-danger/20 text-danger animate-echo",
  warn: "border-alert bg-alert/15 text-alert",
  s2: "border-s2 bg-s2/15 text-s2",
  gene: "border-gene bg-gene/15 text-gene",
  ok: "border-ok bg-ok/15 text-ok",
  info: "border-grid bg-panel-2 text-fg",
};

/** The graph cell is flex-sized, so rows that come and go (banner, end-of-run summary) shrink the canvas instead of overflowing. */
function useCanvasHeight(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = (cell: number) => {
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      setH(Math.max(200, Math.floor(cell - GRAPH_HEADER_REM * rem - 2)));
    };
    apply(el.getBoundingClientRect().height);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) apply(entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, h];
}

export function StageLive({ view, running, selected, onToggle, onKill, onOpenGene, onEvidence }: Props) {
  const [graphCell, height] = useCanvasHeight();
  const [taskId, setTaskId] = useState<string | null>(null);
  const flash = useFlash(view.faultLog.at(-1), BANNER_MS);
  const jevBanner = running && view.faults.jev;
  const task = taskId ? view.tasks[taskId] : undefined;

  useEffect(() => setTaskId(null), [view.runId]);
  useEffect(() => {
    if (!taskId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTaskId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [taskId]);

  const m = view.metrics;
  const hasRun = view.runId !== null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="grid min-h-0 flex-1 grid-cols-[62fr_38fr] gap-2">
        <div className="flex min-h-0 min-w-0 flex-col gap-2">
          <div ref={graphCell} className="relative min-h-0 flex-1 overflow-hidden">
            {height === 0 ? null : hasRun ? (
              <SwarmGraph
                variant="stage"
                cells={view.cells}
                cards={view.cards}
                links={view.links}
                particles={view.particles}
                decisions={view.decisions}
                height={height}
                selected={selected}
                canAct={running}
                onToggle={onToggle}
                onKill={onKill}
                emptyText="等待 Agent 上线"
                overlay={view.genes.length > 0 ? <GeneChips variant="stage" genes={view.genes} max={2} onOpen={onOpenGene} /> : undefined}
              />
            ) : (
              <div className="grid h-full border border-grid bg-panel/90">
                <IdleCard />
              </div>
            )}
          </div>
          {/* Reserved row: the banner comes and goes without shifting the layout. */}
          <div
            role="status"
            className={`flex min-h-[3.25rem] items-center justify-center border-2 px-4 py-1.5 text-center text-xl ${
              jevBanner ? BANNER_TONE.s2 : flash ? BANNER_TONE[flash.tone] : "border-transparent"
            }`}
          >
            {jevBanner ? "Jev 已断开 → 全部判断交给大模型：慢一点、贵一点，但不停" : flash?.text}
          </div>
          {view.summary && m && (
            <p className="border border-grid bg-panel/90 px-4 py-2 text-lg text-fg">
              本轮：互相复核 {view.tally.reviews} 次 · Gene 传出 {view.tally.gossiped} 次、被收下 {m.genesAdopted} 次 · 掉线接手 {view.tally.takeovers} 次 · 隔离{" "}
              {m.quarantined} 个
            </p>
          )}
          <ProtocolStrip counts={view.protocolCounts} />
        </div>
        <div className="flex min-h-0 min-w-0 flex-col gap-2">
          <div className="min-h-0 flex-[58]">
            <StoryPanel story={view.story} startedAt={view.startedAt} onOpenTask={setTaskId} />
          </div>
          <div className="min-h-0 flex-[42]">
            <FaultLog lines={view.faultLog} startedAt={view.startedAt} />
          </div>
        </div>
      </div>

      <Scoreboard view={view} onOpenHit={setTaskId} />

      <footer className="flex flex-wrap items-center justify-between gap-x-6 border border-grid bg-panel/90 px-4 py-1.5 text-base">
        <span className="text-fg">
          同一个模型 Claude Haiku 4.5 · 96 道困难题：单 Agent <span className="text-muted">64%</span> → 只并行{" "}
          <span className="text-fg">80%</span> → JIS 蜂群 <span className="font-semibold text-accent">89%</span>
        </span>
        <button type="button" onClick={onEvidence} className="text-muted hover:text-fg">
          按 2 看完整对比 ›
        </button>
      </footer>

      {task && (
        <div
          role="dialog"
          aria-label={taskName(task.id)}
          className="fixed inset-0 z-50 grid place-items-center bg-bg/75"
          onClick={() => setTaskId(null)}
        >
          <div className="w-[min(760px,92vw)] border-2 border-fg/70 bg-panel p-6 text-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-4">
              <p className="text-fg">
                {taskName(task.id)}（{DOMAIN_ZH[task.domain] ?? task.domain}）· {task.proposers.length} 个 Agent 交了答案 ·{" "}
                {task.status === "accepted" ? (
                  <span className={task.correct ? "text-ok" : "text-danger"}>{task.correct ? "答对了" : "答错了"}</span>
                ) : (
                  <span className="text-muted">还没收下</span>
                )}
              </p>
              <button type="button" onClick={() => setTaskId(null)} className="shrink-0 border border-grid px-3 py-1 text-base text-muted hover:text-fg">
                关闭
              </button>
            </div>
            {task.hit && (
              <p className={`mt-3 ${task.hit === "evomap" ? "text-s2" : "text-accent"}`}>
                卡住了 → 去{task.hit === "evomap" ? " EvoMap " : "本地经验库"}找到经验《{task.hitTitles?.[0] ?? "—"}》→ 先过滤，复核通过才算数
              </p>
            )}
            {(task.independentSources ?? 0) >= 2 && <p className="mt-3 text-ok">{task.independentSources} 个独立来源一致</p>}
            {/* Hard problems run 260-790 characters; a clipped one hides the very facts the answer depends on. */}
            <p className="mt-4 max-h-[40vh] overflow-y-auto font-mono text-base leading-relaxed text-fg/85">{task.prompt}</p>
          </div>
        </div>
      )}
    </div>
  );
}
