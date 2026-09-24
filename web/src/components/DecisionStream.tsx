import { useState } from "react";
import type { Decision } from "../../../src/core/types";
import { fmtMs, fmtPct } from "../format";
import { Panel } from "./Panel";

interface Props {
  decisions: Decision[];
}

function describe(d: Decision): string {
  const tier = d.tier === "system1" ? "S1 Jev" : d.escalated ? "S2 大模型 (escalated)" : "S2 大模型";
  const where = [d.cellId, d.taskId].filter(Boolean).join(" · ");
  const flags = [
    d.precedentsUsed > 0 ? `先例 precedents ${d.precedentsUsed}` : "",
    d.guarded ? "守卫改道 guarded" : "",
    d.fallback ? "大模型失败→保守默认 fallback" : "",
  ].filter(Boolean);
  return [`${d.key} · ${tier} · 置信 conf ${d.confidence.toFixed(2)} · ${fmtMs(d.latencyMs)}`, ...flags, where]
    .filter(Boolean)
    .join(" · ");
}

function tickClass(d: Decision): string {
  if (d.fallback) return "bg-danger";
  return d.tier === "system1" ? "bg-s1" : "bg-s2";
}

export function DecisionStream({ decisions }: Props) {
  const [hovered, setHovered] = useState<Decision | null>(null);
  const s2 = decisions.filter((d) => d.tier === "system2").length;
  const s1 = decisions.length - s2;
  const fallbacks = decisions.filter((d) => d.fallback).length;
  const guarded = decisions.filter((d) => d.guarded).length;

  const summary = (
    <div className="text-xs text-muted tabular-nums">
      最近 last {decisions.length} · <span className="text-s1">S1 {s1}</span> / <span className="text-s2">S2 {s2}</span>
      {decisions.length > 0 && <> · 升级 {fmtPct(s2 / decisions.length)}</>}
      {guarded > 0 && <span className="text-warn"> · 守卫 {guarded}</span>}
      {fallbacks > 0 && <span className="text-danger"> · 保守默认 {fallbacks}</span>}
    </div>
  );

  return (
    <Panel title="决策流" en="Decisions" right={summary}>
      <div className="flex flex-col gap-1 px-3 py-2">
        <div className="flex h-12 items-end justify-end gap-px overflow-hidden" onMouseLeave={() => setHovered(null)}>
          {decisions.length === 0 && <div className="self-center text-sm text-muted">等待决策 Awaiting decisions</div>}
          {decisions.map((d) => (
            <div
              key={d.id}
              title={describe(d)}
              onMouseEnter={() => setHovered(d)}
              className={`w-1.5 shrink-0 ${tickClass(d)} ${d.guarded ? "opacity-60" : ""} ${hovered?.id === d.id ? "outline outline-fg" : ""}`}
              style={{ height: `${Math.max(18, Math.round(d.confidence * 100))}%` }}
            />
          ))}
        </div>
        <div className="h-4 truncate text-xs text-muted tabular-nums">
          {hovered ? (
            <span className="text-fg">{describe(hovered)}</span>
          ) : (
            "悬停查看决策 hover a tick · 高度 = 置信度 · 红 = 保守默认 red = fallback"
          )}
        </div>
      </div>
    </Panel>
  );
}
