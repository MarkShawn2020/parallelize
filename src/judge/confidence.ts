import type { Answer } from "../core/types";

/** NaN maps to 0 so a malformed answer reads as unconfident and escalates. */
export function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}

export function confidenceOf(a: Answer): number {
  return a.type === "noul" ? clamp01(Math.abs(2 * a.noul - 1)) : clamp01(a.confidence);
}

export function describeAnswer(a: Answer): string {
  switch (a.type) {
    case "noul":
      return `${a.noul >= 0.5 ? "yes" : "no"} ${a.noul.toFixed(2)}`;
    case "choice":
      return `${a.choice} ${a.confidence.toFixed(2)}`;
    case "score":
      return `score ${Number(a.score.toFixed(2))} (${a.confidence.toFixed(2)})`;
  }
}
