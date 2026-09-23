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
}

export class OpenAICompatLLM implements LLM {
  readonly id: string;
  readonly simulated = false;
  readonly #opts: OpenAICompatLLMOptions;

  constructor(opts: OpenAICompatLLMOptions) {
    this.#opts = opts;
    this.id = `llm:${opts.model}`;
  }

  async complete(req: LLMRequest): Promise<LLMResult> {
    const body = {
      model: this.#opts.model,
      messages: req.messages,
      max_tokens: req.maxTokens ?? 1024,
      temperature: req.temperature ?? 0,
      ...(req.json ? { response_format: { type: "json_object" } } : {}),
      usage: { include: true },
    };
    const call = async () => {
      const started = performance.now();
      const raw = await postJson(`${this.#opts.baseUrl.replace(/\/+$/, "")}/chat/completions`, body, {
        headers: {
          Authorization: `Bearer ${this.#opts.apiKey}`,
          "Content-Type": "application/json",
          "X-Title": "parallelize",
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
    usage: parseUsage(raw.usage),
    model: typeof raw.model === "string" && raw.model !== "" ? raw.model : fallbackModel,
  };
}

function contentText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content
    .map((part) => (typeof part === "string" ? part : isObject(part) && typeof part.text === "string" ? part.text : ""))
    .join("");
}

function parseUsage(u: unknown): Usage {
  const usage = isObject(u) ? u : {};
  return {
    inputTokens: isNum(usage.prompt_tokens) ? usage.prompt_tokens : 0,
    outputTokens: isNum(usage.completion_tokens) ? usage.completion_tokens : 0,
    costUsd: isNum(usage.cost) ? usage.cost : 0,
  };
}

function unusable(raw: unknown, why: string): ProviderError {
  return new ProviderError(`chat completion unusable: ${why}`, { bodySnippet: snippet(raw) });
}
