import { memo, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * The research report on react-markdown + GFM, with three things the report needs on top: numeric citations like [13]
 * link to their bibliography entry, bibliography entries and headings get ids to land on, and the author's
 * 【手工川注：…】 lines render as notes. All three are found by source line, so the Markdown itself stays untouched
 * apart from the citation links written in before parsing (line count unchanged). ```mermaid blocks render as diagrams.
 */

export interface Heading {
  level: number;
  text: string;
  id: string;
}

export interface Report {
  meta: Record<string, string>;
  body: string;
  headings: Heading[];
  /** Source line (1-based, in `body`) -> id, for every heading. */
  headingIds: Map<number, string>;
  /** Source line -> bibliography number. */
  refLines: Map<number, number>;
  noteLines: Set<number>;
}

const FRONT = /^---\n([\s\S]*?)\n---\n/;
const HEADING = /^(#{1,6})\s+(.+?)\s*$/;
const REF = /^\[(\d{1,3})\]\s+/;
const NOTE = /^【手工川注：(.*)】$/;
const CITE = /\[(\d{1,3})\](?!\()/g;

export const refId = (n: number) => `ref-${n}`;
const plain = (md: string) => md.replace(/\*\*|__|`/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

export function prepareReport(source: string, refHref: (n: number) => string): Report {
  const text = source.replace(/\r\n?/g, "\n");
  const front = FRONT.exec(text);
  const meta: Record<string, string> = {};
  for (const line of front?.[1]?.split("\n") ?? []) {
    const m = /^([\w-]+):\s*(.*)$/.exec(line);
    if (m?.[1]) meta[m[1]] = m[2] ?? "";
  }

  const headings: Heading[] = [];
  const headingIds = new Map<number, string>();
  const refLines = new Map<number, number>();
  const noteLines = new Set<number>();
  let fenced = false;
  const lines = text.slice(front?.[0].length ?? 0).split("\n");
  const body = lines
    .map((line, i) => {
      const at = i + 1;
      if (line.startsWith("```")) fenced = !fenced;
      if (fenced || line.startsWith("```")) return line;
      const h = HEADING.exec(line);
      if (h) {
        const heading = { level: h[1]?.length ?? 2, text: plain(h[2] ?? ""), id: `s${headings.length + 1}` };
        headings.push(heading);
        headingIds.set(at, heading.id);
        return line;
      }
      let out = line;
      const ref = REF.exec(out);
      if (ref) {
        refLines.set(at, Number(ref[1]));
        out = out.slice(ref[0].length);
      }
      const note = NOTE.exec(out);
      if (note) {
        noteLines.add(at);
        out = note[1] ?? "";
      }
      return out.replace(CITE, (_, n: string) => `[\\[${n}\\]](${refHref(Number(n))})`);
    })
    .join("\n");

  return { meta, body, headings, headingIds, refLines, noteLines };
}

const lineOf = (props: ExtraProps) => props.node?.position?.start.line ?? -1;

/** Mermaid takes concrete colours, so hand it the page's theme tokens as they resolve at runtime. */
function themeVariables(): Record<string, string> {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string) => css.getPropertyValue(`--color-${name}`).trim();
  return {
    background: token("bg"),
    mainBkg: token("panel-2"),
    primaryColor: token("panel-2"),
    primaryTextColor: token("fg"),
    primaryBorderColor: token("accent"),
    nodeBorder: token("accent"),
    secondaryColor: token("panel"),
    tertiaryColor: token("panel"),
    lineColor: token("muted"),
    textColor: token("fg"),
    edgeLabelBackground: token("bg"),
    fontFamily: css.getPropertyValue("--font-mono").trim(),
    fontSize: "14px",
  };
}

/**
 * A ```mermaid block. Mermaid is a multi-megabyte library, so it is imported only when a diagram is on screen; until
 * then (and without JavaScript) the block shows its source.
 */
function Mermaid({ chart }: { chart: string }) {
  const id = `mermaid-${useId().replace(/[^\w-]/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "base",
          themeVariables: themeVariables(),
          // Chinese labels wrap far too early at the default 200px, which turns a five-step tree into a tall column.
          flowchart: { wrappingWidth: 360, rankSpacing: 44, nodeSpacing: 36, padding: 12 },
        });
        const out = await mermaid.render(id, chart);
        if (!cancelled) setSvg(out.svg);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [id, chart]);

  if (svg) {
    return (
      <figure
        className="mt-5 overflow-x-auto border border-grid bg-panel p-4 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
        // Mermaid's own output, rendered with securityLevel "strict" from a diagram shipped with the site.
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  }
  return (
    <figure className="mt-5 border border-grid bg-panel p-4">
      <figcaption className="mb-2 text-xs text-muted">{failed ? "图表没有画出来，下面是它的源码" : "正在绘制图表…"}</figcaption>
      <pre className="overflow-x-auto font-mono text-xs leading-snug text-fg/70">{chart}</pre>
    </figure>
  );
}

/** The text of a ```mermaid code block, if this <pre> is one. */
function mermaidSource(node: ExtraProps["node"]): string | null {
  const code = node?.children[0];
  if (code?.type !== "element" || code.tagName !== "code") return null;
  const cls = code.properties.className;
  if (!Array.isArray(cls) || !cls.includes("language-mermaid")) return null;
  return code.children.map((c) => (c.type === "text" ? c.value : "")).join("").trimEnd();
}

function components(report: Report): Components {
  const heading =
    (Tag: "h2" | "h3" | "h4", cls: string) =>
    ({ node, children }: { children?: ReactNode } & ExtraProps) => (
      <Tag id={report.headingIds.get(lineOf({ node }))} className={`scroll-mt-24 ${cls}`}>
        {children}
      </Tag>
    );
  return {
    h1: () => null,
    h2: heading("h2", "mt-14 border-t border-grid pt-10 text-2xl font-bold text-fg md:text-3xl"),
    h3: heading("h3", "mt-10 text-xl font-bold text-fg"),
    h4: heading("h4", "mt-8 text-lg font-semibold text-accent"),
    hr: () => null,
    p: ({ node, children }) => {
      const line = lineOf({ node });
      const ref = report.refLines.get(line);
      if (ref !== undefined) {
        return (
          <p id={refId(ref)} className="mt-2 scroll-mt-24 text-sm leading-relaxed break-words text-fg/80 transition-colors">
            <span className="mr-2 font-mono text-s1">[{ref}]</span>
            {children}
          </p>
        );
      }
      if (report.noteLines.has(line)) {
        return (
          <aside className="mt-4 border-l-4 border-s2 bg-s2/10 px-4 py-2 text-base leading-relaxed text-fg/90">
            <span className="mr-2 text-sm font-semibold text-s2">手工川注</span>
            {children}
          </aside>
        );
      }
      return <p className="mt-4 text-base leading-[1.9] text-fg/85">{children}</p>;
    },
    a: ({ href = "", children }) => {
      if (href.startsWith("#/")) {
        const cite = /\/ref-(\d+)$/.exec(href)?.[1];
        return (
          <a href={href} className="font-mono text-[0.8em] text-s1 hover:underline" aria-label={cite ? `参考文献 ${cite}` : undefined}>
            {children}
          </a>
        );
      }
      return (
        <a href={href} target="_blank" rel="noreferrer" className="break-words text-s1 underline decoration-s1/40 underline-offset-2 hover:decoration-s1">
          {children}
        </a>
      );
    },
    strong: ({ children }) => <strong className="font-semibold text-fg">{children}</strong>,
    em: ({ children }) => <em className="text-fg/95">{children}</em>,
    code: ({ children }) => <code className="bg-panel-2 px-1 py-0.5 font-mono text-[0.9em] text-s1">{children}</code>,
    pre: ({ node, children }) => {
      const chart = mermaidSource(node);
      if (chart !== null) return <Mermaid chart={chart} />;
      return (
        <pre className="mt-4 overflow-x-auto border border-grid bg-panel p-4 font-mono text-xs leading-snug text-fg/85 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-[1em] [&_code]:text-fg/85">
          {children}
        </pre>
      );
    },
    blockquote: ({ children }) => <blockquote className="mt-4 border-l-4 border-accent/60 pl-4 text-fg/70 [&>p]:mt-0">{children}</blockquote>,
    ul: ({ children }) => <ul className="mt-4 flex list-disc flex-col gap-2 pl-6 text-base leading-[1.8] text-fg/85">{children}</ul>,
    ol: ({ children }) => <ol className="mt-4 flex list-decimal flex-col gap-2 pl-6 text-base leading-[1.8] text-fg/85">{children}</ol>,
    table: ({ children }) => (
      <div className="mt-5 overflow-x-auto border border-grid">
        <table className="w-full min-w-[640px] border-collapse text-sm">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="bg-panel-2">{children}</thead>,
    tr: ({ children }) => <tr className="border-b border-grid/70 last:border-b-0">{children}</tr>,
    th: ({ children, style }) => (
      <th style={style} className="border-b border-grid px-3 py-2 text-left font-semibold text-fg">
        {children}
      </th>
    ),
    td: ({ children, style }) => (
      <td style={style} className="px-3 py-2 text-left align-top leading-relaxed text-fg/85">
        {children}
      </td>
    ),
  };
}

const PLUGINS = [remarkGfm];

/**
 * Memoised on the report: fresh component functions on every render would remount the whole article on each hash
 * change, resetting the Mermaid diagram to its placeholder and shifting everything below it mid-scroll.
 */
export const ReportMarkdown = memo(function ReportMarkdown({ report }: { report: Report }) {
  const comps = useMemo(() => components(report), [report]);
  return (
    <Markdown remarkPlugins={PLUGINS} components={comps}>
      {report.body}
    </Markdown>
  );
});
