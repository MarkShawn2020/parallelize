// HTTP + WebSocket contract between src/server.ts and web/. Keys never cross this boundary.
import type { Mode, RunConfig, RunSummary } from "./types";

/** POST /api/runs -> 201 StartRunResponse | 409 (a run is active) | 400 ApiError */
export type StartRunRequest = Partial<Omit<RunConfig, "mode">> & { mode: Mode };
export interface StartRunResponse {
  runId: string;
}

/** POST /api/runs/:runId/kill -> 200 KillResponse. Omit cellId to kill a random live cell. */
export interface KillRequest {
  cellId?: string;
}
export interface KillResponse {
  cellId: string;
}

/** POST /api/runs/:runId/echo -> 200 EchoResponse. Omit taskId to let the swarm pick one. */
export interface EchoRequest {
  taskId?: string;
}
export interface EchoResponse {
  taskId: string;
}

/** POST /api/runs/:runId/stop -> 200 { ok: true } */

/** GET /api/runs -> 200. Finished runs, newest first. */
export interface ListRunsResponse {
  runs: RunSummary[];
  activeRunId: string | null;
}

/** GET /api/config/defaults -> 200 */
export interface DefaultsResponse {
  defaults: RunConfig;
  /** Whether real credentials are configured on the server. */
  providers: { jev: boolean; llm: boolean };
  llmModel: string;
  jevModel: string;
}

export interface ApiError {
  error: string;
}

/**
 * WS /ws: every server message is one JSON-encoded SwarmEvent. On connect the server replays
 * the active (or most recent) run's events in order, so a page refresh restores the view.
 */
export const WS_PATH = "/ws";
