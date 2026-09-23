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
  simPace: 1,
  llmReasoning: "off",
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
  judgeModel: "",
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

describe("stage narration", () => {
  const ev = (e: Record<string, unknown>): SwarmEvent => ({ runId: "A", ...e }) as SwarmEvent;
  const shorts = (s: RunView) => s.faultLog.map((l) => l.short);

  /** c1 solves, hands off for review, c2 claims the verifying task and the answer is accepted. */
  function reviewed(taskId: string, at: number, independentSources = 2): SwarmEvent[] {
    return [
      ev({ type: "task.claimed", at, taskId, cellId: "c1" }),
      ev({ type: "task.proposed", at, taskId, cellId: "c1", proposalId: `${taskId}p1`, sawProposals: [] }),
      ev({ type: "task.verifying", at, taskId, cellId: "c1" }),
      ev({ type: "task.claimed", at, taskId, cellId: "c2" }),
      ev({ type: "task.accepted", at, taskId, answer: "2", independentSources, correct: true }),
    ];
  }

  function decision(over: Record<string, unknown>): SwarmEvent {
    return ev({
      type: "judge.decision",
      at: 5,
      decision: {
        id: "d",
        runId: "A",
        key: "verify",
        tier: "system1",
        escalated: false,
        answer: { type: "noul", noul: 0.2 },
        confidence: 0.9,
        latencyMs: 400,
        usage: { inputTokens: 10, outputTokens: 0, costUsd: 0.001 },
        precedentsUsed: 0,
        at: 5,
        ...over,
      },
    });
  }

  it("run.started opens the story and clears story, fault log, tally and pending", () => {
    const busy = play([started("A"), ...spawned("A"), ev({ type: "cell.killed", at: 2, cellId: "c1" }), decision({})]);
    expect(busy.faultLog).toHaveLength(1);
    expect(busy.tally.jevCalls).toBe(1);

    const fresh = play([started("B", 10)], busy);
    expect(fresh.story).toHaveLength(1);
    expect(fresh.story[0]).toMatchObject({ tone: "info", at: 10 });
    expect(fresh.story[0]?.text).toBe("2 个 Agent 开跑：3 道普通数学题放上黑板，谁有空谁去领，没有指挥官");
    expect(fresh.faultLog).toEqual([]);
    expect(fresh.tally).toEqual(initialRunView.tally);
    expect(fresh.pending).toEqual(initialRunView.pending);
  });

  it("an accepted echo task yields the re-review line with the post-alarm verifier", () => {
    const s = play([
      started("A"),
      ...spawned("A"),
      ev({ type: "task.claimed", at: 2, taskId: "t1", cellId: "c1" }),
      ev({ type: "task.proposed", at: 3, taskId: "t1", cellId: "c1", proposalId: "p1", sawProposals: [] }),
      ev({ type: "task.verifying", at: 4, taskId: "t1", cellId: "c1" }),
      ev({ type: "echo.detected", at: 5, taskId: "t1", proposalIds: ["p1", "p2"], agreeing: 2, independentSources: 1 }),
      ev({ type: "task.claimed", at: 6, taskId: "t1", cellId: "c2" }),
      ev({ type: "task.accepted", at: 7, taskId: "t1", answer: "2", independentSources: 2, correct: true }),
    ]);
    expect(s.story.at(-1)).toMatchObject({ tone: "ok", taskId: "t1" });
    expect(s.story.at(-1)?.text).toBe("第 1 题 重新复核：c2 没看过原答案，独立做出结果 → 2 个独立来源，收下");
    expect(s.story.some((l) => l.text.includes("独立重做"))).toBe(false);
    expect(shorts(s)).toEqual(["第 1 题 回声警报：2 份答案 1 个出处", "第 1 题 由 c2 独立复核通过"]);
    expect(s.pending.echo).toEqual({});
    expect(s.pending.verifier).toEqual({});
  });

  it("a reopened task claimed by another cell counts a takeover, timed from the kill", () => {
    const s = play([
      started("A"),
      ...spawned("A"),
      ev({ type: "task.claimed", at: 2, taskId: "t1", cellId: "c1" }),
      ev({ type: "cell.killed", at: 3000, cellId: "c1" }),
      ev({ type: "task.reopened", at: 4000, taskId: "t1", previousCell: "c1" }),
      ev({ type: "task.claimed", at: 12_000, taskId: "t1", cellId: "c2" }),
    ]);
    expect(s.tally.takeovers).toBe(1);
    expect(s.story.at(-1)).toMatchObject({ tone: "ok", taskId: "t1", text: "第 1 题 由 c2 接手，距 c1 掉线 9 秒" });
    expect(shorts(s)).toEqual(["c1 被拔掉", "第 1 题 退回黑板", "第 1 题 由 c2 接手（9 秒）"]);
    expect(s.story.find((l) => l.text.startsWith("第 1 题 退回黑板"))?.text).toBe("第 1 题 退回黑板（原来在 c1 手里）");
    expect(s.pending.reopened).toEqual({});
  });

  it("a takeover without a kill is timed from the reopen; the previous holder reclaiming is no takeover", () => {
    const s = play([
      started("A"),
      ...spawned("A"),
      ev({ type: "task.reopened", at: 1000, taskId: "t1", previousCell: "c1" }),
      ev({ type: "task.claimed", at: 2500, taskId: "t1", cellId: "c2" }),
      ev({ type: "task.reopened", at: 3000, taskId: "t2", previousCell: "c1" }),
      ev({ type: "task.claimed", at: 3100, taskId: "t2", cellId: "c1" }),
    ]);
    expect(s.tally.takeovers).toBe(1);
    expect(s.story.some((l) => l.text === "第 1 题 由 c2 接手，距退回黑板 1.5 秒")).toBe(true);
    expect(s.pending.reopened).toEqual({});
  });

  it("repeated poison genes from one sender update a single keyed line in place", () => {
    const first = play([
      started("A"),
      ...spawned("A"),
      ev({ type: "cell.compromised", at: 2, cellId: "c1" }),
      ev({ type: "gene.created", at: 3, geneId: "g1", cellId: "c1", domain: "rates", text: "x" }),
      ev({ type: "gene.rejected", at: 4, geneId: "g1", cellId: "c2", reason: "judge" }),
    ]);
    const line = first.story.find((l) => l.key === "poison:c1");
    expect(line?.text).toBe("c2 拒收了 c1 发来的 Gene：它的 Jev 判断没用");

    const s = play(
      [
        ev({ type: "task.claimed", at: 5, taskId: "t1", cellId: "c2" }),
        ev({ type: "gene.rejected", at: 6, geneId: "g1", cellId: "c3", reason: "recollision" }),
        ev({ type: "gene.created", at: 7, geneId: "g2", cellId: "c2", domain: "logic", text: "y" }),
        ev({ type: "gene.rejected", at: 8, geneId: "g2", cellId: "c1", reason: "recollision" }),
        ev({ type: "gene.rejected", at: 9, geneId: "g1", cellId: "c4", reason: "sanitize" }),
      ],
      first,
    );
    const lines = s.story.filter((l) => l.key === "poison:c1");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ id: line?.id, at: 9, text: "c1 发的毒 Gene 已被邻居拒收 3 次" });
    expect(s.story.at(-1)?.key).toBe("poison:c1");
    expect(s.tally.poisonBlocked).toBe(3);
    expect(shorts(s)).toEqual(["c1 被入侵", "邻居开始拒收 c1 的毒 Gene"]);
  });

  it("a second review acceptance inside the 4 s window adds no line but later ones do", () => {
    const s = play([started("A"), ...spawned("A"), ...reviewed("t1", 1000), ...reviewed("t2", 3000), ...reviewed("t3", 6000)]);
    const lines = s.story.filter((l) => l.text.includes("独立重做"));
    expect(lines.map((l) => l.taskId)).toEqual(["t1", "t3"]);
    expect(lines[0]?.text).toBe("第 1 题：c2 独立重做，和 c1 的答案一致 → 两个独立来源，收下");
    expect(s.faultLog).toEqual([]);
  });

  it("cell.killed lands in the fault log with the lease hint", () => {
    const s = play([started("A"), ...spawned("A"), ev({ type: "cell.killed", at: 5, cellId: "c1" })]);
    expect(s.faultLog).toHaveLength(1);
    expect(s.faultLog[0]).toMatchObject({ tone: "danger", short: "c1 被拔掉" });
    expect(s.faultLog[0]?.text).toBe("c1 被拔掉了。它手上的任务租约到期（约 1 秒）后会退回黑板");
    expect(s.faultLog[0]?.id).toBe(s.story.at(-1)?.id);
    expect(s.pending.killedAt).toEqual({ c1: 5 });
  });

  it("repeated denials of a hacked cell update one line with a count and log the fault once", () => {
    const deny = (at: number) => ev({ type: "permission.denied", at, cellId: "c1", action: "propose", reason: "quarantined" });
    const s = play([
      started("A"),
      ev({ type: "cell.spawned", at: 0, cellId: "c1", neighbors: [] }),
      ev({ type: "cell.compromised", at: 0, cellId: "c1" }),
      deny(1),
      deny(2),
      deny(3),
    ]);
    expect(s.story.filter((l) => l.key === "deny:c1").map((l) => l.text)).toEqual(["c1 想交答案，被拦下：已被隔离 ×3"]);
    expect(shorts(s)).toEqual(["c1 被入侵", "c1 越权操作被拦下"]);
  });

  it("repeated echo alarms on one task keep one story line and one fault entry", () => {
    const echo = (at: number, agreeing: number) =>
      ev({ type: "echo.detected", at, taskId: "t1", proposalIds: [], agreeing, independentSources: 1 });
    const s = play([started("A"), echo(1, 2), echo(2, 3), echo(3, 4)]);
    expect(s.story.filter((l) => l.key === "echo:t1").map((l) => l.text)).toEqual([
      "回声警报：第 1 题 有 4 份一样的答案，但只有 1 个出处 → 虚假共识，退回黑板，只让没看过答案的 Agent 复核",
    ]);
    expect(shorts(s)).toEqual(["第 1 题 回声警报：2 份答案 1 个出处"]);
  });

  it("an honest cell denied after it was killed is not narrated as misbehaviour", () => {
    const s = play([
      started("A"),
      ev({ type: "cell.spawned", at: 0, cellId: "c2", neighbors: [] }),
      ev({ type: "permission.denied", at: 1, cellId: "c2", action: "propose", reason: "dead" }),
    ]);
    expect(s.story.some((l) => l.key === "deny:c2")).toBe(false);
    expect(shorts(s)).toEqual([]);
  });

  it("a late joiner's line is completed in place with its model family once the card arrives", () => {
    const s = play([
      started("A", 0),
      ev({ type: "cell.spawned", at: LATE_JOIN_MS + 10, cellId: "c9", neighbors: ["c1"] }),
      ev({ type: "cell.card", at: LATE_JOIN_MS + 11, card: card({ agentId: "c9", model: "deepseek/deepseek-v4.1-flash" }) }),
      ev({ type: "cell.card", at: LATE_JOIN_MS + 12, card: card({ agentId: "c9", model: "deepseek/deepseek-v4.1-flash" }) }),
    ]);
    const joins = s.story.filter((l) => l.key === "join:c9");
    expect(joins.map((l) => l.text)).toEqual(["新 Agent c9 加入（DeepSeek）：亮出能力卡就开始领任务，没改代码、没重启"]);
    expect(shorts(s)).toEqual(["c9（DeepSeek） 加入"]);
    expect(s.faultLog[0]?.at).toBe(LATE_JOIN_MS + 10);
  });

  it("judge decisions accumulate Jev calls, cost and latency; disputes at System 2 are narrated", () => {
    const s = play([
      started("A"),
      decision({}),
      decision({ id: "d2", tier: "system2", escalated: true, latencyMs: 3000, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 } }),
      decision({ id: "d3", tier: "system2", escalated: true, guarded: true }),
      decision({ id: "d4", key: "dispute", tier: "system2", escalated: true, taskId: "t2" }),
    ]);
    expect(s.tally).toMatchObject({ jevCalls: 3, s1Latencies: [400] });
    expect(s.tally.jevCostUsd).toBeCloseTo(0.001);
    expect(s.story.at(-1)).toMatchObject({ tone: "s2", taskId: "t2", text: "第 2 题 两个答案对不上，Jev 拿不准 → 交给大模型裁决" });
  });

  it("gene adoption opens one keyed line and counts adopters in place", () => {
    const s = play([
      started("A"),
      ...spawned("A"),
      ev({ type: "gene.created", at: 1, geneId: "g1", cellId: "c1", domain: "rates", text: "x" }),
      ev({ type: "gene.gossiped", at: 2, geneId: "g1", fromCell: "c1", toCell: "c2" }),
      ev({ type: "gene.adopted", at: 2, geneId: "g1", cellId: "c2" }),
      ev({ type: "gene.adopted", at: 3, geneId: "g1", cellId: "c3" }),
    ]);
    expect(s.story.filter((l) => l.key === "gene:g1").map((l) => l.text)).toEqual(["c1 的比率题经验，已被 2 个邻居收下"]);
    expect(s.tally.gossiped).toBe(1);
  });

  it("story and fault log are capped at 40", () => {
    const events: SwarmEvent[] = [started("A")];
    for (let i = 0; i < 60; i++) events.push(ev({ type: "cell.compromised", at: i, cellId: `c${i}` }));
    const s = play(events);
    expect(s.story).toHaveLength(CAP.story);
    expect(s.faultLog).toHaveLength(CAP.faultLog);
    expect(s.faultLog.at(-1)?.short).toBe("c59 被入侵");
  });
});
