// A book as a list of chapters: reading them, grouping them into Parts, assembling the HTML. Port of bookcore/book.py.

import fs from "node:fs";
import path from "node:path";
import type { MarkdownIt } from "markdown-it";
import { chapterFiles, indexFile, type BookConfig } from "./config.ts";
import { chapterId, makeMarkdown } from "./mdrender.ts";
import { openNotes, parseNotes, stripNotes } from "./notes.ts";

const ROMAN = ["0", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
// "Chapter 3 - Title" or "Appendix A - Title" at the top of a chapter file is split into a label and a title.
const TITLE_RE = /^((?:Chapter|Appendix) [\w.]+) - (.+)$/;
// The line under a chapter title, if it has this shape, becomes the small level/priority line.
const META_RE = /^Level: \[(.+?)\] \| Priority: \[(.+?)\]$/;

export interface Chapter {
  file: string;
  id: string;
  label: string;
  titleHtml: string;
  titleText: string;
  level: string;
  priority: string;
  bodyHtml: string;
  partNumber: number | null;
  partLabel: string;
  partName: string;
  partId: string;
  partOpens: boolean;
}

/** The leading number of a chapter file name (`07-ch07-data.md` is 7), used to order and select. */
export function fileNumber(name: string): number | null {
  const m = /^\d+/.exec(name);
  return m ? parseInt(m[0], 10) : null;
}

export function readIndex(book: BookConfig): Map<number, [number, string]> {
  const mapping = new Map<number, [number, string]>();
  const file = indexFile(book);
  if (!file || !fs.existsSync(file)) return mapping;
  let part: [number, string] | null = null;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    let m = /^## Part ([0IVX]+) - (.+?)\s*(\(.*\))?$/.exec(line);
    if (m) {
      part = [m[1] === "0" ? 0 : romanToInt(m[1]), m[2]];
      continue;
    }
    if (line.startsWith("## ")) {
      part = null;
      continue;
    }
    m = /^\*\*Chapter (\d+)(?:\.\d+)? - /.exec(line);
    if (m && part) mapping.set(parseInt(m[1], 10), part);
  }
  return mapping;
}

function romanToInt(s: string): number {
  const values: Record<string, number> = { I: 1, V: 5, X: 10 };
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const a = values[s[i]];
    const b = values[s[i + 1]] ?? 0;
    total += b > a ? -a : a;
  }
  return total;
}

/** All chapter files, or the subset named by `spec`: numbers (7), ranges (0-3), commas, file names. */
export function selectChapters(book: BookConfig, spec?: string[]): string[] {
  const files = chapterFiles(book);
  // Without a choice the whole book is meant, minus the chapters the reader has marked as known.
  if (!spec || !spec.length) return files.filter((f) => !book.known.includes(path.basename(f)));
  const wanted = new Set<string>();
  for (let item of spec.join(",").split(",")) {
    item = item.trim();
    if (!item) continue;
    let nums: Set<number>;
    let m: RegExpExecArray | null;
    if (/^\d+$/.test(item)) nums = new Set([parseInt(item, 10)]);
    else if ((m = /^(\d+)-(\d+)$/.exec(item))) {
      nums = new Set();
      for (let n = parseInt(m[1], 10); n <= parseInt(m[2], 10); n++) nums.add(n);
    } else {
      const hits = files.filter((f) => path.basename(f) === path.basename(item));
      if (!hits.length) throw new Error(`no chapter matches '${item}'`);
      hits.forEach((h) => wanted.add(h));
      continue;
    }
    const hits = files.filter((f) => nums.has(fileNumber(path.basename(f)) ?? -1));
    if (!hits.length) throw new Error(`no chapter file for '${item}'`);
    hits.forEach((h) => wanted.add(h));
  }
  return files.filter((f) => wanted.has(f));
}

/** Where a picture's file is shown from: the reading view serves it under its own address, the PDF reads it from disk. */
export type ImageUrl = (abs: string) => string;

export function loadChapter(file: string, md: MarkdownIt, lineMap?: { text: string; lineMap: number[] }, imageUrl?: ImageUrl): Chapter {
  const source = lineMap ?? stripNotes(fs.readFileSync(file, "utf8"));
  const env = { chapterDir: path.dirname(file), imageUrl };
  const tokens = md.parse(source.text, env);
  const h1 = tokens.findIndex((t) => t.type === "heading_open" && t.tag === "h1");
  const name = path.basename(file);
  if (h1 === -1) throw new Error(`${name} has no \`# \` title line`);
  const rawTitle = tokens[h1 + 1].content;
  const m = TITLE_RE.exec(rawTitle);
  const [label, titleSrc] = m ? [m[1], m[2]] : ["", rawTitle];
  // Re-parse only the title text so smart quotes and inline code are handled the same way.
  const titleChildren = md.parseInline(titleSrc, {})[0].children ?? [];
  const titleHtml = md.renderer.renderInline(titleChildren, md.options, env);
  const titleText = titleChildren.filter((t) => t.type === "text" || t.type === "code_inline").map((t) => t.content).join("");
  tokens.splice(h1, 3);

  let level = "";
  let priority = "";
  if (h1 < tokens.length && tokens[h1].type === "paragraph_open") {
    const meta = META_RE.exec(tokens[h1 + 1].content);
    if (meta) {
      [level, priority] = [meta[1], meta[2]];
      tokens.splice(h1, 3);
    }
  }
  return {
    file: name,
    id: chapterId(name),
    label,
    titleHtml,
    titleText,
    level,
    priority,
    bodyHtml: md.renderer.render(tokens, md.options, env),
    partNumber: null,
    partLabel: "",
    partName: "",
    partId: "",
    partOpens: false,
  };
}

export function assignParts(chapters: Chapter[], mapping: Map<number, [number, string]>): void {
  let previous: number | null = null;
  for (const ch of chapters) {
    const n = fileNumber(ch.file);
    const entry = n === null ? undefined : mapping.get(n);
    if (!entry) continue;
    const [number, name] = entry;
    ch.partNumber = number;
    ch.partName = name;
    ch.partLabel = number < ROMAN.length ? `Part ${ROMAN[number]}` : `Part ${number}`;
    ch.partId = `part-${number}`;
    ch.partOpens = number !== previous;
    previous = number;
  }
}

/** A picture the book owns may be shown; anything outside the book's folder is not. */
export function insideBook(book: BookConfig, abs: string): boolean {
  const rel = path.relative(book.root, abs);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function readChapters(book: BookConfig, files: string[], imageUrl?: ImageUrl): Chapter[] {
  const md = makeMarkdown(new Set(files.map((f) => path.basename(f))));
  const chapters = files.map((f) => loadChapter(f, md, undefined, imageUrl));
  assignParts(chapters, readIndex(book));
  return chapters;
}

/** What the app's side panel needs about a chapter, without rendering it. */
export interface ChapterSummary {
  file: string;
  /** Absolute path. */
  path: string;
  number: number | null;
  label: string;
  title: string;
  partNumber: number | null;
  partLabel: string;
  partName: string;
  /** Notes with no answer yet (Q, E and ? without an A below). */
  openNotes: number;
  /** Every note, answered or not. */
  notes: number;
}

export function summariseChapter(file: string, text: string, mapping: Map<number, [number, string]>): ChapterSummary {
  const name = path.basename(file);
  const stripped = stripNotes(text).text;
  const h1 = /^# +(.+?)\s*$/m.exec(stripped);
  const raw = h1 ? h1[1] : name.replace(/\.md$/, "");
  const m = TITLE_RE.exec(raw);
  const n = fileNumber(name);
  const entry = n === null ? undefined : mapping.get(n);
  const notes = parseNotes(text);
  return {
    file: name,
    path: file,
    number: n,
    label: m ? m[1] : "",
    title: m ? m[2] : raw,
    partNumber: entry ? entry[0] : null,
    partLabel: entry ? (entry[0] < ROMAN.length ? `Part ${ROMAN[entry[0]]}` : `Part ${entry[0]}`) : "",
    partName: entry ? entry[1] : "",
    openNotes: openNotes(notes).length,
    notes: notes.filter((x) => x.kind !== "A").length,
  };
}

export function listChapters(book: BookConfig, files: string[]): ChapterSummary[] {
  const mapping = readIndex(book);
  return files.map((f) => summariseChapter(f, fs.readFileSync(f, "utf8"), mapping));
}
