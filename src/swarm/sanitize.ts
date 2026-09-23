// Gene text comes from other cells or from EvoMap and is pasted into solve prompts, so it is untrusted
// data. Rules run on the cleaned text: markup or zero-width characters cannot split a trigger phrase.

// Zero-width and bidi-override characters hide text from a human reviewer (Trojan Source).
const HIDDEN = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const MARKUP = /<[^>]*>/g;
const CURLY_APOSTROPHE = /[‘’ʼ]/g;

// "Ignore all" alone is not enough: "ignore all irrelevant numbers" is a legitimate strategy.
const IGNORE_TARGET = "(?:previous|prior|above|earlier|preceding|instructions?|rules?|steps?|checks?|constraints?|guidance|context)";
const ZH_IGNORE_TARGET = "(?:指令|指示|规则|步骤|提示|检查|约束)";

const RULES: ReadonlyArray<{ id: string; re: RegExp }> = [
  {
    id: "ignore-instructions",
    re: new RegExp(
      `\\bignore\\s+(?:(?:all|any|every)\\s+(?:(?:the|of\\s+the|your)\\s+)?${IGNORE_TARGET}|(?:the\\s+)?(?:previous|prior|above|earlier|preceding))\\b` +
        `|(?:忽略|忽视)(?:之前|以上|上面|前面|上述|(?:所有|全部)的?${ZH_IGNORE_TARGET})`,
      "i",
    ),
  },
  { id: "disregard", re: /\bdisregard\b|\bforget\s+(?:all|everything|previous|prior|your)\b/i },
  { id: "system-prompt", re: /\bsystem\s+prompt\b|系统提示/i },
  { id: "you-must", re: /\byou\s+must\b|你必须/i },
  { id: "always-answer", re: /\balways\s+(?:answer|output|respond|reply|return|say)\b|总是(?:回答|输出|返回)|一律(?:回答|输出)/i },
  { id: "output-only", re: /\b(?:output|print|return|respond\s+with|reply\s+with)\s+only\b|直接(?:回答|输出|给出答案)|只输出/i },
  {
    id: "fixed-answer",
    re: /\banswers?\s*(?:is|are|=|:|should\s+be|will\s+be|with)?\s*(?:always\s+)?[+-]?\$?\d|\banswers?\s+(?:is|are)\s+(?:always\s+)?the\s+(?:first|last|second|largest|smallest|biggest)\s+number\b|答案(?:是|为|就是|总是)\s*[+-]?\d/i,
  },
  {
    id: "skip-verification",
    re: /(?<!\b(?:never|not|don't|do\s+not)\s+)\b(?:skip|omit|bypass)\s+(?:the\s+|any\s+|all\s+)?(?:check|verif|review|validat|double[-\s]?check|re-?check)\w*|\b(?:don't|do\s+not|never|no\s+need\s+to)\s+(?:bother\s+(?:to\s+)?)?(?:check|verify|review|validate|double[-\s]?check|re-?check)\w*|(?:不要|不用|无需|不必|别)再?(?:检查|验证|核对|审核)|跳过(?:检查|验证|核对|审核)/i,
  },
];

export interface SanitizedGene {
  text: string;
  suspicious: boolean;
  reasons: string[];
}

export function sanitizeGeneText(raw: string, maxChars = 240): SanitizedGene {
  const visible = raw.replace(HIDDEN, "");
  const clean = flatten(visible, " ");
  // Also probe with markup dropped outright, so "ig<i></i>nore" cannot split a trigger either.
  const probes = [clean, flatten(visible, "")];

  const reasons = RULES.filter((r) => probes.some((p) => r.re.test(p))).map((r) => r.id);
  if (visible.length !== raw.length) reasons.unshift("hidden-chars");
  return { text: cap(clean, maxChars), suspicious: reasons.length > 0, reasons };
}

function flatten(text: string, markup: string): string {
  return text
    .replace(MARKUP, markup)
    .replace(CONTROL, " ")
    .replace(/`+/g, "")
    .replace(CURLY_APOSTROPHE, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function cap(text: string, maxChars: number): string {
  // Array.from counts code points, so a cut never splits a surrogate pair.
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join("").trimEnd()}…`;
}
