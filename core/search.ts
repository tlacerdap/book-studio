// Searching the words of a book. A chapter is turned into the same text its page shows (the rendered body, without the
// title block, the notes, the printed web addresses or the page headers), so a match found here can be found again at the
// same place in the reading view. Each match knows its line in the file, the section it sits in, a snippet to show, and
// the words around it, which the page uses to land on the right one when the same words occur several times.

import crypto from "node:crypto";
import { makeMarkdown } from "./mdrender.ts";
import { stripNotes } from "./notes.ts";
import { contextAround, normChar, normText, occurrences } from "./textnorm.ts";

export interface SearchHit {
  /** Which match this is among the matches in the chapter's page text (0, 1, 2...). -1 for the chapter title. */
  ordinal: number;
  /** 1-based line of the file. */
  line: number;
  /** The nearest H2 or H3 above it. */
  section: string;
  before: string;
  match: string;
  after: string;
  /** The normalised words either side, to tell this occurrence from others of the same words. */
  ctx: string;
}

export interface SearchChapter {
  file: string;
  /** Matches in the chapter (the list of `hits` may be shorter). */
  count: number;
  hits: SearchHit[];
}

export interface SearchResult {
  query: string;
  total: number;
  chapters: SearchChapter[];
}

export const MIN_QUERY = 2;
export const MAX_HITS_PER_CHAPTER = 60;

interface Flat {
  text: string;
  shown: string;
  lineOf: number[];
  sectionOf: number[];
  sections: string[];
  title: string;
}

const BLOCK_TAGS = new Set(["p", "li", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "td", "th", "blockquote", "figcaption", "dt", "dd"]);
const VOID_TAGS = new Set(["br", "hr", "img", "wbr", "input", "meta", "link", "col"]);

function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

interface Open {
  tag: string;
  id: number;
  block: boolean;
  skip: boolean;
  src: number | null;
  /** Lines the element's text has gone down so far, for a paragraph that runs over several lines. */
  down: number;
  /** For a code block: how many of its lines are behind us. */
  codeLines: number;
  heading: boolean;
}

/** The text of a chapter's rendered body, as the reading view's page text, with where each character came from. */
function flatten(html: string, title: string): Flat {
  const text: string[] = [];
  const shown: string[] = [];
  const lineOf: number[] = [];
  const sectionOf: number[] = [];
  const sections: string[] = [""];
  const stack: Open[] = [];
  let nextId = 1;
  let lastBlock = 0;
  let headingText = "";
  let section = 0;

  const push = (n: string, s: string, line: number): void => {
    text.push(n);
    shown.push(s);
    lineOf.push(line);
    sectionOf.push(section);
  };
  const tags = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>|([^<]+)/g;
  for (let m = tags.exec(html); m; m = tags.exec(html)) {
    if (m[4] !== undefined) {
      // text
      if (stack.some((o) => o.skip)) continue;
      const src = [...stack].reverse().find((o) => o.src !== null);
      if (!src) continue; // outside every block of the page: not page text
      const raw = decode(m[4]);
      const block = [...stack].reverse().find((o) => o.block);
      const bid = block ? block.id : 0;
      const line = (): number => {
        const code = [...stack].reverse().find((o) => o.tag === "pre");
        if (code) return (code.src ?? 0) + 1 + Math.max(0, code.codeLines - 1);
        return (src.src ?? 0) + src.down;
      };
      if (bid !== lastBlock) {
        lastBlock = bid;
        if (text.length && text[text.length - 1] !== " ") push(" ", " ", line());
      }
      let space = text.length > 0 && text[text.length - 1] === " ";
      for (const ch of raw) {
        if (/\s/.test(ch)) {
          if (ch === "\n") src.down++;
          if (space) continue;
          space = true;
          push(" ", " ", line());
        } else {
          space = false;
          push(normChar(ch), ch, line());
        }
      }
      if (stack.some((o) => o.heading)) headingText += raw;
      continue;
    }
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    const attrs = m[3] ?? "";
    if (closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag !== tag) continue;
        const done = stack.splice(i)[0];
        if (done.heading && (tag === "h2" || tag === "h3")) {
          sections.push(headingText.replace(/\s+/g, " ").trim());
          section = sections.length - 1;
        }
        if (done.heading) headingText = "";
        break;
      }
      continue;
    }
    if (tag === "br" || tag === "wbr") {
      continue;
    }
    if (VOID_TAGS.has(tag) || attrs.trimEnd().endsWith("/")) continue;
    const cls = /class="([^"]*)"/.exec(attrs)?.[1] ?? "";
    const classes = cls.split(/\s+/);
    const srcAttr = /data-src="(\d+)-(\d+)"/.exec(attrs);
    const isLine = tag === "span" && classes.includes("cl");
    const open: Open = {
      tag,
      id: nextId++,
      block: BLOCK_TAGS.has(tag) || isLine,
      skip: tag === "span" && (classes.includes("pg-hy") || classes.includes("ext-url")),
      src: srcAttr ? Number(srcAttr[1]) : null,
      down: 0,
      codeLines: 0,
      heading: /^h[1-6]$/.test(tag),
    };
    if (isLine) {
      const pre = [...stack].reverse().find((o) => o.tag === "pre");
      if (pre) pre.codeLines++;
    }
    stack.push(open);
  }
  return { text: text.join(""), shown: shown.join(""), lineOf, sectionOf, sections, title };
}

const cache = new Map<string, { hash: string; flat: Flat }>();

function flatOf(file: string, source: string): Flat {
  const hash = crypto.createHash("sha1").update(source).digest("hex");
  const hit = cache.get(file);
  if (hit && hit.hash === hash) return hit.flat;
  let flat: Flat;
  try {
    const { text: plain, lineMap } = stripNotes(source);
    const md = makeMarkdown(new Set(), { sourceLines: true, lineMap });
    const env = {};
    const tokens = md.parse(plain, env);
    // The title is not part of the page text in the reading view: it is shown above the chapter. It is searched on its own.
    const h1 = tokens.findIndex((t) => t.type === "heading_open" && t.tag === "h1");
    let title = "";
    if (h1 >= 0) {
      title = tokens[h1 + 1]?.content ?? "";
      tokens.splice(h1, 3);
      if (tokens[h1]?.type === "paragraph_open" && /^Level: \[(.+?)\] \| Priority: \[(.+?)\]$/.test(tokens[h1 + 1]?.content ?? "")) tokens.splice(h1, 3);
    }
    flat = flatten(md.renderer.render(tokens, md.options, env), title);
  } catch {
    flat = { text: "", shown: "", lineOf: [], sectionOf: [], sections: [""], title: "" };
  }
  cache.set(file, { hash, flat });
  return flat;
}

/** A piece of the text around a match, cut at word boundaries, with an ellipsis where it was cut. */
function around(shown: string, start: number, end: number): { before: string; after: string } {
  let b0 = Math.max(0, start - 48);
  if (b0 > 0) {
    const sp = shown.indexOf(" ", b0);
    if (sp >= 0 && sp < start) b0 = sp + 1;
  }
  let a1 = Math.min(shown.length, end + 72);
  if (a1 < shown.length) {
    const sp = shown.lastIndexOf(" ", a1);
    if (sp > end) a1 = sp;
  }
  return { before: (b0 > 0 ? "..." : "") + shown.slice(b0, start), after: shown.slice(end, a1) + (a1 < shown.length ? "..." : "") };
}

export function searchFiles(files: { file: string; text: string }[], query: string): SearchResult {
  const needle = normText(query);
  const chapters: SearchChapter[] = [];
  let total = 0;
  if (needle.length < MIN_QUERY) return { query, total, chapters };
  for (const { file, text } of files) {
    const flat = flatOf(file, text);
    const hits: SearchHit[] = [];
    let count = 0;
    const title = normText(flat.title);
    for (const at of occurrences(title, needle)) {
      count++;
      if (hits.length < MAX_HITS_PER_CHAPTER) {
        const raw = flat.title.replace(/\s+/g, " ").trim();
        // Positions in the normalised title are the positions in the shown title (same length, one for one).
        hits.push({ ordinal: -1, line: 1, section: "Chapter title", before: raw.slice(0, at), match: raw.slice(at, at + needle.length), after: raw.slice(at + needle.length), ctx: "" });
      }
    }
    const starts = occurrences(flat.text, needle);
    starts.forEach((at, ordinal) => {
      count++;
      if (hits.length >= MAX_HITS_PER_CHAPTER) return;
      const end = at + needle.length;
      const { before, after } = around(flat.shown, at, end);
      hits.push({
        ordinal,
        line: (flat.lineOf[at] ?? 0) + 1,
        section: flat.sections[flat.sectionOf[at] ?? 0] ?? "",
        before,
        match: flat.shown.slice(at, end),
        after,
        ctx: contextAround(flat.text, at, end),
      });
    });
    if (count > 0) {
      chapters.push({ file, count, hits });
      total += count;
    }
  }
  return { query, total, chapters };
}
