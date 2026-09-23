import { describe, expect, it } from "vitest";
import type { TaskView } from "../protocol/handle";
import { ruleClaimOrder } from "./cell";

const view = (id: string, attempts: number, proposers: string[] = []): TaskView => ({
  task: { id, domain: "arithmetic", prompt: id },
  status: proposers.length > 0 ? "verifying" : "open",
  attempts,
  proposers,
});

describe("ruleClaimOrder", () => {
  it("puts echo targets first, then orphaned tasks, then verification, then fresh work", () => {
    const views = [view("fresh", 0), view("orphan", 1), view("verify", 1, ["c2"]), view("echo", 0)];
    const order = ruleClaimOrder(views, {
      model: "m",
      modelOf: () => "m",
      rate: () => 0.5,
      preferred: new Set(["echo"]),
      orphans: new Set(["orphan"]),
      seed: 1,
    });
    expect(order).toEqual([
      { taskId: "echo", rule: "echo" },
      { taskId: "orphan", rule: "orphan" },
      { taskId: "verify", rule: "verifying" },
      { taskId: "fresh", rule: "domain" },
    ]);
  });

  it("without orphans a retried open task still waits behind fresh ones", () => {
    const order = ruleClaimOrder([view("retried", 1), view("fresh", 0)], {
      model: "m",
      modelOf: () => "m",
      rate: () => 0.5,
      preferred: new Set(),
      seed: 1,
    });
    expect(order.map((o) => o.taskId)).toEqual(["fresh", "retried"]);
  });
});
