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

const positive = (x: number | undefined, tone: Tone): Tone => (x !== undefined && x > 0 ? tone : "fg");

export function MetricsPanel({ metrics: m, cellsTotal }: Props) {
  const v = <T,>(fn: (x: LiveMetrics) => T, fmt: (x: T) => string) => (m ? fmt(fn(m)) : DASH);
  const applicable = m?.accuracyApplicable !== false;

  return (
    <Panel title="指标" en="Metrics" bodyClassName="flex flex-col gap-px bg-grid">
      <div className="grid grid-cols-2 gap-px">
        <Stat
          label="准确率"
          en="Accuracy"
          value={applicable ? v((x) => x.accuracy, (x) => fmtPct(x)) : "N/A"}
          sub={
            !applicable
              ? "（研究场景只评金丝雀）"
              : m
                ? `${m.correct} / ${m.tasksTotal} 正确 correct · ${m.accepted} 接受`
                : undefined
          }
          tone={applicable ? "accent" : "muted"}
          size="xl"
        />
        <Stat label="正确/千 Token" en="Correct / 1k tok" value={v((x) => x.air, fmtAir)} size="xl" />
      </div>
      <div className="grid grid-cols-3 gap-px">
        <Stat label="总 Token" en="Total" value={v((x) => x.totalTokens, fmtTokens)} sub={m ? `工作 work ${fmtTokens(m.workTokens)}` : undefined} />
        <Stat label="协调 Token" en="Coordination" value={v((x) => x.coordinationTokens, fmtTokens)} tone="s1" />
        <Stat label="成本" en="Cost USD" value={v((x) => x.costUsd, fmtUsd)} />
      </div>
      <EscalationBar metrics={m} />
      <div className="grid grid-cols-3 gap-px">
        <Stat
          label="放行错误率"
          en="Pass-through"
          value={v((x) => x.passThroughErrorRate, (x) => fmtPct(x))}
          sub="S1 判免复核却错了"
          tone={positive(m?.passThroughErrorRate, "danger")}
        />
        <Stat
          label="错了还被复核放过"
          en="≥2 源错放"
          value={v((x) => x.falseAcceptVerifiedRate, (x) => fmtPct(x))}
          sub={m ? `全部错放 all ${fmtPct(m.falseAcceptRate)}` : undefined}
          tone={positive(m?.falseAcceptVerifiedRate, "danger")}
        />
        <Stat
          label="协调占比"
          en="Coord share"
          value={v((x) => x.coordinationShare, (x) => fmtPct(x))}
          sub="协调 / 总 Token"
          tone="s1"
        />
      </div>
      <div className="grid grid-cols-4 gap-px">
        <Stat label="判定延迟" en="Judge" value={v((x) => x.meanJudgeLatencyMs, fmtMs)} size="sm" />
        <Stat label="存活" en="Alive" value={m ? `${m.cellsAlive}/${cellsTotal || m.cellsAlive}` : DASH} size="sm" />
        <Stat label="回收" en="Reopened" value={v((x) => x.reopened, fmtInt)} tone={positive(m?.reopened, "warn")} size="sm" />
        <Stat label="回声警报" en="Echo" value={v((x) => x.echoAlarms, fmtInt)} tone={positive(m?.echoAlarms, "danger")} size="sm" />
        <Stat label="基因采纳" en="Adopted" value={v((x) => x.genesAdopted, fmtInt)} tone={positive(m?.genesAdopted, "gene")} size="sm" />
        <Stat label="已隔离" en="Quarantined" value={v((x) => x.quarantined, fmtInt)} tone={positive(m?.quarantined, "danger")} size="sm" />
        <Stat label="经验命中" en="Hits" value={v((x) => x.libraryHits, fmtInt)} tone={positive(m?.libraryHits, "s2")} size="sm" />
        <Stat label="继承 Gene" en="Inherited" value={v((x) => x.inheritedGenes, fmtInt)} tone={positive(m?.inheritedGenes, "gene")} size="sm" />
      </div>
    </Panel>
  );
}

const SIZE = {
  xl: "text-[clamp(2rem,2.8vw,3.4rem)]",
  md: "text-[clamp(1.3rem,1.6vw,1.9rem)]",
  sm: "text-[clamp(1.05rem,1.2vw,1.4rem)]",
} as const;

function Stat(props: { label: string; en: string; value: string; sub?: string; tone?: Tone; size?: keyof typeof SIZE }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 bg-panel px-3 py-1.5">
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
    <div className="flex flex-col gap-1 bg-panel px-3 py-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <div className="truncate text-[11px] tracking-wide text-muted">
          <span className="text-fg/80">升级率</span> Escalation · <span className="text-s1">S1 反射</span> {m ? fmtInt(m.s1Decisions) : DASH} /{" "}
          <span className="text-s2">S2 思考</span> {m ? fmtInt(m.s2Decisions) : DASH}
          {m?.jevDown && <span className="ml-2 text-warn">S1 离线</span>}
        </div>
        <div className="font-display text-[clamp(1.3rem,1.6vw,1.9rem)] leading-none font-semibold text-s2 tabular-nums">
          {m ? fmtPct(m.escalationRate) : DASH}
        </div>
      </div>
      <div className="flex h-2.5 w-full bg-panel-2" role="img" aria-label={`System 1 ${fmtPct(s1Share)}`}>
        <div className="h-full bg-s1 transition-[width] duration-500" style={{ width: `${s1Share * 100}%` }} />
        <div className="h-full flex-1 bg-s2" style={{ opacity: total > 0 ? 1 : 0 }} />
      </div>
    </div>
  );
}
