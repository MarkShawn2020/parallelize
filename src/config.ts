import { isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { MODES } from "./core/types";
import type { Mode, RunConfig, TaskSourceConfig } from "./core/types";

export const PROJECT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const DATA_DIR = resolve(PROJECT_ROOT, "data");
export const RUNS_DIR = resolve(PROJECT_ROOT, "runs");

export const DEFAULT_CONFIG: RunConfig = {
  mode: "swarm-jev",
  n: 64,
  cells: 8,
  seed: 7,
  taskSource: { kind: "synthetic" },
  judge: "jev",
  llm: "openrouter",
  escalationThreshold: 0.5,
  verifyThreshold: 0.55,
  leaseMs: 30_000,
  maxCostUsd: 2,
  maxWallMs: 15 * 60_000,
  llmConcurrency: 8,
  judgeConcurrency: 16,
  topology: "small-world",
  geneCapacity: 4,
  gossipEvery: 2,
  claimCandidates: 6,
};

// Simulated calls take ~0.1-1.5s, so a short lease makes fault recovery visible within seconds.
const MOCK_LEASE_MS = 3000;

type NumericKey = {
  [K in keyof RunConfig]: RunConfig[K] extends number ? K : never;
}[keyof RunConfig];

const NUMERIC: Record<NumericKey, { min: number; max: number; integer: boolean }> = {
  n: { min: 1, max: 512, integer: true },
  cells: { min: 1, max: 64, integer: true },
  seed: { min: 0, max: 2 ** 32 - 1, integer: true },
  escalationThreshold: { min: 0, max: 1, integer: false },
  verifyThreshold: { min: 0, max: 1, integer: false },
  leaseMs: { min: 500, max: 600_000, integer: true },
  maxCostUsd: { min: 0.01, max: 50, integer: false },
  maxWallMs: { min: 5_000, max: 3_600_000, integer: true },
  llmConcurrency: { min: 1, max: 64, integer: true },
  judgeConcurrency: { min: 1, max: 64, integer: true },
  geneCapacity: { min: 1, max: 32, integer: true },
  gossipEvery: { min: 1, max: 100, integer: true },
  claimCandidates: { min: 1, max: 255, integer: true },
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function oneOf<T extends string>(field: string, value: unknown, allowed: readonly T[]): T {
  const hit = allowed.find((a) => a === value);
  if (hit === undefined) throw new Error(`${field} must be one of ${allowed.join(", ")}`);
  return hit;
}

function numeric(field: NumericKey, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field} must be a finite number`);
  const { min, max, integer } = NUMERIC[field];
  const clamped = Math.min(max, Math.max(min, value));
  return integer ? Math.round(clamped) : clamped;
}

/** Accepts "data/x.jsonl" or "x.jsonl" (relative to data/); never a path outside the data directory. */
export function dataPath(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") throw new Error("taskSource.path must be a non-empty string");
  const p = raw.trim().replaceAll("\\", "/");
  if (isAbsolute(p) || /^[a-z]:/i.test(p)) throw new Error("taskSource.path must be relative to the project data/ directory");
  if (p.split("/").includes("..")) throw new Error('taskSource.path must not contain ".."');
  const rel = p.startsWith("data/") ? p : `data/${p}`;
  const abs = resolve(PROJECT_ROOT, rel);
  if (!abs.startsWith(DATA_DIR + sep)) throw new Error("taskSource.path must point inside the project data/ directory");
  return rel;
}

function taskSource(raw: unknown): TaskSourceConfig {
  if (!isRecord(raw)) throw new Error("taskSource must be an object");
  const kind = oneOf("taskSource.kind", raw.kind, ["synthetic", "gsm8k"] as const);
  return kind === "synthetic" ? { kind } : { kind, path: dataPath(raw.path) };
}

/** Boundary validation for POST /api/runs: StartRunRequest merged over DEFAULT_CONFIG. */
export function parseRunConfig(body: unknown): RunConfig {
  if (!isRecord(body)) throw new Error("request body must be a JSON object");
  const mode: Mode = oneOf("mode", body.mode, MODES);
  const cfg: RunConfig = { ...DEFAULT_CONFIG, mode };

  for (const key of Object.keys(NUMERIC) as NumericKey[]) {
    if (body[key] !== undefined) cfg[key] = numeric(key, body[key]);
  }
  if (body.judge !== undefined) cfg.judge = oneOf("judge", body.judge, ["jev", "mock"] as const);
  if (body.llm !== undefined) cfg.llm = oneOf("llm", body.llm, ["openrouter", "mock"] as const);
  if (body.topology !== undefined) cfg.topology = oneOf("topology", body.topology, ["ring", "small-world"] as const);
  if (body.taskSource !== undefined) cfg.taskSource = taskSource(body.taskSource);
  if (cfg.llm === "mock" && body.leaseMs === undefined) cfg.leaseMs = MOCK_LEASE_MS;
  return cfg;
}

export interface ProviderEndpoint {
  baseUrl: string;
  apiKey?: string;
  model: string;
}

/** Reads provider settings from the environment. Keys stay server-side and are never logged. */
export function providerEnv(env: NodeJS.ProcessEnv = process.env): { llm: ProviderEndpoint; jev: ProviderEndpoint } {
  const pick = (...values: Array<string | undefined>): string | undefined => values.find((v) => v !== undefined && v.trim() !== "")?.trim();
  return {
    llm: {
      baseUrl: pick(env.LLM_BASE_URL) ?? "https://openrouter.ai/api/v1",
      apiKey: pick(env.LLM_API_KEY, env.OPENROUTER_API_KEY),
      model: pick(env.LLM_MODEL) ?? "anthropic/claude-haiku-4.5",
    },
    jev: {
      baseUrl: pick(env.JEV_BASE_URL) ?? "https://openrouter.ai/api/v1",
      apiKey: pick(env.JEV_API_KEY, env.OPENROUTER_API_KEY),
      model: pick(env.JEV_MODEL) ?? "typesafe/jev-1.13",
    },
  };
}
