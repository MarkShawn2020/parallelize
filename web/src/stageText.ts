import type { Domain, ResearchClaimResult, ResearchReport } from "../../src/core/types";
import { shortModel } from "./format";

/** "t029" -> "第 29 题", "r07" -> "论断 7"; anything else is shown as is. */
export function taskName(id: string): string {
  const m = /^([tr])0*(\d+)$/.exec(id);
  if (!m) return id;
  return m[1] === "t" ? `第 ${m[2]} 题` : `论断 ${m[2]}`;
}

/** Model family for on-stage labels: the audience knows "DeepSeek", not "deepseek/deepseek-v4.1-flash". */
export function family(model: string | undefined): string {
  if (!model) return "";
  const m = model.toLowerCase();
  if (m.includes("deepseek")) return "DeepSeek";
  if (m.includes("haiku")) return "Haiku";
  if (m.includes("sonnet")) return "Sonnet";
  if (m.includes("gpt")) return "GPT";
  if (m.includes("qwen")) return "Qwen";
  if (m.includes("glm")) return "GLM";
  return shortModel(model);
}

export const DOMAIN_ZH: Record<Domain, string> = {
  arithmetic: "算术题",
  rates: "比率题",
  logic: "逻辑题",
  gsm8k: "应用题",
  research: "研究",
};

export const JUDGE_KEY_ZH: Record<string, string> = {
  verify: "要不要复核",
  adopt: "收不收经验",
  dispute: "算不算真分歧",
  claim: "领哪道题",
};

export const REJECT_ZH: Record<string, string> = {
  judge: "它的 Jev 判断没用",
  recollision: "和已有经验重复",
  sanitize: "内容可疑，已过滤",
  untrusted: "发送方信誉太低",
  rule: "已有验证过的同类经验",
};

export const DENY_ACTION_ZH: Record<string, string> = {
  read: "读黑板",
  claim: "领题",
  renew: "续租",
  release: "还题",
  propose: "交答案",
  "offer-gene": "发 Gene",
  announce: "亮能力卡",
  "update-card": "改能力卡",
  heartbeat: "报到",
};

export const DENY_REASON_ZH: Record<string, string> = {
  quarantined: "已被隔离",
  revoked: "权限已收回",
  dead: "已掉线",
  "already proposed": "同一题不能交两次",
  "no lease": "这题不在它手上",
  "not own card": "不能改别人的能力卡",
  "unknown parent": "引用了不存在的答案",
  "sender not active": "发送方已停用",
  "receiver not active": "接收方已停用",
};

export const denyReason = (reason: string): string => DENY_REASON_ZH[reason] ?? "没有权限";

export const REC_ZH: Record<ResearchReport["recommendation"], string> = {
  continue: "值得继续",
  abandon: "建议放弃",
  inconclusive: "待定",
};

export const VERDICT_ZH: Record<ResearchClaimResult["verdict"], string> = {
  supported: "站得住",
  refuted: "被推翻",
  uncertain: "证据不够",
  unresolved: "未决",
};

export const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
};
