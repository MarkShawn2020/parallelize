import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { LLMRequest } from "../core/types";
import { ProviderError } from "./http";
import { OpenAICompatLLM, estimateCostUsd, parseChatResponse } from "./openai-llm";

const fixture = JSON.parse(
  readFileSync(new URL("../../test/fixtures/openrouter-chat-response.json", import.meta.url), "utf8"),
) as unknown;

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.map((c) => c()));
  cleanup = [];
});

async function server(body: unknown, status = 200) {
  const requests: Array<{ url: string; headers: IncomingHttpHeaders; body: string }> = [];
  const s = createServer((req, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      requests.push({ url: req.url ?? "", headers: req.headers, body: raw });
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        s.closeAllConnections();
        s.close(() => resolve());
      }),
  );
  return { baseUrl: `http://127.0.0.1:${(s.address() as AddressInfo).port}/api/v1`, requests };
}

const KEY = "sk-or-test-key";
const req = (extra: Partial<LLMRequest> = {}): LLMRequest => ({
  messages: [
    { role: "system", content: "Solve." },
    { role: "user", content: "100 - 17*3 = ?" },
  ],
  meta: { runId: "r1", purpose: "solve", taskId: "t1" },
  ...extra,
});
const llm = (baseUrl: string) => new OpenAICompatLLM({ baseUrl, apiKey: KEY, model: "anthropic/claude-haiku-4.5", retries: 0 });

describe("OpenAICompatLLM", () => {
  it("posts a chat completion and parses the recorded response", async () => {
    const s = await server(fixture);
    const model = llm(s.baseUrl);
    expect(model.id).toBe("llm:anthropic/claude-haiku-4.5");
    expect(model.simulated).toBe(false);

    const r = await model.complete(req());
    expect(r.text).toBe("METHOD: 17*3=51, 100-51=49\nANSWER: 49");
    expect(r.usage).toEqual({ inputTokens: 48, outputTokens: 5, costUsd: 0.000073 });
    expect(r.model).toBe("anthropic/claude-haiku-4.5");
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);

    const sent = s.requests[0];
    expect(sent?.url).toBe("/api/v1/chat/completions");
    expect(sent?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(sent?.headers["x-title"]).toBe("jis");
    expect(JSON.parse(sent?.body ?? "")).toEqual({
      model: "anthropic/claude-haiku-4.5",
      messages: req().messages,
      max_tokens: 1024,
      temperature: 0,
      usage: { include: true },
    });
  });

  it("requests JSON mode and honours maxTokens and temperature", async () => {
    const s = await server(fixture);
    await llm(s.baseUrl).complete(req({ json: true, maxTokens: 64, temperature: 0.7 }));
    expect(JSON.parse(s.requests[0]?.body ?? "")).toMatchObject({
      max_tokens: 64,
      temperature: 0.7,
      response_format: { type: "json_object" },
    });
  });

  it("turns reasoning off or low, raising max_tokens so a low-effort pass can reach the answer", async () => {
    const s = await server(fixture);
    const off = new OpenAICompatLLM({ baseUrl: s.baseUrl, apiKey: KEY, model: "deepseek/deepseek-v4.1-flash", retries: 0, reasoning: "off" });
    await off.complete(req({ maxTokens: 600 }));
    expect(JSON.parse(s.requests[0]?.body ?? "")).toMatchObject({ max_tokens: 600, reasoning: { enabled: false } });

    const low = new OpenAICompatLLM({ baseUrl: s.baseUrl, apiKey: KEY, model: "deepseek/deepseek-v4.1-flash", retries: 0, reasoning: "low" });
    await low.complete(req({ maxTokens: 600 }));
    expect(JSON.parse(s.requests[1]?.body ?? "")).toMatchObject({ max_tokens: 1500, reasoning: { effort: "low" } });

    await llm(s.baseUrl).complete(req());
    expect(JSON.parse(s.requests[2]?.body ?? "")).not.toHaveProperty("reasoning");
  });

  it("surfaces HTTP errors as ProviderError", async () => {
    const s = await server({ error: { message: "invalid model" } }, 400);
    const err = (await llm(s.baseUrl).complete(req()).catch((e: unknown) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.status).toBe(400);
    expect(`${err.message} ${JSON.stringify(err)}`).not.toContain(KEY);
  });
});

describe("parseChatResponse", () => {
  it("joins array content parts", () => {
    const r = parseChatResponse(
      { choices: [{ message: { content: [{ type: "text", text: "ANSWER:" }, { type: "text", text: " 7" }] } }], usage: {} },
      "fallback",
    );
    expect(r.text).toBe("ANSWER: 7");
    expect(r.model).toBe("fallback");
    expect(r.usage).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
  });

  it("estimates cost from the requested model's list price when the gateway omits it", () => {
    const r = parseChatResponse(
      { model: "anthropic/claude-haiku-4.5", choices: [{ message: { content: "x" } }], usage: { prompt_tokens: 1000, completion_tokens: 200 } },
      "deepseek/deepseek-v4.1-flash",
    );
    // Priced by the model we asked for (0.1/0.5 per M), not the echoed id.
    expect(r.usage.costUsd).toBeCloseTo((1000 * 0.1 + 200 * 0.5) / 1e6, 12);
  });

  it("prices unknown models conservatively like Haiku", () => {
    expect(estimateCostUsd("someone/unknown-model", 1_000_000, 0)).toBe(1);
    expect(estimateCostUsd("anthropic/claude-haiku-4.5", 0, 1_000_000)).toBe(5);
  });

  it("throws when there are no choices or no content", () => {
    expect(() => parseChatResponse({ choices: [] }, "m")).toThrow(ProviderError);
    expect(() => parseChatResponse({ choices: [{ message: { content: null }, finish_reason: "length" }] }, "m")).toThrow(
      /finish_reason length/,
    );
    expect(() => parseChatResponse({ error: { message: "upstream overloaded" } }, "m")).toThrow(/upstream overloaded/);
    expect(() => parseChatResponse("nope", "m")).toThrow(ProviderError);
  });
});
