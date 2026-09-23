import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Gsm8kTaskSource, parseGsm8k } from "./gsm8k";

const FIXTURE = fileURLToPath(new URL("../../test/fixtures/gsm8k-sample.jsonl", import.meta.url));
const line = (question: unknown, answer: unknown) => JSON.stringify({ question, answer });

describe("parseGsm8k", () => {
  it("keeps valid rows with the original line index as id", () => {
    const text = [line("Q zero?", "work\n#### 5"), "", line("Q two?", "#### -3.50")].join("\n");
    expect(parseGsm8k(text)).toEqual([
      { id: "g0000", domain: "gsm8k", prompt: "Q zero?", answer: "5" },
      { id: "g0002", domain: "gsm8k", prompt: "Q two?", answer: "-3.5" },
    ]);
  });

  it.each([
    ["invalid JSON", '{"question": "Q?", "answer": '],
    ["non-object JSON", "42"],
    ["missing question", JSON.stringify({ answer: "#### 1" })],
    ["blank question", line("   ", "#### 1")],
    ["non-string answer", line("Q?", 7)],
    ["missing final marker", line("Q?", "The answer is 7.")],
    ["non-numeric final answer", line("Q?", "#### seven")],
  ])("skips a line with %s", (_, bad) => {
    expect(parseGsm8k([bad, line("Q?", "#### 1")].join("\n")).map((t) => t.id)).toEqual(["g0001"]);
  });

  it("handles CRLF line endings and trailing newlines", () => {
    expect(parseGsm8k(`${line("Q?", "#### 12\n")}\r\n${line("R?", "#### 4")}\r\n`)).toHaveLength(2);
  });
});

describe("Gsm8kTaskSource", () => {
  const source = new Gsm8kTaskSource(FIXTURE);

  it("loads every valid fixture line in file order, skipping the malformed one", async () => {
    const tasks = await source.load(5, 1);
    expect(tasks.map((t) => t.id)).toEqual(["g0000", "g0001", "g0003", "g0004", "g0005"]);
    expect(tasks.map((t) => t.answer)).toEqual(["29", "1250", "2", "9", "17"]);
    expect(tasks.every((t) => t.domain === "gsm8k" && !t.prompt.includes("####"))).toBe(true);
  });

  it("selects a deterministic, file-ordered subset per seed", async () => {
    const a = await source.load(3, 42);
    expect(await source.load(3, 42)).toEqual(a);
    expect(a).toHaveLength(3);
    const ids = a.map((t) => t.id);
    expect(ids).toEqual([...ids].sort());
    const subsets = new Set<string>();
    for (let seed = 0; seed < 10; seed++) subsets.add((await source.load(3, seed)).map((t) => t.id).join());
    expect(subsets.size).toBeGreaterThan(1);
  });

  it("throws a clear error when there are too few valid tasks", async () => {
    await expect(source.load(6, 1)).rejects.toThrow(/need 6 tasks .* only 5 valid lines/);
  });
});
