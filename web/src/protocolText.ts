import type { ProtocolMessage } from "../../src/core/types";
import { truncate } from "./format";

// Body schemas belong to the protocol module; the dashboard only knows these common field names
// and falls back to whatever primitives remain, so a new field still shows up.
const PREFERRED = ["taskId", "geneId", "answer", "domain", "action", "reason", "trust", "source", "model", "title", "titles"];
const MAX_FIELDS = 4;
const MAX_VALUE = 36;

function show(v: unknown): string | null {
  if (typeof v === "string") return v ? truncate(v, MAX_VALUE) : null;
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (Array.isArray(v)) {
    const items = v.map(show).filter((x): x is string => x !== null);
    if (items.length === 0) return null;
    return truncate(items.slice(0, 3).join(",") + (items.length > 3 ? ` +${items.length - 3}` : ""), MAX_VALUE);
  }
  return null;
}

/** One-line summary of a message body, preferred fields first. */
export function describeBody(body: Record<string, unknown>): string {
  const keys = [...PREFERRED.filter((k) => k in body), ...Object.keys(body).filter((k) => !PREFERRED.includes(k))];
  const parts: string[] = [];
  for (const k of keys) {
    if (parts.length >= MAX_FIELDS) break;
    const v = show(body[k]);
    if (v !== null) parts.push(`${k}=${v}`);
  }
  return parts.join(" · ");
}

export function describeMessage(m: ProtocolMessage): string {
  const route = `${m.from} → ${m.to === "*" ? "* 广播" : m.to}`;
  const detail = describeBody(m.body);
  return detail ? `${route} · ${detail}` : route;
}
