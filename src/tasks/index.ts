import type { TaskSource, TaskSourceConfig } from "../core/types";
import { Gsm8kTaskSource } from "./gsm8k";
import { SyntheticTaskSource } from "./synthetic";

export { checkAnswer, extractFinalAnswer, normalizeAnswer } from "./check";
export { Gsm8kTaskSource } from "./gsm8k";
export { SyntheticTaskSource } from "./synthetic";

export function createTaskSource(cfg: TaskSourceConfig): TaskSource {
  switch (cfg.kind) {
    case "synthetic":
      return new SyntheticTaskSource();
    case "gsm8k":
      return new Gsm8kTaskSource(cfg.path);
  }
}
