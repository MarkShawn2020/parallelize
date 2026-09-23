import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ProtocolMessage, ProtocolType } from "../core/types";
import {
  BODY_SCHEMA,
  MAX_BODY_BYTES,
  MAX_ID_CHARS,
  MAX_PARENTS,
  PROTOCOL_TYPES,
  SERVICE,
  createMessage,
  describeMessage,
  validateMessage,
} from "./messages";

const RUN = "swarm-jev-20260923-143012-ab12";

const wire = (m: unknown): unknown => JSON.parse(JSON.stringify(m));

function valid(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    id: "claim-x-1",
    runId: RUN,
    type: "CLAIM",
    from: "c03",
    to: "board",
    parents: ["t012"],
    at: 1_790_000_000_000,
    body: { taskId: "t012" },
    ...over,
  };
}

const msg = (type: ProtocolType, from: string, to: string, body: Record<string, unknown>): ProtocolMessage =>
  createMessage({ runId: RUN, type, from, to, body, at: 0 });

describe("createMessage", () => {
  it("fills defaults and derives a unique id from type, run hash and counter", () => {
    const a = createMessage({ runId: RUN, type: "GENE_OFFER", from: "c05", to: "c02", at: 5 });
    const b = createMessage({ runId: RUN, type: "GENE_OFFER", from: "c05", to: "c02", at: 5 });
    expect(a).toMatchObject({ v: 1, runId: RUN, type: "GENE_OFFER", from: "c05", to: "c02", parents: [], body: {}, at: 5 });
    expect(a.id).toMatch(/^gene_offer-[0-9a-z]+-\d+$/);
    expect(a.id).not.toBe(b.id);
    const other = createMessage({ runId: "another-run", type: "GENE_OFFER", from: "c05", to: "c02", at: 5 });
    expect(other.id.split("-")[1]).not.toBe(a.id.split("-")[1]);
  });

  it("keeps an explicit id and does not alias parents or body", () => {
    const parents = ["t001"];
    const body = { taskId: "t001" };
    const m = createMessage({ runId: RUN, type: "CLAIM", from: "c01", to: SERVICE.board, parents, body, at: 1, id: "m0001" });
    parents.push("x");
    body.taskId = "changed";
    expect(m.id).toBe("m0001");
    expect(m.parents).toEqual(["t001"]);
    expect(m.body).toEqual({ taskId: "t001" });
  });

  it("produces messages that survive the wire and validate", () => {
    const m = createMessage({ runId: RUN, type: "PROPOSE", from: "c03", to: "board", parents: ["t012"], at: 9, body: { taskId: "t012", proposalId: "p1", answer: "42", summary: "s" } });
    expect(validateMessage(wire(m))).toEqual(m);
  });
});

describe("validateMessage", () => {
  it("returns a canonical copy: unknown top-level fields dropped, body deep-copied", () => {
    const raw = valid({ extra: "ignored", body: { taskId: "t012", nested: { a: [1] } } });
    const m = validateMessage(raw);
    expect(m).not.toHaveProperty("extra");
    (raw.body as { nested: { a: number[] } }).nested.a.push(2);
    expect(m.body).toEqual({ taskId: "t012", nested: { a: [1] } });
  });

  it("rejects non-objects and wrong versions", () => {
    for (const raw of [null, undefined, "msg", 3, [valid()], new Date()]) {
      expect(() => validateMessage(raw)).toThrow(/not a JSON object/);
    }
    expect(() => validateMessage(valid({ v: 2 }))).toThrow(/unsupported version 2/);
    expect(() => validateMessage(valid({ v: "1" }))).toThrow(/unsupported version/);
  });

  it("rejects unknown types, including inherited property names", () => {
    for (const type of ["HACK", "claim", "toString", "__proto__", "constructor", 7]) {
      expect(() => validateMessage(valid({ type }))).toThrow(/unknown type/);
    }
  });

  it("bounds ids: string, 1-128 chars, no control characters", () => {
    expect(() => validateMessage(valid({ id: 42 }))).toThrow(/id must be a string/);
    expect(() => validateMessage(valid({ id: "" }))).toThrow(/id must be 1-128/);
    expect(() => validateMessage(valid({ from: "x".repeat(MAX_ID_CHARS + 1) }))).toThrow(/from must be 1-128/);
    expect(validateMessage(valid({ to: "x".repeat(MAX_ID_CHARS) })).to).toHaveLength(MAX_ID_CHARS);
    expect(() => validateMessage(valid({ runId: "run\nFAKE LINE" }))).toThrow(/runId contains control/);
    expect(() => validateMessage(valid({ runId: undefined }))).toThrow(/runId must be a string/);
  });

  it("rejects bad parents", () => {
    expect(() => validateMessage(valid({ parents: "t012" }))).toThrow(/parents must be an array/);
    expect(() => validateMessage(valid({ parents: ["t012", 5] }))).toThrow(/parents\[1\] must be a string/);
    expect(() => validateMessage(valid({ parents: [""] }))).toThrow(/parents\[0\] must be 1-128/);
    expect(() => validateMessage(valid({ parents: Array.from({ length: MAX_PARENTS + 1 }, (_, i) => `p${i}`) }))).toThrow(/more than 64 parents/);
    expect(validateMessage(valid({ parents: [] })).parents).toEqual([]);
  });

  it("requires a finite at", () => {
    for (const at of [Number.NaN, Number.POSITIVE_INFINITY, "1790000000000", null]) {
      expect(() => validateMessage(valid({ at }))).toThrow(/at must be a finite number/);
    }
  });

  it("requires a plain-object, JSON-serialisable body", () => {
    for (const body of [null, [], "x", new Map()]) {
      expect(() => validateMessage(valid({ body }))).toThrow(/body must be a plain JSON object/);
    }
    expect(() => validateMessage(valid({ body: { taskId: "t1", n: 1n } }))).toThrow(/not JSON-serialisable/);
    const circular: Record<string, unknown> = { taskId: "t1" };
    circular.self = circular;
    expect(() => validateMessage(valid({ body: circular }))).toThrow(/not JSON-serialisable/);
  });

  it("caps the body at 8 KB of UTF-8, counting bytes rather than characters", () => {
    const overhead = JSON.stringify({ taskId: "t012", pad: "" }).length;
    const exact = { taskId: "t012", pad: "a".repeat(MAX_BODY_BYTES - overhead) };
    expect(validateMessage(valid({ body: exact })).body).toEqual(exact);
    expect(() => validateMessage(valid({ body: { ...exact, pad: `${exact.pad}a` } }))).toThrow(/8193 bytes \(max 8192\)/);
    // 3000 CJK characters are 9000 bytes: under the limit in chars, over it in bytes.
    expect(() => validateMessage(valid({ body: { taskId: "t012", pad: "中".repeat(3000) } }))).toThrow(/bytes \(max 8192\)/);
  });

  it("enforces required body fields and their JSON types", () => {
    expect(() => validateMessage(valid({ body: {} }))).toThrow(/CLAIM body.taskId must be string/);
    expect(() =>
      validateMessage(valid({ type: "PROPOSE", body: { taskId: "t1", proposalId: "p1", answer: "42" } })),
    ).toThrow(/PROPOSE body.summary must be string/);
    const echo = { taskId: "t7", proposalIds: ["p1", "p2"], agreeing: 2, independentSources: 1 };
    expect(validateMessage(valid({ type: "ECHO_ALARM", body: echo })).body).toEqual(echo);
    expect(() => validateMessage(valid({ type: "ECHO_ALARM", body: { ...echo, agreeing: "2" } }))).toThrow(/agreeing must be number/);
    expect(() => validateMessage(valid({ type: "ECHO_ALARM", body: { ...echo, agreeing: Number.NaN } }))).toThrow(/agreeing must be number/);
    expect(() => validateMessage(valid({ type: "ECHO_ALARM", body: { ...echo, proposalIds: ["p1", 2] } }))).toThrow(/proposalIds must be string\[\]/);
    expect(() => validateMessage(valid({ type: "ANNOUNCE", body: { card: [] } }))).toThrow(/card must be object/);
    expect(validateMessage(valid({ type: "HEARTBEAT", body: {} })).type).toBe("HEARTBEAT");
  });

  it("covers every protocol type with a schema", () => {
    expect(PROTOCOL_TYPES).toHaveLength(15);
    expect(new Set(PROTOCOL_TYPES).size).toBe(15);
  });
});

describe("describeMessage", () => {
  it("renders the dashboard trace lines", () => {
    expect(describeMessage(msg("CLAIM", "c03", SERVICE.board, { taskId: "t012" }))).toBe("c03 → board CLAIM t012");
    expect(describeMessage(msg("GENE_OFFER", "c05", "c02", { geneId: "g0020", domain: "arithmetic", text: "x" }))).toBe(
      "c05 → c02 GENE_OFFER arithmetic",
    );
    expect(
      describeMessage(msg("ECHO_ALARM", "board", "*", { taskId: "t007", proposalIds: ["a", "b", "c"], agreeing: 3, independentSources: 1 })),
    ).toBe("board → * ECHO_ALARM t007 (1 source / 3 agreeing)");
    expect(describeMessage(msg("DENIED", "board", "c04", { action: "propose", reason: "no lease" }))).toBe(
      "board → c04 DENIED propose (no lease)",
    );
  });

  it("uses the other body fields when present", () => {
    expect(describeMessage(msg("ACCEPT", "board", "*", { taskId: "t012", answer: "42", proposalIds: ["a", "b"], independentSources: 2 }))).toBe(
      "board → * ACCEPT t012 (2 sources)",
    );
    expect(describeMessage(msg("GENE_REJECT", "c02", "c05", { geneId: "g0020", reason: "recollision" }))).toBe(
      "c02 → c05 GENE_REJECT g0020 (recollision)",
    );
    expect(describeMessage(msg("QUARANTINE", "registry", "*", { agentId: "c04", trust: 0.214, reason: "low trust" }))).toBe(
      "registry → * QUARANTINE c04 (trust 0.21; low trust)",
    );
    expect(describeMessage(msg("LIBRARY_RESULT", "library", "c03", { taskId: "t019", source: "evomap", geneIds: ["g1"] }))).toBe(
      "library → c03 LIBRARY_RESULT t019 (1 gene; evomap)",
    );
    expect(describeMessage(msg("ANNOUNCE", "c06", "registry", { card: { agentId: "c06", model: "openai/gpt-4o-mini" } }))).toBe(
      "c06 → registry ANNOUNCE gpt-4o-mini",
    );
    expect(describeMessage(msg("HEARTBEAT", "c01", "registry", {}))).toBe("c01 → registry HEARTBEAT");
  });

  it("ignores wrongly typed fields and stays one short line", () => {
    expect(describeMessage(msg("CLAIM", "c03", "board", { taskId: 12, reason: "  " }))).toBe("c03 → board CLAIM");
    const long = describeMessage(msg("DENIED", "board", "c04", { action: "propose", taskId: "t012", reason: `no\nlease ${"x".repeat(200)}` }));
    expect(long.length).toBeLessThanOrEqual(90);
    expect(long).not.toContain("\n");
    expect(long).toMatch(/^board → c04 DENIED propose t012 \(no lease x+…\)$/);
    const huge = describeMessage(msg("CLAIM", "a".repeat(128), "b".repeat(128), { taskId: "t1" }));
    expect(huge.length).toBe(90);
    expect(huge.endsWith("…")).toBe(true);
  });
});

describe("PROTOCOL.md", () => {
  const spec = readFileSync(new URL("../../PROTOCOL.md", import.meta.url), "utf8");
  const blocks = [...spec.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1] as string) as Record<string, unknown>);

  it("has a valid envelope example", () => {
    const envelope = blocks.find((b) => b.v === 1);
    expect(envelope).toBeDefined();
    expect(() => validateMessage(envelope)).not.toThrow();
  });

  it("has a valid example body for every type", () => {
    const bodies = blocks.find((b) => Object.hasOwn(b, "ANNOUNCE") && Object.hasOwn(b, "DENIED"));
    expect(Object.keys(bodies ?? {}).sort()).toEqual([...PROTOCOL_TYPES].sort());
    for (const type of PROTOCOL_TYPES) {
      const body = bodies?.[type] as Record<string, unknown>;
      expect(() => validateMessage(wire(createMessage({ runId: RUN, type, from: "c01", to: "board", body, at: 0 })))).not.toThrow();
    }
  });

  it("lists every required body field in the message table", () => {
    for (const type of PROTOCOL_TYPES) {
      const row = spec.split("\n").find((l) => l.startsWith(`| \`${type}\` |`));
      expect(row, type).toBeDefined();
      const required = row?.split("|")[3] ?? "";
      for (const field of Object.keys(BODY_SCHEMA[type])) expect(required, `${type}.${field}`).toContain(`\`${field}\``);
    }
  });
});
