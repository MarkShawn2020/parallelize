import { useEffect, useRef } from "react";
import type { TaskStatus } from "../../../src/core/types";
import { truncate } from "../format";
import { DOMAIN_LABEL, SOURCE_LABEL, TASK_STATUS_BG, TASK_STATUS_LABEL } from "../labels";
import type { LibrarySource, TaskView } from "../state";
import { Panel } from "./Panel";

interface Props {
  tasks: Record<string, TaskView>;
  focusTask: string | null;
  onFocusTask: (taskId: string | null) => void;
}

const STATUSES: TaskStatus[] = ["open", "claimed", "verifying", "accepted", "failed"];
const HIT_DOT: Record<LibrarySource, string> = { local: "bg-accent", evomap: "bg-s2" };

function ring(t: TaskView): string {
  if (t.status !== "accepted") return "";
  return t.correct ? "ring-2 ring-inset ring-ok" : "ring-2 ring-inset ring-danger";
}

function tooltip(t: TaskView): string {
  const parts = [t.id, DOMAIN_LABEL[t.domain] ?? t.domain, TASK_STATUS_LABEL[t.status]];
  if (t.claimedBy) parts.push(`@${t.claimedBy}`);
  if (t.status === "accepted") parts.push(t.correct ? "正确 correct" : "错误 wrong", `独立来源 sources ${t.independentSources ?? 0}`);
  if (t.hit) parts.push(`${SOURCE_LABEL[t.hit]} 命中 hit`);
  return parts.join(" · ");
}

export function TaskGrid({ tasks, focusTask, onFocusTask }: Props) {
  const list = Object.values(tasks);
  const count = (s: TaskStatus) => list.filter((t) => t.status === s).length;
  const wrong = list.filter((t) => t.status === "accepted" && t.correct === false).length;
  const hits = list.filter((t) => t.hit).length;
  // On stage the hit dot is a few pixels wide; the header count jumps straight to a hit, EvoMap first.
  const hitTarget = list.find((t) => t.hit === "evomap") ?? list.find((t) => t.hit);
  const cellSize = list.length > 200 ? "minmax(9px,1fr)" : list.length > 100 ? "minmax(14px,1fr)" : "minmax(20px,1fr)";
  const focused = focusTask ? tasks[focusTask] : undefined;
  const focusedRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    focusedRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focusTask]);

  return (
    <Panel
      title="任务"
      en="Tasks"
      right={
        <span className="text-xs text-muted tabular-nums">
          {list.length} 个 · <span className="text-ok">✓ {count("accepted") - wrong}</span> <span className="text-danger">✗ {wrong}</span>
          {hits > 0 && hitTarget && (
            <>
              {" · "}
              <button type="button" onClick={() => onFocusTask(hitTarget.id)} className="text-s2 underline-offset-2 hover:underline" title="打开命中的任务 open a hit task">
                命中 {hits}
              </button>
            </>
          )}
        </span>
      }
    >
      <div className="flex flex-col gap-2 px-3 py-2">
        {list.length === 0 ? (
          <div className="py-3 text-center text-sm text-muted">等待任务 Awaiting tasks</div>
        ) : (
          <div className="grid max-h-[180px] gap-[3px] overflow-y-auto" style={{ gridTemplateColumns: `repeat(auto-fill, ${cellSize})` }}>
            {list.map((t) => {
              const isFocused = t.id === focusTask;
              return (
                <button
                  key={t.id}
                  ref={isFocused ? focusedRef : undefined}
                  type="button"
                  title={tooltip(t)}
                  aria-pressed={isFocused}
                  onClick={() => onFocusTask(isFocused ? null : t.id)}
                  className={`relative aspect-square border border-grid transition-colors duration-300 ${TASK_STATUS_BG[t.status]} ${ring(t)} ${
                    t.status === "failed" ? "border-dashed border-danger" : ""
                  } ${isFocused ? "z-10 animate-pulse outline-2 outline-offset-1 outline-fg" : ""}`}
                >
                  {t.hit && (
                    <span aria-hidden className={`absolute top-0 right-0 size-1/3 min-h-1.5 min-w-1.5 ${HIT_DOT[t.hit]}`} />
                  )}
                </button>
              );
            })}
          </div>
        )}
        {focused ? (
          <div className="flex flex-col gap-0.5 border border-fg/60 bg-panel-2 px-2 py-1.5 text-xs">
            <div className="flex flex-wrap items-center gap-x-2">
              <span className="font-semibold text-fg">{focused.id}</span>
              <span className="text-muted">{DOMAIN_LABEL[focused.domain] ?? focused.domain}</span>
              <span className="text-muted">{TASK_STATUS_LABEL[focused.status]}</span>
              {focused.proposers.length > 0 && <span className="text-muted">提交 {focused.proposers.join(", ")}</span>}
              {focused.status === "accepted" && (
                <span className={focused.correct ? "text-ok" : "text-danger"}>
                  {focused.correct ? "正确" : "错误"} · 独立来源 {focused.independentSources ?? 0}
                </span>
              )}
              <button type="button" onClick={() => onFocusTask(null)} className="ml-auto text-muted hover:text-fg" aria-label="关闭 close">
                ✕
              </button>
            </div>
            {focused.hit && (
              <div className={focused.hit === "evomap" ? "text-s2" : "text-accent"}>
                {SOURCE_LABEL[focused.hit]} 命中 · {focused.hitTitles?.join(" / ")}
              </div>
            )}
            <div className="text-fg/75">{truncate(focused.prompt, 220)}</div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted tabular-nums">
            {STATUSES.map((s) => (
              <span key={s} className="flex items-center gap-1.5">
                <span className={`size-2.5 border border-grid ${TASK_STATUS_BG[s]}`} />
                {TASK_STATUS_LABEL[s]} <span className="text-fg">{count(s)}</span>
              </span>
            ))}
            <span className="flex items-center gap-1.5">
              <span className="size-2 bg-s2" />
              EvoMap 命中
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2 bg-accent" />
              本地命中
            </span>
          </div>
        )}
      </div>
    </Panel>
  );
}
