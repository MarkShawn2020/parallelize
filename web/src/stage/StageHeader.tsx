import { fmtClock } from "../format";
import type { RunView } from "../state";

export type StagePage = "live" | "evidence" | "research";

const PAGES: ReadonlyArray<[StagePage, string, string]> = [
  ["live", "现场", "1"],
  ["evidence", "证据", "2"],
  ["research", "点子验证", "3"],
];

interface Props {
  view: RunView;
  page: StagePage;
  offline: boolean;
  onPage: (page: StagePage) => void;
  onEngineering: () => void;
  onHome: () => void;
  /** Back to the idle card after a finished run (key 0). */
  onStandby: () => void;
}

/** One sentence a judge can read from two metres away; no run ids, no connection jargon. */
export function statusLine(view: RunView): string {
  const m = view.metrics;
  if (!view.runId) return "待命 · 点「开始」让蜂群开跑";
  const cells = Object.keys(view.cells).length;
  const research = view.config?.taskSource?.kind === "research";
  const accepted = m?.accepted ?? 0;
  const correct = m?.correct ?? 0;
  const clock = fmtClock(m?.elapsedMs ?? 0);
  if (view.summary?.aborted) return research ? `本轮已停止 · 已定 ${accepted} 条论断` : `本轮已停止 · 已收下 ${accepted} · 答对 ${correct}`;
  if (view.summary) {
    const cost = `$${view.summary.metrics.costUsd.toFixed(2)}`;
    return research
      ? `本轮完成 · ${view.summary.metrics.tasksTotal} 条论断已定 · 用时 ${clock} · 花费 ${cost}`
      : `本轮完成 · ${view.summary.metrics.tasksTotal} 题答对 ${correct} · 用时 ${clock} · 花费 ${cost}`;
  }
  if (research) return `${cells} 个 Agent · 核查 ${m?.tasksTotal ?? 0} 条论断 · 已定 ${accepted}`;
  const source = view.config?.taskSource;
  const level = source?.kind === "synthetic" && source.difficulty === "hard" ? "困难" : "普通";
  return `${cells} 个 Agent · ${m?.tasksTotal ?? view.config?.n ?? 0} 道${level}数学题 · 已收下 ${accepted} · 答对 ${correct} · 用时 ${clock}`;
}

export function StageHeader({ view, page, offline, onPage, onEngineering, onHome, onStandby }: Props) {
  return (
    <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border border-grid bg-panel/90 px-4 py-2">
      <h1 className="shrink-0 font-display text-2xl font-semibold tracking-[0.18em]">
        <button type="button" onClick={onStandby} title="回到待命（按 0）" className="flex items-center gap-3">
          <span className="text-accent">JIS</span>
          <span className="text-fg">JEV IN THE SHELL</span>
          {offline && <span title="服务器连接中断，正在重连" className="size-3 rounded-full bg-danger" />}
        </button>
      </h1>
      <p className="min-w-0 flex-1 text-xl text-fg tabular-nums">{statusLine(view)}</p>
      {view.runId &&
        (view.simulated ? (
          <span className="shrink-0 border border-muted px-3 py-1 text-base text-muted">离线模拟 · 数字不作为成绩</span>
        ) : (
          <span className="shrink-0 border border-ok px-3 py-1 text-base text-ok">真实模型</span>
        ))}
      <nav className="flex shrink-0 border border-grid" aria-label="讲解页">
        {PAGES.map(([id, label, key]) => (
          <button
            key={id}
            type="button"
            onClick={() => onPage(id)}
            aria-pressed={page === id}
            className={`px-4 py-1.5 text-base transition-colors ${page === id ? "bg-accent text-bg" : "text-fg hover:bg-panel-2"}`}
          >
            {label} <span className={page === id ? "text-bg/70" : "text-muted"}>{key}</span>
          </button>
        ))}
      </nav>
      <button type="button" onClick={onEngineering} className="shrink-0 border border-grid px-3 py-1.5 text-base text-muted hover:border-fg hover:text-fg">
        工程视图 <span className="text-muted">E</span>
      </button>
      <button type="button" onClick={onHome} className="shrink-0 border border-grid px-3 py-1.5 text-base text-muted hover:border-fg hover:text-fg">
        首页
      </button>
    </header>
  );
}
