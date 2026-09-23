import type { LiveMetrics } from "../../../src/core/types";
import { DASH, fmtAir, fmtInt, fmtMs, fmtPct, fmtTokens, fmtUsd } from "../format";
import { Panel } from "./Panel";

interface Props {
  metrics: LiveMetrics | null;
  cellsTotal: number;
}

const TONE = {
  fg: "text-fg",
  accent: "text-accent",
  s1: "text-s1",
  s2: "text-s2",
  warn: "text-warn",
  danger: "text-danger",
  gene: "text-gene",
  muted: "text-muted",
} as const;
type Tone = keyof typeof TONE;

export function MetricsPanel({ metrics: m, cellsTotal }: Props) {
  const v = <T,>(fn: (x: LiveMetrics) => T, fmt: (x: T) => string) => (m ? fmt(fn(m)) : DASH);
  const coordShare = m && m.totalTokens > 0 ? m.coordinationTokens / m.totalTokens : 0;

  return (
    <Panel title="指标" en="Metrics" bodyClassName="flex flex-col gap-px bg-grid">
      <div className="grid grid-cols-2 gap-px">
        <Stat
          label="准确率"
          en="Accuracy"
          value={v((x) => x.accuracy, (x) => fmtPct(x))}
          sub={m ? `${m.correct} / ${m.tasksTotal} 正确 correct · ${m.accepted} 接受 accepted` : undefined}
          tone="accent"
          size="xl"
        />
        <Stat
          label="AIR"
          en="每千 Token 正确数"
          value={v((x) => x.air, fmtAir)}
          sub="correct / 1k tokens"
          tone="fg"
          size="xl"
        />
      </div>
      <div className="grid grid-cols-3 gap-px">
        <Stat label="总 Token" en="Total" value={v((x) => x.totalTokens, fmtTokens)} sub={m ? `工作 work ${fmtTokens(m.workTokens)}` : undefined} />
        <Stat
          label="协调 Token"
          en="Coordination"
          value={v((x) => x.coordinationTokens, fmtTokens)}
          sub={m ? `占比 share ${fmtPct(coordShare)}` : undefined}
          tone="s1"
        />
        <Stat label="成本" en="Cost USD" value={v((x) => x.costUsd, fmtUsd)} />
      </div>
      <EscalationBar metrics={m} />
      <div className="grid grid-cols-5 gap-px">
        <Stat label="判定延迟" en="Judge" value={v((x) => x.meanJudgeLatencyMs, fmtMs)} size="sm" />
        <Stat label="存活" en="Alive" value={m ? `${m.cellsAlive}/${cellsTotal || m.cellsAlive}` : DASH} size="sm" />
        <Stat label="回收" en="Reopened" value={v((x) => x.reopened, fmtInt)} tone={m && m.reopened > 0 ? "warn" : "fg"} size="sm" />
        <Stat label="回声警报" en="Echo" value={v((x) => x.echoAlarms, fmtInt)} tone={m && m.echoAlarms > 0 ? "danger" : "fg"} size="sm" />
        <Stat label="基因采纳" en="Genes" value={v((x) => x.genesAdopted, fmtInt)} tone={m && m.genesAdopted > 0 ? "gene" : "fg"} size="sm" />
      </div>
    </Panel>
  );
}

const SIZE = {
  xl: "text-[clamp(2.25rem,3.4vw,4rem)]",
  md: "text-[clamp(1.35rem,1.8vw,2.1rem)]",
  sm: "text-[clamp(1.05rem,1.3vw,1.5rem)]",
} as const;

function Stat(props: { label: string; en: string; value: string; sub?: string; tone?: Tone; size?: keyof typeof SIZE }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 bg-panel px-3 py-2">
      <div className="truncate text-[11px] tracking-wide text-muted">
        <span className="text-fg/80">{props.label}</span> {props.en}
      </div>
      <div className={`font-display leading-none font-semibold tabular-nums ${SIZE[props.size ?? "md"]} ${TONE[props.tone ?? "fg"]}`}>
        {props.value}
      </div>
      {props.sub && <div className="truncate text-[11px] text-muted tabular-nums">{props.sub}</div>}
    </div>
  );
}

function EscalationBar({ metrics: m }: { metrics: LiveMetrics | null }) {
  const total = m ? m.s1Decisions + m.s2Decisions : 0;
  const s1Share = m && total > 0 ? m.s1Decisions / total : 0;
  return (
    <div className="flex flex-col gap-1.5 bg-panel px-3 py-2">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[11px] tracking-wide text-muted">
          <span className="text-fg/80">升级率</span> Escalation · <span className="text-s1">System 1 反射</span> /{" "}
          <span className="text-s2">System 2 思考</span>
        </div>
        <div className="font-display text-[clamp(1.35rem,1.8vw,2.1rem)] leading-none font-semibold text-s2 tabular-nums">
          {m ? fmtPct(m.escalationRate) : DASH}
        </div>
      </div>
      <div className="flex h-3 w-full bg-panel-2" role="img" aria-label={`System 1 ${fmtPct(s1Share)}`}>
        <div className="h-full bg-s1 transition-[width] duration-500" style={{ width: `${s1Share * 100}%` }} />
        <div className="h-full flex-1 bg-s2" style={{ opacity: total > 0 ? 1 : 0 }} />
      </div>
      <div className="flex justify-between text-[11px] text-muted tabular-nums">
        <span>
          S1 <span className="text-s1">{m ? fmtInt(m.s1Decisions) : DASH}</span>
        </span>
        <span>
          S2 <span className="text-s2">{m ? fmtInt(m.s2Decisions) : DASH}</span>
        </span>
      </div>
    </div>
  );
}
