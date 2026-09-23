import type { CellState, Domain, Mode, ProtocolType, ResearchClaimResult, ResearchReport, TaskStatus } from "../../src/core/types";

export const MODE_LABEL: Record<Mode, string> = {
  single: "单上下文",
  "single-vote": "同预算投票",
  subagent: "Sub-Agent",
  "swarm-llm": "LLM 协调蜂群",
  "swarm-jev": "Jev 协调蜂群",
  "swarm-rules": "规则蜂群",
  "swarm-solo": "仅并行",
};

export const MODE_HINT: Record<Mode, string> = {
  single: "一个上下文做完所有任务 one context for all tasks",
  "single-vote": "同等 Token 预算，每题独立做 k 次后多数投票 same budget, k samples, majority vote",
  subagent: "子 Agent 各做一部分，协调者有损合并 workers + lossy coordinator merge",
  "swarm-llm": "判断型协调全部交给大模型 all judgments by the LLM",
  "swarm-jev": "Jev 做反射判断，低置信升级大模型 Jev System 1 + LLM escalation",
  "swarm-rules": "固定规则协调，没有判断者 fixed rules, no judge",
  "swarm-solo": "只并行认领和确定性合并，不复核不传基因 = 单体之和 parallel only = sum of singles",
};

export const CELL_STATE_LABEL: Record<CellState, string> = {
  idle: "空闲 idle",
  claiming: "认领 claim",
  solving: "求解 solve",
  verifying: "复核 verify",
  gossiping: "传播 gossip",
  dead: "阵亡 dead",
};

/** Full class strings so Tailwind's scanner sees them. */
export const CELL_STATE_BG: Record<CellState, string> = {
  idle: "bg-muted",
  claiming: "bg-s1",
  solving: "bg-accent",
  verifying: "bg-verify",
  gossiping: "bg-gene",
  dead: "bg-danger",
};

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  open: "开放 open",
  claimed: "认领 claimed",
  verifying: "复核 verifying",
  accepted: "接受 accepted",
  failed: "失败 failed",
};

export const TASK_STATUS_BG: Record<TaskStatus, string> = {
  open: "bg-panel-2",
  claimed: "bg-s1/70",
  verifying: "bg-verify/70",
  accepted: "bg-fg/55",
  failed: "bg-danger/35",
};

export const DOMAIN_LABEL: Record<Domain, string> = {
  arithmetic: "算术",
  rates: "比率",
  logic: "逻辑",
  gsm8k: "GSM8K",
  research: "研究",
};

export const SOURCE_LABEL: Record<"local" | "evomap", string> = { local: "本地 local", evomap: "EvoMap" };

export const VERDICT_LABEL: Record<ResearchClaimResult["verdict"], string> = {
  supported: "支持 supported",
  refuted: "反驳 refuted",
  uncertain: "不确定 uncertain",
  unresolved: "未决 unresolved",
};

export const VERDICT_TEXT: Record<ResearchClaimResult["verdict"], string> = {
  supported: "text-ok",
  refuted: "text-danger",
  uncertain: "text-warn",
  unresolved: "text-muted",
};

export const RECOMMENDATION: Record<ResearchReport["recommendation"], { zh: string; en: string; tone: string }> = {
  continue: { zh: "继续", en: "CONTINUE", tone: "border-ok text-ok" },
  abandon: { zh: "放弃", en: "ABANDON", tone: "border-danger text-danger" },
  inconclusive: { zh: "不确定", en: "INCONCLUSIVE", tone: "border-warn text-warn" },
};

export const PROTOCOL_LABEL: Record<ProtocolType, string> = {
  ANNOUNCE: "宣告",
  HEARTBEAT: "心跳",
  DISCOVER: "发现",
  CLAIM: "认领",
  PROPOSE: "提交",
  REVIEW_REQUEST: "请求复核",
  ACCEPT: "接受",
  ECHO_ALARM: "回声警报",
  GENE_OFFER: "基因要约",
  GENE_ADOPT: "采纳基因",
  GENE_REJECT: "拒绝基因",
  LIBRARY_QUERY: "查经验库",
  LIBRARY_RESULT: "经验库结果",
  QUARANTINE: "隔离",
  DENIED: "越权拒绝",
};

export const PROTOCOL_TEXT: Record<ProtocolType, string> = {
  ANNOUNCE: "text-s1",
  HEARTBEAT: "text-muted",
  DISCOVER: "text-s1",
  CLAIM: "text-accent",
  PROPOSE: "text-accent",
  REVIEW_REQUEST: "text-verify",
  ACCEPT: "text-ok",
  ECHO_ALARM: "text-danger",
  GENE_OFFER: "text-gene",
  GENE_ADOPT: "text-gene",
  GENE_REJECT: "text-gene",
  LIBRARY_QUERY: "text-s2",
  LIBRARY_RESULT: "text-s2",
  QUARANTINE: "text-danger",
  DENIED: "text-danger",
};
