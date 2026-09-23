import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config";
import { InMemoryBlackboard } from "../core/blackboard";
import { SimpleEventBus } from "../core/events";
import { MemoryLedger, meterLLM } from "../core/ledger";
import { LineageGraph } from "../core/lineage";
import { sleep } from "../core/rng";
import { MARK, QK } from "../core/types";
import type { Answer, Domain, Judge, LLM, LLMRequest, Proposal, PublicTask, RunConfig, SwarmEvent } from "../core/types";
import { pickEchoCandidate, Swarm } from "./swarm";

const DOMAINS: Domain[] = ["arithmetic", "rates", "logic"];
const USAGE = { inputTokens: 10, outputTokens: 5, costUsd: 0.001 };

function fakeLLM(truth: Map<string, string>, delayMs = 2): LLM & { calls: LLMRequest[] } {
  const calls: LLMRequest[] = [];
  return {
    id: "fake-llm",
    simulated: true,
    calls,
    async complete(req) {
      calls.push(req);
      await sleep(req.meta.purpose === "solve" ? delayMs : 1);
      const user = req.messages.at(-1)?.content ?? "";
      let text = "";
      if (req.meta.purpose === "solve") {
        // Always copies a teammate when shown one, so an injected echo is deterministic.
        const teammate = new RegExp(`${MARK.teammate} (\\S+)`).exec(user)?.[1];
        text = `${MARK.method} worked it out\n${MARK.answer} ${teammate ?? truth.get(req.meta.taskId ?? "") ?? "0"}`;
      } else if (req.meta.purpose === "gene") {
        text = "Check the units before the final step.";
      }
      return { text, usage: USAGE, latencyMs: 1, model: "fake" };
    },
  };
}

function fakeJudge(verifyNoul: number, adoptNoul = 0.9): Judge {
  return {
    id: "fake-judge",
    tier: "system1",
    simulated: true,
    async ask(req) {
      await sleep(1);
      const answers: Record<string, Answer> = {};
      for (const [key, q] of Object.entries(req.questions)) {
        if (q.type === "choice") {
          const keys = Object.keys(q.criteria);
          const choice = keys[0] ?? "";
          const probabilities = Object.fromEntries(keys.map((k) => [k, k === choice ? 0.9 : 0.1 / Math.max(1, keys.length - 1)]));
          answers[key] = { type: "choice", choice, probabilities, confidence: 0.9 };
        } else if (q.type === "noul") {
          answers[key] = { type: "noul", noul: key === QK.verify ? verifyNoul : adoptNoul };
        }
      }
      return { answers, usage: USAGE, latencyMs: 1, model: "fake-judge" };
    },
  };
}

interface Setup {
  n: number;
  cells: number;
  verifyNoul?: number;
  leaseMs?: number;
  gossipEvery?: number;
  solveDelayMs?: number;
  llm?: (truth: Map<string, string>) => LLM;
  judge?: Judge;
}

function makeSwarm(s: Setup) {
  const tasks: PublicTask[] = Array.from({ length: s.n }, (_, i) => ({
    id: `t${i + 1}`,
    domain: DOMAINS[i % DOMAINS.length] ?? "arithmetic",
    prompt: `problem ${i + 1}`,
  }));
  const truth = new Map(tasks.map((t, i) => [t.id, String(10 + i)]));
  const bus = new SimpleEventBus();
  const events: SwarmEvent[] = [];
  bus.on((e) => events.push(e));
  const leaseMs = s.leaseMs ?? 5000;
  const board = new InMemoryBlackboard(tasks, { leaseMs });
  const config: RunConfig = {
    ...DEFAULT_CONFIG,
    mode: "swarm-jev",
    n: s.n,
    cells: s.cells,
    leaseMs,
    gossipEvery: s.gossipEvery ?? 100,
    maxWallMs: 15_000,
  };
  const llm = s.llm ? s.llm(truth) : fakeLLM(truth, s.solveDelayMs);
  const swarm = new Swarm({
    runId: "r1",
    config,
    tasks,
    llm,
    judge: s.judge ?? fakeJudge(s.verifyNoul ?? 0.1),
    bus,
    lineage: new LineageGraph(),
    board,
    isCorrect: (id, answer) => truth.get(id) === answer,
  });
  const ofType = <T extends SwarmEvent["type"]>(type: T) => events.filter((e): e is Extract<SwarmEvent, { type: T }> => e.type === type);
  return { swarm, events, ofType, board, truth, bus };
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error("waitFor timed out");
    await sleep(5);
  }
}

describe("Swarm", () => {
  it("settles every task, spawning cells with neighbours and reporting ground-truth correctness", async () => {
    const { swarm, ofType, board } = makeSwarm({ n: 9, cells: 3 });
    await swarm.start();
    expect(swarm.abortReason()).toBeUndefined();
    expect(board.done()).toBe(true);
    expect(ofType("cell.spawned").map((e) => e.cellId)).toEqual(["c01", "c02", "c03"]);
    expect(ofType("cell.spawned").every((e) => e.neighbors.length > 0)).toBe(true);
    const accepted = ofType("task.accepted");
    expect(accepted).toHaveLength(9);
    // Probation and random audits re-solve some lone proposals, so a few tasks carry a second source.
    expect(accepted.every((e) => e.correct && e.independentSources >= 1)).toBe(true);
    // Work spreads across cells: no central scheduler, yet more than one cell solves.
    expect(new Set(ofType("task.proposed").map((e) => e.cellId)).size).toBeGreaterThan(1);
  });

  it("re-solves flagged proposals with a different cell and accepts two independent sources", async () => {
    const { swarm, ofType, board } = makeSwarm({ n: 6, cells: 3, verifyNoul: 0.9 });
    await swarm.start();
    const accepted = ofType("task.accepted");
    expect(accepted).toHaveLength(6);
    expect(accepted.every((e) => e.independentSources === 2)).toBe(true);
    for (const e of board.all()) {
      expect(e.proposals).toHaveLength(2);
      expect(new Set(e.proposals.map((p) => p.cellId)).size).toBe(2);
    }
    expect(ofType("task.verifying")).toHaveLength(6);
  });

  it("recovers a killed cell's task only through lease expiry and discards its late result", async () => {
    const { swarm, ofType, events } = makeSwarm({ n: 6, cells: 3, leaseMs: 150, solveDelayMs: 120 });
    const run = swarm.start();
    await waitFor(() => ofType("task.claimed").length > 0);
    const victim = swarm.kill();
    const claimedByVictim = ofType("task.claimed").filter((e) => e.cellId === victim).at(-1)?.taskId;
    await run;

    expect(swarm.abortReason()).toBeUndefined();
    expect(ofType("task.accepted")).toHaveLength(6);
    const reopened = ofType("task.reopened");
    expect(reopened.some((e) => e.taskId === claimedByVictim && e.previousCell === victim)).toBe(true);
    expect(swarm.stats().reopened).toBe(reopened.length);
    const killedAt = events.findIndex((e) => e.type === "cell.killed");
    expect(events.slice(killedAt).some((e) => e.type === "task.proposed" && e.cellId === victim)).toBe(false);
    expect(swarm.aliveCount()).toBe(2);
  });

  it("flags injected echo as false consensus and accepts only after a lineage-disjoint source agrees", async () => {
    const { swarm, ofType } = makeSwarm({ n: 1, cells: 4 });
    expect(swarm.injectEcho()).toBe("t1");
    await swarm.start();

    const echoes = ofType("echo.detected");
    expect(echoes.length).toBeGreaterThanOrEqual(1);
    expect(echoes[0]).toMatchObject({ taskId: "t1", agreeing: 2, independentSources: 1 });
    expect(swarm.stats().echoAlarms).toBe(echoes.length);
    const proposed = ofType("task.proposed");
    expect(proposed.filter((e) => e.sawProposals.length > 0)).toHaveLength(2);
    expect(ofType("task.accepted")).toEqual([expect.objectContaining({ taskId: "t1", independentSources: 2, correct: true })]);
  });

  it("stops with reason budget once the metered cost cap is reached", async () => {
    const ledger = new MemoryLedger();
    const { swarm, ofType } = makeSwarm({
      n: 6,
      cells: 2,
      llm: (truth) => meterLLM(fakeLLM(truth), ledger, { provider: "mock-llm", maxCostUsd: 0.002 }),
    });
    await swarm.start();
    expect(swarm.abortReason()).toBe("budget");
    expect(ofType("task.accepted").length).toBeLessThan(6);
  });

  it("distils genes and gossips them to neighbours that adopt them", async () => {
    const { swarm, ofType } = makeSwarm({ n: 18, cells: 3, gossipEvery: 1, solveDelayMs: 5 });
    await swarm.start();
    expect(ofType("gene.created").length).toBeGreaterThan(0);
    const gossiped = ofType("gene.gossiped");
    expect(gossiped.length).toBeGreaterThan(0);
    expect(gossiped.every((e) => e.fromCell !== e.toCell)).toBe(true);
    // A cell judges each gene once, even after evicting it.
    const offers = gossiped.map((e) => `${e.geneId}>${e.toCell}`);
    expect(new Set(offers).size).toBe(offers.length);
    expect(ofType("gene.adopted").length).toBe(swarm.stats().genesAdopted);
    expect(swarm.stats().genesAdopted).toBeGreaterThan(0);
  });

  it("retires a cell whose provider refuses it and ends the run once every cell is refused", async () => {
    const refusing = (onlyCell?: string) => (truth: Map<string, string>): LLM => {
      const ok = fakeLLM(truth);
      return {
        ...ok,
        async complete(req) {
          if (onlyCell === undefined || req.meta.cellId === onlyCell) throw Object.assign(new Error("HTTP 403"), { status: 403 });
          return ok.complete(req);
        },
      };
    };
    const all = makeSwarm({ n: 4, cells: 2, llm: refusing() });
    await all.swarm.start();
    expect(all.swarm.abortReason()).toBe("provider refused (HTTP 403)");
    expect(all.swarm.aliveCount()).toBe(0);

    const one = makeSwarm({ n: 6, cells: 3, llm: refusing("c01") });
    await one.swarm.start();
    expect(one.swarm.abortReason()).toBeUndefined();
    expect(one.ofType("cell.killed").map((e) => e.cellId)).toEqual(["c01"]);
    expect(one.ofType("task.accepted")).toHaveLength(6);
  });

  it("validates kill targets and aborts once every cell is dead", async () => {
    const { swarm } = makeSwarm({ n: 4, cells: 2, solveDelayMs: 50 });
    expect(() => swarm.kill("c99")).toThrow(/unknown cell/);
    const run = swarm.start();
    swarm.kill("c01");
    expect(() => swarm.kill("c01")).toThrow(/already dead/);
    swarm.kill("c02");
    expect(() => swarm.kill()).toThrow(/no live cells/);
    await run;
    expect(swarm.abortReason()).toBe("all cells dead");
  });

  it("stop() ends the run with the given reason", async () => {
    const { swarm } = makeSwarm({ n: 30, cells: 2, solveDelayMs: 30 });
    const run = swarm.start();
    await sleep(40);
    swarm.stop("stopped");
    await run;
    expect(swarm.abortReason()).toBe("stopped");
  });

  it("holds an unanswered echo task for the named cells, so the alarm shows within seconds on stage", async () => {
    const { swarm, ofType } = makeSwarm({ n: 12, cells: 4, solveDelayMs: 20 });
    const run = swarm.start();
    await waitFor(() => ofType("task.claimed").length >= 4);
    const taskId = swarm.injectEcho(undefined, ["c03", "c04"]);
    await run;
    const claims = ofType("task.claimed").filter((e) => e.taskId === taskId);
    expect(["c03", "c04"]).toContain(claims[0]?.cellId);
    const copied = ofType("task.proposed").filter((e) => e.taskId === taskId && e.sawProposals.length > 0);
    expect(copied.length).toBeGreaterThan(0);
    expect(copied.every((e) => e.cellId === "c03" || e.cellId === "c04")).toBe(true);
    expect(ofType("echo.detected").some((e) => e.taskId === taskId)).toBe(true);
  });

  it("picks three honest cells itself when none are named mid-run, so the alarm still shows", async () => {
    const { swarm, ofType } = makeSwarm({ n: 12, cells: 5, solveDelayMs: 20 });
    const run = swarm.start();
    await waitFor(() => ofType("task.claimed").length >= 5);
    const taskId = swarm.injectEcho();
    await run;
    const copiers = new Set(ofType("task.proposed").filter((e) => e.taskId === taskId && e.sawProposals.length > 0).map((e) => e.cellId));
    expect(copiers.size).toBeGreaterThan(0);
    expect(copiers.size).toBeLessThanOrEqual(3);
    expect(ofType("echo.detected").some((e) => e.taskId === taskId)).toBe(true);
  });

  it("never lets named echo copies use up the attempts and force a one-source accept", async () => {
    const { swarm, ofType, bus } = makeSwarm({ n: 6, cells: 5, verifyNoul: 0.9, solveDelayMs: 30 });
    let echoed: { taskId: string; proposer: string } | undefined;
    bus.on((e) => {
      if (echoed || e.type !== "task.proposed") return;
      const named = ["c01", "c02", "c03", "c04", "c05"].filter((c) => c !== e.cellId).slice(0, 3);
      echoed = { taskId: swarm.injectEcho(e.taskId, named), proposer: e.cellId };
    });
    await swarm.start();
    const taskId = echoed?.taskId;
    expect(ofType("task.proposed").filter((e) => e.taskId === taskId && e.sawProposals.length > 0)).toHaveLength(3);
    expect(ofType("echo.detected").some((e) => e.taskId === taskId)).toBe(true);
    const accepted = ofType("task.accepted").find((e) => e.taskId === taskId);
    expect(accepted?.independentSources).toBeGreaterThanOrEqual(2);
  });

  it("picks an echo task nobody but its proposer holds, so the named cells can still reach it", () => {
    const tasks: PublicTask[] = ["t1", "t2", "t3"].map((id) => ({ id, domain: "arithmetic", prompt: id }));
    const board = new InMemoryBlackboard(tasks, { leaseMs: 5000 });
    const now = 1_000;
    const answer = (taskId: string, cellId: string): Proposal => ({ id: `${taskId}-${cellId}`, taskId, cellId, answer: "7", summary: "", at: now });
    for (const [taskId, cellId] of [["t1", "c04"], ["t2", "c05"]] as const) {
      board.claim(taskId, cellId, now);
      board.propose(answer(taskId, cellId));
      board.requestVerification(taskId);
    }
    // c06 is already verifying t1: it settles t1 before any named cell arrives.
    board.claim("t1", "c06", now);
    const valid = (e: { proposals: Proposal[] }) => e.proposals;
    expect(pickEchoCandidate(board.all(), ["c01", "c02"], now, valid)?.task.id).toBe("t2");
    // Once c06's lease lapses, t1 is reachable again.
    expect(pickEchoCandidate(board.all(), ["c01", "c02"], now + 6000, valid)?.task.id).toBe("t1");
    // A named cell's own answer can't be echoed back to it; fall back to a fresh open task.
    expect(pickEchoCandidate(board.all(), ["c05"], now, valid)?.task.id).toBe("t3");
  });

  it("rejects echo injection on unknown or settled tasks", async () => {
    const { swarm } = makeSwarm({ n: 2, cells: 2 });
    expect(() => swarm.injectEcho("nope")).toThrow(/unknown task/);
    await swarm.start();
    expect(() => swarm.injectEcho("t1")).toThrow(/already settled/);
    expect(() => swarm.injectEcho()).toThrow(/no task available/);
  });
});
