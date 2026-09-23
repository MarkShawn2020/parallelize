import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunId, SimpleEventBus } from "./events";
import type { SwarmEvent } from "./types";

const ev = (message: string): SwarmEvent => ({ type: "log", runId: "r", at: 0, level: "info", message });

describe("SimpleEventBus", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fans out synchronously in subscription order", () => {
    const bus = new SimpleEventBus();
    const seen: string[] = [];
    bus.on((e) => seen.push(`a:${e.type}`));
    bus.on((e) => seen.push(`b:${e.type}`));
    bus.emit(ev("x"));
    expect(seen).toEqual(["a:log", "b:log"]);
  });

  it("unsubscribes and handles the same listener subscribed twice", () => {
    const bus = new SimpleEventBus();
    const fn = vi.fn();
    const off1 = bus.on(fn);
    const off2 = bus.on(fn);
    bus.emit(ev("1"));
    expect(fn).toHaveBeenCalledTimes(2);
    off1();
    off1();
    bus.emit(ev("2"));
    expect(fn).toHaveBeenCalledTimes(3);
    off2();
    bus.emit(ev("3"));
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("isolates a throwing listener and reports each error once", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const bus = new SimpleEventBus();
    const after = vi.fn();
    bus.on(() => {
      throw new Error("listener broke");
    });
    bus.on(after);
    bus.emit(ev("1"));
    bus.emit(ev("2"));
    expect(after).toHaveBeenCalledTimes(2);
    expect(errSpy).toHaveBeenCalledTimes(2);
  });

  it("applies subscription changes made during emit from the next event", () => {
    const bus = new SimpleEventBus();
    const late = vi.fn();
    bus.on(() => {
      bus.on(late);
    });
    bus.emit(ev("1"));
    expect(late).not.toHaveBeenCalled();
    bus.emit(ev("2"));
    expect(late).toHaveBeenCalledTimes(1);
  });
});

describe("createRunId", () => {
  it("formats mode, local timestamp and a stable 4-hex suffix", () => {
    const now = new Date(2026, 8, 23, 14, 30, 12).getTime();
    const id = createRunId("swarm-jev", now);
    expect(id).toMatch(/^swarm-jev-20260923-143012-[0-9a-f]{4}$/);
    expect(createRunId("swarm-jev", now)).toBe(id);
    expect(createRunId("single", now)).toMatch(/^single-20260923-143012-[0-9a-f]{4}$/);
  });

  it("zero-pads date and time fields", () => {
    const now = new Date(2026, 0, 5, 3, 4, 5).getTime();
    expect(createRunId("subagent", now)).toMatch(/^subagent-20260105-030405-[0-9a-f]{4}$/);
  });
});
