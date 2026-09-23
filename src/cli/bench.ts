import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_CONFIG, parseRunConfig, RUNS_DIR } from "../config";
import { SimpleEventBus } from "../core/events";
import { MODES, SWARM_MODES } from "../core/types";
import type { Mode, ResearchReport, RunConfig, RunSummary } from "../core/types";
import { startRun } from "../run";

/** swarm-jev first: its total tokens become single-vote's budget, so both spend the same. */
export const BENCH_ORDER: readonly Mode[] = ["swarm-jev", "single", "single-vote", "subagent", "swarm-llm", "swarm-rules", "swarm-solo"];

const USAGE = `usage: pnpm bench [--mode <mode[,mode...]|all>] [--n 64] [--cells 8] [--seed 7] [--judge jev|mock] [--llm openrouter|mock] [--sim-pace 1]
                  [--source synthetic|gsm8k] [--difficulty normal|hard] [--path file.jsonl] [--max-cost 2] [--vote-budget <tokens>]
                  [--inherit] [--library-dir <dir>] [--evomap-lookup] [--cell-models a,b]
                  [--research "<idea>" [--claims 6] [--canaries 2]]
modes: ${MODES.join(", ")}
--inherit runs one swarm mode (default swarm-jev) twice: cold on --seed with an empty library, warm on --seed+1 inheriting it.
--difficulty hard (synthetic only): 6-9 step problems with distractor facts and unit conversions; run labels get a /hard suffix.
--sim-pace N (1-40) multiplies simulated provider latency; 10 paces a mock run like a real one.
--reasoning off|low|default sets the real LLM reasoning pass (default off).`;

const COLUMNS: Array<[string, number]> = [
  ["run", 20],
  ["sim", 4],
  ["accuracy", 8],
  ["correct/n", 9],
  ["total_tok", 10],
  ["work_tok", 10],
  ["coord_tok", 10],
  ["coord_share", 11],
  ["cost_usd", 9],
  ["AIR", 7],
  ["esc_rate", 8],
  ["pass_err", 8],
  ["false_acc_verified", 18],
  ["wall_s", 7],
  ["aborted", 12],
];

export type BenchArgs = Record<string, string | boolean | undefined>;
type Difficulty = "normal" | "hard";

export interface BenchRun {
  label: string;
  config: RunConfig;
  /** single-vote without --vote-budget spends what the swarm-jev run of this bench spent. */
  budgetFromSwarm: boolean;
}

export interface BenchResult {
  label: string;
  summary: RunSummary;
}

function text(values: BenchArgs, name: string): string | undefined {
  const v = values[name];
  return typeof v === "string" ? v : undefined;
}

function num(values: BenchArgs, name: string): number | undefined {
  const raw = text(values, name);
  if (raw === undefined) return undefined;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`--${name} must be a number, got ${raw}`);
  return v;
}

/** The synthetic difficulty a run used, or undefined for gsm8k and research runs. */
export function difficultyOf(config: RunConfig): Difficulty | undefined {
  return config.taskSource.kind === "synthetic" ? (config.taskSource.difficulty ?? "normal") : undefined;
}

function parseModes(raw: string): Mode[] {
  if (raw === "all") return [...BENCH_ORDER];
  const picked = raw.split(",").map((m) => m.trim());
  for (const m of picked) if (!MODES.includes(m as Mode)) throw new Error(`--mode must be one of ${MODES.join(", ")} or all`);
  return BENCH_ORDER.filter((m) => picked.includes(m));
}

export function buildPlan(values: BenchArgs): BenchRun[] {
  const source = text(values, "source") ?? "synthetic";
  if (source !== "synthetic" && source !== "gsm8k") throw new Error("--source must be synthetic or gsm8k");
  const path = text(values, "path");
  if (source === "gsm8k" && !path) throw new Error("--source gsm8k needs --path <file.jsonl>");
  const idea = text(values, "research");
  if (idea !== undefined && source === "gsm8k") throw new Error("--research and --source gsm8k are exclusive");
  if (idea === undefined && (values.claims !== undefined || values.canaries !== undefined)) throw new Error("--claims/--canaries need --research");
  const difficultyArg = text(values, "difficulty");
  if (difficultyArg !== undefined && difficultyArg !== "normal" && difficultyArg !== "hard") throw new Error("--difficulty must be normal or hard");
  if (difficultyArg !== undefined && (source !== "synthetic" || idea !== undefined)) throw new Error("--difficulty applies to synthetic tasks only");
  const difficulty: Difficulty = difficultyArg ?? "normal";
  // Normal labels stay as they were, so earlier compare files line up with new ones.
  const reasoningArg = text(values, "reasoning");
  // Labels mark a non-default reasoning pass so a "thinking individual" reference row stands apart.
  const suffix = (difficulty === "hard" ? "/hard" : "") + (reasoningArg === "low" ? "/think" : "");
  const models = text(values, "cell-models");
  const voteBudget = num(values, "vote-budget");
  const inherit = values.inherit === true;

  const configFor = (mode: Mode, seedOffset = 0): RunConfig => {
    const seed = num(values, "seed");
    const cfg = parseRunConfig({
      mode,
      n: num(values, "n"),
      cells: num(values, "cells"),
      seed: seedOffset === 0 ? seed : (seed ?? DEFAULT_CONFIG.seed) + seedOffset,
      judge: text(values, "judge"),
      llm: text(values, "llm"),
      simPace: num(values, "sim-pace"),
      llmReasoning: text(values, "reasoning"),
      maxCostUsd: num(values, "max-cost"),
      voteBudgetTokens: voteBudget,
      inherit,
      evomapLookup: values["evomap-lookup"] === true,
      cellModels: models === undefined ? undefined : models.split(",").map((m) => m.trim()).filter(Boolean),
      taskSource:
        idea !== undefined
          ? { kind: "research", idea, claims: num(values, "claims"), canaries: num(values, "canaries") }
          : source === "synthetic"
            ? { kind: "synthetic", difficulty }
            : undefined,
    });
    // The CLI is local and trusted, so --path may point anywhere (the server restricts it to data/).
    if (source === "gsm8k" && path) cfg.taskSource = { kind: "gsm8k", path: resolve(path) };
    return cfg;
  };

  if (inherit) {
    const modeArg = text(values, "mode") ?? "swarm-jev";
    const mode = MODES.find((m) => m === modeArg);
    if (mode === undefined || !SWARM_MODES.includes(mode)) throw new Error(`--inherit needs one swarm mode (${SWARM_MODES.join(", ")})`);
    return [
      { label: `${mode}/cold${suffix}`, config: configFor(mode), budgetFromSwarm: false },
      { label: `${mode}/warm${suffix}`, config: configFor(mode, 1), budgetFromSwarm: false },
    ];
  }
  const modes = parseModes(text(values, "mode") ?? "all");
  return modes.map((mode) => ({
    label: `${mode}${suffix}`,
    config: configFor(mode),
    budgetFromSwarm: mode === "single-vote" && voteBudget === undefined && modes.includes("swarm-jev"),
  }));
}

const fmt = (v: number, digits: number): string => v.toFixed(digits);

export function formatTable(results: BenchResult[]): string {
  const row = (cells: string[]) => cells.map((c, i) => c.padEnd(COLUMNS[i]?.[1] ?? 8)).join(" ").trimEnd();
  const lines = [row(COLUMNS.map(([h]) => h)), row(COLUMNS.map(([, w]) => "-".repeat(w)))];
  let canaryOnly = false;
  for (const { label, summary: r } of results) {
    const m = r.metrics;
    const judged = m.s1Decisions + m.s2Decisions > 0;
    const swarm = SWARM_MODES.includes(r.mode);
    if (!m.accuracyApplicable) canaryOnly = true;
    lines.push(
      row([
        label,
        r.simulated ? "yes" : "no",
        `${fmt(m.accuracy, 3)}${m.accuracyApplicable ? "" : "*"}`,
        `${m.correct}/${r.config.taskSource.kind === "research" ? r.config.taskSource.canaries : m.tasksTotal}`,
        String(m.totalTokens),
        String(m.workTokens),
        String(m.coordinationTokens),
        fmt(m.coordinationShare, 3),
        fmt(m.costUsd, 4),
        fmt(m.air, 3),
        judged ? fmt(m.escalationRate, 3) : "-",
        m.s1Decisions > 0 ? fmt(m.passThroughErrorRate, 3) : "-",
        swarm ? fmt(m.falseAcceptVerifiedRate, 3) : "-",
        fmt((r.finishedAt - r.startedAt) / 1000, 1),
        r.aborted ?? "-",
      ]),
    );
  }
  if (canaryOnly) lines.push("", "* research run: accuracy counts canary claims only (idea claims have no ground truth)");
  return lines.join("\n");
}

const stamp = (d: Date): string =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-` +
  `${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      mode: { type: "string" },
      n: { type: "string" },
      cells: { type: "string" },
      seed: { type: "string" },
      judge: { type: "string" },
      llm: { type: "string" },
      "sim-pace": { type: "string" },
      reasoning: { type: "string" },
      source: { type: "string" },
      difficulty: { type: "string" },
      path: { type: "string" },
      "max-cost": { type: "string" },
      "vote-budget": { type: "string" },
      inherit: { type: "boolean" },
      "library-dir": { type: "string" },
      "evomap-lookup": { type: "boolean" },
      research: { type: "string" },
      claims: { type: "string" },
      canaries: { type: "string" },
      "cell-models": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const { help: _help, ...args } = values;
  const plan = buildPlan(args);
  await mkdir(RUNS_DIR, { recursive: true });
  const libraryArg = text(args, "library-dir");
  // A fresh directory under runs/ makes the cold run truly cold without touching the dashboard's library.
  const libraryDir = libraryArg ? resolve(libraryArg) : args.inherit ? await mkdtemp(join(RUNS_DIR, "bench-library-")) : undefined;
  if (libraryDir) process.stderr.write(`experience library: ${libraryDir}\n`);

  const results: BenchResult[] = [];
  const reports: Record<string, ResearchReport> = {};
  let swarmTokens: number | undefined;
  for (const run of plan) {
    const config = run.budgetFromSwarm && swarmTokens !== undefined ? { ...run.config, voteBudgetTokens: swarmTokens } : run.config;
    const budget = config.mode === "single-vote" ? `, vote budget=${config.voteBudgetTokens || "fixed k"}` : "";
    const difficulty = difficultyOf(config);
    const level = difficulty === undefined ? "" : `, difficulty=${difficulty}`;
    const pace = config.simPace === 1 ? "" : `, sim-pace=${config.simPace}`;
    process.stderr.write(`running ${run.label} (n=${config.n}, cells=${config.cells}, seed=${config.seed}, llm=${config.llm}, judge=${config.judge}${level}${pace}${budget}) ... `);
    const bus = new SimpleEventBus();
    bus.on((e) => {
      if (e.type === "research.report") reports[e.runId] = e.report;
    });
    const handle = await startRun(config, { bus, runsDir: RUNS_DIR, ...(libraryDir ? { libraryDir } : {}) });
    const summary = await handle.done;
    results.push({ label: run.label, summary });
    if (config.mode === "swarm-jev" && swarmTokens === undefined) swarmTokens = summary.metrics.totalTokens;
    process.stderr.write(`${summary.aborted ? `aborted: ${summary.aborted}` : "done"} (${handle.runId})\n`);
  }

  console.log(formatTable(results));
  const out = join(RUNS_DIR, `compare-${stamp(new Date())}.json`);
  const runs = results.map(({ label, summary }) => ({ label, ...summary }));
  const difficulty = plan[0] === undefined ? undefined : difficultyOf(plan[0].config);
  await writeFile(out, `${JSON.stringify({ createdAt: Date.now(), args, difficulty, libraryDir, runs, reports }, null, 2)}\n`);
  console.log(`\nwrote ${out}`);
  return results.some((r) => r.summary.aborted?.startsWith("error")) ? 1 : 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      console.error(USAGE);
      process.exit(1);
    },
  );
}
