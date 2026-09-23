import type { ProtocolType } from "../../../src/core/types";

interface Props {
  counts: Partial<Record<ProtocolType, number>>;
}

type Item = { label: string; types: readonly ProtocolType[]; note?: string };

// The spec's "亮能力卡" is ANNOUNCE plus DISCOVER: both are how agents find each other without a directory.
const ITEMS: readonly Item[] = [
  { label: "亮能力卡", types: ["ANNOUNCE", "DISCOVER"] },
  { label: "黑板领题", types: ["CLAIM"], note: "（0 token）" },
  { label: "交答案", types: ["PROPOSE"] },
  { label: "请别人复核", types: ["REVIEW_REQUEST"] },
  { label: "收下", types: ["ACCEPT"] },
  { label: "传 Gene", types: ["GENE_OFFER"] },
  { label: "回声警报", types: ["ECHO_ALARM"] },
];

export function ProtocolStrip({ counts }: Props) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3.5 border border-grid bg-panel/90 px-4 py-1 text-base leading-tight">
      <span className="font-semibold text-accent">协议</span>
      {ITEMS.map(({ label, types, note }) => {
        const n = types.reduce((sum, t) => sum + (counts[t] ?? 0), 0);
        return (
          <span key={label} className="whitespace-nowrap text-fg/80">
            {label} <span className={`font-semibold tabular-nums ${n > 0 ? "text-fg" : "text-muted"}`}>{n}</span>
            {note && <span className="text-muted">{note}</span>}
          </span>
        );
      })}
      <span className="ml-auto whitespace-nowrap text-muted">谁找谁不写死</span>
    </div>
  );
}
