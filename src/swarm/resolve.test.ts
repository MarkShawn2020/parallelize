import { describe, expect, it } from "vitest";
import { LineageGraph } from "../core/lineage";
import type { Proposal, TaskEntry } from "../core/types";
import { normalizeAnswer } from "../tasks/check";
import { resolveAfterProposal } from "./resolve";

const TASK = { id: "t1", domain: "arithmetic" as const, prompt: "2+2?" };

function setup(specs: Array<{ id: string; cell: string; answer: string; saw?: string[] }>, attempts = specs.length) {
  const lineage = new LineageGraph();
  lineage.add({ id: "task:t1", kind: "task", taskId: "t1", parents: [], at: 0 });
  const proposals: Proposal[] = specs.map((s, i) => {
    lineage.add({ id: s.id, kind: "proposal", cellId: s.cell, taskId: "t1", parents: ["task:t1", ...(s.saw ?? [])], at: i });
    return { id: s.id, taskId: "t1", cellId: s.cell, answer: s.answer, summary: "", at: i };
  });
  const entry: TaskEntry = {
    task: TASK,
    status: "claimed",
    attempts,
    proposals,
    proposers: [...new Set(specs.map((s) => s.cell))],
  };
  return { entry, lineage };
}

const opts = (needsVerification = false, maxAttempts = 4) => ({ needsVerification, maxAttempts, normalize: normalizeAnswer });

describe("resolveAfterProposal", () => {
  it("accepts a lone proposal unless verification is needed", () => {
    const { entry, lineage } = setup([{ id: "p1", cell: "a", answer: "4" }]);
    expect(resolveAfterProposal(entry, lineage, opts(false))).toEqual({
      kind: "accept",
      answer: "4",
      proposalIds: ["p1"],
      independentSources: 1,
    });
    expect(resolveAfterProposal(entry, lineage, opts(true))).toEqual({ kind: "verify" });
  });

  it("accepts a lone proposal needing verification once attempts are exhausted", () => {
    const { entry, lineage } = setup([{ id: "p1", cell: "a", answer: "4" }], 4);
    expect(resolveAfterProposal(entry, lineage, opts(true))).toMatchObject({ kind: "accept", independentSources: 1 });
  });

  it("accepts two independent agreeing proposals, matching on the normalized answer", () => {
    const { entry, lineage } = setup([
      { id: "p1", cell: "a", answer: "1,250" },
      { id: "p2", cell: "b", answer: "1250.0" },
    ]);
    expect(resolveAfterProposal(entry, lineage, opts())).toEqual({
      kind: "accept",
      answer: "1250",
      proposalIds: ["p1", "p2"],
      independentSources: 2,
    });
  });

  it("flags an echo when agreement comes from one lineage root", () => {
    const { entry, lineage } = setup([
      { id: "p1", cell: "a", answer: "5" },
      { id: "p2", cell: "b", answer: "5", saw: ["p1"] },
    ]);
    expect(resolveAfterProposal(entry, lineage, opts())).toEqual({
      kind: "echo",
      answer: "5",
      proposalIds: ["p1", "p2"],
      agreeing: 2,
      independentSources: 1,
    });
  });

  it("asks for another solve on disagreement, and accepts the best group once attempts run out", () => {
    const { entry, lineage } = setup([
      { id: "p1", cell: "a", answer: "5" },
      { id: "p2", cell: "b", answer: "4" },
    ]);
    expect(resolveAfterProposal(entry, lineage, opts())).toEqual({ kind: "verify" });
    entry.attempts = 4;
    // Tie on sources and size: the earliest group wins.
    expect(resolveAfterProposal(entry, lineage, opts())).toMatchObject({ kind: "accept", answer: "5", independentSources: 1 });
  });

  it("prefers more independent sources over a larger echoing group", () => {
    const { entry, lineage } = setup([
      { id: "p1", cell: "a", answer: "5" },
      { id: "p2", cell: "b", answer: "5", saw: ["p1"] },
      { id: "p3", cell: "c", answer: "5", saw: ["p1"] },
      { id: "p4", cell: "d", answer: "4" },
      { id: "p5", cell: "e", answer: "4" },
    ]);
    expect(resolveAfterProposal(entry, lineage, opts())).toMatchObject({ kind: "accept", answer: "4", independentSources: 2 });
  });

  it("counts an independent solver agreeing with an echo group as a second source", () => {
    const { entry, lineage } = setup([
      { id: "p1", cell: "a", answer: "5" },
      { id: "p2", cell: "b", answer: "5", saw: ["p1"] },
      { id: "p3", cell: "c", answer: "5" },
    ]);
    expect(resolveAfterProposal(entry, lineage, opts())).toEqual({
      kind: "accept",
      answer: "5",
      proposalIds: ["p1", "p2", "p3"],
      independentSources: 2,
    });
  });

  it("ignores empty answers: verify while attempts remain, then fail", () => {
    const { entry, lineage } = setup([{ id: "p1", cell: "a", answer: "" }]);
    expect(resolveAfterProposal(entry, lineage, opts())).toEqual({ kind: "verify" });
    entry.attempts = 4;
    expect(resolveAfterProposal(entry, lineage, opts())).toEqual({ kind: "fail" });
  });

  it("does not let an empty second answer count as disagreement", () => {
    const { entry, lineage } = setup(
      [
        { id: "p1", cell: "a", answer: "7" },
        { id: "p2", cell: "b", answer: " " },
      ],
      4,
    );
    expect(resolveAfterProposal(entry, lineage, opts())).toMatchObject({ kind: "accept", answer: "7", proposalIds: ["p1"] });
  });
});
