import type { ReactNode } from "react";

export type SideTab = "events" | "registry" | "protocol" | "library" | "report";

export interface TabSpec {
  id: SideTab;
  zh: string;
  en: string;
  badge?: string;
  /** Draws attention to a tab whose content changed in a way the audience should see. */
  alert?: boolean;
}

interface Props {
  tabs: TabSpec[];
  active: SideTab;
  onChange: (tab: SideTab) => void;
  className?: string;
  children: ReactNode;
}

export function SidePanel({ tabs, active, onChange, className = "", children }: Props) {
  return (
    <section className={`flex min-h-0 min-w-0 flex-col border border-grid bg-panel/90 ${className}`}>
      <div role="tablist" aria-label="侧栏 Side panel" className="flex shrink-0 border-b border-grid">
        {tabs.map((t) => {
          const selected = t.id === active;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={selected}
              aria-controls="side-panel-body"
              onClick={() => onChange(t.id)}
              className={`relative flex min-w-0 flex-1 flex-col items-center gap-0.5 border-r border-grid px-1 py-1.5 last:border-r-0 transition-colors ${
                selected ? "bg-panel-2 text-fg" : "text-muted hover:bg-panel-2/60 hover:text-fg"
              }`}
            >
              {selected && <span aria-hidden className="absolute inset-x-0 top-0 h-[2px] bg-accent" />}
              <span className="flex items-center gap-1 font-display text-[15px] leading-none tracking-wider whitespace-nowrap">
                {t.zh}
                {t.alert && <span className="size-1.5 animate-pulse rounded-full bg-accent" />}
              </span>
              <span className="text-[10px] leading-none whitespace-nowrap">
                {t.en}
                {t.badge && <span className="ml-1 text-fg/80 tabular-nums">{t.badge}</span>}
              </span>
            </button>
          );
        })}
      </div>
      <div id="side-panel-body" role="tabpanel" aria-labelledby={`tab-${active}`} className="min-h-0 flex-1 overflow-y-auto">
        {children}
      </div>
    </section>
  );
}
