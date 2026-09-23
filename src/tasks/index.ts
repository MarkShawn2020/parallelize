import type { LLM, TaskSource, TaskSourceConfig } from "../core/types";
import { Gsm8kTaskSource } from "./gsm8k";
import { ResearchTaskSource } from "./research";
import { SyntheticTaskSource } from "./synthetic";

export { checkAnswer, extractFinalAnswer, normalizeAnswer } from "./check";
export { Gsm8kTaskSource } from "./gsm8k";
export {
  RESEARCH_VERDICTS,
  ResearchTaskSource,
  extractVerdict,
  isCanaryTask,
  normalizeResearchAnswer,
  normalizeVerdict,
} from "./research";
export { SyntheticTaskSource } from "./synthetic";

/** `planner` is required for research sources: an LLM decomposes the idea into claims. */
export function createTaskSource(cfg: TaskSourceConfig, planner?: { llm: LLM; runId: string }): TaskSource {
  switch (cfg.kind) {
    case "synthetic":
      return new SyntheticTaskSource({ difficulty: cfg.difficulty });
    case "gsm8k":
      return new Gsm8kTaskSource(cfg.path);
    case "research":
      if (planner === undefined) throw new Error("research tasks need a planner: createTaskSource(cfg, { llm, runId })");
      return new ResearchTaskSource({ ...planner, idea: cfg.idea, claims: cfg.claims, canaries: cfg.canaries });
  }
}
