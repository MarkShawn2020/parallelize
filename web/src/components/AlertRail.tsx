import type { ReactNode } from "react";
import type { Compromise, Denial, GuardAlarm, QuarantineAlarm } from "../state";
import { useFlash } from "../useFlash";

interface Props {
  jevDown: boolean;
  llmDown: boolean;
  quarantines: QuarantineAlarm[];
  compromises: Compromise[];
  guards: GuardAlarm[];
  denials: Denial[];
}

const HOLD_MS = 8000;
const DENIED_MS = 3000;

const TONE = {
  warn: "border-warn bg-warn/15 text-warn",
  danger: "animate-echo border-danger text-danger",
} as const;

function Alert({ tone, title, detail }: { tone: keyof typeof TONE; title: string; detail: ReactNode }) {
  return (
    <div role="alert" className={`flex min-w-0 flex-1 items-center gap-3 border-2 px-3 ${TONE[tone]}`}>
      <span className="shrink-0 font-display text-lg leading-none font-bold tracking-[0.12em]">{title}</span>
      <span className="min-w-0 truncate text-sm text-fg">{detail}</span>
    </div>
  );
}

export function AlertRail({ jevDown, llmDown, quarantines, compromises, guards, denials }: Props) {
  const quarantine = useFlash(quarantines.at(-1), HOLD_MS);
  const hacked = useFlash(compromises.at(-1), HOLD_MS);
  const guard = useFlash(guards.at(-1), HOLD_MS);
  const denied = useFlash(denials.at(-1), DENIED_MS);
  const deniedCount = denied ? denials.filter((d) => d.cellId === denied.cellId).length : 0;

  const active = jevDown || llmDown || quarantine || hacked || guard || denied;

  // Fixed height so an alert appearing never shifts the rest of the layout.
  return (
    <div className="flex h-12 shrink-0 gap-2" aria-live="polite">
      {jevDown && (
        <Alert
          tone="warn"
          title="System 1 离线 → 已降级为 System 2 判断"
          detail="Jev 不可用，所有判断改由大模型完成 · degraded, not down"
        />
      )}
      {llmDown && <Alert tone="warn" title="System 2 离线" detail="大模型不可用，采用保守默认 conservative defaults" />}
      {hacked && (
        <Alert
          tone="danger"
          title={`入侵 GHOST HACKED ${hacked.cellId}`}
          detail="演示注入：该单元开始给出对抗答案，蜂群并不知情 the swarm is not told"
        />
      )}
      {quarantine && (
        <Alert
          tone="danger"
          title={`已隔离 ${quarantine.cellId}`}
          detail={`信任 trust ${quarantine.trust.toFixed(2)} · ${quarantine.reason}`}
        />
      )}
      {guard && (
        <Alert
          tone="warn"
          title="校准守卫 GUARD"
          detail={`${guard.key} 类判断与大模型分歧过大，已改由大模型判断 · 分歧 ${(guard.disagreement * 100).toFixed(0)}% / ${guard.window}`}
        />
      )}
      {denied && (
        <Alert
          tone="danger"
          title={`越权拒绝 DENIED ${denied.cellId}${deniedCount > 1 ? ` ×${deniedCount}` : ""}`}
          detail={`${denied.action} · ${denied.reason}`}
        />
      )}
      {!active && (
        <div className="flex min-w-0 flex-1 items-center gap-4 border border-grid bg-panel/90 px-3 text-sm text-muted">
          <span className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-ok" />
            <span className="text-fg">态势正常</span> All systems nominal
          </span>
          <span className="tabular-nums">
            隔离 <span className={quarantines.length ? "text-danger" : "text-fg"}>{quarantines.length}</span>
          </span>
          <span className="tabular-nums">
            越权拒绝 <span className={denials.length ? "text-danger" : "text-fg"}>{denials.length}</span>
          </span>
          <span className="tabular-nums">
            校准守卫 <span className={guards.length ? "text-warn" : "text-fg"}>{guards.length}</span>
          </span>
        </div>
      )}
    </div>
  );
}
