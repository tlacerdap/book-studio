// The pieces of a chapter's markdown a reader edits in place: a paragraph, a section, the whole chapter. All are ranges of
// whole lines (0-based, inclusive), found from the text alone, so they stay right however the page is laid out.

import type { Line } from "./notes.ts";

export interface LineRange {
  from: number;
  to: number;
}

export type Scope = "paragraph" | "section" | "chapter";

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^(#{1,6}) +\S/;

/** Lines that are inside a fenced code block, fences included. */
function fenced(lines: Line[]): boolean[] {
  const inside = new Array<boolean>(lines.length).fill(false);
  let open: string | null = null;
  lines.forEach((l, i) => {
    const m = FENCE.exec(l.body);
    if (open) {
      inside[i] = true;
      if (m && m[1][0] === open[0] && m[1].length >= open.length && l.body.trim() === m[1]) open = null;
    } else if (m) {
      inside[i] = true;
      open = m[1];
    }
  });
  return inside;
}

/** Runs of non-blank lines (a code block counts as one run, blank lines inside it included). */
export function paragraphs(lines: Line[]): LineRange[] {
  const inside = fenced(lines);
  const out: LineRange[] = [];
  let start = -1;
  for (let i = 0; i <= lines.length; i++) {
    const blank = i === lines.length || (lines[i].body.trim() === "" && !inside[i]);
    // A code block ends the run that came before it and starts a new one.
    const edge = i < lines.length && i > 0 && inside[i] !== inside[i - 1] && start >= 0 && !blank;
    if (edge) {
      out.push({ from: start, to: i - 1 });
      start = i;
      continue;
    }
    if (blank) {
      if (start >= 0) out.push({ from: start, to: i - 1 });
      start = -1;
    } else if (start < 0) start = i;
  }
  return out;
}

/** The paragraph that holds a line, or the next one if the line is blank. */
export function paragraphAt(lines: Line[], line: number): LineRange | null {
  const all = paragraphs(lines);
  return all.find((r) => line >= r.from && line <= r.to) ?? all.find((r) => r.from > line) ?? all[all.length - 1] ?? null;
}

/** The section a line is in: from its heading (up to H3) to the line before the next heading of the same or higher rank. */
export function sectionAt(lines: Line[], line: number): LineRange {
  const inside = fenced(lines);
  const heads: { line: number; level: number }[] = [];
  lines.forEach((l, i) => {
    const m = !inside[i] && HEADING.exec(l.body);
    if (m && m[1].length <= 3) heads.push({ line: i, level: m[1].length });
  });
  const mine = [...heads].reverse().find((h) => h.line <= line);
  const from = mine ? mine.line : 0;
  const next = heads.find((h) => h.line > from && (!mine || h.level <= mine.level));
  let to = (next ? next.line : lines.length) - 1;
  while (to > from && lines[to].body.trim() === "") to--;
  return { from, to: Math.max(from, to) };
}

export function rangeFor(scope: Scope, lines: Line[], line: number): LineRange {
  if (scope === "chapter") return { from: 0, to: Math.max(0, lines.length - 1) };
  if (scope === "section") return sectionAt(lines, line);
  return paragraphAt(lines, line) ?? { from: Math.min(line, Math.max(0, lines.length - 1)), to: Math.min(line, Math.max(0, lines.length - 1)) };
}

/** Put edited text in place of a range of lines; the line endings of the file are kept. */
export function replaceRange(lines: Line[], range: LineRange, body: string): Line[] {
  const text = body.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  const eol = lines[range.from]?.eol || "\n";
  const added: Line[] = text.split("\n").map((b) => ({ body: b, eol }));
  added[added.length - 1].eol = lines[range.to]?.eol ?? "";
  return [...lines.slice(0, range.from), ...added, ...lines.slice(range.to + 1)];
}
