import type { Blackboard, Proposal, PublicTask, TaskEntry, TaskStatus } from "./types";

const isTerminal = (s: TaskStatus): boolean => s === "accepted" || s === "failed";

const hasLiveLease = (e: TaskEntry, now: number): boolean =>
  e.claimedBy !== undefined && e.leaseUntil !== undefined && e.leaseUntil > now;

/** Where a claimed task goes when its claim is dropped: back to open, or to verification if someone already answered. */
const unclaimedStatus = (e: TaskEntry): TaskStatus =>
  e.status === "claimed" ? (e.proposals.length > 0 ? "verifying" : "open") : e.status;

const clearClaim = (e: TaskEntry): void => {
  delete e.claimedBy;
  delete e.leaseUntil;
};

/** Terminal entries (accepted / failed) are frozen: late writes from slow cells are ignored. */
export class InMemoryBlackboard implements Blackboard {
  private readonly entries = new Map<string, TaskEntry>();
  private readonly leaseMs: number;

  constructor(tasks: PublicTask[], opts: { leaseMs: number }) {
    this.leaseMs = opts.leaseMs;
    for (const task of tasks) {
      if (this.entries.has(task.id)) throw new Error(`blackboard: duplicate task id ${task.id}`);
      this.entries.set(task.id, { task, status: "open", attempts: 0, proposals: [], proposers: [] });
    }
  }

  claimable(now: number): TaskEntry[] {
    // An expired claim with proposals is effectively verifying (sweep would move it there).
    const rank = (e: TaskEntry): number => (unclaimedStatus(e) === "verifying" ? 0 : 1);
    // Array.prototype.sort is stable, so ties keep the original task order.
    return this.all()
      .filter((e) => this.isClaimable(e, now))
      .sort((a, b) => rank(a) - rank(b) || a.attempts - b.attempts);
  }

  get(taskId: string): TaskEntry | undefined {
    return this.entries.get(taskId);
  }

  all(): TaskEntry[] {
    return [...this.entries.values()];
  }

  claim(taskId: string, cellId: string, now: number): boolean {
    const e = this.entries.get(taskId);
    if (!e || isTerminal(e.status) || hasLiveLease(e, now)) return false;
    const status = unclaimedStatus(e);
    if (status === "verifying" && e.proposers.includes(cellId)) return false;
    e.status = status === "open" ? "claimed" : status;
    e.claimedBy = cellId;
    e.leaseUntil = now + this.leaseMs;
    e.attempts++;
    return true;
  }

  renew(taskId: string, cellId: string, now: number): boolean {
    const e = this.entries.get(taskId);
    if (!e || e.claimedBy !== cellId || !hasLiveLease(e, now)) return false;
    e.leaseUntil = now + this.leaseMs;
    return true;
  }

  release(taskId: string, cellId: string): void {
    const e = this.entries.get(taskId);
    if (!e || e.claimedBy !== cellId) return;
    clearClaim(e);
    e.status = unclaimedStatus(e);
  }

  propose(p: Proposal): void {
    const e = this.entries.get(p.taskId);
    if (!e || isTerminal(e.status)) return;
    e.proposals.push(p);
    if (!e.proposers.includes(p.cellId)) e.proposers.push(p.cellId);
  }

  requestVerification(taskId: string): void {
    const e = this.entries.get(taskId);
    if (!e || isTerminal(e.status)) return;
    e.status = "verifying";
    clearClaim(e);
  }

  accept(taskId: string, answer: string, proposalIds: string[], independentSources: number): void {
    const e = this.entries.get(taskId);
    if (!e || isTerminal(e.status)) return;
    e.status = "accepted";
    e.acceptedAnswer = answer;
    e.acceptedProposalIds = [...proposalIds];
    e.independentSources = independentSources;
    clearClaim(e);
  }

  fail(taskId: string): void {
    const e = this.entries.get(taskId);
    if (!e || isTerminal(e.status)) return;
    e.status = "failed";
    clearClaim(e);
  }

  sweep(now: number): string[] {
    const swept: string[] = [];
    for (const e of this.entries.values()) {
      if (isTerminal(e.status) || e.claimedBy === undefined || hasLiveLease(e, now)) continue;
      clearClaim(e);
      e.status = unclaimedStatus(e);
      swept.push(e.task.id);
    }
    return swept;
  }

  done(): boolean {
    return this.all().every((e) => isTerminal(e.status));
  }

  results(): Map<string, string> {
    const out = new Map<string, string>();
    for (const e of this.entries.values()) {
      if (e.status === "accepted" && e.acceptedAnswer !== undefined) out.set(e.task.id, e.acceptedAnswer);
    }
    return out;
  }

  private isClaimable(e: TaskEntry, now: number): boolean {
    if (e.status === "open") return true;
    if (e.status === "verifying" || e.status === "claimed") return !hasLiveLease(e, now);
    return false;
  }
}
