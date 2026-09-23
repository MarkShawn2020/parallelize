import type { CellState } from "../../src/core/types";

const TOKENS = [
  "bg",
  "panel",
  "panel-2",
  "fg",
  "muted",
  "grid",
  "accent",
  "s1",
  "s2",
  "warn",
  "danger",
  "ok",
  "verify",
  "gene",
] as const;

export type ColorToken = (typeof TOKENS)[number];
export type Palette = Record<ColorToken, string>;

let cached: Palette | null = null;

/** Canvas cannot use Tailwind classes, so it reads the same @theme variables. */
export function palette(): Palette {
  if (cached) return cached;
  const css = getComputedStyle(document.documentElement);
  const read = Object.fromEntries(TOKENS.map((t) => [t, css.getPropertyValue(`--color-${t}`).trim()])) as Palette;
  // Only cache once the stylesheet has actually been applied.
  if (read.accent) cached = read;
  return read;
}

export const CELL_STATE_COLOR: Record<CellState, ColorToken> = {
  idle: "muted",
  claiming: "s1",
  solving: "accent",
  verifying: "verify",
  gossiping: "gene",
  dead: "danger",
};

let cachedFont = "";

export function monoFont(): string {
  if (!cachedFont) cachedFont = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim();
  return cachedFont || "monospace";
}
