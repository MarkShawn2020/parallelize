import { describe, expect, it } from "vitest";
import type { ProtocolMessage } from "../../src/core/types";
import { byNaturalId, fmtPctOrDash, safeHttpUrl, shortModel } from "./format";
import { describeBody, describeMessage } from "./protocolText";
import { primaryTarget, toggleSelected } from "./selection";
import { rankGenes } from "./components/GeneChips";
import { geneTitle } from "./components/GeneCard";
import type { GeneView } from "./state";

describe("toggleSelected", () => {
  it("adds, removes and keeps at most three picks, dropping the oldest", () => {
    let s: string[] = [];
    s = toggleSelected(s, "c1");
    s = toggleSelected(s, "c2");
    s = toggleSelected(s, "c3");
    expect(s).toEqual(["c1", "c2", "c3"]);
    s = toggleSelected(s, "c4");
    expect(s).toEqual(["c2", "c3", "c4"]);
    s = toggleSelected(s, "c3");
    expect(s).toEqual(["c2", "c4"]);
    expect(primaryTarget(s)).toBe("c4");
    expect(primaryTarget([])).toBeUndefined();
  });
});

describe("describeMessage", () => {
  const base: ProtocolMessage = { v: 1, id: "m1", runId: "A", type: "CLAIM", from: "c1", to: "board", parents: [], at: 0, body: {} };

  it("puts preferred fields first and caps the field count", () => {
    const text = describeBody({ zeta: "z", taskId: "t7", answer: "42", extra: 1, more: 2, trust: 0.456 });
    expect(text).toBe("taskId=t7 · answer=42 · trust=0.46 · zeta=z");
  });

  it("summarises arrays, skips objects and truncates long strings", () => {
    const text = describeBody({ titles: ["a", "b", "c", "d"], nested: { x: 1 }, reason: "x".repeat(80) });
    expect(text).toContain("reason=" + "x".repeat(35) + "…");
    expect(text).toContain("titles=a,b,c +1");
    expect(text).not.toContain("nested");
  });

  it("renders the route and marks broadcasts", () => {
    expect(describeMessage({ ...base, body: { taskId: "t1" } })).toBe("c1 → board · taskId=t1");
    expect(describeMessage({ ...base, to: "*" })).toBe("c1 → * 广播");
  });
});

describe("format helpers", () => {
  it("only accepts http(s) urls", () => {
    expect(safeHttpUrl("https://evomap.ai/a/1")).toBe("https://evomap.ai/a/1");
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("not a url")).toBeNull();
  });

  it("shortens model ids, sorts ids naturally and dashes missing metrics", () => {
    expect(shortModel("anthropic/claude-haiku-4.5")).toBe("claude-haiku-4.5");
    expect(shortModel("mock")).toBe("mock");
    expect(["c10", "c2", "c1"].sort(byNaturalId)).toEqual(["c1", "c2", "c10"]);
    expect(fmtPctOrDash(undefined)).toBe("—");
    expect(fmtPctOrDash(0.25)).toBe("25.0%");
  });
});

describe("gene chips", () => {
  const gene = (id: string, adopted: number): GeneView => ({
    id,
    cellId: "c01",
    domain: "rates",
    text: id,
    at: 0,
    gossiped: adopted,
    adoptedBy: Array.from({ length: adopted }, (_, i) => `c0${i + 2}`),
    rejectedBy: [],
  });

  it("keeps spreading genes on screen when newer genes with no takers arrive", () => {
    const genes = [gene("old-popular", 3), gene("mid", 1), gene("new-a", 0), gene("new-b", 0)];
    expect(rankGenes(genes, 3).map((g) => g.id)).toEqual(["old-popular", "mid", "new-b"]);
  });

  it("drops markdown emphasis from the title line", () => {
    expect(geneTitle("**Strategy:** Break the timeline into phases\nmore")).toBe("Strategy: Break the timeline into phases");
    expect(geneTitle("## Rates")).toBe("Rates");
  });
});
