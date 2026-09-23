import { useEffect, useReducer, useState } from "react";
import type { SwarmEvent } from "../../../src/core/types";
import { SwarmGraph } from "../components/SwarmGraph";
import { PROTOCOL_LABEL, PROTOCOL_TEXT } from "../labels";
import { describeBody } from "../protocolText";
import { StoryPanel } from "../stage/StoryPanel";
import { initialRunView, reduce, type RunView } from "../state";
import { parseEvent } from "../useRunStream";

/** The main comparison's Jev swarm: 96 hard tasks, Haiku 4.5, 8 cells, real Jev. */
export const REPLAY_RUN = "swarm-jev-20260923-151902-323c";
const SPEEDS = [4, 8, 16] as const;
const TICKER = 9;

type Status = "loading" | "playing" | "done" | "error";

const reduceBatch = (s: RunView, batch: SwarmEvent[]): RunView => batch.reduce(reduce, s);

/**
 * Replays a saved run on its own clock, so the landing page shows a real swarm without spending on a new run.
 * The stream ships with the site (web/public/replay), so the replay also works on a static deploy with no server.
 */
function useReplay(runId: string, speed: number, epoch: number): { view: RunView; status: Status; progress: number } {
  const [view, dispatch] = useReducer(reduceBatch, initialRunView);
  const [status, setStatus] = useState<Status>("loading");
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let frame = 0;
    setStatus("loading");
    fetch(`/replay/${encodeURIComponent(runId)}.jsonl`)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.text();
      })
      .then((text) => {
        if (cancelled) return;
        const events = text
          .split("\n")
          .map(parseEvent)
          .filter((e): e is SwarmEvent => e !== null);
        const first = events[0];
        const last = events.at(-1);
        if (!first || !last) throw new Error("empty");
        const span = Math.max(1, last.at - first.at);
        const started = performance.now();
        let i = 0;
        const tick = () => {
          if (cancelled) return;
          const now = first.at + (performance.now() - started) * speed;
          const batch: SwarmEvent[] = [];
          while (i < events.length && (events[i]?.at ?? Infinity) <= now) batch.push(events[i++] as SwarmEvent);
          if (batch.length) {
            dispatch(batch);
            setProgress(Math.min(1, (now - first.at) / span));
          }
          if (i < events.length) frame = requestAnimationFrame(tick);
          else setStatus("done");
        };
        setStatus("playing");
        frame = requestAnimationFrame(tick);
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [runId, speed, epoch]);

  return { view, status, progress };
}

export function ReplaySwarm() {
  const [speed, setSpeed] = useState<number>(8);
  const [epoch, setEpoch] = useState(0);
  const { view, status, progress } = useReplay(REPLAY_RUN, speed, epoch);
  const m = view.metrics;
  const messages = view.protocol.slice(-TICKER).reverse();

  if (status === "error") {
    return (
      <div className="border border-grid bg-panel p-6 text-fg/80">
        回放文件没有加载成功，刷新页面再试；也可以直接点「进入现场演示」跑一轮新的。
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <span className="text-fg/80">
          回放：2026-09-23 真实运行 · Haiku 4.5 做题 · Jev 判断 · 96 道困难题 · 8 个 Agent
        </span>
        <span className="font-mono text-muted tabular-nums">
          {status === "loading" ? "加载中…" : `${Math.round(progress * 100)}%`}
          {m && ` · 已收下 ${m.accepted} · 答对 ${m.correct}`}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSpeed(s)}
              aria-pressed={speed === s}
              className={`border px-2 py-0.5 font-mono ${speed === s ? "border-accent text-accent" : "border-grid text-muted hover:text-fg"}`}
            >
              {s}×
            </button>
          ))}
          <button type="button" onClick={() => setEpoch((n) => n + 1)} className="border border-grid px-3 py-0.5 text-fg hover:border-fg">
            重新播放
          </button>
        </span>
      </div>
      <div className="h-1 bg-grid" aria-hidden>
        <div className="h-full bg-accent" style={{ width: `${progress * 100}%` }} />
      </div>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <SwarmGraph
          variant="stage"
          cells={view.cells}
          cards={view.cards}
          links={view.links}
          particles={view.particles}
          decisions={view.decisions}
          height={380}
          selected={[]}
          canAct={false}
          onToggle={() => {}}
          onKill={() => {}}
          emptyText="加载回放…"
        />
        <div className="flex min-h-0 flex-col gap-3">
          <div className="h-[260px] min-h-0">
            <StoryPanel story={view.story} startedAt={view.startedAt} onOpenTask={() => {}} />
          </div>
          <section className="flex min-h-0 flex-1 flex-col border border-grid bg-panel/90">
            <h3 className="border-b border-grid px-4 py-2 text-base font-semibold text-fg">Agent 之间的消息</h3>
            <ul className="flex flex-col gap-1 px-4 py-2 font-mono text-sm">
              {messages.map((msg) => (
                <li key={msg.id} className="flex gap-2 whitespace-nowrap">
                  <span className={`w-20 shrink-0 ${PROTOCOL_TEXT[msg.type]}`}>{PROTOCOL_LABEL[msg.type]}</span>
                  <span className="shrink-0 text-fg/80">
                    {msg.from} → {msg.to === "*" ? "全体" : msg.to}
                  </span>
                  <span className="min-w-0 truncate text-muted">{describeBody(msg.body)}</span>
                </li>
              ))}
              {messages.length === 0 && <li className="text-muted">等待第一条消息…</li>}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
