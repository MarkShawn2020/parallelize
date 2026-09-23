import type { CalibrationBin, CalibrationSample } from "../core/types";
import { clamp01 } from "./confidence";

/** Equal-width bins over [0, 1]; the last bin includes 1. Empty bins report zeros. */
export function calibrationBins(samples: CalibrationSample[], bins = 5): CalibrationBin[] {
  const n = Math.max(1, Math.floor(bins));
  const acc = Array.from({ length: n }, () => ({ count: 0, sumPredicted: 0, hits: 0 }));
  for (const s of usable(samples)) {
    const p = clamp01(s.predicted);
    const b = acc[Math.min(n - 1, Math.floor(p * n))]!;
    b.count += 1;
    b.sumPredicted += p;
    if (s.outcome) b.hits += 1;
  }
  return acc.map((b, i) => ({
    lo: i / n,
    hi: (i + 1) / n,
    count: b.count,
    meanPredicted: b.count ? b.sumPredicted / b.count : 0,
    observedRate: b.count ? b.hits / b.count : 0,
  }));
}

export function groupCalibration(samples: CalibrationSample[], bins?: number): Record<string, CalibrationBin[]> {
  const byKey = new Map<string, CalibrationSample[]>();
  for (const s of samples) {
    const list = byKey.get(s.key) ?? [];
    list.push(s);
    byKey.set(s.key, list);
  }
  return Object.fromEntries([...byKey].map(([key, list]) => [key, calibrationBins(list, bins)]));
}

export function brierScore(samples: CalibrationSample[]): number {
  const ok = usable(samples);
  if (ok.length === 0) return 0;
  const total = ok.reduce((sum, s) => sum + (clamp01(s.predicted) - (s.outcome ? 1 : 0)) ** 2, 0);
  return total / ok.length;
}

function usable(samples: CalibrationSample[]): CalibrationSample[] {
  return samples.filter((s) => Number.isFinite(s.predicted));
}
