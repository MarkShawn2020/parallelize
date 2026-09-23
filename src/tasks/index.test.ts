import { describe, expect, it } from "vitest";
import type { LLM } from "../core/types";
import { Gsm8kTaskSource, ResearchTaskSource, SyntheticTaskSource, createTaskSource } from "./index";

describe("createTaskSource", () => {
  it("builds the source named by the config", () => {
    expect(createTaskSource({ kind: "synthetic" })).toBeInstanceOf(SyntheticTaskSource);
    expect(createTaskSource({ kind: "synthetic" })).toMatchObject({ difficulty: "normal" });
    expect(createTaskSource({ kind: "synthetic", difficulty: "hard" })).toMatchObject({ difficulty: "hard" });
    expect(createTaskSource({ kind: "gsm8k", path: "data/gsm8k.jsonl" })).toBeInstanceOf(Gsm8kTaskSource);
  });

  it("builds a research source only when given a planner", () => {
    const cfg = { kind: "research", idea: "A pet vet app", claims: 4, canaries: 2 } as const;
    const llm: LLM = { id: "fake", simulated: true, complete: async () => Promise.reject(new Error("unused")) };
    expect(createTaskSource(cfg, { llm, runId: "r" })).toBeInstanceOf(ResearchTaskSource);
    expect(() => createTaskSource(cfg)).toThrow(/planner/);
  });
});
