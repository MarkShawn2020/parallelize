import { isWorkPurpose } from "./ledger";
import type { Decision, Ledger, LiveMetrics } from "./types";

export interface AcceptedTask {
  /** Whether the accepted answer matches ground truth (false for tasks without any). */
  correct: boolean;
  independentSources: number;
}

export interface MetricsInput {
  tasksTotal: number;
  accepted: Map<string, AcceptedTask>;
  /** Tasks that have ground truth (research: canaries only); omitted means every task. */
  graded?: ReadonlySet<string>;
  ledger: Ledger;
  decisions: Decision[];
  /** One entry per non-escalated System-1 "no review needed" verify on a graded task: true if that proposal was wrong. */
  passThrough: boolean[];
  cellsAlive: number;
  reopened: number;
  echoAlarms: number;
  genesAdopted: number;
  quarantined: number;
  libraryHits: number;
  inheritedGenes: number;
  jevDown: boolean;
  accuracyApplicable: boolean;
  startedAt: number;
  now: number;
}

const share = (part: number, whole: number): number => (whole > 0 ? part / whole : 0);

export function computeMetrics(input: MetricsInput): LiveMetrics {
  const { tasksTotal, ledger, decisions, graded } = input;
  let correct = 0;
  let gradedAccepted = 0;
  let verified = 0;
  let verifiedWrong = 0;
  for (const [taskId, a] of input.accepted) {
    if (graded && !graded.has(taskId)) continue;
    gradedAccepted++;
    if (a.correct) correct++;
    if (a.independentSources >= 2) {
      verified++;
      if (!a.correct) verifiedWrong++;
    }
  }

  const all = ledger.totals();
  const work = ledger.totals((e) => isWorkPurpose(e.purpose));
  const coordinationTokens = all.totalTokens - work.totalTokens;

  let s1Decisions = 0;
  let s2Decisions = 0;
  let latencySum = 0;
  for (const d of decisions) {
    if (d.tier === "system1") s1Decisions++;
    else s2Decisions++;
    latencySum += d.latencyMs;
  }

  return {
    tasksTotal,
    accepted: input.accepted.size,
    correct,
    accuracy: share(correct, graded ? graded.size : tasksTotal),
    totalTokens: all.totalTokens,
    workTokens: work.totalTokens,
    coordinationTokens,
    costUsd: all.costUsd,
    air: all.totalTokens > 0 ? correct / (all.totalTokens / 1000) : 0,
    s1Decisions,
    s2Decisions,
    escalationRate: share(s2Decisions, s1Decisions + s2Decisions),
    meanJudgeLatencyMs: share(latencySum, decisions.length),
    cellsAlive: input.cellsAlive,
    reopened: input.reopened,
    echoAlarms: input.echoAlarms,
    genesAdopted: input.genesAdopted,
    passThroughErrorRate: share(input.passThrough.filter(Boolean).length, input.passThrough.length),
    falseAcceptRate: share(gradedAccepted - correct, gradedAccepted),
    falseAcceptVerifiedRate: share(verifiedWrong, verified),
    coordinationShare: share(coordinationTokens, all.totalTokens),
    quarantined: input.quarantined,
    libraryHits: input.libraryHits,
    inheritedGenes: input.inheritedGenes,
    jevDown: input.jevDown,
    accuracyApplicable: input.accuracyApplicable,
    elapsedMs: input.now - input.startedAt,
  };
}
