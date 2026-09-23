import { useEffect, useState } from "react";
import type { EchoAlarm } from "../state";

interface Props {
  alarms: EchoAlarm[];
}

const FLASH_MS = 4000;
// Both states share one height so a firing alarm never shifts the rest of the layout.
const FRAME = "flex h-16 shrink-0 flex-col justify-center gap-0.5 px-3";

export function EchoBanner({ alarms }: Props) {
  const latest = alarms.at(-1);
  const [flashing, setFlashing] = useState<EchoAlarm | null>(null);

  useEffect(() => {
    if (!latest) return;
    setFlashing(latest);
    const timer = setTimeout(() => setFlashing(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [latest]);

  if (flashing) {
    return (
      <div role="alert" className={`${FRAME} animate-echo border-2 border-danger`}>
        <div className="truncate font-display text-xl leading-tight font-bold tracking-[0.2em] text-danger">
          回声警报 ECHO ALARM · {flashing.taskId}
        </div>
        <div className="truncate text-sm text-fg tabular-nums">
          {flashing.agreeing} 一致 agreeing → {flashing.independentSources} 独立来源 independent · 伪共识 false consensus
        </div>
      </div>
    );
  }

  return (
    <div className={`${FRAME} border border-grid bg-panel/90 text-sm text-muted`}>
      <div className="flex items-center justify-between gap-3">
        <span className="truncate">
          <span className="text-fg">回声监测</span> Echo watch
        </span>
        <span className={`tabular-nums ${alarms.length > 0 ? "text-danger" : ""}`}>{alarms.length} 次 alarms</span>
      </div>
      <div className="truncate text-xs">
        {latest
          ? `最近 last ${latest.taskId} · ${latest.agreeing} 一致 / ${latest.independentSources} 独立来源`
          : "同源一致即报警 alarms when agreement shares one lineage"}
      </div>
    </div>
  );
}
