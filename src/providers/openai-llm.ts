import type { LLM, LLMRequest, LLMResult, Usage } from "../core/types";
import { ProviderError, isNum, isObject, postJson, snippet } from "./http";
import type { Semaphore } from "./limiter";

export interface OpenAICompatLLMOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  retries?: number;
  limiter?: Semaphore;
  /**
   * OpenRouter's reasoning switch. "off" makes open-weight reasoning models answer directly (fast, error-prone);
   * "low" keeps a short reasoning pass, which needs a larger max_tokens or the answer gets truncated.
   */
  reasoning?: "default" | "off" | "low";
}

/** Reasoning tokens count against max_tokens; below this a low-effort pass often never reaches the answer. */
const LOW_REASONING_MIN_TOKENS = 1500;

export class OpenAICompatLLM implements LLM {
  readonly id: string;
  readonly simulated = false;
  readonly #opts: OpenAICompatLLMOptions;

  constructor(opts: OpenAICompatLLMOptions) {
    this.#opts = opts;
    this.id = `llm:${opts.model}`;
  }

  async complete(req: LLMRequest): Promise<LLMResult> {
    const reasoning = this.#opts.reasoning ?? "default";
    const maxTokens = req.maxTokens ?? 1024;
    const body = {
      model: this.#opts.model,
      messages: req.messages,
      max_tokens: reasoning === "low" ? Math.max(maxTokens, LOW_REASONING_MIN_TOKENS) : maxTokens,
      temperature: req.temperature ?? 0,
      ...(req.json ? { response_format: { type: "json_object" } } : {}),
      ...(reasoning === "off" ? { reasoning: { enabled: false } } : reasoning === "low" ? { reasoning: { effort: "low" } } : {}),
      usage: { include: true },
    };
    const call = async () => {
      const started = performance.now();
      const raw = await postJson(`${this.#opts.baseUrl.replace(/\/+$/, "")}/chat/completions`, body, {
        headers: {
          Authorization: `Bearer ${this.#opts.apiKey}`,
          "Content-Type": "application/json",
          "X-Title": "jis",
        },
        timeoutMs: this.#opts.timeoutMs ?? 180_000,
        retries: this.#opts.retries ?? 2,
      });
      return { raw, latencyMs: performance.now() - started };
    };
    const { raw, latencyMs } = this.#opts.limiter ? await this.#opts.limiter.run(call) : await call();
    return { ...parseChatResponse(raw, this.#opts.model), latencyMs };
  }
}

export function parseChatResponse(raw: unknown, fallbackModel: string): Omit<LLMResult, "latencyMs"> {
  if (!isObject(raw)) throw unusable(raw, "response is not an object");
  const choice = Array.isArray(raw.choices) ? raw.choices[0] : undefined;
  const message = isObject(choice) && isObject(choice.message) ? choice.message : undefined;
  const text = message ? contentText(message.content) : undefined;
  if (text === undefined || text === "") {
    // OpenRouter reports some upstream failures as HTTP 200 with an error object instead of choices.
    const upstream = isObject(raw.error) && typeof raw.error.message === "string" ? `: ${raw.error.message}` : "";
    const finish = isObject(choice) && typeof choice.finish_reason === "string" ? ` (finish_reason ${choice.finish_reason})` : "";
    throw unusable(raw, `no message content${finish}${upstream}`);
  }
  return {
    text,
    usage: parseUsage(raw.usage, fallbackModel),
    model: typeof raw.model === "string" && raw.model !== "" ? raw.model : fallbackModel,
  };
}

/** USD per million tokens [input, output], list prices on 2026-09-23. */
const LIST_PRICES: Record<string, [number, number]> = {
  "anthropic/claude-haiku-4.5": [1, 5],
  "deepseek/deepseek-v4.1-flash": [0.1, 0.5],
  "openai/gpt-6-luna": [0.1, 0.5],
  "qwen/qwen3.8-flash": [0.15, 0.47],
};

/**
 * Gateways other than OpenRouter (e.g. ZenMux) may omit usage.cost; without an estimate the ledger would
 * read $0 and the run's cost cap would never trip. Unknown models are priced like Haiku to stay conservative.
 */
export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const [inPrice, outPrice] = LIST_PRICES[model] ?? [1, 5];
  return (inputTokens * inPrice + outputTokens * outPrice) / 1e6;
}

function contentText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content
    .map((part) => (typeof part === "string" ? part : isObject(part) && typeof part.text === "string" ? part.text : ""))
    .join("");
}

function parseUsage(u: unknown, model: string): Usage {
  const usage = isObject(u) ? u : {};
  const inputTokens = isNum(usage.prompt_tokens) ? usage.prompt_tokens : 0;
  const outputTokens = isNum(usage.completion_tokens) ? usage.completion_tokens : 0;
  return {
    inputTokens,
    outputTokens,
    costUsd: isNum(usage.cost) ? usage.cost : estimateCostUsd(model, inputTokens, outputTokens),
  };
}

function unusable(raw: unknown, why: string): ProviderError {
  return new ProviderError(`chat completion unusable: ${why}`, { bodySnippet: snippet(raw) });
}
