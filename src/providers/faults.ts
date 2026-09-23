import type { Judge, JudgeRequest, JudgeResult, LLM, LLMRequest, LLMResult, Tier } from "../core/types";
import { ProviderError } from "./http";

/** Demo fault switch. Flipping it takes effect on the next call; in-flight calls finish normally. */
export class FaultSwitch {
  down = false;
  readonly name: string;

  constructor(name: "jev" | "llm") {
    this.name = name;
  }

  set(down: boolean): void {
    this.down = down;
  }
}

// Fail before touching the network: a real outage that hangs would make every judgment wait for an
// HTTP timeout on stage, while an instant 503 lets the caller degrade to its fallback right away.
function offline(sw: FaultSwitch): ProviderError {
  return new ProviderError(`${sw.name} offline (fault injected)`, { status: 503 });
}

class FaultJudge implements Judge {
  readonly id: string;
  readonly tier: Tier;
  readonly simulated: boolean;

  constructor(
    private readonly inner: Judge,
    private readonly sw: FaultSwitch,
  ) {
    this.id = inner.id;
    this.tier = inner.tier;
    this.simulated = inner.simulated;
  }

  ask(req: JudgeRequest): Promise<JudgeResult> {
    return this.sw.down ? Promise.reject(offline(this.sw)) : this.inner.ask(req);
  }
}

class FaultLLM implements LLM {
  readonly id: string;
  readonly simulated: boolean;

  constructor(
    private readonly inner: LLM,
    private readonly sw: FaultSwitch,
  ) {
    this.id = inner.id;
    this.simulated = inner.simulated;
  }

  complete(req: LLMRequest): Promise<LLMResult> {
    return this.sw.down ? Promise.reject(offline(this.sw)) : this.inner.complete(req);
  }
}

export function withFaultJudge(judge: Judge, sw: FaultSwitch): Judge {
  return new FaultJudge(judge, sw);
}

export function withFaultLLM(llm: LLM, sw: FaultSwitch): LLM {
  return new FaultLLM(llm, sw);
}
