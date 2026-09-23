import { describe, expect, it } from "vitest";
import type { Domain, Gene } from "../core/types";
import { MemoryGenePool, adoptCopy, createGene, geneFitness, provenGeneBlocks } from "./genes";

function gene(id: string, opts: { domain?: Domain; now?: number; wins?: number; trials?: number } = {}): Gene {
  return {
    ...createGene({
      id,
      domain: opts.domain ?? "arithmetic",
      text: `strategy ${id}`,
      origin: "cell-0",
      lineageId: `lin-${id}`,
      now: opts.now ?? 0,
    }),
    wins: opts.wins ?? 0,
    trials: opts.trials ?? 0,
  };
}

describe("geneFitness", () => {
  it("uses a Laplace prior", () => {
    expect(geneFitness(gene("a"))).toBe(0.5);
    expect(geneFitness(gene("a", { wins: 3, trials: 3 }))).toBeCloseTo(0.8);
    expect(geneFitness(gene("a", { wins: 0, trials: 2 }))).toBe(0.25);
  });
});

describe("createGene / adoptCopy", () => {
  it("creates a fresh solve gene", () => {
    const g = createGene({ id: "g1", domain: "logic", text: "t", origin: "c1", lineageId: "L1", now: 42 });
    expect(g).toEqual({
      id: "g1",
      kind: "solve",
      domain: "logic",
      text: "t",
      origin: "c1",
      lineageId: "L1",
      wins: 0,
      trials: 0,
      createdAt: 42,
    });
  });

  it("gives the adopting cell a reset copy and leaves the source untouched", () => {
    const src = gene("g1", { domain: "rates", now: 5, wins: 7, trials: 9 });
    const copy = adoptCopy(src, 100);
    expect(copy).toEqual({ ...src, wins: 0, trials: 0, createdAt: 100 });
    expect(copy).not.toBe(src);
    expect(src.wins).toBe(7);
    expect(src.trials).toBe(9);
  });

  it("keeps fitness per cell", () => {
    const a = new MemoryGenePool({ capacity: 4 });
    const b = new MemoryGenePool({ capacity: 4 });
    a.add(gene("g1"));
    a.record("g1", true);
    a.record("g1", true);
    const shared = a.list()[0] as Gene;
    b.add(adoptCopy(shared, 10));
    b.record("g1", false);
    expect(a.fitness(a.best() as Gene)).toBeCloseTo(0.75);
    expect(b.fitness(b.best() as Gene)).toBeCloseTo(1 / 3);
  });
});

describe("MemoryGenePool", () => {
  it("ignores a duplicate id and keeps the existing stats", () => {
    const pool = new MemoryGenePool({ capacity: 2 });
    expect(pool.add(gene("g1"))).toBeUndefined();
    pool.record("g1", true);
    expect(pool.add(gene("g1", { now: 9 }))).toBeUndefined();
    expect(pool.list()).toHaveLength(1);
    expect(pool.list()[0]).toMatchObject({ id: "g1", wins: 1, trials: 1, createdAt: 0 });
  });

  it("never evicts the newcomer, even when it has the lowest fitness", () => {
    const pool = new MemoryGenePool({ capacity: 2 });
    pool.add(gene("strong", { wins: 9, trials: 9 }));
    pool.add(gene("ok", { wins: 2, trials: 2 }));
    const evicted = pool.add(gene("fresh", { now: 1, wins: 0, trials: 5 }));
    expect(evicted?.id).toBe("ok");
    expect(pool.has("fresh")).toBe(true);
    expect(pool.has("strong")).toBe(true);
    expect(pool.has("ok")).toBe(false);
  });

  it("evicts the lowest-fitness existing gene", () => {
    const pool = new MemoryGenePool({ capacity: 3 });
    pool.add(gene("a", { wins: 1, trials: 1 }));
    pool.add(gene("b", { wins: 0, trials: 3 }));
    pool.add(gene("c", { wins: 3, trials: 4 }));
    expect(pool.add(gene("d"))?.id).toBe("b");
    expect(pool.list().map((g) => g.id).sort()).toEqual(["a", "c", "d"]);
  });

  it("breaks eviction ties by oldest createdAt, then id", () => {
    const byAge = new MemoryGenePool({ capacity: 2 });
    byAge.add(gene("young", { now: 20 }));
    byAge.add(gene("old", { now: 10 }));
    expect(byAge.add(gene("new", { now: 30 }))?.id).toBe("old");

    const byId = new MemoryGenePool({ capacity: 2 });
    byId.add(gene("b", { now: 10 }));
    byId.add(gene("a", { now: 10 }));
    expect(byId.add(gene("c", { now: 30 }))?.id).toBe("a");
  });

  it("stays within capacity across many additions", () => {
    const pool = new MemoryGenePool({ capacity: 3 });
    for (let i = 0; i < 10; i++) {
      pool.add(gene(`g${i}`, { now: i }));
      expect(pool.has(`g${i}`)).toBe(true);
      expect(pool.list().length).toBeLessThanOrEqual(3);
    }
  });

  it("lists genes by fitness descending as a copy", () => {
    const pool = new MemoryGenePool({ capacity: 5 });
    pool.add(gene("mid"));
    pool.add(gene("low", { wins: 0, trials: 4 }));
    pool.add(gene("high", { wins: 4, trials: 4 }));
    const listed = pool.list();
    expect(listed.map((g) => g.id)).toEqual(["high", "mid", "low"]);
    listed.pop();
    (listed[0] as Gene).wins = 0;
    expect(pool.list()).toHaveLength(3);
    expect(pool.list()[0]).toMatchObject({ id: "high", wins: 4 });
  });

  it("does not alias the gene object passed to add", () => {
    const pool = new MemoryGenePool({ capacity: 2 });
    const g = gene("g1");
    pool.add(g);
    pool.record("g1", true);
    expect(g.trials).toBe(0);
    g.wins = 99;
    expect(pool.best()?.wins).toBe(1);
  });

  it("records trials and wins, ignoring unknown ids", () => {
    const pool = new MemoryGenePool({ capacity: 2 });
    pool.add(gene("g1"));
    pool.record("g1", true);
    pool.record("g1", false);
    pool.record("missing", true);
    expect(pool.list()).toEqual([expect.objectContaining({ id: "g1", wins: 1, trials: 2 })]);
    expect(pool.has("missing")).toBe(false);
  });

  it("picks the best gene, optionally by domain, ties to the newest", () => {
    const pool = new MemoryGenePool({ capacity: 10 });
    expect(pool.best()).toBeUndefined();
    pool.add(gene("arith-old", { domain: "arithmetic", now: 1 }));
    pool.add(gene("arith-new", { domain: "arithmetic", now: 2 }));
    pool.add(gene("logic-good", { domain: "logic", now: 0, wins: 3, trials: 3 }));
    pool.add(gene("logic-bad", { domain: "logic", now: 5, wins: 0, trials: 3 }));

    expect(pool.best()?.id).toBe("logic-good");
    expect(pool.best("arithmetic")?.id).toBe("arith-new");
    expect(pool.best("logic")?.id).toBe("logic-good");
    expect(pool.best("gsm8k")).toBeUndefined();

    pool.record("arith-old", true);
    expect(pool.best("arithmetic")?.id).toBe("arith-old");
  });
});

describe("provenGeneBlocks", () => {
  const held = (wins: number, trials: number) => ({ ...createGene({ id: "g", domain: "rates", text: "t", origin: "c1", lineageId: "g", now: 0 }), wins, trials });
  it("blocks an equal-or-weaker peer gene once the held gene is proven", () => {
    expect(provenGeneBlocks(held(3, 3), 0.8)).toBe(true); // held fitness 4/5 = 0.8
    expect(provenGeneBlocks(held(3, 3), 0.81)).toBe(false); // the offer is fitter: worth a judgment
  });
  it("never blocks without a proven held gene", () => {
    expect(provenGeneBlocks(undefined, 0)).toBe(false);
    expect(provenGeneBlocks(held(1, 1), 0)).toBe(false); // too few trials
    expect(provenGeneBlocks(held(0, 4), 0)).toBe(false); // fitness 1/6 below the proven line
  });
});
