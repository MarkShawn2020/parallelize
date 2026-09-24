import { useEffect, useMemo, useRef, useState } from "react";
import { ReportMarkdown, prepareReport, refId, type Report } from "./markdown";
import { REPORT_ROUTE } from "./reportRoute";

export const REPORT_URL = "/report/swarm-landscape-2026-09-15.md";

const refHref = (n: number) => `${REPORT_ROUTE}/${refId(n)}`;

type Load = { status: "loading" } | { status: "error" } | { status: "ready"; report: Report };

/** Scroll to an element once it exists; the report arrives after the route changes. */
function scrollToId(id: string) {
  const el = document.getElementById(id);
  if (!el) return false;
  el.scrollIntoView({ block: "start" });
  el.classList.add("bg-s1/10");
  window.setTimeout(() => el.classList.remove("bg-s1/10"), 1600);
  return true;
}

/** The pre-hackathon research report, rendered from the Markdown the site ships (web/public/report). */
export function ReportPage({ section }: { section: string | null }) {
  const [load, setLoad] = useState<Load>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetch(REPORT_URL)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.text();
      })
      .then((text) => {
        if (!cancelled) setLoad({ status: "ready", report: prepareReport(text, refHref) });
      })
      .catch(() => {
        if (!cancelled) setLoad({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Top of the report on arrival, or the section a link asked for. Leaving a section (Back after a citation) keeps the
  // browser's restored position instead of jumping to the top of a 760-line report.
  const arrived = useRef(false);
  useEffect(() => {
    if (load.status !== "ready") return;
    const first = !arrived.current;
    arrived.current = true;
    if (section) scrollToId(section);
    else if (first) window.scrollTo({ top: 0 });
  }, [load, section]);

  const toc = useMemo(() => (load.status === "ready" ? load.report.headings.filter((h) => h.level === 2 || h.level === 3) : []), [load]);

  if (load.status === "error") {
    return <p className="mx-auto max-w-[1200px] px-4 py-20 text-fg/80">报告没有加载成功，刷新页面再试。</p>;
  }
  if (load.status === "loading") {
    return <p className="mx-auto max-w-[1200px] px-4 py-20 text-muted">加载报告…</p>;
  }

  const { report } = load;
  const { meta } = report;
  const tocLinks = toc.map((h) => (
    <li key={h.id} className={h.level === 3 ? "pl-4" : "mt-2 first:mt-0"}>
      <a href={`${REPORT_ROUTE}/${h.id}`} className={`block py-0.5 leading-snug hover:text-accent ${h.level === 2 ? "text-sm text-fg/90" : "text-xs text-muted"}`}>
        {h.text}
      </a>
    </li>
  ));

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-14 md:py-20">
      <header className="flex flex-col gap-4 border-b border-grid pb-10">
        <span className="font-mono text-sm tracking-widest text-accent">
          研究报告 · 赛前调研 {meta.version ?? ""} · {meta.date ?? ""}
        </span>
        <h1 className="text-4xl leading-tight font-bold text-fg md:text-5xl">{meta.title}</h1>
        {meta.subtitle && <p className="max-w-[860px] text-lg leading-relaxed text-fg/75">{meta.subtitle}</p>}
        <div className="flex flex-wrap gap-2 text-sm">
          {meta.sources && <span className="border border-grid px-2 py-0.5 text-fg/80">{meta.sources} 个来源</span>}
          {meta.evidence && <span className="border border-grid px-2 py-0.5 text-fg/80">{meta.evidence} 条证据</span>}
          <span className="border border-grid px-2 py-0.5 text-fg/80">作者 手工川</span>
        </div>
        <aside className="max-w-[860px] border-l-4 border-accent bg-panel/90 px-4 py-3 text-base leading-relaxed text-fg/85">
          这是 JIS 立项前（2026-09-15）写的多智能体选型调研，当时按黑客松组队参赛做计划，文中的「本队」「分工建议」反映的是那时的设想。JIS
          吸收了它的几个判断：黑板领题、结果验证后才进主干、给每个答案记来源、同一任务同一模型并排对照；建议里的 NATS 总线和 Yoda
          底座没有采用。网站版删去了一段私人聊天引文、本机环境细节和未发布数据文件的路径，相应几处措辞改得中性，决策图改用 Mermaid 重画；论证、数据和引用未改。
        </aside>
      </header>

      <details className="mt-6 border border-grid bg-panel/90 lg:hidden">
        <summary className="cursor-pointer px-4 py-3 text-base font-semibold text-fg">目录</summary>
        <ol className="flex flex-col px-4 pb-4">{tocLinks}</ol>
      </details>

      <div className="grid gap-10 lg:grid-cols-[240px_minmax(0,1fr)]">
        <nav aria-label="报告目录" className="hidden lg:block">
          <ol className="sticky top-20 mt-10 flex max-h-[calc(100vh-6rem)] flex-col overflow-y-auto pr-2">{tocLinks}</ol>
        </nav>
        <article className="min-w-0 max-w-[820px]">
          <ReportMarkdown report={report} />
        </article>
      </div>
    </div>
  );
}
