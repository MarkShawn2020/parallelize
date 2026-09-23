import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseRunConfig, RUNS_DIR } from "../config";
import { SimpleEventBus } from "../core/events";
import { MODES } from "../core/types";
import type { Mode, RunConfig, RunSummary } from "../core/types";
import { startRun } from "../run";

const USAGE = `usage: pnpm bench [--mode <${MODES.join("|")}|all>] [--n 64] [--cells 8] [--seed 7]
                  [--judge jev|mock] [--llm openrouter|mock] [--source synthetic|gsm8k] [--path file.jsonl] [--max-cost 2]`;

const COLUMNS: Array<[string, number]> = [
  ["mode", 10],
  ["sim", 4],
  ["accuracy", 8],
  ["correct/n", 9],
  ["total_tok", 10],
  ["work_tok", 10],
  ["coord_tok", 10],
  ["cost_usd", 9],
  ["AIR", 7],
  ["esc_rate", 8],
  ["wall_s", 7],
  ["aborted", 12],
];

function num(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`--${name} must be a number, got ${raw}`);
  return v;
}

export function buildConfigs(values: Record<string, string | undefined>): RunConfig[] {
  const modeArg = values.mode ?? "all";
  if (modeArg !== "all" && !MODES.includes(modeArg as Mode)) throw new Error(`--mode must be one of ${MODES.join(", ")} or all`);
  const modes = modeArg === "all" ? [...MODES] : [modeArg as Mode];
  const source = values.source ?? "synthetic";
  if (source !== "synthetic" && source !== "gsm8k") throw new Error("--source must be synthetic or gsm8k");
  if (source === "gsm8k" && !values.path) throw new Error("--source gsm8k needs --path <file.jsonl>");

  return modes.map((mode) => {
    const cfg = parseRunConfig({
      mode,
      n: num("n", values.n),
      cells: num("cells", values.cells),
      seed: num("seed", values.seed),
      judge: values.judge,
      llm: values.llm,
      maxCostUsd: num("max-cost", values["max-cost"]),
    });
    // The CLI is local and trusted, so --path may point anywhere (the server restricts it to data/).
    if (source === "gsm8k" && values.path) cfg.taskSource = { kind: "gsm8k", path: resolve(values.path) };
    return cfg;
  });
}

const fmt = (v: number, digits: number): string => v.toFixed(digits);

export function formatTable(runs: RunSummary[]): string {
  const row = (cells: string[]) => cells.map((c, i) => c.padEnd(COLUMNS[i]?.[1] ?? 8)).join(" ").trimEnd();
  const lines = [row(COLUMNS.map(([h]) => h)), row(COLUMNS.map(([, w]) => "-".repeat(w)))];
  for (const r of runs) {
    const m = r.metrics;
    lines.push(
      row([
        r.mode,
        r.simulated ? "yes" : "no",
        fmt(m.accuracy, 3),
        `${m.correct}/${m.tasksTotal}`,
        String(m.totalTokens),
        String(m.workTokens),
        String(m.coordinationTokens),
        fmt(m.costUsd, 4),
        fmt(m.air, 3),
        m.s1Decisions + m.s2Decisions > 0 ? fmt(m.escalationRate, 3) : "-",
        fmt((r.finishedAt - r.startedAt) / 1000, 1),
        r.aborted ?? "-",
      ]),
    );
  }
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
      source: { type: "string" },
      path: { type: "string" },
      "max-cost": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const { help: _help, ...args } = values;
  const configs = buildConfigs(args);

  const runs: RunSummary[] = [];
  for (const config of configs) {
    process.stderr.write(`running ${config.mode} (n=${config.n}, cells=${config.cells}, llm=${config.llm}, judge=${config.judge}) ... `);
    const handle = await startRun(config, { bus: new SimpleEventBus(), runsDir: RUNS_DIR });
    const summary = await handle.done;
    runs.push(summary);
    process.stderr.write(`${summary.aborted ? `aborted: ${summary.aborted}` : "done"} (${handle.runId})\n`);
  }

  console.log(formatTable(runs));
  await mkdir(RUNS_DIR, { recursive: true });
  const out = join(RUNS_DIR, `compare-${stamp(new Date())}.json`);
  await writeFile(out, `${JSON.stringify({ createdAt: Date.now(), args, runs }, null, 2)}\n`);
  console.log(`\nwrote ${out}`);
  return runs.some((r) => r.aborted?.startsWith("error")) ? 1 : 0;
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
