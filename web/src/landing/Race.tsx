import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { RADAR_AXES } from "../paradigms";
import { STATIC_SITE } from "../site";
import { Radar, type RadarSeries } from "./Radar";
import { SQ, laneAt, mcnemar, outcomes, type JudgeKey, type LaneState, type RaceData, type RaceRun } from "./raceData";

type LaneId = "single" | "swarm-rules" | "swarm-llm" | "swarm-jev";
type Middle = "rules" | "llm";

interface LaneMeta {
  name: string;
  how: string;
  judge: string;
  judgeChip: string;
  text: string;
  border: string;
  stroke: string;
  fill: string;
  bar: string;
}

const LANES: Record<LaneId, LaneMeta> = {
  single: {
    name: "单 Agent",
    how: "一个 Agent、一个上下文，一次调用把 96 题从头做到尾，做完才交卷。",
    judge: "没有判断环节",
    judgeChip: "border-grid text-muted",
    text: "text-fg",
    border: "border-grid",
    stroke: "stroke-muted",
    fill: "fill-muted/25",
    bar: "bg-muted",
  },
  "swarm-rules": {
    name: "规则蜂群",
    how: "8 个 Agent 在黑板上领题、互相复核、在邻居间传经验（按 EvoMap 公开的 gossip / adopt / forget 实现）。",
    judge: "判断用固定规则 · 0 token",
    judgeChip: "border-fg/40 text-fg/85",
    text: "text-fg",
    border: "border-fg/40",
    stroke: "stroke-fg",
    fill: "fill-fg/15",
    bar: "bg-fg/70",
  },
  "swarm-llm": {
    name: "LLM 蜂群",
    how: "8 个 Agent 在黑板上领题、互相复核、在邻居间传经验（按 EvoMap 公开的 gossip / adopt / forget 实现）。",
    judge: "判断全交大模型",
    judgeChip: "border-s2/60 text-s2",
    text: "text-fg",
    border: "border-s2/50",
    stroke: "stroke-s2",
    fill: "fill-s2/20",
    bar: "bg-s2",
  },
  "swarm-jev": {
    name: "JIS 蜂群",
    how: "同一个蜂群，只把判断换成 Jev：约半秒一次、几乎不花钱；这一轮里一部分判断交回大模型。",
    judge: "Jev 先判断 → 部分交大模型",
    judgeChip: "border-s1/60 text-s1",
    text: "text-accent",
    border: "border-accent",
    stroke: "stroke-accent",
    fill: "fill-accent/25",
    bar: "bg-accent",
  },
};

const SPEEDS = [1, 4, 8, 16] as const;
const TICK_MS = 40;
/** How long, in wall time, a judgment keeps its pip lit. */
const PIP_MS = 350;

const SQUARE: Record<number, string> = {
  [SQ.idle]: "bg-grid",
  [SQ.working]: "bg-fg/25 motion-safe:animate-pulse",
  [SQ.verifying]: "bg-verify/80",
  [SQ.ok]: "bg-ok",
  [SQ.wrong]: "bg-danger",
};
const SQUARE_ZH: Record<number, string> = {
  [SQ.idle]: "还没开始",
  [SQ.working]: "正在做",
  [SQ.verifying]: "复核中",
  [SQ.ok]: "答对",
  [SQ.wrong]: "答错",
};
const FEED_TONE: Record<string, string> = {
  s1: "text-s1",
  s2: "text-s2",
  ok: "text-ok",
  danger: "text-danger",
  alert: "text-alert",
};

const usd = (x: number) => (x === 0 ? "$0" : x < 0.01 ? `$${x.toFixed(4)}` : `$${x.toFixed(3)}`);
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}`;
const pct = (x: number, n: number) => Math.round((x / n) * 100);
const fmtP = (p: number) => (p < 0.001 ? "p < 0.001" : `p = ${p.toFixed(2)}`);

function useRaceData(): RaceData | null | "error" {
  const [data, setData] = useState<RaceData | null | "error">(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/race/hard-96.json")
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json() as Promise<RaceData>;
      })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setData("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return data;
}

/** Replay clock in run milliseconds. A timer, not rAF, so it keeps going in a background or occluded pane. */
function useClock(speed: number, end: number) {
  const [t, setT] = useState(0);
  const [running, setRunning] = useState(false);
  const tRef = useRef(0);

  useEffect(() => {
    if (!running) return;
    const wall0 = performance.now();
    const sim0 = tRef.current;
    const id = window.setInterval(() => {
      const next = Math.min(end, sim0 + (performance.now() - wall0) * speed);
      tRef.current = next;
      setT(next);
      if (next >= end) setRunning(false);
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [running, speed, end]);

  const seek = useCallback((to: number) => {
    tRef.current = to;
    setT(to);
  }, []);
  return { t, running, setRunning, seek };
}

function Chip({ className, children }: { className: string; children: ReactNode }) {
  return <span className={`border px-2 py-0.5 text-xs ${className}`}>{children}</span>;
}

function Pip({ on, tone, label }: { on: boolean; tone: "s1" | "s2"; label: string }) {
  const lit = tone === "s1" ? "bg-s1 shadow-[0_0_12px_var(--color-s1)]" : "bg-s2 shadow-[0_0_12px_var(--color-s2)]";
  return (
    <span className={`flex items-center gap-1.5 text-xs ${on ? (tone === "s1" ? "text-s1" : "text-s2") : "text-muted"}`}>
      <span className={`size-2.5 rounded-full transition-colors ${on ? lit : "bg-grid"}`} aria-hidden />
      {label}
    </span>
  );
}

function Stat({ label, value, sub, tone = "text-fg" }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="text-xs text-muted">{label}</span>
      <span className={`font-mono text-xl font-bold tabular-nums ${tone}`}>{value}</span>
      {sub && <span className="truncate text-xs text-fg/60 tabular-nums">{sub}</span>}
    </div>
  );
}

function Lane({ id, run, s, ids, speed, t, scale }: { id: LaneId; run: RaceRun; s: LaneState; ids: string[]; speed: number; t: number; scale: number }) {
  const m = LANES[id];
  const n = ids.length;
  const progress = Math.min(1, s.elapsedMs / run.durationMs);
  const jevOn = s.lastJevAt !== null && t - s.lastJevAt < PIP_MS * speed;
  const llmOn = s.lastLlmAt !== null && t - s.lastLlmAt < PIP_MS * speed;
  const judged = s.total.jev + s.total.llm;
  const batch = run.claim.length === 0;

  return (
    <article className={`flex min-w-0 flex-col gap-4 border-2 bg-panel/90 p-5 ${m.border}`}>
      <header className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className={`text-2xl font-bold ${m.text}`}>{m.name}</h3>
          {s.finished ? (
            <span className="bg-fg px-2 py-0.5 font-mono text-sm font-bold text-bg">交卷 {secs(run.durationMs)} 秒</span>
          ) : t > 0 ? (
            <span className="font-mono text-sm text-muted">进行中</span>
          ) : null}
        </div>
        <p className="min-h-[3em] text-sm leading-relaxed text-fg/75">{m.how}</p>
        <div className="flex flex-wrap gap-2">
          <Chip className="border-grid text-fg/80">做题 Haiku 4.5 · {run.cells === 1 ? "1 个 Agent" : `${run.cells} 个 Agent`}</Chip>
          <Chip className={m.judgeChip}>{m.judge}</Chip>
        </div>
      </header>

      <div className="grid grid-cols-12 gap-[3px]" role="img" aria-label={`${m.name}：已交 ${s.done} 题，答对 ${s.correct} 题`}>
        {s.squares.map((q, i) => (
          <span
            key={ids[i]}
            className={`relative aspect-square transition-colors duration-300 ${SQUARE[q] ?? "bg-grid"}`}
            title={`第 ${i + 1} 题 · ${SQUARE_ZH[q] ?? ""}`}
          />
        ))}
      </div>

      <div className="h-1.5 bg-grid" aria-hidden>
        <div className={`h-full ${m.bar}`} style={{ width: `${progress * 100}%` }} />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Stat label="答对" value={String(s.correct)} sub={`已交 ${s.done}/${n}`} tone={s.finished && id === "swarm-jev" ? "text-accent" : "text-fg"} />
        <Stat label="花费" value={usd(s.costUsd)} sub={batch && !s.finished ? "交卷时结算" : "累计"} />
        <Stat label="用时" value={`${secs(s.elapsedMs)}s`} sub="真实时间" />
      </div>

      <div className="flex flex-col gap-2 border-t border-grid pt-3">
        {id === "single" && <p className="text-sm text-fg/75">没有复核：做错了没人发现，每个答案只有一个来源。</p>}
        {id === "swarm-rules" && (
          <p className="text-sm text-fg/75">
            判断全按固定规则，不花 token：已复核 <span className="font-mono text-fg tabular-nums">{s.verified}</span> 次，收下经验{" "}
            <span className="font-mono text-fg tabular-nums">{s.adopted}</span> 条。
          </p>
        )}
        {(id === "swarm-llm" || id === "swarm-jev") && (
          <>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="text-sm text-fg/85">
                判断 <span className="font-mono tabular-nums">{judged}</span> 次
              </span>
              {id === "swarm-jev" && <Pip on={jevOn} tone="s1" label={`Jev ${s.total.jev}`} />}
              <Pip on={llmOn} tone="s2" label={`大模型 ${s.total.llm}`} />
              <span className="ml-auto font-mono text-xs text-muted tabular-nums">判断花费 {usd(s.total.jevUsd + s.total.llmUsd)}</span>
            </div>
            <div className="flex h-2 bg-grid" aria-hidden>
              <div className="h-full bg-s1" style={{ width: `${(s.total.jev / scale) * 100}%` }} />
              <div className="h-full bg-s2" style={{ width: `${(s.total.llm / scale) * 100}%` }} />
            </div>
          </>
        )}
      </div>

      <ul className="flex min-h-[4.5em] flex-col gap-0.5 font-mono text-xs" aria-live="off">
        {batch && !s.finished && t > 0 && <li className="text-fg/60">一次调用里从第 1 题做到第 {n} 题，做完才交卷…</li>}
        {s.feed.map((l) => (
          <li key={`${l.t}-${l.text}`} className={`truncate ${FEED_TONE[l.tone] ?? "text-fg/70"}`} title={l.text}>
            {secs(l.t)}s · {l.text}
          </li>
        ))}
        {t === 0 && <li className="text-muted">等待开始</li>}
      </ul>
    </article>
  );
}

/** Who makes a call in one lane. A Jev cell shows how many calls Jev and the LLM each made, or what they cost. */
type Who =
  | { kind: "none" | "rule" | "model" | "llm"; text: string }
  | { kind: "jev"; jev: number; llm: number; money?: boolean; note?: string };

const WHO_STYLE: Record<Who["kind"], string> = {
  none: "border-grid text-muted",
  rule: "border-fg/30 text-fg/85",
  model: "border-grid text-fg/85",
  llm: "border-s2/60 bg-s2/10 text-s2",
  jev: "border-s1/70 bg-s1/10 text-s1",
};

function WhoCell({ w }: { w: Who }) {
  if (w.kind !== "jev") return <div className={`flex min-h-14 items-center border px-3 py-2 text-sm ${WHO_STYLE[w.kind]}`}>{w.text}</div>;
  return (
    <div className={`flex min-h-14 flex-col justify-center gap-1 border px-3 py-2 text-sm ${WHO_STYLE.jev}`}>
      {w.money ? (
        <>
          <span className="font-mono text-fg tabular-nums">{usd(w.jev + w.llm)}</span>
          <span className="font-mono text-xs tabular-nums">
            <span className="text-s1">Jev {usd(w.jev)}</span> · <span className="text-s2">大模型 {usd(w.llm)}</span>
          </span>
        </>
      ) : (
        <span className="flex flex-wrap items-baseline gap-x-3 font-mono tabular-nums">
          <span className="font-semibold text-s1">Jev {w.jev}</span>
          <span className="text-s2">大模型 {w.llm}</span>
        </span>
      )}
      {w.note && <span className="text-xs text-alert">{w.note}</span>}
    </div>
  );
}

function JevMap({ middle, mid, jev, single }: { middle: Middle; mid: LaneState; jev: LaneState; single: LaneState }) {
  const judgeRow = (key: JudgeKey, none: string, rule: string): [Who, Who, Who] => [
    { kind: "none", text: none },
    middle === "rules" ? { kind: "rule", text: rule } : { kind: "llm", text: `大模型 ${mid.judges[key].llm} 次` },
    {
      kind: "jev",
      jev: jev.judges[key].jev,
      llm: jev.judges[key].llm,
      note: key === "verify" && jev.guard ? "守卫触发：Jev 和大模型分歧太大，这一类交回大模型" : undefined,
    },
  ];
  const rows: ReadonlyArray<[string, string, [Who, Who, Who]]> = [
    [
      "领题 · 续租 · 合并答案",
      "谁有空谁领；掉线的题租约到期自动退回",
      [
        { kind: "none", text: "一个上下文全包" },
        { kind: "rule", text: "黑板规则 · 0 token" },
        { kind: "rule", text: "黑板规则 · 0 token" },
      ],
    ],
    [
      "做题",
      "三条车道同一个做题模型",
      [
        { kind: "model", text: "Haiku 4.5 · 1 次调用" },
        { kind: "model", text: "Haiku 4.5 · 8 个 Agent" },
        { kind: "model", text: "Haiku 4.5 · 8 个 Agent" },
      ],
    ],
    ["要不要复核", "这个答案值不值得让另一个 Agent 再做一遍", judgeRow("verify", "不复核", `固定规则 · 已复核 ${mid.verified} 次`)],
    ["算不算真分歧", "两个答案对不上，是真错还是写法不同", judgeRow("dispute", "没有第二个答案", "固定规则")],
    ["收不收经验（Gene）", "邻居传来的解题经验适不适合自己", judgeRow("adopt", "没有经验传递", `固定规则 · 收下 ${mid.adopted} 条`)],
    [
      "判断花费",
      "按每次判断记录的花费累计",
      [
        { kind: "none", text: usd(single.total.jevUsd + single.total.llmUsd) },
        middle === "rules" ? { kind: "rule", text: "$0 · 规则不花 token" } : { kind: "llm", text: usd(mid.total.llmUsd) },
        { kind: "jev", jev: jev.total.jevUsd, llm: jev.total.llmUsd, money: true },
      ],
    ],
  ];

  return (
    <div className="flex flex-col gap-3 border border-grid bg-panel/90 p-5">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <h3 className="text-xl font-bold text-fg">哪些环节用了 Jev</h3>
        <span className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <span className="text-s1">■ Jev（System 1，约半秒）</span>
          <span className="text-s2">■ 大模型（System 2）</span>
          <span className="text-fg/85">□ 固定规则（0 token）</span>
        </span>
      </div>
      <div className="overflow-x-auto">
        <div className="grid min-w-[720px] grid-cols-[minmax(0,1.3fr)_repeat(3,minmax(0,1fr))] gap-2">
          <span />
          <span className="text-sm font-semibold text-fg/85">单 Agent</span>
          <span className="text-sm font-semibold text-fg/85">{middle === "rules" ? "规则蜂群" : "LLM 蜂群"}</span>
          <span className="text-sm font-semibold text-accent">JIS 蜂群</span>
          {rows.map(([label, hint, cells]) => (
            <div key={label} className="contents">
              <div className="flex flex-col justify-center">
                <span className="text-base font-semibold text-fg">{label}</span>
                <span className="text-xs text-muted">{hint}</span>
              </div>
              <WhoCell w={cells[0]} />
              <WhoCell w={cells[1]} />
              <WhoCell w={cells[2]} />
            </div>
          ))}
        </div>
      </div>
      <p className="text-sm leading-relaxed text-muted">
        对照蜂群和 JIS 蜂群只差青色这几格：领题、合并、防作恶是同一套规则；Jev 只替换「规则写不出来、又不值得每次都请大模型」的判断。
      </p>
    </div>
  );
}

function Summary({ data, lanes, middle }: { data: RaceData; lanes: ReadonlyArray<[LaneId, RaceRun]>; middle: Middle }) {
  const n = data.ids.length;
  const minCost = Math.min(...lanes.map(([, r]) => r.final.costUsd));
  const minWall = Math.min(...lanes.map(([, r]) => r.durationMs));
  const series: RadarSeries[] = lanes.map(([id, r]) => ({
    label: LANES[id].name,
    values: [pct(r.final.correct, n), (minCost / r.final.costUsd) * 100, (minWall / r.durationMs) * 100],
    stroke: LANES[id].stroke,
    fill: LANES[id].fill,
  }));

  const single = lanes[0]?.[1];
  const mid = lanes[1]?.[1];
  const jev = lanes[2]?.[1];
  if (!single || !mid || !jev) return null;
  const J = outcomes(jev, n);
  const vsSingle = mcnemar(J, outcomes(single, n));
  const vsMid = mcnemar(J, outcomes(mid, n));
  const jevJudge = laneAt(jev, data.judgeKeys, n, Infinity).total;
  const midJudge = laneAt(mid, data.judgeKeys, n, Infinity).total;
  const midName = middle === "rules" ? "规则蜂群" : "LLM 蜂群";
  const jevVerified = laneAt(jev, data.judgeKeys, n, Infinity).verified;
  const midVerified = laneAt(mid, data.judgeKeys, n, Infinity).verified;
  const judgeText = (id: LaneId, r: RaceRun) => {
    if (id === "single") return "无";
    if (id === "swarm-rules") return "固定规则";
    const s = id === "swarm-jev" ? jevJudge : midJudge;
    return id === "swarm-jev" ? `Jev ${s.jev} · 大模型 ${s.llm}` : `大模型 ${s.llm}`;
  };

  const lines = [
    `JIS 蜂群答对 ${jev.final.correct} 题，单 Agent ${single.final.correct} 题：只有 JIS 蜂群答对的 ${vsSingle.onlyA} 题，只有单 Agent 答对的 ${vsSingle.onlyB} 题（${fmtP(vsSingle.p)}）。`,
    `比${midName}多答对 ${jev.final.correct - mid.final.correct} 题：只有 JIS 蜂群答对 ${vsMid.onlyA} 题、只有${midName}答对 ${vsMid.onlyB} 题（${fmtP(vsMid.p)}，${vsMid.p < 0.05 ? "差距显著" : "差距还不显著"}）。`,
    middle === "rules"
      ? `代价：花费 $${jev.final.costUsd.toFixed(2)} 对 $${mid.final.costUsd.toFixed(2)}，用时 ${Math.round(jev.durationMs / 1000)} 秒对 ${Math.round(mid.durationMs / 1000)} 秒。多出的钱里判断占 ${usd(jevJudge.jevUsd + jevJudge.llmUsd)}，其余主要是多做的复核：${jevVerified} 次对 ${midVerified} 次。`
      : `判断：大模型判断从 ${midJudge.llm} 次降到 ${jevJudge.llm} 次，Jev 做的 ${jevJudge.jev} 次判断一共 ${usd(jevJudge.jevUsd)}；总花费 $${jev.final.costUsd.toFixed(2)} 对 $${mid.final.costUsd.toFixed(2)}，用时 ${Math.round(jev.durationMs / 1000)} 秒对 ${Math.round(mid.durationMs / 1000)} 秒。`,
  ];

  return (
    <div className="flex flex-col gap-6 border-2 border-accent/70 bg-panel/90 p-6">
      <h3 className="text-2xl font-bold text-fg">结果汇总</h3>
      <div className="grid items-start gap-8 lg:grid-cols-[auto_minmax(0,1fr)]">
        <div className="flex flex-col items-center gap-4">
          <div className="px-14 py-8">
            <Radar series={series} size={240} />
          </div>
          <ul className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-sm">
            {lanes.map(([id]) => (
              <li key={id} className="flex items-center gap-1.5">
                <span className={`inline-block h-1 w-5 ${LANES[id].bar}`} aria-hidden />
                <span className={id === "swarm-jev" ? "text-accent" : "text-fg/85"}>{LANES[id].name}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-left">
              <thead>
                <tr className="border-b border-grid text-sm text-muted">
                  <th className="py-2 pr-3 font-normal">方式</th>
                  <th className="py-2 pr-3 font-normal">准确率</th>
                  <th className="py-2 pr-3 font-normal">花费</th>
                  <th className="py-2 pr-3 font-normal">用时</th>
                  <th className="py-2 font-normal">判断由谁做</th>
                </tr>
              </thead>
              <tbody className="font-mono tabular-nums">
                {lanes.map(([id, r]) => (
                  <tr key={id} className={`border-b border-grid ${id === "swarm-jev" ? "text-accent" : "text-fg"}`}>
                    <td className="py-2.5 pr-3 font-sans font-semibold">{LANES[id].name}</td>
                    <td className="py-2.5 pr-3 text-lg font-bold">
                      {pct(r.final.correct, n)}% <span className="text-xs font-normal text-muted">{r.final.correct}/{n}</span>
                    </td>
                    <td className="py-2.5 pr-3">${r.final.costUsd.toFixed(2)}</td>
                    <td className="py-2.5 pr-3">{Math.round(r.durationMs / 1000)} 秒</td>
                    <td className="py-2.5 text-sm">{judgeText(id, r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="flex flex-col gap-2 text-base leading-relaxed text-fg/85">
            {lines.map((l) => (
              <li key={l} className="border-l-2 border-accent/60 pl-3">
                {l}
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted">
            雷达越往外越好：{RADAR_AXES.join(" · ")}，越准、越省、越快；成本、速度以三者里最便宜、最快的为 100。p 值为按题配对的精确 McNemar 检验。
          </p>
        </div>
      </div>
    </div>
  );
}

const LEGEND: ReadonlyArray<[string, string]> = [
  [SQUARE[SQ.idle] ?? "", "还没开始"],
  ["bg-fg/25", "正在做"],
  [SQUARE[SQ.verifying] ?? "", "复核中"],
  [SQUARE[SQ.ok] ?? "", "答对"],
  [SQUARE[SQ.wrong] ?? "", "答错"],
];

/**
 * Three lanes on one clock: the same 96 problems, the same solver model, three ways of working together. The board
 * opens on the final result; "重跑一遍" replays the recorded runs from the first second.
 */
export function Race({ onReady }: { onReady?: () => void }) {
  const data = useRaceData();
  const [speed, setSpeed] = useState<number>(8);
  const [middle, setMiddle] = useState<Middle>("rules");
  const ready = data !== null && data !== "error";

  const lanes = useMemo((): ReadonlyArray<[LaneId, RaceRun]> => {
    if (!ready) return [];
    const ids: LaneId[] = ["single", middle === "rules" ? "swarm-rules" : "swarm-llm", "swarm-jev"];
    return ids.flatMap((id) => {
      const r = data.runs[id];
      return r ? [[id, r] as [LaneId, RaceRun]] : [];
    });
  }, [data, ready, middle]);
  const end = lanes.reduce((m, [, r]) => Math.max(m, r.durationMs), 0);
  // Judgment bars share one scale, so the Jev and LLM lanes compare at a glance.
  const judgeScale = lanes.reduce((m, [, r]) => Math.max(m, r.judge.length), 1);
  const { t: clock, running, setRunning, seek } = useClock(speed, end);
  // Until someone replays, every lane shows where its run ended.
  const [replaying, setReplaying] = useState(false);
  const t = replaying ? clock : end;
  const done = t >= end;

  const replay = useCallback(() => {
    setReplaying(true);
    seek(0);
    setRunning(true);
  }, [seek, setRunning]);
  const showResult = useCallback(() => {
    setRunning(false);
    setReplaying(false);
  }, [setRunning]);

  // The board is ~1000px tall and arrives after the page: a deep link to a section below it re-scrolls then.
  useEffect(() => {
    if (ready) onReady?.();
  }, [ready, onReady]);

  const states = useMemo(() => (ready ? lanes.map(([, r]) => laneAt(r, data.judgeKeys, data.ids.length, t)) : []), [data, ready, lanes, t]);

  if (data === "error") return <p className="border border-grid bg-panel p-6 text-fg/80">对照数据没有加载成功，刷新页面再试。</p>;
  if (!ready || states.length < 3) return <p className="border border-grid bg-panel p-6 text-muted">加载对照数据…</p>;
  const [single, mid, jev] = states as [LaneState, LaneState, LaneState];

  const primary = running ? "暂停" : done ? "重跑一遍" : "继续";

  return (
    <div id="race-board" className="flex scroll-mt-16 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3 border border-grid bg-panel/90 p-4">
        <button
          type="button"
          onClick={() => (running ? setRunning(false) : done ? replay() : setRunning(true))}
          className="min-w-36 bg-accent px-6 py-3 text-lg font-bold text-bg hover:bg-accent/85"
        >
          {primary}
        </button>
        <button
          type="button"
          onClick={showResult}
          disabled={done}
          className="border border-fg/40 px-4 py-3 text-fg hover:border-fg disabled:opacity-40"
        >
          直接看结果
        </button>
        <span className="flex items-center gap-1.5 text-sm text-muted">
          倍速
          {SPEEDS.map((x) => (
            <button
              key={x}
              type="button"
              onClick={() => setSpeed(x)}
              aria-pressed={speed === x}
              className={`border px-2 py-1 font-mono ${speed === x ? "border-accent text-accent" : "border-grid text-fg/75 hover:text-fg"}`}
            >
              {x}×
            </button>
          ))}
        </span>
        <span className="font-mono text-sm text-fg/85 tabular-nums">
          {replaying && !done ? `回放中 · 真实时间 ${secs(t)} / ${secs(end)} 秒` : `最终结果 · 最慢的一路用了 ${secs(end)} 秒`}
        </span>
        <span className="flex flex-wrap items-center gap-1.5 text-sm text-muted lg:ml-auto">
          对照蜂群的判断
          {(
            [
              ["rules", "固定规则"],
              ["llm", "全交大模型"],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              onClick={() => setMiddle(v)}
              aria-pressed={middle === v}
              className={`border px-2 py-1 ${middle === v ? (v === "llm" ? "border-s2 text-s2" : "border-fg text-fg") : "border-grid text-fg/75 hover:text-fg"}`}
            >
              {label}
            </button>
          ))}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-fg/75">
        <span className="text-muted">每个格子是一道题：</span>
        {LEGEND.map(([cls, label]) => (
          <span key={label} className="flex items-center gap-1.5">
            <span className={`inline-block size-3.5 ${cls}`} aria-hidden />
            {label}
          </span>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {lanes.map(([id, r], i) => {
          const s = states[i];
          return s ? <Lane key={id} id={id} run={r} s={s} ids={data.ids} speed={speed} t={t} scale={judgeScale} /> : null;
        })}
      </div>

      {done ? (
        <Summary data={data} lanes={lanes} middle={middle} />
      ) : (
        <div className="border border-dashed border-grid px-5 py-4 text-sm text-muted">
          三条车道都交卷后，这里重新出雷达图和汇总表；也可以点「直接看结果」。
        </div>
      )}

      <JevMap middle={middle} mid={mid} jev={jev} single={single} />

      <p className="text-sm leading-relaxed text-muted">
        回放 2026-09-23 三次真实运行的事件记录，时间按所选倍速压缩，不会重新调用模型；每一格何时变色、每次判断由谁做、花了多少，都来自当次记录。规则蜂群和
        LLM 蜂群是本项目按 EvoMap 公开的 gossip / adopt / forget 协议实现的，不是 EvoMap 官方的 EvoX。想看真跑一轮：
        {STATIC_SITE ? "按 GitHub 上的快速开始在本地运行现场演示。" : "进入现场演示。"}
      </p>
    </div>
  );
}
