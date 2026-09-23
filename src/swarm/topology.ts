import { mulberry32 } from "../core/rng";

export type TopologyKind = "ring" | "small-world";

export function buildTopology(cellIds: string[], kind: TopologyKind, seed: number): Map<string, string[]> {
  const n = cellIds.length;
  const adj = new Map<string, Set<string>>(cellIds.map((id) => [id, new Set<string>()]));
  const link = (a: string, b: string): void => {
    if (a === b) return;
    adj.get(a)?.add(b);
    adj.get(b)?.add(a);
  };

  for (let i = 0; i < n; i++) {
    link(cellIds[i] as string, cellIds[(i + 1) % n] as string);
  }

  if (kind === "small-world") {
    const rand = mulberry32(seed);
    for (const id of cellIds) {
      const mine = adj.get(id) as Set<string>;
      const candidates = cellIds.filter((c) => c !== id && !mine.has(c));
      if (candidates.length === 0) continue;
      link(id, candidates[Math.floor(rand() * candidates.length)] as string);
    }
  }

  const pos = new Map(cellIds.map((id, i) => [id, i]));
  const order = (a: string, b: string): number => (pos.get(a) ?? 0) - (pos.get(b) ?? 0);
  return new Map(cellIds.map((id) => [id, [...(adj.get(id) as Set<string>)].sort(order)]));
}

/** Each undirected edge once, as [a, b] with a before b in the map's insertion order. */
export function edgesOf(topology: Map<string, string[]>): Array<[string, string]> {
  const pos = new Map([...topology.keys()].map((id, i) => [id, i]));
  const edges: Array<[string, string]> = [];
  for (const [a, neighbours] of topology) {
    const pa = pos.get(a) as number;
    for (const b of neighbours) {
      if ((pos.get(b) ?? -1) > pa) edges.push([a, b]);
    }
  }
  return edges;
}
