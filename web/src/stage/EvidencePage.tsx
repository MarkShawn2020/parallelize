import {
  EVIDENCE_BOXES,
  EVIDENCE_FOOTNOTE,
  EVIDENCE_ROWS,
  EVIDENCE_TITLE,
  pct,
  type EvidenceBox,
  type EvidenceRow,
  type EvidenceStyle,
} from "../evidence";

/** Full class strings so Tailwind's scanner sees them. */
const BAR: Record<EvidenceStyle, string> = {
  muted: "bg-muted",
  fg: "bg-fg/70",
  dim: "bg-muted/45",
  accent: "bg-accent",
  hatched: "border-2 border-muted",
};

const HATCH = "repeating-linear-gradient(135deg, color-mix(in oklab, var(--color-muted) 70%, transparent) 0 3px, transparent 3px 11px)";

const PCT: Record<EvidenceStyle, string> = {
  muted: "text-muted",
  fg: "text-fg/80",
  dim: "text-muted",
  accent: "text-accent",
  hatched: "text-fg/70",
};

const BOX_MARK = ["bg-accent", "bg-s1", "bg-muted"] as const;

const TICKS = [0, 25, 50, 75, 100] as const;

// Label | bar with its meta line | percentage. Shared by the rows and the axis so they line up.
const GRID = "grid grid-cols-[19rem_minmax(0,1fr)_6rem] items-center gap-x-5";

function Bar({ row }: { row: EvidenceRow }) {
  return (
    <div className="relative h-7 bg-panel-2">
      {TICKS.slice(1, -1).map((t) => (
        <span key={t} aria-hidden className="absolute inset-y-0 w-px bg-grid" style={{ left: `${t}%` }} />
      ))}
      <div
        className={`absolute inset-y-0 left-0 ${BAR[row.style]}`}
        style={{ width: `${(row.correct / row.total) * 100}%`, backgroundImage: row.style === "hatched" ? HATCH : undefined }}
      />
    </div>
  );
}

function Row({ row }: { row: EvidenceRow }) {
  const ours = row.style === "accent";
  return (
    <>
      <div className={`flex flex-wrap items-center gap-x-3 text-2xl leading-tight ${ours ? "font-semibold text-accent" : "text-fg"}`}>
        {/* Wrap only before a parenthetical, never inside a phrase. */}
        {row.label.split(/(?=（)/).map((part) => (
          <span key={part} className="whitespace-nowrap">
            {part}
          </span>
        ))}
        {row.badge && <span className="bg-accent px-2 py-0.5 text-base font-semibold text-bg">{row.badge}</span>}
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <Bar row={row} />
        <div className="flex gap-6 text-lg leading-snug text-muted tabular-nums">
          <span>答对 {row.correct}/{row.total}</span>
          <span>
            ${row.costUsd.toFixed(2)} · {Math.round(row.wallS)} 秒
          </span>
        </div>
      </div>
      <div className={`text-right font-display text-5xl leading-none font-bold tabular-nums ${PCT[row.style]}`}>{pct(row)}%</div>
      {row.note && (
        <div className={`col-start-2 col-end-4 -mt-1 flex flex-wrap gap-x-3 text-lg leading-snug ${ours ? "text-accent" : "text-fg/80"}`}>
          {row.note.split(" · ").map((part, i, parts) => (
            <span key={part} className="whitespace-nowrap">
              {part}
              {i < parts.length - 1 && " ·"}
            </span>
          ))}
        </div>
      )}
    </>
  );
}

function Axis() {
  return (
    <div className={GRID}>
      <span />
      <div className="relative h-7 text-base text-muted tabular-nums">
        {TICKS.map((t) => (
          <span
            key={t}
            className={`absolute top-0 ${t === 0 ? "" : t === 100 ? "-translate-x-full" : "-translate-x-1/2"}`}
            style={{ left: `${t}%` }}
          >
            {t}%
          </span>
        ))}
      </div>
      <span />
    </div>
  );
}

function SideBox({ box, mark }: { box: EvidenceBox; mark: string }) {
  return (
    <section className="flex flex-col gap-2 border border-grid bg-panel/90 px-4 py-3">
      <h3 className="flex items-center gap-2 text-xl font-semibold text-fg">
        <span aria-hidden className={`h-5 w-1 shrink-0 ${mark}`} />
        <span>{box.title}</span>
        {box.tag && <span className="ml-auto border border-muted px-2 text-base font-normal text-muted">{box.tag}</span>}
      </h3>
      <ul className="flex flex-col gap-1.5 text-lg leading-snug text-fg/90">
        {box.lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </section>
  );
}

export function EvidencePage() {
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 px-6 py-5">
      <header className="flex items-center gap-4">
        <h2 className="text-3xl leading-tight font-semibold text-fg">{EVIDENCE_TITLE}</h2>
        <span className="shrink-0 border border-muted px-2 text-base text-muted">涌现</span>
      </header>
      <div className="flex min-h-0 flex-1 gap-8">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className={`${GRID} gap-y-2`}>
            {EVIDENCE_ROWS.map((row) => (
              <Row key={row.runId} row={row} />
            ))}
          </div>
          <div className="mt-2">
            <Axis />
          </div>
          <p className="mt-auto pt-3 text-base text-muted">{EVIDENCE_FOOTNOTE}</p>
        </div>
        <aside className="flex w-[30%] shrink-0 flex-col gap-4">
          {EVIDENCE_BOXES.map((box, i) => (
            <SideBox key={box.title} box={box} mark={BOX_MARK[i] ?? "bg-muted"} />
          ))}
        </aside>
      </div>
    </div>
  );
}
