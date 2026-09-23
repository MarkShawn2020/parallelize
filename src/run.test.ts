import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseRunConfig } from "./config";
import { SimpleEventBus } from "./core/events";
import { sleep } from "./core/rng";
import type { LedgerEntry, LibraryGene, RunSummary, SwarmEvent } from "./core/types";
import { validateMessage } from "./protocol/messages";
import { FileExperienceLibrary } from "./protocol/library";
import { EvoMapClient } from "./providers/evomap";
import { startRun } from "./run";
import type { StartRunOptions } from "./run";

let runsDir = "";
beforeAll(async () => {
  runsDir = await mkdtemp(join(tmpdir(), "parallelize-run-"));
});
afterAll(async () => {
  await rm(runsDir, { recursive: true, force: true });
});

type Extra = Partial<Omit<StartRunOptions, "bus" | "runsDir">>;

async function launch(body: Record<string, unknown>, extra: Extra = {}) {
  const bus = new SimpleEventBus();
  const events: SwarmEvent[] = [];
  bus.on((e) => events.push(e));
  const config = parseRunConfig({ llm: "mock", judge: "mock", ...body });
  const handle = await startRun(config, { bus, runsDir, mockLatencyMs: [0, 2], ...extra });
  return { handle, events };
}

async function run(body: Record<string, unknown>, extra: Extra = {}) {
  const { handle, events } = await launch(body, extra);
  const summary = await handle.done;
  return { handle, summary, events };
}

const ofType = <T extends SwarmEvent["type"]>(events: SwarmEvent[], type: T) =>
  events.filter((e): e is Extract<SwarmEvent, { type: T }> => e.type === type);

const JUDGE_PURPOSES = ["claim", "verify", "adopt", "adjudicate"] as const;

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error("waitFor timed out");
    await sleep(10);
  }
}

// No latency override, so config.simPace sets the pace of every simulated call.
const PACED: Extra = { mockLatencyMs: undefined };

async function readJsonl(path: string): Promise<unknown[]> {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as unknown);
}

/** A stand-in EvoMap hub on localhost that records every request. */
async function fakeHub(): Promise<{ server: Server; base: string; seen: string[] }> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      seen.push(`${req.method} ${(req.url ?? "").split("?")[0]}`);
      const hit = {
        asset_id: `sha256:${"b".repeat(64)}`,
        asset_type: "Gene",
        short_title: "Recompute every intermediate value",
        nl_summary: "Write each intermediate result on its own line and recompute the last step before answering.",
        gdi_score: 42,
        trust_tier: "verified",
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url?.startsWith("/a2a/assets") ? { search_status: "ok", assets: [hit] } : { payload: { status: "accepted" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

describe("startRun", () => {
  it("runs a simulated swarm-jev end to end with zero-token rule claims and persists events, ledger and summary", async () => {
    const { handle, summary, events } = await run({ mode: "swarm-jev", n: 18, cells: 3 });
    expect(handle.simulated).toBe(true);
    expect(summary.aborted).toBeUndefined();
    expect(summary.metrics).toMatchObject({ tasksTotal: 18, accepted: 18, accuracyApplicable: true, jevDown: false });
    expect(summary.metrics.s1Decisions).toBeGreaterThan(0);
    expect(summary.metrics.coordinationTokens).toBeGreaterThan(0);
    expect(summary.metrics.coordinationShare).toBeCloseTo(summary.metrics.coordinationTokens / summary.metrics.totalTokens);
    expect(summary.byPurpose.solve?.calls).toBeGreaterThanOrEqual(18);
    // claimPolicy "rule": claiming never calls a judge.
    expect(summary.byPurpose.claim).toBeUndefined();
    expect(Object.keys(summary.calibration)).toContain("verify");

    expect(events[0]?.type).toBe("run.started");
    expect(events.at(-1)?.type).toBe("run.finished");
    const started = events[0];
    if (started?.type !== "run.started") throw new Error("missing run.started");
    // Ground truth never leaves the runner.
    expect(started.tasks.every((t) => !("answer" in t))).toBe(true);
    expect(ofType(events, "judge.decision").length).toBe(summary.metrics.s1Decisions + summary.metrics.s2Decisions);
    expect(ofType(events, "cell.card").length).toBeGreaterThanOrEqual(3);
    // Every protocol message would survive the future wire boundary.
    const messages = ofType(events, "protocol.message");
    expect(messages.length).toBeGreaterThan(0);
    for (const e of messages) expect(() => validateMessage(JSON.parse(JSON.stringify(e.message)))).not.toThrow();

    const dir = join(runsDir, handle.runId);
    const persisted = await readJsonl(join(dir, "events.jsonl"));
    expect(persisted).toHaveLength(events.length);
    const ledger = await readJsonl(join(dir, "ledger.jsonl"));
    expect(ledger.length).toBe(Object.values(summary.byPurpose).reduce((n, t) => n + (t?.calls ?? 0), 0));
    const onDisk = JSON.parse(await readFile(join(dir, "summary.json"), "utf8")) as RunSummary;
    expect(onDisk.runId).toBe(handle.runId);
    expect(onDisk.metrics).toEqual(summary.metrics);
  });

  it("never calls a judge in the swarm-rules and swarm-solo ablations; swarm-solo also skips review and genes", async () => {
    for (const mode of ["swarm-rules", "swarm-solo"] as const) {
      const { summary, events } = await run({ mode, n: 15, cells: 3 });
      expect(summary.aborted).toBeUndefined();
      expect(summary.metrics.accepted).toBe(15);
      expect(ofType(events, "judge.decision")).toHaveLength(0);
      expect(summary.metrics.s1Decisions + summary.metrics.s2Decisions).toBe(0);
      for (const p of JUDGE_PURPOSES) expect(summary.byPurpose[p]).toBeUndefined();
      if (mode === "swarm-solo") {
        expect(summary.byPurpose.gene).toBeUndefined();
        expect(ofType(events, "task.verifying")).toHaveLength(0);
        expect(ofType(events, "task.accepted").every((e) => e.independentSources === 1)).toBe(true);
      }
    }
  });

  it("accepts every baseline answer as a single source and scores unanswered tasks as wrong", async () => {
    const { summary, events } = await run({ mode: "single", n: 12 });
    expect(summary.metrics.accepted + ofType(events, "task.failed").length).toBe(12);
    expect(ofType(events, "task.accepted").every((e) => e.independentSources === 1)).toBe(true);
    expect(summary.metrics.accuracy).toBe(summary.metrics.correct / 12);
    expect(summary.metrics.workTokens).toBe(summary.metrics.totalTokens);
    expect(summary.calibration).toEqual({});
  });

  it("runs subagent with coordination tokens from the merge", async () => {
    const { summary } = await run({ mode: "subagent", n: 10 });
    expect(summary.byPurpose.report?.calls).toBe(10);
    expect(summary.byPurpose.merge?.calls).toBe(1);
    expect(summary.metrics.coordinationTokens).toBe(summary.byPurpose.merge?.totalTokens);
  });

  it("runs single-vote with a fixed k of 5, or sizes k to a token budget", async () => {
    const fixed = await run({ mode: "single-vote", n: 6 });
    expect(fixed.summary.byPurpose.solve?.calls).toBe(30);
    expect(fixed.summary.metrics.accepted).toBe(6);
    expect(fixed.summary.metrics.coordinationTokens).toBe(0);
    const budgeted = await run({ mode: "single-vote", n: 6, voteBudgetTokens: 1 });
    // A budget below one sample per task still leaves the pilot sample.
    expect(budgeted.summary.byPurpose.solve?.calls).toBe(6);
  });

  it("validates an idea: plans claims, scores only canaries and writes a deterministic report", async () => {
    const idea = "An app that lets cat cafes schedule staff with AI";
    for (const mode of ["swarm-jev", "single"] as const) {
      const { handle, summary, events } = await run({ mode, cells: 3, taskSource: { kind: "research", idea, claims: 4, canaries: 2 } });
      expect(summary.aborted).toBeUndefined();
      expect(summary.metrics.tasksTotal).toBe(6);
      expect(summary.metrics.accuracyApplicable).toBe(false);
      expect(summary.byPurpose.plan?.calls).toBe(1);
      expect(summary.metrics.correct).toBeLessThanOrEqual(2);
      const [report] = ofType(events, "research.report");
      expect(report?.report.idea).toBe(idea);
      expect(report?.report.claims).toHaveLength(6);
      expect(report?.report.canaryTotal).toBe(2);
      expect(["continue", "abandon", "inconclusive"]).toContain(report?.report.recommendation);
      expect(ofType(events, "task.accepted").every((e) => ["supported", "refuted", "uncertain"].includes(e.answer))).toBe(true);
      const md = await readFile(join(runsDir, handle.runId, "report.md"), "utf8");
      expect(md).toContain(idea);
      // The planner call ran before the ledger file existed and is still persisted.
      const ledger = (await readJsonl(join(runsDir, handle.runId, "ledger.jsonl"))) as Array<{ purpose: string }>;
      expect(ledger.some((e) => e.purpose === "plan")).toBe(true);
    }
  });

  it("takes Jev offline: every judgment degrades to System 2 and the dashboard is told", async () => {
    const { handle, events } = await launch({ mode: "swarm-jev", n: 15, cells: 3 });
    handle.setFault("jev", true);
    const summary = await handle.done;
    expect(ofType(events, "provider.fault")).toMatchObject([{ provider: "jev", down: true }]);
    expect(summary.metrics.jevDown).toBe(true);
    expect(summary.metrics.s1Decisions).toBe(0);
    expect(summary.metrics.s2Decisions).toBeGreaterThan(0);
    expect(summary.byPurpose.verify?.calls ?? 0).toBeGreaterThan(0);
  });

  it("paces a simulated run with simPace: the same run takes several times longer at 10 than at 1", async () => {
    const timed = async (simPace: number, extra: Extra) => {
      const { summary } = await run({ mode: "single", n: 2, simPace }, extra);
      expect(summary.aborted).toBeUndefined();
      return { wallMs: summary.finishedAt - summary.startedAt, callMs: summary.byPurpose.single?.latencyMs ?? Number.NaN };
    };
    const fast = await timed(1, PACED);
    const paced = await timed(10, PACED);
    expect(paced.callMs / fast.callMs).toBeCloseTo(10, 0);
    expect(paced.wallMs).toBeGreaterThan(3 * fast.wallMs);
    // The test latency override still wins over any pace.
    const overridden = await timed(40, {});
    expect(overridden.callMs).toBeLessThanOrEqual(2);
  });

  it("keeps leases alive through paced calls longer than the lease and still reopens a killed cell's task", async () => {
    // simPace 10 makes every solve 0.6-1.8 s, longer than this 0.5 s lease: only in-flight renewal keeps them.
    const leaseMs = 500;
    const { handle, events } = await launch({ mode: "swarm-rules", n: 8, cells: 2, simPace: 10, leaseMs }, PACED);
    await waitFor(() => new Set(ofType(events, "task.claimed").map((e) => e.cellId)).size === 2);
    const killed = handle.kill();
    const heldTask = ofType(events, "task.claimed").filter((e) => e.cellId === killed).at(-1)?.taskId;
    const survivor = handle.cellIds().find((id) => id !== killed);
    await waitFor(() => ofType(events, "task.reopened").some((e) => e.taskId === heldTask));
    await waitFor(() => ofType(events, "task.proposed").filter((e) => e.cellId === survivor).length >= 2);
    handle.stop();
    await handle.done;

    expect(ofType(events, "task.reopened")).toEqual([expect.objectContaining({ taskId: heldTask, previousCell: killed })]);
    const ledger = (await readJsonl(join(runsDir, handle.runId, "ledger.jsonl"))) as LedgerEntry[];
    const survivorSolves = ledger.filter((e) => e.cellId === survivor && e.purpose === "solve");
    expect(survivorSolves.length).toBeGreaterThanOrEqual(2);
    expect(survivorSolves.every((e) => e.latencyMs > leaseMs)).toBe(true);
  });

  it("lets a new cell with another model join mid-run and catches a compromised cell", async () => {
    const { handle, events } = await launch({ mode: "swarm-rules", n: 40, cells: 4 });
    expect(handle.compromise("c01")).toBe("c01");
    expect(handle.spawn("openai/gpt-6-luna")).toEqual({ cellId: "c05", model: "openai/gpt-6-luna" });
    expect(handle.cellIds()).toContain("c05");
    const summary = await handle.done;
    expect(summary.aborted).toBeUndefined();
    expect(ofType(events, "cell.compromised")).toMatchObject([{ cellId: "c01" }]);
    expect(ofType(events, "cell.spawned").map((e) => e.cellId)).toContain("c05");
    expect(ofType(events, "cell.card").some((e) => e.card.agentId === "c05" && e.card.model === "openai/gpt-6-luna")).toBe(true);
    expect(ofType(events, "task.proposed").some((e) => e.cellId === "c05")).toBe(true);
    expect(ofType(events, "cell.quarantined").map((e) => e.cellId)).toEqual(["c01"]);
    expect(summary.metrics.quarantined).toBe(1);
  });

  it("stops gracefully and rejects swarm controls in baseline modes", async () => {
    const bus = new SimpleEventBus();
    const handle = await startRun(parseRunConfig({ mode: "swarm-llm", llm: "mock", n: 40, cells: 2 }), { bus, runsDir });
    expect(handle.kill()).toMatch(/^c0[12]$/);
    handle.stop();
    const summary = await handle.done;
    expect(summary.aborted).toBe("stopped");

    const single = await startRun(parseRunConfig({ mode: "single", llm: "mock", n: 3 }), { bus, runsDir, mockLatencyMs: [0, 0] });
    expect(() => single.kill()).toThrow(/swarm mode/);
    expect(() => single.injectEcho()).toThrow(/swarm mode/);
    expect(() => single.spawn()).toThrow(/swarm mode/);
    expect(() => single.compromise()).toThrow(/swarm mode/);
    expect(single.cellIds()).toEqual([]);
    await single.done;
  });

  it("inherits genes and confirmed precedents from the experience library and deposits new experience", async () => {
    const libraryDir = await mkdtemp(join(tmpdir(), "parallelize-lib-"));
    try {
      const seed: LibraryGene = {
        id: "g-seed",
        kind: "solve",
        domain: "arithmetic",
        text: "Work in small steps, write down every intermediate value, and recompute the final step.",
        origin: "c09",
        lineageId: "g-seed",
        wins: 5,
        trials: 6,
        createdAt: 1,
        source: "local",
        evidence: { wins: 5, trials: 6 },
      };
      await new FileExperienceLibrary(libraryDir).publish([seed], [{ key: "verify", state: "DOMAIN: arithmetic", verdict: { type: "noul", noul: 0.1 }, at: 1 }]);
      const { summary, events } = await run({ mode: "swarm-jev", n: 18, cells: 3, inherit: true }, { libraryDir });
      expect(ofType(events, "library.loaded")).toMatchObject([{ genes: 1, precedents: 1 }]);
      expect(summary.metrics.inheritedGenes).toBe(1);
      const [published] = ofType(events, "library.published");
      expect(published).toBeDefined();
      expect(published?.evomap).toBeUndefined();
      const after = new FileExperienceLibrary(libraryDir);
      const counts = await after.load();
      expect(counts.genes).toBeGreaterThanOrEqual(1);
      // The library dedupes precedents by key + clipped state, so new ones can merge with each other.
      const deposited = published?.precedents ?? 0;
      expect(counts.precedents).toBeLessThanOrEqual(1 + deposited);
      expect(counts.precedents).toBeGreaterThanOrEqual(deposited > 0 ? 2 : 1);
    } finally {
      await rm(libraryDir, { recursive: true, force: true });
    }
  });

  it("looks up EvoMap for stuck tasks and never publishes simulated evidence", async () => {
    const hub = await fakeHub();
    const dir = await mkdtemp(join(tmpdir(), "parallelize-evomap-"));
    try {
      const evomap = new EvoMapClient({ baseUrl: hub.base, nodeFile: join(dir, "node.json"), timeoutMs: 2000 });
      const { summary, events } = await run(
        { mode: "swarm-rules", n: 30, cells: 4, auditRate: 1, stuckAfter: 1, evomapLookup: true, evomapPublish: true },
        { evomap },
      );
      expect(summary.aborted).toBeUndefined();
      const hits = ofType(events, "library.hit");
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((h) => h.source === "evomap" && h.titles[0]?.startsWith("Recompute every intermediate value"))).toBe(true);
      expect(summary.metrics.libraryHits).toBe(hits.length);
      const [published] = ofType(events, "library.published");
      expect(published?.evomap?.assetIds).toEqual([]);
      expect(published?.evomap?.status).toMatch(/no-candidates|gate-failed|simulated/);
      expect(hub.seen.length).toBeGreaterThan(0);
      expect(hub.seen.every((r) => r.startsWith("GET /a2a/assets/"))).toBe(true);
    } finally {
      await new Promise<void>((resolve) => hub.server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails fast with a clear message when a real provider has no key", async () => {
    const saved = { ...process.env };
    for (const k of ["OPENROUTER_API_KEY", "LLM_API_KEY", "JEV_API_KEY"]) delete process.env[k];
    try {
      await expect(startRun(parseRunConfig({ mode: "single", n: 2 }), { bus: new SimpleEventBus(), runsDir })).rejects.toThrow(
        /LLM_API_KEY or OPENROUTER_API_KEY is not set/,
      );
      await expect(
        startRun(parseRunConfig({ mode: "swarm-jev", llm: "mock", judge: "jev", n: 2 }), { bus: new SimpleEventBus(), runsDir }),
      ).rejects.toThrow(/JEV_API_KEY or OPENROUTER_API_KEY is not set/);
    } finally {
      process.env = saved;
    }
  });
});
