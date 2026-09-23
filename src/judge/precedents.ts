import { MARK } from "../core/types";
import type { Precedent, PrecedentStore } from "../core/types";
import { describeAnswer } from "./confidence";

export interface MemoryPrecedentStoreOptions {
  maxPerKey?: number;
  maxStateChars?: number;
}

export class MemoryPrecedentStore implements PrecedentStore {
  private readonly byKey = new Map<string, Precedent[]>();
  private readonly maxPerKey: number;
  private readonly maxStateChars: number;

  constructor(opts: MemoryPrecedentStoreOptions = {}) {
    this.maxPerKey = Math.max(1, opts.maxPerKey ?? 32);
    this.maxStateChars = Math.max(1, opts.maxStateChars ?? 280);
  }

  add(p: Precedent): void {
    const list = this.byKey.get(p.key) ?? [];
    list.push({ ...p, state: truncate(p.state, this.maxStateChars) });
    if (list.length > this.maxPerKey) list.splice(0, list.length - this.maxPerKey);
    this.byKey.set(p.key, list);
  }

  relevant(key: string, k: number): Precedent[] {
    // slice(-0) would return the whole list.
    if (k <= 0) return [];
    return (this.byKey.get(key) ?? []).slice(-k);
  }

  size(key?: string): number {
    if (key !== undefined) return this.byKey.get(key)?.length ?? 0;
    let n = 0;
    for (const list of this.byKey.values()) n += list.length;
    return n;
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Mock judges count the "- " lines after the MARK.precedents line, so keep this exact shape. */
export function formatPrecedents(ps: Precedent[]): string {
  if (ps.length === 0) return "";
  const lines = ps.map(
    (p) => `- [${p.key}] ${p.state.replace(/\s+/g, " ").trim()} => ${describeAnswer(p.verdict)}`,
  );
  return [MARK.precedents, ...lines].join("\n");
}
