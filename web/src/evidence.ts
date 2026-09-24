/**
 * The evidence page is static on purpose: runs/ also collects live demo runs and simulated runs, and a
 * judge must see the same numbers every visit, offline included. Every row names its runId so a question
 * can be traced back to runs/<runId>/summary.json.
 *
 * Source: the 2026-09-23 comparison (runs/compare-20260923-152732.json), all real-model runs with
 * taskSource {synthetic, hard}, n = 96, cells = 8, no inherited library, none aborted.
 */

export type EvidenceStyle = "muted" | "fg" | "dim" | "accent" | "hatched";

export interface EvidenceRow {
  runId: string;
  label: string;
  correct: number;
  total: number;
  /** metrics.costUsd from summary.json. */
  costUsd: number;
  /** finishedAt - startedAt from summary.json, in seconds. */
  wallS: number;
  style: EvidenceStyle;
  badge?: string;
  note?: string;
}

export interface EvidenceBox {
  title: string;
  tag?: string;
  lines: readonly string[];
}

export const EVIDENCE_TOTAL = 96;

export const EVIDENCE_TITLE = `同一个模型 Claude Haiku 4.5 · 同一批 ${EVIDENCE_TOTAL} 道困难题 · 8 个 Agent`;

export const EVIDENCE_ROWS: readonly EvidenceRow[] = [
  {
    runId: "single-20260923-152044-53da",
    label: "单 Agent",
    correct: 61,
    total: EVIDENCE_TOTAL,
    costUsd: 0.061681,
    wallS: 58.712,
    style: "muted",
  },
  {
    runId: "swarm-solo-20260923-152701-d944",
    label: "只并行（个体之和）",
    correct: 77,
    total: EVIDENCE_TOTAL,
    costUsd: 0.114609,
    wallS: 31.103,
    style: "fg",
  },
  {
    runId: "subagent-20260923-152348-20ea",
    label: "Sub-Agent",
    correct: 77,
    total: EVIDENCE_TOTAL,
    costUsd: 0.239956,
    wallS: 48.902,
    style: "dim",
  },
  {
    runId: "swarm-rules-20260923-152617-a404",
    label: "规则蜂群",
    correct: 81,
    total: EVIDENCE_TOTAL,
    costUsd: 0.153961,
    wallS: 43.781,
    style: "dim",
    // Said on screen before a judge asks: Jev's lead over plain rules is not significant (paired p = 0.42).
    note: "比 JIS 蜂群只少 4 题，差距不显著（p = 0.42）",
  },
  {
    runId: "swarm-llm-20260923-152436-632f",
    label: "LLM 蜂群（Haiku 判断）",
    correct: 80,
    total: EVIDENCE_TOTAL,
    costUsd: 0.309951,
    wallS: 100.956,
    style: "dim",
  },
  {
    runId: "swarm-jev-20260923-151902-323c",
    label: "JIS 蜂群（Jev + 大模型）",
    correct: 85,
    total: EVIDENCE_TOTAL,
    costUsd: 0.295811,
    wallS: 102.36,
    style: "accent",
    badge: "本作",
    // Only the question count: on 96 questions alone the paired test gives p = 0.077, not significant.
    note: "比只并行多对 8 题（85 对 77）",
  },
  {
    runId: "single-vote-20260923-152143-6b9c",
    label: "单 Agent 投票",
    correct: 87,
    total: EVIDENCE_TOTAL,
    costUsd: 0.485061,
    wallS: 124.577,
    style: "hatched",
    note: "多对 2 题，差距不显著（p = 0.8）· 多花 64% 的钱 · 没有接力、防作恶、经验继承",
  },
];

export const EVIDENCE_FOOTNOTE = "2026-09-23 真实运行 · 原始记录见仓库 docs/evidence/2026-09-23/ · 百分比四舍五入";

/** Facts from docs/技术说明.md (retest, main-comparison judge ledger, EvoMap publish). */
export const EVIDENCE_BOXES: readonly EvidenceBox[] = [
  {
    title: "换一批题再测",
    lines: ["192 道新题：只并行 84% → JIS 蜂群 93%", "两次合计 288 题：JIS 蜂群对、只并行错 34 题，反过来只有 9 题 · p = 0.00017"],
  },
  {
    title: "Jev 的账（主对照这一场）",
    lines: [
      "Jev 拍板 84 次，另有 20 次没把握转给大模型 · Jev 一共 0.2 美分 · 一次约半秒",
      "全交给大模型的那一场判断 155 次 → JIS 蜂群里大模型只判 77 次 · 总花费持平",
      "代价：「要不要复核」Jev 和大模型最近 8 次有 7 次不一致 → 自动交还大模型",
    ],
  },
  {
    title: "下一步",
    tag: "扩展",
    lines: [
      "今天：8 个 Agent、一块黑板",
      "黑板换 Redis / NATS：上千个 Agent",
      "判断记录攒够：蒸馏成本地小分类器",
      "已发回 EvoMap 1 条经验（新题 A/B 8 对 7，过了验证门）",
    ],
  },
];

export const pct = (row: Pick<EvidenceRow, "correct" | "total">): number => Math.round((row.correct / row.total) * 100);
