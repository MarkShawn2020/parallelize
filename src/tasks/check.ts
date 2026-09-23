import { MARK } from "../core/types";

const WRAPPERS = /^[\s*_`"'“”‘’]+|[\s*_`"'“”‘’]+$/g;
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const FRACTION = /^([+-]?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/;
const NUMBER_WITH_UNIT = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:\s*\/\s*\d+(?:\.\d+)?)?)\s*(?:%|[a-z][a-z\s./]*)$/i;
const THOUSANDS_SEPARATOR = /(\d),(?=\d{3}(?!\d))/g;
const NUMBER_IN_TEXT = /(?<![\d.])-?(?:\d{1,3}(?:,\d{3})+(?!\d)|\d+)(?:\.\d+)?/g;

function toNumber(s: string): number | undefined {
  if (NUMBER.test(s)) {
    const x = Number(s);
    return Number.isFinite(x) ? x : undefined;
  }
  const fraction = FRACTION.exec(s);
  if (!fraction) return undefined;
  const denominator = Number(fraction[2]);
  return denominator === 0 ? undefined : Number(fraction[1]) / denominator;
}

function formatNumber(x: number): string {
  return String(Number.isInteger(x) ? x : Number(x.toFixed(4)));
}

export function normalizeAnswer(s: string): string {
  let t = s
    .trim()
    .replace(/^\\boxed\{(.*)\}$/, "$1")
    .replace(WRAPPERS, "")
    .replace(/−/g, "-")
    .replace(/^\$\s*|\s*\$$/g, "")
    .replace(/\.+$/, "")
    .trim()
    .replace(THOUSANDS_SEPARATOR, "$1");
  const withUnit = NUMBER_WITH_UNIT.exec(t);
  if (withUnit?.[1] !== undefined) t = withUnit[1];
  const x = toNumber(t);
  return x === undefined ? t.toLowerCase().replace(/\s+/g, " ") : formatNumber(x);
}

function lastNumber(text: string): string | undefined {
  return text.match(NUMBER_IN_TEXT)?.at(-1);
}

function answerFrom(value: string): string {
  const direct = normalizeAnswer(value);
  if (toNumber(direct) !== undefined || !/\d/.test(value)) return direct;
  // Models decorate the value ("42 (6 x 7)", "x = 42", "the total is 42"): keep the number they settled on.
  const settled = value.slice(value.lastIndexOf("=") + 1).match(NUMBER_IN_TEXT)?.[0];
  return settled === undefined ? direct : normalizeAnswer(settled);
}

export function extractFinalAnswer(text: string): string {
  const lines = text.split(/\r?\n/);
  const marker = MARK.answer.toLowerCase();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    const at = line.toLowerCase().lastIndexOf(marker);
    if (at < 0) continue;
    const rest = line.slice(at + marker.length);
    const value = rest.replace(WRAPPERS, "") ? rest : (lines.slice(i + 1).find((l) => l.trim()) ?? "");
    return answerFrom(value);
  }
  const fallback = lastNumber(text);
  return fallback === undefined ? "" : normalizeAnswer(fallback);
}

export function checkAnswer(expected: string, got: string): boolean {
  const e = normalizeAnswer(expected);
  const g = normalizeAnswer(got);
  const a = toNumber(e);
  const b = toNumber(g);
  if (a !== undefined && b !== undefined) return Math.abs(a - b) <= 1e-6 * Math.max(Math.abs(a), Math.abs(b));
  return e === g;
}
