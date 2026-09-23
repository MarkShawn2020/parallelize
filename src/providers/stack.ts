import { providerEnv } from "../config";
import type { ProviderEndpoint } from "../config";
import { meterJudge, meterLLM } from "../core/ledger";
import type { MeterOptions } from "../core/ledger";
import { hashString } from "../core/rng";
import type { Decision, Judge, Ledger, LLM, RunConfig, Task } from "../core/types";
import { conservativeAnswer } from "../judge/dispute";
import { EscalatingJudge } from "../judge/escalating";
import { LLMJudge } from "../judge/llm-judge";
import { ObservedJudge } from "../judge/observed";
import { MemoryPrecedentStore } from "../judge/precedents";
import { FaultSwitch, withFaultJudge, withFaultLLM } from "./faults";
import { JevJudge } from "./jev";
import { Semaphore } from "./limiter";
import { MockJudge, MockLLM, MockOracle } from "./mock";
import { OpenAICompatLLM } from "./openai-llm";

// Precedents are appended to every System-1 state, so they must stay short or System 1 stops being cheap.
const PRECEDENT_STATE_CHARS = 120;
const PRECEDENTS_PER_KEY = 3;

export interface ProviderStackOptions {
  config: RunConfig;
  ledger: Ledger;
  meter: Omit<MeterOptions, "provider">;
  /** Overrides the latency range of every simulated provider (tests use [0, 0]). */
  mockLatencyMs?: [number, number];
  env?: { llm: ProviderEndpoint; jev: ProviderEndpoint };
}

export interface JudgeHooks {
  onDecision: (d: Decision) => void;
  onGuard: (key: string, disagreement: number) => void;
}

function requireKey(key: string | undefined, names: string): string {
  if (!key) throw new Error(`${names} is not set; add it to .env or use the mock provider`);
  return key;
}

/**
 * Builds every provider a run uses. Fault switches sit innermost (right around the raw provider) so the
 * meter never bills a refused call and the escalating judge sees the failure and degrades.
 */
export class ProviderStack {
  readonly switches = { jev: new FaultSwitch("jev"), llm: new FaultSwitch("llm") };
  /** Shared by the judge, the swarm (outcome routing) and the experience library. */
  readonly precedents = new MemoryPrecedentStore({ maxStateChars: PRECEDENT_STATE_CHARS });
  readonly defaultModel: string;
  readonly simulated: boolean;
  private readonly config: RunConfig;
  private readonly ledger: Ledger;
  private readonly meter: Omit<MeterOptions, "provider">;
  private readonly latency: { latencyMs?: [number, number] };
  private readonly env: { llm: ProviderEndpoint; jev: ProviderEndpoint };
  private readonly mockLLM: boolean;
  private readonly mockJudge: boolean;
  // One limiter for every LLM, so llmConcurrency caps the run however many models the cells use.
  private readonly limiter: Semaphore;
  private readonly llms = new Map<string, LLM>();
  private oracle = new MockOracle([]);

  constructor(opts: ProviderStackOptions) {
    const { config } = opts;
    this.config = config;
    this.ledger = opts.ledger;
    this.meter = opts.meter;
    this.latency = opts.mockLatencyMs ? { latencyMs: opts.mockLatencyMs } : {};
    this.env = opts.env ?? providerEnv();
    this.mockLLM = config.llm === "mock";
    this.mockJudge = config.judge === "mock";
    const usesJev = config.mode === "swarm-jev";
    this.simulated = this.mockLLM || (usesJev && this.mockJudge);
    this.defaultModel = this.env.llm.model;
    this.limiter = new Semaphore(config.llmConcurrency);
    // Checked up front so a missing key fails the start request instead of the first cell call.
    if (!this.mockLLM) requireKey(this.env.llm.apiKey, "LLM_API_KEY or OPENROUTER_API_KEY");
    if (usesJev && !this.mockJudge) requireKey(this.env.jev.apiKey, "JEV_API_KEY or OPENROUTER_API_KEY");
  }

  /** The default LLM before the tasks exist (research planning); the simulated planner needs no oracle. */
  planner(): LLM {
    return this.wrap(this.raw(this.defaultModel, new MockOracle([])));
  }

  /** Simulated providers read ground truth through the oracle, so call this once the tasks are loaded. */
  useTasks(tasks: Task[]): void {
    this.oracle = new MockOracle(tasks);
    this.llms.clear();
  }

  /** Metered LLM for a model (default: the configured one), one instance per model. */
  llm(model: string = this.defaultModel): LLM {
    let llm = this.llms.get(model);
    if (!llm) {
      llm = this.wrap(this.raw(model, this.oracle));
      this.llms.set(model, llm);
    }
    return llm;
  }

  /** LLM for tasks outside the run (holdout gate); a simulated one needs those tasks in its oracle. */
  holdoutLLM(tasks: Task[]): LLM {
    if (!this.mockLLM) return this.llm();
    return this.wrap(new MockLLM({ oracle: new MockOracle(tasks), seed: hashString(`${this.config.seed}|holdout`), ...this.latency }));
  }

  /** swarm-jev: Jev (System 1) escalating to System 2. swarm-llm: System 2 only. Other modes: no judge. */
  judge(hooks: JudgeHooks): Judge | undefined {
    const { config, ledger, meter } = this;
    switch (config.mode) {
      case "swarm-llm":
        return new ObservedJudge(this.system2(), { onDecision: hooks.onDecision, fallback: conservativeAnswer });
      case "swarm-jev": {
        const rawS1: Judge = this.mockJudge
          ? new MockJudge({ tier: "system1", seed: config.seed, oracle: this.oracle, ...this.latency })
          : new JevJudge({
              baseUrl: this.env.jev.baseUrl,
              apiKey: requireKey(this.env.jev.apiKey, "JEV_API_KEY or OPENROUTER_API_KEY"),
              model: this.env.jev.model,
              limiter: new Semaphore(config.judgeConcurrency),
            });
        return new EscalatingJudge({
          s1: meterJudge(withFaultJudge(rawS1, this.switches.jev), ledger, { ...meter, provider: this.mockJudge ? "mock-judge" : "jev" }),
          s2: this.system2(),
          threshold: config.escalationThreshold,
          precedents: this.precedents,
          precedentsPerKey: PRECEDENTS_PER_KEY,
          guard: { window: config.guardWindow, maxDisagreement: config.guardMaxDisagreement, onGuard: hooks.onGuard },
          fallback: conservativeAnswer,
          onDecision: hooks.onDecision,
        });
      }
      default:
        return undefined;
    }
  }

  private system2(): Judge {
    if (!this.mockLLM) return new LLMJudge({ llm: this.llm() });
    // LLMJudge calls go through the metered LLM; only the simulated System 2 needs its own meter and fault switch.
    const s2 = new MockJudge({ tier: "system2", seed: this.config.seed, oracle: this.oracle, ...this.latency });
    return meterJudge(withFaultJudge(s2, this.switches.llm), this.ledger, { ...this.meter, provider: "mock-judge" });
  }

  private raw(model: string, oracle: MockOracle): LLM {
    if (this.mockLLM) {
      // Each simulated model draws its own numbers; a shared seed would make "different models" err in lockstep.
      const seed = model === this.defaultModel ? this.config.seed : hashString(`${this.config.seed}|${model}`);
      return new MockLLM({ oracle, seed, ...this.latency });
    }
    return new OpenAICompatLLM({
      baseUrl: this.env.llm.baseUrl,
      apiKey: requireKey(this.env.llm.apiKey, "LLM_API_KEY or OPENROUTER_API_KEY"),
      model,
      limiter: this.limiter,
    });
  }

  private wrap(raw: LLM): LLM {
    return meterLLM(withFaultLLM(raw, this.switches.llm), this.ledger, { ...this.meter, provider: this.mockLLM ? "mock-llm" : "llm" });
  }
}
