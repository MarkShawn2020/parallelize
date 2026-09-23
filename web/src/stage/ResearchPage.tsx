import type { ResearchClaimResult, ResearchReport } from "../../../src/core/types";
import { REC_ZH, VERDICT_ZH } from "../stageText";

interface Props {
  report: ResearchReport | null;
  /** The report comes from an earlier research run, not the current one. */
  saved: boolean;
  /** Idea of the active research run, shown until its report arrives. */
  idea: string | null;
}

type Verdict = ResearchClaimResult["verdict"];

const ORDER: Record<Verdict, number> = { refuted: 0, supported: 1, uncertain: 2, unresolved: 3 };

/** Full class strings so Tailwind's scanner sees them. */
const VERDICT_TONE: Record<Verdict, string> = {
  supported: "text-ok",
  refuted: "text-danger",
  uncertain: "text-fg/75",
  unresolved: "text-muted",
};

// Inconclusive is white on a dashed frame: amber on stage only ever means "handed to the LLM".
const REC_TONE: Record<ResearchReport["recommendation"], string> = {
  continue: "border-solid border-ok text-ok",
  abandon: "border-solid border-danger text-danger",
  inconclusive: "border-dashed border-fg/60 text-fg",
};

export interface ClaimSummary {
  /** Non-canary claims, refuted first, then supported, uncertain, unresolved. */
  claims: ResearchClaimResult[];
  counts: Record<Verdict, number>;
  firstRefuted: ResearchClaimResult | null;
  canaryAllPassed: boolean;
}

/** Canaries are test questions with a known answer; they prove the swarm was not led astray but are not part of the idea. */
export function summarizeClaims(report: ResearchReport): ClaimSummary {
  const claims = report.claims.filter((c) => !c.canary).sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict]);
  const counts: Record<Verdict, number> = { supported: 0, refuted: 0, uncertain: 0, unresolved: 0 };
  for (const c of claims) counts[c.verdict]++;
  return {
    claims,
    counts,
    firstRefuted: claims.find((c) => c.verdict === "refuted") ?? null,
    canaryAllPassed: report.canaryTotal > 0 && report.canaryPassed === report.canaryTotal,
  };
}

function Idea({ text, className = "" }: { text: string; className?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-base text-muted">点子</span>
      <p className={`leading-snug text-fg ${className}`}>{text}</p>
    </div>
  );
}

function Waiting({ idea }: { idea: string }) {
  return (
    <div className="flex h-full min-h-0 flex-col justify-center gap-6 px-10 py-8">
      <Idea text={idea} className="border-l-4 border-accent pl-4 text-3xl" />
      <div className="flex items-center gap-3 text-2xl text-fg">
        <span aria-hidden className="size-4 animate-pulse rounded-full bg-accent" />
        蜂群核查中
      </div>
      <p className="text-xl text-muted">点子已拆成几条论断放上黑板，几个 Agent 各自查证，结论出来后显示在这里。</p>
    </div>
  );
}

function Empty() {
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-4 px-10 py-8 text-center">
      <p className="text-3xl text-muted">还没有点子验证的结果</p>
      <p className="text-xl text-muted">点「设置」，选「点子验证」，填好点子后点「开始」。</p>
    </div>
  );
}

export function ResearchPage({ report, saved, idea }: Props) {
  if (!report) return idea ? <Waiting idea={idea} /> : <Empty />;

  const { claims, counts, firstRefuted, canaryAllPassed } = summarizeClaims(report);
  const canaryText = canaryAllPassed ? "全部判对 ✓" : `判对 ${report.canaryPassed}/${report.canaryTotal}`;

  return (
    <div className="flex min-h-full flex-col gap-5 px-6 py-5">
      {saved && <div className="self-start border border-muted px-3 py-1 text-base text-muted">这是上一次点子验证的结果（不是这一轮）</div>}
      <Idea text={report.idea} className="text-2xl" />

      <div className="flex items-stretch gap-8">
        <div className={`flex shrink-0 flex-col items-center justify-center gap-2 border-4 px-10 py-4 ${REC_TONE[report.recommendation]}`}>
          <span className="text-base text-muted">蜂群结论</span>
          <span className="font-display text-7xl leading-none font-bold">{REC_ZH[report.recommendation]}</span>
        </div>
        <ul className="flex min-w-0 flex-col justify-center gap-3 text-2xl leading-snug text-fg">
          <li>
            {claims.length} 条论断：<span className="text-ok">{counts.supported} 条站得住</span>、
            <span className="text-danger">{counts.refuted} 条被推翻</span>、{counts.uncertain} 条证据不够
            {counts.unresolved > 0 && `、${counts.unresolved} 条未决`}
          </li>
          {report.canaryTotal > 0 && (
            <li className={canaryAllPassed ? "text-ok" : "text-alert"}>
              {canaryAllPassed
                ? `${report.canaryPassed} 道已知答案的测试题（金丝雀）全部判对：蜂群没被带偏`
                : `已知答案的测试题（金丝雀）判对 ${report.canaryPassed}/${report.canaryTotal}`}
            </li>
          )}
          <li>
            {firstRefuted ? (
              <>
                <span className="text-danger">被推翻：</span>
                {firstRefuted.claim}
              </>
            ) : (
              <span className="text-muted">没有论断被推翻</span>
            )}
          </li>
        </ul>
      </div>

      <table className="w-full border-collapse text-lg">
        <thead>
          <tr className="border-b border-grid text-left text-base text-muted">
            <th className="py-2 pr-6 font-normal">论断</th>
            <th className="py-2 pr-6 font-normal whitespace-nowrap">蜂群结论</th>
            <th className="py-2 text-right font-normal whitespace-nowrap">几个 Agent 各自查到</th>
          </tr>
        </thead>
        <tbody>
          {claims.length === 0 && (
            <tr>
              <td colSpan={3} className="py-3 text-center text-muted">
                这个点子没有拆出论断
              </td>
            </tr>
          )}
          {claims.map((c) => (
            <tr key={c.taskId} className={`border-b border-grid/60 align-top ${c.verdict === "refuted" ? "bg-danger/10" : ""}`}>
              <td className="py-2 pr-6 leading-snug text-fg">{c.claim}</td>
              <td className={`py-2 pr-6 whitespace-nowrap ${VERDICT_TONE[c.verdict]}`}>{VERDICT_ZH[c.verdict]}</td>
              <td className="py-2 text-right text-fg tabular-nums">{c.independentSources}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {report.canaryTotal > 0 && (
        <p className={`text-lg ${canaryAllPassed ? "text-muted" : "text-alert"}`}>
          另有 {report.canaryTotal} 道测试题：{canaryText}
        </p>
      )}
    </div>
  );
}
