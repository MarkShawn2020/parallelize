import { describe, expect, it } from "vitest";
import { LineageGraph } from "./lineage";
import type { LineageNode } from "./types";

const node = (id: string, kind: LineageNode["kind"], parents: string[] = [], cellId?: string): LineageNode => ({
  id,
  kind,
  parents,
  at: 0,
  ...(cellId === undefined ? {} : { cellId }),
});

/** Task T; A solves from T only; B saw A before answering; C solves independently. */
function echoGraph(): LineageGraph {
  const g = new LineageGraph();
  g.add(node("T", "task"));
  g.add(node("A", "proposal", ["T"], "cellA"));
  g.add(node("B", "proposal", ["T", "A"], "cellB"));
  g.add(node("C", "proposal", ["T"], "cellC"));
  return g;
}

describe("LineageGraph", () => {
  it("rejects duplicate ids and unknown parents", () => {
    const g = new LineageGraph();
    g.add(node("T", "task"));
    expect(() => g.add(node("T", "task"))).toThrow(/duplicate/);
    expect(() => g.add(node("P", "proposal", ["missing"], "c1"))).toThrow(/unknown parent/);
    expect(() => g.add(node("S", "proposal", ["S"], "c1"))).toThrow(/unknown parent/);
    expect(g.get("P")).toBeUndefined();
  });

  it("does not alias the caller's parents array", () => {
    const g = new LineageGraph();
    g.add(node("T", "task"));
    const parents = ["T"];
    g.add(node("A", "proposal", parents, "c1"));
    parents.push("X");
    expect(g.get("A")?.parents).toEqual(["T"]);
  });

  it("computes roots: task nodes have none, independent solves are their own root", () => {
    const g = echoGraph();
    expect(g.roots("T")).toEqual(new Set());
    expect(g.roots("A")).toEqual(new Set(["A"]));
    expect(g.roots("B")).toEqual(new Set(["A"]));
    expect(g.roots("C")).toEqual(new Set(["C"]));
  });

  it("returns a copy of the root set", () => {
    const g = echoGraph();
    g.roots("B").add("Z");
    expect(g.roots("B")).toEqual(new Set(["A"]));
  });

  it("detects the echo: B saw A, so A and B are one source", () => {
    const g = echoGraph();
    expect(g.independentSources(["A", "B"])).toBe(1);
    expect(g.independentSources(["A", "B", "C"])).toBe(2);
    expect(g.independentSources(["A", "C"])).toBe(2);
    expect(g.independentSources([])).toBe(0);
    expect(g.independentSources(["A", "A"])).toBe(1);
  });

  it("groups transitively and unions roots across multiple parents", () => {
    const g = echoGraph();
    g.add(node("D", "proposal", ["T", "B", "C"], "cellD"));
    g.add(node("E", "proposal", ["T"], "cellE"));
    expect(g.roots("D")).toEqual(new Set(["A", "C"]));
    // D bridges A's and C's groups.
    expect(g.independentSources(["B", "C", "D"])).toBe(1);
    expect(g.independentSources(["B", "C", "D", "E"])).toBe(2);
  });

  it("ignores task nodes when counting sources and throws on unknown ids", () => {
    const g = echoGraph();
    expect(g.independentSources(["T", "A"])).toBe(1);
    expect(() => g.independentSources(["A", "nope"])).toThrow(/unknown node/);
    expect(() => g.roots("nope")).toThrow(/unknown node/);
    expect(() => g.isRecollision("nope", "c1")).toThrow(/unknown node/);
  });

  it("detects gene and message recollision through proper ancestors only", () => {
    const g = new LineageGraph();
    g.add(node("T", "task"));
    g.add(node("p1", "proposal", ["T"], "cell1"));
    g.add(node("g", "gene", ["p1"], "cell1"));
    g.add(node("m", "message", ["g"], "cell2"));
    g.add(node("g2", "gene", ["T"], "cell1"));

    expect(g.isRecollision("m", "cell1")).toBe(true);
    expect(g.isRecollision("m", "cell3")).toBe(false);
    expect(g.isRecollision("m", "cell2")).toBe(false);
    expect(g.isRecollision("g", "cell1")).toBe(true);
    expect(g.isRecollision("g2", "cell1")).toBe(false);
    expect(g.isRecollision("T", "cell1")).toBe(false);
  });

  it("handles long chains without recursion limits", () => {
    const g = new LineageGraph();
    g.add(node("T", "task"));
    g.add(node("p0", "proposal", ["T"], "origin"));
    const n = 50_000;
    for (let i = 1; i <= n; i++) g.add(node(`p${i}`, "proposal", ["T", `p${i - 1}`], `c${i}`));
    expect(g.roots(`p${n}`)).toEqual(new Set(["p0"]));
    expect(g.independentSources(["p0", `p${n}`])).toBe(1);
    expect(g.isRecollision(`p${n}`, "origin")).toBe(true);
    expect(g.isRecollision(`p${n}`, "nobody")).toBe(false);
  });
});
