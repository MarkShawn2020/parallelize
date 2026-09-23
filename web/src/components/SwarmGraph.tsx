import { useEffect, useMemo, useRef } from "react";
import ForceGraph2D, { type ForceGraphMethods, type LinkObject, type NodeObject } from "react-force-graph-2d";
import type { CellState } from "../../../src/core/types";
import { CELL_STATE_BG, CELL_STATE_LABEL } from "../labels";
import { CELL_STATE_COLOR, monoFont, palette } from "../palette";
import type { CellView, Particle } from "../state";
import { useElementWidth } from "../useElementWidth";
import { Panel } from "./Panel";

interface GNode {
  id: string;
}
interface GLink {
  source: string;
  target: string;
  /** Each neighbour pair has a link per direction so particles can travel either way; only one is drawn. */
  drawn: boolean;
}
type Node = NodeObject<GNode>;
type Link = LinkObject<GNode, GLink>;
type GraphRef = ForceGraphMethods<Node, Link>;

interface Props {
  cells: Record<string, CellView>;
  particles: Particle[];
  height: number;
  canKill: boolean;
  onKill: (cellId: string) => void;
  emptyText: string;
}

const LEGEND: CellState[] = ["idle", "claiming", "solving", "verifying", "gossiping", "dead"];
const PARTICLE_BURST = 12;

const radius = (c: CellView | undefined) => 8 + Math.sqrt(c?.solved ?? 0) * 2.8;

// The panel is several times wider than tall; pulling nodes toward the horizontal axis
// spreads the swarm across the width instead of leaving it a small blob in the middle.
function flatten(strength: number) {
  let nodes: Node[] = [];
  const force = (alpha: number) => {
    for (const n of nodes) n.vy = (n.vy ?? 0) - (n.y ?? 0) * strength * alpha;
  };
  force.initialize = (all: Node[]) => {
    nodes = all;
  };
  return force;
}

export function SwarmGraph({ cells, particles, height, canKill, onKill, emptyText }: Props) {
  const [boxRef, width] = useElementWidth<HTMLDivElement>();
  const fgRef = useRef<GraphRef | undefined>(undefined);
  const cellsRef = useRef(cells);
  cellsRef.current = cells;
  const nodeCache = useRef(new Map<string, Node>());
  const emitted = useRef(new WeakSet<Particle>());

  const topology = Object.values(cells)
    .map((c) => `${c.id}:${c.neighbors.join(",")}`)
    .join("|");

  const { graphData, linkIndex } = useMemo(() => {
    const current = cellsRef.current;
    // Reuse node objects so the simulation keeps positions when a cell joins.
    const nodes = Object.keys(current).map((id) => {
      const known = nodeCache.current.get(id) ?? { id };
      nodeCache.current.set(id, known);
      return known;
    });
    const links: Link[] = [];
    const index = new Map<string, Link>();
    for (const c of Object.values(current)) {
      for (const nb of c.neighbors) {
        if (!current[nb]) continue;
        for (const [a, b] of [
          [c.id, nb],
          [nb, c.id],
        ] as const) {
          const key = `${a}>${b}`;
          if (index.has(key)) continue;
          const link: Link = { source: a, target: b, drawn: a < b };
          index.set(key, link);
          links.push(link);
        }
      }
    }
    return { graphData: { nodes, links }, linkIndex: index };
  }, [topology]);

  const cellList = Object.values(cells);
  const mounted = width > 0 && cellList.length > 0;

  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    fg.d3Force("charge")?.strength?.(-320);
    fg.d3Force("link")?.distance?.(70);
    fg.d3Force("flatten", flatten(0.22));
    fg.d3ReheatSimulation();
  }, [mounted, graphData]);

  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    const fresh = particles.filter((p) => !emitted.current.has(p));
    fresh.forEach((p) => emitted.current.add(p));
    for (const p of fresh.slice(-PARTICLE_BURST)) {
      const link = linkIndex.get(`${p.from}>${p.to}`);
      if (link) fg.emitParticle(link);
    }
  }, [particles, linkIndex]);

  const alive = cellList.filter((c) => c.alive).length;

  const drawNode = (node: Node, ctx: CanvasRenderingContext2D, scale: number) => {
    const cell = cellsRef.current[String(node.id)];
    if (!cell || node.x === undefined || node.y === undefined) return;
    const p = palette();
    const r = radius(cell);
    const { x, y } = node;
    ctx.save();
    ctx.globalAlpha = cell.alive ? 1 : 0.4;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 2 * Math.PI);
    ctx.fillStyle = cell.alive ? p[CELL_STATE_COLOR[cell.state]] : p["panel-2"];
    ctx.fill();
    ctx.lineWidth = 1.5 / scale;
    ctx.strokeStyle = cell.alive ? p.bg : p.danger;
    ctx.stroke();
    if (!cell.alive) {
      const d = r * 0.9;
      ctx.globalAlpha = 1;
      ctx.lineWidth = 2.5 / scale;
      ctx.strokeStyle = p.danger;
      ctx.beginPath();
      ctx.moveTo(x - d, y - d);
      ctx.lineTo(x + d, y + d);
      ctx.moveTo(x + d, y - d);
      ctx.lineTo(x - d, y + d);
      ctx.stroke();
    }
    const fontPx = 13 / scale;
    ctx.globalAlpha = cell.alive ? 0.9 : 0.6;
    ctx.font = `${fontPx}px ${monoFont()}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = cell.alive ? p.fg : p.danger;
    ctx.fillText(cell.genes > 0 ? `${cell.id} ·${cell.genes}g` : cell.id, x, y + r + 3 / scale);
    ctx.restore();
  };

  const paintHitArea = (node: Node, color: string, ctx: CanvasRenderingContext2D) => {
    if (node.x === undefined || node.y === undefined) return;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(node.x, node.y, radius(cellsRef.current[String(node.id)]) + 2, 0, 2 * Math.PI);
    ctx.fill();
  };

  const legend = (
    <div className="hidden flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted md:flex">
      {LEGEND.map((s) => (
        <span key={s} className="flex items-center gap-1.5">
          <span className={`size-2 rounded-full ${CELL_STATE_BG[s]}`} />
          {CELL_STATE_LABEL[s]}
        </span>
      ))}
    </div>
  );

  return (
    <Panel title="蜂群拓扑" en="Swarm" right={legend}>
      <div ref={boxRef} className="relative w-full" style={{ height }}>
        {mounted && (
          <ForceGraph2D<GNode, GLink>
            ref={fgRef}
            width={width}
            height={height}
            graphData={graphData}
            autoPauseRedraw={false}
            warmupTicks={40}
            cooldownTicks={120}
            onEngineStop={() => fgRef.current?.zoomToFit(400, 48)}
            nodeCanvasObject={drawNode}
            nodePointerAreaPaint={paintHitArea}
            nodeLabel={(n) => {
              const c = cellsRef.current[String(n.id)];
              return c ? `${c.id} · ${CELL_STATE_LABEL[c.state]} · solved ${c.solved}${c.taskId ? ` · ${c.taskId}` : ""}` : "";
            }}
            linkColor={(l) => (l.drawn ? palette().muted : "transparent")}
            linkWidth={1}
            linkDirectionalParticleColor={() => palette().gene}
            linkDirectionalParticleWidth={5}
            linkDirectionalParticleSpeed={0.02}
            enableNodeDrag={false}
            onNodeClick={(n) => {
              const c = cellsRef.current[String(n.id)];
              if (canKill && c?.alive) onKill(c.id);
            }}
          />
        )}
        {cellList.length === 0 && (
          <div className="absolute inset-0 grid place-items-center text-sm text-muted">{emptyText}</div>
        )}
        {cellList.length > 0 && (
          <div className="pointer-events-none absolute bottom-2 left-3 flex gap-4 text-xs text-muted">
            <span>
              存活 alive <span className="text-fg tabular-nums">{alive}</span>/{cellList.length}
            </span>
            {canKill && <span>点击节点击杀 click a cell to kill</span>}
          </div>
        )}
      </div>
    </Panel>
  );
}
