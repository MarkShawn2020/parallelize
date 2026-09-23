import type {
  CompromiseRequest,
  CompromiseResponse,
  DefaultsResponse,
  EchoRequest,
  EchoResponse,
  FaultRequest,
  KillRequest,
  KillResponse,
  LibraryResponse,
  ListRunsResponse,
  RunReportResponse,
  SpawnRequest,
  SpawnResponse,
  StartRunRequest,
  StartRunResponse,
} from "../../src/core/api";

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

type Guard<T> = (v: unknown) => v is T;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const withString =
  <K extends string>(key: K): Guard<Record<K, string>> =>
  (v): v is Record<K, string> =>
    isObject(v) && typeof v[key] === "string";
const isRuns: Guard<ListRunsResponse> = (v): v is ListRunsResponse => isObject(v) && Array.isArray(v.runs);
const isDefaults: Guard<DefaultsResponse> = (v): v is DefaultsResponse =>
  isObject(v) && isObject(v.defaults) && isObject(v.providers);
const isSpawn: Guard<SpawnResponse> = (v): v is SpawnResponse =>
  isObject(v) && typeof v.cellId === "string" && typeof v.model === "string";
const isLibrary: Guard<LibraryResponse> = (v): v is LibraryResponse =>
  isObject(v) && typeof v.genes === "number" && Array.isArray(v.recent);
const isReport: Guard<RunReportResponse> = (v): v is RunReportResponse =>
  isObject(v) && typeof v.runId === "string" && isObject(v.report);
const isAny: Guard<unknown> = (_v): _v is unknown => true;

async function request<T>(method: "GET" | "POST", path: string, guard: Guard<T>, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiRequestError("服务器不可达 server unreachable", 0);
  }
  const payload = await readPayload(res);
  if (!res.ok) throw new ApiRequestError(errorMessage(res, payload), res.status);
  if (!guard(payload)) throw new ApiRequestError(`响应格式异常 unexpected response from ${path}`, res.status);
  return payload;
}

async function readPayload(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function errorMessage(res: Response, payload: unknown): string {
  if (isObject(payload) && typeof payload.error === "string") return payload.error;
  if (typeof payload === "string" && payload.length > 0 && payload.length < 200) return payload;
  // The vite proxy answers 5xx with an empty body when the server is down.
  if (res.status >= 500 && payload === undefined) return "服务器不可达 server unreachable";
  return `HTTP ${res.status} ${res.statusText}`;
}

const runPath = (runId: string, action: string) => `/runs/${encodeURIComponent(runId)}/${action}`;

export function startRun(req: StartRunRequest): Promise<StartRunResponse> {
  return request("POST", "/runs", withString("runId"), req);
}

export function kill(runId: string, cellId?: string): Promise<KillResponse> {
  const body: KillRequest = cellId ? { cellId } : {};
  return request("POST", runPath(runId, "kill"), withString("cellId"), body);
}

export function injectEcho(runId: string, cellIds: string[] = []): Promise<EchoResponse> {
  const body: EchoRequest = cellIds.length > 0 ? { cellIds } : {};
  return request("POST", runPath(runId, "echo"), withString("taskId"), body);
}

export function spawn(runId: string, model?: string): Promise<SpawnResponse> {
  const body: SpawnRequest = model ? { model } : {};
  return request("POST", runPath(runId, "spawn"), isSpawn, body);
}

export function compromise(runId: string, cellId?: string): Promise<CompromiseResponse> {
  const body: CompromiseRequest = cellId ? { cellId } : {};
  return request("POST", runPath(runId, "compromise"), withString("cellId"), body);
}

export async function setFault(runId: string, req: FaultRequest): Promise<void> {
  await request("POST", runPath(runId, "fault"), isAny, req);
}

export async function stopRun(runId: string): Promise<void> {
  await request("POST", runPath(runId, "stop"), isAny, {});
}

export function listRuns(): Promise<ListRunsResponse> {
  return request("GET", "/runs", isRuns);
}

export function getReport(runId: string): Promise<RunReportResponse> {
  return request("GET", runPath(runId, "report"), isReport);
}

export function getDefaults(): Promise<DefaultsResponse> {
  return request("GET", "/config/defaults", isDefaults);
}

export function getLibrary(): Promise<LibraryResponse> {
  return request("GET", "/library", isLibrary);
}

export async function resetLibrary(): Promise<void> {
  await request("POST", "/library/reset", isAny, {});
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
