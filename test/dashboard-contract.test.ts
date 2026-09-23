import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initialRunView, reduce } from "../web/src/state";
import type { RunView } from "../web/src/state";
import { parseRunConfig } from "../src/config";
import { SimpleEventBus } from "../src/core/events";
import { startRun } from "../src/run";

let runsDir = "";
beforeAll(async () => {
  runsDir = await mkdtemp(join(tmpdir(), "parallelize-contract-"));
});
afterAll(async () => {
  await rm(runsDir, { recursive: true, force: true });
});

/** Runs a simulated swarm and folds every event into the dashboard's state, as the WebSocket client does. */
async function dashboardAfter(body: Record<string, unknown>, act: (h: Awaited<ReturnType<typeof startRun>>) => void = () => {}): Promise<RunView> {
  const bus = new SimpleEventBus();
  let view = initialRunView;
  bus.on((e) => {
    view = reduce(view, e);
  });
  const handle = await startRun(parseRunConfig({ llm: "mock", judge: "mock", ...body }), { bus, runsDir, mockLatencyMs: [0, 2] });
  act(handle);
  await handle.done;
  return view;
}

describe("run events drive every dashboard view", () => {
  it("fills registry, links, protocol trace, alarms and fault state from a live swarm", async () => {
    const view = await dashboardAfter({ mode: "swarm-jev", n: 30, cells: 4 }, (h) => {
      h.compromise("c01");
      h.spawn("deepseek/deepseek-v4.1-flash");
      h.setFault("jev", true);
    });
    expect(view.summary?.metrics.accepted).toBe(30);
    expect(Object.keys(view.cards).sort()).toEqual(["c01", "c02", "c03", "c04", "c05"]);
    expect(view.cards.c05?.model).toBe("deepseek/deepseek-v4.1-flash");
    expect(Object.keys(view.cells)).toContain("c05");
    expect(Object.keys(view.links).length).toBeGreaterThan(0);
    expect(view.protocol.length).toBeGreaterThan(0);
    expect(view.protocolCounts.PROPOSE ?? 0).toBeGreaterThan(0);
    expect(view.protocolCounts.ACCEPT).toBe(30);
    expect(view.compromises.map((c) => c.cellId)).toEqual(["c01"]);
    expect(view.faults.jev).toBe(true);
    expect(view.metrics?.jevDown).toBe(true);
    expect(Object.values(view.tasks).every((t) => t.status === "accepted")).toBe(true);
  });

  it("switches to the research report and marks accuracy as canary-only", async () => {
    const view = await dashboardAfter({ mode: "swarm-rules", cells: 3, taskSource: { kind: "research", idea: "A marketplace for used lab equipment", claims: 3, canaries: 2 } });
    expect(view.report?.claims).toHaveLength(5);
    expect(view.metrics?.accuracyApplicable).toBe(false);
    expect(view.config?.taskSource.kind).toBe("research");
  });
});
