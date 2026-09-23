import { EVIDENCE_ROWS, EVIDENCE_TOTAL } from "./evidence";

/**
 * The nine-lecture ladder's seven measured rungs, in the order the pitch tells them. Numbers come from the same
 * 2026-09-23 real runs as the evidence page (Haiku 4.5, 96 hard tasks); `auditable` is the share of accepted answers
 * with two or more independent sources, counted from each run's task.accepted events.
 */
export interface Paradigm {
  lecture: number;
  name: string;
  runId: string;
  adds: string;
  fit: string;
  cost: string;
  correct: number;
  costUsd: number;
  wallS: number;
  auditable: number;
  /** Tailwind colour token for its radar and highlights. */
  tone: "muted" | "fg" | "s2" | "accent";
}

const LADDER: ReadonlyArray<Omit<Paradigm, "correct" | "costUsd" | "wallS">> = [
  {
    lecture: 1,
    name: "单 Agent",
    runId: "single-20260923-152044-53da",
    adds: "最简单：一个上下文，一次把 96 道题全做完。",
    fit: "题少、题简单、预算最紧",
    cost: "上下文越长越乱；做错了没人发现，也没有第二个来源",
    auditable: 0,
    tone: "muted",
  },
  {
    lecture: 2,
    name: "同预算投票",
    runId: "single-vote-20260923-152143-6b9c",
    adds: "同一个 Agent 每题独立做 4 次取多数，和 Jev 蜂群花同样多的 token。",
    fit: "只求单次准确率，不在乎钱和时间",
    cost: "多花 64% 的钱、最慢；坏一个就少一票，没有接力、防作恶和经验继承",
    auditable: 0,
    tone: "muted",
  },
  {
    lecture: 3,
    name: "Sub-Agent",
    runId: "subagent-20260923-152348-20ea",
    adds: "主管把题分给子 Agent，再把报告汇总成答案。",
    fit: "任务能拆、需要一个统一出口",
    cost: "汇总是一道有损的传话：EvoMap 实测 373 个对的中间答案，汇总后只剩 207 个",
    auditable: 0,
    tone: "muted",
  },
  {
    lecture: 4,
    name: "只并行",
    runId: "swarm-solo-20260923-152701-d944",
    adds: "换成黑板：谁有空谁领题，原子认领，协调 0 token。",
    fit: "题目彼此独立、要又快又省",
    cost: "等于个体之和：没人复核，错了照样收下",
    auditable: 0,
    tone: "fg",
  },
  {
    lecture: 5,
    name: "规则蜂群",
    runId: "swarm-rules-20260923-152617-a404",
    adds: "加上互相复核和经验（Gene）传递，全部用固定规则判断。",
    fit: "预算紧，又想要复核的一档",
    cost: "规则写不出「算不算真分歧」「这条经验适不适合我」这类判断",
    auditable: 16.7,
    tone: "s2",
  },
  {
    lecture: 6,
    name: "大模型协调蜂群",
    runId: "swarm-llm-20260923-152436-632f",
    adds: "规则写不出来的判断，全部交给大模型。",
    fit: "没有 Jev 的时候",
    cost: "每条判断都要大模型想一遍：155 次判断，贵、慢",
    auditable: 52.1,
    tone: "s2",
  },
  {
    lecture: 7,
    name: "Jev 协调蜂群",
    runId: "swarm-jev-20260923-151902-323c",
    adds: "判断先交给 Jev（约半秒、只收输入的钱），拿不准才请大模型；大模型的裁决经复核确认后变成判例。",
    fit: "判断多、要快、要可审计",
    cost: "比规则蜂群只多 4 题，差距不显著（p=0.42）；「要不要复核」Jev 最近 8 次有 7 次和大模型不一致，系统自动交还",
    auditable: 58.3,
    tone: "accent",
  },
];

export const PARADIGMS: readonly Paradigm[] = LADDER.map((p) => {
  const row = EVIDENCE_ROWS.find((r) => r.runId === p.runId);
  if (!row) throw new Error(`evidence row missing for ${p.runId}`);
  return { ...p, correct: row.correct, costUsd: row.costUsd, wallS: row.wallS };
});

export const RADAR_AXES = ["准确率", "省钱", "速度", "可审计"] as const;

const minCost = Math.min(...PARADIGMS.map((p) => p.costUsd));
const minWall = Math.min(...PARADIGMS.map((p) => p.wallS));

export const accuracyOf = (p: Paradigm): number => (p.correct / EVIDENCE_TOTAL) * 100;

/** 0-100 per axis, outward is better; cost and speed are relative to the cheapest and fastest rung. */
export function radarValues(p: Paradigm): number[] {
  return [accuracyOf(p), (minCost / p.costUsd) * 100, (minWall / p.wallS) * 100, p.auditable];
}
