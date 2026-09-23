import { fmtClock } from "../format";
import type { StoryLine, StoryTone } from "../state";
import { StagePanel } from "./StoryPanel";

interface Props {
  lines: StoryLine[];
  startedAt: number | null;
}

const TONE: Record<StoryTone, string> = {
  danger: "text-danger",
  warn: "text-alert",
  s2: "text-s2",
  gene: "text-gene",
  ok: "text-ok",
  info: "text-fg",
};

/** Newest on top, like the story panel next to it, so the latest fault is always in view. */
export function FaultLog({ lines, startedAt }: Props) {
  return (
    <StagePanel title="容错记录" className="h-full">
      <div className="h-full overflow-y-auto">
        {lines.length === 0 ? (
          <p className="px-4 py-3 text-lg leading-snug text-muted">还没有故障。可以点上面的按钮：入侵、让 3 个互相抄答案、拔掉一个、断开 Jev。</p>
        ) : (
          <ol className="flex flex-col gap-1 px-4 py-2 text-lg leading-snug">
            {lines.toReversed().map((line) => (
              <li key={line.id} className="flex items-baseline gap-4">
                <span className="shrink-0 text-muted tabular-nums">{fmtClock(line.at - (startedAt ?? line.at))}</span>
                <span className={`min-w-0 break-words ${TONE[line.tone]}`}>{line.short ?? line.text}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </StagePanel>
  );
}
