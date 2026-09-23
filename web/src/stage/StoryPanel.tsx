import type { ReactNode } from "react";
import { fmtClock } from "../format";
import type { StoryLine, StoryTone } from "../state";

interface FrameProps {
  title: string;
  right?: ReactNode;
  className?: string;
  children: ReactNode;
}

/** Stage counterpart of Panel: a Chinese-only header, sized in rem so it scales with the stage root font. */
export function StagePanel({ title, right, className = "", children }: FrameProps) {
  return (
    <section className={`flex min-h-0 min-w-0 flex-col border border-grid bg-panel/90 ${className}`}>
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-grid px-4 py-1.5">
        <h2 className="flex items-center gap-2 text-xl font-semibold text-fg">
          <span aria-hidden className="h-5 w-1 shrink-0 bg-accent" />
          {title}
        </h2>
        {right}
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </section>
  );
}

interface Props {
  story: StoryLine[];
  startedAt: number | null;
  onOpenTask: (taskId: string) => void;
}

const EDGE: Record<StoryTone, string> = {
  danger: "border-danger",
  warn: "border-alert",
  s2: "border-s2",
  gene: "border-gene",
  ok: "border-ok",
  info: "border-transparent",
};

const ROW = "flex w-full items-baseline gap-3 border-l-4 py-1 pr-2 pl-3 text-left text-xl leading-[1.35]";

export function StoryPanel({ story, startedAt, onOpenTask }: Props) {
  return (
    <StagePanel title="此刻发生了什么" className="h-full">
      {story.length === 0 ? (
        <p className="px-4 py-3 text-xl leading-[1.35] text-muted">等待开始。开跑后，这里用一句话说明蜂群每一步在做什么。</p>
      ) : (
        // Newest first and clipped at the bottom, so the latest line is always in view without scrolling.
        <div className="relative h-full">
          <ol className="flex flex-col gap-1.5 px-3 py-2">
            {story.toReversed().map((line) => {
              const body = (
                <>
                  <span className="shrink-0 text-lg text-muted tabular-nums">{fmtClock(line.at - (startedAt ?? line.at))}</span>
                  <span className="min-w-0 break-words text-fg">{line.text}</span>
                </>
              );
              const taskId = line.taskId;
              return (
                <li key={line.id}>
                  {taskId ? (
                    <button
                      type="button"
                      onClick={() => onOpenTask(taskId)}
                      title="点开看这道题"
                      className={`${ROW} ${EDGE[line.tone]} cursor-pointer transition-colors hover:bg-panel-2 focus-visible:bg-panel-2 focus-visible:outline-none`}
                    >
                      {body}
                    </button>
                  ) : (
                    <div className={`${ROW} ${EDGE[line.tone]}`}>{body}</div>
                  )}
                </li>
              );
            })}
          </ol>
          <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-linear-to-t from-panel to-transparent" />
        </div>
      )}
    </StagePanel>
  );
}
