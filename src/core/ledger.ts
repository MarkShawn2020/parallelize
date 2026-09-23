import { BudgetExceededError, WORK_PURPOSES } from "./types";
import type {
  CallMeta,
  Judge,
  Ledger,
  LedgerEntry,
  LLM,
  ProviderKind,
  Purpose,
  Tier,
  Totals,
  Usage,
} from "./types";

export const isWorkPurpose = (p: Purpose): boolean => WORK_PURPOSES.includes(p);

export function sumTotals(entries: LedgerEntry[]): Totals {
  const t: Totals = { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, latencyMs: 0 };
  for (const e of entries) {
    t.calls++;
    t.inputTokens += e.usage.inputTokens;
    t.outputTokens += e.usage.outputTokens;
    t.totalTokens += e.usage.inputTokens + e.usage.outputTokens;
    t.costUsd += e.usage.costUsd;
    t.latencyMs += e.latencyMs;
  }
  return t;
}

export class MemoryLedger implements Ledger {
  private readonly list: LedgerEntry[] = [];

  record(e: LedgerEntry): void {
    this.list.push(e);
  }

  entries(): LedgerEntry[] {
    return this.list.slice();
  }

  totals(filter?: (e: LedgerEntry) => boolean): Totals {
    return sumTotals(filter ? this.list.filter(filter) : this.list);
  }

  byPurpose(): Partial<Record<Purpose, Totals>> {
    const groups = new Map<Purpose, LedgerEntry[]>();
    for (const e of this.list) {
      const group = groups.get(e.purpose);
      if (group) group.push(e);
      else groups.set(e.purpose, [e]);
    }
    const out: Partial<Record<Purpose, Totals>> = {};
    for (const [purpose, group] of groups) out[purpose] = sumTotals(group);
    return out;
  }
}

export interface MeterOptions {
  provider: ProviderKind;
  maxCostUsd?: number;
  onEntry?: (e: LedgerEntry) => void;
  now?: () => number;
}

// Checked before the call, so concurrent in-flight calls can overshoot the cap by at most their own cost.
function checkBudget(ledger: Ledger, capUsd: number | undefined): void {
  if (capUsd === undefined) return;
  const spent = ledger.totals().costUsd;
  if (spent >= capUsd) throw new BudgetExceededError(spent, capUsd);
}

function recordCall(
  ledger: Ledger,
  opts: MeterOptions,
  meta: CallMeta,
  res: { usage: Usage; latencyMs: number; model: string },
  tier: Tier | undefined,
): void {
  const entry: LedgerEntry = {
    runId: meta.runId,
    at: (opts.now ?? Date.now)(),
    provider: opts.provider,
    model: res.model,
    purpose: meta.purpose,
    usage: res.usage,
    latencyMs: res.latencyMs,
  };
  if (tier !== undefined) entry.tier = tier;
  if (meta.cellId !== undefined) entry.cellId = meta.cellId;
  if (meta.taskId !== undefined) entry.taskId = meta.taskId;
  ledger.record(entry);
  opts.onEntry?.(entry);
}

export function meterLLM(llm: LLM, ledger: Ledger, opts: MeterOptions): LLM {
  return {
    id: llm.id,
    simulated: llm.simulated,
    async complete(req) {
      checkBudget(ledger, opts.maxCostUsd);
      const res = await llm.complete(req);
      recordCall(ledger, opts, req.meta, res, undefined);
      return res;
    },
  };
}

export function meterJudge(judge: Judge, ledger: Ledger, opts: MeterOptions): Judge {
  return {
    id: judge.id,
    tier: judge.tier,
    simulated: judge.simulated,
    async ask(req) {
      checkBudget(ledger, opts.maxCostUsd);
      const res = await judge.ask(req);
      recordCall(ledger, opts, req.meta, res, judge.tier);
      return res;
    },
  };
}
