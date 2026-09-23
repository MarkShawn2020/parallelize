import { hashString } from "./rng";
import type { EventBus, Mode, SwarmEvent } from "./types";

type Listener = (e: SwarmEvent) => void;

export class SimpleEventBus implements EventBus {
  // Wrapped so the same function subscribed twice gets two independent unsubscribes.
  private readonly subs = new Set<{ fn: Listener }>();

  emit(e: SwarmEvent): void {
    // Snapshot: listeners added or removed during emit take effect from the next event.
    for (const sub of [...this.subs]) {
      try {
        sub.fn(e);
      } catch (err) {
        console.error(`event listener failed on ${e.type}:`, err);
      }
    }
  }

  on(fn: Listener): () => void {
    const sub = { fn };
    this.subs.add(sub);
    return () => {
      this.subs.delete(sub);
    };
  }
}

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/** e.g. "swarm-jev-20260923-143012-ab12" (local time). */
export function createRunId(mode: Mode, now: number): string {
  const d = new Date(now);
  const date = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const suffix = hashString(`${mode}${now}`).toString(16).padStart(8, "0").slice(0, 4);
  return `${mode}-${date}-${time}-${suffix}`;
}
