import type { ProtocolMessage, ProtocolType } from "../../../src/core/types";
import { fmtClock, fmtInt } from "../format";
import { PROTOCOL_LABEL, PROTOCOL_TEXT } from "../labels";
import { describeMessage } from "../protocolText";

interface Props {
  messages: ProtocolMessage[];
  counts: Partial<Record<ProtocolType, number>>;
  startedAt: number | null;
}

export function ProtocolTrace({ messages, counts, startedAt }: Props) {
  const tally = (Object.entries(counts) as Array<[ProtocolType, number]>).sort((a, b) => b[1] - a[1]);
  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 border-b border-grid/60 px-3 py-1.5 text-[11px] text-muted tabular-nums">
        <span>v1 信封 envelope · 同一 JSON 可走进程内总线或 WebSocket</span>
        {tally.map(([type, n]) => (
          <span key={type} className={PROTOCOL_TEXT[type]}>
            {type} {fmtInt(n)}
          </span>
        ))}
      </div>
      {messages.length === 0 ? (
        <div className="px-3 py-4 text-center text-sm text-muted">等待协议消息 Awaiting protocol messages</div>
      ) : (
        <ol className="flex flex-col px-2 py-1 text-xs leading-5">
          {messages.toReversed().map((m) => {
            const denied = m.type === "DENIED";
            return (
              <li
                key={m.id}
                className={`flex gap-2 px-1 ${denied ? "bg-danger/15 text-danger" : "text-fg/80"}`}
                title={JSON.stringify(m.body)}
              >
                <span className="shrink-0 text-muted tabular-nums">{fmtClock(m.at - (startedAt ?? m.at))}</span>
                <span className={`w-[7.5rem] shrink-0 truncate font-semibold ${PROTOCOL_TEXT[m.type]}`}>
                  {m.type} <span className="font-normal">{PROTOCOL_LABEL[m.type]}</span>
                </span>
                <span className="min-w-0 truncate">{describeMessage(m)}</span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
