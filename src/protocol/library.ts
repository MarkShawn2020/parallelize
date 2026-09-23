import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Answer, Domain, ExperienceLibrary, LibraryGene, Precedent } from "../core/types";

export const MAX_LIBRARY_GENES = 300;
export const MAX_LIBRARY_PRECEDENTS = 500;

const DOMAINS: readonly Domain[] = ["arithmetic", "rates", "logic", "gsm8k", "research"];
const GENES_FILE = "genes.jsonl";
const PRECEDENTS_FILE = "precedents.jsonl";

/** Laplace-smoothed, so one lucky win cannot outrank a long track record. */
export function evidenceRate(g: LibraryGene): number {
  return (g.evidence.wins + 1) / (g.evidence.trials + 2);
}

function byEvidence(a: LibraryGene, b: LibraryGene): number {
  return (
    evidenceRate(b) - evidenceRate(a) ||
    b.evidence.trials - a.evidence.trials ||
    b.createdAt - a.createdAt ||
    a.id.localeCompare(b.id)
  );
}

const precedentKey = (p: Precedent): string => `${p.key}␟${p.state}`;

export class FileExperienceLibrary implements ExperienceLibrary {
  private geneMap = new Map<string, LibraryGene>();
  private precedentList: Precedent[] = [];
  // Serialises publish/reset so two overlapping writers cannot drop each other's updates.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly dir: string) {}

  async load(): Promise<{ genes: number; precedents: number }> {
    const [genes, precedents] = await Promise.all([
      readJsonl(join(this.dir, GENES_FILE), parseLibraryGene),
      readJsonl(join(this.dir, PRECEDENTS_FILE), parsePrecedent),
    ]);
    this.geneMap = new Map(genes.map((g) => [g.id, g]));
    this.precedentList = precedents;
    return this.stats();
  }

  genes(domain?: Domain): LibraryGene[] {
    return [...this.geneMap.values()]
      .filter((g) => domain === undefined || g.domain === domain)
      .sort(byEvidence)
      .map(cloneGene);
  }

  precedents(): Precedent[] {
    return this.precedentList.map((p) => ({ ...p }));
  }

  search(domain: Domain, k: number): LibraryGene[] {
    return k <= 0 ? [] : this.genes(domain).slice(0, k);
  }

  publish(genes: LibraryGene[], precedents: Precedent[]): Promise<{ genes: number; precedents: number }> {
    return this.serial(async () => {
      // Re-read first: the files are the source of truth and may have changed since load().
      await this.load();
      for (const g of genes) this.mergeGene(g);
      this.mergePrecedents(precedents);
      await this.persist();
      return this.stats();
    });
  }

  reset(): Promise<void> {
    return this.serial(async () => {
      await Promise.all([rm(join(this.dir, GENES_FILE), { force: true }), rm(join(this.dir, PRECEDENTS_FILE), { force: true })]);
      this.geneMap.clear();
      this.precedentList = [];
    });
  }

  stats(): { genes: number; precedents: number } {
    return { genes: this.geneMap.size, precedents: this.precedentList.length };
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private mergeGene(g: LibraryGene): void {
    const existing = this.geneMap.get(g.id);
    if (!existing) {
      this.geneMap.set(g.id, cloneGene(g));
      return;
    }
    const sources = maxDefined(existing.evidence.independentSources, g.evidence.independentSources);
    existing.evidence = {
      wins: existing.evidence.wins + g.evidence.wins,
      trials: existing.evidence.trials + g.evidence.trials,
      ...(sources === undefined ? {} : { independentSources: sources }),
    };
    if (existing.assetId === undefined && g.assetId !== undefined) existing.assetId = g.assetId;
  }

  private mergePrecedents(incoming: Precedent[]): void {
    const byKey = new Map<string, Precedent>();
    // Later entries win, so a newer verdict for the same key+state replaces the older one.
    for (const p of [...this.precedentList, ...incoming]) {
      const k = precedentKey(p);
      byKey.delete(k);
      byKey.set(k, { ...p });
    }
    const merged = [...byKey.values()].map((p, i) => ({ p, i }));
    merged.sort((a, b) => a.p.at - b.p.at || a.i - b.i);
    this.precedentList = merged.slice(-MAX_LIBRARY_PRECEDENTS).map(({ p }) => p);
  }

  private async persist(): Promise<void> {
    const kept = [...this.geneMap.values()].sort(byEvidence).slice(0, MAX_LIBRARY_GENES);
    this.geneMap = new Map(kept.map((g) => [g.id, g]));
    await mkdir(this.dir, { recursive: true });
    await Promise.all([
      writeAtomic(join(this.dir, GENES_FILE), kept),
      writeAtomic(join(this.dir, PRECEDENTS_FILE), this.precedentList),
    ]);
  }
}

function maxDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

function cloneGene(g: LibraryGene): LibraryGene {
  return { ...g, evidence: { ...g.evidence } };
}

async function writeAtomic(file: string, rows: unknown[]): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const body = rows.map((r) => JSON.stringify(r)).join("\n");
  await writeFile(tmp, body === "" ? "" : `${body}\n`);
  await rename(tmp, file);
}

async function readJsonl<T>(file: string, parse: (v: unknown) => T | undefined): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = parse(raw);
    if (parsed !== undefined) out.push(parsed);
  }
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isProb = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

export function parseLibraryGene(v: unknown): LibraryGene | undefined {
  if (!isObj(v) || !isObj(v.evidence)) return undefined;
  const e = v.evidence;
  if (
    !isStr(v.id) ||
    v.id === "" ||
    v.kind !== "solve" ||
    !DOMAINS.includes(v.domain as Domain) ||
    !isStr(v.text) ||
    !isStr(v.origin) ||
    !isStr(v.lineageId) ||
    !isCount(v.wins) ||
    !isCount(v.trials) ||
    !isTime(v.createdAt) ||
    (v.source !== "local" && v.source !== "evomap") ||
    !isCount(e.wins) ||
    !isCount(e.trials) ||
    (e.independentSources !== undefined && !isCount(e.independentSources)) ||
    (v.runId !== undefined && !isStr(v.runId)) ||
    (v.assetId !== undefined && !isStr(v.assetId))
  ) {
    return undefined;
  }
  return {
    id: v.id,
    kind: "solve",
    domain: v.domain as Domain,
    text: v.text,
    origin: v.origin,
    lineageId: v.lineageId,
    wins: v.wins,
    trials: v.trials,
    createdAt: v.createdAt,
    source: v.source,
    ...(v.runId === undefined ? {} : { runId: v.runId }),
    ...(v.assetId === undefined ? {} : { assetId: v.assetId }),
    evidence: {
      wins: e.wins,
      trials: e.trials,
      ...(e.independentSources === undefined ? {} : { independentSources: e.independentSources }),
    },
  };
}

export function parsePrecedent(v: unknown): Precedent | undefined {
  if (!isObj(v) || !isStr(v.key) || !isStr(v.state) || !isTime(v.at)) return undefined;
  const verdict = parseAnswer(v.verdict);
  return verdict ? { key: v.key, state: v.state, verdict, at: v.at } : undefined;
}

function parseProbabilities(v: unknown): Record<string, number> | undefined {
  if (!isObj(v)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, p] of Object.entries(v)) {
    if (!isProb(p)) return undefined;
    out[k] = p;
  }
  return out;
}

function parseAnswer(v: unknown): Answer | undefined {
  if (!isObj(v)) return undefined;
  if (v.type === "noul") return isProb(v.noul) ? { type: "noul", noul: v.noul } : undefined;
  if (v.type === "choice") {
    const probabilities = parseProbabilities(v.probabilities);
    if (!isStr(v.choice) || !probabilities || !isProb(v.confidence)) return undefined;
    return { type: "choice", choice: v.choice, probabilities, confidence: v.confidence };
  }
  if (v.type === "score") {
    if (!isTime(v.score) || !isProb(v.confidence)) return undefined;
    if (v.probabilities === undefined) return { type: "score", score: v.score, confidence: v.confidence };
    const probabilities = parseProbabilities(v.probabilities);
    return probabilities ? { type: "score", score: v.score, confidence: v.confidence, probabilities } : undefined;
  }
  return undefined;
}
