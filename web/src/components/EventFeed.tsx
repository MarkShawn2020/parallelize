import { fmtClock } from "../format";
import type { FeedKind, FeedLine } from "../state";
import { Panel } from "./Panel";

interface Props {
  feed: FeedLine[];
  startedAt: number | null;
  className?: string;
}

const KIND: Record<FeedKind, string> = {
  info: "text-fg/75",
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger",
  gene: "text-gene",
};

export function EventFeed({ feed, startedAt, className }: Props) {
  return (
    <Panel title="事件" en="Events" className={className} bodyClassName="overflow-y-auto">
      <ol className="flex flex-col px-3 py-1.5 text-xs leading-5">
        {feed.length === 0 && <li className="py-2 text-muted">等待事件 Awaiting events</li>}
        {feed.toReversed().map((line) => (
          <li key={line.id} className={`flex gap-2 ${KIND[line.kind]}`}>
            <span className="shrink-0 text-muted tabular-nums">{fmtClock(line.at - (startedAt ?? line.at))}</span>
            <span className="min-w-0 break-words">{line.text}</span>
          </li>
        ))}
      </ol>
    </Panel>
  );
}
