import type { AgentRegistry, CapabilityCard, Domain } from "../core/types";

type DomainRecord = { wins: number; trials: number };
type Domains = CapabilityCard["domains"];

const GIST_DOMAINS = 2;

/** Laplace prior, same as gene fitness: an agent with no record in a domain scores 0.5. */
export function smoothedRate(r?: DomainRecord): number {
  return r ? (r.wins + 1) / (r.trials + 2) : 0.5;
}

/** "anthropic/claude-haiku-4.5" -> "claude-haiku-4.5". */
export function shortModel(model: string): string {
  return model.slice(model.lastIndexOf("/") + 1) || model;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function domainEntries(d: Domains): Array<[Domain, DomainRecord]> {
  return (Object.entries(d) as Array<[Domain, DomainRecord | undefined]>).filter((e): e is [Domain, DomainRecord] => e[1] !== undefined);
}

function copyDomains(d: Domains): Domains {
  const out: Domains = {};
  for (const [k, r] of domainEntries(d)) out[k] = { wins: r.wins, trials: r.trials };
  return out;
}

const copyCard = (c: CapabilityCard): CapabilityCard => ({ ...c, domains: copyDomains(c.domains), genes: [...c.genes] });

/** e.g. "c03 haiku-4.5 trust 0.72 arithmetic 5/6"; non-active status is appended. */
export function cardGist(card: CapabilityCard): string {
  const domains = domainEntries(card.domains)
    .filter(([, r]) => r.trials > 0)
    .sort(([da, a], [db, b]) => b.trials - a.trials || cmp(da, db))
    .slice(0, GIST_DOMAINS)
    .map(([d, r]) => `${d} ${r.wins}/${r.trials}`);
  const parts = [card.agentId, shortModel(card.model), `trust ${card.trust.toFixed(2)}`, ...domains];
  if (card.status !== "active") parts.push(card.status);
  return parts.filter((p) => p !== "").join(" ");
}

/** In-process registry. Discovery is advisory: it ranks peers and never assigns work. */
export class MemoryRegistry implements AgentRegistry {
  private readonly cards = new Map<string, CapabilityCard>();

  announce(card: CapabilityCard): void {
    this.cards.set(card.agentId, copyCard(card));
  }

  update(agentId: string, patch: Partial<Omit<CapabilityCard, "agentId">>): CapabilityCard | undefined {
    const cur = this.cards.get(agentId);
    if (!cur) return undefined;
    const domains = copyDomains(cur.domains);
    for (const [d, r] of domainEntries(patch.domains ?? {})) domains[d] = { wins: r.wins, trials: r.trials };
    const next: CapabilityCard = {
      agentId,
      model: patch.model ?? cur.model,
      domains,
      genes: [...(patch.genes ?? cur.genes)],
      trust: patch.trust ?? cur.trust,
      status: patch.status ?? cur.status,
      joinedAt: patch.joinedAt ?? cur.joinedAt,
      // Messages can arrive out of order; liveness must never move backwards.
      lastSeen: patch.lastSeen === undefined ? cur.lastSeen : Math.max(cur.lastSeen, patch.lastSeen),
    };
    this.cards.set(agentId, next);
    return copyCard(next);
  }

  get(agentId: string): CapabilityCard | undefined {
    const c = this.cards.get(agentId);
    return c && copyCard(c);
  }

  list(): CapabilityCard[] {
    return [...this.cards.values()].sort((a, b) => a.joinedAt - b.joinedAt || cmp(a.agentId, b.agentId)).map(copyCard);
  }

  discover(q: { domain?: Domain; exclude?: string[]; limit: number }): CapabilityCard[] {
    const excluded = new Set(q.exclude ?? []);
    const domain = q.domain;
    const rate = (c: CapabilityCard): number => (domain === undefined ? 0 : smoothedRate(c.domains[domain]));
    return [...this.cards.values()]
      .filter((c) => c.status === "active" && !excluded.has(c.agentId))
      .sort((a, b) => rate(b) - rate(a) || b.trust - a.trust || cmp(a.agentId, b.agentId))
      .slice(0, Math.max(0, q.limit))
      .map(copyCard);
  }
}
