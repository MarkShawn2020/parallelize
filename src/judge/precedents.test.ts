import { describe, expect, it } from "vitest";
import { MARK } from "../core/types";
import type { Answer, Precedent } from "../core/types";
import { formatPrecedents, MemoryPrecedentStore } from "./precedents";

const yes: Answer = { type: "noul", noul: 0.9 };
const p = (key: string, state: string, at: number, verdict: Answer = yes): Precedent => ({ key, state, verdict, at });

describe("MemoryPrecedentStore", () => {
  it("returns the newest k, oldest first, per key", () => {
    const store = new MemoryPrecedentStore();
    for (let i = 1; i <= 5; i++) store.add(p("verify", `s${i}`, i));
    store.add(p("claim", "c1", 6));
    expect(store.relevant("verify", 3).map((x) => x.state)).toEqual(["s3", "s4", "s5"]);
    expect(store.relevant("verify", 10)).toHaveLength(5);
    expect(store.relevant("verify", 0)).toEqual([]);
    expect(store.relevant("adopt", 3)).toEqual([]);
    expect(store.size("verify")).toBe(5);
    expect(store.size("claim")).toBe(1);
    expect(store.size()).toBe(6);
  });

  it("drops the oldest beyond maxPerKey", () => {
    const store = new MemoryPrecedentStore({ maxPerKey: 2 });
    for (let i = 1; i <= 4; i++) store.add(p("verify", `s${i}`, i));
    expect(store.size("verify")).toBe(2);
    expect(store.relevant("verify", 5).map((x) => x.at)).toEqual([3, 4]);
  });

  it("truncates long state keeping the head", () => {
    const store = new MemoryPrecedentStore({ maxStateChars: 10 });
    store.add(p("verify", "abcdefghijklmnop", 1));
    store.add(p("verify", "short", 2));
    const [long, short] = store.relevant("verify", 2);
    expect(long?.state).toBe("abcdefghi…");
    expect(long?.state).toHaveLength(10);
    expect(short?.state).toBe("short");
  });
});

describe("formatPrecedents", () => {
  it("is empty for no precedents", () => {
    expect(formatPrecedents([])).toBe("");
  });

  it("emits the marker line then one '- ' line per precedent", () => {
    const out = formatPrecedents([
      p("verify", "DOMAIN: logic\nANSWER: 42", 1, { type: "noul", noul: 0.12 }),
      p("claim", "pick\n\n one", 2, { type: "choice", choice: "t2", probabilities: { t2: 0.8 }, confidence: 0.8 }),
    ]);
    const lines = out.split("\n");
    expect(lines[0]).toBe(MARK.precedents);
    expect(lines.slice(1)).toEqual([
      "- [verify] DOMAIN: logic ANSWER: 42 => no 0.12",
      "- [claim] pick one => t2 0.80",
    ]);
  });
});
