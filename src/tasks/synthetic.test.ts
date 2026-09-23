import { describe, expect, it } from "vitest";
import { SYNTHETIC_DOMAINS, SyntheticTaskSource, TEMPLATES, createRng, leaksAnswer } from "./synthetic";

const source = new SyntheticTaskSource();

function standaloneNumbers(prompt: string): string[] {
  return (prompt.match(/\d+(?:,\d{3})*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, ""));
}

describe("SyntheticTaskSource", () => {
  it("is deterministic for the same (n, seed)", async () => {
    expect(await source.load(30, 7)).toEqual(await source.load(30, 7));
  });

  it("produces different tasks for different seeds", async () => {
    const [a, b] = await Promise.all([source.load(12, 1), source.load(12, 2)]);
    expect(a.map((t) => t.prompt)).not.toEqual(b.map((t) => t.prompt));
  });

  it("keeps load(k) a prefix of load(n)", async () => {
    const long = await source.load(60, 42);
    for (const k of [0, 1, 7, 33]) expect(await source.load(k, 42)).toEqual(long.slice(0, k));
  });

  it("numbers ids from t001 and grows past t999", async () => {
    const tasks = await source.load(1001, 3);
    expect(tasks[0]?.id).toBe("t001");
    expect(tasks[41]?.id).toBe("t042");
    expect(tasks[998]?.id).toBe("t999");
    expect(tasks[1000]?.id).toBe("t1001");
    expect(new Set(tasks.map((t) => t.id)).size).toBe(1001);
  });

  it("rotates domains arithmetic, rates, logic", async () => {
    const tasks = await source.load(9, 5);
    expect(tasks.map((t) => t.domain)).toEqual([...SYNTHETIC_DOMAINS, ...SYNTHETIC_DOMAINS, ...SYNTHETIC_DOMAINS]);
  });

  it("gives positive integer answers that never appear as a number in the prompt", async () => {
    for (const seed of [0, 1, 99, 2026]) {
      for (const task of await source.load(300, seed)) {
        expect(task.answer).toMatch(/^[1-9]\d*$/);
        expect(task.prompt).not.toMatch(new RegExp(`=\\s*\\$?${task.answer}(?!\\d)`));
        expect(standaloneNumbers(task.prompt)).not.toContain(task.answer);
        expect(task.prompt.endsWith("?") || task.prompt.endsWith("number.")).toBe(true);
      }
    }
  });

  it("rejects an invalid task count", async () => {
    await expect(source.load(-1, 1)).rejects.toThrow(RangeError);
    await expect(source.load(2.5, 1)).rejects.toThrow(RangeError);
  });
});

describe("templates", () => {
  it("has at least five templates per domain", () => {
    for (const domain of SYNTHETIC_DOMAINS) expect(TEMPLATES[domain].length).toBeGreaterThanOrEqual(5);
  });

  it("computes a positive integer answer from every template and leaves no placeholders", () => {
    for (const domain of SYNTHETIC_DOMAINS) {
      TEMPLATES[domain].forEach((template, i) => {
        for (let seed = 0; seed < 400; seed++) {
          const { prompt, answer } = template(createRng(seed * 31 + i));
          expect(Number.isSafeInteger(answer) && answer > 0, `${domain}#${i} seed ${seed}: ${answer}`).toBe(true);
          expect(prompt).not.toMatch(/undefined|NaN|\[object/);
        }
      });
    }
  });

  it("varies its wording within a template", () => {
    for (const domain of SYNTHETIC_DOMAINS) {
      TEMPLATES[domain].forEach((template) => {
        const prompts = new Set(Array.from({ length: 20 }, (_, s) => template(createRng(s)).prompt));
        expect(prompts.size).toBeGreaterThan(15);
      });
    }
  });
});

describe("leaksAnswer", () => {
  it("flags the answer as a standalone number only", () => {
    expect(leaksAnswer("pays $42 in total", 42)).toBe(true);
    expect(leaksAnswer("after 42.", 42)).toBe(true);
    expect(leaksAnswer("costs 142 or 420 or 4.2 or 1,420", 42)).toBe(false);
  });
});

describe("hand-checked template answers", () => {
  // Pins a few seeds whose prompts were solved by hand, so a template edit that breaks the math is caught.
  it.each([
    ["arithmetic", 0, 1000, 23],
    ["rates", 1, 1001, 10],
    ["logic", 4, 1004, 18],
    ["logic", 6, 1006, 798],
  ] as const)("%s template #%i at seed %i answers %i", (domain, index, seed, expected) => {
    expect(TEMPLATES[domain][index]!(createRng(seed)).answer).toBe(expected);
  });
});
