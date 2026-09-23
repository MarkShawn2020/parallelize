// HTTP + WebSocket contract between src/server.ts and web/. Keys never cross this boundary.
import type { LibraryGene, Mode, ResearchReport, RunConfig, RunSummary } from "./types";

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
  /** Cells forced to see the first proposal (judges pick them on stage). Default: the next two solvers. */
  cellIds?: string[];
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

/** GET /api/runs/:runId/report -> 200 for a finished research run, 404 when the run has no report. */
export interface RunReportResponse {
  runId: string;
  report: ResearchReport;
}

/** GET /api/config/defaults -> 200 */
export interface DefaultsResponse {
  defaults: RunConfig;
  /** Whether real credentials are configured on the server. */
  providers: { jev: boolean; llm: boolean };
  llmModel: string;
  jevModel: string;
  /** Models a newly spawned cell may use. */
  models: string[];
  /** Whether an EvoMap agent node is registered locally (the secret and claim URL never leave the server). */
  evomapNode: boolean;
}

/** POST /api/runs/:runId/spawn -> 200 SpawnResponse. A new cell joins the running swarm (plug-and-play). */
export interface SpawnRequest {
  model?: string;
}
export interface SpawnResponse {
  cellId: string;
  model: string;
}

/** POST /api/runs/:runId/compromise -> 200 CompromiseResponse. Demo: the cell turns adversarial. */
export interface CompromiseRequest {
  cellId?: string;
}
export interface CompromiseResponse {
  cellId: string;
}

/** POST /api/runs/:runId/fault -> 200 { ok: true }. Demo: take a provider offline or back online. */
export interface FaultRequest {
  provider: "jev" | "llm";
  down: boolean;
}

/** GET /api/library -> 200 LibraryResponse */
export interface LibraryResponse {
  genes: number;
  precedents: number;
  recent: LibraryGene[];
}

/** POST /api/library/reset -> 200 { ok: true }. Clears the local experience library (cold start). */

export interface ApiError {
  error: string;
}

/**
 * WS /ws: every server message is one JSON-encoded SwarmEvent. On connect the server replays
 * the active (or most recent) run's events in order, so a page refresh restores the view.
 */
export const WS_PATH = "/ws";
