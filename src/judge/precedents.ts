import { MARK } from "../core/types";
import type { Precedent, PrecedentStore } from "../core/types";
import { describeAnswer } from "./confidence";

export interface MemoryPrecedentStoreOptions {
  maxPerKey?: number;
  maxStateChars?: number;
  /** Unconfirmed precedents kept at most; a run that never confirms must not grow without bound. */
  maxPending?: number;
}

interface Entry {
  p: Precedent;
  seq: number;
}

/**
 * System-2 verdicts enter as pending proposals and reach System 1 only once the outcome confirms
 * them, so a wrong System-2 call cannot teach System 1 a wrong habit.
 */
export class MemoryPrecedentStore implements PrecedentStore {
  private readonly byKey = new Map<string, Entry[]>();
  // Map iteration order is insertion order, so the first key is always the oldest pending entry.
  private readonly pending = new Map<string, Precedent>();
  private readonly maxPerKey: number;
  private readonly maxStateChars: number;
  private readonly maxPending: number;
  private proposed = 0;
  private seq = 0;

  constructor(opts: MemoryPrecedentStoreOptions = {}) {
    this.maxPerKey = Math.max(1, opts.maxPerKey ?? 32);
    this.maxStateChars = Math.max(1, opts.maxStateChars ?? 280);
    this.maxPending = Math.max(1, opts.maxPending ?? 200);
  }

  add(p: Precedent): void {
    const list = this.byKey.get(p.key) ?? [];
    list.push({ p: { ...p, state: truncate(p.state, this.maxStateChars) }, seq: this.seq++ });
    if (list.length > this.maxPerKey) list.splice(0, list.length - this.maxPerKey);
    this.byKey.set(p.key, list);
  }

  propose(p: Precedent): string {
    this.proposed += 1;
    const id = `p${this.proposed}`;
    this.pending.set(id, { ...p, state: truncate(p.state, this.maxStateChars) });
    if (this.pending.size > this.maxPending) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) this.pending.delete(oldest);
    }
    return id;
  }

  /** Unknown ids (already settled or dropped by the pending cap) are ignored. */
  confirm(id: string): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    this.add(p);
  }

  reject(id: string): void {
    this.pending.delete(id);
  }

  relevant(key: string, k: number): Precedent[] {
    // slice(-0) would return the whole list.
    if (k <= 0) return [];
    return (this.byKey.get(key) ?? []).slice(-k).map((e) => e.p);
  }

  size(key?: string): number {
    if (key !== undefined) return this.byKey.get(key)?.length ?? 0;
    let n = 0;
    for (const list of this.byKey.values()) n += list.length;
    return n;
  }

  all(): Precedent[] {
    return [...this.byKey.values()]
      .flat()
      .sort((a, b) => a.p.at - b.p.at || a.seq - b.seq)
      .map((e) => e.p);
  }

  pendingSize(): number {
    return this.pending.size;
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
