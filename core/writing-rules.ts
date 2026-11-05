// Checks on the writing itself, run as the author types: the book's own rules (words that must not appear) and a general
// one that suits a book for readers starting from zero: an acronym must be explained where it first appears.

import type { BookRule } from "./config.ts";

export interface Hint {
  /** 0-based line and column of the words, and how many characters. */
  line: number;
  column: number;
  length: number;
  /** The words that were found. */
  text: string;
  kind: "rule" | "term";
  message: string;
}

export interface CheckInput {
  rules: BookRule[];
  /** Acronyms and words the reader is assumed to know. */
  terms: string[];
}

// Everyone knows these; asking for an explanation would only be noise.
const COMMON = new Set([
  "AI", "PDF", "URL", "URLS", "HTML", "CSS", "JSON", "YAML", "SQL", "ID", "IDS", "OK", "UI", "UX", "CPU", "GPU", "RAM", "FAQ", "USA", "UK", "EU", "CEO", "HR", "IT", "TV", "PC", "OS", "GB", "MB", "KB", "TB",
  "NOT", "AND", "THE", "FOR", "ALL", "ANY", "USE", "NEW", "OLD", "ONE", "YES", "NO", "BUT", "ARE", "YOU", "CAN", "NEVER", "ALWAYS", "ONLY", "TODO", "NOTE", "WARNING", "READ", "STOP", "WHY", "HOW", "WHAT",
]);

/** The text with everything that is not prose (code blocks, inline code, notes) replaced by spaces, so positions stay the same. */
export function proseOnly(text: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  return text
    .replace(/^ {0,3}(`{3,}|~{3,})[\s\S]*?(?:^ {0,3}\1[`~]*[ \t]*$|(?![\s\S]))/gm, blank)
    .replace(/<!--[\s\S]*?-->|%%[\s\S]*?%%/g, blank)
    .replace(/`[^`\n]*`/g, blank)
    .replace(/\]\([^)\n]*\)/g, blank)
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?=\r?\n)/, blank);
}

const ACRONYM = /\b[A-Z][A-Z0-9]{1,6}\b/g;

/** Where an acronym is explained at the spot: `RAG (retrieval...)`, `(RAG)`, `RAG stands for`, `RAG, short for`, or set in bold. */
function explainedAt(text: string, start: number, word: string): boolean {
  const before = text.slice(Math.max(0, start - 3), start);
  const after = text.slice(start + word.length, start + word.length + 22);
  if (/\($/.test(before) && /^\)/.test(after)) return true;
  if (/^\s*\(/.test(after)) return true;
  if (/^\s*(stands for|means|is short for|, short for|, which stands for|is an acronym)/i.test(after)) return true;
  if (/\*\*$/.test(before) && /^\*\*/.test(after)) return true;
  return false;
}

const lineStarts = (text: string): number[] => {
  const out = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") out.push(i + 1);
  return out;
};

function position(starts: number[], at: number): { line: number; column: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= at) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, column: at - starts[lo] };
}

/**
 * Hints for one chapter. `earlier` is the text of the chapters before it, in book order: an acronym explained there is
 * explained for good.
 */
export function checkText(text: string, input: CheckInput, earlier = ""): Hint[] {
  const prose = proseOnly(text);
  const starts = lineStarts(prose);
  const hints: Hint[] = [];

  for (const rule of input.rules) {
    let re: RegExp;
    try {
      re = rule.regex ? new RegExp(rule.forbid, "gimu") : new RegExp(rule.forbid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gimu");
    } catch {
      continue;
    }
    for (const m of prose.matchAll(re)) {
      if (!m[0]) continue;
      const at = position(starts, m.index!);
      hints.push({ ...at, length: m[0].length, text: m[0], kind: "rule", message: rule.message });
    }
  }

  const skip = new Set([...COMMON, ...input.terms.map((t) => t.toUpperCase())]);
  const before = proseOnly(earlier);
  const seen = new Set<string>();
  // Acronyms that were explained in an earlier chapter, or used there at all (their first use was that chapter's to flag).
  for (const m of before.matchAll(ACRONYM)) seen.add(m[0]);
  const counted = new Map<string, number>();
  for (const m of (before + "\n" + prose).matchAll(ACRONYM)) counted.set(m[0], (counted.get(m[0]) ?? 0) + 1);
  const flagged = new Set<string>();
  for (const m of prose.matchAll(ACRONYM)) {
    const word = m[0];
    if (skip.has(word) || /^[IVXLC]+$/.test(word) || /^\d/.test(word) || seen.has(word)) continue;
    seen.add(word);
    if ((counted.get(word) ?? 0) < 2 || flagged.has(word)) continue;
    // A line written entirely in capitals is a heading in disguise, not an acronym.
    const at = position(starts, m.index!);
    const lineText = prose.slice(starts[at.line], starts[at.line + 1] ?? prose.length).replace(/[^A-Za-z]/g, "");
    if (lineText && lineText === lineText.toUpperCase() && lineText.length > 8) continue;
    if (explainedAt(prose, m.index!, word)) continue;
    flagged.add(word);
    hints.push({ ...at, length: word.length, text: word, kind: "term", message: `${word} is used here before it is explained. Spell it out the first time, for example: the full name (${word}).` });
  }
  return hints.sort((a, b) => a.line - b.line || a.column - b.column);
}
