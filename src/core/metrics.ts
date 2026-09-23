import { isWorkPurpose } from "./ledger";
import type { Decision, Ledger, LiveMetrics } from "./types";

export interface MetricsInput {
  tasksTotal: number;
  /** taskId -> whether the accepted answer matches ground truth. */
  accepted: Map<string, boolean>;
  ledger: Ledger;
  decisions: Decision[];
  cellsAlive: number;
  reopened: number;
  echoAlarms: number;
  genesAdopted: number;
  startedAt: number;
  now: number;
}

export function computeMetrics(input: MetricsInput): LiveMetrics {
  const { tasksTotal, ledger, decisions } = input;
  let correct = 0;
  for (const ok of input.accepted.values()) if (ok) correct++;

  const all = ledger.totals();
  const work = ledger.totals((e) => isWorkPurpose(e.purpose));

  let s1Decisions = 0;
  let s2Decisions = 0;
  let latencySum = 0;
  for (const d of decisions) {
    if (d.tier === "system1") s1Decisions++;
    else s2Decisions++;
    latencySum += d.latencyMs;
  }
  const judged = s1Decisions + s2Decisions;

  return {
    tasksTotal,
    accepted: input.accepted.size,
    correct,
    accuracy: tasksTotal > 0 ? correct / tasksTotal : 0,
    totalTokens: all.totalTokens,
    workTokens: work.totalTokens,
    coordinationTokens: all.totalTokens - work.totalTokens,
    costUsd: all.costUsd,
    air: all.totalTokens > 0 ? correct / (all.totalTokens / 1000) : 0,
    s1Decisions,
    s2Decisions,
    escalationRate: judged > 0 ? s2Decisions / judged : 0,
    meanJudgeLatencyMs: decisions.length > 0 ? latencySum / decisions.length : 0,
    cellsAlive: input.cellsAlive,
    reopened: input.reopened,
    echoAlarms: input.echoAlarms,
    genesAdopted: input.genesAdopted,
    elapsedMs: input.now - input.startedAt,
  };
}
