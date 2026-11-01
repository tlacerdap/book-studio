// Where notes sit on the page. Notes live in the markdown (see notes.ts); the reading view draws one card per block that has
// notes. These functions connect the two: from a note's line in the file to the block on the page, and back.

import { parseNotes, stripNotes, threads, type Note, type NoteThread } from "./notes.ts";

export interface BlockRange {
  /** The block's `data-src` value, "first-last" in lines of the note-free text. */
  src: string;
  first: number;
  last: number;
}

export interface NoteGroup {
  /** The block the notes are about, or null for notes above the first block (under the chapter title). */
  src: string | null;
  threads: NoteThread[];
  /** True if any thread has no answer yet. */
  open: boolean;
}

export function parseSrc(src: string): BlockRange {
  const [first, last] = src.split("-").map(Number);
  return { src, first, last };
}

/** The block that contains a line of the note-free text, or null if the line is above every block. */
export function blockForLine(blocks: BlockRange[], line: number): BlockRange | null {
  return blocks.find((b) => b.first <= line && line <= b.last) ?? null;
}

/** All notes in `text`, grouped by the block they follow, in page order. */
export function placeNotes(text: string, blocks: BlockRange[]): { groups: NoteGroup[]; notes: Note[] } {
  const notes = parseNotes(text);
  const { lineMap } = stripNotes(text);
  const toStripped = new Map<number, number>();
  lineMap.forEach((orig, stripped) => toStripped.set(orig, stripped));
  const groups = new Map<string | null, NoteGroup>();
  for (const t of threads(notes)) {
    const k = t.note.anchor >= 0 ? toStripped.get(t.note.anchor) : undefined;
    const block = k === undefined ? null : blockForLine(blocks, k);
    const key = block ? block.src : null;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { src: key, threads: [], open: false }));
    g.threads.push(t);
    if (t.answers.length === 0) g.open = true;
  }
  const order = (g: NoteGroup) => (g.src === null ? -1 : parseSrc(g.src).first);
  return { groups: [...groups.values()].sort((a, b) => order(a) - order(b)), notes };
}

/** The line of the file a new note about block `src` goes after (the block's last line, in the file's own numbering). */
export function insertAfterLine(text: string, src: string): number {
  const { text: plain, lineMap } = stripNotes(text);
  const lines = plain.split(/\r\n|\n|\r/);
  let k = Math.min(parseSrc(src).last, lineMap.length - 1);
  // A block's range can run on into the blank line after it (lists do); the note goes under its last line of text.
  while (k > 0 && (lines[k] ?? "").trim() === "") k--;
  return lineMap[k] ?? -1;
}

/** Headings of a chapter for the side panel's outline: H2 and H3 lines outside code, with their 0-based line in the file. */
export function outline(text: string): { level: 2 | 3; title: string; line: number }[] {
  const out: { level: 2 | 3; title: string; line: number }[] = [];
  let fence: string | null = null;
  text.split(/\r\n|\n|\r/).forEach((line, i) => {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (fence === null) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      return;
    }
    if (fence !== null) return;
    const m = /^(#{2,3}) +(.+?)\s*#*\s*$/.exec(line);
    if (m) out.push({ level: m[1].length as 2 | 3, title: m[2].replace(/[`*_]/g, ""), line: i });
  });
  return out;
}

/** The `data-src` of the block that starts at a given line of the file, for scrolling the page to a heading. */
export function blockStartingAt(text: string, blocks: BlockRange[], origLine: number): BlockRange | null {
  const { lineMap } = stripNotes(text);
  const k = lineMap.indexOf(origLine);
  return k < 0 ? null : blockForLine(blocks, k);
}

// A note can point at exact words. The words ride at the end of the note's text as `[on: "..."]`, so the file stays plain
// markdown and Claude Code, which reads the comment, sees which words the reader meant.

const QUOTE_MAX = 200;

/** Add the quoted words to a note's text. Quotes inside the words become apostrophes, so the quote cannot end early. */
export function withQuote(body: string, quote: string | null | undefined): string {
  const q = (quote ?? "").replace(/\s+/g, " ").trim().replace(/"/g, "'").slice(0, QUOTE_MAX);
  if (!q) return body.trim();
  return `${body.trim()} [on: "${q}"]`.trim();
}

/** Split a note's text into what the reader wrote and the words it points at, if any. */
export function splitQuote(text: string): { body: string; quote: string | null } {
  const m = /\s*\[on: "([^\n]*)"\]\s*$/.exec(text);
  return m ? { body: text.slice(0, m.index).trim(), quote: m[1] } : { body: text, quote: null };
}
