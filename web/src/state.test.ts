import { describe, expect, it } from "vitest";
import type { CapabilityCard, LiveMetrics, ProtocolMessage, ResearchReport, RunConfig, SwarmEvent } from "../../src/core/types";
import { CAP, LATE_JOIN_MS, initialRunView, reduce, type RunView } from "./state";

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
  claimPolicy: "rule",
  auditRate: 0.1,
  probation: 2,
  reviewTrust: 0.6,
  quarantineTrust: 0.3,
  stuckAfter: 2,
  guardWindow: 20,
  guardMaxDisagreement: 0.4,
  inherit: false,
  evomapLookup: false,
  evomapPublish: false,
  publishGateTasks: 6,
  publishGateMinDelta: 1,
  cellModels: [],
  voteBudgetTokens: 0,
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
    passThroughErrorRate: 0,
    falseAcceptRate: 0,
    falseAcceptVerifiedRate: 0,
    coordinationShare: 0,
    quarantined: 0,
    libraryHits: 0,
    inheritedGenes: 0,
    jevDown: false,
    accuracyApplicable: true,
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

function message(i: number, type: ProtocolMessage["type"] = "CLAIM"): SwarmEvent {
  return {
    type: "protocol.message",
    runId: "A",
    at: i,
    message: { v: 1, id: `m${i}`, runId: "A", type, from: "c1", to: "board", parents: [], at: i, body: { taskId: "t1" } },
  };
}

function card(over: Partial<CapabilityCard> = {}): CapabilityCard {
  return {
    agentId: "c1",
    model: "anthropic/claude-haiku-4.5",
    domains: { arithmetic: { wins: 2, trials: 3 } },
    genes: ["check units"],
    trust: 0.8,
    status: "active",
    joinedAt: 1,
    lastSeen: 2,
    ...over,
  };
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
    expect(b.tasks.t1?.prompt).toBe("1+1");
    expect(b.feed).toHaveLength(1);
    expect(b.simulated).toBe(true);

    const stale = play([{ type: "task.claimed", runId: "A", at: 11, taskId: "t2", cellId: "c1" }], b);
    expect(stale).toBe(b);
  });

  it("ignores events before any run.started", () => {
    const s = play([{ type: "cell.killed", runId: "A", at: 1, cellId: "c1" }]);
    expect(s).toBe(initialRunView);
  });

  it("ignores unknown event types", () => {
    const s = play([started("A")]);
    const unknown = { type: "from.the.future", runId: "A", at: 5 } as unknown as SwarmEvent;
    expect(reduce(s, unknown)).toBe(s);
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
    expect(s.particles.every((p) => p.kind === "gene")).toBe(true);
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

describe("reduce v2 events", () => {
  it("cell.spawned after the start burst is a late joiner with a feed line", () => {
    const s = play([
      started("A", 1000),
      { type: "cell.spawned", runId: "A", at: 1001, cellId: "c1", neighbors: [] },
      { type: "cell.spawned", runId: "A", at: 1000 + LATE_JOIN_MS + 1, cellId: "c9", neighbors: ["c1"] },
    ]);
    expect(s.cells.c1).toMatchObject({ late: false, quarantined: false, compromised: false, spawnedAt: 1001 });
    expect(s.cells.c9?.late).toBe(true);
    expect(s.feed.at(-1)).toMatchObject({ kind: "ok" });
    expect(s.feed.at(-1)?.text).toContain("c9");
  });

  it("protocol.message keeps a capped trace, counts every type and drops heartbeats from the trace", () => {
    const events: SwarmEvent[] = [started("A")];
    for (let i = 0; i < CAP.protocol + 30; i++) events.push(message(i));
    events.push(message(9000, "HEARTBEAT"), message(9001, "HEARTBEAT"));
    const s = play(events);
    expect(s.protocol).toHaveLength(CAP.protocol);
    expect(s.protocol.at(-1)?.id).toBe(`m${CAP.protocol + 29}`);
    expect(s.protocol.some((m) => m.type === "HEARTBEAT")).toBe(false);
    expect(s.protocolCounts).toEqual({ CLAIM: CAP.protocol + 30, HEARTBEAT: 2 });
  });

  it("cell.card stores the latest card per agent and a quarantined card flags the cell", () => {
    const s = play([
      started("A"),
      ...spawned("A"),
      { type: "cell.card", runId: "A", at: 2, card: card({ trust: 0.8 }) },
      { type: "cell.card", runId: "A", at: 3, card: card({ trust: 0.2, status: "quarantined" }) },
    ]);
    expect(s.cards.c1?.trust).toBe(0.2);
    expect(s.cells.c1?.quarantined).toBe(true);
    expect(s.cells.c2?.quarantined).toBe(false);
  });

  it("cell.quarantined flags the cell, records an alarm and logs danger", () => {
    const s = play([
      started("A"),
      ...spawned("A"),
      { type: "cell.quarantined", runId: "A", at: 4, cellId: "c2", trust: 0.18, reason: "disagrees with accepted answers" },
    ]);
    expect(s.cells.c2?.quarantined).toBe(true);
    expect(s.quarantines).toEqual([{ at: 4, cellId: "c2", trust: 0.18, reason: "disagrees with accepted answers" }]);
    expect(s.feed.at(-1)).toMatchObject({ kind: "danger" });
    expect(s.feed.at(-1)?.text).toContain("0.18");
  });

  it("cell.compromised flags the cell as ground truth", () => {
    const s = play([started("A"), ...spawned("A"), { type: "cell.compromised", runId: "A", at: 4, cellId: "c1" }]);
    expect(s.cells.c1?.compromised).toBe(true);
    expect(s.compromises).toEqual([{ at: 4, cellId: "c1" }]);
    expect(s.feed.at(-1)?.text).toContain("GHOST HACKED");
  });

  it("permission.denied is recorded and capped", () => {
    const events: SwarmEvent[] = [started("A")];
    for (let i = 0; i < CAP.alarms + 5; i++) {
      events.push({ type: "permission.denied", runId: "A", at: i, cellId: "c1", action: "accept", reason: "not a verifier" });
    }
    const s = play(events);
    expect(s.denials).toHaveLength(CAP.alarms);
    expect(s.denials.at(-1)).toEqual({ at: CAP.alarms + 4, cellId: "c1", action: "accept", reason: "not a verifier" });
    expect(s.feed.at(-1)).toMatchObject({ kind: "danger" });
  });

  it("provider.fault toggles jev/llm down and metrics keep jevDown in sync", () => {
    const down = play([started("A"), { type: "provider.fault", runId: "A", at: 2, provider: "jev", down: true }]);
    expect(down.faults).toEqual({ jev: true, llm: false });
    expect(down.feed.at(-1)).toMatchObject({ kind: "warn" });

    const up = play([{ type: "provider.fault", runId: "A", at: 3, provider: "jev", down: false }], down);
    expect(up.faults.jev).toBe(false);
    expect(up.feed.at(-1)).toMatchObject({ kind: "ok" });

    const synced = play([{ type: "metrics", runId: "A", at: 4, metrics: metrics({ jevDown: true }) }], up);
    expect(synced.faults.jev).toBe(true);
  });

  it("judge.guard is recorded with a warn feed line", () => {
    const s = play([started("A"), { type: "judge.guard", runId: "A", at: 5, key: "verify", disagreement: 0.55, window: 20 }]);
    expect(s.guards).toEqual([{ at: 5, key: "verify", disagreement: 0.55, window: 20 }]);
    expect(s.feed.at(-1)).toMatchObject({ kind: "warn" });
    expect(s.feed.at(-1)?.text).toContain("verify");
  });

  it("library.loaded, library.hit and library.published fill the library view", () => {
    const s = play([
      started("A"),
      { type: "library.loaded", runId: "A", at: 1, genes: 4, precedents: 9 },
      { type: "library.hit", runId: "A", at: 2, cellId: "c1", taskId: "t2", source: "evomap", geneIds: ["e1"], titles: ["Unit check"] },
      { type: "library.hit", runId: "A", at: 3, cellId: "c2", taskId: "t2", source: "local", geneIds: ["g1"], titles: ["Work backwards"] },
      {
        type: "library.published",
        runId: "A",
        at: 4,
        genes: 1,
        precedents: 3,
        gate: [{ geneId: "g1", withGene: 5, withoutGene: 3, tasks: 6, passed: true }],
        evomap: { assetIds: ["a1"], urls: ["https://evomap.ai/a1"], status: "published" },
      },
    ]);
    expect(s.library.loaded).toEqual({ genes: 4, precedents: 9 });
    expect(s.library.hits.map((h) => h.source)).toEqual(["evomap", "local"]);
    expect(s.tasks.t2).toMatchObject({ hit: "evomap", hitTitles: ["Unit check", "Work backwards"] });
    expect(s.library.published?.gate[0]?.passed).toBe(true);
    expect(s.library.published?.evomap?.urls).toEqual(["https://evomap.ai/a1"]);
  });

  it("library hits are capped", () => {
    const events: SwarmEvent[] = [started("A")];
    for (let i = 0; i < CAP.hits + 10; i++) {
      events.push({ type: "library.hit", runId: "A", at: i, cellId: "c1", taskId: "t1", source: "local", geneIds: [], titles: [] });
    }
    expect(play(events).library.hits).toHaveLength(CAP.hits);
  });

  it("link.formed accumulates per unordered pair and review links emit review particles", () => {
    const s = play([
      started("A"),
      { type: "link.formed", runId: "A", at: 1, from: "c2", to: "c1", reason: "review" },
      { type: "link.formed", runId: "A", at: 2, from: "c1", to: "c2", reason: "review" },
      { type: "link.formed", runId: "A", at: 3, from: "c1", to: "c2", reason: "gossip" },
      { type: "link.formed", runId: "A", at: 4, from: "c1", to: "c3", reason: "discover" },
    ]);
    expect(Object.keys(s.links).sort()).toEqual(["c1~c2", "c1~c3"]);
    expect(s.links["c1~c2"]).toEqual({ a: "c1", b: "c2", counts: { gossip: 1, review: 2, discover: 0 }, total: 3 });
    expect(s.particles).toEqual([
      { from: "c2", to: "c1", at: 1, kind: "review" },
      { from: "c1", to: "c2", at: 2, kind: "review" },
    ]);
  });

  it("gene events build gene cards with adopters and rejecters", () => {
    const s = play([
      started("A"),
      ...spawned("A"),
      { type: "gene.created", runId: "A", at: 1, geneId: "g1", cellId: "c1", domain: "rates", text: "Convert units first" },
      { type: "gene.gossiped", runId: "A", at: 2, geneId: "g1", fromCell: "c1", toCell: "c2" },
      { type: "gene.adopted", runId: "A", at: 3, geneId: "g1", cellId: "c2" },
      { type: "gene.rejected", runId: "A", at: 4, geneId: "g1", cellId: "c3", reason: "recollision" },
    ]);
    expect(s.genes).toEqual([
      { id: "g1", cellId: "c1", domain: "rates", text: "Convert units first", at: 1, gossiped: 1, adoptedBy: ["c2"], rejectedBy: ["c3"] },
    ]);
  });

  it("research.report is stored", () => {
    const report: ResearchReport = {
      idea: "Solar kiosks",
      claims: [],
      canaryPassed: 2,
      canaryTotal: 2,
      recommendation: "continue",
      rule: "continue when every canary passes and most claims are supported",
    };
    const s = play([started("A"), { type: "research.report", runId: "A", at: 9, report }]);
    expect(s.report).toBe(report);
    expect(s.feed.at(-1)).toMatchObject({ kind: "ok" });
  });

  it("run.started clears every v2 field", () => {
    const busy = play([
      started("A"),
      ...spawned("A"),
      message(1),
      { type: "cell.card", runId: "A", at: 2, card: card() },
      { type: "cell.quarantined", runId: "A", at: 3, cellId: "c1", trust: 0.1, reason: "r" },
      { type: "provider.fault", runId: "A", at: 4, provider: "jev", down: true },
      { type: "library.loaded", runId: "A", at: 5, genes: 1, precedents: 1 },
      { type: "link.formed", runId: "A", at: 6, from: "c1", to: "c2", reason: "review" },
    ]);
    const fresh = play([started("B", 10)], busy);
    expect(fresh).toMatchObject({
      protocol: [],
      protocolCounts: {},
      cards: {},
      quarantines: [],
      faults: { jev: false, llm: false },
      library: { loaded: null, hits: [], published: null },
      links: {},
      particles: [],
      report: null,
    });
  });
});
