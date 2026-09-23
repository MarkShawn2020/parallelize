import type { TaskStatus } from "../../../src/core/types";
import { TASK_STATUS_BG, TASK_STATUS_LABEL } from "../labels";
import type { TaskView } from "../state";
import { Panel } from "./Panel";

interface Props {
  tasks: Record<string, TaskView>;
}

const STATUSES: TaskStatus[] = ["open", "claimed", "verifying", "accepted", "failed"];

function ring(t: TaskView): string {
  if (t.status !== "accepted") return "";
  return t.correct ? "ring-2 ring-inset ring-ok" : "ring-2 ring-inset ring-danger";
}

function tooltip(t: TaskView): string {
  const parts = [t.id, t.domain, TASK_STATUS_LABEL[t.status]];
  if (t.claimedBy) parts.push(`@${t.claimedBy}`);
  if (t.status === "accepted") parts.push(t.correct ? "正确 correct" : "错误 wrong", `独立来源 sources ${t.independentSources ?? 0}`);
  return parts.join(" · ");
}

export function TaskGrid({ tasks }: Props) {
  const list = Object.values(tasks);
  const count = (s: TaskStatus) => list.filter((t) => t.status === s).length;
  const wrong = list.filter((t) => t.status === "accepted" && t.correct === false).length;
  const cellSize = list.length > 200 ? "minmax(9px,1fr)" : list.length > 100 ? "minmax(14px,1fr)" : "minmax(20px,1fr)";

  return (
    <Panel
      title="任务"
      en="Tasks"
      right={
        <span className="text-xs text-muted tabular-nums">
          {list.length} 个 · <span className="text-ok">✓ {count("accepted") - wrong}</span> <span className="text-danger">✗ {wrong}</span>
        </span>
      }
    >
      <div className="flex flex-col gap-2 px-3 py-2">
        {list.length === 0 ? (
          <div className="py-3 text-center text-sm text-muted">等待任务 Awaiting tasks</div>
        ) : (
          <div className="grid gap-[3px]" style={{ gridTemplateColumns: `repeat(auto-fill, ${cellSize})` }}>
            {list.map((t) => (
              <div
                key={t.id}
                title={tooltip(t)}
                className={`aspect-square border border-grid transition-colors duration-300 ${TASK_STATUS_BG[t.status]} ${ring(t)} ${
                  t.status === "failed" ? "border-dashed border-danger" : ""
                }`}
              />
            ))}
          </div>
        )}
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted tabular-nums">
          {STATUSES.map((s) => (
            <span key={s} className="flex items-center gap-1.5">
              <span className={`size-2.5 border border-grid ${TASK_STATUS_BG[s]}`} />
              {TASK_STATUS_LABEL[s]} <span className="text-fg">{count(s)}</span>
            </span>
          ))}
        </div>
      </div>
    </Panel>
  );
}
