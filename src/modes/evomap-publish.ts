import { readFile } from "node:fs/promises";
import { seededShuffle } from "../core/rng";
import type { Domain, LibraryGene, LLM, Task } from "../core/types";
import type { EvoMapClient, EvoMapSendResult } from "../providers/evomap";
import { Semaphore } from "../providers/limiter";
import { buildSolvePrompt, SOLVE_SYSTEM } from "../swarm/cell";
import { geneFitness } from "../swarm/genes";
import { sanitizeGeneText } from "../swarm/sanitize";
import { checkAnswer, extractFinalAnswer } from "../tasks/check";
import { parseGsm8k } from "../tasks/gsm8k";
import { SyntheticTaskSource } from "../tasks/synthetic";

export const PUBLISH_MIN_FITNESS = 0.7;
export const PUBLISH_MIN_TRIALS = 3;
export const MAX_PUBLISH_CANDIDATES = 2;
const MIN_STEP_CHARS = 15;
// Research verdicts have no fresh tasks with ground truth, so only these domains can pass a holdout gate.
const GATE_DOMAINS: readonly Domain[] = ["arithmetic", "rates", "logic", "gsm8k"];

export const DOMAIN_SIGNALS: Record<Domain, string[]> = {
  arithmetic: ["arithmetic", "multi-step calculation", "order of operations", "answer verification"],
  rates: ["rate problem", "time distance speed", "work rate", "unit conversion"],
  logic: ["logic puzzle", "case elimination", "constraint reasoning"],
  gsm8k: ["grade school math", "word problem", "multi-step reasoning"],
  research: ["claim verification", "evidence assessment"],
};

export interface GateRow {
  geneId: string;
  withGene: number;
  withoutGene: number;
  tasks: number;
  passed: boolean;
}

export interface PublishOutcome {
  gate: GateRow[];
  evomap: { assetIds: string[]; urls: string[]; status: string };
  /** geneId -> EvoMap Gene asset id, for bundles the hub accepted. */
  published: Map<string, string>;
}

/** Up to two local genes whose evidence in this run clears the bar, never injection-shaped text. */
export function publishCandidates(genes: readonly LibraryGene[]): LibraryGene[] {
  return genes
    .filter(
      (g) =>
        g.source === "local" &&
        GATE_DOMAINS.includes(g.domain) &&
        g.trials >= PUBLISH_MIN_TRIALS &&
        geneFitness(g) >= PUBLISH_MIN_FITNESS &&
        !sanitizeGeneText(g.text).suspicious,
    )
    .sort((a, b) => geneFitness(b) - geneFitness(a) || b.trials - a.trials || a.id.localeCompare(b.id))
    .slice(0, MAX_PUBLISH_CANDIDATES);
}

/** A one-sentence strategy split into clauses; fragments too short to stand alone stay with the previous step. */
export function strategySteps(text: string): string[] {
  const parts = text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?;。；])\s+|,\s*(?:and\s+)?then\s+|\s+then\s+|,\s+and\s+/i)
    .map((s) => s.trim().replace(/[.;。；]+$/, ""))
    .filter((s) => s !== "");
  const steps: string[] = [];
  for (const p of parts) {
    const last = steps.at(-1);
    if (last !== undefined && (p.length < MIN_STEP_CHARS || last.length < MIN_STEP_CHARS)) steps[steps.length - 1] = `${last}, ${p}`;
    else steps.push(p);
  }
  return steps;
}

/**
 * Holdout tasks of one domain that the run never saw. Ids are renamed so they cannot collide with the
 * run's task ids in the ledger or in a simulated provider's per-task state.
 */
export async function freshTasks(p: {
  domain: Domain;
  count: number;
  seed: number;
  exclude: ReadonlySet<string>;
  gsm8kPath?: string;
  /** Holdout tasks match the run's difficulty, so a gene is judged where it was learned. */
  difficulty?: "normal" | "hard";
}): Promise<Task[]> {
  let pool: Task[];
  if (p.domain === "gsm8k") {
    if (p.gsm8kPath === undefined) return [];
    pool = seededShuffle(parseGsm8k(await readFile(p.gsm8kPath, "utf8")), p.seed);
  } else if (p.domain === "research") {
    return [];
  } else {
    // Synthetic domains rotate, so 3x the count (plus slack for excluded prompts) yields enough of one domain.
    pool = await new SyntheticTaskSource({ difficulty: p.difficulty ?? "normal" }).load(p.count * 3 + 30, p.seed);
  }
  return pool
    .filter((t) => t.domain === p.domain && !p.exclude.has(t.prompt))
    .slice(0, p.count)
    .map((t, i) => ({ ...t, id: `holdout-${p.domain}-${p.seed}-${i + 1}` }));
}

/** Solves every holdout task with and without the gene (paired), counting correct answers. */
export async function holdoutGate(p: {
  runId: string;
  gene: LibraryGene;
  tasks: Task[];
  llm: LLM;
  minDelta: number;
  concurrency: number;
}): Promise<GateRow> {
  const limiter = new Semaphore(Math.max(1, Math.floor(p.concurrency)));
  const solve = (t: Task, withGene: boolean) =>
    limiter.run(async () => {
      const task = { id: t.id, domain: t.domain, prompt: t.prompt };
      const r = await p.llm.complete({
        messages: [
          { role: "system", content: SOLVE_SYSTEM },
          { role: "user", content: buildSolvePrompt(task, withGene ? p.gene : undefined) },
        ],
        maxTokens: 600,
        meta: { runId: p.runId, purpose: "solve", cellId: "holdout", taskId: t.id },
      });
      return checkAnswer(t.answer, extractFinalAnswer(r.text));
    });
  const results = await Promise.all(p.tasks.flatMap((t) => [solve(t, true), solve(t, false)]));
  const withGene = results.filter((ok, i) => ok && i % 2 === 0).length;
  const withoutGene = results.filter((ok, i) => ok && i % 2 === 1).length;
  return { geneId: p.gene.id, withGene, withoutGene, tasks: p.tasks.length, passed: p.tasks.length > 0 && withGene - withoutGene >= p.minDelta };
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Gate first, then validate, then publish: a gene reaches EvoMap only if it beat "no gene" on fresh
 * tasks and the hub's dry run accepted the bundle. Never throws; every failure lands in the status.
 */
export async function gateAndPublish(p: {
  runId: string;
  candidates: LibraryGene[];
  holdout: (gene: LibraryGene, index: number) => Promise<{ tasks: Task[]; llm: LLM }>;
  minDelta: number;
  concurrency: number;
  client: EvoMapClient;
  modelName: string;
  /** false: run the gate but never contact the hub (simulated runs must not publish simulated evidence). */
  send: boolean;
  log: (level: "info" | "warn", message: string) => void;
}): Promise<PublishOutcome> {
  const out: PublishOutcome = { gate: [], evomap: { assetIds: [], urls: [], status: "no-candidates" }, published: new Map() };
  if (p.candidates.length === 0) return out;
  const statuses: string[] = [];
  for (const [i, gene] of p.candidates.entries()) {
    let row: GateRow;
    try {
      const { tasks, llm } = await p.holdout(gene, i);
      if (tasks.length === 0) {
        statuses.push("no-holdout-tasks");
        continue;
      }
      row = await holdoutGate({ runId: p.runId, gene, tasks, llm, minDelta: p.minDelta, concurrency: p.concurrency });
    } catch (err) {
      p.log("warn", `holdout gate for ${gene.id} failed: ${errorMessage(err)}`);
      statuses.push("gate-error");
      continue;
    }
    out.gate.push(row);
    p.log("info", `holdout gate ${gene.id}: ${row.withGene}/${row.tasks} with vs ${row.withoutGene}/${row.tasks} without -> ${row.passed ? "pass" : "fail"}`);
    if (!row.passed) {
      statuses.push("gate-failed");
      continue;
    }
    if (!p.send) {
      statuses.push("gate-passed (simulated run, not published)");
      continue;
    }
    const res = await sendBundle(p.client, {
      gene,
      modelName: p.modelName,
      signals: DOMAIN_SIGNALS[gene.domain],
      strategy: strategySteps(gene.text),
      confidence: row.withGene / row.tasks,
      score: row.withGene / row.tasks,
      // Only an unbroken record proves a streak; wins alone do not say in which order they came.
      successStreak: gene.wins === gene.trials ? gene.wins : 0,
      cycles: 1,
      mutations: 0,
      gate: { tasks: row.tasks, withGene: row.withGene, withoutGene: row.withoutGene },
    });
    statuses.push(res.status);
    if (res.error) p.log("warn", `EvoMap ${res.status} for ${gene.id}: ${res.error}`);
    if (res.ok) {
      out.evomap.assetIds.push(...res.assetIds);
      out.evomap.urls.push(...res.urls);
      const geneAsset = res.assetIds[0];
      if (geneAsset !== undefined) out.published.set(gene.id, geneAsset);
    }
  }
  out.evomap.status = [...new Set(statuses)].join(", ");
  return out;
}

async function sendBundle(client: EvoMapClient, input: Parameters<EvoMapClient["buildBundle"]>[0]): Promise<EvoMapSendResult & { status: string }> {
  const bundle = client.buildBundle(input);
  const checked = await client.validate(bundle);
  if (!checked.ok) return { ...checked, status: `validate-${checked.status}` };
  const res = await client.publish(bundle);
  return res.ok ? { ...res, status: "published" } : { ...res, status: `publish-${res.status}` };
}
