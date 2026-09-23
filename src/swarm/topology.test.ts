import { describe, expect, it } from "vitest";
import { buildTopology, edgesOf, type TopologyKind } from "./topology";

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `cell-${String(n - i).padStart(2, "0")}`);
const SIZES = [1, 2, 3, 8, 24];
const KINDS: TopologyKind[] = ["ring", "small-world"];

function ringEdgeCount(n: number): number {
  return n < 2 ? 0 : n === 2 ? 1 : n;
}

describe("buildTopology invariants", () => {
  for (const kind of KINDS) {
    for (const n of SIZES) {
      it(`${kind} n=${n}: symmetric, simple, ordered, deterministic`, () => {
        const cells = ids(n);
        const topo = buildTopology(cells, kind, 7);
        expect([...topo.keys()]).toEqual(cells);

        for (const [a, ns] of topo) {
          expect(ns).not.toContain(a);
          expect(new Set(ns).size).toBe(ns.length);
          const positions = ns.map((b) => cells.indexOf(b));
          expect(positions.every((p) => p >= 0)).toBe(true);
          expect(positions).toEqual([...positions].sort((x, y) => x - y));
          for (const b of ns) expect(topo.get(b)).toContain(a);
        }

        expect(buildTopology(cells, kind, 7)).toEqual(topo);
      });

      it(`${kind} n=${n}: degree and edge bounds`, () => {
        const cells = ids(n);
        const topo = buildTopology(cells, kind, 7);
        const edges = edgesOf(topo);
        const degrees = [...topo.values()].map((ns) => ns.length);
        expect(edges).toHaveLength(degrees.reduce((s, d) => s + d, 0) / 2);

        if (kind === "ring") {
          for (const d of degrees) expect(d).toBe(Math.min(2, n - 1));
          expect(edges).toHaveLength(ringEdgeCount(n));
        } else {
          for (const d of degrees) {
            expect(d).toBeGreaterThanOrEqual(Math.min(3, n - 1));
            expect(d).toBeLessThanOrEqual(Math.max(0, n - 1));
          }
          expect(edges.length).toBeGreaterThanOrEqual(ringEdgeCount(n));
          expect(edges.length).toBeLessThanOrEqual(ringEdgeCount(n) + n);
        }
      });
    }
  }
});

describe("buildTopology shapes", () => {
  it("handles tiny swarms", () => {
    expect(buildTopology(["a"], "small-world", 1)).toEqual(new Map([["a", []]]));
    expect(buildTopology(["a", "b"], "small-world", 1)).toEqual(
      new Map([
        ["a", ["b"]],
        ["b", ["a"]],
      ]),
    );
  });

  it("links each ring cell to its predecessor and successor in cellIds order", () => {
    const topo = buildTopology(["z", "m", "a", "q"], "ring", 0);
    expect(topo).toEqual(
      new Map([
        ["z", ["m", "q"]],
        ["m", ["z", "a"]],
        ["a", ["m", "q"]],
        ["q", ["z", "a"]],
      ]),
    );
  });

  it("small-world contains the ring and adds long-range links", () => {
    for (const n of [8, 24]) {
      const cells = ids(n);
      const ring = buildTopology(cells, "ring", 3);
      const sw = buildTopology(cells, "small-world", 3);
      for (const [a, ns] of ring) {
        for (const b of ns) expect(sw.get(a)).toContain(b);
      }
      expect(edgesOf(sw).length).toBeGreaterThan(edgesOf(ring).length);
    }
  });

  it("ring ignores the seed; small-world depends on it", () => {
    const cells = ids(24);
    expect(buildTopology(cells, "ring", 1)).toEqual(buildTopology(cells, "ring", 2));
    expect(buildTopology(cells, "small-world", 1)).not.toEqual(buildTopology(cells, "small-world", 2));
  });
});

describe("edgesOf", () => {
  it("lists each undirected edge once with endpoints in insertion order", () => {
    const topo = buildTopology(["c", "a", "b"], "ring", 0);
    expect(edgesOf(topo)).toEqual([
      ["c", "a"],
      ["c", "b"],
      ["a", "b"],
    ]);
  });

  it("orders endpoints and has no duplicates on a larger graph", () => {
    const cells = ids(24);
    const edges = edgesOf(buildTopology(cells, "small-world", 11));
    const keys = new Set(edges.map(([a, b]) => `${a}|${b}`));
    expect(keys.size).toBe(edges.length);
    for (const [a, b] of edges) {
      expect(cells.indexOf(a)).toBeLessThan(cells.indexOf(b));
      expect(keys.has(`${b}|${a}`)).toBe(false);
    }
  });

  it("returns nothing for an isolated cell", () => {
    expect(edgesOf(buildTopology(["solo"], "ring", 0))).toEqual([]);
  });
});
