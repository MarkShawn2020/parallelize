import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { sleep } from "./core/rng";
import type { DefaultsResponse, LibraryResponse, ListRunsResponse, RunReportResponse } from "./core/api";
import type { LibraryGene, ResearchReport, SwarmEvent } from "./core/types";
import { FileExperienceLibrary } from "./protocol/library";
import { EvoMapClient } from "./providers/evomap";
import { createAppServer } from "./server";
import type { AppServer } from "./server";

let dir = "";
let app: AppServer;
let base = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "parallelize-server-"));
  const staticDir = join(dir, "dist");
  await mkdir(join(staticDir, "assets"), { recursive: true });
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>t</title>");
  await writeFile(join(staticDir, "assets", "app.js"), "console.log(1)");
  await writeFile(join(dir, "secret.txt"), "nope");
  // A node file that does not exist yet: the server must never read the operator's real EvoMap credentials in tests.
  const evomap = new EvoMapClient({ baseUrl: "http://127.0.0.1:9", nodeFile: join(dir, "evomap", "node.json") });
  app = createAppServer({ runsDir: join(dir, "runs"), staticDir, evomap, runOptions: { mockLatencyMs: [5, 10] } });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

const post = (path: string, body: unknown, type = "application/json") =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": type }, body: JSON.stringify(body) });

async function waitForIdle(): Promise<ListRunsResponse> {
  for (let i = 0; i < 400; i++) {
    const list = (await (await fetch(`${base}/api/runs`)).json()) as ListRunsResponse;
    if (list.activeRunId === null) return list;
    await sleep(10);
  }
  throw new Error("run did not finish");
}

describe("server", () => {
  it("serves defaults, spawnable models and EvoMap node presence without keys or claim URLs", async () => {
    const res = await fetch(`${base}/api/config/defaults`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DefaultsResponse;
    expect(Object.keys(body).sort()).toEqual(["defaults", "evomapNode", "jevModel", "llmModel", "models", "providers"]);
    expect(body.models).toEqual(["deepseek/deepseek-v4.1-flash", "qwen/qwen3.8-flash"]);
    expect(body.evomapNode).toBe(false);
    expect(body.defaults.evomapPublish).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/apiKey|sk-/);

    await mkdir(join(dir, "evomap"), { recursive: true });
    const secret = "c".repeat(64);
    await writeFile(join(dir, "evomap", "node.json"), JSON.stringify({ node_id: "node_abcd1234", node_secret: secret, claim_url: "https://evomap.ai/claim/xyz" }));
    const withNode = await (await fetch(`${base}/api/config/defaults`)).text();
    expect((JSON.parse(withNode) as DefaultsResponse).evomapNode).toBe(true);
    expect(withNode).not.toContain(secret);
    expect(withNode).not.toContain("evomap.ai/claim");
  });

  it("lists the experience library, newest genes first, and resets it", async () => {
    const empty = (await (await fetch(`${base}/api/library`)).json()) as LibraryResponse;
    expect(empty).toEqual({ genes: 0, precedents: 0, recent: [] });
    const gene = (id: string, createdAt: number): LibraryGene => ({
      id,
      kind: "solve",
      domain: "rates",
      text: `strategy ${id}`,
      origin: "c01",
      lineageId: id,
      wins: 1,
      trials: 2,
      createdAt,
      source: "local",
      evidence: { wins: 1, trials: 2 },
    });
    const genes = Array.from({ length: 22 }, (_, i) => gene(`g${i}`, 100 + i));
    await new FileExperienceLibrary(join(dir, "runs", "library")).publish(genes, [{ key: "verify", state: "s", verdict: { type: "noul", noul: 0.2 }, at: 5 }]);
    const full = (await (await fetch(`${base}/api/library`)).json()) as LibraryResponse;
    expect(full.genes).toBe(22);
    expect(full.precedents).toBe(1);
    expect(full.recent).toHaveLength(20);
    expect(full.recent[0]?.id).toBe("g21");
    expect((await post("/api/library/reset", {}, "text/plain")).status).toBe(415);
    expect((await post("/api/library/reset", {})).status).toBe(200);
    expect(((await (await fetch(`${base}/api/library`)).json()) as LibraryResponse).genes).toBe(0);
    expect((await fetch(`${base}/api/library/reset`)).status).toBe(405);
  });

  it("validates run requests at the boundary", async () => {
    expect((await post("/api/runs", { mode: "single" }, "text/plain")).status).toBe(415);
    const bad = await post("/api/runs", { mode: "nope" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/mode must be one of/);
    const big = await post("/api/runs", { mode: "single", pad: "x".repeat(70_000) });
    expect(big.status).toBe(413);
    const traversal = await post("/api/runs", { mode: "single", llm: "mock", taskSource: { kind: "gsm8k", path: "../x" } });
    expect(traversal.status).toBe(400);
    expect((await post("/api/runs/unknown/kill", {})).status).toBe(404);
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);
  });

  it("starts one run at a time, streams and replays events over WebSocket, and lists the finished run", async () => {
    const live: SwarmEvent[] = [];
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws`);
    ws.on("message", (data: Buffer) => live.push(JSON.parse(data.toString()) as SwarmEvent));
    await new Promise((resolve) => ws.once("open", resolve));

    const res = await post("/api/runs", { mode: "swarm-jev", llm: "mock", judge: "mock", n: 60, cells: 3 });
    expect(res.status).toBe(201);
    const { runId } = (await res.json()) as { runId: string };
    expect((await post("/api/runs", { mode: "single", llm: "mock" })).status).toBe(409);

    const kill = await post(`/api/runs/${runId}/kill`, { cellId: "c02" });
    expect(await kill.json()).toEqual({ cellId: "c02" });
    expect((await post(`/api/runs/${runId}/kill`, { cellId: "c02" })).status).toBe(409);
    const echo = await post(`/api/runs/${runId}/echo`, {});
    expect(echo.status).toBe(200);
    expect(((await echo.json()) as { taskId: string }).taskId).toMatch(/^t\d+$/);
    expect((await post(`/api/runs/${runId}/echo`, { cellIds: ["c09"] })).status).toBe(400);
    expect((await post(`/api/runs/${runId}/echo`, { cellIds: ["c01", "c03", "c01"] })).status).toBe(400);
    expect((await post(`/api/runs/${runId}/echo`, { cellIds: "c01" })).status).toBe(400);
    expect((await post(`/api/runs/${runId}/echo`, { cellIds: ["c01", "c03"] })).status).toBe(200);

    expect((await post(`/api/runs/${runId}/spawn`, { model: "evil/model" })).status).toBe(400);
    const spawned = await post(`/api/runs/${runId}/spawn`, { model: "deepseek/deepseek-v4.1-flash" });
    expect(await spawned.json()).toEqual({ cellId: "c04", model: "deepseek/deepseek-v4.1-flash" });
    const compromised = await post(`/api/runs/${runId}/compromise`, { cellId: "c01" });
    expect(await compromised.json()).toEqual({ cellId: "c01" });
    expect((await post(`/api/runs/${runId}/compromise`, { cellId: "c02" })).status).toBe(409);
    expect((await post(`/api/runs/${runId}/fault`, { provider: "gpu", down: true })).status).toBe(400);
    expect((await post(`/api/runs/${runId}/fault`, { provider: "jev", down: "yes" })).status).toBe(400);
    expect(await (await post(`/api/runs/${runId}/fault`, { provider: "jev", down: true })).json()).toEqual({ ok: true });
    expect((await post("/api/library/reset", {})).status).toBe(409);
    expect((await post(`/api/runs/${runId}/stop`, {})).status).toBe(200);
    const list = await waitForIdle();
    expect(list.runs[0]).toMatchObject({ runId, aborted: "stopped" });
    expect(live.some((e) => e.type === "run.started" && e.runId === runId)).toBe(true);
    expect(live.some((e) => e.type === "run.finished" && e.runId === runId)).toBe(true);
    expect(live.some((e) => e.type === "provider.fault" && e.provider === "jev" && e.down)).toBe(true);
    expect(live.some((e) => e.type === "cell.compromised" && e.cellId === "c01")).toBe(true);
    ws.close();

    const replayed: SwarmEvent[] = [];
    const late = new WebSocket(`${base.replace("http", "ws")}/ws`);
    late.on("message", (data: Buffer) => replayed.push(JSON.parse(data.toString()) as SwarmEvent));
    await new Promise((resolve) => late.once("open", resolve));
    for (let i = 0; i < 100 && replayed.at(-1)?.type !== "run.finished"; i++) await sleep(10);
    expect(replayed[0]).toMatchObject({ type: "run.started", runId });
    expect(replayed.at(-1)).toMatchObject({ type: "run.finished", runId });
    late.close();
  });

  it("serves a saved research run's report and refuses run ids that could leave the runs directory", async () => {
    const report: ResearchReport = { idea: "rooftop solar", claims: [], canaryPassed: 2, canaryTotal: 2, recommendation: "inconclusive", rule: "r" };
    const runDir = join(dir, "runs", "swarm-jev-20260923-154422-f678");
    await mkdir(runDir, { recursive: true });
    const lines = [{ type: "log", level: "info", message: "x" }, { type: "research.report", runId: "r", at: 1, report }];
    await writeFile(join(runDir, "events.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n{"type":"research.rep`);

    const ok = await fetch(`${base}/api/runs/swarm-jev-20260923-154422-f678/report`);
    expect(ok.status).toBe(200);
    expect((await ok.json()) as RunReportResponse).toEqual({ runId: "swarm-jev-20260923-154422-f678", report });
    expect((await fetch(`${base}/api/runs/single-20260923-000000-0000/report`)).status).toBe(404);
    expect((await fetch(`${base}/api/runs/..%2F..%2Fsecret/report`)).status).toBe(400);
    expect((await post("/api/runs/swarm-jev-20260923-154422-f678/report", {})).status).toBe(405);
  });

  it("refuses WebSocket upgrades on other paths", async () => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/other`);
    await expect(new Promise((resolve, reject) => ws.once("open", resolve).once("error", reject))).rejects.toThrow();
  });

  it("serves the static dashboard without path traversal", async () => {
    const index = await fetch(`${base}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toMatch(/text\/html/);
    expect((await fetch(`${base}/assets/app.js`)).headers.get("content-type")).toMatch(/javascript/);
    expect((await fetch(`${base}/..%2fsecret.txt`)).status).toBe(404);
    expect((await fetch(`${base}/%2e%2e/secret.txt`)).status).toBe(404);
    expect((await fetch(`${base}/missing.js`)).status).toBe(404);
  });
});
