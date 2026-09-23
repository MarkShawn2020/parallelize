import type {
  AgentRegistry,
  Blackboard,
  CapabilityCard,
  CellState,
  Gene,
  Lineage,
  Proposal,
  ProtocolType,
  PublicTask,
  SwarmEvent,
  TaskStatus,
} from "../core/types";
import { createMessage, SERVICE } from "./messages";

export const taskNodeId = (taskId: string): string => `task:${taskId}`;

/** What an agent may see of a claimable task: no answers, only who already proposed (in order). */
export interface TaskView {
  task: PublicTask;
  status: TaskStatus;
  attempts: number;
  proposers: string[];
}

/**
 * The only door an agent has to shared state. Every call checks revocation first; a violation is
 * answered with DENIED (plus a permission.denied event) and a false/undefined result, never a throw.
 */
export interface CellHandle {
  readonly agentId: string;
  claimable(): TaskView[];
  claim(taskId: string, rule?: string): boolean;
  renew(taskId: string): boolean;
  release(taskId: string): void;
  /** Needs a live lease on the task; sawProposalIds become lineage parents and must be proposals on it. */
  propose(p: { taskId: string; answer: string; summary: string; sawProposalIds: string[] }): Proposal | undefined;
  /** Returns the offer's id, which is also its lineage node (used for the recollision check). */
  offerGene(toId: string, gene: Gene): string | undefined;
  announce(card: CapabilityCard): boolean;
  /** Agent-supplied fields only; trust, status and domains belong to the registry. */
  updateCard(patch: { model?: string; genes?: string[] }): CapabilityCard | undefined;
  heartbeat(p?: { state?: CellState; taskId?: string }): boolean;
}

export interface CellHandleDeps {
  agentId: string;
  runId: string;
  board: Blackboard;
  registry: AgentRegistry;
  lineage: Lineage;
  emit: (e: SwarmEvent) => void;
  now: () => number;
  isRevoked: () => boolean;
  /** Shared id source so proposal and message ids stay unique across agents; default is per handle. */
  nextId?: (prefix: string) => string;
}

type Service = (typeof SERVICE)[keyof typeof SERVICE];

export function createCellHandle(deps: CellHandleDeps): CellHandle {
  const { agentId, runId, board, registry, lineage, emit, now, isRevoked } = deps;
  let seq = 0;
  const nextId = deps.nextId ?? ((prefix: string) => `${agentId}.${prefix}${++seq}`);

  const message = (p: { type: ProtocolType; from: string; to: string; parents?: string[]; body: Record<string, unknown>; id?: string }): void => {
    const at = now();
    emit({ type: "protocol.message", runId, at, message: createMessage({ ...p, runId, at }) });
  };

  const deny = (action: string, reason: string, from: Service, taskId?: string): void => {
    emit({ type: "permission.denied", runId, at: now(), cellId: agentId, action, reason });
    message({ type: "DENIED", from, to: agentId, body: taskId === undefined ? { action, reason } : { action, reason, taskId } });
  };

  /** false (after a DENIED) when the agent has been cut off. */
  const allowed = (action: string, from: Service, taskId?: string): boolean => {
    if (!isRevoked()) return true;
    const status = registry.get(agentId)?.status;
    deny(action, status !== undefined && status !== "active" ? status : "revoked", from, taskId);
    return false;
  };

  const cardEvent = (card: CapabilityCard | undefined): void => {
    if (card) emit({ type: "cell.card", runId, at: now(), card });
  };

  return {
    agentId,

    claimable() {
      if (!allowed("read", SERVICE.board)) return [];
      return board
        .claimable(now())
        .filter((e) => !e.proposers.includes(agentId))
        .map((e) => ({ task: { ...e.task }, status: e.status, attempts: e.attempts, proposers: [...e.proposers] }));
    },

    claim(taskId, rule) {
      if (!allowed("claim", SERVICE.board, taskId)) return false;
      // A lost race is not a violation: the agent simply tries its next candidate.
      if (!board.claim(taskId, agentId, now())) return false;
      const leaseUntil = board.get(taskId)?.leaseUntil;
      const body: Record<string, unknown> = { taskId };
      if (leaseUntil !== undefined) body.leaseUntil = leaseUntil;
      if (rule !== undefined) body.rule = rule;
      message({ type: "CLAIM", from: agentId, to: SERVICE.board, parents: [taskNodeId(taskId)], body });
      emit({ type: "task.claimed", runId, at: now(), taskId, cellId: agentId });
      return true;
    },

    renew(taskId) {
      if (!allowed("renew", SERVICE.board, taskId)) return false;
      return board.renew(taskId, agentId, now());
    },

    release(taskId) {
      if (!allowed("release", SERVICE.board, taskId)) return;
      board.release(taskId, agentId);
    },

    propose({ taskId, answer, summary, sawProposalIds }) {
      if (!allowed("propose", SERVICE.board, taskId)) return undefined;
      const entry = board.get(taskId);
      if (!entry) return void deny("propose", "unknown task", SERVICE.board, taskId);
      // One proposal per agent per task: an agent can never be its own reviewer.
      if (entry.proposers.includes(agentId)) return void deny("propose", "already proposed", SERVICE.board, taskId);
      if (!board.renew(taskId, agentId, now())) return void deny("propose", "no lease", SERVICE.board, taskId);
      const onTask = new Set(entry.proposals.map((p) => p.id));
      if (sawProposalIds.some((id) => !onTask.has(id))) return void deny("propose", "unknown parent", SERVICE.board, taskId);

      const id = nextId("p");
      const at = now();
      const parents = [taskNodeId(taskId), ...sawProposalIds];
      lineage.add({ id, kind: "proposal", cellId: agentId, taskId, parents, at });
      const proposal: Proposal = { id, taskId, cellId: agentId, answer, summary, at };
      board.propose(proposal);
      message({ type: "PROPOSE", from: agentId, to: SERVICE.board, parents, body: { taskId, proposalId: id, answer, summary } });
      emit({ type: "task.proposed", runId, at, taskId, cellId: agentId, proposalId: id, sawProposals: [...sawProposalIds] });
      return { ...proposal };
    },

    offerGene(toId, gene) {
      if (!allowed("offer-gene", SERVICE.registry)) return undefined;
      if (registry.get(agentId)?.status !== "active") return void deny("offer-gene", "sender not active", SERVICE.registry);
      if (toId === agentId || registry.get(toId)?.status !== "active") return void deny("offer-gene", "receiver not active", SERVICE.registry);
      if (!lineage.get(gene.lineageId)) return void deny("offer-gene", "unknown gene", SERVICE.registry);

      const id = nextId("m");
      lineage.add({ id, kind: "message", cellId: agentId, parents: [gene.lineageId], at: now() });
      message({
        id,
        type: "GENE_OFFER",
        from: agentId,
        to: toId,
        parents: [gene.lineageId],
        body: { geneId: gene.id, domain: gene.domain, text: gene.text, wins: gene.wins, trials: gene.trials },
      });
      emit({ type: "gene.gossiped", runId, at: now(), geneId: gene.id, fromCell: agentId, toCell: toId });
      return id;
    },

    announce(card) {
      if (!allowed("announce", SERVICE.registry)) return false;
      if (card.agentId !== agentId) {
        deny("announce", "not own card", SERVICE.registry);
        return false;
      }
      const existing = registry.get(agentId);
      // Re-announcing must not wash away a quarantine or a death.
      if (existing && existing.status !== "active") {
        deny("announce", existing.status, SERVICE.registry);
        return false;
      }
      const at = now();
      registry.announce({ ...card, status: "active", joinedAt: existing?.joinedAt ?? card.joinedAt, lastSeen: at });
      const stored = registry.get(agentId);
      if (stored) message({ type: "ANNOUNCE", from: agentId, to: SERVICE.registry, body: { card: stored } });
      cardEvent(stored);
      return true;
    },

    updateCard(patch) {
      if (!allowed("update-card", SERVICE.registry)) return undefined;
      const safe: { model?: string; genes?: string[]; lastSeen: number } = { lastSeen: now() };
      if (patch.model !== undefined) safe.model = patch.model;
      if (patch.genes !== undefined) safe.genes = [...patch.genes];
      const card = registry.update(agentId, safe);
      if (!card) return void deny("update-card", "not announced", SERVICE.registry);
      message({ type: "HEARTBEAT", from: agentId, to: SERVICE.registry, body: { genes: card.genes.length } });
      cardEvent(card);
      return card;
    },

    heartbeat(p = {}) {
      if (!allowed("heartbeat", SERVICE.registry)) return false;
      const card = registry.update(agentId, { lastSeen: now() });
      if (!card) {
        deny("heartbeat", "not announced", SERVICE.registry);
        return false;
      }
      const body: Record<string, unknown> = {};
      if (p.state !== undefined) body.state = p.state;
      if (p.taskId !== undefined) body.taskId = p.taskId;
      message({ type: "HEARTBEAT", from: agentId, to: SERVICE.registry, body });
      cardEvent(card);
      return true;
    },
  };
}
