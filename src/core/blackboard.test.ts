import { describe, expect, it } from "vitest";
import { InMemoryBlackboard } from "./blackboard";
import type { Proposal, PublicTask } from "./types";

const LEASE = 1000;
const tasks: PublicTask[] = ["t1", "t2", "t3"].map((id) => ({ id, domain: "arithmetic", prompt: `solve ${id}` }));
const board = () => new InMemoryBlackboard(tasks, { leaseMs: LEASE });
const proposal = (taskId: string, cellId: string, id = `${taskId}-${cellId}`): Proposal => ({
  id,
  taskId,
  cellId,
  answer: "42",
  summary: "did it",
  at: 0,
});
const ids = (entries: { task: PublicTask }[]) => entries.map((e) => e.task.id);
const expectUnclaimed = (b: InMemoryBlackboard, taskId: string) => {
  const e = b.get(taskId);
  expect(e).toBeDefined();
  expect(e).not.toHaveProperty("claimedBy");
  expect(e).not.toHaveProperty("leaseUntil");
};

describe("InMemoryBlackboard", () => {
  it("starts with every task open and claimable in original order", () => {
    const b = board();
    expect(ids(b.claimable(0))).toEqual(["t1", "t2", "t3"]);
    expect(b.all().every((e) => e.status === "open" && e.attempts === 0)).toBe(true);
    expect(b.done()).toBe(false);
  });

  it("rejects duplicate task ids", () => {
    expect(() => new InMemoryBlackboard([...tasks, tasks[0]!], { leaseMs: LEASE })).toThrow(/duplicate/);
  });

  it("claims an open task and sets lease and attempts", () => {
    const b = board();
    expect(b.claim("t1", "c1", 100)).toBe(true);
    expect(b.get("t1")).toMatchObject({ status: "claimed", claimedBy: "c1", leaseUntil: 1100, attempts: 1 });
    expect(ids(b.claimable(100))).toEqual(["t2", "t3"]);
  });

  it("lets exactly one cell win a claim race and forbids double-claim", () => {
    const b = board();
    const wins = ["c1", "c2", "c3"].map((c) => b.claim("t1", c, 0));
    expect(wins).toEqual([true, false, false]);
    expect(b.claim("t1", "c1", 10)).toBe(false);
    expect(b.get("t1")).toMatchObject({ claimedBy: "c1", attempts: 1 });
  });

  it("renews only a live lease held by the caller", () => {
    const b = board();
    b.claim("t1", "c1", 0);
    expect(b.renew("t1", "c2", 500)).toBe(false);
    expect(b.renew("t1", "c1", 500)).toBe(true);
    expect(b.get("t1")?.leaseUntil).toBe(1500);
    expect(b.renew("t1", "c1", 1500)).toBe(false);
    expect(b.renew("t2", "c1", 0)).toBe(false);
  });

  it("release returns a claimed task to open, or to verifying when proposals exist", () => {
    const b = board();
    b.claim("t1", "c1", 0);
    b.release("t1", "c2");
    expect(b.get("t1")?.claimedBy).toBe("c1");
    b.release("t1", "c1");
    expect(b.get("t1")?.status).toBe("open");
    expectUnclaimed(b, "t1");

    b.claim("t2", "c1", 0);
    b.propose(proposal("t2", "c1"));
    b.release("t2", "c1");
    expect(b.get("t2")?.status).toBe("verifying");
    expectUnclaimed(b, "t2");
  });

  it("propose keeps the proposer's lease and dedupes proposers", () => {
    const b = board();
    b.claim("t1", "c1", 0);
    b.propose(proposal("t1", "c1", "p1"));
    b.propose(proposal("t1", "c1", "p2"));
    const e = b.get("t1")!;
    expect(e).toMatchObject({ status: "claimed", claimedBy: "c1", leaseUntil: 1000, proposers: ["c1"] });
    expect(e.proposals.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(b.claim("t1", "c2", 10)).toBe(false);
  });

  it("requestVerification excludes proposers and admits a different verifier", () => {
    const b = board();
    b.claim("t1", "c1", 0);
    b.propose(proposal("t1", "c1"));
    b.requestVerification("t1");
    expect(b.get("t1")?.status).toBe("verifying");
    expectUnclaimed(b, "t1");

    expect(b.claim("t1", "c1", 10)).toBe(false);
    expect(b.claim("t1", "c2", 10)).toBe(true);
    expect(b.get("t1")).toMatchObject({ status: "verifying", claimedBy: "c2", attempts: 2 });
    expect(b.claim("t1", "c3", 20)).toBe(false);
    expect(ids(b.claimable(20))).not.toContain("t1");

    b.propose(proposal("t1", "c2"));
    expect(b.get("t1")?.proposers).toEqual(["c1", "c2"]);
    b.release("t1", "c2");
    expect(b.get("t1")?.status).toBe("verifying");
    expect(b.claim("t1", "c2", 30)).toBe(false);
    expect(b.claim("t1", "c3", 30)).toBe(true);
  });

  it("orders claimable: verifying first, then fewest attempts, then original order", () => {
    const b = board();
    b.claim("t1", "c1", 0);
    b.release("t1", "c1");
    b.claim("t3", "c1", 0);
    b.propose(proposal("t3", "c1"));
    b.requestVerification("t3");
    // t3 verifying (1 attempt), t2 open (0), t1 open (1)
    expect(ids(b.claimable(0))).toEqual(["t3", "t2", "t1"]);
  });

  it("sweep reopens an expired claim without proposals as open", () => {
    const b = board();
    b.claim("t1", "dead", 0);
    expect(b.sweep(999)).toEqual([]);
    expect(b.sweep(1000)).toEqual(["t1"]);
    expect(b.get("t1")?.status).toBe("open");
    expectUnclaimed(b, "t1");
    expect(ids(b.claimable(1000))).toContain("t1");
    expect(b.sweep(5000)).toEqual([]);
  });

  it("sweep moves a dead proposer's task to verifying and keeps it excluded", () => {
    const b = board();
    b.claim("t1", "dead", 0);
    b.propose(proposal("t1", "dead"));
    expect(ids(b.claimable(500))).not.toContain("t1");
    expect(b.sweep(1000)).toEqual(["t1"]);
    expect(b.get("t1")?.status).toBe("verifying");
    expectUnclaimed(b, "t1");
    expect(ids(b.claimable(1000))[0]).toBe("t1");
    expect(b.claim("t1", "dead", 1000)).toBe(false);
    expect(b.claim("t1", "c2", 1000)).toBe(true);
  });

  it("sweep clears an expired verifier lease and the task stays verifying", () => {
    const b = board();
    b.claim("t1", "c1", 0);
    b.propose(proposal("t1", "c1"));
    b.requestVerification("t1");
    b.claim("t1", "c2", 100);
    expect(ids(b.claimable(1099))).not.toContain("t1");
    expect(ids(b.claimable(1100))).toContain("t1");
    expect(b.sweep(1100)).toEqual(["t1"]);
    expect(b.get("t1")?.status).toBe("verifying");
    expectUnclaimed(b, "t1");
  });

  it("claims an expired lease without a sweep, applying verifier exclusion", () => {
    const b = board();
    b.claim("t1", "c1", 0);
    expect(ids(b.claimable(1000))).toContain("t1");
    expect(b.claim("t1", "c2", 1000)).toBe(true);
    expect(b.get("t1")).toMatchObject({ status: "claimed", claimedBy: "c2", leaseUntil: 2000, attempts: 2 });
    expect(b.renew("t1", "c1", 1000)).toBe(false);

    b.claim("t2", "c1", 0);
    b.propose(proposal("t2", "c1"));
    expect(ids(b.claimable(1000))[0]).toBe("t2");
    expect(b.claim("t2", "c1", 1000)).toBe(false);
    expect(b.get("t2")?.status).toBe("claimed");
    expect(b.claim("t2", "c3", 1000)).toBe(true);
    expect(b.get("t2")).toMatchObject({ status: "verifying", claimedBy: "c3" });
  });

  it("accept is terminal, stores the result and feeds results() in task order", () => {
    const b = board();
    b.claim("t2", "c1", 0);
    b.propose(proposal("t2", "c1", "p2"));
    b.accept("t2", "7", ["p2"], 1);
    b.claim("t1", "c1", 0);
    b.accept("t1", "3", [], 0);
    expect(b.get("t2")).toMatchObject({
      status: "accepted",
      acceptedAnswer: "7",
      acceptedProposalIds: ["p2"],
      independentSources: 1,
    });
    expectUnclaimed(b, "t2");
    expect(b.claim("t2", "c9", 10_000)).toBe(false);
    expect(ids(b.claimable(10_000))).toEqual(["t3"]);
    expect([...b.results()]).toEqual([
      ["t1", "3"],
      ["t2", "7"],
    ]);
    expect(b.done()).toBe(false);
    b.fail("t3");
    expect(b.get("t3")?.status).toBe("failed");
    expect(b.done()).toBe(true);
    expect(b.results().has("t3")).toBe(false);
  });

  it("ignores late writes to terminal tasks", () => {
    const b = board();
    b.claim("t1", "c1", 0);
    b.accept("t1", "3", [], 0);
    b.requestVerification("t1");
    b.fail("t1");
    b.accept("t1", "9", [], 0);
    b.propose(proposal("t1", "c2"));
    expect(b.get("t1")).toMatchObject({ status: "accepted", acceptedAnswer: "3", proposals: [] });
    b.fail("t2");
    b.accept("t2", "1", [], 0);
    expect(b.get("t2")?.status).toBe("failed");
    expect(b.sweep(1e9)).toEqual([]);
  });

  it("treats unknown task ids as no-ops", () => {
    const b = board();
    expect(b.claim("nope", "c1", 0)).toBe(false);
    expect(b.renew("nope", "c1", 0)).toBe(false);
    expect(b.get("nope")).toBeUndefined();
    expect(() => {
      b.release("nope", "c1");
      b.propose(proposal("nope", "c1"));
      b.requestVerification("nope");
      b.accept("nope", "1", [], 0);
      b.fail("nope");
    }).not.toThrow();
    expect(b.all()).toHaveLength(3);
  });

  it("is trivially done with no tasks", () => {
    const b = new InMemoryBlackboard([], { leaseMs: LEASE });
    expect(b.done()).toBe(true);
    expect(b.results().size).toBe(0);
  });
});
