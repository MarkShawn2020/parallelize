import { describe, expect, it } from "vitest";
import type { CapabilityCard } from "../core/types";
import { MemoryRegistry, cardGist, shortModel, smoothedRate } from "./registry";

const card = (agentId: string, over: Partial<CapabilityCard> = {}): CapabilityCard => ({
  agentId,
  model: "anthropic/claude-haiku-4.5",
  domains: {},
  genes: [],
  trust: 0.5,
  status: "active",
  joinedAt: 0,
  lastSeen: 0,
  ...over,
});

const ids = (cards: CapabilityCard[]): string[] => cards.map((c) => c.agentId);

describe("smoothedRate / shortModel", () => {
  it("applies a Laplace prior", () => {
    expect(smoothedRate()).toBe(0.5);
    expect(smoothedRate({ wins: 0, trials: 0 })).toBe(0.5);
    expect(smoothedRate({ wins: 1, trials: 1 })).toBeCloseTo(2 / 3);
    expect(smoothedRate({ wins: 5, trials: 6 })).toBe(0.75);
  });

  it("drops the vendor prefix", () => {
    expect(shortModel("anthropic/claude-haiku-4.5")).toBe("claude-haiku-4.5");
    expect(shortModel("haiku-4.5")).toBe("haiku-4.5");
    expect(shortModel("")).toBe("");
  });
});

describe("cardGist", () => {
  it("summarises id, model, trust and the most-tried domains", () => {
    expect(cardGist(card("c03", { model: "haiku-4.5", trust: 0.72, domains: { arithmetic: { wins: 5, trials: 6 } } }))).toBe(
      "c03 haiku-4.5 trust 0.72 arithmetic 5/6",
    );
    const busy = card("c01", {
      trust: 0.6,
      domains: { logic: { wins: 1, trials: 2 }, rates: { wins: 3, trials: 4 }, arithmetic: { wins: 2, trials: 2 }, gsm8k: { wins: 0, trials: 0 } },
    });
    expect(cardGist(busy)).toBe("c01 claude-haiku-4.5 trust 0.60 rates 3/4 arithmetic 2/2");
  });

  it("appends a non-active status and skips an empty model", () => {
    expect(cardGist(card("c04", { model: "", trust: 0.21, status: "quarantined" }))).toBe("c04 trust 0.21 quarantined");
  });
});

describe("MemoryRegistry", () => {
  it("stores and returns copies; re-announce replaces", () => {
    const r = new MemoryRegistry();
    const input = card("c01", { genes: ["g"], domains: { logic: { wins: 1, trials: 1 } } });
    r.announce(input);
    input.genes.push("mutated");
    (input.domains.logic as { wins: number }).wins = 99;
    const got = r.get("c01");
    expect(got?.genes).toEqual(["g"]);
    expect(got?.domains).toEqual({ logic: { wins: 1, trials: 1 } });
    got?.genes.push("also mutated");
    expect(r.get("c01")?.genes).toEqual(["g"]);
    r.announce(card("c01", { model: "other" }));
    expect(r.get("c01")).toMatchObject({ model: "other", genes: [], domains: {} });
    expect(r.get("missing")).toBeUndefined();
  });

  it("update merges domains per key, ignores undefined fields and never moves lastSeen back", () => {
    const r = new MemoryRegistry();
    r.announce(card("c01", { domains: { logic: { wins: 1, trials: 2 }, rates: { wins: 0, trials: 1 } }, lastSeen: 100, genes: ["a"] }));
    const next = r.update("c01", {
      domains: { rates: { wins: 2, trials: 3 }, arithmetic: { wins: 1, trials: 1 }, logic: undefined },
      trust: undefined,
      lastSeen: 150,
    });
    expect(next).toMatchObject({
      agentId: "c01",
      trust: 0.5,
      lastSeen: 150,
      genes: ["a"],
      domains: { logic: { wins: 1, trials: 2 }, rates: { wins: 2, trials: 3 }, arithmetic: { wins: 1, trials: 1 } },
    });
    expect(r.update("c01", { lastSeen: 120, trust: 0.8, status: "quarantined", genes: ["b"] })).toMatchObject({
      lastSeen: 150,
      trust: 0.8,
      status: "quarantined",
      genes: ["b"],
    });
    next?.genes.push("x");
    expect(r.get("c01")?.genes).toEqual(["b"]);
    expect(r.update("missing", { trust: 1 })).toBeUndefined();
  });

  it("update cannot rename an agent", () => {
    const r = new MemoryRegistry();
    r.announce(card("c01"));
    r.update("c01", { agentId: "c99" } as Partial<CapabilityCard>);
    expect(r.get("c01")?.agentId).toBe("c01");
    expect(r.get("c99")).toBeUndefined();
  });

  it("lists by joinedAt then agentId", () => {
    const r = new MemoryRegistry();
    r.announce(card("c03", { joinedAt: 5 }));
    r.announce(card("c02", { joinedAt: 10 }));
    r.announce(card("c01", { joinedAt: 5 }));
    expect(ids(r.list())).toEqual(["c01", "c03", "c02"]);
  });

  it("discover ranks active cards by smoothed domain rate, then trust, then id", () => {
    const r = new MemoryRegistry();
    r.announce(card("lucky", { domains: { arithmetic: { wins: 1, trials: 1 } }, trust: 0.9 }));
    r.announce(card("steady", { domains: { arithmetic: { wins: 5, trials: 6 } }, trust: 0.6 }));
    r.announce(card("fresh-b", { trust: 0.7 }));
    r.announce(card("fresh-a", { trust: 0.7 }));
    r.announce(card("poor", { domains: { arithmetic: { wins: 0, trials: 1 } }, trust: 0.95 }));
    r.announce(card("bad", { domains: { arithmetic: { wins: 9, trials: 9 } }, trust: 0.1, status: "quarantined" }));
    r.announce(card("gone", { domains: { arithmetic: { wins: 9, trials: 9 } }, trust: 0.9, status: "dead" }));

    expect(ids(r.discover({ domain: "arithmetic", limit: 10 }))).toEqual(["steady", "lucky", "fresh-a", "fresh-b", "poor"]);
    expect(ids(r.discover({ limit: 10 }))).toEqual(["poor", "lucky", "fresh-a", "fresh-b", "steady"]);
    expect(ids(r.discover({ domain: "arithmetic", exclude: ["steady", "fresh-a"], limit: 2 }))).toEqual(["lucky", "fresh-b"]);
    expect(r.discover({ domain: "arithmetic", limit: 0 })).toEqual([]);
    expect(r.discover({ domain: "arithmetic", limit: -1 })).toEqual([]);
  });

  it("discover returns copies", () => {
    const r = new MemoryRegistry();
    r.announce(card("c01", { genes: ["g"] }));
    r.discover({ limit: 1 })[0]?.genes.push("x");
    expect(r.get("c01")?.genes).toEqual(["g"]);
  });
});
