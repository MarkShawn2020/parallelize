import type { PublicTask, ResearchClaimResult, ResearchReport, ResearchVerdict, Task, TaskEntry } from "../core/types";
import { claimText, isCanaryTask, normalizeVerdict } from "../tasks/research";

const VERDICT_ZH: Record<ResearchVerdict | "unresolved", string> = {
  supported: "支持",
  refuted: "反驳",
  uncertain: "不确定",
  unresolved: "未决",
};
const RECOMMENDATION_ZH: Record<ResearchReport["recommendation"], string> = {
  continue: "继续",
  abandon: "放弃",
  inconclusive: "待定",
};

export function buildResearchReport(p: {
  idea: string;
  tasks: Task[];
  entries: TaskEntry[];
  normalize: (s: string) => string;
}): ResearchReport {
  const byId = new Map(p.entries.map((e) => [e.task.id, e]));
  const verdictOf = (answer: string) => normalizeVerdict(p.normalize(answer));
  const keyOf = (answer: string): string => verdictOf(answer) ?? p.normalize(answer);

  const claims = p.tasks.map((t): ResearchClaimResult => {
    const entry = byId.get(t.id);
    const accepted = entry?.acceptedAnswer;
    const keys = (entry?.proposals ?? []).map((pr) => keyOf(pr.answer));
    const canary = isCanaryTask(t) ? normalizeVerdict(t.answer) : undefined;
    return {
      taskId: t.id,
      claim: claimText(t.prompt),
      ...(canary === undefined ? {} : { canary }),
      verdict: (accepted === undefined ? undefined : verdictOf(accepted)) ?? "unresolved",
      independentSources: entry?.independentSources ?? 0,
      proposals: keys.length,
      dissent: accepted === undefined ? keys.length - largestGroup(keys) : keys.filter((k) => k !== keyOf(accepted)).length,
    };
  });

  const canaries = claims.filter((c) => c.canary !== undefined);
  const canaryPassed = canaries.filter((c) => c.verdict === c.canary).length;
  return { idea: p.idea, claims, canaryPassed, canaryTotal: canaries.length, ...recommend(claims, canaryPassed, canaries.length) };
}

/** Without an accepted answer, dissent is everything outside the largest agreeing group. */
function largestGroup(keys: string[]): number {
  const counts = new Map<string, number>();
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  return Math.max(0, ...counts.values());
}

function recommend(
  claims: ResearchClaimResult[],
  canaryPassed: number,
  canaryTotal: number,
): Pick<ResearchReport, "recommendation" | "rule"> {
  const canaryText = canaryTotal === 0 ? "未设金丝雀" : `金丝雀 ${canaryPassed}/${canaryTotal} 判对`;
  if (canaryPassed < canaryTotal) {
    return { recommendation: "inconclusive", rule: `${canaryText} → 金丝雀论断未全部判对，结论不可信` };
  }
  const ideas = claims.filter((c) => c.canary === undefined);
  const n = ideas.length;
  if (n === 0) return { recommendation: "inconclusive", rule: `${canaryText}；论断 0 条 → 无可评估的论断，结论待定` };

  const count = (v: ResearchClaimResult["verdict"]) => ideas.filter((c) => c.verdict === v).length;
  const s = count("supported");
  const r = count("refuted");
  const unresolved = count("unresolved");
  const head =
    `${canaryText}；论断 ${n} 条：支持 ${s}、反驳 ${r}、不确定 ${count("uncertain")}` + (unresolved > 0 ? `、未决 ${unresolved}` : "");
  // Integer comparisons: s/n >= 0.6 <=> 5s >= 3n, so float rounding never flips a threshold.
  const supportOk = 5 * s >= 3 * n;
  if (supportOk && 4 * r < n) {
    return { recommendation: "continue", rule: `${head} → 支持占比 ${pct(s, n, 60)} ≥ 60% 且反驳 ${pct(r, n, 25)} < 25% → 建议继续` };
  }
  if (5 * r >= 2 * n) return { recommendation: "abandon", rule: `${head} → 反驳占比 ${pct(r, n, 40)} ≥ 40% → 建议放弃` };
  const why = supportOk
    ? `支持占比 ${pct(s, n, 60)} ≥ 60% 但反驳 ${pct(r, n, 25)} ≥ 25%，且反驳未达放弃线 40%`
    : `支持占比 ${pct(s, n, 60)} < 60% 且反驳 ${pct(r, n, 40)} < 40%`;
  return { recommendation: "inconclusive", rule: `${head} → ${why} → 结论待定` };
}

function pct(count: number, n: number, threshold: number): string {
  const rounded = Math.round((count * 100) / n);
  // A share just below the threshold must not print as reaching it ("60% < 60%").
  if (count * 100 < threshold * n && rounded >= threshold) return `${(Math.floor((count * 1000) / n) / 10).toFixed(1)}%`;
  return `${rounded}%`;
}

/** Blackboard-shaped entries for modes without a blackboard (single, single-vote, subagent). */
export function entriesFromAnswers(tasks: PublicTask[], answers: ReadonlyMap<string, string>): TaskEntry[] {
  return tasks.map((t): TaskEntry => {
    const task: PublicTask = { id: t.id, domain: t.domain, prompt: t.prompt };
    const answer = answers.get(t.id);
    return answer === undefined
      ? { task, status: "failed", attempts: 1, proposals: [], proposers: [] }
      : { task, status: "accepted", attempts: 1, proposals: [], proposers: [], acceptedAnswer: answer, independentSources: 1 };
  });
}

const cell = (s: string) => s.replace(/\s+/g, " ").replaceAll("|", "\\|").trim();

export function reportMarkdown(r: ResearchReport): string {
  const rows = r.claims.map((c) => {
    const kind = c.canary === undefined ? "论断" : `金丝雀（真值：${VERDICT_ZH[c.canary]}）`;
    const mark = c.canary === undefined ? "" : c.verdict === c.canary ? "（判对）" : "（判错）";
    return `| ${c.taskId} | ${cell(c.claim)} | ${kind} | ${VERDICT_ZH[c.verdict]}${mark} | ${c.independentSources} | ${c.proposals} | ${c.dissent} |`;
  });
  return [
    "# 研究报告",
    "",
    `**想法**：${cell(r.idea)}`,
    "",
    `**建议**：${RECOMMENDATION_ZH[r.recommendation]}（${r.recommendation}）`,
    "",
    `**依据**：${r.rule}`,
    "",
    `**金丝雀**：${r.canaryPassed}/${r.canaryTotal} 判对`,
    "",
    "| 编号 | 论断 | 类型 | 结论 | 独立来源 | 提案 | 异议 |",
    "| --- | --- | --- | --- | ---: | ---: | ---: |",
    ...rows,
    "",
  ].join("\n");
}
