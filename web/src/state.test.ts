import { describe, expect, it } from "vitest";
import type { LiveMetrics, RunConfig, SwarmEvent } from "../../src/core/types";
import { CAP, initialRunView, reduce, type RunView } from "./state";

const config: RunConfig = {
  mode: "swarm-jev",
  n: 3,
  cells: 2,
  seed: 1,
  taskSource: { kind: "synthetic" },
  judge: "mock",
  llm: "mock",
  escalationThreshold: 0.7,
  verifyThreshold: 0.5,
  leaseMs: 1000,
  maxCostUsd: 1,
  maxWallMs: 60_000,
  llmConcurrency: 2,
  judgeConcurrency: 2,
  topology: "ring",
  geneCapacity: 4,
  gossipEvery: 2,
  claimCandidates: 3,
};

function metrics(over: Partial<LiveMetrics> = {}): LiveMetrics {
  return {
    tasksTotal: 3,
    accepted: 0,
    correct: 0,
    accuracy: 0,
    totalTokens: 0,
    workTokens: 0,
    coordinationTokens: 0,
    costUsd: 0,
    air: 0,
    s1Decisions: 0,
    s2Decisions: 0,
    escalationRate: 0,
    meanJudgeLatencyMs: 0,
    cellsAlive: 2,
    reopened: 0,
    echoAlarms: 0,
    genesAdopted: 0,
    elapsedMs: 0,
    ...over,
  };
}

function started(runId: string, at = 0): SwarmEvent {
  return {
    type: "run.started",
    runId,
    at,
    mode: "swarm-jev",
    config,
    simulated: true,
    tasks: [
      { id: "t1", domain: "arithmetic", prompt: "1+1" },
      { id: "t2", domain: "logic", prompt: "p" },
      { id: "t3", domain: "rates", prompt: "r" },
    ],
  };
}

function spawned(runId: string): SwarmEvent[] {
  return [
    { type: "cell.spawned", runId, at: 1, cellId: "c1", neighbors: ["c2"] },
    { type: "cell.spawned", runId, at: 1, cellId: "c2", neighbors: ["c1"] },
  ];
}

const play = (events: SwarmEvent[], from: RunView = initialRunView) => events.reduce(reduce, from);

describe("reduce", () => {
  it("run.started resets everything for the new run and ignores other runIds", () => {
    const a = play([started("A"), ...spawned("A"), { type: "task.claimed", runId: "A", at: 2, taskId: "t1", cellId: "c1" }]);
    expect(a.tasks.t1?.status).toBe("claimed");

    const b = play([started("B", 10)], a);
    expect(b.runId).toBe("B");
    expect(b.cells).toEqual({});
    expect(b.tasks.t1?.status).toBe("open");
    expect(b.feed).toHaveLength(1);
    expect(b.simulated).toBe(true);

    const stale = play([{ type: "task.claimed", runId: "A", at: 11, taskId: "t2", cellId: "c1" }], b);
    expect(stale).toBe(b);
  });

  it("ignores events before any run.started", () => {
    const s = play([{ type: "cell.killed", runId: "A", at: 1, cellId: "c1" }]);
    expect(s).toBe(initialRunView);
  });

  it("cell.killed marks the cell dead, keeps it dead, and logs it", () => {
    const s = play([
      started("A"),
      ...spawned("A"),
      { type: "cell.killed", runId: "A", at: 5, cellId: "c1" },
      { type: "cell.state", runId: "A", at: 6, cellId: "c1", state: "solving", taskId: "t1" },
    ]);
    expect(s.cells.c1).toMatchObject({ state: "dead", alive: false });
    expect(s.cells.c2?.alive).toBe(true);
    expect(s.feed.at(-1)?.text).toContain("c1");
    expect(s.feed.at(-1)?.kind).toBe("danger");
  });

  it("task.reopened puts the task back to open with a feed line", () => {
    const s = play([
      started("A"),
      ...spawned("A"),
      { type: "task.claimed", runId: "A", at: 2, taskId: "t1", cellId: "c1" },
      { type: "cell.killed", runId: "A", at: 3, cellId: "c1" },
      { type: "task.reopened", runId: "A", at: 4, taskId: "t1", previousCell: "c1" },
    ]);
    expect(s.tasks.t1).toMatchObject({ status: "open", claimedBy: undefined });
    const line = s.feed.at(-1);
    expect(line?.kind).toBe("warn");
    expect(line?.text).toContain("Reopened t1");
    expect(line?.text).toContain("c1");

    const reclaimed = play([{ type: "task.claimed", runId: "A", at: 5, taskId: "t1", cellId: "c2" }], s);
    expect(reclaimed.tasks.t1).toMatchObject({ status: "claimed", claimedBy: "c2" });
  });

  it("a reopened task that already has a proposal returns to verifying", () => {
    const s = play([
      started("A"),
      ...spawned("A"),
      { type: "task.claimed", runId: "A", at: 2, taskId: "t1", cellId: "c1" },
      { type: "task.proposed", runId: "A", at: 3, taskId: "t1", cellId: "c1", proposalId: "p1", sawProposals: [] },
      { type: "task.reopened", runId: "A", at: 4, taskId: "t1", previousCell: "c1" },
    ]);
    expect(s.tasks.t1?.status).toBe("verifying");
    expect(s.cells.c1?.solved).toBe(1);
  });

  it("task.accepted records status, correctness and independent sources", () => {
    const s = play([
      started("A"),
      { type: "task.accepted", runId: "A", at: 3, taskId: "t1", answer: "2", independentSources: 2, correct: true },
      { type: "task.accepted", runId: "A", at: 4, taskId: "t2", answer: "x", independentSources: 1, correct: false },
      { type: "task.claimed", runId: "A", at: 5, taskId: "t1", cellId: "c2" },
    ]);
    expect(s.tasks.t1).toMatchObject({ status: "accepted", correct: true, independentSources: 2, claimedBy: undefined });
    expect(s.tasks.t2).toMatchObject({ status: "accepted", correct: false });
  });

  it("echo.detected appends an alarm and a danger feed line", () => {
    const s = play([
      started("A"),
      { type: "echo.detected", runId: "A", at: 7, taskId: "t3", proposalIds: ["p1", "p2", "p3"], agreeing: 3, independentSources: 1 },
    ]);
    expect(s.echoAlarms).toEqual([{ taskId: "t3", agreeing: 3, independentSources: 1, at: 7 }]);
    expect(s.feed.at(-1)).toMatchObject({ kind: "danger" });
    expect(s.feed.at(-1)?.text).toContain("t3");
  });

  it("metrics history is capped and keeps both the first and the latest point", () => {
    const events: SwarmEvent[] = [started("A")];
    for (let i = 0; i < CAP.history * 2 + 7; i++) {
      events.push({ type: "metrics", runId: "A", at: i, metrics: metrics({ elapsedMs: i }) });
    }
    const s = play(events);
    expect(s.metricsHistory.length).toBeLessThanOrEqual(CAP.history);
    expect(s.metricsHistory[0]?.elapsedMs).toBe(0);
    expect(s.metricsHistory.at(-1)?.elapsedMs).toBe(CAP.history * 2 + 6);
    expect(s.metrics?.elapsedMs).toBe(CAP.history * 2 + 6);
    const times = s.metricsHistory.map((m) => m.elapsedMs);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("caps decisions, feed and gossip particles", () => {
    const events: SwarmEvent[] = [started("A"), ...spawned("A")];
    for (let i = 0; i < 300; i++) {
      events.push({ type: "gene.gossiped", runId: "A", at: i, geneId: `g${i}`, fromCell: "c1", toCell: "c2" });
      events.push({ type: "gene.adopted", runId: "A", at: i, geneId: `g${i}`, cellId: "c2" });
      events.push({
        type: "judge.decision",
        runId: "A",
        at: i,
        decision: {
          id: `d${i}`,
          runId: "A",
          key: "claim",
          tier: "system1",
          escalated: false,
          answer: { type: "noul", noul: 0.2 },
          confidence: 0.9,
          latencyMs: 80,
          usage: { inputTokens: 10, outputTokens: 0, costUsd: 0 },
          precedentsUsed: 0,
          at: i,
        },
      });
    }
    const s = play(events);
    expect(s.particles).toHaveLength(CAP.particles);
    expect(s.decisions).toHaveLength(CAP.decisions);
    expect(s.decisions.at(-1)?.id).toBe("d299");
    expect(s.feed).toHaveLength(CAP.feed);
    expect(s.cells.c2?.genes).toBe(300);
  });

  it("run.finished stores the summary and final metrics", () => {
    const final = metrics({ accepted: 3, correct: 2, accuracy: 2 / 3, air: 1.5 });
    const s = play([
      started("A"),
      {
        type: "run.finished",
        runId: "A",
        at: 9,
        summary: {
          runId: "A",
          mode: "swarm-jev",
          config,
          simulated: true,
          metrics: final,
          byPurpose: {},
          calibration: {},
          startedAt: 0,
          finishedAt: 9,
        },
      },
    ]);
    expect(s.summary?.runId).toBe("A");
    expect(s.metrics).toBe(final);
    expect(s.feed.at(-1)).toMatchObject({ kind: "ok" });
  });
});
