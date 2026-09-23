import { hashString } from "../core/rng";
import type { ProtocolMessage, ProtocolType } from "../core/types";
import { shortModel } from "./registry";

export const PROTOCOL_VERSION = 1;
export const MAX_BODY_BYTES = 8 * 1024;
export const MAX_ID_CHARS = 128;
export const MAX_PARENTS = 64;
const DESCRIBE_MAX_CHARS = 90;
const TOKEN_MAX_CHARS = 40;

/** The only acceptors of shared state. Agents address them by these names in `to`. */
export const SERVICE = { board: "board", registry: "registry", library: "library" } as const;
export const BROADCAST = "*";

export type FieldKind = "string" | "number" | "string[]" | "object";

/** Required body fields per type (PROTOCOL.md mirrors this table). Other body fields are optional. */
export const BODY_SCHEMA: Readonly<Record<ProtocolType, Readonly<Record<string, FieldKind>>>> = {
  ANNOUNCE: { card: "object" },
  HEARTBEAT: {},
  DISCOVER: { limit: "number" },
  CLAIM: { taskId: "string" },
  PROPOSE: { taskId: "string", proposalId: "string", answer: "string", summary: "string" },
  REVIEW_REQUEST: { taskId: "string", reason: "string" },
  ACCEPT: { taskId: "string", answer: "string", proposalIds: "string[]", independentSources: "number" },
  ECHO_ALARM: { taskId: "string", proposalIds: "string[]", agreeing: "number", independentSources: "number" },
  GENE_OFFER: { geneId: "string", domain: "string", text: "string" },
  GENE_ADOPT: { geneId: "string", domain: "string" },
  GENE_REJECT: { geneId: "string", reason: "string" },
  LIBRARY_QUERY: { taskId: "string", domain: "string" },
  LIBRARY_RESULT: { taskId: "string", source: "string", geneIds: "string[]" },
  QUARANTINE: { agentId: "string", trust: "number", reason: "string" },
  DENIED: { action: "string", reason: "string" },
};

export const PROTOCOL_TYPES = Object.keys(BODY_SCHEMA) as readonly ProtocolType[];

let counter = 0;

export function createMessage(p: {
  runId: string;
  type: ProtocolType;
  from: string;
  to: string;
  parents?: string[];
  body?: Record<string, unknown>;
  at: number;
  id?: string;
}): ProtocolMessage {
  counter++;
  return {
    v: PROTOCOL_VERSION,
    id: p.id ?? `${p.type.toLowerCase()}-${hashString(p.runId).toString(36)}-${counter}`,
    runId: p.runId,
    type: p.type,
    from: p.from,
    to: p.to,
    parents: [...(p.parents ?? [])],
    at: p.at,
    body: { ...p.body },
  };
}

function fail(reason: string): never {
  throw new Error(`invalid protocol message: ${reason}`);
}

function preview(x: unknown): string {
  try {
    const s = JSON.stringify(x);
    return s === undefined ? typeof x : s.slice(0, 40);
  } catch {
    return typeof x;
  }
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  const proto: unknown = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

// Control characters would let a remote agent forge extra lines in logs and the dashboard trace.
const CONTROL = /[\u0000-\u001f\u007f]/;

function checkId(value: unknown, field: string): string {
  if (typeof value !== "string") return fail(`${field} must be a string, got ${preview(value)}`);
  if (value.length === 0 || value.length > MAX_ID_CHARS) fail(`${field} must be 1-${MAX_ID_CHARS} chars`);
  if (CONTROL.test(value)) fail(`${field} contains control characters`);
  return value;
}

function hasKind(v: unknown, kind: FieldKind): boolean {
  switch (kind) {
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "string[]":
      return Array.isArray(v) && v.every((s) => typeof s === "string");
    case "object":
      return isPlainObject(v);
  }
}

/**
 * Boundary check for messages from an untrusted transport. Returns a fresh canonical copy:
 * unknown top-level fields are dropped and the body is a JSON round-trip, so no caller aliasing survives.
 */
export function validateMessage(raw: unknown): ProtocolMessage {
  if (!isPlainObject(raw)) return fail("not a JSON object");
  if (raw.v !== PROTOCOL_VERSION) fail(`unsupported version ${preview(raw.v)} (expected ${PROTOCOL_VERSION})`);
  const type = raw.type;
  if (typeof type !== "string" || !Object.hasOwn(BODY_SCHEMA, type)) return fail(`unknown type ${preview(type)}`);
  const id = checkId(raw.id, "id");
  const runId = checkId(raw.runId, "runId");
  const from = checkId(raw.from, "from");
  const to = checkId(raw.to, "to");

  if (!Array.isArray(raw.parents)) return fail("parents must be an array of ids");
  if (raw.parents.length > MAX_PARENTS) fail(`more than ${MAX_PARENTS} parents`);
  const parents = raw.parents.map((p, i) => checkId(p, `parents[${i}]`));

  if (typeof raw.at !== "number" || !Number.isFinite(raw.at)) return fail(`at must be a finite number, got ${preview(raw.at)}`);
  const at = raw.at;

  if (!isPlainObject(raw.body)) return fail("body must be a plain JSON object");
  let json: string;
  try {
    json = JSON.stringify(raw.body);
  } catch {
    return fail("body is not JSON-serialisable");
  }
  const bytes = new TextEncoder().encode(json).length;
  if (bytes > MAX_BODY_BYTES) fail(`body is ${bytes} bytes (max ${MAX_BODY_BYTES})`);
  const body = JSON.parse(json) as Record<string, unknown>;

  const t = type as ProtocolType;
  for (const [field, kind] of Object.entries(BODY_SCHEMA[t])) {
    if (!hasKind(body[field], kind)) fail(`${t} body.${field} must be ${kind}, got ${preview(body[field])}`);
  }

  return { v: PROTOCOL_VERSION, id, runId, type: t, from, to, parents, at, body };
}

function clean(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > TOKEN_MAX_CHARS ? `${one.slice(0, TOKEN_MAX_CHARS - 1)}…` : one;
}

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** One deterministic line for the dashboard trace, e.g. "board → * ECHO_ALARM t007 (1 source / 3 agreeing)". */
export function describeMessage(m: ProtocolMessage): string {
  const b = m.body;
  const str = (k: string): string | undefined => {
    const v = b[k];
    return typeof v === "string" && v.trim() !== "" ? clean(v) : undefined;
  };
  const num = (k: string): number | undefined => {
    const v = b[k];
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  };
  const card = b.card;
  const model = isPlainObject(card) && typeof card.model === "string" && card.model !== "" ? clean(shortModel(card.model)) : undefined;

  const tokens = [str("action"), str("agentId"), str("taskId"), str("domain") ?? str("geneId"), model];

  const notes: string[] = [];
  const sources = num("independentSources");
  const agreeing = num("agreeing");
  if (sources !== undefined) notes.push(plural(sources, "source") + (agreeing === undefined ? "" : ` / ${agreeing} agreeing`));
  const trust = num("trust");
  if (trust !== undefined) notes.push(`trust ${trust.toFixed(2)}`);
  if (Array.isArray(b.geneIds)) notes.push(plural(b.geneIds.length, "gene"));
  const source = str("source");
  if (source !== undefined) notes.push(source);
  const reason = str("reason");
  if (reason !== undefined) notes.push(reason);

  const head = [`${clean(m.from)} → ${clean(m.to)} ${m.type}`, ...tokens.filter((t) => t !== undefined)];
  if (notes.length > 0) head.push(`(${notes.join("; ")})`);
  const line = head.join(" ");
  return line.length > DESCRIBE_MAX_CHARS ? `${line.slice(0, DESCRIBE_MAX_CHARS - 1)}…` : line;
}
