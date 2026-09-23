import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CapabilityCard } from "../../../src/core/types";
import { IdleCard } from "../stage/IdleCard";
import type { CellView, GeneView } from "../state";
import { GeneChips, stageGeneText } from "./GeneChips";
import { SwarmGraph, stageStatus } from "./SwarmGraph";

// The force graph needs a real canvas; these tests only cover the text around it.
vi.mock("react-force-graph-2d", () => ({ default: () => null }));

const cell = (patch: Partial<CellView> = {}): CellView => ({
  id: "c03",
  state: "idle",
  neighbors: [],
  alive: true,
  solved: 0,
  genes: 0,
  spawnedAt: 0,
  late: false,
  quarantined: false,
  compromised: false,
  ...patch,
});

const card = { agentId: "c03", model: "deepseek/deepseek-v4.1-flash", trust: 0.183 } as CapabilityCard;

const gene = (patch: Partial<GeneView> = {}): GeneView => ({
  id: "g1",
  cellId: "c01",
  domain: "rates",
  text: "Convert units before dividing.",
  at: 0,
  gossiped: 0,
  adoptedBy: [],
  rejectedBy: [],
  ...patch,
});

const hasLatin = (s: string, allowed: string[]) => {
  let rest = s;
  for (const word of allowed) rest = rest.split(word).join("");
  return /[A-Za-z]{2,}/.test(rest);
};

describe("stageStatus", () => {
  it("takes the first matching row: dead, quarantined, compromised, then the working state", () => {
    expect(stageStatus(cell({ alive: false, quarantined: true, compromised: true }), card)).toEqual({ text: "掉线", color: "danger" });
    expect(stageStatus(cell({ quarantined: true, compromised: true }), card)).toEqual({ text: "已隔离 · 信誉 0.18", color: "danger" });
    expect(stageStatus(cell({ quarantined: true }), undefined).text).toBe("已隔离");
    expect(stageStatus(cell({ compromised: true, state: "solving" }), card)).toEqual({ text: "被入侵", color: "danger" });
  });

  it("shows claiming like solving and maps the remaining states to the legend colours", () => {
    expect(stageStatus(cell({ state: "claiming" }), card)).toEqual({ text: "做题", color: "accent" });
    expect(stageStatus(cell({ state: "solving" }), card)).toEqual({ text: "做题", color: "accent" });
    expect(stageStatus(cell({ state: "verifying" }), card)).toEqual({ text: "复核", color: "accent" });
    expect(stageStatus(cell({ state: "gossiping" }), card)).toEqual({ text: "传经验", color: "accent" });
    expect(stageStatus(cell({ state: "idle" }), card)).toEqual({ text: "空闲", color: "muted" });
  });
});

describe("stage gene chips", () => {
  it("says how far a gene spread in Chinese, or that it is new", () => {
    expect(stageGeneText(gene({ adoptedBy: ["c02", "c04", "c07"] }))).toBe("比率题经验 · 已被 3 个邻居收下");
    expect(stageGeneText(gene({ domain: "logic" }))).toBe("逻辑题经验 · 刚生成");
  });

  it("renders the title and ranked chips without the English gene body", () => {
    const genes = [gene({ id: "a" }), gene({ id: "b", domain: "arithmetic", adoptedBy: ["c02"] }), gene({ id: "c" })];
    const html = renderToStaticMarkup(createElement(GeneChips, { variant: "stage", genes, max: 2, onOpen: () => {} }));
    expect(html).toContain("正在流传的经验");
    expect(html.indexOf("算术题经验 · 已被 1 个邻居收下")).toBeLessThan(html.indexOf("比率题经验 · 刚生成"));
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html).not.toContain("Convert units");
    expect(html).not.toMatch(/text-xs|text-\[1|truncate/);
  });
});

describe("stage swarm graph", () => {
  const base = {
    cards: {},
    links: {},
    particles: [],
    decisions: [],
    height: 600,
    canAct: true,
    onToggle: () => {},
    onKill: () => {},
    emptyText: "等待 Agent 上线",
  };

  it("titles the panel with the live head count and keeps the legend Chinese", () => {
    const cells = { c01: cell({ id: "c01" }), c02: cell({ id: "c02" }), c03: cell({ id: "c03" }) };
    const html = renderToStaticMarkup(createElement(SwarmGraph, { ...base, variant: "stage", cells, selected: ["c02"] }));
    expect(html).toContain("3 个 Agent，没有指挥官");
    for (const word of ["在忙", "空闲", "出事", "青圈 Jev 判断", "琥珀圈 交给大模型", "紫点 经验在传", "红锁 已隔离", "已选", "1 · c02"]) {
      expect(html).toContain(word);
    }
    const text = html.replace(/<[^>]+>/g, " ");
    expect(hasLatin(text, ["Agent", "Jev"])).toBe(false);
    expect(html).not.toMatch(/text-xs|text-\[1|truncate/);
  });

  it("leaves the engineering panel as it was when no variant is given", () => {
    const html = renderToStaticMarkup(createElement(SwarmGraph, { ...base, cells: {}, selected: [] }));
    expect(html).toContain("蜂群拓扑");
    expect(html).toContain("Swarm");
    expect(html).not.toContain("没有指挥官");
  });
});

describe("IdleCard", () => {
  it("renders the three-layer story with the ring colours", () => {
    const html = renderToStaticMarkup(createElement(IdleCard));
    expect(html).toContain("一个没有指挥官的 Agent 蜂群");
    expect(html).toContain("能写成规则的协调 → 规则：原子领题，0 token");
    expect(html).toContain("text-s1");
    expect(html).toContain("text-s2");
    expect(html).toContain("想过的，变成反射。");
    expect(html).not.toMatch(/text-xs|text-\[1|truncate/);
  });
});
