import type { CellState, Mode, TaskStatus } from "../../src/core/types";

export const MODE_LABEL: Record<Mode, string> = {
  single: "单上下文",
  subagent: "Sub-Agent",
  "swarm-llm": "LLM 协调蜂群",
  "swarm-jev": "Jev 协调蜂群",
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
