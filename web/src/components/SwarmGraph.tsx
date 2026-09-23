import { useEffect, useMemo, useRef, type ReactNode } from "react";
import ForceGraph2D, { type ForceGraphMethods, type LinkObject, type NodeObject } from "react-force-graph-2d";
import type { CapabilityCard, CellState, Decision, Tier } from "../../../src/core/types";
import { shortModel } from "../format";
import { CELL_STATE_BG, CELL_STATE_LABEL } from "../labels";
import { CELL_STATE_COLOR, LINK_COLOR, PARTICLE_COLOR, monoFont, palette, type ColorToken, type Palette } from "../palette";
import { family, taskName } from "../stageText";
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
  emptyText: ReactNode;
  /** Top-right corner content, e.g. the latest genes. */
  overlay?: ReactNode;
  /** Judge-facing rendering: Chinese only, large type, no accumulated edges. Fixed for the life of the instance. */
  variant?: "stage";
  /** Stage only: each new decision flashes a ring on its cell. */
  decisions?: Decision[];
}

interface Pulse {
  from: string;
  to: string;
  kind: ParticleKind;
  t0: number;
}

interface Flash {
  cellId: string;
  tier: Tier;
  t0: number;
}

export interface StageStatus {
  text: string;
  color: ColorToken;
}

/** First matching row wins, so a hacked cell that is also quarantined reads as quarantined. */
export function stageStatus(cell: CellView, card: CapabilityCard | undefined): StageStatus {
  if (!cell.alive) return { text: "掉线", color: "danger" };
  if (cell.quarantined) return { text: card ? `已隔离 · 信誉 ${card.trust.toFixed(2)}` : "已隔离", color: "danger" };
  if (cell.compromised) return { text: "被入侵", color: "danger" };
  switch (cell.state) {
    case "claiming":
    case "solving":
      return { text: "做题", color: "accent" };
    // One "busy" colour: blue and purple fills were one more code to learn, and a cyan ring on blue was hard to see.
    case "verifying":
      return { text: "复核", color: "accent" };
    case "gossiping":
      return { text: "传经验", color: "accent" };
    case "dead":
      return { text: "掉线", color: "danger" };
    default:
      return { text: "空闲", color: "muted" };
  }
}

const STAGE_LEGEND: Array<[string, string]> = [
  ["在忙", "bg-accent"],
  ["空闲", "bg-muted"],
  ["出事", "bg-danger"],
];
// Long and thick enough to read from two metres away.
const FLASH_MS = 1000;
const MAX_FLASHES = 60;
// Labels hang about three lines below each node; the fit padding keeps the bottom row off the legend strip.
// The stage canvas is wide and short (~330px at 1440x900); a large pad left the swarm a small knot in the middle.
const STAGE_FIT_PAD = 64;
const ROOT_FONT_POLL_MS = 500;

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
  const { cells, cards, links, particles, height, selected, canAct, onToggle, onKill, emptyText, overlay, decisions } = props;
  const stage = props.variant === "stage";
  const [boxRef, width] = useElementWidth<HTMLDivElement>();
  const fgRef = useRef<GraphRef | undefined>(undefined);
  // Canvas callbacks read the latest props through refs so the graph is not rebuilt per event.
  const live = useRef({ cells, cards, links, selected });
  live.current = { cells, cards, links, selected };
  const nodeCache = useRef(new Map<string, Node>());
  const firstSeen = useRef(new Map<string, number>());
  const emitted = useRef(new WeakSet<Particle>());
  const pulses = useRef<Pulse[]>([]);
  const seenDecisions = useRef(new WeakSet<Decision>());
  const decisionsPrimed = useRef(false);
  const flashes = useRef<Flash[]>([]);
  // Root font size / 16: the stage view scales rem with the viewport, and canvas text must follow it.
  const rootScale = useRef(1);
  const rootScaleReadAt = useRef(-Infinity);

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
    // Stage labels are three lines of 16px+ text, so cells need more room between them.
    fg.d3Force("charge")?.strength?.(stage ? -700 : -340);
    fg.d3Force("link")?.distance?.(stage ? 110 : 72);
    fg.d3Force("flatten", flatten(stage ? 0.4 : 0.22));
    fg.d3ReheatSimulation();
    // After a page reload the whole run replays at once and onEngineStop can fit while nodes are still spreading,
    // leaving the swarm a tiny knot; refitting a few times while the layout settles keeps it framed.
    const timers = [800, 2000, 4000].map((ms) => setTimeout(() => fgRef.current?.zoomToFit(300, stage ? STAGE_FIT_PAD : 56), ms));
    return () => timers.forEach(clearTimeout);
  }, [mounted, graphData]);

  const fitPad = stage ? STAGE_FIT_PAD : 56;

  // Going fullscreen on the projector resizes the canvas; refit so the swarm stays centred.
  useEffect(() => {
    if (width > 0) fgRef.current?.zoomToFit(300, fitPad);
  }, [width, height]);

  useEffect(() => {
    const fresh = particles.filter((p) => !emitted.current.has(p));
    fresh.forEach((p) => emitted.current.add(p));
    const now = performance.now();
    fresh.slice(-PARTICLE_BURST).forEach((p, i) => {
      pulses.current.push({ from: p.from, to: p.to, kind: p.kind, t0: now + i * PULSE_STAGGER_MS });
    });
    if (pulses.current.length > MAX_PULSES) pulses.current = pulses.current.slice(-MAX_PULSES);
  }, [particles]);

  useEffect(() => {
    if (!decisions) return;
    const fresh = decisions.filter((d) => !seenDecisions.current.has(d));
    fresh.forEach((d) => seenDecisions.current.add(d));
    // Mounting mid-run (switching back from the engineering view) would otherwise flash every past decision at once.
    if (!decisionsPrimed.current) {
      decisionsPrimed.current = true;
      return;
    }
    const now = performance.now();
    for (const d of fresh) if (d.cellId) flashes.current.push({ cellId: d.cellId, tier: d.tier, t0: now });
    if (flashes.current.length > MAX_FLASHES) flashes.current = flashes.current.slice(-MAX_FLASHES);
  }, [decisions]);

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

  // Stage replaces drawEmergent: accumulated edges turn into a hairball within a minute, so only live pulses show collaboration.
  const prepareStageFrame = () => {
    const now = performance.now();
    if (now - rootScaleReadAt.current > ROOT_FONT_POLL_MS) {
      rootScaleReadAt.current = now;
      const size = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
      rootScale.current = size > 0 ? size / 16 : 1;
    }
    flashes.current = flashes.current.filter((f) => now - f.t0 < FLASH_MS);
  };

  const latestFlash = (cellId: string): Flash | undefined => {
    let found: Flash | undefined;
    for (const f of flashes.current) if (f.cellId === cellId && (!found || f.t0 >= found.t0)) found = f;
    return found;
  };

  // A dark outline keeps the text readable where it crosses lines and pulses on a projector.
  const stageLabel = (
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    size: number,
    color: string,
    weight: 400 | 600 | 700 = 400,
  ) => {
    ctx.font = `${weight} ${size}px ${monoFont()}`;
    ctx.lineJoin = "round";
    ctx.lineWidth = size * 0.28;
    ctx.strokeStyle = withAlpha(palette().bg, 0.9);
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  };

  const drawStageNode = (node: Node, ctx: CanvasRenderingContext2D, scale: number) => {
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
    const s = rootScale.current;
    const text = px(16 * s);
    const line = px(20 * s);
    const order = sel.indexOf(cell.id);
    const card = cardMap[cell.id];
    const status = stageStatus(cell, card);

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
    // Dead and quarantined keep a dark fill so the red cross and lock stay visible on top of it.
    ctx.fillStyle = cell.alive && !cell.quarantined ? p[status.color] : p["panel-2"];
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
      ctx.lineDashOffset = -now / 40 / scale;
      ctx.strokeStyle = p.danger;
      ctx.shadowColor = p.danger;
      ctx.shadowBlur = 12;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.shadowBlur = 0;
    }

    const flash = latestFlash(cell.id);
    const t = flash ? (now - flash.t0) / FLASH_MS : 1;
    if (flash && t >= 0 && t < 1) {
      const color = flash.tier === "system1" ? p.s1 : p.s2;
      ctx.beginPath();
      ctx.arc(x, y, r + px(8), 0, 2 * Math.PI);
      ctx.lineWidth = px(5);
      ctx.strokeStyle = withAlpha(color, 1 - t);
      ctx.shadowColor = color;
      ctx.shadowBlur = 10 * (1 - t);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // Outside the flash ring, so picking a cell never hides whether Jev or the LLM is judging it.
    if (order >= 0) {
      ctx.beginPath();
      ctx.arc(x, y, r + px(12), 0, 2 * Math.PI);
      ctx.lineWidth = px(3);
      ctx.strokeStyle = p.fg;
      ctx.stroke();
      const badge = px(12 * s);
      const bx = x + r * 0.75 + px(12) + badge * 0.5;
      const by = y - r * 0.75 - px(12) - badge * 0.5;
      ctx.beginPath();
      ctx.arc(bx, by, badge, 0, 2 * Math.PI);
      ctx.fillStyle = p.fg;
      ctx.fill();
      ctx.textBaseline = "middle";
      ctx.font = `700 ${text}px ${monoFont()}`;
      ctx.fillStyle = p.bg;
      ctx.fillText(String(order + 1), bx, by + px(1));
    }

    const gap = px(order >= 0 ? 16 : 10);
    if (cell.late && age < JOIN_LABEL_MS) {
      ctx.textBaseline = "bottom";
      stageLabel(ctx, "新加入", x, y - r - gap, text, p.accent, 700);
    }

    ctx.textBaseline = "top";
    let below = y + r + gap;
    ctx.globalAlpha = cell.alive ? 1 : 0.7;
    stageLabel(ctx, cell.id, x, below, text, p.fg, 700);
    below += line;
    ctx.globalAlpha = 1;
    stageLabel(ctx, status.text, x, below, text, p[status.color], 600);
    below += line;
    if (multiModel && card) stageLabel(ctx, family(card.model), x, below, text, withAlpha(p.fg, 0.75));
    ctx.restore();
  };

  const stageTooltip = (c: CellView): string => {
    const card = live.current.cards[c.id];
    const parts = [c.id, stageStatus(c, card).text];
    if (card) parts.push(family(card.model));
    if (card && !c.quarantined) parts.push(`信誉 ${card.trust.toFixed(2)}`);
    if (c.taskId) parts.push(`正在处理${taskName(c.taskId)}`);
    return `${parts.join(" · ")} · 点击选中`;
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

  const graph = mounted && (
    <ForceGraph2D<GNode, GLink>
      ref={fgRef}
      width={width}
      height={height}
      graphData={graphData}
      autoPauseRedraw={false}
      warmupTicks={40}
      cooldownTicks={120}
      onEngineStop={() => fgRef.current?.zoomToFit(400, fitPad)}
      // Wheel and drag-pan would hijack page scrolling on stage and shrink the swarm; auto-fit keeps it framed.
      enableZoomInteraction={false}
      enablePanInteraction={false}
      maxZoom={MAX_ZOOM}
      onRenderFramePre={stage ? prepareStageFrame : drawEmergent}
      onRenderFramePost={drawPulses}
      nodeCanvasObject={stage ? drawStageNode : drawNode}
      nodePointerAreaPaint={paintHitArea}
      nodeLabel={(n) => {
        const c = live.current.cells[String(n.id)];
        if (!c) return "";
        if (stage) return stageTooltip(c);
        const card = live.current.cards[c.id];
        const parts = [c.id, CELL_STATE_LABEL[c.state]];
        if (card) parts.push(shortModel(card.model), `信任 trust ${card.trust.toFixed(2)}`);
        parts.push(`solved ${c.solved}`);
        if (c.taskId) parts.push(c.taskId);
        return `${parts.join(" · ")} · 点击选择 click to select`;
      }}
      linkColor={(l) => {
        const p = palette();
        const dim = isDim(endpointId(l.source)) || isDim(endpointId(l.target));
        if (stage) return withAlpha(p.fg, dim ? 0.07 : 0.15);
        return dim ? p.grid : p.muted;
      }}
      linkLineDash={(l) => (isDim(endpointId(l.source)) || isDim(endpointId(l.target)) ? [2, 3] : null)}
      linkWidth={1}
      enableNodeDrag={false}
      onNodeClick={(n) => onToggle(String(n.id))}
    />
  );

  if (stage) {
    return (
      <section className="flex min-h-0 min-w-0 flex-col border border-grid bg-panel/90">
        <header className="flex h-11 shrink-0 items-center gap-2.5 border-b border-grid px-4">
          <span aria-hidden className="h-5 w-1 shrink-0 bg-accent" />
          <h2 className="text-xl font-semibold whitespace-nowrap text-fg">
            {cellList.length > 0 ? `${cellList.length} 个 Agent，没有指挥官` : "Agent 蜂群，没有指挥官"}
          </h2>
        </header>
        <div ref={boxRef} className="relative w-full" style={{ height }}>
          {graph}
          {cellList.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center text-xl text-muted">{emptyText}</div>
          )}
          {cellList.length > 0 && selected.length > 0 && (
            <div className="absolute top-3 left-4 flex max-w-[52%] flex-wrap items-center gap-2 text-base">
              <span className="text-fg/80">已选</span>
              {selected.map((id, i) => (
                <span key={id} className="flex items-center border border-fg/70 bg-bg/85">
                  <span className="px-2.5 py-0.5 text-fg tabular-nums">
                    {i + 1} · {id}
                  </span>
                  <button
                    type="button"
                    disabled={!canAct}
                    onClick={() => onKill(id)}
                    className="border-l border-fg/40 px-2.5 py-0.5 text-danger enabled:hover:bg-danger enabled:hover:text-bg disabled:opacity-35"
                    title={`拔掉 ${id}`}
                  >
                    杀
                  </button>
                  <button
                    type="button"
                    onClick={() => onToggle(id)}
                    className="border-l border-fg/40 px-2.5 py-0.5 text-muted hover:text-fg"
                    aria-label={`取消选中 ${id}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {cellList.length > 0 && overlay && <div className="absolute top-3 right-4 max-w-[45%]">{overlay}</div>}
        </div>
          {/* Its own row under the canvas: as an overlay it covered the labels of the lowest cells. */}
          <div className="flex h-10 flex-wrap items-center gap-x-4 gap-y-1 overflow-hidden border-t border-grid px-4 text-base text-fg/85">
            {STAGE_LEGEND.map(([text, bg]) => (
              <span key={text} className="flex items-center gap-1.5">
                <span aria-hidden className={`size-3 rounded-full ${bg}`} />
                {text}
              </span>
            ))}
            <span aria-hidden className="h-4 w-px bg-grid" />
            <span className="flex items-center gap-1.5 text-s1">
              <span aria-hidden className="size-3.5 rounded-full border-[3px] border-s1" />
              青圈 Jev 判断
            </span>
            <span className="flex items-center gap-1.5 text-s2">
              <span aria-hidden className="size-3.5 rounded-full border-[3px] border-s2" />
              琥珀圈 交给大模型
            </span>
            <span className="flex items-center gap-1.5 text-gene">
              <span aria-hidden className="size-2.5 rounded-full bg-gene shadow-[0_0_8px_var(--color-gene)]" />
              紫点 经验在传
            </span>
            <span aria-hidden className="h-4 w-px bg-grid" />
            <span className="flex items-center gap-1.5 text-danger">
              <span aria-hidden className="flex flex-col items-center">
                <span className="h-1.5 w-2 rounded-t-full border-2 border-b-0 border-danger" />
                <span className="h-2 w-3 rounded-[1px] bg-danger" />
              </span>
              红锁 已隔离
            </span>
          </div>
      </section>
    );
  }

  return (
    <Panel title="蜂群拓扑" en="Swarm" right={legend}>
      <div ref={boxRef} className="relative w-full" style={{ height }}>
        {graph}
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
