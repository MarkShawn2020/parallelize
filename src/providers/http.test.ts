import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderError, postJson } from "./http";

type Handler = (res: ServerResponse, call: number) => void;

async function startServer(handler: Handler) {
  const requests: Array<{ url: string; headers: IncomingHttpHeaders; body: string }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      requests.push({ url: req.url ?? "", headers: req.headers, body });
      handler(res, requests.length - 1);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return { url: `http://127.0.0.1:${port}`, requests, close };
}

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

const SECRET = "sk-test-secret-123";
const fast = { headers: { Authorization: `Bearer ${SECRET}` }, timeoutMs: 2000, retries: 2, backoffMs: 1, maxBackoffMs: 20 };

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.map((c) => c()));
  cleanup = [];
});

async function server(handler: Handler) {
  const s = await startServer(handler);
  cleanup.push(s.close);
  return s;
}

describe("postJson", () => {
  it("posts JSON with the given headers and returns the parsed body", async () => {
    const s = await server((res) => json(res, 200, { ok: true }));
    await expect(postJson(`${s.url}/x`, { a: 1 }, fast)).resolves.toEqual({ ok: true });
    expect(s.requests[0]?.url).toBe("/x");
    expect(JSON.parse(s.requests[0]?.body ?? "")).toEqual({ a: 1 });
    expect(s.requests[0]?.headers["content-type"]).toBe("application/json");
    expect(s.requests[0]?.headers.authorization).toBe(`Bearer ${SECRET}`);
  });

  it("retries 5xx and 408 then succeeds", async () => {
    const s = await server((res, call) => {
      if (call === 0) json(res, 503, { error: "busy" });
      else if (call === 1) json(res, 408, { error: "slow" });
      else json(res, 200, { ok: 3 });
    });
    await expect(postJson(s.url, {}, fast)).resolves.toEqual({ ok: 3 });
    expect(s.requests).toHaveLength(3);
  });

  it("honours Retry-After seconds on 429", async () => {
    const s = await server((res, call) =>
      call === 0 ? json(res, 429, { error: "rate" }, { "Retry-After": "0.15" }) : json(res, 200, { ok: true }),
    );
    const started = performance.now();
    await postJson(s.url, {}, { ...fast, maxBackoffMs: 5000 });
    expect(performance.now() - started).toBeGreaterThanOrEqual(140);
    expect(s.requests).toHaveLength(2);
  });

  it("caps Retry-After at the maximum backoff", async () => {
    const s = await server((res, call) =>
      call === 0 ? json(res, 429, {}, { "Retry-After": "30" }) : json(res, 200, { ok: true }),
    );
    const started = performance.now();
    await postJson(s.url, {}, fast);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("gives up after the configured retries with the last status", async () => {
    const s = await server((res) => json(res, 500, { error: "down" }));
    const err = await postJson(s.url, {}, fast).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).status).toBe(500);
    expect(s.requests).toHaveLength(3);
  });

  it("does not retry other 4xx and never leaks request headers", async () => {
    const s = await server((res) => json(res, 400, "x".repeat(1000)));
    const err = (await postJson(s.url, {}, fast).catch((e: unknown) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.status).toBe(400);
    expect(err.bodySnippet).toHaveLength(300);
    expect(s.requests).toHaveLength(1);
    const dump = `${err.message} ${err.stack ?? ""} ${JSON.stringify(err)}`;
    expect(dump).not.toContain(SECRET);
  });

  it("aborts a stalled request after timeoutMs and retries it", async () => {
    const s = await server((res, call) => {
      if (call > 0) json(res, 200, { ok: true });
    });
    await expect(postJson(s.url, {}, { ...fast, timeoutMs: 100 })).resolves.toEqual({ ok: true });
    expect(s.requests).toHaveLength(2);
  });

  it("reports a timeout once retries are exhausted", async () => {
    const s = await server(() => {});
    const err = (await postJson(s.url, {}, { ...fast, timeoutMs: 50, retries: 1 }).catch((e: unknown) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain("timed out after 50ms");
    expect(err.status).toBeUndefined();
    expect(s.requests).toHaveLength(2);
  });

  it("wraps network errors in ProviderError", async () => {
    const s = await startServer(() => {});
    await s.close();
    const err = (await postJson(s.url, {}, { ...fast, retries: 1 }).catch((e: unknown) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.status).toBeUndefined();
    expect(err.message).toContain("after 2 attempt(s)");
  });

  it("rejects a non-JSON 2xx body", async () => {
    const s = await server((res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html>oops</html>");
    });
    const err = (await postJson(s.url, {}, fast).catch((e: unknown) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.bodySnippet).toBe("<html>oops</html>");
  });
});
