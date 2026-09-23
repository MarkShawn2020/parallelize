import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ResearchReport, RunSummary } from "../../src/core/types";
import { orderRuns } from "./components/CompareTable";
import { EVIDENCE_ROWS, pct } from "./evidence";
import { EvidencePage } from "./stage/EvidencePage";
import { ResearchPage, summarizeClaims } from "./stage/ResearchPage";

// Stage pages must read from two metres away and stay Chinese-only.
const BANNED = ["text-xs", "text-[1", "truncate", "AIR", "S1", "S2", "gossip", "canary", "INCONCLUSIVE"];

const F678: ResearchReport = {
  idea: "在深圳城中村的楼顶装光伏板，给电动自行车集中充电站供电",
  claims: [
    { taskId: "r01", claim: "铜是良好的电导体", canary: "supported", verdict: "supported", independentSources: 2, proposals: 2, dissent: 0 },
    { taskId: "r02", claim: "装机容量可满足日均50辆充电需求", verdict: "uncertain", independentSources: 2, proposals: 2, dissent: 0 },
    { taskId: "r03", claim: "安装成本低于15万元/100kW", verdict: "supported", independentSources: 2, proposals: 2, dissent: 0 },
    { taskId: "r04", claim: "金鱼的记忆只有3秒", canary: "refuted", verdict: "refuted", independentSources: 2, proposals: 2, dissent: 0 },
    { taskId: "r05", claim: "已有3个以上类似项目", verdict: "uncertain", independentSources: 2, proposals: 2, dissent: 0 },
    { taskId: "r06", claim: "日均充电需求超过100辆次", verdict: "uncertain", independentSources: 2, proposals: 2, dissent: 0 },
    { taskId: "r07", claim: "楼顶光伏不存在产权纠纷", verdict: "refuted", independentSources: 2, proposals: 2, dissent: 0 },
    { taskId: "r08", claim: "可降低火灾风险80%以上", verdict: "uncertain", independentSources: 1, proposals: 1, dissent: 0 },
    { taskId: "r09", claim: "太平洋是面积最大的海洋", canary: "supported", verdict: "supported", independentSources: 2, proposals: 2, dissent: 0 },
    { taskId: "r10", claim: "长城在月球上肉眼可见", canary: "refuted", verdict: "refuted", independentSources: 2, proposals: 2, dissent: 0 },
  ],
  canaryPassed: 4,
  canaryTotal: 4,
  recommendation: "inconclusive",
  rule: "",
};

describe("evidence rows", () => {
  it("match the 2026-09-23 comparison as read on stage", () => {
    expect(EVIDENCE_ROWS.map(pct)).toEqual([64, 80, 80, 84, 83, 89, 91]);
    expect(EVIDENCE_ROWS.map((r) => `$${r.costUsd.toFixed(2)} · ${Math.round(r.wallS)}`)).toEqual([
      "$0.06 · 59",
      "$0.11 · 31",
      "$0.24 · 49",
      "$0.15 · 44",
      "$0.31 · 101",
      "$0.30 · 102",
      "$0.49 · 125",
    ]);
    expect(EVIDENCE_ROWS.every((r) => r.total === 96)).toBe(true);
  });

  it("keeps the hand-written annotations consistent with the numbers", () => {
    const byMode = (prefix: string) => EVIDENCE_ROWS.find((r) => r.runId.startsWith(prefix))!;
    const jev = byMode("swarm-jev-");
    const solo = byMode("swarm-solo-");
    const vote = byMode("single-vote-");
    expect(jev.note).toContain(`多对 ${jev.correct - solo.correct} 题（${jev.correct} 对 ${solo.correct}）`);
    expect(vote.note).toContain(`多对 ${vote.correct - jev.correct} 题`);
    expect(vote.note).toContain(`多花 ${Math.round((vote.costUsd / jev.costUsd - 1) * 100)}% 的钱`);
  });

  it("renders every row without banned stage tokens", () => {
    const html = renderToStaticMarkup(createElement(EvidencePage));
    const text = html.replace(/<[^>]+>/g, "");
    for (const r of EVIDENCE_ROWS) expect(text).toContain(r.label);
    expect(html).toContain("89%");
    expect(html).toContain("本作");
    for (const b of BANNED) expect(html).not.toContain(b);
  });
});

describe("research page", () => {
  it("counts only non-canary claims and sorts refuted first", () => {
    const s = summarizeClaims(F678);
    expect(s.claims.map((c) => c.taskId)).toEqual(["r07", "r03", "r02", "r05", "r06", "r08"]);
    expect(s.counts).toEqual({ supported: 1, refuted: 1, uncertain: 4, unresolved: 0 });
    expect(s.firstRefuted?.taskId).toBe("r07");
    expect(s.canaryAllPassed).toBe(true);
  });

  it("renders the verdict, the summary lines and the canary footer", () => {
    const html = renderToStaticMarkup(createElement(ResearchPage, { report: F678, saved: true, idea: null }));
    expect(html).toContain("待定");
    expect(html).toContain("border-dashed");
    expect(html).toContain("这是上一次点子验证的结果（不是这一轮）");
    expect(html).toContain("4 道已知答案的测试题（金丝雀）全部判对：蜂群没被带偏");
    expect(html).toContain("被推翻：</span>楼顶光伏不存在产权纠纷");
    expect(html).toContain("另有 4 道测试题：全部判对 ✓");
    expect(html).not.toContain("铜是良好的电导体");
    for (const b of BANNED) expect(html).not.toContain(b);
  });

  it("shows the waiting and empty states", () => {
    const waiting = renderToStaticMarkup(createElement(ResearchPage, { report: null, saved: false, idea: "楼顶光伏" }));
    expect(waiting).toContain("蜂群核查中");
    expect(waiting).toContain("楼顶光伏");
    const empty = renderToStaticMarkup(createElement(ResearchPage, { report: null, saved: false, idea: null }));
    expect(empty).toContain("还没有点子验证的结果");
  });
});

describe("orderRuns", () => {
  const run = (runId: string, mode: RunSummary["mode"], startedAt: number, extra: Partial<RunSummary> = {}, research = false) =>
    ({
      runId,
      mode,
      startedAt,
      simulated: false,
      config: { taskSource: research ? { kind: "research" } : { kind: "synthetic", difficulty: "hard" } },
      ...extra,
    }) as unknown as RunSummary;

  it("uses the fixed mode order, newest first within a mode, simulated and research runs last", () => {
    const ordered = orderRuns([
      run("vote", "single-vote", 1),
      run("sim", "swarm-jev", 9, { simulated: true }),
      run("jev-old", "swarm-jev", 2),
      run("research", "swarm-jev", 8, {}, true),
      run("single", "single", 3),
      run("jev-new", "swarm-jev", 5),
      run("solo", "swarm-solo", 4),
      run("rules", "swarm-rules", 6),
      run("llm", "swarm-llm", 7),
      run("sub", "subagent", 1),
    ]);
    expect(ordered.map((r) => r.runId)).toEqual([
      "single",
      "solo",
      "sub",
      "rules",
      "llm",
      "jev-new",
      "jev-old",
      "vote",
      "sim",
      "research",
    ]);
  });
});
