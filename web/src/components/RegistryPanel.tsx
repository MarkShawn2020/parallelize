import type { CapabilityCard, Domain } from "../../../src/core/types";
import { byNaturalId, shortModel } from "../format";
import { DOMAIN_LABEL } from "../labels";
import type { CellView } from "../state";

interface Props {
  cards: Record<string, CapabilityCard>;
  cells: Record<string, CellView>;
  selected: string[];
  reviewTrust: number | undefined;
  quarantineTrust: number | undefined;
  onToggle: (cellId: string) => void;
}

const STATUS = {
  active: { label: "在线 active", className: "border-ok/60 text-ok" },
  quarantined: { label: "已隔离", className: "border-danger bg-danger/15 text-danger" },
  dead: { label: "阵亡 dead", className: "border-muted text-muted" },
} as const;

function trustTone(trust: number, review: number, quarantine: number): { bar: string; text: string } {
  if (trust < quarantine) return { bar: "bg-danger", text: "text-danger" };
  if (trust < review) return { bar: "bg-warn", text: "text-warn" };
  return { bar: "bg-ok", text: "text-ok" };
}

export function RegistryPanel({ cards, cells, selected, reviewTrust = 0.6, quarantineTrust = 0.3, onToggle }: Props) {
  const list = Object.values(cards).sort((a, b) => byNaturalId(a.agentId, b.agentId));
  if (list.length === 0) {
    return <div className="px-3 py-4 text-center text-sm text-muted">等待能力卡 Awaiting capability cards</div>;
  }

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap gap-x-3 border-b border-grid/60 px-3 py-1.5 text-[11px] text-muted">
        <span>{list.length} 个 Agent 自我描述，无中心调度 self-published, no central scheduler</span>
        <span>
          复核线 review &lt; {reviewTrust.toFixed(2)} · 隔离线 quarantine &lt; {quarantineTrust.toFixed(2)}
        </span>
      </div>
      <ul className="flex flex-col">
        {list.map((card) => {
          const cell = cells[card.agentId];
          const status = cell && !cell.alive ? "dead" : cell?.quarantined ? "quarantined" : card.status;
          const tone = trustTone(card.trust, reviewTrust, quarantineTrust);
          const domains = Object.entries(card.domains) as Array<[Domain, { wins: number; trials: number }]>;
          const picked = selected.includes(card.agentId);
          return (
            <li key={card.agentId}>
              <button
                type="button"
                onClick={() => onToggle(card.agentId)}
                aria-pressed={picked}
                className={`flex w-full flex-col gap-1 border-b border-grid/50 px-3 py-1.5 text-left text-xs transition-colors hover:bg-panel-2 ${
                  picked ? "bg-fg/10 outline outline-1 -outline-offset-1 outline-fg/70" : ""
                } ${status === "dead" ? "opacity-50" : ""}`}
              >
                <div className="flex items-center gap-2">
                  <span className="w-10 shrink-0 font-semibold text-fg tabular-nums">{card.agentId}</span>
                  <span className="min-w-0 flex-1 truncate text-muted" title={card.model}>
                    {shortModel(card.model)}
                  </span>
                  {cell?.compromised && (
                    <span className="shrink-0 border border-dashed border-danger px-1 text-[10px] text-danger" title="演示真相，蜂群不知情">
                      HACKED
                    </span>
                  )}
                  <span className={`shrink-0 border px-1.5 text-[10px] ${STATUS[status].className}`}>{STATUS[status].label}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-10 shrink-0 text-[10px] text-muted">信任</span>
                  <div className="relative h-2 flex-1 bg-panel-2" role="img" aria-label={`trust ${card.trust.toFixed(2)}`}>
                    <div className={`h-full ${tone.bar} transition-[width] duration-500`} style={{ width: `${Math.max(0, Math.min(1, card.trust)) * 100}%` }} />
                    <div className="absolute inset-y-0 w-px bg-danger/80" style={{ left: `${quarantineTrust * 100}%` }} />
                    <div className="absolute inset-y-0 w-px bg-warn/80" style={{ left: `${reviewTrust * 100}%` }} />
                  </div>
                  <span className={`w-9 shrink-0 text-right tabular-nums ${tone.text}`}>{card.trust.toFixed(2)}</span>
                </div>
                {(domains.length > 0 || card.genes.length > 0) && (
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-12 text-[11px] text-muted">
                    {domains.map(([d, r]) => (
                      <span key={d} className="tabular-nums">
                        {DOMAIN_LABEL[d] ?? d} <span className="text-fg">{r.wins}/{r.trials}</span>
                      </span>
                    ))}
                    {card.genes.slice(0, 2).map((g) => (
                      <span key={g} className="max-w-[16rem] truncate text-gene" title={card.genes.join("\n")}>
                        ◆ {g}
                      </span>
                    ))}
                    {card.genes.length > 2 && <span className="text-gene">+{card.genes.length - 2}</span>}
                  </div>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
