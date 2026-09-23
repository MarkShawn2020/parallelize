import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LibraryGene } from "../core/types";
import {
  buildBundle,
  bundleProblems,
  canonicalize,
  computeAssetId,
  EvoMapClient,
  type EvoMapBundleInput,
  hitToLibraryGene,
  searchKeywords,
  unsafeSecretLocation,
} from "./evomap";

type Req = { method: string; url: string; headers: IncomingHttpHeaders; body: string };
type Handler = (req: Req, res: ServerResponse) => void;

const SECRET = "ab".repeat(32);
const NODE_ID = "node_a3f8b2c1d9e04567";
const ASSET = (c: string) => `sha256:${c.repeat(64)}`;

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

let cleanup: Array<() => Promise<void>> = [];
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "parallelize-evomap-"));
});
afterEach(async () => {
  await Promise.all(cleanup.map((c) => c()));
  cleanup = [];
  delete process.env.EVOMAP_NODE_FILE;
  await rm(dir, { recursive: true, force: true });
});

async function server(handler: Handler) {
  const requests: Req[] = [];
  const s = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      const r = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
      requests.push(r);
      handler(r, res);
    });
  });
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const { port } = s.address() as AddressInfo;
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        s.closeAllConnections();
        s.close(() => resolve());
      }),
  );
  return { url: `http://127.0.0.1:${port}`, requests };
}

function sampleInput(over: Partial<EvoMapBundleInput> = {}): EvoMapBundleInput {
  const gene: LibraryGene = {
    id: "g1",
    kind: "solve",
    domain: "arithmetic",
    text: "Write every intermediate result on its own line,\nthen invert the last operation to check the answer.",
    origin: "cell-2",
    lineageId: "g1",
    wins: 7,
    trials: 8,
    createdAt: 1,
    source: "local",
    evidence: { wins: 7, trials: 8 },
  };
  return {
    gene,
    modelName: "anthropic/claude-haiku-4.5",
    signals: ["arithmetic", "multi-step", "ab", "arithmetic"],
    strategy: ["Rewrite the problem as an ordered list of operations", "Invert the final operation to confirm the answer"],
    confidence: 0.8,
    score: 0.875,
    successStreak: 7,
    cycles: 3,
    mutations: 2,
    gate: { tasks: 8, withGene: 7, withoutGene: 5 },
    ...over,
  };
}

async function writeNode(file: string, extra: Record<string, unknown> = {}) {
  await writeFile(file, JSON.stringify({ node_id: NODE_ID, node_secret: SECRET, claim_url: "https://evomap.ai/claim/REEF-4X7K", ...extra }), {
    mode: 0o600,
  });
}

describe("canonicalize / computeAssetId", () => {
  it("sorts keys at every depth, keeps array order, drops undefined members", () => {
    const v = { z: { k: "v", e: [] }, b: [3, { d: null, c: "x" }], a: 1, u: undefined };
    expect(JSON.stringify(canonicalize(v))).toBe('{"a":1,"b":[3,{"c":"x","d":null}],"z":{"e":[],"k":"v"}}');
  });

  it("hashes the canonical JSON without asset_id (pinned vector)", () => {
    const asset = { z: { k: "v", e: [] }, b: [3, { d: null, c: "x" }], a: 1, asset_id: "sha256:ignored" };
    // shasum -a 256 of '{"a":1,"b":[3,{"c":"x","d":null}],"z":{"e":[],"k":"v"}}'
    expect(computeAssetId(asset)).toBe("sha256:4df9ff7fc9758e5df1df50015c19c174a18c5f9f0a05670de9fe8e877ef267f6");
    const { asset_id: _drop, ...rest } = asset;
    expect(computeAssetId(rest)).toBe(computeAssetId(asset));
    expect(computeAssetId({ ...rest, a: 2 })).not.toBe(computeAssetId(asset));
  });
});

describe("buildBundle", () => {
  it("chains ids gene -> capsule -> event and carries the gate evidence", () => {
    const b = buildBundle(sampleInput());
    expect(b.gene).toMatchObject({
      type: "Gene",
      schema_version: "1.14.0",
      category: "optimize",
      signals_match: ["arithmetic", "multi-step"],
      summary: "Write every intermediate result on its own line, then invert the last operation to check the answer.",
      model_name: "anthropic/claude-haiku-4.5",
    });
    expect(b.capsule).toMatchObject({
      type: "Capsule",
      gene: b.gene.asset_id,
      trigger: ["arithmetic", "multi-step"],
      confidence: 0.8,
      blast_radius: { files: 1, lines: 4 },
      outcome: { status: "success", score: 0.875 },
      env_fingerprint: { platform: process.platform, arch: process.arch },
      success_streak: 7,
    });
    expect(b.capsule.summary).toContain("holdout A/B on 8 fresh tasks: 7/8 with vs 5/8 without");
    expect(b.event).toMatchObject({
      type: "EvolutionEvent",
      intent: "optimize",
      capsule_id: b.capsule.asset_id,
      genes_used: [b.gene.asset_id],
      mutations_tried: 2,
      total_cycles: 3,
      summary: "holdout A/B on 8 fresh tasks: 7/8 with vs 5/8 without",
    });
    for (const a of [b.gene, b.capsule, b.event]) expect(a.asset_id).toBe(computeAssetId(a));
    expect(bundleProblems(b)).toEqual([]);
  });

  it("is deterministic and sensitive to the gate result", () => {
    expect(buildBundle(sampleInput())).toEqual(buildBundle(sampleInput()));
    const other = buildBundle(sampleInput({ gate: { tasks: 8, withGene: 6, withoutGene: 5 } }));
    expect(other.gene.asset_id).not.toBe(buildBundle(sampleInput()).gene.asset_id);
  });

  it("uses sandbox-safe validation commands", () => {
    const [cmd] = buildBundle(sampleInput()).gene.validation as string[];
    expect(cmd).toMatch(/^node -e '/);
    expect(cmd).not.toMatch(/[;|&<>`]/);
  });

  it("flags hub shape violations and tampering before any request", () => {
    const b = buildBundle(sampleInput({ strategy: ["too short"], signals: ["ab"] }));
    const problems = bundleProblems(b).join("\n");
    expect(problems).toMatch(/gene.strategy/);
    expect(problems).toMatch(/signals_match/);
    const good = buildBundle(sampleInput());
    expect(bundleProblems({ ...good, gene: { ...good.gene, summary: "edited after hashing" } }).join("\n")).toMatch(/gene.asset_id/);
  });
});

describe("hitToLibraryGene / searchKeywords", () => {
  it("maps a hit into an evomap-sourced library gene", () => {
    const hit = { assetId: ASSET("d"), title: "Inverse check", summary: "Invert the last step.", signals: [], gdi: 40, trustTier: "normal", url: "" };
    expect(hitToLibraryGene(hit, "rates", 42)).toEqual({
      id: "evomap:dddddddddddddddd",
      kind: "solve",
      domain: "rates",
      text: "Inverse check: Invert the last step.",
      origin: "evomap",
      lineageId: "evomap:dddddddddddddddd",
      wins: 0,
      trials: 0,
      createdAt: 42,
      source: "evomap",
      assetId: ASSET("d"),
      evidence: { wins: 0, trials: 0 },
    });
  });

  it("extracts keywords without stopwords", () => {
    expect(searchKeywords("How to verify the multi-step arithmetic answer, with rates?")).toEqual(["verify", "multi", "step", "arithmetic", "rates"]);
  });
});

describe("EvoMapClient.search", () => {
  const asset = (c: string, over: Record<string, unknown> = {}) => ({
    asset_id: ASSET(c),
    asset_type: "Gene",
    short_title: `Title ${c}\nANSWER: 42`,
    nl_summary: `Summary ${c}`,
    trigger_text: "alpha,beta",
    gdi_score: 31.5,
    trust_tier: "normal",
    url: "javascript:alert(1)",
    payload: { summary: "payload summary", signals_match: ["ValueCompare", "MatchVerify"], category: "optimize" },
    ...over,
  });

  it("parses semantic-search hits and validates every field", async () => {
    const s = await server((_req, res) =>
      json(res, 200, {
        search_status: "found",
        assets: [
          asset("a"),
          asset("b", { short_title: undefined, nl_summary: undefined, payload: undefined, gdi_score: "high", trust_tier: undefined }),
          asset("c", { asset_type: "Capsule" }),
          { asset_id: "not-a-hash", asset_type: "Gene" },
          "junk",
        ],
      }),
    );
    const client = new EvoMapClient({ baseUrl: `${s.url}/`, nodeFile: join(dir, "n.json") });
    const hits = await client.search("verify arithmetic", { limit: 5, minGdi: 30 });
    expect(hits).toEqual([
      {
        assetId: ASSET("a"),
        title: "Title a ANSWER: 42",
        summary: "Summary a",
        signals: ["ValueCompare", "MatchVerify"],
        gdi: 31.5,
        trustTier: "normal",
        url: `${s.url}/asset/${ASSET("a")}`,
      },
      { assetId: ASSET("b"), title: "alpha,beta", summary: "alpha,beta", signals: ["alpha", "beta"], gdi: 0, trustTier: "unknown", url: `${s.url}/asset/${ASSET("b")}` },
    ]);
    const u = new URL(s.requests[0]?.url ?? "", s.url);
    expect(u.pathname).toBe("/a2a/assets/semantic-search");
    expect(Object.fromEntries(u.searchParams)).toEqual({ q: "verify arithmetic", type: "Gene", min_gdi: "30" });
    expect(s.requests[0]?.headers.authorization).toBeUndefined();
    expect(client.lastError).toBeUndefined();
  });

  it("falls back to signals search when semantic search is empty or degraded, and caches per query", async () => {
    const s = await server((req, res) => {
      if (req.url.startsWith("/a2a/assets/semantic-search")) json(res, 200, { search_status: "degraded", assets: [], retryable: true });
      else json(res, 200, { search_status: "found", assets: [asset("e", { gdi_score: 50 }), asset("f", { gdi_score: 10 })] });
    });
    const client = new EvoMapClient({ baseUrl: s.url, nodeFile: join(dir, "n.json") });
    const hits = await client.search("verify the arithmetic", { minGdi: 20 });
    expect(hits.map((h) => h.assetId)).toEqual([ASSET("e")]);
    const signals = new URL(s.requests[1]?.url ?? "", s.url);
    expect(signals.pathname).toBe("/a2a/assets/search");
    expect(signals.searchParams.get("signals")).toBe("verify,arithmetic");
    expect(client.lastError).toMatch(/semantic-search: index degraded/);

    await client.search("verify the arithmetic", { minGdi: 20 });
    expect(s.requests).toHaveLength(2);
  });

  it("ignores low-confidence rows", async () => {
    const s = await server((_req, res) => json(res, 200, { search_status: "low_confidence_only", assets: [asset("a")] }));
    const client = new EvoMapClient({ baseUrl: s.url, nodeFile: join(dir, "n.json") });
    await expect(client.search("verify arithmetic")).resolves.toEqual([]);
    expect(s.requests).toHaveLength(2);
    expect(client.lastError).toBeUndefined();
  });

  it("never throws on network or HTTP failure and remembers the error", async () => {
    const s = await server((_req, res) => json(res, 429, { error: "rate_limited" }));
    const client = new EvoMapClient({ baseUrl: s.url, nodeFile: join(dir, "n.json") });
    await expect(client.search("verify arithmetic")).resolves.toEqual([]);
    expect(client.lastError).toMatch(/semantic-search: HTTP 429 \(rate_limited\)/);
    expect(client.lastError).toMatch(/signals search: HTTP 429/);
    // A failed query is not retried immediately (per-IP rate limits).
    await client.search("verify arithmetic");
    expect(s.requests).toHaveLength(2);

    const down = new EvoMapClient({ baseUrl: "http://127.0.0.1:1", nodeFile: join(dir, "n.json"), timeoutMs: 2000 });
    await expect(down.search("verify arithmetic")).resolves.toEqual([]);
    expect(down.lastError).toMatch(/semantic-search: /);
  });

  it("times out a stalled server", async () => {
    const s = await server(() => undefined);
    const client = new EvoMapClient({ baseUrl: s.url, nodeFile: join(dir, "n.json"), timeoutMs: 100 });
    await expect(client.search("verify arithmetic")).resolves.toEqual([]);
    expect(client.lastError).toMatch(/timed out after 100ms/);
  });
});

describe("EvoMapClient node registration", () => {
  const ack = {
    protocol: "gep-a2a",
    message_type: "hello",
    sender_id: "hub_0f978bbe1fb5",
    payload: {
      status: "acknowledged",
      your_node_id: NODE_ID,
      node_secret: SECRET,
      hub_node_id: "hub_0f978bbe1fb5",
      claim_code: "REEF-4X7K",
      claim_url: "https://evomap.ai/claim/REEF-4X7K",
      heartbeat_interval_ms: 300000,
    },
  };

  it("registers once, stores the secret 0600 in a 0700 dir, and never returns it", async () => {
    const s = await server((_req, res) => json(res, 200, ack));
    const file = join(dir, "private", "evomap-node.json");
    process.env.EVOMAP_NODE_FILE = file;
    const client = new EvoMapClient({ baseUrl: s.url });
    expect(client.nodeFile).toBe(file);
    await expect(client.node()).resolves.toBeUndefined();

    const [first, second] = await Promise.all([client.ensureNode(), client.ensureNode()]);
    expect(first).toEqual({ nodeId: NODE_ID, claimUrl: "https://evomap.ai/claim/REEF-4X7K", created: true });
    expect(second).toEqual(first);
    await expect(client.ensureNode()).resolves.toEqual({ ...first, created: false });
    expect(s.requests).toHaveLength(1);
    expect(JSON.stringify([first, await client.node()])).not.toContain(SECRET);

    const hello = JSON.parse(s.requests[0]?.body ?? "{}") as Record<string, unknown>;
    expect(s.requests[0]?.url).toBe("/a2a/hello");
    expect(hello).toMatchObject({
      protocol: "gep-a2a",
      protocol_version: "1.0.0",
      message_type: "hello",
      payload: { capabilities: {}, env_fingerprint: { platform: process.platform, arch: process.arch } },
    });
    expect(hello.message_id).toMatch(/^msg_\d+_[0-9a-f]{8}$/);
    expect(new Date(String(hello.timestamp)).toISOString()).toBe(hello.timestamp);

    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "private"))).mode & 0o777).toBe(0o700);
    const stored = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(stored).toMatchObject({ node_id: NODE_ID, node_secret: SECRET, claim_code: "REEF-4X7K", hub_node_id: "hub_0f978bbe1fb5" });
  });

  it("treats an HTTP 200 rejection as a refusal and writes nothing", async () => {
    const s = await server((_req, res) =>
      json(res, 200, {
        protocol: "gep-a2a",
        payload: { status: "rejected", reason: "hello_blocked: bulk-fetch antibody active", captcha_required: true, retry_after_ms: 3600000 },
      }),
    );
    const file = join(dir, "node.json");
    const client = new EvoMapClient({ baseUrl: s.url, nodeFile: file });
    await expect(client.ensureNode()).rejects.toThrow(/refused node registration: hello_blocked: bulk-fetch antibody active; retry after 3600s; captcha required/);
    await expect(stat(file)).rejects.toThrow();
  });

  it("keeps the secret out of errors on a malformed acknowledgement or HTTP failure", async () => {
    const leaky = await server((_req, res) => json(res, 200, { payload: { status: "acknowledged", node_secret: SECRET } }));
    const e1 = await new EvoMapClient({ baseUrl: leaky.url, nodeFile: join(dir, "a.json") }).ensureNode().catch((e: unknown) => e as Error);
    expect(e1).toBeInstanceOf(Error);
    expect(String((e1 as Error).message)).not.toContain(SECRET);

    const failing = await server((_req, res) => json(res, 500, { error: `boom ${SECRET}` }));
    const e2 = await new EvoMapClient({ baseUrl: failing.url, nodeFile: join(dir, "b.json") }).ensureNode().catch((e: unknown) => e as Error);
    expect((e2 as Error).message).toMatch(/HTTP 500 \(boom \[redacted\]\)/);
    expect((e2 as Error).message).not.toContain(SECRET);
  });

  it("refuses to store the secret inside the repository or a malformed existing file", async () => {
    const s = await server((_req, res) => json(res, 200, ack));
    const inRepo = new EvoMapClient({ baseUrl: s.url, nodeFile: join(process.cwd(), "runs", "evomap-node.json") });
    await expect(inRepo.ensureNode()).rejects.toThrow(/inside the project repository/);
    expect(unsafeSecretLocation(join(dir, "x.json"))).toBeUndefined();

    const file = join(dir, "broken.json");
    await writeFile(file, "{}");
    const client = new EvoMapClient({ baseUrl: s.url, nodeFile: file });
    await expect(client.ensureNode()).rejects.toThrow(/malformed/);
    await expect(client.node()).resolves.toBeUndefined();
    expect(s.requests).toHaveLength(0);
  });
});

describe("EvoMapClient validate / publish", () => {
  it("publishes the bundle with the node secret and returns asset urls", async () => {
    const s = await server((_req, res) => json(res, 200, { payload: { status: "accepted" } }));
    const file = join(dir, "node.json");
    await writeNode(file);
    const client = new EvoMapClient({ baseUrl: s.url, nodeFile: file });
    const bundle = client.buildBundle(sampleInput());
    const res = await client.publish(bundle);
    const ids = [bundle.gene.asset_id, bundle.capsule.asset_id, bundle.event.asset_id];
    expect(res).toEqual({ ok: true, status: "accepted", assetIds: ids, urls: ids.map((id) => `${s.url}/asset/${id}`) });

    const req = s.requests[0];
    expect(req?.url).toBe("/a2a/publish");
    expect(req?.headers.authorization).toBe(`Bearer ${SECRET}`);
    const body = JSON.parse(req?.body ?? "{}") as { payload: { assets: Array<Record<string, unknown>> } } & Record<string, unknown>;
    expect(body).toMatchObject({ protocol: "gep-a2a", protocol_version: "1.0.0", message_type: "publish", sender_id: NODE_ID });
    expect(body.payload.assets.map((a) => a.type)).toEqual(["Gene", "Capsule", "EvolutionEvent"]);
    for (const a of body.payload.assets) expect(a.asset_id).toBe(computeAssetId(a));
  });

  it("refuses to publish without a registered node and without touching the network", async () => {
    const s = await server((_req, res) => json(res, 200, {}));
    const client = new EvoMapClient({ baseUrl: s.url, nodeFile: join(dir, "none.json") });
    const res = await client.publish(client.buildBundle(sampleInput()));
    expect(res).toMatchObject({ ok: false, status: "no-node" });
    expect(s.requests).toHaveLength(0);
  });

  it("validates with a throwaway sender id when no node exists, and reports hub errors", async () => {
    const s = await server((_req, res) =>
      json(res, 422, {
        error: "capsule_blast_radius_invalid",
        errors: [{ field: "blast_radius", message: "files must be > 0" }],
        quality_warnings: ["validation not credible"],
      }),
    );
    const client = new EvoMapClient({ baseUrl: s.url, nodeFile: join(dir, "none.json") });
    const res = await client.validate(client.buildBundle(sampleInput()));
    expect(res).toMatchObject({
      ok: false,
      status: "capsule_blast_radius_invalid",
      error: "capsule_blast_radius_invalid; files must be > 0",
      warnings: ["validation not credible"],
    });
    const req = s.requests[0];
    expect(req?.url).toBe("/a2a/validate");
    expect(req?.headers.authorization).toBeUndefined();
    expect((JSON.parse(req?.body ?? "{}") as { sender_id: string }).sender_id).toMatch(/^node_[0-9a-f]{16}$/);
  });

  it("treats an HTTP 200 rejection as failure and redacts the secret", async () => {
    const s = await server((_req, res) => json(res, 200, { payload: { status: "rejected", reason: `bad token ${SECRET}` } }));
    const file = join(dir, "node.json");
    await writeNode(file);
    const client = new EvoMapClient({ baseUrl: s.url, nodeFile: file });
    const res = await client.publish(client.buildBundle(sampleInput()));
    expect(res.ok).toBe(false);
    expect(res.status).toBe("rejected");
    expect(res.error).toBe("bad token [redacted]");
  });

  it("does not send a bundle that fails the local pre-flight", async () => {
    const s = await server((_req, res) => json(res, 200, {}));
    const client = new EvoMapClient({ baseUrl: s.url, nodeFile: join(dir, "none.json") });
    const res = await client.validate(client.buildBundle(sampleInput({ strategy: ["short"] })));
    expect(res).toMatchObject({ ok: false, status: "invalid" });
    expect(s.requests).toHaveLength(0);
  });

  it("returns a failure result instead of throwing when the hub is unreachable", async () => {
    const file = join(dir, "node.json");
    await writeNode(file);
    const client = new EvoMapClient({ baseUrl: "http://127.0.0.1:1", nodeFile: file, timeoutMs: 2000 });
    const res = await client.publish(client.buildBundle(sampleInput()));
    expect(res).toMatchObject({ ok: false, status: "network" });
    expect(res.error).not.toContain(SECRET);
  });
});

describe("hash helper sanity", () => {
  it("matches node:crypto directly", () => {
    const hex = createHash("sha256").update('{"type":"Gene"}').digest("hex");
    expect(computeAssetId({ type: "Gene" })).toBe(`sha256:${hex}`);
  });
});
