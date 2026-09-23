export const DASH = "—";

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

export function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  return fmtInt(n);
}

export function fmtUsd(n: number): string {
  return `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;
}

export function fmtPct(x: number, digits = 1): string {
  return `${(x * 100).toFixed(digits)}%`;
}

/** Summaries from the server may predate a metric; show a dash instead of NaN%. */
export function fmtPctOrDash(x: number | undefined, digits = 1): string {
  return typeof x === "number" && Number.isFinite(x) ? fmtPct(x, digits) : DASH;
}

export function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

export function fmtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function fmtAir(x: number): string {
  return x.toFixed(x >= 10 ? 1 : 2);
}

/** "anthropic/claude-haiku-4.5" -> "claude-haiku-4.5" */
export function shortModel(model: string): string {
  return model.slice(model.lastIndexOf("/") + 1) || model;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Links arrive from the server (and from EvoMap through it); never render a non-http(s) href. */
export function safeHttpUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/** Orders "c2" before "c10". */
export function byNaturalId(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true });
}
