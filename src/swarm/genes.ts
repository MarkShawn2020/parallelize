import type { Domain, Gene, GenePool } from "../core/types";

/** Laplace prior: an untried gene scores 0.5, so one lucky win cannot dominate the pool. */
export function geneFitness(g: Gene): number {
  return (g.wins + 1) / (g.trials + 2);
}

export function createGene(p: {
  id: string;
  domain: Domain;
  text: string;
  origin: string;
  lineageId: string;
  now: number;
}): Gene {
  return {
    id: p.id,
    kind: "solve",
    domain: p.domain,
    text: p.text,
    origin: p.origin,
    lineageId: p.lineageId,
    wins: 0,
    trials: 0,
    createdAt: p.now,
  };
}

/** Fitness is per cell: a strategy that works for one cell may not work for another. */
export function adoptCopy(g: Gene, now: number): Gene {
  return { ...g, wins: 0, trials: 0, createdAt: now };
}

function byEviction(a: Gene, b: Gene): number {
  return geneFitness(a) - geneFitness(b) || a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}

function byRank(a: Gene, b: Gene): number {
  return geneFitness(b) - geneFitness(a) || b.createdAt - a.createdAt || a.id.localeCompare(b.id);
}

export class MemoryGenePool implements GenePool {
  private readonly genes = new Map<string, Gene>();
  private readonly capacity: number;

  constructor(opts: { capacity: number }) {
    this.capacity = opts.capacity;
  }

  list(): Gene[] {
    return [...this.genes.values()].map((g) => ({ ...g })).sort(byRank);
  }

  has(id: string): boolean {
    return this.genes.has(id);
  }

  add(g: Gene): Gene | undefined {
    if (this.genes.has(g.id)) return undefined;
    this.genes.set(g.id, { ...g });
    if (this.genes.size <= this.capacity) return undefined;

    // The newcomer is exempt: it has had no trials yet, so evicting it would make adoption a no-op.
    let victim: Gene | undefined;
    for (const c of this.genes.values()) {
      if (c.id !== g.id && (!victim || byEviction(c, victim) < 0)) victim = c;
    }
    if (victim) this.genes.delete(victim.id);
    return victim;
  }

  best(domain?: Domain): Gene | undefined {
    let top: Gene | undefined;
    for (const c of this.genes.values()) {
      if (domain !== undefined && c.domain !== domain) continue;
      if (!top || byRank(c, top) < 0) top = c;
    }
    return top && { ...top };
  }

  record(geneId: string, success: boolean): void {
    const g = this.genes.get(geneId);
    if (!g) return;
    g.trials++;
    if (success) g.wins++;
  }

  fitness(g: Gene): number {
    return geneFitness(g);
  }
}
