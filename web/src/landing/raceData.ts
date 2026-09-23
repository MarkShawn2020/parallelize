/**
 * The three-lane race: compact timelines of real runs (built by scripts/build-race.ts) and the pure functions that
 * turn "t milliseconds into the run" into what each lane shows. Nothing here is simulated; the page only replays.
 */

export type JudgeKey = "verify" | "adopt" | "dispute" | "claim";

export interface RaceRun {
  runId: string;
  mode: string;
  cells: number;
  durationMs: number;
  /** [t, task, correct 0/1, independent sources] */
  acc: Array<[number, number, number, number]>;
  /** [t, task, cell] */
  claim: Array<[number, number, number]>;
  /** [t, task, cell] */
  ver: Array<[number, number, number]>;
  /** [t, key index, tier 1 = Jev / 2 = LLM, cell, latency ms, usd] */
  judge: Array<[number, number, number, number, number, number]>;
  adopt: number[];
  /** [t, cumulative usd] */
  cost: Array<[number, number]>;
  /** [t, key, disagreement, window] */
  guard: Array<[number, string, number, number]>;
  final: { correct: number; costUsd: number; auditable: number };
}

export interface RaceData {
  title: string;
  model: string;
  judgeModel: string;
  judgeKeys: JudgeKey[];
  ids: string[];
  runs: Record<string, RaceRun>;
}

export const SQ = { idle: 0, working: 1, verifying: 2, ok: 3, wrong: 4 } as const;

export type FeedLine = { t: number; tone: "s1" | "s2" | "ok" | "danger" | "alert"; text: string };

export interface JudgeTally {
  jev: number;
  llm: number;
  jevUsd: number;
  llmUsd: number;
}

export interface LaneState {
  squares: number[];
  sources: number[];
  done: number;
  correct: number;
  auditable: number;
  costUsd: number;
  verified: number;
  adopted: number;
  judges: Record<JudgeKey, JudgeTally>;
  total: JudgeTally;
  guard: RaceRun["guard"][number] | null;
  lastJevAt: number | null;
  lastLlmAt: number | null;
  feed: FeedLine[];
  finished: boolean;
  elapsedMs: number;
}

export const JUDGE_ZH: Record<JudgeKey, string> = {
  verify: "要不要复核",
  adopt: "收不收经验",
  dispute: "算不算真分歧",
  claim: "领哪道题",
};

const FEED = 3;
const tally = (): JudgeTally => ({ jev: 0, llm: 0, jevUsd: 0, llmUsd: 0 });
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`;

/** A lane at `t` ms into its run. One-context baselines (no claims) count every task as in progress from the start. */
export function laneAt(run: RaceRun, keys: readonly JudgeKey[], n: number, t: number): LaneState {
  const batch = run.claim.length === 0;
  const squares = new Array<number>(n).fill(batch && t > 0 ? SQ.working : SQ.idle);
  const sources = new Array<number>(n).fill(0);
  const feed: FeedLine[] = [];
  const push = (line: FeedLine) => {
    feed.push(line);
    if (feed.length > FEED) feed.shift();
  };

  for (const [at, i] of run.claim) {
    if (at > t) break;
    if (squares[i] !== SQ.ok && squares[i] !== SQ.wrong) squares[i] = SQ.working;
  }
  let verified = 0;
  for (const [at, i] of run.ver) {
    if (at > t) break;
    verified++;
    if (squares[i] !== SQ.ok && squares[i] !== SQ.wrong) squares[i] = SQ.verifying;
  }

  let done = 0;
  let correct = 0;
  let auditable = 0;
  let lastAcc: RaceRun["acc"][number] | null = null;
  for (const a of run.acc) {
    const [at, i, ok, src] = a;
    if (at > t) break;
    squares[i] = ok ? SQ.ok : SQ.wrong;
    sources[i] = src;
    done++;
    if (ok) correct++;
    if (src >= 2) auditable++;
    lastAcc = a;
  }

  const judges = Object.fromEntries(keys.map((k) => [k, tally()])) as Record<JudgeKey, JudgeTally>;
  const total = tally();
  let lastJevAt: number | null = null;
  let lastLlmAt: number | null = null;
  // Feed lines are merged by time from judgments, acceptances and guard trips.
  const lines: FeedLine[] = [];
  for (const [at, k, tier, cell, lat, usd] of run.judge) {
    if (at > t) break;
    const key = keys[k] ?? "verify";
    const slot = judges[key];
    if (tier === 1) {
      slot.jev++;
      slot.jevUsd += usd;
      total.jev++;
      total.jevUsd += usd;
      lastJevAt = at;
    } else {
      slot.llm++;
      slot.llmUsd += usd;
      total.llm++;
      total.llmUsd += usd;
      lastLlmAt = at;
    }
    lines.push({
      t: at,
      tone: tier === 1 ? "s1" : "s2",
      text: `c${String(cell).padStart(2, "0")} ${tier === 1 ? "用 Jev " : "请大模型"}判断「${JUDGE_ZH[key]}」· ${secs(lat)}`,
    });
  }
  let guard: LaneState["guard"] = null;
  for (const g of run.guard) {
    if (g[0] > t) break;
    guard = g;
    const key = (keys.includes(g[1] as JudgeKey) ? g[1] : "verify") as JudgeKey;
    lines.push({
      t: g[0],
      tone: "alert",
      text: `守卫：「${JUDGE_ZH[key]}」Jev 最近 ${g[3]} 次有 ${Math.round(g[2] * g[3])} 次和大模型不一致，整类交回大模型`,
    });
  }
  if (lastAcc) {
    const [at, i, ok, src] = lastAcc;
    lines.push({
      t: at,
      tone: ok ? "ok" : "danger",
      text: batch
        ? `一次交卷：${done} 题全部交上，答对 ${correct} 题`
        : `第 ${i + 1} 题收下 · ${ok ? "答对" : "答错"}${src >= 2 ? ` · ${src} 个独立来源` : ""}`,
    });
  }
  lines.sort((a, b) => a.t - b.t);
  for (const l of lines.slice(-FEED)) push(l);

  let costUsd = 0;
  for (const [at, usd] of run.cost) {
    if (at > t) break;
    costUsd = usd;
  }
  let adopted = 0;
  for (const at of run.adopt) {
    if (at > t) break;
    adopted++;
  }

  return {
    squares,
    sources,
    done,
    correct,
    auditable,
    costUsd,
    verified,
    adopted,
    judges,
    total,
    guard,
    lastJevAt,
    lastLlmAt,
    feed,
    finished: t >= run.durationMs,
    elapsedMs: Math.min(t, run.durationMs),
  };
}

/** Exact two-sided McNemar test on paired right/wrong outcomes. */
export function mcnemar(a: readonly boolean[], b: readonly boolean[]): { onlyA: number; onlyB: number; p: number } {
  let onlyA = 0;
  let onlyB = 0;
  a.forEach((x, i) => {
    if (x && !b[i]) onlyA++;
    if (!x && b[i]) onlyB++;
  });
  const n = onlyA + onlyB;
  const k = Math.min(onlyA, onlyB);
  let tail = 0;
  let c = 1;
  for (let i = 0; i <= k; i++) {
    tail += c;
    c = (c * (n - i)) / (i + 1);
  }
  return { onlyA, onlyB, p: n === 0 ? 1 : Math.min(1, (2 * tail) / 2 ** n) };
}

/** Per-task right/wrong for a finished run, in task order. */
export function outcomes(run: RaceRun, n: number): boolean[] {
  const out = new Array<boolean>(n).fill(false);
  for (const [, i, ok] of run.acc) out[i] = ok === 1;
  return out;
}
