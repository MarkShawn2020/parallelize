import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../config";
import { MemoryLedger } from "../core/ledger";
import type { JudgeRequest, LedgerEntry, Task } from "../core/types";
import { ProviderStack } from "./stack";

const ENV = { llm: { baseUrl: "http://llm.invalid", model: "m" }, jev: { baseUrl: "http://jev.invalid", model: "j" } };
const TASKS: Task[] = [{ id: "t1", domain: "arithmetic", prompt: "What is 2 + 3 * 4?", answer: "14" }];
const META = { runId: "r", cellId: "c01", taskId: "t1" };
const VERIFY: JudgeRequest = {
  state: "task t1: What is 2 + 3 * 4?\nproposal: 14",
  questions: { verify: { type: "noul", instructions: "Is the proposal wrong?" } },
  meta: { ...META, purpose: "verify" },
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** One solve, one judgment, and one judgment with Jev down (System 2), as the ledger records them. */
async function simulatedCalls(simPace: number, mockLatencyMs?: [number, number]): Promise<LedgerEntry[]> {
  const ledger = new MemoryLedger();
  const stack = new ProviderStack({
    config: { ...DEFAULT_CONFIG, mode: "swarm-jev", llm: "mock", judge: "mock", simPace },
    ledger,
    meter: {},
    env: ENV,
    ...(mockLatencyMs ? { mockLatencyMs } : {}),
  });
  stack.useTasks(TASKS);
  const judge = stack.judge({ onDecision: () => {}, onGuard: () => {} });
  if (!judge) throw new Error("swarm-jev must have a judge");
  // Fake timers: the drawn latency is recorded without actually waiting for it.
  const settle = async <T>(p: Promise<T>): Promise<T> => {
    await vi.advanceTimersByTimeAsync(120_000);
    return p;
  };
  await settle(stack.llm().complete({ messages: [{ role: "user", content: "What is 2 + 3 * 4?" }], meta: { ...META, purpose: "solve" } }));
  await settle(judge.ask(VERIFY));
  stack.switches.jev.set(true);
  await settle(judge.ask(VERIFY));
  return ledger.entries();
}

describe("ProviderStack simulated latency", () => {
  it("stretches simulated latency by simPace, System 2 by at most 2x", async () => {
    const base = await simulatedCalls(1);
    const paced = await simulatedCalls(10);
    expect(new Set(base.map((e) => `${e.provider}/${e.tier ?? "-"}`))).toEqual(new Set(["mock-llm/-", "mock-judge/system1", "mock-judge/system2"]));
    // Latency draws do not depend on the pace, so the same calls happen in the same order, each slower by the pace;
    // System 2 is capped at 2x because a real LLM judgment takes seconds, not tens of seconds.
    expect(paced.map((e) => [e.provider, e.tier, e.purpose])).toEqual(base.map((e) => [e.provider, e.tier, e.purpose]));
    paced.forEach((e, i) => {
      const factor = e.tier === "system2" ? 2 : 10;
      expect(Math.abs(e.latencyMs - factor * (base[i]?.latencyMs ?? 0))).toBeLessThanOrEqual(5);
    });
    const llm = paced.find((e) => e.provider === "mock-llm");
    expect(llm?.latencyMs).toBeGreaterThanOrEqual(600);
    expect(llm?.latencyMs).toBeLessThanOrEqual(1800);
  });

  it("lets a test latency override win over simPace", async () => {
    const entries = await simulatedCalls(40, [0, 2]);
    expect(entries.length).toBeGreaterThanOrEqual(3);
    expect(entries.every((e) => e.latencyMs <= 2)).toBe(true);
  });
});
