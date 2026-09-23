import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Domain, LibraryGene, Precedent } from "../core/types";
import { FileExperienceLibrary, MAX_LIBRARY_GENES, MAX_LIBRARY_PRECEDENTS } from "./library";

function gene(id: string, wins: number, trials: number, over: Partial<LibraryGene> = {}): LibraryGene {
  return {
    id,
    kind: "solve",
    domain: "arithmetic",
    text: `strategy ${id}`,
    origin: "cell-1",
    lineageId: id,
    wins: 0,
    trials: 0,
    createdAt: 1000,
    source: "local",
    evidence: { wins, trials },
    ...over,
  };
}

function precedent(key: string, state: string, at: number, noul = 0.9): Precedent {
  return { key, state, verdict: { type: "noul", noul }, at };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "parallelize-library-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("FileExperienceLibrary", () => {
  it("starts empty when no files exist", async () => {
    const lib = new FileExperienceLibrary(join(dir, "missing"));
    await expect(lib.load()).resolves.toEqual({ genes: 0, precedents: 0 });
    expect(lib.search("arithmetic", 3)).toEqual([]);
  });

  it("persists genes and precedents across instances", async () => {
    const a = new FileExperienceLibrary(dir);
    await a.publish([gene("g1", 3, 4, { runId: "r1", assetId: "sha256:abc" })], [precedent("verify", "s1", 5)]);
    const b = new FileExperienceLibrary(dir);
    await expect(b.load()).resolves.toEqual({ genes: 1, precedents: 1 });
    expect(b.genes()[0]).toEqual(gene("g1", 3, 4, { runId: "r1", assetId: "sha256:abc" }));
    expect(b.precedents()).toEqual([precedent("verify", "s1", 5)]);
  });

  it("merges a known gene by summing evidence and keeping the stored text", async () => {
    const lib = new FileExperienceLibrary(dir);
    await lib.publish([gene("g1", 3, 4, { evidence: { wins: 3, trials: 4, independentSources: 2 } })], []);
    await lib.publish([gene("g1", 2, 5, { text: "rewritten", assetId: "sha256:new", evidence: { wins: 2, trials: 5, independentSources: 1 } })], []);
    const [g] = lib.genes();
    expect(g?.text).toBe("strategy g1");
    expect(g?.evidence).toEqual({ wins: 5, trials: 9, independentSources: 2 });
    expect(g?.assetId).toBe("sha256:new");
    expect(lib.stats()).toEqual({ genes: 1, precedents: 0 });
  });

  it("searches one domain by smoothed rate, then by trials", async () => {
    const lib = new FileExperienceLibrary(dir);
    await lib.publish(
      [
        gene("lucky", 1, 1), // 2/3
        gene("proven", 8, 10), // 9/12
        gene("proven-long", 16, 22), // 17/24 ~ 0.708 < 0.75
        gene("same-rate-more-trials", 17, 22), // 18/24 = 0.75, more trials than proven
        gene("rates-best", 10, 10, { domain: "rates" }),
      ],
      [],
    );
    expect(lib.search("arithmetic", 3).map((g) => g.id)).toEqual(["same-rate-more-trials", "proven", "proven-long"]);
    expect(lib.search("rates", 5).map((g) => g.id)).toEqual(["rates-best"]);
    expect(lib.search("logic", 5)).toEqual([]);
    expect(lib.search("arithmetic", 0)).toEqual([]);
    expect(lib.genes("rates")).toHaveLength(1);
  });

  it("returns copies, so callers cannot mutate the library", async () => {
    const lib = new FileExperienceLibrary(dir);
    await lib.publish([gene("g1", 1, 2)], [precedent("k", "s", 1)]);
    const [g] = lib.genes();
    if (g) g.evidence.wins = 99;
    const [p] = lib.precedents();
    if (p) p.state = "tampered";
    expect(lib.genes()[0]?.evidence.wins).toBe(1);
    expect(lib.precedents()[0]?.state).toBe("s");
  });

  it("dedupes precedents by key+state, keeping the newest verdict", async () => {
    const lib = new FileExperienceLibrary(dir);
    await lib.publish([], [precedent("verify", "same", 1, 0.2), precedent("adopt", "same", 2)]);
    await lib.publish([], [precedent("verify", "same", 3, 0.8), precedent("verify", "other", 4)]);
    expect(lib.precedents()).toEqual([precedent("adopt", "same", 2), precedent("verify", "same", 3, 0.8), precedent("verify", "other", 4)]);
  });

  it("caps precedents at the newest 500 and genes at the best 300 by evidence", async () => {
    const lib = new FileExperienceLibrary(dir);
    const ps = Array.from({ length: MAX_LIBRARY_PRECEDENTS + 20 }, (_, i) => precedent("k", `s${i}`, i));
    const gs = Array.from({ length: MAX_LIBRARY_GENES + 10 }, (_, i) => gene(`g${i}`, i, MAX_LIBRARY_GENES + 10));
    await lib.publish(gs, ps);
    expect(lib.stats()).toEqual({ genes: MAX_LIBRARY_GENES, precedents: MAX_LIBRARY_PRECEDENTS });
    expect(lib.precedents()[0]?.at).toBe(20);
    const ids = new Set(lib.genes().map((g) => g.id));
    for (let i = 0; i < 10; i++) expect(ids.has(`g${i}`)).toBe(false);
    expect(ids.has(`g${MAX_LIBRARY_GENES + 9}`)).toBe(true);

    const reloaded = new FileExperienceLibrary(dir);
    await expect(reloaded.load()).resolves.toEqual({ genes: MAX_LIBRARY_GENES, precedents: MAX_LIBRARY_PRECEDENTS });
  });

  it("skips malformed lines when loading", async () => {
    const good = gene("ok", 1, 2);
    const lines = [
      JSON.stringify(good),
      "{not json",
      JSON.stringify({ ...good, id: "bad-domain", domain: "cooking" as Domain }),
      JSON.stringify({ ...good, id: "bad-evidence", evidence: { wins: -1, trials: 2 } }),
      JSON.stringify({ ...good, id: "bad-source", source: "web" }),
      "",
      JSON.stringify([1, 2]),
    ];
    await writeFile(join(dir, "genes.jsonl"), `${lines.join("\n")}\n`);
    await writeFile(
      join(dir, "precedents.jsonl"),
      [
        JSON.stringify(precedent("verify", "fine", 1)),
        JSON.stringify({ key: "verify", state: "x", verdict: { type: "noul", noul: 7 }, at: 2 }),
        JSON.stringify({ key: "adopt", state: "y", verdict: { type: "choice", choice: "a", probabilities: { a: 0.9 }, confidence: 0.9 }, at: 3 }),
        JSON.stringify({ key: "dispute", state: "z", verdict: { type: "choice", choice: "a" }, at: 4 }),
        JSON.stringify({ key: "s", state: "w", verdict: { type: "score", score: 3, confidence: 0.5 }, at: 5 }),
      ].join("\n"),
    );
    const lib = new FileExperienceLibrary(dir);
    await expect(lib.load()).resolves.toEqual({ genes: 1, precedents: 3 });
    expect(lib.genes()[0]).toEqual(good);
    expect(lib.precedents().map((p) => p.at)).toEqual([1, 3, 5]);
  });

  it("writes atomically, leaving no temp files behind", async () => {
    const lib = new FileExperienceLibrary(dir);
    await Promise.all([lib.publish([gene("a", 1, 1)], []), lib.publish([gene("b", 1, 1)], [precedent("k", "s", 1)])]);
    expect((await readdir(dir)).sort()).toEqual(["genes.jsonl", "precedents.jsonl"]);
    expect(lib.stats()).toEqual({ genes: 2, precedents: 1 });
    const text = await readFile(join(dir, "genes.jsonl"), "utf8");
    expect(text.trim().split("\n")).toHaveLength(2);
  });

  it("reset deletes both files and clears memory", async () => {
    const lib = new FileExperienceLibrary(dir);
    await lib.publish([gene("a", 1, 1)], [precedent("k", "s", 1)]);
    await lib.reset();
    expect(lib.stats()).toEqual({ genes: 0, precedents: 0 });
    expect(await readdir(dir)).toEqual([]);
    await expect(new FileExperienceLibrary(dir).load()).resolves.toEqual({ genes: 0, precedents: 0 });
    await expect(lib.reset()).resolves.toBeUndefined();
  });
});
