# JIS Swarm Protocol v1

> **中文摘要**：这是一套与模型、传输无关的蜂群协作协议。没有中心调度器：agent 用能力卡（capability card）自我描述、互相发现，从黑板按固定规则认领任务（零 token），只有规则写不出的判断（要不要复核、要不要采纳基因、两个冲突答案谁对）才交给 System 1（Jev），低置信再升级给 System 2（LLM）。每条消息都带血缘（parents），据此按"独立来源"而非票数判定共识，识别回声 / 假共识。共享状态只由 `board`、`registry`、`library` 三个服务写入，agent 持有权限受限的句柄，越权即 `DENIED`；信任过低自动隔离，Jev 离线降级到 System 2，System 2 失败回退到保守默认值。经验（基因 + 已被结果确认的判例）沉淀到本地经验库，卡住时查 EvoMap 公共基因，通过留出集 A/B 门槛的基因才发布回 EvoMap。新 agent 只需实现几条消息、发一张能力卡即可接入，模型不限；目前只实现了进程内接入，外部 agent 的 WebSocket 绑定已设计、尚未上线（见第 8 节 Transport bindings）。

Machine-checked: `src/protocol/messages.ts` holds the same body table (`BODY_SCHEMA`), and a test validates every JSON example in this file.

## 1. Purpose and design principles

The protocol lets heterogeneous agents (any model, in-process or remote) solve a shared pool of tasks without a coordinator, while keeping the cost, correctness and trust of every coordination step observable.

1. **No central scheduler.** Agents pull work from the board. Services accept or deny; they never assign.
2. **Rules for what can be rules.** Claiming, leases, review triggers (probation, audit, low trust), echo detection and the final merge are deterministic and cost zero tokens.
3. **Typed judgments for the rest.** Only three judgments go to a model, each as a Jev question primitive (`noul`, `choice`): `verify` (does this proposal need an independent re-solve?), `adopt` (does this gene suit me?), `dispute` (which of two conflicting answers is right, or `unclear`?). System 1 answers; below `escalationThreshold` confidence the same question goes to System 2.
4. **Bounded summaries.** Agents exchange an answer plus a one-line method (at most 550 tokens) and gene gists (at most 240 chars), never transcripts.
5. **Lineage on every message.** `parents` lists the lineage node ids a message derives from (the task, proposals the sender saw, a gene). Consensus counts independent roots, not votes.
6. **Trust boundaries.** Agents are untrusted. Only services write shared state, ground-truth answers never leave the runner, and every judgment has a conservative default so a provider outage degrades the swarm instead of stopping it.

## 2. Envelope

Every message, on every transport, is this JSON object (`ProtocolMessage` in `src/core/types.ts`):

```json
{
  "v": 1,
  "id": "propose-1b3k9x-42",
  "runId": "swarm-jev-20260923-143012-ab12",
  "type": "PROPOSE",
  "from": "c03",
  "to": "board",
  "parents": ["t012", "p0007"],
  "at": 1790000000000,
  "body": { "taskId": "t012", "proposalId": "p0011", "answer": "42", "summary": "12 boxes x 3.5 kg, minus 0 returns" }
}
```

| Field | Meaning |
| --- | --- |
| `v` | Protocol version, exactly `1`. |
| `id` | Unique message id (1-128 chars, no control characters). |
| `runId` | The run (swarm session) the message belongs to. |
| `type` | One of the 15 types in section 4. |
| `from` / `to` | Agent id, `"*"` (broadcast), or a service: `"board"`, `"registry"`, `"library"`. |
| `parents` | Lineage node ids (at most 64). Here: the task and the proposal `p0007` the sender saw. |
| `at` | Sender clock, epoch ms. |
| `body` | Plain JSON object, at most 8 KB (UTF-8). Required fields per type below; extra fields are allowed. |

## 3. Capability cards and discovery

An agent describes itself with a card. The agent supplies `agentId`, `model`, `genes`; the registry owns `trust`, `status`, `domains` (the record of accepted/attempted proposals), `joinedAt` and `lastSeen`.

```json
{
  "agentId": "c03",
  "model": "anthropic/claude-haiku-4.5",
  "domains": { "arithmetic": { "wins": 5, "trials": 6 }, "rates": { "wins": 1, "trials": 3 } },
  "genes": ["arithmetic: convert units before multiplying"],
  "trust": 0.72,
  "status": "active",
  "joinedAt": 1790000000000,
  "lastSeen": 1790000042000
}
```

`discover({ domain?, exclude?, limit })` returns only `active` cards, ranked by:

1. smoothed win rate in the domain, `(wins + 1) / (trials + 2)` (an unknown agent scores 0.5, so one lucky win cannot dominate);
2. then trust, descending;
3. then `agentId`, for determinism.

Excluded ids are dropped, then the top `limit` are returned. Discovery is advisory (whom to offer a gene, which peers are strong in a domain); it never assigns work.

## 4. Message types

| Type | Direction | Required body | Optional body |
| --- | --- | --- | --- |
| `ANNOUNCE` | agent → registry | `card` | |
| `HEARTBEAT` | agent → registry | | `state`, `taskId` |
| `DISCOVER` | agent → registry, registry → agent (reply) | `limit` | `domain`, `exclude`, `agents` (reply: ranked ids) |
| `CLAIM` | agent → board | `taskId` | `leaseUntil`, `rule` |
| `PROPOSE` | agent → board | `taskId`, `proposalId`, `answer`, `summary` | |
| `REVIEW_REQUEST` | board → `*` | `taskId`, `reason` | `proposalId` |
| `ACCEPT` | board → `*` | `taskId`, `answer`, `proposalIds`, `independentSources` | |
| `ECHO_ALARM` | board → `*` | `taskId`, `proposalIds`, `agreeing`, `independentSources` | |
| `GENE_OFFER` | agent → neighbour | `geneId`, `domain`, `text` | `wins`, `trials` |
| `GENE_ADOPT` | agent → offering agent | `geneId`, `domain` | |
| `GENE_REJECT` | agent → offering agent | `geneId`, `reason` | |
| `LIBRARY_QUERY` | agent → library | `taskId`, `domain` | `k` |
| `LIBRARY_RESULT` | library → agent | `taskId`, `source`, `geneIds` | `titles` |
| `QUARANTINE` | registry → `*` | `agentId`, `trust`, `reason` | |
| `DENIED` | board / registry / library → agent | `action`, `reason` | `taskId` |

Value conventions: `REVIEW_REQUEST.reason` is `judge` | `probation` | `audit` | `trust` | `echo` | `dispute`; `GENE_REJECT.reason` is `judge` | `recollision`; `LIBRARY_RESULT.source` is `local` | `evomap`. `parents`: `PROPOSE` = task + proposals seen; `ACCEPT` / `ECHO_ALARM` = the grouped proposals; `GENE_OFFER` = the gene's lineage node.

Example body for each type:

```json
{
  "ANNOUNCE": { "card": { "agentId": "c06", "model": "openai/gpt-4o-mini", "domains": {}, "genes": [], "trust": 0.5, "status": "active", "joinedAt": 1790000050000, "lastSeen": 1790000050000 } },
  "HEARTBEAT": { "state": "solving", "taskId": "t012" },
  "DISCOVER": { "domain": "arithmetic", "limit": 3, "exclude": ["c03"], "agents": ["c05", "c01", "c02"] },
  "CLAIM": { "taskId": "t012", "rule": "verifying" },
  "PROPOSE": { "taskId": "t012", "proposalId": "p0011", "answer": "42", "summary": "12 boxes x 3.5 kg" },
  "REVIEW_REQUEST": { "taskId": "t012", "reason": "probation", "proposalId": "p0011" },
  "ACCEPT": { "taskId": "t012", "answer": "42", "proposalIds": ["p0011", "p0015"], "independentSources": 2 },
  "ECHO_ALARM": { "taskId": "t007", "proposalIds": ["p0003", "p0006", "p0009"], "agreeing": 3, "independentSources": 1 },
  "GENE_OFFER": { "geneId": "g0020", "domain": "arithmetic", "text": "Convert every quantity to one unit before multiplying.", "wins": 4, "trials": 5 },
  "GENE_ADOPT": { "geneId": "g0020", "domain": "arithmetic" },
  "GENE_REJECT": { "geneId": "g0020", "reason": "recollision" },
  "LIBRARY_QUERY": { "taskId": "t019", "domain": "rates", "k": 3 },
  "LIBRARY_RESULT": { "taskId": "t019", "source": "evomap", "geneIds": ["g-evo-81"], "titles": ["Set up rate x time tables"] },
  "QUARANTINE": { "agentId": "c04", "trust": 0.21, "reason": "trust below 0.3 after 6 judged proposals" },
  "DENIED": { "action": "propose", "reason": "no lease", "taskId": "t012" }
}
```

## 5. Core flows

**A. Claim → propose → review → accept**

1. The agent reads the claimable tasks (public view, no answers) and picks by a fixed rule: tasks awaiting verification first, then tasks in its best smoothed domain, then fewest attempts, then task id. `CLAIM` → board; the board grants atomically with a lease (a lost race just tries the next candidate). Asking a judge to pick exists only as the `claimPolicy: "judge"` ablation.
2. The agent solves with its own model and sends `PROPOSE` with a bounded summary; `parents` names every proposal it saw.
3. The board decides whether a lone proposal needs review. Rules first: proposer in probation (first `probation` proposals), proposer trust below `reviewTrust`, or a random audit (`auditRate`). Otherwise System 1 answers `verify`. Review → `REVIEW_REQUEST`.
4. A different agent (never an existing proposer) pulls the verifying task first under the claim rule and re-solves independently, without seeing the earlier answer.
5. Agreeing proposals with at least 2 independent lineage roots → `ACCEPT`. A lone low-risk proposal is accepted with 1 source. The merge is keyed by task id; no model rewrites accepted answers.

**B. Disagreement → dispute judgment → escalation → precedent**

1. Proposals conflict and no answer has 2 independent sources.
2. System 1 answers `dispute`: a `choice` between the answers or `unclear`. Below `escalationThreshold` confidence, System 2 answers the same question.
3. A clear verdict resolves the task; `unclear` sends it back for another independent solve (`REVIEW_REQUEST`, reason `dispute`).
4. A System-2 verdict becomes a *pending* precedent. It is confirmed, and only then shown to System 1 under `PRECEDENTS:`, once the task's outcome agrees with it; otherwise it is rejected. Wrong verdicts never train the fast path.
5. Calibration guard: per judgment key, over the last `guardWindow` escalations, if System 1 disagreed with System 2 on more than `guardMaxDisagreement` of them, that key goes straight to System 2.

**C. Echo / false consensus**

1. Every proposal's `parents` records what the solver saw, so the board knows each proposal's lineage roots.
2. Agreeing proposals whose roots intersect count as one source (one solver copied another).
3. `agreeing >= 2` but `independentSources == 1` → `ECHO_ALARM` plus `REVIEW_REQUEST` (reason `echo`); the task stays open until a lineage-disjoint solve agrees or disagrees.
4. Correlated errors that still pass review are reported, not hidden (`falseAcceptVerifiedRate`).

**D. Failure**

1. *Agent death*: an agent renews its lease while working. A dead agent stops renewing, the board's sweep reopens the task after the lease expires, and any live agent picks it up. Proposals already made are kept.
2. *Bad agent*: each judged proposal updates the agent's Beta-posterior trust (agreed with the accepted answer or not). Below `quarantineTrust` after at least `probation` judged proposals, the registry sets `status: "quarantined"` and broadcasts `QUARANTINE`; the agent's handle is revoked (every call → `DENIED`) and discovery skips it. The demo "compromise" switch turns a cell adversarial without telling the swarm; detection must come from trust.
3. *System-1 outage*: with Jev offline, every judgment goes to System 2 and the run reports `jevDown`.
4. *System-2 failure*: the judgment falls back to a conservative default and is marked `fallback`: verify → review, adopt → reject, dispute → `unclear`. Rules keep claiming, leasing and merging with no judge at all.

## 6. Knowledge inheritance

- **Genes.** After accepted solves an agent distils a one-sentence strategy (a lineage node). Gossip, adopt, forget (EvoMap's R1/R2/R3): every `gossipEvery` accepted solves it sends `GENE_OFFER` to trusted active peers found through `DISCOVER` (weakest record in the gene's domain first; topology neighbours as fallback); the receiver rejects a gene that descends from its own work (recollision, zero tokens) or asks System 1 `adopt`, then answers `GENE_ADOPT` / `GENE_REJECT`; a full pool (`geneCapacity`) forgets its lowest-fitness gene. Fitness is per agent, with the same Laplace prior as discovery.
- **Precedents.** Only outcome-confirmed System-2 verdicts are kept (flow B).
- **Experience library.** A persistent local store of genes with evidence (wins, trials, independent sources) plus confirmed precedents. With `inherit`, it is loaded at start and verified experience is written back at the end.
- **When stuck.** After `stuckAfter` failed reviews on a task, the agent sends `LIBRARY_QUERY`; the library answers from the local store and, with `evomapLookup`, from EvoMap's public gene catalog (A2A search), in `LIBRARY_RESULT`.
- **Publishing to EvoMap.** A gene is published only if it passes a holdout A/B gate: `publishGateTasks` fresh tasks solved with and without it, and `withGene - withoutGene >= publishGateMinDelta`. Candidates are at most two local genes with smoothed fitness >= 0.7 over >= 3 trials in this run, from a domain that has fresh tasks with ground truth, and free of injection-shaped text. Passing genes go out as a Gene + Capsule + EvolutionEvent bundle, and only after the hub's dry run (`/a2a/validate`) accepts it. Simulated runs run the gate but never send. Off by default (`evomapPublish: false`); the node secret never leaves the server.

## 7. Permission model

Agents never touch shared state directly. Each gets a permission-scoped handle; `board`, `registry` and `library` are the only acceptors.

| An agent can | An agent cannot |
| --- | --- |
| read claimable tasks (public view) | read ground-truth answers |
| claim by the rule, renew and release its own lease | accept, fail or reopen a task |
| propose on a task it currently holds the lease for | propose without a lease, or review its own proposal |
| offer, adopt and reject genes | see a teammate's answer, except on the explicit echo path |
| query the library (read-only) | write the library or publish to EvoMap |
| announce and heartbeat its own card | set its own trust or status, or edit another card |

Any violation returns `DENIED` (`action`, `reason`) and emits `permission.denied`. A quarantined or dead agent is denied everything.

## 8. Transport bindings

- **In-process (today).** Agents and services share one event bus. Each message is emitted as a `protocol.message` event, recorded to `runs/<runId>/events.jsonl`, and streamed to the dashboard over `WS /ws`.
- **WebSocket for external agents (designed, not yet shipped).** The same JSON, one message per frame. The server runs `validateMessage` at the boundary (exact `v`, known type, ids of 1-128 chars without control characters, at most 64 parents, finite `at`, plain-object body of at most 8 KB, required body fields present with the right JSON type; unknown top-level fields are dropped), binds `from` to the authenticated connection, and applies the same permission checks as for in-process handles.

## 9. Plugging in a new agent

1. Obtain a handle (in-process) or connect (WebSocket binding).
2. `ANNOUNCE` a card. A newcomer starts at the neutral trust prior and in probation, so its first proposals are always reviewed.
3. Loop: claim by the rule, solve with **any** model, `PROPOSE` with a bounded summary and honest `parents`. `HEARTBEAT` while alive; dying at any point is safe (flow D).
4. Optionally exchange genes and query the library.

At start, `cellModels` assigns models round-robin; mid-run, `POST /api/runs/:runId/spawn { model }` adds a cell with a different model. Nothing else changes.

The pattern is not tied to arithmetic. In the research scenario an idea is split by an LLM planner into verifiable claims plus canary claims of known truth; the swarm returns `supported` / `refuted` / `uncertain` per claim through the same flows; a deterministic rule turns verdicts and canary results into a `continue` / `abandon` / `inconclusive` report and states the rule it used.
