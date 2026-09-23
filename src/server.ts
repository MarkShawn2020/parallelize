import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { DEFAULT_CONFIG, parseRunConfig, PROJECT_ROOT, providerEnv, RUNS_DIR } from "./config";
import { WS_PATH } from "./core/api";
import type { ApiError, DefaultsResponse, EchoResponse, KillResponse, ListRunsResponse, StartRunResponse } from "./core/api";
import { SimpleEventBus } from "./core/events";
import type { EventBus, RunConfig, RunSummary, SwarmEvent } from "./core/types";
import { startRun } from "./run";
import type { RunHandle, StartRunOptions } from "./run";

const MAX_BODY_BYTES = 64 * 1024;
const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export interface AppServerOptions {
  runsDir: string;
  /** Serve the built dashboard from this directory (production). */
  staticDir?: string;
  bus?: EventBus;
  runOptions?: Omit<StartRunOptions, "bus" | "runsDir">;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

// Requiring a JSON content type also blocks cross-site form posts, which cannot set it without a CORS preflight.
async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
    throw new HttpError(415, "Content-Type must be application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    // Keep draining instead of destroying the socket, so the client still receives the 413.
    if (size > MAX_BODY_BYTES) tooLarge = true;
    else chunks.push(chunk);
  }
  if (tooLarge) throw new HttpError(413, "request body exceeds 64KB");
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "request body is not valid JSON");
  }
}

function optionalString(body: unknown, key: string): string | undefined {
  if (!isRecord(body)) throw new HttpError(400, "request body must be a JSON object");
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.length === 0 || v.length > 64) throw new HttpError(400, `${key} must be a non-empty string`);
  return v;
}

function isSummary(v: unknown): v is RunSummary {
  return isRecord(v) && typeof v.runId === "string" && typeof v.startedAt === "number" && isRecord(v.metrics);
}

async function listSummaries(runsDir: string): Promise<RunSummary[]> {
  let names: string[];
  try {
    names = await readdir(runsDir);
  } catch {
    return [];
  }
  const runs = await Promise.all(
    names.map(async (name) => {
      try {
        const parsed: unknown = JSON.parse(await readFile(join(runsDir, name, "summary.json"), "utf8"));
        return isSummary(parsed) ? parsed : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  return runs.filter((r): r is RunSummary => r !== undefined).sort((a, b) => b.startedAt - a.startedAt);
}

async function serveStatic(res: ServerResponse, root: string, pathname: string): Promise<void> {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, "bad path");
  }
  const target = resolve(root, `.${rel === "/" ? "/index.html" : rel}`);
  if (target !== root && !target.startsWith(root + sep)) throw new HttpError(404, "not found");
  const info = await stat(target).catch(() => undefined);
  if (!info?.isFile()) throw new HttpError(404, rel === "/" ? "dashboard not built: run pnpm build" : "not found");
  const type = STATIC_TYPES[extname(target)] ?? "application/octet-stream";
  const cache = target.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache";
  res.writeHead(200, { "Content-Type": type, "Content-Length": info.size, "Cache-Control": cache });
  createReadStream(target).pipe(res);
}

export interface AppServer {
  server: Server;
  bus: EventBus;
  activeRun: () => RunHandle | null;
  /** Drops WebSocket clients and open connections, then closes the listener. */
  close: () => Promise<void>;
}

export function createAppServer(opts: AppServerOptions): AppServer {
  const bus = opts.bus ?? new SimpleEventBus();
  const staticDir = opts.staticDir === undefined ? undefined : resolve(opts.staticDir);
  let active: RunHandle | null = null;
  let starting = false;
  let replay: string[] = [];
  const wss = new WebSocketServer({ noServer: true });

  bus.on((e: SwarmEvent) => {
    const text = JSON.stringify(e);
    if (e.type === "run.started") replay = [];
    replay.push(text);
    for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(text);
  });

  wss.on("connection", (ws) => {
    for (const text of replay) ws.send(text);
  });

  async function launch(body: unknown): Promise<StartRunResponse> {
    if (active || starting) throw new HttpError(409, `a run is already active${active ? `: ${active.runId}` : ""}`);
    let config: RunConfig;
    try {
      config = parseRunConfig(body);
    } catch (err) {
      throw new HttpError(400, errorMessage(err));
    }
    starting = true;
    try {
      const handle = await startRun(config, { ...opts.runOptions, bus, runsDir: opts.runsDir });
      active = handle;
      void handle.done.then(() => {
        if (active === handle) active = null;
      });
      return { runId: handle.runId };
    } catch (err) {
      throw new HttpError(400, errorMessage(err));
    } finally {
      starting = false;
    }
  }

  function runFor(runId: string): RunHandle {
    if (!active || active.runId !== runId) throw new HttpError(404, `run ${runId} is not active`);
    return active;
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (path === "/api/config/defaults" && method === "GET") {
      const env = providerEnv();
      const body: DefaultsResponse = {
        defaults: DEFAULT_CONFIG,
        providers: { jev: Boolean(env.jev.apiKey), llm: Boolean(env.llm.apiKey) },
        llmModel: env.llm.model,
        jevModel: env.jev.model,
      };
      return sendJson(res, 200, body);
    }
    if (path === "/api/runs" && method === "GET") {
      const body: ListRunsResponse = { runs: await listSummaries(opts.runsDir), activeRunId: active?.runId ?? null };
      return sendJson(res, 200, body);
    }
    if (path === "/api/runs" && method === "POST") {
      return sendJson(res, 201, await launch(await readJson(req)));
    }
    const action = /^\/api\/runs\/([^/]+)\/(kill|echo|stop)$/.exec(path);
    if (action && method === "POST") {
      const runId = decodeURIComponent(action[1] ?? "");
      const body = await readJson(req);
      const run = runFor(runId);
      try {
        switch (action[2]) {
          case "kill":
            return sendJson(res, 200, { cellId: run.kill(optionalString(body, "cellId")) } satisfies KillResponse);
          case "echo":
            return sendJson(res, 200, { taskId: run.injectEcho(optionalString(body, "taskId")) } satisfies EchoResponse);
          default:
            run.stop();
            return sendJson(res, 200, { ok: true });
        }
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(409, errorMessage(err));
      }
    }
    if (path.startsWith("/api/")) throw new HttpError(path === "/api/runs" || action ? 405 : 404, "no such endpoint");
    if (staticDir && (method === "GET" || method === "HEAD")) return serveStatic(res, staticDir, path);
    throw new HttpError(404, "not found");
  }

  const server = createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (!(err instanceof HttpError)) console.error("request failed:", err);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(res, status, { error: err instanceof HttpError ? err.message : "internal server error" } satisfies ApiError);
    });
  });

  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== WS_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  const close = (): Promise<void> =>
    new Promise((done) => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.close(() => done());
      server.closeAllConnections();
    });

  return { server, bus, activeRun: () => active, close };
}

function main(): void {
  const host = process.env.HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? 8787);
  const production = process.env.NODE_ENV === "production";
  const app = createAppServer({ runsDir: RUNS_DIR, staticDir: production ? join(PROJECT_ROOT, "web", "dist") : undefined });
  app.server.listen(port, host, () => {
    console.log(`parallelize server listening on http://${host}:${port}${production ? "" : " (API only; dashboard via pnpm dev at :5173)"}`);
  });
  const shutdown = () => {
    app.activeRun()?.stop();
    void app.close();
    // Give the stopped run a moment to write its summary.
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
