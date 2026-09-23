import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Domain, LibraryGene } from "../core/types";

export const EVOMAP_DEFAULT_BASE_URL = "https://evomap.ai";
const SCHEMA_VERSION = "1.14.0";
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_SEARCH_LIMIT = 5;
/** Search endpoints are rate limited per IP (signals 6/min), so a failed query is not retried at once. */
const SEARCH_FAILURE_COOLDOWN_MS = 60_000;
const PROJECT_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SECRET_RE = /^[0-9a-f]{64}$/i;
const ASSET_ID_RE = /^sha256:[0-9a-f]{64}$/i;
const NODE_ID_RE = /^node_[A-Za-z0-9_-]{4,64}$/;
const REFUSED_STATUSES = new Set(["rejected", "error", "failed", "invalid"]);

export type EvoMapGeneHit = {
  assetId: string;
  title: string;
  summary: string;
  signals: string[];
  gdi: number;
  trustTier: string;
  url: string;
};

export type EvoMapAsset = Record<string, unknown> & { asset_id: string };

export interface EvoMapBundle {
  gene: EvoMapAsset;
  capsule: EvoMapAsset;
  event: EvoMapAsset;
}

export interface EvoMapBundleInput {
  gene: LibraryGene;
  modelName: string;
  signals: string[];
  strategy: string[];
  confidence: number;
  score: number;
  successStreak: number;
  cycles: number;
  mutations: number;
  gate: { tasks: number; withGene: number; withoutGene: number };
}

export interface EvoMapSendResult {
  ok: boolean;
  status: string;
  assetIds: string[];
  urls: string[];
  error?: string;
  /** Hub quality warnings (e.g. quality_warnings on validate), when it sends any. */
  warnings?: string[];
}

export interface EvoMapClientOptions {
  baseUrl?: string;
  nodeFile?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface NodeCredential {
  nodeId: string;
  secret: string;
  claimUrl?: string;
}

// ---------------------------------------------------------------- content addressing

/** Keys sorted at every depth, arrays kept in order, undefined members dropped (as JSON.stringify does). */
export function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (isObj(v)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      if (v[k] !== undefined) out[k] = canonicalize(v[k]);
    }
    return out;
  }
  return v;
}

/** GEP asset_id: sha256 of the canonical JSON of the asset without its own asset_id. */
export function computeAssetId(asset: Record<string, unknown>): string {
  const { asset_id: _ignored, ...rest } = asset;
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(rest))).digest("hex")}`;
}

function withAssetId(asset: Record<string, unknown>): EvoMapAsset {
  return { ...asset, asset_id: computeAssetId(asset) };
}

// ---------------------------------------------------------------- bundle

export function gateEvidence(gate: EvoMapBundleInput["gate"]): string {
  return `holdout A/B on ${gate.tasks} fresh tasks: ${gate.withGene}/${gate.tasks} with vs ${gate.withoutGene}/${gate.tasks} without`;
}

/**
 * A reasoning strategy has no code to test, so its sandbox validation re-checks the recorded holdout
 * result against the publish thresholds: strictly more correct with the gene, and >= 70% correct with it.
 * The hub only runs node/npm/npx and forbids ';' and pipes; '<' and '>' are avoided as well.
 */
function gateCommand(gate: EvoMapBundleInput["gate"]): string {
  return `node -e 'if (Math.min(Math.sign(${gate.withGene} - ${gate.withoutGene}), Math.sign(${gate.withGene} * 10 - ${gate.tasks} * 7) + 1) !== 1) process.exit(1)'`;
}

/** Adopting a gene means adding one strategy file to an agent's strategy library; that file is the blast radius. */
export function strategyFilePath(g: EvoMapBundleInput): string {
  const slug = g.gene.id.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 48) || "gene";
  return `strategies/${g.gene.domain}/${slug}.md`;
}

function envFingerprint(): { platform: string; arch: string } {
  return { platform: process.platform, arch: process.arch };
}

export function buildBundle(g: EvoMapBundleInput): EvoMapBundle {
  const signals = [...new Set(g.signals.map(oneLine).filter((s) => s.length >= 3))].slice(0, 12);
  const strategy = g.strategy.map(oneLine).filter((s) => s !== "");
  const text = clip(oneLine(g.gene.text), 400);
  const evidence = gateEvidence(g.gate);
  const validation = [gateCommand(g.gate)];
  const outcome = { status: "success", score: clamp01(g.score) };
  const file = strategyFilePath(g);
  const fileLines = strategy.length + 2;

  const gene = withAssetId({
    type: "Gene",
    schema_version: SCHEMA_VERSION,
    category: "optimize",
    signals_match: signals,
    summary: text,
    strategy,
    validation,
    model_name: g.modelName,
  });
  const capsule = withAssetId({
    type: "Capsule",
    schema_version: SCHEMA_VERSION,
    trigger: signals,
    gene: gene.asset_id,
    summary: clip(`${g.gene.domain} reasoning strategy, ${evidence}: ${text}`, 300),
    // The hub rejects a capsule without >= 50 chars of substance (content/strategy/diff/code_snippet).
    content: [
      `Strategy (${g.gene.domain}): ${text}`,
      "Steps:",
      ...strategy.map((s, i) => `${i + 1}. ${s}`),
      `Evidence: ${evidence}; accepted answers were reviewed by an independent re-solve before counting.`,
      `Scope: 1 file(s), ${fileLines} line(s): the strategy is applied by adding one strategy file to the agent's prompt strategy library; no code changes.`,
      "Changed files:",
      file,
      "Validation: the node command re-checks the recorded holdout numbers against the publish thresholds; the holdout run itself happened in Parallelize before publishing.",
    ]
      .join("\n")
      .slice(0, 8000),
    confidence: clamp01(g.confidence),
    // The hub requires files > 0 and lines > 0; the honest unit of change is the one strategy file described in content.
    blast_radius: { files: 1, lines: fileLines },
    outcome,
    env_fingerprint: envFingerprint(),
    success_streak: count(g.successStreak),
    validation,
    model_name: g.modelName,
  });
  const event = withAssetId({
    type: "EvolutionEvent",
    intent: "optimize",
    capsule_id: capsule.asset_id,
    genes_used: [gene.asset_id],
    outcome,
    mutations_tried: count(g.mutations),
    total_cycles: count(g.cycles),
    model_name: g.modelName,
    summary: evidence,
  });
  return { gene, capsule, event };
}

/** Local pre-flight mirroring the hub's documented shape rules, so a bad bundle never costs a request. */
export function bundleProblems(b: EvoMapBundle): string[] {
  const problems: string[] = [];
  const need = (ok: boolean, msg: string) => {
    if (!ok) problems.push(msg);
  };
  for (const [name, asset] of Object.entries(b)) {
    need(asset.asset_id === computeAssetId(asset), `${name}.asset_id does not match its content`);
  }
  need(b.capsule.gene === b.gene.asset_id, "capsule.gene must reference the gene asset_id");
  need(b.event.capsule_id === b.capsule.asset_id, "event.capsule_id must reference the capsule asset_id");
  need(strings(b.gene.signals_match, 3).length > 0, "gene.signals_match needs >= 1 signal of >= 3 chars");
  need(strings(b.capsule.trigger, 3).length > 0, "capsule.trigger needs >= 1 signal of >= 3 chars");
  need(textLen(b.gene.summary) >= 10, "gene.summary needs >= 10 chars");
  need(textLen(b.capsule.summary) >= 20, "capsule.summary needs >= 20 chars");
  need(textLen(b.capsule.content) >= 50, "capsule.content needs >= 50 chars of substance");
  const steps = Array.isArray(b.gene.strategy) ? b.gene.strategy : [];
  need(steps.length >= 2 && steps.every((s) => textLen(s) >= 15), "gene.strategy needs >= 2 steps of >= 15 chars");
  for (const name of ["gene", "capsule"] as const) {
    const cmds = Array.isArray(b[name].validation) ? (b[name].validation as unknown[]) : [];
    need(cmds.length > 0 && cmds.every(isSandboxCommand), `${name}.validation needs node/npm/npx commands of >= 10 chars without ; | & or $(`);
  }
  return problems;
}

function isSandboxCommand(c: unknown): boolean {
  return typeof c === "string" && c.length >= 10 && /^(node|npm|npx) /.test(c) && !/[;|&`\n]|\$\(/.test(c);
}

// ---------------------------------------------------------------- hits

export function hitToLibraryGene(hit: EvoMapGeneHit, domain: Domain, now: number): LibraryGene {
  const id = `evomap:${hit.assetId.replace(/^sha256:/, "").slice(0, 16)}`;
  return {
    id,
    kind: "solve",
    domain,
    text: `${hit.title}: ${hit.summary}`,
    origin: "evomap",
    lineageId: id,
    wins: 0,
    trials: 0,
    createdAt: now,
    source: "evomap",
    assetId: hit.assetId,
    evidence: { wins: 0, trials: 0 },
  };
}

function parseHit(v: unknown, baseUrl: string): EvoMapGeneHit | undefined {
  if (!isObj(v) || typeof v.asset_id !== "string" || !ASSET_ID_RE.test(v.asset_id)) return undefined;
  if (v.asset_type !== undefined && v.asset_type !== "Gene") return undefined;
  const payload = isObj(v.payload) ? v.payload : {};
  const trigger = typeof v.trigger_text === "string" ? v.trigger_text : undefined;
  const signals = Array.isArray(payload.signals_match) ? strings(payload.signals_match, 1) : (trigger?.split(",") ?? []);
  return {
    assetId: v.asset_id,
    // Newlines are collapsed so remote text cannot forge line-prefix markers (ANSWER:, STRATEGY:) in prompts.
    title: clip(firstText(v.short_title, payload.summary, trigger) ?? v.asset_id, 160),
    summary: clip(firstText(v.nl_summary, payload.summary, trigger) ?? "", 600),
    signals: signals.map((s) => clip(oneLine(s), 64)).filter((s) => s !== "").slice(0, 12),
    gdi: typeof v.gdi_score === "number" && Number.isFinite(v.gdi_score) ? v.gdi_score : 0,
    trustTier: firstText(v.trust_tier) ?? "unknown",
    // Built from the validated id rather than trusting a remote URL that the dashboard will render as a link.
    url: `${baseUrl}/asset/${v.asset_id}`,
  };
}

const STOPWORDS = new Set(
  "the and for with that this from into what when which how are was its not but use using task tasks answer problem solve about than then them they".split(" "),
);

export function searchKeywords(query: string): string[] {
  const words = query.toLowerCase().split(/[^\p{L}\p{N}]+/u);
  return [...new Set(words.filter((w) => w.length >= 3 && !STOPWORDS.has(w)))].slice(0, 6);
}

// ---------------------------------------------------------------- client

export class EvoMapClient {
  readonly baseUrl: string;
  readonly nodeFile: string;
  /** Last search failure (network, HTTP or degraded index), cleared by a search that saw no failure. */
  lastError: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly cache = new Map<string, { hits: EvoMapGeneHit[]; until: number }>();
  private registering: Promise<{ nodeId: string; claimUrl?: string; created: boolean }> | undefined;

  constructor(opts: EvoMapClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.EVOMAP_BASE_URL ?? EVOMAP_DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.nodeFile = resolve(opts.nodeFile ?? process.env.EVOMAP_NODE_FILE ?? join(homedir(), ".config", "parallelize", "evomap-node.json"));
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async search(query: string, opts: { limit?: number; minGdi?: number } = {}): Promise<EvoMapGeneHit[]> {
    const q = clip(oneLine(query), 300);
    if (q === "") return [];
    const limit = Math.max(1, Math.min(20, Math.floor(opts.limit ?? DEFAULT_SEARCH_LIMIT)));
    const minGdi = opts.minGdi;
    const key = `${q}␟${limit}␟${minGdi ?? ""}`;
    const cached = this.cache.get(key);
    if (cached && cached.until > Date.now()) return cached.hits.map(copyHit);

    const errors: string[] = [];
    const params = new URLSearchParams({ q, type: "Gene" });
    if (minGdi !== undefined) params.set("min_gdi", String(minGdi));
    let hits = await this.searchOnce("semantic-search", `/a2a/assets/semantic-search?${params}`, errors);
    const signals = searchKeywords(q);
    if (hits.length === 0 && signals.length > 0) {
      const found = await this.searchOnce("signals search", `/a2a/assets/search?${new URLSearchParams({ signals: signals.join(",") })}`, errors);
      // Signals search has no server-side quality floor.
      hits = minGdi === undefined ? found : found.filter((h) => h.gdi >= minGdi);
    }
    hits = hits.slice(0, limit);
    this.lastError = errors.length > 0 ? errors.join("; ") : undefined;
    const failed = errors.length > 0 && hits.length === 0;
    this.cache.set(key, { hits, until: failed ? Date.now() + SEARCH_FAILURE_COOLDOWN_MS : Number.POSITIVE_INFINITY });
    return hits.map(copyHit);
  }

  /** The registered node, without its secret. Undefined when missing or unreadable. */
  async node(): Promise<{ nodeId: string; claimUrl?: string } | undefined> {
    try {
      const cred = await this.readCredential();
      return cred ? publicNode(cred) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Registers this machine as an EvoMap node once; later calls return the stored node. */
  ensureNode(): Promise<{ nodeId: string; claimUrl?: string; created: boolean }> {
    this.registering ??= this.register().finally(() => {
      this.registering = undefined;
    });
    return this.registering;
  }

  buildBundle(g: EvoMapBundleInput): EvoMapBundle {
    return buildBundle(g);
  }

  /** Dry run of publish: same envelope, the hub only checks it. Uses a throwaway sender id when no node exists. */
  validate(bundle: EvoMapBundle): Promise<EvoMapSendResult> {
    return this.send("/a2a/validate", bundle, false);
  }

  publish(bundle: EvoMapBundle): Promise<EvoMapSendResult> {
    return this.send("/a2a/publish", bundle, true);
  }

  private async searchOnce(label: string, path: string, errors: string[]): Promise<EvoMapGeneHit[]> {
    let res: { status: number; json: unknown };
    try {
      res = await this.request("GET", path);
    } catch (err) {
      errors.push(`${label}: ${errorText(err)}`);
      return [];
    }
    const body = isObj(res.json) ? res.json : undefined;
    if (res.status < 200 || res.status >= 300) {
      errors.push(`${label}: HTTP ${res.status}${reasonSuffix(body)}`);
      return [];
    }
    if (!body || !Array.isArray(body.assets)) {
      errors.push(`${label}: unexpected response`);
      return [];
    }
    if (body.search_status === "degraded") {
      errors.push(`${label}: index degraded`);
      return [];
    }
    // Rows the hub itself calls weak evidence would only add noise to a stuck solver's prompt.
    if (body.search_status === "low_confidence_only") return [];
    return body.assets.map((a) => parseHit(a, this.baseUrl)).filter((h): h is EvoMapGeneHit => h !== undefined);
  }

  private async register(): Promise<{ nodeId: string; claimUrl?: string; created: boolean }> {
    const existing = await this.readCredential();
    if (existing) return { ...publicNode(existing), created: false };
    const unsafe = unsafeSecretLocation(this.nodeFile);
    if (unsafe) {
      throw new Error(`refusing to store the EvoMap node secret ${unsafe} (${this.nodeFile}); set EVOMAP_NODE_FILE to a private path`);
    }

    let res: { status: number; json: unknown };
    try {
      res = await this.request("POST", "/a2a/hello", envelope("hello", undefined, { capabilities: {}, env_fingerprint: envFingerprint() }));
    } catch (err) {
      throw new Error(`EvoMap hello failed: ${errorText(err)}`);
    }
    const payload = isObj(res.json) && isObj(res.json.payload) ? res.json.payload : undefined;
    // The hub answers a refusal with HTTP 200 too, so payload.status decides before the status code.
    if (payload?.status === "rejected") throw new Error(rejectionText(payload));
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`EvoMap hello failed with HTTP ${res.status}${reasonSuffix(isObj(res.json) ? res.json : undefined)}`);
    }
    if (
      payload?.status !== "acknowledged" ||
      typeof payload.your_node_id !== "string" ||
      !NODE_ID_RE.test(payload.your_node_id) ||
      typeof payload.node_secret !== "string" ||
      !SECRET_RE.test(payload.node_secret)
    ) {
      throw new Error("EvoMap hello reply was not an acknowledged registration with a node id and a 64-hex secret");
    }
    const claimUrl = httpUrl(payload.claim_url);
    const cred: NodeCredential = { nodeId: payload.your_node_id, secret: payload.node_secret, ...(claimUrl ? { claimUrl } : {}) };
    await writeCredential(this.nodeFile, cred, {
      hub_node_id: typeof payload.hub_node_id === "string" ? payload.hub_node_id : undefined,
      claim_code: typeof payload.claim_code === "string" ? payload.claim_code : undefined,
    });
    return { ...publicNode(cred), created: true };
  }

  private async send(path: string, bundle: EvoMapBundle, requireNode: boolean): Promise<EvoMapSendResult> {
    const assetIds = [bundle.gene.asset_id, bundle.capsule.asset_id, bundle.event.asset_id];
    const urls = assetIds.map((id) => `${this.baseUrl}/asset/${id}`);
    let secret: string | undefined;
    const fail = (status: string, error: string, warnings?: string[]): EvoMapSendResult => ({
      ok: false,
      status,
      assetIds,
      urls,
      error: redact(error, secret),
      ...(warnings && warnings.length > 0 ? { warnings } : {}),
    });

    const problems = bundleProblems(bundle);
    if (problems.length > 0) return fail("invalid", problems.join("; "));
    let cred: NodeCredential | undefined;
    try {
      cred = await this.readCredential();
    } catch (err) {
      return fail("no-node", errorText(err));
    }
    secret = cred?.secret;
    if (!cred && requireNode) return fail("no-node", "no EvoMap node registered; run `pnpm evomap node` and claim it first");

    const senderId = cred?.nodeId ?? `node_${randomBytes(8).toString("hex")}`;
    let res: { status: number; json: unknown };
    try {
      res = await this.request("POST", path, envelope("publish", senderId, { assets: [bundle.gene, bundle.capsule, bundle.event] }), secret);
    } catch (err) {
      return fail("network", errorText(err));
    }
    // The reply shape is undocumented: read the envelope payload first, then the top level.
    const body = isObj(res.json) ? res.json : {};
    const layers = isObj(body.payload) ? [body.payload, body] : [body];
    const pick = (...keys: string[]) => firstText(...layers.flatMap((l) => keys.map((k) => l[k])));
    const list = (key: string) => [...new Set(layers.flatMap((l) => messages(l[key])))];
    const status = pick("status", "decision", "error") ?? `http_${res.status}`;
    const warnings = list("quality_warnings").map((w) => redact(w, secret));
    const ok = res.status >= 200 && res.status < 300 && !REFUSED_STATUSES.has(status) && layers.every((l) => l.valid !== false);
    if (ok) return { ok, status, assetIds, urls, ...(warnings.length > 0 ? { warnings } : {}) };
    const details = [...new Set([pick("reason", "message", "error"), ...list("errors")].filter((d): d is string => d !== undefined))];
    return fail(status, details.length === 0 ? `HTTP ${res.status}` : clip(details.join("; "), 1000), warnings);
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown, secret?: string): Promise<{ status: number; json: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (secret !== undefined) headers.Authorization = `Bearer ${secret}`;
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      // Reading the body stays inside the timeout so a stalled stream cannot hang a run.
      const text = await res.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { status: res.status, json };
    } catch (err) {
      throw new Error(err instanceof Error && err.name === "AbortError" ? `timed out after ${this.timeoutMs}ms` : errorText(err));
    } finally {
      clearTimeout(timer);
    }
  }

  private async readCredential(): Promise<NodeCredential | undefined> {
    let text: string;
    try {
      text = await readFile(this.nodeFile, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(`cannot read the EvoMap node file ${this.nodeFile}`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      raw = undefined;
    }
    if (!isObj(raw) || typeof raw.node_id !== "string" || !NODE_ID_RE.test(raw.node_id) || typeof raw.node_secret !== "string" || !SECRET_RE.test(raw.node_secret)) {
      throw new Error(`the EvoMap node file ${this.nodeFile} is malformed; fix or remove it before registering again`);
    }
    const claimUrl = httpUrl(raw.claim_url);
    return { nodeId: raw.node_id, secret: raw.node_secret, ...(claimUrl ? { claimUrl } : {}) };
  }
}

// ---------------------------------------------------------------- node credential file

async function writeCredential(file: string, cred: NodeCredential, extra: Record<string, string | undefined>): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const record = {
    node_id: cred.nodeId,
    node_secret: cred.secret,
    claim_url: cred.claimUrl,
    ...extra,
    created_at: new Date().toISOString(),
  };
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  // "wx" refuses to follow a pre-planted file or symlink at the temp path.
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(tmp, file);
}

/** The node secret must stay out of any git repository and cloud-synced folder (EvoMap hello guidance). */
export function unsafeSecretLocation(file: string): string | undefined {
  const abs = resolve(file);
  if (isInside(abs, PROJECT_ROOT)) return "inside the project repository";
  const home = homedir();
  const synced = ["Library/Mobile Documents", "Library/CloudStorage", "iCloud Drive", "Dropbox", "OneDrive", "Google Drive"];
  if (synced.some((d) => isInside(abs, join(home, d)))) return "inside a cloud-synced folder";
  for (let dir = dirname(abs); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return `inside the git repository at ${dir}`;
    if (dirname(dir) === dir) return undefined;
  }
}

function isInside(file: string, dir: string): boolean {
  const rel = relative(dir, file);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// ---------------------------------------------------------------- helpers

function envelope(messageType: string, senderId: string | undefined, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    protocol: "gep-a2a",
    protocol_version: "1.0.0",
    message_type: messageType,
    message_id: `msg_${Date.now()}_${randomBytes(4).toString("hex")}`,
    ...(senderId === undefined ? {} : { sender_id: senderId }),
    timestamp: new Date().toISOString(),
    payload,
  };
}

function publicNode(cred: NodeCredential): { nodeId: string; claimUrl?: string } {
  return cred.claimUrl ? { nodeId: cred.nodeId, claimUrl: cred.claimUrl } : { nodeId: cred.nodeId };
}

function rejectionText(payload: Record<string, unknown>): string {
  const parts = [`EvoMap refused node registration: ${firstText(payload.reason) ?? "no reason given"}`];
  if (typeof payload.retry_after_ms === "number" && payload.retry_after_ms > 0) {
    parts.push(`retry after ${Math.ceil(payload.retry_after_ms / 1000)}s`);
  }
  if (payload.captcha_required === true) parts.push("captcha required (tied to an abuse signal, not a transient error)");
  return redact(parts.join("; "));
}

function reasonSuffix(body: Record<string, unknown> | undefined): string {
  const reason = body ? firstText(body.reason, body.error, body.message) : undefined;
  return reason ? ` (${redact(clip(reason, 200))})` : "";
}

/** Strips any 64-hex run that is not an asset id, plus the known secret, from text leaving this module. */
function redact(text: string, secret?: string): string {
  const out = secret ? text.split(secret).join("[redacted]") : text;
  return out.replace(/(?<!sha256:)\b[0-9a-f]{64}\b/gi, "[redacted]");
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const code = (err.cause as { code?: unknown } | undefined)?.code;
    return redact(typeof code === "string" ? `${err.message} (${code})` : err.message);
  }
  return redact(String(err));
}

function messages(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((m) => (typeof m === "string" ? m : isObj(m) ? firstText(m.message, m.code, m.error, m.field) : undefined))
    .filter((m): m is string => m !== undefined)
    .map((m) => clip(oneLine(m), 200))
    .slice(0, 10);
}

function httpUrl(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

function firstText(...vs: unknown[]): string | undefined {
  for (const v of vs) {
    if (typeof v === "string" && v.trim() !== "") return oneLine(v);
  }
  return undefined;
}

function strings(v: unknown, minLen: number): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.trim().length >= minLen) : [];
}

function textLen(v: unknown): number {
  return typeof v === "string" ? v.trim().length : 0;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

function count(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
}

function copyHit(h: EvoMapGeneHit): EvoMapGeneHit {
  return { ...h, signals: [...h.signals] };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
