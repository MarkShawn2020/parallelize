import { useEffect, useState } from "react";
import type { RunReportResponse } from "../../src/core/api";
import { getReport, listRuns } from "./api";

/** The latest finished research run's report, so a past verdict can be shown while a math run is live. */
export function useSavedReport(enabled: boolean): RunReportResponse | null {
  const [saved, setSaved] = useState<RunReportResponse | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    listRuns()
      .then(({ runs }) => {
        const last = runs.find((r) => r.config.taskSource?.kind === "research");
        return last ? getReport(last.runId) : null;
      })
      .then((r) => {
        if (!cancelled) setSaved(r);
      })
      .catch(() => {
        if (!cancelled) setSaved(null);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return saved;
}
