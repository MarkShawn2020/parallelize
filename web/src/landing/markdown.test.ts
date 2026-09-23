import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReportMarkdown, prepareReport } from "./markdown";
import { parseLandingHash } from "./routes";

const SOURCE = readFileSync(join(__dirname, "../../public/report/swarm-landscape-2026-09-15.md"), "utf8");
const report = prepareReport(SOURCE, (n) => `#/report/ref-${n}`);
const html = renderToStaticMarkup(createElement(ReportMarkdown, { report }));
const text = html
  .replace(/<[^>]+>/g, "")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"')
  .replace(/&#x27;/g, "'")
  .replace(/&amp;/g, "&");

/** A source line as it should read once rendered: Markdown syntax gone, text kept. */
const plain = (line: string) =>
  line
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s?/, "")
    .replace(/^[-*]\s+/, "")
    .replace(/^\[\d{1,3}\]\s+/, "")
    .replace(/^【手工川注：(.*)】$/, "$1")
    .replace(/<(https?:\/\/[^>]+)>/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*/g, "")
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*/g, "$1$2")
    .replace(/`/g, "")
    .trim();

describe("research report on react-markdown", () => {
  it("reads the front matter", () => {
    expect(report.meta.title).toBe("多智能体蜂群协同：开源全景与深度调研");
    expect(report.meta.sources).toBe("67");
    expect(report.meta.evidence).toBe("134");
  });

  it("renders every line of the body", () => {
    let fenced = false;
    // The original body, before citations are rewritten into links; the title (h1) is shown by the page header.
    const missing = SOURCE.replace(/^---\n[\s\S]*?\n---\n/, "")
      .split("\n")
      .flatMap((raw) => {
        const line = raw.trim();
        if (/^#\s/.test(line)) return [];
        if (line.startsWith("```")) {
          fenced = !fenced;
          return [];
        }
        if (fenced) return line ? [line] : [];
        if (line === "" || /^-{3,}$/.test(line) || /^\|?\s*:?-{3,}/.test(line)) return [];
        const cells = line.startsWith("|") ? line.replace(/^\||\|$/g, "").split("|") : [line];
        return cells.map(plain).filter(Boolean);
      })
      .filter((l) => !text.includes(l));
    expect(missing).toEqual([]);
  });

  it("anchors all 98 bibliography entries and links every citation to one", () => {
    expect([...report.refLines.values()]).toEqual(Array.from({ length: 98 }, (_, i) => i + 1));
    for (let n = 1; n <= 98; n++) expect(html).toContain(`id="ref-${n}"`);
    const cited = new Set([...html.matchAll(/href="#\/report\/ref-(\d+)"/g)].map((m) => Number(m[1])));
    expect(cited.size).toBeGreaterThan(60);
    for (const n of cited) expect(n).toBeLessThanOrEqual(98);
  });

  it("gives headings ids and renders notes, tables and the Mermaid decision diagram", () => {
    expect(report.headings.filter((h) => h.level === 2).length).toBeGreaterThanOrEqual(12);
    for (const h of report.headings.filter((x) => x.level > 1)) expect(html).toContain(`id="${h.id}"`);
    expect(html.match(/<aside/g)).toHaveLength(5);
    expect((html.match(/<table/g) ?? []).length).toBeGreaterThanOrEqual(5);
    // The decision diagram ships as Mermaid; on the server (and before the library loads) its source is shown.
    expect(report.body).toContain("```mermaid\nflowchart TD");
    expect(html).toContain("<figure");
    expect(html).toContain("正在绘制图表");
    expect(SOURCE).not.toContain("┌─");
    expect(html).toContain('href="https://github.com/langgenius/dify" target="_blank"');
  });

  it("ships none of the private details the site copy removes", () => {
    for (const banned of ["output/data", "本机", "微信", "/Users/"]) expect(SOURCE).not.toContain(banned);
  });
});

describe("landing routes", () => {
  it("maps hashes to pages and sections", () => {
    expect(parseLandingHash("")).toEqual({ page: "framework", section: null });
    expect(parseLandingHash("#/")).toEqual({ page: "framework", section: null });
    expect(parseLandingHash("#/compare")).toEqual({ page: "compare", section: null });
    expect(parseLandingHash("#/compare/exam")).toEqual({ page: "compare", section: "exam" });
    expect(parseLandingHash("#/report")).toEqual({ page: "report", section: null });
    expect(parseLandingHash("#/report/ref-13")).toEqual({ page: "report", section: "ref-13" });
  });

  it("sends the old one-page anchors to their new page", () => {
    expect(parseLandingHash("#exam")).toEqual({ page: "compare", section: "exam" });
    expect(parseLandingHash("#race")).toEqual({ page: "compare", section: null });
    expect(parseLandingHash("#usage")).toEqual({ page: "framework", section: "usage" });
    expect(parseLandingHash("#nowhere")).toEqual({ page: "framework", section: null });
  });
});

describe("landing links", () => {
  it("keeps dashboard routes out of the landing's own link handling", async () => {
    const { isLandingHref } = await import("./routes");
    for (const href of ["#/", "#top", "#/compare", "#/compare/exam", "#/report", "#/report/ref-13", "#exam"]) expect(isLandingHref(href), href).toBe(true);
    for (const href of ["#/live", "#/eng", "#nowhere", "https://github.com/lovstudio/jis"]) expect(isLandingHref(href), href).toBe(false);
  });
});
