import { useEffect, useState } from "react";
import type { RunSummary } from "../../../src/core/types";
import { errorText, listRuns } from "../api";
import { fmtAir, fmtMs, fmtPct, fmtPctOrDash, fmtTokens, fmtUsd } from "../format";
import { MODE_HINT, MODE_LABEL } from "../labels";
import { Panel } from "./Panel";

interface Props {
  /** Changes whenever a run finishes, which triggers a refresh. */
  refreshKey: string | null;
  className?: string;
}

const COLUMNS = [
  ["模式", "Mode"],
  ["n", ""],
  ["准确率", "Accuracy"],
  ["总 Token", "Total"],
  ["协调 Token", "Coord"],
  ["协调占比", "Share"],
  ["成本", "Cost"],
  ["AIR", "正确/千Token"],
  ["升级率", "Escalation"],
  ["放行错误率", "Pass-through"],
  ["错放率(≥2源)", "False accept"],
  ["用时", "Wall"],
] as const;

const isResearch = (r: RunSummary) => r.config.taskSource?.kind === "research";

export function CompareTable({ refreshKey, className }: Props) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listRuns()
      .then((r) => {
        if (cancelled) return;
        setRuns(r.runs);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const bestAir = runs.reduce<RunSummary | null>((best, r) => (r.metrics.air > (best?.metrics.air ?? 0) ? r : best), null);

  return (
    <Panel
      title="模式对比"
      en="Compare runs"
      className={className}
      bodyClassName="overflow-auto"
      right={
        error ? (
          <span className="text-xs text-danger">{error}</span>
        ) : (
          <span className="text-xs text-muted">
            <span className="mr-3">
              <span className="text-gene">继承</span> = 带经验库 · <span className="text-s1">研究</span> = 点子验证
            </span>
            {runs.length} runs
          </span>
        )
      }
    >
      <table className="w-full border-collapse text-sm tabular-nums">
        <thead className="sticky top-0 bg-panel">
          <tr className="border-b border-grid text-left text-[11px] text-muted">
            {COLUMNS.map(([zh, en]) => (
              <th key={zh} className="px-2.5 py-1.5 font-normal whitespace-nowrap">
                <span className="text-fg/80">{zh}</span> {en}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {runs.length === 0 && (
            <tr>
              <td colSpan={COLUMNS.length} className="px-3 py-3 text-center text-muted">
                暂无完成的运行 No finished runs yet
              </td>
            </tr>
          )}
          {runs.map((r) => {
            const best = r === bestAir;
            const m = r.metrics;
            const research = isResearch(r);
            return (
              <tr
                key={r.runId}
                className={`border-b border-grid/60 ${best ? "bg-accent/10 text-accent" : "text-fg"}`}
                title={r.aborted ? `中止 aborted: ${r.aborted}` : `${r.runId} · ${MODE_HINT[r.mode] ?? ""}`}
              >
                <td className={`border-l-2 px-2.5 py-1 whitespace-nowrap ${best ? "border-accent" : "border-transparent"}`}>
                  {MODE_LABEL[r.mode] ?? r.mode}
                  {r.config.inherit && <span className="ml-2 bg-gene/20 px-1 text-[10px] text-gene">继承</span>}
                  {research && <span className="ml-1 bg-s1/20 px-1 text-[10px] text-s1">研究</span>}
                  {r.simulated && <span className="ml-1 bg-warn/20 px-1 text-[10px] text-warn">SIM</span>}
                  {r.aborted && <span className="ml-1 bg-danger/20 px-1 text-[10px] text-danger">中止</span>}
                  {best && <span className="ml-1 bg-accent px-1 text-[10px] text-bg">最佳 AIR</span>}
                </td>
                <td className="px-2.5 py-1">{m.tasksTotal}</td>
                <td className="px-2.5 py-1 whitespace-nowrap">
                  {research || m.accuracyApplicable === false ? (
                    <span className="text-muted">N/A</span>
                  ) : (
                    <>
                      {fmtPct(m.accuracy)} <span className="text-muted">{m.correct}/{m.tasksTotal}</span>
                    </>
                  )}
                </td>
                <td className="px-2.5 py-1">{fmtTokens(m.totalTokens)}</td>
                <td className="px-2.5 py-1">{fmtTokens(m.coordinationTokens)}</td>
                <td className="px-2.5 py-1">{fmtPctOrDash(m.coordinationShare)}</td>
                <td className="px-2.5 py-1">{fmtUsd(m.costUsd)}</td>
                <td className={`px-2.5 py-1 font-semibold ${best ? "text-accent" : ""}`}>{fmtAir(m.air)}</td>
                <td className="px-2.5 py-1">{fmtPct(m.escalationRate)}</td>
                <td className={`px-2.5 py-1 ${m.passThroughErrorRate > 0 ? "text-danger" : ""}`}>{fmtPctOrDash(m.passThroughErrorRate)}</td>
                <td className={`px-2.5 py-1 ${m.falseAcceptVerifiedRate > 0 ? "text-danger" : ""}`}>
                  {fmtPctOrDash(m.falseAcceptVerifiedRate)}
                </td>
                <td className="px-2.5 py-1">{fmtMs(r.finishedAt - r.startedAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Panel>
  );
}
