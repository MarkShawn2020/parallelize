import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

interface Cell {
  executor: string;
  judge: string;
  runIds: string[];
  correct: number;
  n: number;
}
interface Data {
  seeds: number[];
  tasksPerRun: number;
  judges: string[];
  executors: string[];
  cells: Cell[];
  tests: Array<{ executor: string; a: string; b: string; onlyA: number; onlyB: number; p: number }>;
}

const ROOT = join(__dirname, "../../..");
const data = JSON.parse(readFileSync(join(ROOT, "web/public/matrix/judge-matrix.json"), "utf8")) as Data;

/** The run's own summary: the local runs/ folder when present, else the copy published under docs/evidence/<day>. */
function summaryOf(runId: string): { metrics?: { correct?: number } } | null {
  const local = join(ROOT, "runs", runId, "summary.json");
  if (existsSync(local)) return JSON.parse(readFileSync(local, "utf8"));
  for (const day of ["2026-09-24", "2026-09-23"]) {
    const published = join(ROOT, "docs/evidence", day, `${runId}.summary.json`);
    if (existsSync(published)) return JSON.parse(readFileSync(published, "utf8"));
  }
  return null;
}

describe("executor x judge matrix data", () => {
  it("fills every cell with one run per seed", () => {
    expect(data.cells).toHaveLength(data.executors.length * data.judges.length);
    for (const c of data.cells) {
      expect(c.runIds, `${c.executor} × ${c.judge}`).toHaveLength(data.seeds.length);
      expect(c.n).toBe(data.tasksPerRun * data.seeds.length);
      expect(c.correct).toBeLessThanOrEqual(c.n);
    }
  });

  it("tests Jev against every other judge in each row", () => {
    for (const ex of data.executors) {
      const others = data.tests.filter((t) => t.executor === ex).map((t) => t.b);
      expect(others.sort()).toEqual(data.judges.filter((j) => j !== "Jev").sort());
    }
  });

  it("matches the runs' own summaries", () => {
    for (const c of data.cells) {
      const total = c.runIds.reduce((sum, id) => {
        const s = summaryOf(id);
        expect(s, `${id} has no summary in runs/ or docs/evidence`).not.toBeNull();
        return sum + Number(s?.metrics?.correct);
      }, 0);
      expect(total, `${c.executor} × ${c.judge}`).toBe(c.correct);
    }
  });
});
