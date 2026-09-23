import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bundleProblems, EvoMapClient } from "../providers/evomap";
import { runCli, sampleBundleInput } from "./evomap";

const SECRET = "cd".repeat(32);
const NODE_ID = "node_0123456789abcdef";

let dir: string;
let closers: Array<() => Promise<void>> = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "parallelize-evomap-cli-"));
});
afterEach(async () => {
  await Promise.all(closers.map((c) => c()));
  closers = [];
  await rm(dir, { recursive: true, force: true });
});

async function hub(handler: (url: string, body: string, auth: string | undefined, res: ServerResponse) => void) {
  const requests: string[] = [];
  const s = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      requests.push(req.url ?? "");
      handler(req.url ?? "", body, req.headers.authorization, res);
    });
  });
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise<void>((resolve) => s.close(() => resolve())));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, requests };
}

const reply = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

async function run(argv: string[], client: EvoMapClient) {
  const lines: string[] = [];
  const code = await runCli(argv, { client, out: (l) => lines.push(l) });
  return { code, text: lines.join("\n") };
}

describe("evomap CLI", () => {
  it("ships a sample bundle that passes the local pre-flight", () => {
    const client = new EvoMapClient({ baseUrl: "http://127.0.0.1:1", nodeFile: join(dir, "n.json") });
    expect(bundleProblems(client.buildBundle(sampleBundleInput(0)))).toEqual([]);
  });

  it("status reports a missing node and a present one without its secret", async () => {
    const file = join(dir, "node.json");
    const client = new EvoMapClient({ baseUrl: "http://127.0.0.1:1", nodeFile: file });
    expect((await run(["status"], client)).text).toMatch(/\(missing\)[\s\S]*pnpm evomap node/);

    await writeFile(file, JSON.stringify({ node_id: NODE_ID, node_secret: SECRET, claim_url: "https://evomap.ai/claim/ABCD-1234" }), { mode: 0o600 });
    const { code, text } = await run(["status"], client);
    expect(code).toBe(0);
    expect(text).toContain(`node id:   ${NODE_ID}`);
    expect(text).toContain("https://evomap.ai/claim/ABCD-1234");
    expect(text).not.toContain(SECRET);
  });

  it("node registers and prints the claim URL but never the secret", async () => {
    const s = await hub((_url, _body, _auth, res) =>
      reply(res, 200, { payload: { status: "acknowledged", your_node_id: NODE_ID, node_secret: SECRET, claim_url: "https://evomap.ai/claim/ABCD-1234" } }),
    );
    const client = new EvoMapClient({ baseUrl: s.url, nodeFile: join(dir, "private", "node.json") });
    const { code, text } = await run(["node"], client);
    expect(code).toBe(0);
    expect(text).toContain(`registered EvoMap node ${NODE_ID}`);
    expect(text).toContain("claim URL: https://evomap.ai/claim/ABCD-1234");
    expect(text).not.toContain(SECRET);
  });

  it("search prints title, gdi, trust tier and url", async () => {
    const id = `sha256:${"e".repeat(64)}`;
    const s = await hub((_url, _body, _auth, res) =>
      reply(res, 200, { search_status: "found", assets: [{ asset_id: id, asset_type: "Gene", short_title: "Inverse check", gdi_score: 42.25, trust_tier: "verified" }] }),
    );
    const client = new EvoMapClient({ baseUrl: s.url, nodeFile: join(dir, "n.json") });
    const { code, text } = await run(["search", "verify", "arithmetic", "--min-gdi", "30", "--limit", "3"], client);
    expect(code).toBe(0);
    expect(text).toBe(` 1. [gdi 42.3 | verified] Inverse check\n    ${s.url}/asset/${id}`);
    expect(s.requests[0]).toContain("min_gdi=30");
  });

  it("validate-sample posts the publish envelope to /a2a/validate and prints the verdict", async () => {
    const file = join(dir, "node.json");
    await writeFile(file, JSON.stringify({ node_id: NODE_ID, node_secret: SECRET }), { mode: 0o600 });
    let seen: { url: string; type: string; auth: string | undefined } | undefined;
    const s = await hub((url, body, auth, res) => {
      seen = { url, type: (JSON.parse(body) as { message_type: string }).message_type, auth };
      reply(res, 200, { payload: { status: "valid", quality_warnings: ["capsule not broadcast-eligible"] } });
    });
    const client = new EvoMapClient({ baseUrl: s.url, nodeFile: file });
    const { code, text } = await run(["validate-sample"], client);
    expect(code).toBe(0);
    expect(seen).toEqual({ url: "/a2a/validate", type: "publish", auth: `Bearer ${SECRET}` });
    expect(text).toMatch(/^validate: ok \(status: valid\)/);
    expect(text).toContain(`sender:   ${NODE_ID}`);
    expect(text).toMatch(/gene {6}sha256:[0-9a-f]{64}/);
    expect(text).toContain("warning:  capsule not broadcast-eligible");
    expect(text).not.toContain(SECRET);
  });

  it("rejects unknown commands and bad numbers", async () => {
    const client = new EvoMapClient({ baseUrl: "http://127.0.0.1:1", nodeFile: join(dir, "n.json") });
    await expect(run(["publish"], client)).rejects.toThrow(/unknown command: publish/);
    await expect(run(["search", "x", "--limit", "many"], client)).rejects.toThrow(/--limit must be a number/);
    await expect(run(["search"], client)).rejects.toThrow(/needs a query/);
    expect((await run([], client)).code).toBe(1);
  });
});
