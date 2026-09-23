import type { ResearchClaimResult, ResearchReport as Report } from "../../../src/core/types";
import { RECOMMENDATION, TASK_STATUS_LABEL, VERDICT_LABEL, VERDICT_TEXT } from "../labels";
import type { TaskView } from "../state";

interface Props {
  report: Report | null;
  /** Idea of the active research run, shown before the report arrives. */
  idea: string | null;
  tasks: Record<string, TaskView>;
}

function canaryMark(c: ResearchClaimResult): { text: string; className: string } {
  if (!c.canary) return { text: "—", className: "text-muted" };
  return c.verdict === c.canary ? { text: "✓", className: "text-ok" } : { text: "✗", className: "text-danger" };
}

export function ResearchReport({ report, idea, tasks }: Props) {
  if (!report) {
    if (!idea) {
      return (
        <div className="flex flex-col gap-2 px-3 py-4 text-center text-sm text-muted">
          <span>尚无研究报告 No report yet</span>
          <span className="text-xs">在控制栏选择「点子验证」，输入点子后启动；蜂群的结论会汇成确定性报告。</span>
        </div>
      );
    }
    const list = Object.values(tasks);
    const settled = list.filter((t) => t.status === "accepted" || t.status === "failed").length;
    return (
      <div className="flex flex-col gap-2 px-3 py-2">
        <div className="text-[11px] text-muted">点子 Idea</div>
        <p className="border-l-2 border-s1 pl-3 text-base leading-snug text-fg">{idea}</p>
        <div className="flex items-center gap-2 text-sm text-s1">
          <span className="size-2 animate-pulse rounded-full bg-s1" />
          蜂群核查中 verifying · {settled}/{list.length} 条论断已定
        </div>
        <ul className="flex flex-col gap-1 text-xs">
          {list.map((t) => (
            <li key={t.id} className="flex gap-2 border-b border-grid/50 py-1">
              <span className="w-10 shrink-0 text-muted tabular-nums">{t.id}</span>
              <span className="min-w-0 flex-1 text-fg/85">{t.prompt}</span>
              <span className="shrink-0 text-muted">{TASK_STATUS_LABEL[t.status]}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const rec = RECOMMENDATION[report.recommendation];
  const canaryOk = report.canaryTotal > 0 && report.canaryPassed === report.canaryTotal;

  return (
    <div className="flex flex-col gap-3 px-3 py-2">
      <div className="flex flex-col gap-1">
        <span className="text-[11px] text-muted">点子 Idea</span>
        <p className="text-base leading-snug text-fg">{report.idea}</p>
      </div>

      <div className={`flex items-center gap-4 border-2 px-4 py-3 ${rec.tone}`}>
        <div className="flex flex-col items-center">
          <span className="font-display text-5xl leading-none font-bold">{rec.zh}</span>
          <span className="font-display text-sm tracking-[0.3em]">{rec.en}</span>
        </div>
        <div className="flex min-w-0 flex-col gap-1 text-sm text-fg">
          <span className="text-[11px] text-muted">判定规则 deterministic rule</span>
          <span className="leading-snug">{report.rule}</span>
          <span className={`text-xs tabular-nums ${canaryOk ? "text-ok" : "text-warn"}`}>
            金丝雀 canary {report.canaryPassed}/{report.canaryTotal} 通过
          </span>
        </div>
      </div>

      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-grid text-left text-[10px] text-muted">
            <th className="py-1 pr-2 font-normal">论断 claim</th>
            <th className="py-1 pr-2 font-normal whitespace-nowrap">结论 verdict</th>
            <th className="py-1 pr-2 text-right font-normal whitespace-nowrap">独立源</th>
            <th className="py-1 pr-2 text-right font-normal">异议</th>
            <th className="py-1 text-center font-normal whitespace-nowrap">金丝雀</th>
          </tr>
        </thead>
        <tbody>
          {report.claims.map((c) => {
            const mark = canaryMark(c);
            return (
              <tr key={c.taskId} className={`border-b border-grid/50 align-top ${c.canary ? "bg-panel-2/60" : ""}`}>
                <td className="py-1 pr-2 text-fg/90">
                  {c.canary && <span className="mr-1 border border-muted px-1 text-[10px] text-muted">金丝雀</span>}
                  {c.claim}
                </td>
                <td className={`py-1 pr-2 whitespace-nowrap ${VERDICT_TEXT[c.verdict]}`}>{VERDICT_LABEL[c.verdict]}</td>
                <td className="py-1 pr-2 text-right text-fg tabular-nums">{c.independentSources}</td>
                <td className={`py-1 pr-2 text-right tabular-nums ${c.dissent > 0 ? "text-warn" : "text-muted"}`}>{c.dissent}</td>
                <td className={`py-1 text-center font-semibold ${mark.className}`}>{mark.text}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
