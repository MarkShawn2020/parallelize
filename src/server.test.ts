import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { sleep } from "./core/rng";
import type { ListRunsResponse } from "./core/api";
import type { SwarmEvent } from "./core/types";
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
  app = createAppServer({ runsDir: join(dir, "runs"), staticDir, runOptions: { mockLatencyMs: [5, 10] } });
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
  it("serves defaults and provider readiness without keys", async () => {
    const res = await fetch(`${base}/api/config/defaults`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["defaults", "jevModel", "llmModel", "providers"]);
    expect(JSON.stringify(body)).not.toMatch(/apiKey|sk-/);
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
    expect((await post(`/api/runs/${runId}/stop`, {})).status).toBe(200);
    const list = await waitForIdle();
    expect(list.runs[0]).toMatchObject({ runId, aborted: "stopped" });
    expect(live.some((e) => e.type === "run.started" && e.runId === runId)).toBe(true);
    expect(live.some((e) => e.type === "run.finished" && e.runId === runId)).toBe(true);
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
