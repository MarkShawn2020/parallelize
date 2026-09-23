import { describe, expect, it } from "vitest";
import { Semaphore } from "./limiter";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = () => new Promise<void>((r) => setImmediate(r));

describe("Semaphore", () => {
  it("never runs more than max tasks at once", async () => {
    const sem = new Semaphore(2);
    const gates = Array.from({ length: 5 }, deferred);
    let running = 0;
    let peak = 0;
    const all = gates.map((g) =>
      sem.run(async () => {
        running++;
        peak = Math.max(peak, running);
        await g.promise;
        running--;
      }),
    );
    await flush();
    expect(sem.active).toBe(2);
    expect(sem.queued).toBe(3);
    gates[0]?.resolve();
    await flush();
    expect(sem.active).toBe(2);
    expect(sem.queued).toBe(2);
    for (const g of gates) g.resolve();
    await Promise.all(all);
    expect(peak).toBe(2);
    expect(sem.active).toBe(0);
    expect(sem.queued).toBe(0);
  });

  it("starts queued tasks in FIFO order", async () => {
    const sem = new Semaphore(1);
    const started: number[] = [];
    await Promise.all(
      [0, 1, 2, 3, 4].map((i) =>
        sem.run(async () => {
          started.push(i);
          await flush();
        }),
      ),
    );
    expect(started).toEqual([0, 1, 2, 3, 4]);
  });

  it("releases the slot when the task throws or rejects", async () => {
    const sem = new Semaphore(1);
    const failAsync = sem.run(async () => {
      throw new Error("async boom");
    });
    const failSync = sem.run((() => {
      throw new Error("sync boom");
    }) as () => Promise<never>);
    const ok = sem.run(async () => 42);
    await expect(failAsync).rejects.toThrow("async boom");
    await expect(failSync).rejects.toThrow("sync boom");
    await expect(ok).resolves.toBe(42);
    expect(sem.active).toBe(0);
  });

  it("returns the task's value", async () => {
    await expect(new Semaphore(3).run(async () => "done")).resolves.toBe("done");
  });

  it("rejects a non-positive max", () => {
    expect(() => new Semaphore(0)).toThrow(RangeError);
    expect(() => new Semaphore(1.5)).toThrow(RangeError);
  });
});
