import { useEffect, useState } from "react";
import type { RunSummary } from "../../../src/core/types";
import { errorText, listRuns } from "../api";
import { fmtAir, fmtMs, fmtPct, fmtTokens, fmtUsd } from "../format";
import { MODE_LABEL } from "../labels";
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
  ["协调 Token", "Coordination"],
  ["成本", "Cost"],
  ["AIR", "每千 Token 正确数"],
  ["升级率", "Escalation"],
  ["用时", "Wall"],
] as const;

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
      right={error ? <span className="text-xs text-danger">{error}</span> : <span className="text-xs text-muted">{runs.length} runs</span>}
    >
      <table className="w-full border-collapse text-sm tabular-nums">
        <thead className="sticky top-0 bg-panel">
          <tr className="border-b border-grid text-left text-[11px] text-muted">
            {COLUMNS.map(([zh, en]) => (
              <th key={zh} className="px-3 py-1.5 font-normal whitespace-nowrap">
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
            return (
              <tr
                key={r.runId}
                className={`border-b border-grid/60 ${best ? "bg-accent/10 text-accent" : "text-fg"}`}
                title={r.aborted ? `中止 aborted: ${r.aborted}` : r.runId}
              >
                <td className={`border-l-2 px-3 py-1 whitespace-nowrap ${best ? "border-accent" : "border-transparent"}`}>
                  {MODE_LABEL[r.mode] ?? r.mode}
                  {r.simulated && <span className="ml-2 bg-warn/20 px-1 text-[10px] text-warn">SIM</span>}
                  {r.aborted && <span className="ml-2 bg-danger/20 px-1 text-[10px] text-danger">中止</span>}
                  {best && <span className="ml-2 bg-accent px-1 text-[10px] text-bg">最佳 BEST AIR</span>}
                </td>
                <td className="px-3 py-1">{r.config.n}</td>
                <td className="px-3 py-1">
                  {fmtPct(m.accuracy)} <span className="text-muted">{m.correct}/{m.tasksTotal}</span>
                </td>
                <td className="px-3 py-1">{fmtTokens(m.totalTokens)}</td>
                <td className="px-3 py-1">{fmtTokens(m.coordinationTokens)}</td>
                <td className="px-3 py-1">{fmtUsd(m.costUsd)}</td>
                <td className={`px-3 py-1 font-semibold ${best ? "text-accent" : ""}`}>{fmtAir(m.air)}</td>
                <td className="px-3 py-1">{fmtPct(m.escalationRate)}</td>
                <td className="px-3 py-1">{fmtMs(r.finishedAt - r.startedAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Panel>
  );
}
