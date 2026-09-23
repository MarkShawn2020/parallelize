import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseRunConfig } from "./config";
import { SimpleEventBus } from "./core/events";
import type { RunSummary, SwarmEvent } from "./core/types";
import { startRun } from "./run";

let runsDir = "";
beforeAll(async () => {
  runsDir = await mkdtemp(join(tmpdir(), "parallelize-run-"));
});
afterAll(async () => {
  await rm(runsDir, { recursive: true, force: true });
});

async function run(body: Record<string, unknown>) {
  const bus = new SimpleEventBus();
  const events: SwarmEvent[] = [];
  bus.on((e) => events.push(e));
  const config = parseRunConfig({ llm: "mock", judge: "mock", ...body });
  const handle = await startRun(config, { bus, runsDir, mockLatencyMs: [0, 2] });
  const summary = await handle.done;
  return { handle, summary, events };
}

async function readJsonl(path: string): Promise<unknown[]> {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as unknown);
}

describe("startRun", () => {
  it("runs a simulated swarm-jev end to end and persists events, ledger and summary", async () => {
    const { handle, summary, events } = await run({ mode: "swarm-jev", n: 9, cells: 3 });
    expect(handle.simulated).toBe(true);
    expect(summary.aborted).toBeUndefined();
    expect(summary.metrics.tasksTotal).toBe(9);
    expect(summary.metrics.accepted).toBe(9);
    expect(summary.metrics.s1Decisions).toBeGreaterThan(0);
    expect(summary.metrics.coordinationTokens).toBeGreaterThan(0);
    expect(summary.byPurpose.solve?.calls).toBeGreaterThanOrEqual(9);
    expect(Object.keys(summary.calibration)).toEqual(expect.arrayContaining(["claim", "verify"]));

    expect(events[0]?.type).toBe("run.started");
    expect(events.at(-1)?.type).toBe("run.finished");
    const started = events[0];
    if (started?.type !== "run.started") throw new Error("missing run.started");
    // Ground truth never leaves the runner.
    expect(started.tasks.every((t) => !("answer" in t))).toBe(true);
    expect(events.filter((e) => e.type === "judge.decision").length).toBe(summary.metrics.s1Decisions + summary.metrics.s2Decisions);
    expect(events.some((e) => e.type === "metrics")).toBe(true);

    const dir = join(runsDir, handle.runId);
    const persisted = await readJsonl(join(dir, "events.jsonl"));
    expect(persisted).toHaveLength(events.length);
    const ledger = await readJsonl(join(dir, "ledger.jsonl"));
    expect(ledger.length).toBe(Object.values(summary.byPurpose).reduce((n, t) => n + (t?.calls ?? 0), 0));
    const onDisk = JSON.parse(await readFile(join(dir, "summary.json"), "utf8")) as RunSummary;
    expect(onDisk.runId).toBe(handle.runId);
    expect(onDisk.metrics).toEqual(summary.metrics);
  });

  it("accepts every baseline answer as a single source and scores unanswered tasks as wrong", async () => {
    const { summary, events } = await run({ mode: "single", n: 12 });
    expect(summary.metrics.accepted + events.filter((e) => e.type === "task.failed").length).toBe(12);
    const accepted = events.filter((e) => e.type === "task.accepted");
    expect(accepted.every((e) => e.type === "task.accepted" && e.independentSources === 1)).toBe(true);
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
    await single.done;
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
