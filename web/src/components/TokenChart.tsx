import type { LiveMetrics } from "../../../src/core/types";
import { fmtClock, fmtPct, fmtTokens } from "../format";
import { useElementWidth } from "../useElementWidth";
import { Panel } from "./Panel";

interface Props {
  history: LiveMetrics[];
  height: number;
}

const M = { top: 12, right: 48, bottom: 22, left: 56 };
const TICKS = 4;

function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

function path(points: Array<[number, number]>): string {
  return points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
}

const accuracyOf = (m: LiveMetrics) => (m.tasksTotal > 0 ? m.correct / m.tasksTotal : 0);

export function TokenChart({ history, height }: Props) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const last = history.at(-1);
  const applicable = last?.accuracyApplicable !== false;

  const legend = (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted tabular-nums">
      <Key className="bg-s1" label="协调 Token" value={last ? fmtTokens(last.coordinationTokens) : undefined} />
      <Key className="bg-fg" label="准确率 Accuracy" value={last ? (applicable ? fmtPct(accuracyOf(last)) : "N/A") : undefined} />
      <Key className="bg-s2" dashed label="升级率 Escalation" value={last ? fmtPct(last.escalationRate) : undefined} />
      <Key className="bg-danger" dashed label="放行错误率 Pass-through" value={last ? fmtPct(last.passThroughErrorRate) : undefined} />
    </div>
  );

  return (
    <Panel title="准确率 vs Token" en="Accuracy vs tokens" right={legend}>
      <div ref={ref} className="relative w-full" style={{ height }}>
        {width > 0 && history.length >= 2 ? (
          <Chart history={history} width={width} height={height} showAccuracy={applicable} />
        ) : (
          <div className="absolute inset-0 grid place-items-center text-sm text-muted">等待指标 Awaiting metrics</div>
        )}
      </div>
    </Panel>
  );
}

function Chart(props: { history: LiveMetrics[]; width: number; height: number; showAccuracy: boolean }) {
  const { history, width, height, showAccuracy } = props;
  const w = Math.max(10, width - M.left - M.right);
  const h = Math.max(10, height - M.top - M.bottom);
  const tMax = Math.max(1000, ...history.map((m) => m.elapsedMs));
  const tokMax = niceCeil(Math.max(...history.map((m) => m.coordinationTokens)) * 1.05);
  const x = (t: number) => M.left + (t / tMax) * w;
  const yTok = (v: number) => M.top + h - (v / tokMax) * h;
  const yUnit = (v: number) => M.top + h - Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0)) * h;

  const coord = path(history.map((m) => [x(m.elapsedMs), yTok(m.coordinationTokens)]));
  const accuracy = path(history.map((m) => [x(m.elapsedMs), yUnit(accuracyOf(m))]));
  const escalation = path(history.map((m) => [x(m.elapsedMs), yUnit(m.escalationRate)]));
  const passThrough = path(history.map((m) => [x(m.elapsedMs), yUnit(m.passThroughErrorRate)]));
  const ticks = Array.from({ length: TICKS + 1 }, (_, i) => i / TICKS);

  return (
    <svg
      width={width}
      height={height}
      className="absolute inset-0 font-mono"
      role="img"
      aria-label="协调 Token、准确率、升级率与放行错误率随时间变化"
    >
      {ticks.map((f) => {
        const y = M.top + h - f * h;
        return (
          <g key={f}>
            <line x1={M.left} x2={M.left + w} y1={y} y2={y} className="stroke-grid" strokeWidth={1} />
            <text x={M.left - 6} y={y} dy="0.32em" textAnchor="end" className="fill-s1 text-[11px]">
              {fmtTokens(f * tokMax)}
            </text>
            <text x={M.left + w + 6} y={y} dy="0.32em" className="fill-muted text-[11px]">
              {f.toFixed(2)}
            </text>
          </g>
        );
      })}
      {ticks.map((f) => (
        <text key={`t${f}`} x={M.left + f * w} y={height - 6} textAnchor="middle" className="fill-muted text-[11px]">
          {fmtClock(f * tMax)}
        </text>
      ))}
      <path d={passThrough} fill="none" className="stroke-danger" strokeWidth={2} strokeDasharray="2 3" />
      <path d={escalation} fill="none" className="stroke-s2" strokeWidth={2} strokeDasharray="6 3" />
      {showAccuracy && <path d={accuracy} fill="none" className="stroke-fg" strokeWidth={2.25} />}
      <path d={coord} fill="none" className="stroke-s1" strokeWidth={2.5} />
    </svg>
  );
}

function Key({ className, label, value, dashed }: { className: string; label: string; value: string | undefined; dashed?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className={`h-0.5 w-4 ${className}`}
        style={dashed ? { maskImage: "repeating-linear-gradient(90deg, #000 0 3px, transparent 3px 5px)" } : undefined}
      />
      {label}
      {value !== undefined && <span className="text-fg">{value}</span>}
    </span>
  );
}
