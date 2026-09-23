import { useEffect, useMemo, useState } from "react";
import type { Domain } from "../../../src/core/types";
import { PARADIGMS } from "../paradigms";
import { DOMAIN_ZH } from "../stageText";

type Result = { answer: string; correct: boolean; sources: number } | null;

interface BankTask {
  id: string;
  domain: Domain;
  prompt: string;
  answer: string;
  results: Record<string, Result>;
}

interface Bank {
  title: string;
  runs: Record<string, string>;
  tasks: BankTask[];
}

type Filter = "all" | "jev-only" | "jev-wrong" | "all-right" | "all-wrong";

const FILTERS: ReadonlyArray<[Filter, string]> = [
  ["all", "全部"],
  ["jev-only", "Jev 蜂群对、只并行错"],
  ["jev-wrong", "Jev 蜂群答错"],
  ["all-right", "七种都对"],
  ["all-wrong", "七种都错"],
];
const DOMAINS: ReadonlyArray<Domain | "all"> = ["all", "arithmetic", "rates", "logic"];

/** Mode key in the bank (as the runs were labelled) for each rung of the ladder, by run id. */
function modeKeys(bank: Bank): string[] {
  const byRun = new Map(Object.entries(bank.runs).map(([mode, runId]) => [runId, mode]));
  return PARADIGMS.map((p) => byRun.get(p.runId) ?? "");
}

export function ExamBank({ onClose }: { onClose: () => void }) {
  const [bank, setBank] = useState<Bank | null>(null);
  const [error, setError] = useState(false);
  const [domain, setDomain] = useState<Domain | "all">("all");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/exam/hard-96.json")
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json() as Promise<Bank>;
      })
      .then((b) => {
        if (!cancelled) setBank(b);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  const keys = bank ? modeKeys(bank) : [];
  const solo = keys[3] ?? "";
  const jev = keys[6] ?? "";

  const shown = useMemo(() => {
    if (!bank) return [];
    const q = query.trim().toLowerCase();
    const ok = (t: BankTask, k: string) => t.results[k]?.correct === true;
    return bank.tasks.filter((t) => {
      if (domain !== "all" && t.domain !== domain) return false;
      if (q && !t.id.includes(q) && !t.prompt.toLowerCase().includes(q)) return false;
      switch (filter) {
        case "jev-only":
          return ok(t, jev) && !ok(t, solo);
        case "jev-wrong":
          return !ok(t, jev);
        case "all-right":
          return keys.every((k) => ok(t, k));
        case "all-wrong":
          return keys.every((k) => !ok(t, k));
        default:
          return true;
      }
    });
  }, [bank, domain, filter, query, jev, solo, keys]);

  return (
    <div role="dialog" aria-label="全部 96 道题" className="fixed inset-0 z-50 flex flex-col bg-bg/95 backdrop-blur">
      <header className="border-b border-grid">
        <div className="mx-auto flex max-w-[1200px] flex-col gap-3 px-4 py-4">
          <div className="flex items-center gap-4">
            <h2 className="text-2xl font-bold text-fg">全部 96 道题</h2>
            <span className="text-sm text-muted">2026-09-23 主对照 · Claude Haiku 4.5 · 每道题 7 种范式各答了什么</span>
            <span className="flex-1" />
            <button type="button" onClick={onClose} className="border border-grid px-3 py-1 text-fg hover:border-fg">
              关闭
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {DOMAINS.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDomain(d)}
                aria-pressed={domain === d}
                className={`border px-3 py-1 ${domain === d ? "border-accent text-accent" : "border-grid text-fg/80 hover:border-fg/60"}`}
              >
                {d === "all" ? "全部题型" : DOMAIN_ZH[d]}
              </button>
            ))}
            <span className="mx-1 h-5 w-px bg-grid" aria-hidden />
            {FILTERS.map(([f, label]) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                aria-pressed={filter === f}
                className={`border px-3 py-1 ${filter === f ? "border-s1 text-s1" : "border-grid text-fg/80 hover:border-fg/60"}`}
              >
                {label}
              </button>
            ))}
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜题号或题面，如 t030、train"
              className="ml-auto w-64 border border-grid bg-panel-2 px-3 py-1 text-fg outline-none focus:border-accent"
            />
          </div>
          {bank && (
            <p className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-sm text-fg/80 tabular-nums">
              <span className="text-muted">当前 {shown.length} 题，答对：</span>
              {PARADIGMS.map((p, i) => (
                <span key={p.runId} className={p.tone === "accent" ? "text-accent" : ""}>
                  {p.name} {shown.filter((t) => t.results[keys[i] ?? ""]?.correct).length}
                </span>
              ))}
            </p>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[1200px] flex-col gap-3 px-4 py-4">
          {error && <p className="text-danger">题库文件没有加载成功，刷新页面再试。</p>}
          {!bank && !error && <p className="text-muted">加载中…</p>}
          {bank && shown.length === 0 && <p className="text-muted">没有符合条件的题。</p>}
          {shown.map((t) => (
            <article key={t.id} className="flex flex-col gap-3 border border-grid bg-panel/90 p-4">
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <span className="font-mono text-lg font-bold text-fg">{t.id}</span>
                <span className="text-sm text-muted">{DOMAIN_ZH[t.domain]}</span>
                <span className="text-sm text-fg/80">
                  标准答案 <span className="font-mono font-bold text-accent">{t.answer}</span>
                </span>
              </div>
              <p className="font-mono text-sm leading-relaxed text-fg/90">{t.prompt}</p>
              <ul className="flex flex-wrap gap-2" aria-label="7 种范式的答案">
                {PARADIGMS.map((p, i) => {
                  const r = t.results[keys[i] ?? ""];
                  const tone = !r ? "border-grid text-muted" : r.correct ? "border-ok/60 text-ok" : "border-danger/60 text-danger";
                  return (
                    <li
                      key={p.runId}
                      className={`border px-2 py-1 text-xs ${tone}`}
                      title={r ? `${p.name} 答 ${r.answer}` : `${p.name} 没有给出答案`}
                    >
                      {p.lecture} · {p.name} {!r ? "未答" : r.correct ? "对" : `错（${r.answer}）`}
                    </li>
                  );
                })}
              </ul>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
