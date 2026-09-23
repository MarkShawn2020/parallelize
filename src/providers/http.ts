import { fetch } from "undici";
import { sleep } from "../core/rng";

const SNIPPET_CHARS = 300;

export class ProviderError extends Error {
  status?: number;
  bodySnippet?: string;

  constructor(message: string, opts: { status?: number; bodySnippet?: string; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "ProviderError";
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.bodySnippet !== undefined) this.bodySnippet = opts.bodySnippet.slice(0, SNIPPET_CHARS);
  }
}

export interface PostJsonOptions {
  headers: Record<string, string>;
  timeoutMs: number;
  retries: number;
  /** Base of the exponential backoff (default 500ms). */
  backoffMs?: number;
  /** Upper bound for any single wait, including Retry-After (default 8000ms). */
  maxBackoffMs?: number;
}

export function snippet(value: unknown): string {
  const text = typeof value === "string" ? value : safeStringify(value);
  return text.slice(0, SNIPPET_CHARS);
}

export async function postJson(url: string, body: unknown, opts: PostJsonOptions): Promise<unknown> {
  const base = opts.backoffMs ?? 500;
  const cap = opts.maxBackoffMs ?? 8000;
  const payload = JSON.stringify(body);

  for (let attempt = 0; ; attempt++) {
    const canRetry = attempt < opts.retries;
    let res: SendResult;
    try {
      res = await send(url, payload, opts.headers, opts.timeoutMs);
    } catch (err) {
      if (canRetry) {
        await sleep(Math.min(cap, base * 2 ** attempt));
        continue;
      }
      throw new ProviderError(`POST ${url} failed after ${attempt + 1} attempt(s): ${describe(err, opts.timeoutMs)}`, {
        cause: err,
      });
    }

    const { status, text, retryAfter } = res;
    if (status >= 200 && status < 300) {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new ProviderError(`POST ${url} returned non-JSON body (HTTP ${status})`, { status, bodySnippet: text });
      }
    }
    if (canRetry && isRetryable(status)) {
      await sleep(Math.min(cap, retryAfterMs(retryAfter) ?? base * 2 ** attempt));
      continue;
    }
    throw new ProviderError(`POST ${url} failed with HTTP ${status}`, { status, bodySnippet: text });
  }
}

interface SendResult {
  status: number;
  text: string;
  retryAfter: string | null;
}

async function send(url: string, payload: string, headers: Record<string, string>, timeoutMs: number): Promise<SendResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: payload,
      signal: controller.signal,
    });
    // Reading the body stays inside the timeout: a stalled stream must not hang the run.
    const text = await res.text();
    return { status: res.status, text, retryAfter: res.headers.get("retry-after") };
  } finally {
    clearTimeout(timer);
  }
}

function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function retryAfterMs(header: string | null): number | undefined {
  if (header === null || header.trim() === "") return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

function describe(err: unknown, timeoutMs: number): string {
  if (err instanceof Error && err.name === "AbortError") return `timed out after ${timeoutMs}ms`;
  if (err instanceof Error) {
    const code = (err.cause as { code?: unknown } | undefined)?.code;
    return typeof code === "string" ? `${err.message} (${code})` : err.message;
  }
  return String(err);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
