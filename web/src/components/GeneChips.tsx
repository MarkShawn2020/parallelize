import { truncate } from "../format";
import { DOMAIN_LABEL } from "../labels";
import { DOMAIN_ZH } from "../stageText";
import type { GeneView } from "../state";
import { fromRunGene, geneTitle, type GeneCardData } from "./GeneCard";

interface Props {
  genes: GeneView[];
  max: number;
  onOpen: (gene: GeneCardData) => void;
  /** Overlay variant: fewer details, opaque background. */
  compact?: boolean;
  /** Judge-facing overlay: Chinese only, large type; the gene text itself stays inside the card. */
  variant?: "stage";
}

/** Most-adopted first, newest breaking ties: a fresh gene with no takers never pushes a spreading one out mid-click. */
export function rankGenes(genes: readonly GeneView[], max: number): GeneView[] {
  return genes
    .map((g, i) => ({ g, i }))
    .sort((a, b) => b.g.adoptedBy.length - a.g.adoptedBy.length || b.i - a.i)
    .slice(0, max)
    .map(({ g }) => g);
}

export function stageGeneText(g: GeneView): string {
  const spread = g.adoptedBy.length > 0 ? `已被 ${g.adoptedBy.length} 个邻居收下` : "刚生成";
  return `${DOMAIN_ZH[g.domain] ?? ""}经验 · ${spread}`;
}

export function GeneChips({ genes, max, onOpen, compact = false, variant }: Props) {
  if (variant === "stage") {
    const shown = rankGenes(genes, max);
    if (shown.length === 0) return null;
    return (
      <div className="flex flex-col items-end gap-1.5">
        <span className="bg-bg/85 px-2 text-base text-fg/80">正在流传的经验</span>
        {shown.map((g) => (
          <button
            key={g.id}
            type="button"
            onClick={() => onOpen(fromRunGene(g))}
            title="点开看这条经验"
            className="flex items-center gap-2 border border-gene/70 bg-bg/85 px-3 py-1 text-left text-base text-gene transition-colors hover:bg-gene hover:text-bg"
          >
            <span aria-hidden>◆</span>
            <span>{stageGeneText(g)}</span>
          </button>
        ))}
      </div>
    );
  }
  return (
    <div className={`flex flex-wrap gap-1.5 ${compact ? "justify-end" : ""}`}>
      {rankGenes(genes, max).map((g) => (
        <button
          key={g.id}
          type="button"
          onClick={() => onOpen(fromRunGene(g))}
          title={`打开基因卡 open gene card · ${g.text}`}
          className={`flex max-w-full items-center gap-1.5 border border-gene/70 px-2 py-0.5 text-left text-xs text-gene transition-colors hover:bg-gene hover:text-bg ${
            compact ? "bg-bg/85" : ""
          }`}
        >
          <span aria-hidden>◆</span>
          <span className="truncate">{truncate(geneTitle(g.text), compact ? 22 : 34)}</span>
          {!compact && (
            <span className="shrink-0 opacity-70">
              {DOMAIN_LABEL[g.domain] ?? g.domain} · {g.cellId}
              {g.adoptedBy.length > 0 ? ` · +${g.adoptedBy.length}` : ""}
            </span>
          )}
          {compact && g.adoptedBy.length > 0 && <span className="shrink-0 opacity-70">+{g.adoptedBy.length}</span>}
        </button>
      ))}
    </div>
  );
}
