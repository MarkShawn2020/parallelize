import { describe, expect, it } from "vitest";
import { checkAnswer, extractFinalAnswer, normalizeAnswer } from "./check";

describe("normalizeAnswer", () => {
  it.each([
    ["  42  ", "42"],
    ["**42**", "42"],
    ["`42`", "42"],
    ['"42"', "42"],
    ["\\boxed{42}", "42"],
    ["$1,200", "1200"],
    ["$1,234,567.50", "1234567.5"],
    ["49.0", "49"],
    ["-3", "-3"],
    ["−3", "-3"],
    ["+7", "7"],
    ["-0", "0"],
    ["42.", "42"],
    ["3.14159", "3.1416"],
    ["2.50", "2.5"],
    ["0.00001", "0"],
    ["18 dollars", "18"],
    ["18 dollars.", "18"],
    ["75%", "75"],
    ["12 km/h", "12"],
    ["1/4", "0.25"],
    ["2 / 3", "0.6667"],
    ["3/4 cup", "0.75"],
    ["1/0", "1/0"],
    ["Tuesday", "tuesday"],
    ["  Hello   World. ", "hello world"],
    ["5 hours and 30 minutes", "5 hours and 30 minutes"],
    ["", ""],
  ])("%j -> %j", (input, expected) => {
    expect(normalizeAnswer(input)).toBe(expected);
  });
});

describe("extractFinalAnswer", () => {
  it("reads the value after the answer marker in multi-line output", () => {
    const text = ["Packs cost 3 * 4 = 12.", "Change is 20 - 12 = 8.", "METHOD: total then subtract", "ANSWER: 8"].join("\n");
    expect(extractFinalAnswer(text)).toBe("8");
  });

  it("uses the last answer line when the model revises itself", () => {
    expect(extractFinalAnswer("ANSWER: 10\nWait, I forgot the discount.\nANSWER: 7\nDone.")).toBe("7");
  });

  it("strips markdown, currency and separators around the marked value", () => {
    expect(extractFinalAnswer("**ANSWER:** $1,200.")).toBe("1200");
  });

  it("matches the marker case-insensitively", () => {
    expect(extractFinalAnswer("so the final Answer: 7 apples")).toBe("7");
  });

  it("takes the next non-empty line when the marker line has no value", () => {
    expect(extractFinalAnswer("ANSWER:\n\n**42**")).toBe("42");
  });

  it.each([
    ["ANSWER: 42 (6 x 7)", "42"],
    ["ANSWER: x = 42", "42"],
    ["ANSWER: 3 + 4 = 7", "7"],
    ["ANSWER: The total is 42 dollars and change", "42"],
  ])("recovers the settled number from a decorated value: %j", (text, expected) => {
    expect(extractFinalAnswer(text)).toBe(expected);
  });

  it("keeps a text answer after the marker", () => {
    expect(extractFinalAnswer("ANSWER: Tuesday")).toBe("tuesday");
  });

  it("falls back to the last number in the text", () => {
    expect(extractFinalAnswer("First 12, then 30,\nso the crowd was 1,250 people.")).toBe("1250");
    expect(extractFinalAnswer("The balance ends at -5.")).toBe("-5");
    expect(extractFinalAnswer("It rises to 2.50 overall.")).toBe("2.5");
  });

  it("returns an empty string when there is no answer at all", () => {
    expect(extractFinalAnswer("I am not sure.")).toBe("");
    expect(extractFinalAnswer("")).toBe("");
  });
});

describe("checkAnswer", () => {
  it.each([
    ["42", "42.0", true],
    ["1200", "$1,200", true],
    ["0.5", "1/2", true],
    ["18", "18 dollars", true],
    ["3", "3.0000001", true],
    ["0", "-0", true],
    ["Tuesday", " tuesday. ", true],
    ["42", "43", false],
    ["12", "twelve", false],
    ["12", "", false],
    ["0", "0.001", false],
  ])("checkAnswer(%j, %j) -> %s", (expected, got, result) => {
    expect(checkAnswer(expected, got)).toBe(result);
  });

  it("uses a relative tolerance for large numbers", () => {
    expect(checkAnswer("1000000", "1000000.5")).toBe(true);
    expect(checkAnswer("1000", "1000.5")).toBe(false);
  });
});
