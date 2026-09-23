import { REPORT_ROUTE } from "./reportRoute";

/** Landing-page routing: three pages under hash routes, plus the old one-page anchors. */
export const COMPARE_ROUTE = "#/compare";
export { REPORT_ROUTE };

export type Page = "framework" | "compare" | "report";

/** The three pages in the top bar; the live demo is a separate button, not a page of the site. */
export const PAGES: ReadonlyArray<[Page, string, string]> = [
  ["framework", "#/", "JIS 框架"],
  ["compare", COMPARE_ROUTE, "框架对比"],
  ["report", REPORT_ROUTE, "研究报告"],
];

export const COMPARE_SECTIONS: ReadonlyArray<[string, string]> = [
  ["exam", "考卷"],
  ["paradigms", "七种范式"],
  ["data", "数据报告"],
];

/** Old one-page anchors, so links in the pitch notes and deck still land on the right section. */
const LEGACY: Record<string, Page> = {
  race: "compare",
  exam: "compare",
  paradigms: "compare",
  data: "compare",
  overview: "framework",
  framework: "framework",
  replay: "framework",
  usage: "framework",
  value: "framework",
};

/** "#/compare/exam" -> compare page, exam section; "#/report/ref-13" -> report page, ref-13; anything else -> framework. */
export function parseLandingHash(hash: string): { page: Page; section: string | null } {
  const route = /^#\/(compare|report)(?:\/([\w-]+))?\/?$/.exec(hash);
  if (route) return { page: route[1] as Page, section: route[2] ?? null };
  const legacy = /^#([\w-]+)$/.exec(hash)?.[1];
  if (legacy && LEGACY[legacy]) return { page: LEGACY[legacy], section: legacy === "race" ? null : legacy };
  return { page: "framework", section: null };
}

/** Links that stay on the landing pages; "#/live" and the like belong to the dashboard and navigate normally. */
export function isLandingHref(href: string): boolean {
  if (href === "#" || href === "#/" || href === "#top") return true;
  if (/^#\/(compare|report)(\/[\w-]+)?\/?$/.test(href)) return true;
  return Boolean(LEGACY[href.slice(1)]);
}

