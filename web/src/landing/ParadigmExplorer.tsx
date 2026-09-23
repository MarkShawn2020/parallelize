import { useState } from "react";
import { PARADIGMS, accuracyOf, radarValues, type Paradigm } from "../paradigms";
import { Radar, type RadarSeries } from "./Radar";

const TONE: Record<Paradigm["tone"], { text: string; stroke: string; fill: string; border: string }> = {
  muted: { text: "text-muted", stroke: "stroke-muted", fill: "fill-muted/25", border: "border-muted" },
  fg: { text: "text-fg", stroke: "stroke-fg", fill: "fill-fg/20", border: "border-fg" },
  s2: { text: "text-s2", stroke: "stroke-s2", fill: "fill-s2/20", border: "border-s2" },
  accent: { text: "text-accent", stroke: "stroke-accent", fill: "fill-accent/25", border: "border-accent" },
};

const signed = (x: number, digits = 0, unit = "") => `${x > 0 ? "+" : x < 0 ? "−" : "±"}${Math.abs(x).toFixed(digits)}${unit}`;

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-sm text-muted">{label}</span>
      <span className="font-mono text-3xl font-bold text-fg tabular-nums">{value}</span>
      {sub && <span className="text-sm text-fg/60 tabular-nums">{sub}</span>}
    </div>
  );
}

/** Pick a rung of the ladder; overlay any other rung on its radar to see what each step buys and costs. */
export function ParadigmExplorer() {
  const [pick, setPick] = useState(PARADIGMS.length - 1);
  const [against, setAgainst] = useState(3);
  const p = PARADIGMS[pick] ?? PARADIGMS[0];
  const q = PARADIGMS[against];
  if (!p) return null;
  const tone = TONE[p.tone];
  const series: RadarSeries[] = [];
  if (q && q !== p) series.push({ label: q.name, values: radarValues(q), stroke: "stroke-s1", fill: "fill-s1/10" });
  series.push({ label: p.name, values: radarValues(p), stroke: tone.stroke, fill: tone.fill });

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
      <ol className="flex flex-col gap-2" aria-label="九讲范式">
        {PARADIGMS.map((x, i) => (
          <li key={x.runId}>
            <button
              type="button"
              onClick={() => setPick(i)}
              aria-pressed={i === pick}
              className={`flex w-full items-center justify-between gap-3 border px-4 py-3 text-left transition-colors ${
                i === pick ? `${TONE[x.tone].border} bg-panel-2` : "border-grid hover:border-fg/50"
              }`}
            >
              <span className="flex items-baseline gap-3">
                <span className="font-mono text-sm text-muted">第 {x.lecture} 讲</span>
                <span className={`text-lg font-semibold ${i === pick ? TONE[x.tone].text : "text-fg"}`}>{x.name}</span>
              </span>
              <span className="font-mono text-lg text-fg/80 tabular-nums">{Math.round(accuracyOf(x))}%</span>
            </button>
          </li>
        ))}
        <li className="px-1 pt-2 text-sm leading-relaxed text-muted">第 8 讲容错与安全、第 9 讲经验与生态，在首页的蜂群回放和现场演示里看。</li>
      </ol>

      <div className="flex flex-col gap-6 border border-grid bg-panel p-6">
        <div className="flex flex-col gap-2">
          <span className="font-mono text-sm text-accent">第 {p.lecture} 讲</span>
          <h3 className={`text-3xl font-bold ${tone.text}`}>{p.name}</h3>
          <p className="text-lg leading-relaxed text-fg/80">{p.adds}</p>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <Metric label="准确率" value={`${Math.round(accuracyOf(p))}%`} sub={`${p.correct}/96`} />
          <Metric label="花费" value={`$${p.costUsd.toFixed(2)}`} sub="96 题合计" />
          <Metric label="用时" value={`${Math.round(p.wallS)}s`} sub="墙钟时间" />
        </div>

        <div className="flex flex-col items-center gap-8 md:flex-row md:items-start">
          <div className="px-14 py-8">
            <Radar series={series} size={220} />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <label className="flex flex-wrap items-center gap-2 text-sm text-muted">
              对比
              <select
                value={against}
                onChange={(e) => setAgainst(Number(e.target.value))}
                className="border border-grid bg-panel-2 px-2 py-1 text-base text-fg outline-none focus:border-accent"
              >
                {PARADIGMS.map((x, i) => (
                  <option key={x.runId} value={i}>
                    第 {x.lecture} 讲 · {x.name}
                  </option>
                ))}
              </select>
              <span className="text-s1">（青色轮廓）</span>
            </label>
            {q && q !== p && (
              <p className="font-mono text-base leading-relaxed text-fg/85 tabular-nums">
                比「{q.name}」：准确率 {signed(accuracyOf(p) - accuracyOf(q), 0, " 点")} · 花费 {signed(p.costUsd - q.costUsd, 2)} 美元 · 用时{" "}
                {signed(p.wallS - q.wallS, 0, " 秒")}
              </p>
            )}
            <div className="border-l-4 border-accent bg-panel-2 px-4 py-3">
              <p className="text-sm text-accent">适合</p>
              <p className="text-base text-fg">{p.fit}</p>
            </div>
            <div className="border-l-4 border-s2 bg-panel-2 px-4 py-3">
              <p className="text-sm text-s2">代价</p>
              <p className="text-base text-fg">{p.cost}</p>
            </div>
          </div>
        </div>
        <p className="text-sm text-muted">雷达越往外越好：越准、越省、越快。成本、速度以七种里最便宜、最快的为 100。</p>
      </div>
    </div>
  );
}
