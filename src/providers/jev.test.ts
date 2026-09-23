import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { JudgeRequest, Question } from "../core/types";
import { ProviderError } from "./http";
import { JevJudge, parseJevResponse } from "./jev";
import { Semaphore } from "./limiter";

const fixture = JSON.parse(readFileSync(new URL("../../test/fixtures/jev-response.json", import.meta.url), "utf8")) as Record<
  string,
  unknown
>;

type Handler = (res: ServerResponse, call: number) => void;

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.map((c) => c()));
  cleanup = [];
});

async function server(handler: Handler) {
  const requests: Array<{ url: string; headers: IncomingHttpHeaders; body: string }> = [];
  const s = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      requests.push({ url: req.url ?? "", headers: req.headers, body });
      handler(res, requests.length - 1);
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

const reply = (body: unknown, status = 200) => (res: ServerResponse) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const QUESTIONS: Record<string, Question> = {
  claim: { type: "noul", instructions: "Should this cell claim the task?" },
  domain: { type: "choice", instructions: "Which domain?", criteria: { logic: "logic", math: "math", physics: "physics" } },
};

const request = (questions = QUESTIONS, state = "state text"): JudgeRequest => ({
  state,
  questions,
  meta: { runId: "r1", purpose: "claim", cellId: "c1" },
});

const KEY = "sk-or-test-key";
const judge = (baseUrl: string, extra: Partial<ConstructorParameters<typeof JevJudge>[0]> = {}) =>
  new JevJudge({ baseUrl, apiKey: KEY, model: "typesafe/jev", retries: 0, ...extra });

describe("JevJudge", () => {
  it("sends the Jev wire format and parses the recorded response", async () => {
    const s = await server(reply(fixture));
    const j = judge(s.baseUrl);
    expect(j.id).toBe("jev:typesafe/jev");
    expect(j.tier).toBe("system1");
    expect(j.simulated).toBe(false);

    const result = await j.ask(request());
    expect(result.answers).toEqual({
      claim: { type: "noul", noul: 0.71 },
      domain: { type: "choice", choice: "math", probabilities: { logic: 0, math: 1, physics: 0 }, confidence: 1 },
    });
    expect(result.usage).toEqual({ inputTokens: 370, outputTokens: 54, costUsd: 0.00001554 });
    expect(result.model).toBe("typesafe/jev-1.13-20260917");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    const sent = s.requests[0];
    expect(sent?.url).toBe("/api/v1/systemone");
    expect(sent?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(sent?.headers["x-title"]).toBe("jis");
    expect(sent?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(sent?.body ?? "")).toEqual({ model: "typesafe/jev", state: "state text", questions: QUESTIONS });
  });

  it("keeps head and tail of an oversized state", async () => {
    const s = await server(reply(fixture));
    const state = "H".repeat(60_000) + "M".repeat(20_000) + "T".repeat(29_000);
    await judge(s.baseUrl).ask(request(QUESTIONS, state));
    const sent = (JSON.parse(s.requests[0]?.body ?? "") as { state: string }).state;
    expect(sent).toBe(`${"H".repeat(60_000)}\n…\n${"T".repeat(29_000)}`);
  });

  it("refuses a choice question with more than 255 criteria before calling the API", async () => {
    const s = await server(reply(fixture));
    const criteria = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`k${i}`, `option ${i}`]));
    await expect(judge(s.baseUrl).ask(request({ c: { type: "choice", instructions: "pick", criteria } }))).rejects.toThrow(
      ProviderError,
    );
    expect(s.requests).toHaveLength(0);
  });

  it("surfaces HTTP errors without leaking the key", async () => {
    const s = await server(reply({ error: { message: "bad key" } }, 401));
    const err = (await judge(s.baseUrl).ask(request()).catch((e: unknown) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.status).toBe(401);
    expect(err.bodySnippet).toContain("bad key");
    expect(`${err.message} ${JSON.stringify(err)}`).not.toContain(KEY);
  });

  it("rejects a structurally unusable response", async () => {
    const s = await server(reply({ model: "x", answers: { claim: { type: "choice", choice: "a" } } }));
    await expect(judge(s.baseUrl).ask(request())).rejects.toThrow(/unusable/);
  });

  it("runs through the limiter", async () => {
    let inFlight = 0;
    let peak = 0;
    const s = await server((res) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      setTimeout(() => {
        inFlight--;
        reply(fixture)(res);
      }, 20);
    });
    const j = judge(s.baseUrl, { limiter: new Semaphore(1) });
    await Promise.all([j.ask(request()), j.ask(request()), j.ask(request())]);
    expect(s.requests).toHaveLength(3);
    expect(peak).toBe(1);
  });
});

describe("parseJevResponse", () => {
  const parse = (answers: unknown, questions: Record<string, Question> = QUESTIONS, usage: unknown = {}) =>
    parseJevResponse({ answers, usage }, questions, "fallback-model");

  it("clamps noul into [0, 1]", () => {
    const r = parse({ n: { type: "noul", noul: 1.4 } }, { n: { type: "noul", instructions: "" } });
    expect(r.answers.n).toEqual({ type: "noul", noul: 1 });
  });

  it("falls back to the argmax over criteria when the choice is not a criteria key", () => {
    const r = parse(
      {
        claim: { type: "noul", noul: -0.2 },
        domain: { type: "choice", choice: "chemistry", probabilities: { logic: 0.2, math: 0.1, physics: 0.7, chemistry: 0.9 } },
      },
      QUESTIONS,
    );
    expect(r.answers.claim).toEqual({ type: "noul", noul: 0 });
    expect(r.answers.domain).toEqual({
      type: "choice",
      choice: "physics",
      probabilities: { logic: 0.2, math: 0.1, physics: 0.7 },
      confidence: 0.7,
    });
  });

  it("uses the max probability when confidence is missing", () => {
    const r = parse({ claim: { type: "noul", noul: 0.4 }, domain: { type: "choice", choice: "logic", probabilities: { logic: 0.6, math: 0.4 } } });
    expect(r.answers.domain).toMatchObject({ choice: "logic", confidence: 0.6, probabilities: { logic: 0.6, math: 0.4, physics: 0 } });
  });

  it("parses score answers", () => {
    const q: Record<string, Question> = { s: { type: "score", instructions: "rate", criteria: ["low", "mid", "high"] } };
    const r = parse({ s: { type: "score", score: 1.03, confidence: 0.8, legend: { 0: "low" }, probabilities: { 0: 0.1, 1: 0.8, 2: 0.1 } } }, q);
    expect(r.answers.s).toEqual({ type: "score", score: 1.03, confidence: 0.8, probabilities: { 0: 0.1, 1: 0.8, 2: 0.1 } });
    const noConfidence = parse({ s: { type: "score", score: 2, probabilities: { 0: 0.3, 1: 0.7 } } }, q);
    expect(noConfidence.answers.s).toMatchObject({ confidence: 0.7 });
  });

  it("estimates cost from input tokens when usage.cost is absent and defaults the model", () => {
    const answers = { claim: { type: "noul", noul: 0.5 }, domain: { type: "choice", choice: "math", confidence: 1 } };
    const r = parse(answers, QUESTIONS, { input_tokens: 1000 });
    expect(r.usage.inputTokens).toBe(1000);
    expect(r.usage.outputTokens).toBe(0);
    expect(r.usage.costUsd).toBeCloseTo(1000 * 0.042e-6, 12);
    expect(r.model).toBe("fallback-model");
  });

  it("throws on missing keys, wrong types and missing answers", () => {
    expect(() => parse({ claim: { type: "noul", noul: 0.5 } })).toThrow(ProviderError);
    expect(() => parse({ claim: { type: "choice", choice: "x" }, domain: { type: "choice", choice: "math", confidence: 1 } })).toThrow(
      ProviderError,
    );
    expect(() => parseJevResponse({ error: "nope" }, QUESTIONS, "m")).toThrow(ProviderError);
    expect(() => parseJevResponse("garbage", QUESTIONS, "m")).toThrow(ProviderError);
    expect(() => parse({ claim: { type: "noul", noul: "high" }, domain: { type: "choice", choice: "math", confidence: 1 } })).toThrow(
      ProviderError,
    );
    expect(() => parse({ claim: { type: "noul", noul: 0.5 }, domain: { type: "choice", choice: "chemistry" } })).toThrow(ProviderError);
  });

  it("fills probabilities from confidence when only a valid choice and confidence are given", () => {
    const r = parse({ claim: { type: "noul", noul: 0.5 }, domain: { type: "choice", choice: "math", confidence: 0.9 } });
    expect(r.answers.domain).toEqual({ type: "choice", choice: "math", probabilities: { logic: 0, math: 0.9, physics: 0 }, confidence: 0.9 });
  });
});
