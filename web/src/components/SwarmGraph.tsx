import { useEffect, useMemo, useRef, type ReactNode } from "react";
import ForceGraph2D, { type ForceGraphMethods, type LinkObject, type NodeObject } from "react-force-graph-2d";
import type { CapabilityCard, CellState } from "../../../src/core/types";
import { shortModel } from "../format";
import { CELL_STATE_BG, CELL_STATE_LABEL } from "../labels";
import { CELL_STATE_COLOR, LINK_COLOR, PARTICLE_COLOR, monoFont, palette, type Palette } from "../palette";
import type { CellView, LinkReason, LinkView, Particle, ParticleKind } from "../state";
import { useElementWidth } from "../useElementWidth";
import { Panel } from "./Panel";

interface GNode {
  id: string;
}
// Link endpoints come from LinkObject: ids going in, node objects once the simulation resolves them.
type GLink = Record<never, never>;
type Node = NodeObject<GNode>;
type Link = LinkObject<GNode, GLink>;
type GraphRef = ForceGraphMethods<Node, Link>;

interface Props {
  cells: Record<string, CellView>;
  cards: Record<string, CapabilityCard>;
  links: Record<string, LinkView>;
  particles: Particle[];
  height: number;
  selected: string[];
  canAct: boolean;
  onToggle: (cellId: string) => void;
  onKill: (cellId: string) => void;
  emptyText: string;
  /** Top-right corner content, e.g. the latest genes. */
  overlay?: ReactNode;
}

interface Pulse {
  from: string;
  to: string;
  kind: ParticleKind;
  t0: number;
}

const LEGEND: CellState[] = ["idle", "claiming", "solving", "verifying", "gossiping", "dead"];
const LINK_LEGEND: Array<[LinkReason, string]> = [
  ["gossip", "传播 gossip"],
  ["review", "复核 review"],
  ["discover", "发现 discover"],
];
const LINK_BG: Record<LinkReason, string> = { gossip: "bg-gene", review: "bg-verify", discover: "bg-s1" };
const PARTICLE_BURST = 12;
const PULSE_MS = 1100;
const PULSE_STAGGER_MS = 70;
const MAX_PULSES = 80;
const GROW_MS = 900;
const JOIN_RING_MS = 3600;
const JOIN_LABEL_MS = 12_000;

// Capped: long runs would otherwise grow nodes until they cover the panel.
const radius = (c: CellView | undefined) => 9 + Math.min(9, Math.sqrt(c?.solved ?? 0) * 1.5);
const MAX_ZOOM = 2.2;
const pairKey = (a: string, b: string) => (a < b ? `${a}~${b}` : `${b}~${a}`);

function easeOutBack(t: number): number {
  const c = 1.70158;
  return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;
}

function dominant(l: LinkView): LinkReason {
  const { gossip, review, discover } = l.counts;
  return review >= gossip && review >= discover ? "review" : gossip >= discover ? "gossip" : "discover";
}

function withAlpha(hex: string, alpha: number): string {
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, "0");
  return /^#[0-9a-f]{6}$/i.test(hex) ? `${hex}${a}` : hex;
}

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

function drawLock(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, scale: number) {
  const w = r * 0.95;
  const h = r * 0.72;
  ctx.fillStyle = color;
  ctx.fillRect(x - w / 2, y - h / 2 + r * 0.18, w, h);
  ctx.beginPath();
  ctx.lineWidth = Math.max(2 / scale, r * 0.16);
  ctx.strokeStyle = color;
  ctx.arc(x, y - h / 2 + r * 0.18, w * 0.32, Math.PI, 0);
  ctx.stroke();
}

export function SwarmGraph(props: Props) {
  const { cells, cards, links, particles, height, selected, canAct, onToggle, onKill, emptyText, overlay } = props;
  const [boxRef, width] = useElementWidth<HTMLDivElement>();
  const fgRef = useRef<GraphRef | undefined>(undefined);
  // Canvas callbacks read the latest props through refs so the graph is not rebuilt per event.
  const live = useRef({ cells, cards, links, selected });
  live.current = { cells, cards, links, selected };
  const nodeCache = useRef(new Map<string, Node>());
  const firstSeen = useRef(new Map<string, number>());
  const emitted = useRef(new WeakSet<Particle>());
  const pulses = useRef<Pulse[]>([]);

  const topology = Object.values(cells)
    .map((c) => `${c.id}:${c.neighbors.join(",")}`)
    .join("|");

  const graphData = useMemo(() => {
    const current = live.current.cells;
    // A new run reuses ids like c1; forgetting departed ids lets its cells animate in again.
    for (const id of firstSeen.current.keys()) if (!current[id]) firstSeen.current.delete(id);
    // Reuse node objects so the simulation keeps positions when a cell joins.
    const nodes = Object.keys(current).map((id) => {
      const known = nodeCache.current.get(id) ?? { id };
      nodeCache.current.set(id, known);
      return known;
    });
    const seen = new Set<string>();
    const out: Link[] = [];
    for (const c of Object.values(current)) {
      for (const nb of c.neighbors) {
        const key = pairKey(c.id, nb);
        if (!current[nb] || seen.has(key)) continue;
        seen.add(key);
        out.push({ source: c.id, target: nb });
      }
    }
    return { nodes, links: out };
  }, [topology]);

  const cellList = Object.values(cells);
  const mounted = width > 0 && cellList.length > 0;
  const multiModel = new Set(Object.values(cards).map((c) => c.model)).size > 1;

  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    fg.d3Force("charge")?.strength?.(-340);
    fg.d3Force("link")?.distance?.(72);
    fg.d3Force("flatten", flatten(0.22));
    fg.d3ReheatSimulation();
  }, [mounted, graphData]);

  // Going fullscreen on the projector resizes the canvas; refit so the swarm stays centred.
  useEffect(() => {
    if (width > 0) fgRef.current?.zoomToFit(300, 56);
  }, [width]);

  useEffect(() => {
    const fresh = particles.filter((p) => !emitted.current.has(p));
    fresh.forEach((p) => emitted.current.add(p));
    const now = performance.now();
    fresh.slice(-PARTICLE_BURST).forEach((p, i) => {
      pulses.current.push({ from: p.from, to: p.to, kind: p.kind, t0: now + i * PULSE_STAGGER_MS });
    });
    if (pulses.current.length > MAX_PULSES) pulses.current = pulses.current.slice(-MAX_PULSES);
  }, [particles]);

  // Same definition as metrics.cellsAlive (working cells), so the two panels never disagree on stage.
  const alive = cellList.filter((c) => c.alive && !c.quarantined).length;
  const quarantined = cellList.filter((c) => c.quarantined).length;

  const isDim = (id: string) => {
    const c = live.current.cells[id];
    return !c || !c.alive || c.quarantined;
  };

  const endpointId = (end: Link["source"]) => (typeof end === "object" && end !== null ? String(end.id) : String(end));

  const drawEmergent = (ctx: CanvasRenderingContext2D, scale: number) => {
    const p = palette();
    ctx.save();
    for (const l of Object.values(live.current.links)) {
      const a = nodeCache.current.get(l.a);
      const b = nodeCache.current.get(l.b);
      if (a?.x === undefined || a.y === undefined || b?.x === undefined || b.y === undefined) continue;
      const dim = isDim(l.a) || isDim(l.b);
      const px = 1.2 + Math.min(5, Math.log2(1 + l.total) * 1.3);
      ctx.lineWidth = px / scale;
      ctx.strokeStyle = withAlpha(p[LINK_COLOR[dominant(l)]], dim ? 0.14 : 0.55);
      ctx.setLineDash(dim ? [3 / scale, 4 / scale] : []);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  };

  const drawPulses = (ctx: CanvasRenderingContext2D, scale: number) => {
    const p = palette();
    const now = performance.now();
    pulses.current = pulses.current.filter((q) => now - q.t0 < PULSE_MS);
    ctx.save();
    for (const q of pulses.current) {
      const t = (now - q.t0) / PULSE_MS;
      if (t < 0) continue;
      const a = nodeCache.current.get(q.from);
      const b = nodeCache.current.get(q.to);
      if (a?.x === undefined || a.y === undefined || b?.x === undefined || b.y === undefined) continue;
      const e = t * t * (3 - 2 * t);
      const x = a.x + (b.x - a.x) * e;
      const y = a.y + (b.y - a.y) * e;
      const color = p[PARTICLE_COLOR[q.kind]];
      ctx.shadowColor = color;
      ctx.shadowBlur = 10;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, 4.5 / scale, 0, 2 * Math.PI);
      ctx.fill();
    }
    ctx.restore();
  };

  const label = (ctx: CanvasRenderingContext2D, text: string, x: number, y: number, px: number, color: string, bold = false) => {
    ctx.font = `${bold ? "700 " : ""}${px}px ${monoFont()}`;
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  };

  const drawNode = (node: Node, ctx: CanvasRenderingContext2D, scale: number) => {
    const { cells: cur, cards: cardMap, selected: sel } = live.current;
    const cell = cur[String(node.id)];
    if (!cell || node.x === undefined || node.y === undefined) return;
    const p: Palette = palette();
    const now = performance.now();
    const seenAt = firstSeen.current.get(cell.id) ?? now;
    if (!firstSeen.current.has(cell.id)) firstSeen.current.set(cell.id, now);
    const age = now - seenAt;
    const grow = age >= GROW_MS ? 1 : Math.max(0.05, easeOutBack(age / GROW_MS));
    const r = radius(cell) * grow;
    const { x, y } = node;
    const px = (n: number) => n / scale;
    const order = sel.indexOf(cell.id);

    ctx.save();
    ctx.textAlign = "center";

    if (cell.late && age < JOIN_RING_MS) {
      const phase = (age % 1200) / 1200;
      ctx.beginPath();
      ctx.arc(x, y, r + px(4 + phase * 26), 0, 2 * Math.PI);
      ctx.lineWidth = px(2);
      ctx.strokeStyle = withAlpha(p.accent, 1 - phase);
      ctx.stroke();
    }

    ctx.globalAlpha = cell.alive ? (cell.quarantined ? 0.85 : 1) : 0.4;
    if (order >= 0) {
      ctx.shadowColor = p.fg;
      ctx.shadowBlur = 14;
    }
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 2 * Math.PI);
    ctx.fillStyle = cell.alive && !cell.quarantined ? p[CELL_STATE_COLOR[cell.state]] : p["panel-2"];
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = px(1.5);
    ctx.strokeStyle = cell.alive ? p.bg : p.danger;
    ctx.stroke();

    if (!cell.alive) {
      const d = r * 0.9;
      ctx.globalAlpha = 1;
      ctx.lineWidth = px(2.5);
      ctx.strokeStyle = p.danger;
      ctx.beginPath();
      ctx.moveTo(x - d, y - d);
      ctx.lineTo(x + d, y + d);
      ctx.moveTo(x + d, y - d);
      ctx.lineTo(x - d, y + d);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
    if (cell.quarantined && cell.alive) {
      ctx.beginPath();
      ctx.arc(x, y, r + px(2.5), 0, 2 * Math.PI);
      ctx.lineWidth = px(3);
      ctx.strokeStyle = p.danger;
      ctx.stroke();
      drawLock(ctx, x, y, r, p.danger, scale);
    }

    if (cell.compromised) {
      ctx.beginPath();
      ctx.arc(x, y, r + px(8), 0, 2 * Math.PI);
      ctx.lineWidth = px(2);
      ctx.setLineDash([px(5), px(4)]);
      // A slowly rotating dash reads as "active intrusion" from the back of the room.
      ctx.lineDashOffset = -now / 40 / scale;
      ctx.strokeStyle = p.danger;
      ctx.shadowColor = p.danger;
      ctx.shadowBlur = 12;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.shadowBlur = 0;
    }

    if (order >= 0) {
      ctx.beginPath();
      ctx.arc(x, y, r + px(cell.compromised ? 13 : 5), 0, 2 * Math.PI);
      ctx.lineWidth = px(3);
      ctx.strokeStyle = p.fg;
      ctx.stroke();
      const bx = x + r * 0.75 + px(8);
      const by = y - r * 0.75 - px(8);
      ctx.beginPath();
      ctx.arc(bx, by, px(8), 0, 2 * Math.PI);
      ctx.fillStyle = p.fg;
      ctx.fill();
      ctx.textBaseline = "middle";
      label(ctx, String(order + 1), bx, by + px(0.5), px(11), p.bg, true);
    }

    ctx.textBaseline = "bottom";
    let top = y - r - px(cell.compromised ? 11 : 4);
    if (cell.compromised) {
      label(ctx, "GHOST HACKED", x, top, px(13), p.danger, true);
      top -= px(15);
    }
    if (cell.late && age < JOIN_LABEL_MS) label(ctx, "+ 新加入 JOINED", x, top, px(12), p.accent, true);

    ctx.textBaseline = "top";
    ctx.globalAlpha = cell.alive ? 0.95 : 0.6;
    let below = y + r + px(cell.compromised ? 10 : 4);
    label(ctx, cell.genes > 0 ? `${cell.id} ·${cell.genes}g` : cell.id, x, below, px(13), cell.alive ? p.fg : p.danger);
    below += px(15);
    const card = cardMap[cell.id];
    if (multiModel && card) {
      label(ctx, shortModel(card.model), x, below, px(11), p.muted);
      below += px(13);
    }
    if (cell.quarantined && cell.alive) label(ctx, "已隔离 QUARANTINED", x, below, px(11), p.danger, true);
    ctx.restore();
  };

  const paintHitArea = (node: Node, color: string, ctx: CanvasRenderingContext2D) => {
    if (node.x === undefined || node.y === undefined) return;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(node.x, node.y, radius(live.current.cells[String(node.id)]) + 5, 0, 2 * Math.PI);
    ctx.fill();
  };

  const legend = (
    <div className="hidden flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted lg:flex">
      {LEGEND.map((s) => (
        <span key={s} className="flex items-center gap-1.5">
          <span className={`size-2 rounded-full ${CELL_STATE_BG[s]}`} />
          {CELL_STATE_LABEL[s]}
        </span>
      ))}
      <span className="flex items-center gap-1.5">
        <span className="size-2.5 rounded-full border-2 border-fg" />
        选中
      </span>
      <span className="flex items-center gap-1.5">
        <span className="size-2.5 rounded-full border-2 border-danger" />
        隔离
      </span>
      <span className="flex items-center gap-1.5">
        <span className="size-2.5 rounded-full border border-dashed border-danger" />
        入侵
      </span>
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
            onEngineStop={() => fgRef.current?.zoomToFit(400, 56)}
            // Wheel and drag-pan would hijack page scrolling on stage and shrink the swarm; auto-fit keeps it framed.
            enableZoomInteraction={false}
            enablePanInteraction={false}
            maxZoom={MAX_ZOOM}
            onRenderFramePre={drawEmergent}
            onRenderFramePost={drawPulses}
            nodeCanvasObject={drawNode}
            nodePointerAreaPaint={paintHitArea}
            nodeLabel={(n) => {
              const c = live.current.cells[String(n.id)];
              if (!c) return "";
              const card = live.current.cards[c.id];
              const parts = [c.id, CELL_STATE_LABEL[c.state]];
              if (card) parts.push(shortModel(card.model), `信任 trust ${card.trust.toFixed(2)}`);
              parts.push(`solved ${c.solved}`);
              if (c.taskId) parts.push(c.taskId);
              return `${parts.join(" · ")} · 点击选择 click to select`;
            }}
            linkColor={(l) => {
              const p = palette();
              return isDim(endpointId(l.source)) || isDim(endpointId(l.target)) ? p.grid : p.muted;
            }}
            linkLineDash={(l) => (isDim(endpointId(l.source)) || isDim(endpointId(l.target)) ? [2, 3] : null)}
            linkWidth={1}
            enableNodeDrag={false}
            onNodeClick={(n) => onToggle(String(n.id))}
          />
        )}
        {cellList.length === 0 && (
          <div className="absolute inset-0 grid place-items-center text-sm text-muted">{emptyText}</div>
        )}
        {cellList.length > 0 && (
          <>
            <div className="absolute top-2 left-3 flex flex-wrap items-center gap-2 text-xs">
              {selected.length === 0 ? (
                <span className="pointer-events-none text-muted">点击节点选择（最多 3 个）click cells to pick up to 3</span>
              ) : (
                <>
                  <span className="text-muted">已选 Picked</span>
                  {selected.map((id, i) => (
                    <span key={id} className="flex items-center border border-fg/70 bg-bg/80">
                      <span className="px-2 py-0.5 text-fg tabular-nums">
                        {i + 1} · {id}
                      </span>
                      <button
                        type="button"
                        disabled={!canAct}
                        onClick={() => onKill(id)}
                        className="border-l border-fg/40 px-2 py-0.5 text-danger enabled:hover:bg-danger enabled:hover:text-bg disabled:opacity-35"
                        title={`杀掉 kill ${id}`}
                      >
                        杀
                      </button>
                      <button
                        type="button"
                        onClick={() => onToggle(id)}
                        className="border-l border-fg/40 px-2 py-0.5 text-muted hover:text-fg"
                        aria-label={`取消选择 deselect ${id}`}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </>
              )}
            </div>
            {overlay && <div className="absolute top-2 right-3 max-w-[45%]">{overlay}</div>}
            <div className="pointer-events-none absolute bottom-2 left-3 flex gap-4 text-xs text-muted">
              <span>
                存活 alive <span className="text-fg tabular-nums">{alive}</span>/{cellList.length}
              </span>
              {quarantined > 0 && (
                <span className="text-danger">
                  已隔离 quarantined <span className="tabular-nums">{quarantined}</span>
                </span>
              )}
            </div>
            <div className="pointer-events-none absolute right-3 bottom-2 flex gap-3 text-xs text-muted">
              <span>协作边 emergent</span>
              {LINK_LEGEND.map(([reason, text]) => (
                <span key={reason} className="flex items-center gap-1.5">
                  <span className={`h-[3px] w-4 ${LINK_BG[reason]}`} />
                  {text}
                </span>
              ))}
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}
