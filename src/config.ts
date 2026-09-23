import { isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { MODES } from "./core/types";
import type { Mode, RunConfig, TaskSourceConfig } from "./core/types";

export const PROJECT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const DATA_DIR = resolve(PROJECT_ROOT, "data");
export const RUNS_DIR = resolve(PROJECT_ROOT, "runs");

/**
 * Models a runtime-spawned cell may use: open-weight models on OpenRouter that accept reasoning "off"
 * (GLM refuses to disable reasoning; closed-weight models are restricted on the account used for the demo).
 */
export const SPAWN_MODELS = ["deepseek/deepseek-v4.1-flash", "qwen/qwen3.8-flash"] as const;
export const DEFAULT_LLM_MODEL = "deepseek/deepseek-v4.1-flash";
export const REAL_JEV_ESCALATION = 0.2;
export const REAL_VERIFY_THRESHOLD = 0.4;

export const DEFAULT_CONFIG: RunConfig = {
  mode: "swarm-jev",
  n: 64,
  cells: 8,
  seed: 7,
  taskSource: { kind: "synthetic" },
  judge: "jev",
  llm: "openrouter",
  simPace: 1,
  llmReasoning: "off",
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
  claimPolicy: "rule",
  auditRate: 0.1,
  probation: 2,
  reviewTrust: 0.55,
  // With BetaTrust's 2:1 prior, three straight misses (trust 2/6) cross this line; two (2/5) do not.
  quarantineTrust: 0.35,
  stuckAfter: 2,
  guardWindow: 8,
  guardMaxDisagreement: 0.5,
  inherit: false,
  evomapLookup: false,
  evomapPublish: false,
  publishGateTasks: 8,
  publishGateMinDelta: 1,
  cellModels: [],
  voteBudgetTokens: 0,
};

// Simulated calls take ~0.1-1.5s, so a short lease makes fault recovery visible within seconds.
const MOCK_LEASE_MS = 3000;
// A paced simulation keeps the lease above twice the slowest simulated solve (180 ms x simPace), so a killed
// cell's task still reopens a few seconds after the kill. Cells renew while calls are in flight, so slower
// calls (System 2 at high pace) never cost a healthy cell its lease.
const PACED_LEASE_MS_PER_PACE = 400;
const PACED_LEASE_MAX_MS = 15_000;
const MAX_CELL_MODELS = 8;
const MAX_MODEL_CHARS = 80;
const MODEL_ID = /^[a-z0-9._~/:-]+$/i;
const MAX_IDEA_CHARS = 500;
const CLAIMS = { min: 3, max: 10 };
const CANARIES = { min: 0, max: 6 };
const DIFFICULTIES = ["normal", "hard"] as const;

type NumericKey = {
  [K in keyof RunConfig]: RunConfig[K] extends number ? K : never;
}[keyof RunConfig];

type BooleanKey = {
  [K in keyof RunConfig]: RunConfig[K] extends boolean ? K : never;
}[keyof RunConfig];

interface Range {
  min: number;
  max: number;
  integer: boolean;
}

const NUMERIC: Record<NumericKey, Range> = {
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
  auditRate: { min: 0, max: 1, integer: false },
  probation: { min: 0, max: 50, integer: true },
  reviewTrust: { min: 0, max: 1, integer: false },
  quarantineTrust: { min: 0, max: 1, integer: false },
  stuckAfter: { min: 1, max: 20, integer: true },
  guardWindow: { min: 2, max: 200, integer: true },
  guardMaxDisagreement: { min: 0, max: 1, integer: false },
  publishGateTasks: { min: 2, max: 64, integer: true },
  // A gene that does no better than no gene is never published.
  publishGateMinDelta: { min: 1, max: 64, integer: true },
  voteBudgetTokens: { min: 0, max: 50_000_000, integer: true },
  simPace: { min: 1, max: 40, integer: false },
};

const BOOLEAN: readonly BooleanKey[] = ["inherit", "evomapLookup", "evomapPublish"];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function oneOf<T extends string>(field: string, value: unknown, allowed: readonly T[]): T {
  const hit = allowed.find((a) => a === value);
  if (hit === undefined) throw new Error(`${field} must be one of ${allowed.join(", ")}`);
  return hit;
}

function clampNumber(field: string, value: unknown, { min, max, integer }: Range): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field} must be a finite number`);
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

function researchSource(raw: Record<string, unknown>): TaskSourceConfig {
  if (typeof raw.idea !== "string" || raw.idea.trim() === "") throw new Error("taskSource.idea must be a non-empty string");
  const idea = raw.idea.trim();
  if ([...idea].length > MAX_IDEA_CHARS) throw new Error(`taskSource.idea must be at most ${MAX_IDEA_CHARS} characters`);
  const claims = raw.claims === undefined ? 6 : clampNumber("taskSource.claims", raw.claims, { ...CLAIMS, integer: true });
  const canaries = raw.canaries === undefined ? 2 : clampNumber("taskSource.canaries", raw.canaries, { ...CANARIES, integer: true });
  return { kind: "research", idea, claims, canaries };
}

function taskSource(raw: unknown): TaskSourceConfig {
  if (!isRecord(raw)) throw new Error("taskSource must be an object");
  const kind = oneOf("taskSource.kind", raw.kind, ["synthetic", "gsm8k", "research"] as const);
  if (kind === "synthetic") {
    return raw.difficulty === undefined ? { kind } : { kind, difficulty: oneOf("taskSource.difficulty", raw.difficulty, DIFFICULTIES) };
  }
  if (kind === "gsm8k") return { kind, path: dataPath(raw.path) };
  return researchSource(raw);
}

function cellModels(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new Error("cellModels must be an array of model ids");
  if (raw.length > MAX_CELL_MODELS) throw new Error(`cellModels allows at most ${MAX_CELL_MODELS} models`);
  return raw.map((m) => {
    if (typeof m !== "string" || m.length === 0 || m.length > MAX_MODEL_CHARS || !MODEL_ID.test(m)) {
      throw new Error(`cellModels entries must be model ids like "vendor/model" (at most ${MAX_MODEL_CHARS} chars)`);
    }
    return m;
  });
}

/** Default lease of a simulated run: 3 s at the default pace, growing with simPace up to 15 s. */
function mockLeaseMs(simPace: number): number {
  return Math.min(PACED_LEASE_MAX_MS, Math.max(MOCK_LEASE_MS, Math.round(PACED_LEASE_MS_PER_PACE * simPace)));
}

/** Boundary validation for POST /api/runs: StartRunRequest merged over DEFAULT_CONFIG. */
export function parseRunConfig(body: unknown): RunConfig {
  if (!isRecord(body)) throw new Error("request body must be a JSON object");
  const mode: Mode = oneOf("mode", body.mode, MODES);
  const cfg: RunConfig = { ...DEFAULT_CONFIG, mode, cellModels: [] };

  for (const key of Object.keys(NUMERIC) as NumericKey[]) {
    if (body[key] !== undefined) cfg[key] = clampNumber(key, body[key], NUMERIC[key]);
  }
  for (const key of BOOLEAN) {
    const v = body[key];
    if (v === undefined) continue;
    if (typeof v !== "boolean") throw new Error(`${key} must be true or false`);
    cfg[key] = v;
  }
  if (body.judge !== undefined) cfg.judge = oneOf("judge", body.judge, ["jev", "mock"] as const);
  if (body.llm !== undefined) cfg.llm = oneOf("llm", body.llm, ["openrouter", "mock"] as const);
  if (body.topology !== undefined) cfg.topology = oneOf("topology", body.topology, ["ring", "small-world"] as const);
  if (body.claimPolicy !== undefined) cfg.claimPolicy = oneOf("claimPolicy", body.claimPolicy, ["rule", "judge"] as const);
  if (body.llmReasoning !== undefined) cfg.llmReasoning = oneOf("llmReasoning", body.llmReasoning, ["default", "off", "low"] as const);
  if (body.cellModels !== undefined) cfg.cellModels = cellModels(body.cellModels);
  if (body.taskSource !== undefined) cfg.taskSource = taskSource(body.taskSource);
  // The planner sets a research run's size, so n mirrors it for every display that reads config.n.
  if (cfg.taskSource.kind === "research") cfg.n = cfg.taskSource.claims + cfg.taskSource.canaries;
  if (cfg.llm === "mock" && body.leaseMs === undefined) cfg.leaseMs = mockLeaseMs(cfg.simPace);
  // Calibrated on 48 real hard tasks (DeepSeek V4.1 Flash, reasoning off): Jev's verify noul separates wrong from
  // right answers only weakly (AUC 0.67) and |2p-1| is usually small, so 0.5 escalated 40/48 decisions. At 0.2 about
  // a quarter escalate; a 0.4 verify line sends half the proposals to review and catches two thirds of the wrong ones.
  if (cfg.judge === "jev" && body.escalationThreshold === undefined) cfg.escalationThreshold = REAL_JEV_ESCALATION;
  if (cfg.llm === "openrouter" && body.verifyThreshold === undefined) cfg.verifyThreshold = REAL_VERIFY_THRESHOLD;
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
      model: pick(env.LLM_MODEL) ?? DEFAULT_LLM_MODEL,
    },
    jev: {
      baseUrl: pick(env.JEV_BASE_URL) ?? "https://openrouter.ai/api/v1",
      apiKey: pick(env.JEV_API_KEY, env.OPENROUTER_API_KEY),
      model: pick(env.JEV_MODEL) ?? "typesafe/jev-1.13",
    },
  };
}
