import { useEffect, useState, type ReactNode } from "react";
import type { LibraryResponse } from "../../../src/core/api";
import { errorText, getLibrary } from "../api";
import { fmtInt, safeHttpUrl, truncate } from "../format";
import { DOMAIN_LABEL, SOURCE_LABEL } from "../labels";
import type { GeneView, LibrarySource, LibraryView } from "../state";
import { fromLibraryGene, geneTitle, type GeneCardData } from "./GeneCard";
import { GeneChips } from "./GeneChips";

interface Props {
  library: LibraryView;
  genes: GeneView[];
  inherit: boolean | undefined;
  inheritedGenes: number | undefined;
  focusTask: string | null;
  refreshKey: string;
  onFocusTask: (taskId: string) => void;
  onOpenGene: (gene: GeneCardData) => void;
}

const SOURCE_BADGE: Record<LibrarySource, string> = {
  local: "border-accent/70 text-accent",
  evomap: "border-s2 bg-s2/15 text-s2",
};

function Section({ title, en, right, children }: { title: string; en: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5 border-b border-grid/60 px-3 py-2">
      <header className="flex items-baseline justify-between gap-2 text-[11px] tracking-wide text-muted">
        <span>
          <span className="text-fg/85">{title}</span> {en}
        </span>
        {right}
      </header>
      {children}
    </section>
  );
}

function Stat({ label, value, tone = "text-fg" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex flex-col bg-panel px-2 py-1.5">
      <span className="text-[10px] text-muted">{label}</span>
      <span className={`font-display text-xl leading-tight tabular-nums ${tone}`}>{value}</span>
    </div>
  );
}

export function LibraryPanel(props: Props) {
  const { library, genes, inherit, inheritedGenes, focusTask, refreshKey, onFocusTask, onOpenGene } = props;
  const [store, setStore] = useState<LibraryResponse | null>(null);
  const [storeError, setStoreError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getLibrary()
      .then((r) => {
        if (cancelled) return;
        setStore(r);
        setStoreError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setStoreError(errorText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const geneText = new Map(genes.map((g) => [g.id, g.text]));
  const published = library.published;
  const links = (published?.evomap?.urls ?? []).map(safeHttpUrl).filter((u): u is string => u !== null);

  return (
    <div className="flex flex-col">
      <div className="grid grid-cols-4 gap-px border-b border-grid/60 bg-grid">
        <Stat label="继承 Gene inherited" value={inheritedGenes === undefined ? "—" : fmtInt(inheritedGenes)} tone="text-gene" />
        <Stat label="载入 Gene loaded" value={library.loaded ? fmtInt(library.loaded.genes) : "—"} />
        <Stat label="载入先例 precedents" value={library.loaded ? fmtInt(library.loaded.precedents) : "—"} />
        <Stat label="经验命中 hits" value={fmtInt(library.hits.length)} tone={library.hits.length ? "text-s2" : "text-fg"} />
      </div>
      {inherit === false && (
        <div className="border-b border-grid/60 px-3 py-1 text-[11px] text-muted">本轮未开启继承经验 inherit off · 冷启动 cold start</div>
      )}

      <Section title="本轮基因" en="Genes this run" right={<span className="tabular-nums">{genes.length}</span>}>
        {genes.length === 0 ? (
          <span className="text-xs text-muted">尚未产生基因 no genes yet</span>
        ) : (
          <GeneChips genes={genes} max={12} onOpen={onOpenGene} />
        )}
      </Section>

      <Section title="经验命中" en="Library hits · 卡住时查前人经验" right={<span className="tabular-nums">{library.hits.length}</span>}>
        {library.hits.length === 0 ? (
          <span className="text-xs text-muted">暂无命中 no hits yet</span>
        ) : (
          <ul className="flex flex-col gap-1">
            {library.hits
              .toReversed()
              .slice(0, 20)
              .map((h, i) => (
                <li key={`${h.at}-${h.taskId}-${i}`}>
                  <button
                    type="button"
                    onClick={() => onFocusTask(h.taskId)}
                    title="在任务网格中高亮 highlight in task grid"
                    className={`flex w-full items-center gap-2 border px-2 py-1 text-left text-xs transition-colors hover:bg-panel-2 ${
                      focusTask === h.taskId ? "border-fg" : "border-grid"
                    }`}
                  >
                    <span className={`shrink-0 border px-1.5 text-[10px] ${SOURCE_BADGE[h.source]}`}>{SOURCE_LABEL[h.source]}</span>
                    <span className="shrink-0 text-fg tabular-nums">{h.taskId}</span>
                    <span className="shrink-0 text-muted">@{h.cellId}</span>
                    <span className="min-w-0 truncate text-fg/80">{h.titles.join(" / ") || h.geneIds.join(", ")}</span>
                  </button>
                </li>
              ))}
          </ul>
        )}
      </Section>

      {published && (
        <Section
          title="验证门与发布"
          en="Holdout gate · publish"
          right={
            <span className="tabular-nums">
              {published.genes} genes · {published.precedents} precedents
            </span>
          }
        >
          {published.gate.length > 0 && (
            <table className="w-full border-collapse text-xs tabular-nums">
              <thead>
                <tr className="text-left text-[10px] text-muted">
                  <th className="py-0.5 font-normal">基因 gene</th>
                  <th className="py-0.5 text-right font-normal">有 with</th>
                  <th className="py-0.5 text-right font-normal">无 without</th>
                  <th className="py-0.5 text-right font-normal">任务 tasks</th>
                  <th className="py-0.5 text-right font-normal">通过</th>
                </tr>
              </thead>
              <tbody>
                {published.gate.map((g) => (
                  <tr key={g.geneId} className="border-t border-grid/50">
                    <td className="max-w-0 truncate py-0.5 pr-2 text-fg" title={geneText.get(g.geneId) ?? g.geneId}>
                      {truncate(geneTitle(geneText.get(g.geneId) ?? g.geneId), 40)}
                    </td>
                    <td className="py-0.5 text-right text-fg">{g.withGene}</td>
                    <td className="py-0.5 text-right text-muted">{g.withoutGene}</td>
                    <td className="py-0.5 text-right text-muted">{g.tasks}</td>
                    <td className={`py-0.5 text-right font-semibold ${g.passed ? "text-ok" : "text-danger"}`}>{g.passed ? "✓" : "✗"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {published.evomap && (
            <div className="flex flex-col gap-1 text-xs">
              <span>
                <span className="text-muted">EvoMap</span> <span className="text-s2">{published.evomap.status}</span>{" "}
                <span className="text-muted tabular-nums">· {published.evomap.assetIds.length} assets</span>
              </span>
              {links.map((url) => (
                <a
                  key={url}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="truncate text-s2 underline decoration-s2/40 underline-offset-2 hover:decoration-s2"
                >
                  {url}
                </a>
              ))}
            </div>
          )}
        </Section>
      )}

      <Section
        title="经验库存"
        en="Library store"
        right={
          storeError ? (
            <span className="text-danger">{storeError}</span>
          ) : (
            <span className="tabular-nums">{store ? `${store.genes} genes · ${store.precedents} precedents` : "…"}</span>
          )
        }
      >
        {store && store.recent.length === 0 && <span className="text-xs text-muted">经验库为空 empty · 冷启动</span>}
        {store && store.recent.length > 0 && (
          <ul className="flex flex-col gap-1">
            {store.recent.slice(0, 12).map((g) => (
              <li key={`${g.source}-${g.id}`}>
                <button
                  type="button"
                  onClick={() => onOpenGene(fromLibraryGene(g))}
                  className="flex w-full items-center gap-2 border border-grid px-2 py-1 text-left text-xs transition-colors hover:border-gene hover:bg-panel-2"
                >
                  <span className={`shrink-0 border px-1.5 text-[10px] ${SOURCE_BADGE[g.source]}`}>{SOURCE_LABEL[g.source]}</span>
                  <span className="shrink-0 text-muted">{DOMAIN_LABEL[g.domain] ?? g.domain}</span>
                  <span className="min-w-0 flex-1 truncate text-fg/85">{geneTitle(g.text)}</span>
                  <span className="shrink-0 text-muted tabular-nums">
                    {g.evidence.wins}/{g.evidence.trials}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
