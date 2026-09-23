import { describe, expect, it } from "vitest";
import { Gsm8kTaskSource, SyntheticTaskSource, createTaskSource } from "./index";

describe("createTaskSource", () => {
  it("builds the source named by the config", () => {
    expect(createTaskSource({ kind: "synthetic" })).toBeInstanceOf(SyntheticTaskSource);
    expect(createTaskSource({ kind: "gsm8k", path: "data/gsm8k.jsonl" })).toBeInstanceOf(Gsm8kTaskSource);
  });
});
