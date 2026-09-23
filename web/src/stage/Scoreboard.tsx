import type { ReactNode } from "react";
import type { RunView } from "../state";
import { median } from "../stageText";

interface Props {
  view: RunView;
  onOpenHit: (taskId: string) => void;
}

function Tile({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-1 border border-grid bg-panel/90 px-3 py-1.5">
      <header className="flex items-center justify-between gap-3">
        <h3 className="shrink-0 text-base leading-tight text-fg/80">{title}</h3>
        {right}
      </header>
      {children}
    </section>
  );
}

/** The headline number with its unit and a short caption on the same baseline. */
function Big({ value, unit, tone, caption }: { value: string; unit?: string; tone: string; caption?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3">
      <span className={`font-display text-5xl leading-none font-bold tabular-nums ${tone}`}>
        {value}
        {unit && <span className="ml-1 text-2xl font-semibold">{unit}</span>}
      </span>
      {caption && <span className="text-lg leading-tight text-fg/80">{caption}</span>}
    </div>
  );
}

/** A sub-line whose parts wrap as whole units; a gap instead of "·" so a wrapped line never ends on a separator. */
function Sub({ parts, className = "text-fg/80" }: { parts: ReactNode[]; className?: string }) {
  return (
    <p className={`flex flex-wrap gap-x-4 text-lg leading-tight ${className}`}>
      {parts.map((p, i) => (
        <span key={i} className={parts.length > 1 ? "whitespace-nowrap" : undefined}>
          {p}
        </span>
      ))}
    </p>
  );
}

const count = (n: number, hot: string) => (n > 0 ? hot : "text-muted");

export function Scoreboard({ view, onOpenHit }: Props) {
  const m = view.metrics;
  const cells = Object.values(view.cells);
  const tasks = Object.values(view.tasks);
  const accepted = m?.accepted ?? 0;
  const correct = m?.correct ?? 0;
  const total = m?.tasksTotal ?? tasks.length;
  const research = view.config?.taskSource.kind === "research" || m?.accuracyApplicable === false;

  const hacked = view.compromises.length > 0;
  const dead = cells.filter((c) => !c.alive).length;
  const incident = hacked && dead > 0 ? "本场有入侵和断节点" : hacked ? "本场有入侵" : dead > 0 ? "本场有断节点" : null;

  const s1 = m?.s1Decisions ?? 0;
  const s2 = m?.s2Decisions ?? 0;
  const s1Share = s1 + s2 > 0 ? (s1 / (s1 + s2)) * 100 : 0;
  const jevDown = view.faults.jev;
  const jevMedianS = (median(view.tally.s1Latencies) / 1000).toFixed(1);

  const adopted = m?.genesAdopted ?? 0;
  const evomapHits = tasks.filter((t) => t.hit === "evomap").length;
  const anyHits = tasks.filter((t) => t.hit).length;
  const hitTarget = tasks.find((t) => t.hit === "evomap") ?? tasks.find((t) => t.hit);

  const quarantined = cells.filter((c) => c.quarantined).length;
  // Only a hacked cell's denials are keyed and counted; an honest cell denied after a kill is not misbehaviour.
  const hackDenied = Object.entries(view.pending.counts)
    .filter(([key]) => key.startsWith("deny:"))
    .reduce((n, [, k]) => n + k, 0);
  const guard = [
    { label: "拦下毒 Gene", n: view.tally.poisonBlocked },
    // The alarm lists are capped at 50 for rendering; the counters are not.
    { label: "抄答案警报", n: m?.echoAlarms ?? view.echoAlarms.length },
    { label: "隔离坏 Agent", n: quarantined },
    { label: "越权操作被拒", n: hackDenied },
  ];
  const clean = guard.every((g) => g.n === 0);

  const online = cells.filter((c) => c.alive && !c.quarantined).length;

  return (
    <div className="grid shrink-0 grid-cols-5 gap-2">
      {research ? (
        <Tile title="论断已核查">
          <Big value={`${accepted}/${total}`} tone={view.simulated ? "text-muted" : count(accepted, "text-fg")} />
          {view.simulated ? (
            <Sub parts={["离线模拟，不作为成绩"]} className="text-muted" />
          ) : (
            view.report && <Sub parts={[`金丝雀 ${view.report.canaryPassed}/${view.report.canaryTotal} 判对`]} />
          )}
        </Tile>
      ) : (
        <Tile title="本场答对">
          <Big
            value={String(correct)}
            unit="题"
            tone={view.simulated ? "text-muted" : count(correct, "text-ok")}
            caption={view.simulated ? undefined : `答对率 ${accepted > 0 ? `${Math.round((correct / accepted) * 100)}%` : "—"}`}
          />
          <Sub parts={[`已收下 ${accepted} / 共 ${total} 题`]} />
          {view.simulated ? (
            <Sub parts={["离线模拟，不作为成绩"]} className="text-muted" />
          ) : (
            incident && <Sub parts={[incident]} className="text-danger" />
          )}
        </Tile>
      )}

      <Tile
        title="谁在做判断"
        right={
          <div className="flex h-3 min-w-0 flex-1 overflow-hidden bg-grid" aria-hidden>
            <span className="bg-s1" style={{ width: `${s1Share}%` }} />
            <span className="flex-1 bg-s2" style={{ opacity: s1 + s2 > 0 ? 1 : 0 }} />
          </div>
        }
      >
        <p className="text-xl leading-tight text-s1">
          Jev 自己拿主意 <span className="text-2xl leading-none font-bold tabular-nums">{s1}</span> 次
        </p>
        <p className="text-xl leading-tight text-s2">
          交给大模型 <span className="text-2xl leading-none font-bold tabular-nums">{s2}</span> 次
        </p>
        {jevDown ? (
          <Sub parts={["Jev 已断开，全部交给大模型"]} className="text-s2" />
        ) : view.tally.s1Latencies.length > 0 ? (
          // Live cents would undercount: an escalated decision's usage mixes Jev and the LLM. The audited total is on the evidence page.
          <Sub parts={[`Jev 一次约 ${jevMedianS} 秒`, "只收输入的钱"]} />
        ) : (
          <Sub parts={["Jev 还没做过判断"]} className="text-muted" />
        )}
      </Tile>

      <Tile title="经验传递">
        <Big value={String(adopted)} unit="次" tone={count(adopted, "text-gene")} caption="被邻居收下" />
        <Sub parts={[`Gene 传出 ${view.tally.gossiped} 次`]} />
        {hitTarget ? (
          <button
            type="button"
            onClick={() => onOpenHit(hitTarget.id)}
            className="self-start border border-gene/60 px-2 text-lg leading-tight text-gene transition-colors hover:bg-gene/10"
          >
            {evomapHits > 0 ? `EvoMap 命中 ${evomapHits} 题 ›` : `本地经验命中 ${anyHits} 题 ›`}
          </button>
        ) : (
          <Sub parts={["卡住的题会去 EvoMap 找经验"]} className="text-muted" />
        )}
      </Tile>

      <Tile title="防作恶" right={clean ? <span className="text-lg leading-tight text-muted">还没有人作恶</span> : undefined}>
        <ul className="flex flex-col gap-1">
          {guard.map(({ label, n }) => (
            <li key={label} className="flex items-baseline justify-between gap-3 text-2xl leading-none">
              <span className="text-xl leading-none text-fg/90">{label}</span>
              <span className={`font-bold tabular-nums ${count(n, "text-danger")}`}>{n}</span>
            </li>
          ))}
        </ul>
      </Tile>

      <Tile title="掉线接力">
        <Big
          value={`${online}/${cells.length}`}
          tone={count(cells.length, "text-fg")}
          caption={
            <>
              在线，<span className={dead > 0 ? "text-danger" : undefined}>掉线 {dead} 个</span>
            </>
          }
        />
        <Sub parts={[`任务被接手 ${view.tally.takeovers} 次`]} className={view.tally.takeovers > 0 ? "text-ok" : "text-fg/80"} />
        {jevDown ? <Sub parts={["Jev：已断开，没有停机"]} className="text-s2" /> : <Sub parts={["Jev：在线"]} />}
      </Tile>
    </div>
  );
}
