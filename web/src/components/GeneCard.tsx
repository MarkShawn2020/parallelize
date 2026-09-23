import { useEffect, useRef } from "react";
import type { Domain, LibraryGene } from "../../../src/core/types";
import { DOMAIN_LABEL } from "../labels";
import type { GeneView } from "../state";

export interface GeneCardData {
  id: string;
  domain: Domain;
  text: string;
  source: "run" | "local" | "evomap";
  origin: string;
  wins?: number;
  trials?: number;
  independentSources?: number;
  gossiped?: number;
  adoptedBy?: string[];
  rejectedBy?: string[];
  assetId?: string;
}

export function fromRunGene(g: GeneView): GeneCardData {
  return {
    id: g.id,
    domain: g.domain,
    text: g.text,
    source: "run",
    origin: g.cellId,
    gossiped: g.gossiped,
    adoptedBy: g.adoptedBy,
    rejectedBy: g.rejectedBy,
  };
}

export function fromLibraryGene(g: LibraryGene): GeneCardData {
  return {
    id: g.id,
    domain: g.domain,
    text: g.text,
    source: g.source,
    origin: g.runId ? `${g.origin} · ${g.runId}` : g.origin,
    wins: g.evidence.wins,
    trials: g.evidence.trials,
    independentSources: g.evidence.independentSources,
    assetId: g.assetId,
  };
}

/** First line without markdown emphasis or heading marks, which models often put on a gene's first line. */
export function geneTitle(text: string): string {
  return (text.split("\n", 1)[0] ?? text).replace(/\*\*|__|`/g, "").replace(/^#+\s*/, "");
}

const SOURCE = {
  run: { label: "本轮生成 this run", className: "border-gene text-gene" },
  local: { label: "本地经验库 local library", className: "border-accent text-accent" },
  evomap: { label: "EvoMap 公共基因", className: "border-s2 text-s2" },
} as const;

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 bg-panel px-3 py-2">
      <span className="text-[11px] text-muted">{label}</span>
      <span className="font-display text-2xl leading-none text-fg tabular-nums">{value}</span>
    </div>
  );
}

export function GeneCard({ gene, onClose }: { gene: GeneCardData; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const src = SOURCE[gene.source];
  const winRate = gene.trials ? `${gene.wins ?? 0}/${gene.trials}` : "—";

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) ref.current.close();
      }}
      className="m-auto w-[min(720px,92vw)] border-2 border-gene bg-panel p-0 text-fg shadow-[0_0_40px_color-mix(in_oklab,var(--color-gene)_35%,transparent)] backdrop:bg-bg/75"
    >
      <div className="flex flex-col gap-4 p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <span className="font-display text-sm tracking-[0.3em] text-gene">GENE 基因卡</span>
            <span className="font-display text-3xl leading-tight font-semibold">{geneTitle(gene.text)}</span>
          </div>
          <button
            type="button"
            onClick={() => ref.current?.close()}
            className="shrink-0 border border-grid px-3 py-1 text-muted hover:border-fg hover:text-fg"
            aria-label="关闭 close"
          >
            关闭 ✕
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className={`border px-2 py-0.5 ${src.className}`}>{src.label}</span>
          <span className="border border-grid px-2 py-0.5 text-fg">{DOMAIN_LABEL[gene.domain] ?? gene.domain}</span>
          <span className="text-muted tabular-nums">id {gene.id}</span>
          <span className="text-muted">来源 origin {gene.origin}</span>
          {gene.assetId && <span className="text-s2 tabular-nums">asset {gene.assetId}</span>}
        </div>

        <p className="border-l-2 border-gene bg-panel-2 px-4 py-3 text-lg leading-relaxed whitespace-pre-wrap">{gene.text.replace(/\*\*|__/g, "")}</p>

        <div className="grid grid-cols-2 gap-px bg-grid sm:grid-cols-4">
          {gene.source === "run" ? (
            <>
              <Fact label="传播 gossiped" value={String(gene.gossiped ?? 0)} />
              <Fact label="采纳 adopted" value={String(gene.adoptedBy?.length ?? 0)} />
              <Fact label="拒收 rejected" value={String(gene.rejectedBy?.length ?? 0)} />
              <Fact label="领域 domain" value={DOMAIN_LABEL[gene.domain] ?? gene.domain} />
            </>
          ) : (
            <>
              <Fact label="胜 / 试 wins / trials" value={winRate} />
              <Fact label="独立来源 sources" value={gene.independentSources === undefined ? "—" : String(gene.independentSources)} />
              <Fact label="领域 domain" value={DOMAIN_LABEL[gene.domain] ?? gene.domain} />
              <Fact label="来源 source" value={gene.source === "evomap" ? "EvoMap" : "本地"} />
            </>
          )}
        </div>

        {gene.source === "run" && (gene.adoptedBy?.length || gene.rejectedBy?.length) ? (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {gene.adoptedBy && gene.adoptedBy.length > 0 && (
              <span>
                <span className="text-muted">采纳者 adopted by</span> <span className="text-gene">{gene.adoptedBy.join(", ")}</span>
              </span>
            )}
            {gene.rejectedBy && gene.rejectedBy.length > 0 && (
              <span>
                <span className="text-muted">拒收者 rejected by</span> <span className="text-fg">{gene.rejectedBy.join(", ")}</span>
              </span>
            )}
          </div>
        ) : null}
        <p className="text-xs text-muted">
          基因只改变解题策略，不算答案证据：用过同一基因的两个答案仍按血缘判断是否独立。
        </p>
      </div>
    </dialog>
  );
}
