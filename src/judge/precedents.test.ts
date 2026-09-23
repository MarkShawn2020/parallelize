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

  it("keeps proposals invisible until confirmed", () => {
    const store = new MemoryPrecedentStore();
    const id = store.propose(p("verify", "s1", 1));
    expect(id).toBe("p1");
    expect(store.relevant("verify", 5)).toEqual([]);
    expect(store.size()).toBe(0);
    expect(store.all()).toEqual([]);
    expect(store.pendingSize()).toBe(1);

    store.confirm(id);
    expect(store.relevant("verify", 5).map((x) => x.state)).toEqual(["s1"]);
    expect(store.size("verify")).toBe(1);
    expect(store.pendingSize()).toBe(0);
    store.confirm(id);
    expect(store.size()).toBe(1);
  });

  it("never shows rejected proposals, even if confirmed later", () => {
    const store = new MemoryPrecedentStore();
    const id = store.propose(p("verify", "wrong", 1));
    store.reject(id);
    store.confirm(id);
    expect(store.size()).toBe(0);
    expect(store.pendingSize()).toBe(0);
  });

  it("issues distinct ids and truncates proposed state", () => {
    const store = new MemoryPrecedentStore({ maxStateChars: 5 });
    const a = store.propose(p("verify", "abcdefgh", 1));
    const b = store.propose(p("adopt", "x", 2));
    expect(a).not.toBe(b);
    store.confirm(a);
    expect(store.relevant("verify", 1)[0]?.state).toBe("abcd…");
  });

  it("caps pending proposals, dropping the oldest", () => {
    const store = new MemoryPrecedentStore({ maxPending: 2 });
    const ids = [1, 2, 3].map((i) => store.propose(p("verify", `s${i}`, i)));
    expect(store.pendingSize()).toBe(2);
    for (const id of ids) store.confirm(id);
    expect(store.all().map((x) => x.state)).toEqual(["s2", "s3"]);
  });

  it("defaults the pending cap to 200", () => {
    const store = new MemoryPrecedentStore();
    for (let i = 0; i < 250; i++) store.propose(p("verify", `s${i}`, i));
    expect(store.pendingSize()).toBe(200);
  });

  it("lists confirmed precedents across keys, oldest first", () => {
    const store = new MemoryPrecedentStore();
    store.add(p("verify", "v5", 5));
    const pending = store.propose(p("adopt", "a2", 2));
    store.add(p("claim", "c1", 1));
    store.add(p("verify", "v5b", 5));
    store.propose(p("adopt", "never", 0));
    store.confirm(pending);
    expect(store.all().map((x) => x.state)).toEqual(["c1", "a2", "v5", "v5b"]);
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
