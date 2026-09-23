import { readFile } from "node:fs/promises";
import { seededShuffle } from "../core/rng";
import type { Task, TaskSource } from "../core/types";
import { normalizeAnswer } from "./check";

const FINAL_ANSWER = /####\s*([^\n]+?)\s*$/;
const NUMERIC = /^-?\d+(?:\.\d+)?$/;

function parseLine(line: string, index: number): Task | undefined {
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof row !== "object" || row === null) return undefined;
  const { question, answer } = row as Record<string, unknown>;
  if (typeof question !== "string" || !question.trim() || typeof answer !== "string") return undefined;
  const final = FINAL_ANSWER.exec(answer)?.[1];
  if (final === undefined) return undefined;
  const normalized = normalizeAnswer(final);
  if (!NUMERIC.test(normalized)) return undefined;
  return { id: `g${String(index).padStart(4, "0")}`, domain: "gsm8k", prompt: question.trim(), answer: normalized };
}

/** Valid tasks in file order; malformed lines are skipped. Ids carry the 0-based line index. */
export function parseGsm8k(text: string): Task[] {
  return text.split(/\r?\n/).flatMap((line, i) => (line.trim() ? (parseLine(line, i) ?? []) : []));
}

export class Gsm8kTaskSource implements TaskSource {
  constructor(private readonly path: string) {}

  async load(n: number, seed: number): Promise<Task[]> {
    const valid = parseGsm8k(await readFile(this.path, "utf8"));
    if (valid.length < n) {
      throw new Error(`gsm8k: need ${n} tasks but ${this.path} has only ${valid.length} valid lines`);
    }
    const chosen = new Set(seededShuffle(valid, seed).slice(0, n));
    return valid.filter((t) => chosen.has(t));
  }
}
