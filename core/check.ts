// Typographic and ink checks on a built book PDF. Port of bookcore/check.py, reading the PDF with pdfjs.
//
//  1. a page ends with a heading, or a heading has fewer than 3 lines after it on the same page
//  2. a page starts or ends with fewer than 3 lines of a paragraph that continues across the break
//  3. a code block is split with fewer than 4 visible lines on a side, or a short block is split
//  4. a sentence that introduces a list or code block is stranded at the bottom of a page
//  5. a list item is split across pages
//  6. contents page numbers differ from the real chapter start pages
//  7. dashes (em, en) in the PDF that are not in the source chapters; colour on any page
//  and information: measure (characters per line), pages that end mostly empty, darkest pages.
//
// The PDF has no structure, so lines are classified from the fonts the stylesheet assigns (read back from its custom
// properties): the heading serif at heading sizes and the body sans Semibold at H3 size are headings, the mono font at
// code size is code, drawn dots and number markers mark list items, everything else in the text area is body.

import fs from "node:fs";
import path from "node:path";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { BookConfig } from "./config.ts";
import { makeMarkdown } from "./mdrender.ts";
import { stripNotes } from "./notes.ts";
import { selectChapters } from "./book.ts";
import { readCss, styleFiles, styleMetrics, type StyleMetrics } from "./style.ts";

const SENTENCE_END = new Set([..."." + "!?:;)\"”’]"]);

// ---------------------------------------------------------------------------------------------------------------
// Reading the PDF
// ---------------------------------------------------------------------------------------------------------------

export interface Line {
  text: string;
  x0: number;
  x1: number;
  /** Baseline, measured down from the top of the page. */
  y: number;
  size: number;
  kind: "header" | "footer" | "heading" | "code" | "body";
  bullet: boolean;
}

export interface Block {
  kind: Line["kind"];
  lines: Line[];
}

export interface PageInfo {
  index: number;
  height: number;
  lines: Line[];
  blocks: Block[];
  /** The printed page number from the footer, "" if none. */
  label: string;
  /** The code frames drawn on the page (their outlines). */
  frames: Frame[];
}

interface TextItem {
  str: string;
  transform: number[];
  width: number;
  fontName: string;
}

type Dot = { cx: number; cy: number };
type Frame = { top: number; bottom: number };

/**
 * What the page draws besides text: small filled dots (the bullets of unordered lists) and long hairlines (the borders of
 * code frames), found from the filled paths in the content stream.
 */
async function drawnShapes(page: pdfjs.PDFPageProxy, size: number, pageHeight: number): Promise<{ dots: Dot[]; frames: Frame[] }> {
  const ops = await page.getOperatorList();
  const O = pdfjs.OPS;
  const dots: Dot[] = [];
  const frames: Frame[] = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];
  const mul = (m: number[], n: number[]) => [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
  ops.fnArray.forEach((fn, i) => {
    const args = ops.argsArray[i];
    if (fn === O.save) stack.push(ctm);
    else if (fn === O.restore) ctm = stack.pop() ?? ctm;
    else if (fn === O.transform) ctm = mul(ctm, args as number[]);
    else if (fn === O.constructPath && (args[0] === O.fill || args[0] === O.stroke) && args[2]) {
      const mm = args[2] as Record<number, number>;
      const w = (mm[2] - mm[0]) * Math.hypot(ctm[0], ctm[1]);
      const h = (mm[3] - mm[1]) * Math.hypot(ctm[2], ctm[3]);
      const cx = ctm[0] * (mm[0] + mm[2]) / 2 + ctm[2] * (mm[1] + mm[3]) / 2 + ctm[4];
      const cy = ctm[1] * (mm[0] + mm[2]) / 2 + ctm[3] * (mm[1] + mm[3]) / 2 + ctm[5];
      if (Math.abs(w - size) < 0.3 && Math.abs(h - size) < 0.3) dots.push({ cx, cy: pageHeight - cy });
      else if (args[0] === O.stroke && Math.abs(w) >= 200 && Math.abs(h) >= 8) {
        const ya = pageHeight - (ctm[1] * mm[0] + ctm[3] * mm[1] + ctm[5]);
        const yb = pageHeight - (ctm[1] * mm[0] + ctm[3] * mm[3] + ctm[5]);
        frames.push({ top: Math.min(ya, yb), bottom: Math.max(ya, yb) });
      }
    }
  });
  return { dots, frames };
}

async function readPage(page: pdfjs.PDFPageProxy, index: number, S: StyleMetrics): Promise<PageInfo> {
  const height = page.getViewport({ scale: 1 }).height;
  const tc = await page.getTextContent();
  const { dots, frames } = await drawnShapes(page, S.bulletSize, height); // also loads the fonts into commonObjs
  const fontNames = new Map<string, string>();
  const fontOf = (id: string): string => {
    let n = fontNames.get(id);
    if (n === undefined) {
      try {
        n = (page.commonObjs.get(id) as { name: string }).name.replace(/^[A-Z]{6}\+/, "").replace(/[- ]/g, "");
      } catch {
        n = "";
      }
      fontNames.set(id, n);
    }
    return n;
  };

  // Group text items into lines by baseline.
  const raw = (tc.items as TextItem[])
    .filter((it) => it.str !== "" || it.width > 0)
    .map((it) => ({ it, y: height - it.transform[5], x: it.transform[4], size: Math.hypot(it.transform[0], it.transform[1]), font: fontOf(it.fontName) }))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const groups: (typeof raw)[] = [];
  for (const r of raw) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(g[0].y - r.y) < 1.5) g.push(r);
    else groups.push([r]);
  }
  const lines: Line[] = [];
  for (const g of groups) {
    g.sort((a, b) => a.x - b.x);
    const text = g.map((r) => r.it.str).join("").replace(/­/g, "").trim();
    if (!text) continue;
    const real = g.filter((r) => r.it.str.trim());
    const size = Math.max(...real.map((r) => r.size));
    const y = g[0].y;
    const x0 = Math.min(...real.map((r) => r.x));
    const x1 = Math.max(...g.map((r) => r.x + r.it.width));
    const mono = real.every((r) => r.font.includes(S.mono));
    const serif = real.some((r) => r.font.includes(S.headingSerif));
    const semibold = real.some((r) => /semibold/i.test(r.font));
    let kind: Line["kind"];
    if (y < S.topMargin) kind = "header";
    else if (y > height - S.bottomMargin + 4) kind = "footer";
    else if (mono && Math.abs(size - S.codeSize) < 0.15) kind = "code";
    else if ((serif && size >= S.h2Size - 1.5) || (semibold && size >= S.h3Size - 0.5 && !mono)) kind = "heading";
    else kind = "body";
    const first = real[0];
    // A numbered item: its number is a run of its own, or part of the first run ("3. Why ...").
    const marker = (/^\d+\.$/.test(first.it.str.trim()) && real.length > 1) || /^\d{1,2}\.\s+\S/.test(text);
    const dot = dots.some((d) => d.cx < x0 && x0 - d.cx < 40 && Math.abs(d.cy - (y - size * 0.3)) < size * 0.7);
    lines.push({ text, x0, x1, y, size, kind, bullet: dot || marker });
  }
  const footer = lines.filter((l) => l.kind === "footer").map((l) => l.text);
  return { index, height, lines, blocks: makeBlocks(lines), label: footer[footer.length - 1] ?? "", frames };
}

function makeBlocks(lines: Line[]): Block[] {
  const blocks: Block[] = [];
  let prev: Line | null = null;
  for (const ln of lines) {
    if (ln.kind === "header" || ln.kind === "footer") continue;
    let fresh = true;
    if (prev && prev.kind === ln.kind && blocks.length) {
      const delta = ln.y - prev.y;
      if (ln.kind === "code") fresh = delta > ln.size * 1.5 * 5; // blank lines inside code leave gaps; blocks are rarely adjacent
      else if (ln.kind === "heading") fresh = delta > ln.size * 1.7 || Math.abs(ln.size - prev.size) > 0.5;
      else fresh = delta > ln.size * 1.5 + 2 || ln.bullet;
    }
    if (fresh) blocks.push({ kind: ln.kind, lines: [] });
    blocks[blocks.length - 1].lines.push(ln);
    prev = ln;
  }
  return blocks;
}

// ---------------------------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------------------------

let MEASURE = 0; // widest body line in the book

const bodyPages = (pages: PageInfo[]) => pages.filter((p) => /^\d+$/.test(p.label));
const isContinuation = (prev: Line, next: Line): boolean => {
  const full = prev.x1 - prev.x0 >= 0.8 * MEASURE;
  const ends = SENTENCE_END.has(prev.text.slice(-1));
  return (full && !ends) || !/^\p{Lu}/u.test(next.text);
};
const tip = (b: Block) => b.lines.map((l) => l.text).join(" ");

/** True if the next page opens a chapter (or there is none): a last section that is short has nothing more to keep with it. */
function endsChapter(pages: PageInfo[], p: PageInfo, S: StyleMetrics): boolean {
  const next = pages[p.index + 1];
  if (!next) return true;
  return next.lines.slice(0, 8).some((l) => l.kind === "heading" && l.size >= S.h1Size - 2);
}

function checkHeadings(pages: PageInfo[], S: StyleMetrics, minAfter: number): string[] {
  const out: string[] = [];
  for (const p of bodyPages(pages)) {
    const heads = p.blocks.map((b, i) => [b, i] as const).filter(([b]) => b.kind === "heading" && b.lines[0].size < S.h1Size - 2);
    if (!heads.length) continue;
    const [hb, i] = heads[heads.length - 1];
    const after = p.blocks.slice(i + 1).filter((b) => b.kind !== "heading").reduce((n, b) => n + b.lines.length, 0);
    if (p.blocks[p.blocks.length - 1].kind === "heading") out.push(`page ${p.index + 1} (printed ${p.label || "-"}): ends with heading '${tip(p.blocks[p.blocks.length - 1])}'`);
    else if (after < minAfter && !endsChapter(pages, p, S)) out.push(`page ${p.index + 1} (printed ${p.label || "-"}): heading '${tip(hb)}' has only ${after} line(s) after it`);
  }
  return out;
}

function checkFragments(pages: PageInfo[], minLines: number): string[] {
  const out: string[] = [];
  const body = bodyPages(pages);
  for (let k = 0; k + 1 < body.length; k++) {
    const a = body[k];
    const b = body[k + 1];
    if (!a.blocks.length || !b.blocks.length) continue;
    const last = a.blocks[a.blocks.length - 1];
    const first = b.blocks[0];
    if (last.kind !== "body" || first.kind !== "body" || last.lines[0].bullet || first.lines[0].bullet) continue; // list items never split
    if (!isContinuation(last.lines[last.lines.length - 1], first.lines[0])) continue;
    if (last.lines.length < minLines) out.push(`page ${a.index + 1} (printed ${a.label}): ends with ${last.lines.length} line(s) of a paragraph: '${tip(last).slice(0, 70)}'`);
    if (first.lines.length < minLines) out.push(`page ${b.index + 1} (printed ${b.label}): starts with ${first.lines.length} line(s) of a paragraph: '${tip(first).slice(0, 70)}'`);
  }
  return out;
}

function checkCodeSplits(pages: PageInfo[], S: StyleMetrics, minCode: number, shortLimit: number): { problems: string[]; splits: number } {
  const problems: string[] = [];
  let splits = 0;
  const body = bodyPages(pages);
  for (let k = 0; k + 1 < body.length; k++) {
    const a = body[k];
    const b = body[k + 1];
    if (!a.blocks.length || !b.blocks.length) continue;
    const last = a.blocks[a.blocks.length - 1];
    const first = b.blocks[0];
    if (last.kind !== "code" || first.kind !== "code") continue;
    // A real split runs to the bottom of one page and resumes at the top of the next. Two separate blocks (code, then
    // its output) that merely meet at a page boundary do not.
    const lineH = S.codeSize * 1.5;
    const reachesBottom = a.height - S.bottomMargin - last.lines[last.lines.length - 1].y < lineH * 2.2;
    const startsAtTop = first.lines[0].y - S.topMargin < lineH * 3;
    if (!reachesBottom || !startsAtTop) continue;
    // A split frame is open at the cut. A frame that closes (its bottom border sits a padding below the last line) or
    // opens (its top border sits a padding above the first) belongs to a separate block: a script and its output.
    const lastY = last.lines[last.lines.length - 1].y;
    const firstY = first.lines[0].y;
    const frameA = a.frames.find((f) => f.top < lastY && f.bottom > lastY - 1);
    const frameB = b.frames.find((f) => f.top < firstY && f.bottom > firstY - 1);
    const closes = !!frameA && frameA.bottom - lastY > 8;
    const opens = !!frameB && firstY - frameB.top > 13;
    if (closes || opens) continue;
    splits++;
    const n1 = last.lines.length;
    const n2 = first.lines.length;
    if (n1 < minCode || n2 < minCode) problems.push(`pages ${a.index + 1}-${b.index + 1}: code split ${n1} + ${n2} lines (min ${minCode}): '${last.lines[0].text.slice(0, 50)}'`);
    else if (n1 + n2 <= shortLimit) problems.push(`pages ${a.index + 1}-${b.index + 1}: short code block (${n1 + n2} lines) split ${n1} + ${n2}`);
  }
  return { problems, splits };
}

/** A page must not end with a sentence that introduces a list or code block (it ends with a colon). */
function checkStrandedIntro(pages: PageInfo[]): string[] {
  const out: string[] = [];
  const body = bodyPages(pages);
  body.forEach((p, k) => {
    const last = p.blocks[p.blocks.length - 1];
    if (!last || last.kind !== "body" || !last.lines[last.lines.length - 1].text.endsWith(":")) return;
    const next = body[k + 1];
    if (next?.blocks[0]?.kind === "body" && !/^\p{Lu}/u.test(next.blocks[0].lines[0].text)) return; // the sentence continues
    out.push(`page ${p.index + 1} (printed ${p.label}): ends with an introducing sentence '${tip(last).slice(-60)}'`);
  });
  return out;
}

/** List items must not split: a page must not open with an indented block that continues the previous page's last block. */
function checkListSplits(pages: PageInfo[]): string[] {
  const out: string[] = [];
  const body = bodyPages(pages);
  const lefts = body.flatMap((p) => p.lines.filter((l) => l.kind === "body" && l.size > 10).map((l) => Math.round(l.x0)));
  if (!lefts.length) return out;
  const tally = new Map<number, number>();
  lefts.forEach((x) => tally.set(x, (tally.get(x) ?? 0) + 1));
  // The text edge is the smallest x that many lines share (list text is indented from it).
  const left = Math.min(...[...tally].filter(([, n]) => n > lefts.length * 0.05).map(([x]) => x));
  for (let k = 0; k + 1 < body.length; k++) {
    const a = body[k];
    const b = body[k + 1];
    if (!a.blocks.length || !b.blocks.length || a.blocks[a.blocks.length - 1].kind !== "body" || b.blocks[0].kind !== "body") continue;
    const first = b.blocks[0].lines[0];
    const last = a.blocks[a.blocks.length - 1];
    if (first.x0 > left + 10 && !first.bullet && isContinuation(last.lines[last.lines.length - 1], first)) {
      out.push(`pages ${a.index + 1}-${b.index + 1}: list item appears to continue across the break: '${first.text.slice(0, 60)}'`);
    }
  }
  return out;
}

/** Letters and digits only: layout may add hyphens, spaces and bullets, none of which changes what was said. */
// Latin letters and digits only: a fallback font (CJK, say) cannot always be read back to Unicode, so those characters are not compared.
const alnum = (s: string): string => s.replace(/[^A-Za-z0-9\u00C0-\u024F]+/g, "");

/**
 * The words of a table cell that cannot be found in the printed text. A cell is not one run there: narrow columns break
 * words at the end of a line (with a hyphen, or a ligature glyph apart) and the neighbouring columns' lines come in
 * between. So a word counts as present when it is found whole, or when its first four letters or its last four are
 * (a word broken early still has its end intact, and one broken late its beginning). Words under five letters are skipped.
 */
export function tableWordsMissing(cell: string, printed: string): string[] {
  const out: string[] = [];
  for (const w of cell.match(/[A-Za-z0-9\u00C0-\u024F]+/g) ?? []) {
    if (w.length < 5) continue;
    if (!printed.includes(w) && !printed.includes(w.slice(0, 4)) && !printed.includes(w.slice(-4))) out.push(w);
  }
  return out;
}

/**
 * Every paragraph, heading, list item and code line of the source must be in the printed text. This is the check on the
 * PDF itself: the page can look fine on screen and still lose a line when it is printed.
 */
function checkTextIntegrity(pages: PageInfo[], sources: { name: string; text: string }[]): string[] {
  const printed = alnum(
    pages
      .filter((p) => p.label === "" ? false : /^\d+$/.test(p.label))
      .flatMap((p) => p.lines.filter((l) => l.kind !== "header" && l.kind !== "footer").map((l) => l.text))
      .join(""),
  );
  const md = makeMarkdown(new Set());
  const missing: string[] = [];
  for (const src of sources) {
    let inTable = false;
    for (const tok of md.parse(stripNotes(src.text).text, {})) {
      // A table prints its columns side by side, so the lines of one cell are interleaved with its neighbours' and its
      // text is never one run in the printed text. Cells are checked word by word instead (see tableWordsMissing).
      if (tok.type === "table_open") inTable = true;
      else if (tok.type === "table_close") inTable = false;
      const pieces: string[] = [];
      if (inTable) {
        if (tok.type === "inline" && tok.children) {
          const cell = tok.children.filter((t) => t.type === "text" || t.type === "code_inline").map((t) => t.content).join(" ");
          for (const w of tableWordsMissing(cell, printed)) missing.push(`${src.name}: table cell word '${w}'`);
        }
        continue;
      }
      if (tok.type === "inline" && tok.children) {
        // An external link prints its address after its text, so the run of source text is broken there.
        let cur = "";
        let inExternal = false;
        for (const t of tok.children) {
          if (t.type === "link_open" && String(t.attrGet("href") ?? "").startsWith("http")) {
            pieces.push(cur);
            cur = "";
            inExternal = true;
          } else if (t.type === "link_close" && inExternal) {
            pieces.push(cur);
            cur = "";
            inExternal = false;
          } else if (t.type === "text" || t.type === "code_inline") cur += t.content;
        }
        pieces.push(cur);
      }
      // A diagram written as text (mermaid) prints as a picture, not as these lines.
      else if (tok.type === "fence" && tok.info.trim().split(/\s+/)[0] === "mermaid") continue;
      else if (tok.type === "fence" || tok.type === "code_block") pieces.push(...tok.content.split("\n"));
      for (const piece of pieces) {
        const key = alnum(piece);
        if (key.length >= 3 && !printed.includes(key)) missing.push(`${src.name}: '${piece.trim().slice(0, 70)}'`);
      }
    }
  }
  const shown = missing.slice(0, 10);
  if (missing.length > shown.length) shown.push(`... and ${missing.length - shown.length} more`);
  return shown;
}

function squash(s: string): string {
  return s.replace(/[\s­]+/g, "");
}

/** Compare contents page numbers with where each chapter really starts: bookmarks and the number printed in the footer. */
async function checkToc(doc: pdfjs.PDFDocumentProxy, pages: PageInfo[], S: StyleMetrics): Promise<{ problems: string[]; note: string; marks: { title: string; page: number }[] }> {
  const entries: { title: string; printed: number; part: boolean }[] = [];
  const stripLabel = (words: string[]): { words: string[]; part: boolean } => {
    const part = /^part$/i.test(words[0] ?? "");
    return { words: part || words[0] === "Chapter" || words[0] === "Appendix" ? words.slice(2) : words, part };
  };
  for (const p of pages) {
    if (!/^[ivxlc]+$/.test(p.label)) continue;
    let pending: { words: string[]; part: boolean } | null = null; // a wrapped title: its first lines carry no number
    for (const l of p.lines) {
      if (l.kind === "header" || l.kind === "footer" || (l.kind === "heading" && l.size >= S.h1Size - 2)) continue;
      const words = l.text.split(/\s+/).filter((w) => !/^\.+$/.test(w));
      const last = words[words.length - 1];
      if (!/^\d+$/.test(last) || (words.length < 2 && !pending)) {
        if (words.length) pending = pending !== null ? { words: [...pending.words, ...words], part: pending.part } : stripLabel(words);
        continue;
      }
      const head = pending ?? stripLabel(words.slice(0, -1));
      const title = pending ? [...pending.words, ...words.slice(0, -1)] : head.words;
      if (pending && !title.length) continue;
      entries.push({ title: title.join(" "), printed: parseInt(last, 10), part: head.part });
      pending = null;
    }
  }
  if (process.env.BOOKSTUDIO_DEBUG) for (const p of pages) if (/^[ivxlc]+$/.test(p.label)) for (const l of p.lines) console.error(`TOC ${p.label} y=${l.y.toFixed(1)} ${l.kind} ${JSON.stringify(l.text)}`);
  if (!entries.length) return { problems: ["no contents entries found in the front matter"], note: "", marks: [] };

  const marks: { title: string; page: number }[] = [];
  const walk = async (items: Awaited<ReturnType<typeof doc.getOutline>>): Promise<void> => {
    for (const o of items ?? []) {
      let dest = o.dest;
      if (typeof dest === "string") dest = await doc.getDestination(dest);
      if (Array.isArray(dest)) {
        try {
          marks.push({ title: o.title, page: await doc.getPageIndex(dest[0]) });
        } catch {
          /* destination outside the document */
        }
      }
      await walk(o.items);
    }
  };
  await walk(await doc.getOutline());

  const problems: string[] = [];
  let checked = 0;
  let lastChapterPage: string | null = null;
  // Parts have no bookmark: a Part opens on the same page as its first chapter, which is the entry that follows it.
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.part) {
      const next = entries.slice(i + 1).find((x) => !x.part);
      if (next && next.printed !== e.printed) problems.push(`contents says Part '${e.title}' is on page ${e.printed}, but its first chapter is on page ${next.printed}`);
      else checked++;
      continue;
    }
    const mark = marks.find((m) => squash(m.title) === squash(e.title));
    if (!mark) {
      problems.push(`contents entry '${e.title}' has no matching bookmark`);
      continue;
    }
    const real = pages[mark.page]?.label;
    checked++;
    if (String(e.printed) !== real) problems.push(`contents says '${e.title}' is on page ${e.printed}, but it starts on printed page ${real || "?"} (pdf page ${mark.page + 1})`);
    lastChapterPage = real ?? lastChapterPage;
  }
  void lastChapterPage;
  return { problems, note: `${checked} of ${entries.length} contents entries verified against bookmarks and footers`, marks };
}

function checkDashes(pages: PageInfo[], sources: string[]): string[] {
  const text = pages.flatMap((p) => p.lines.map((l) => l.text)).join("\n");
  const src = sources.join("");
  const out: string[] = [];
  for (const [ch, name] of [["—", "em dash"], ["–", "en dash"]] as const) {
    const n = text.split(ch).length - 1;
    const m = src.split(ch).length - 1;
    if (n > m) out.push(`${n} ${name}(s) in the PDF but ${m} in the source`);
  }
  return out;
}

function measure(pages: PageInfo[]): number {
  const widths: number[] = [];
  for (const p of bodyPages(pages)) {
    for (const b of p.blocks) {
      if (b.kind !== "body") continue;
      for (const ln of b.lines.slice(0, -1)) if (ln.size > 10 && ln.text.length > 40 && !ln.bullet) widths.push(ln.text.length);
    }
  }
  if (!widths.length) return 0;
  const max = Math.max(...widths);
  const full = widths.filter((w) => w >= 0.8 * max).sort((a, b) => a - b);
  return full.length % 2 ? full[(full.length - 1) / 2] : (full[full.length / 2 - 1] + full[full.length / 2]) / 2;
}

function blankGaps(pages: PageInfo[], S: StyleMetrics, share: number): string[] {
  const out: string[] = [];
  const body = bodyPages(pages);
  const area = body[0] ? body[0].height - S.topMargin - S.bottomMargin : 0;
  for (let k = 0; k + 1 < body.length; k++) {
    const a = body[k];
    const used = a.lines.filter((l) => l.kind === "body" || l.kind === "code" || l.kind === "heading");
    if (!used.length || body[k + 1].blocks.some((bl) => bl.kind === "heading" && bl.lines[0].size >= S.h1Size - 2)) continue; // empty, or the next page opens a chapter
    const gap = (a.height - S.bottomMargin - (Math.max(...used.map((l) => l.y)) + 0.25 * 12)) / area;
    if (gap > share) out.push(`page ${a.index + 1} (printed ${a.label}): ${Math.round(gap * 100)}% of the text area is empty at the bottom`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Ink and colour (rasterised)
// ---------------------------------------------------------------------------------------------------------------

interface Raster {
  ink: number[];
  coloured: number[];
}

async function rasterise(doc: pdfjs.PDFDocumentProxy, dpi: number, samples?: { dir: string; pages: Map<string, number>; dpi: number }): Promise<Raster> {
  const ink: number[] = [];
  const coloured: number[] = [];
  const factory = (doc as unknown as { canvasFactory: { create(w: number, h: number): { canvas: { toBuffer(t: string): Buffer }; context: CanvasRenderingContext2D } } }).canvasFactory;
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: dpi / 72 });
    const { canvas, context } = factory.create(Math.ceil(vp.width), Math.ceil(vp.height));
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, vp.width, vp.height);
    await page.render({ canvasContext: context, viewport: vp, canvas: canvas as unknown as HTMLCanvasElement }).promise;
    const { data } = context.getImageData(0, 0, Math.ceil(vp.width), Math.ceil(vp.height));
    let sum = 0;
    let colour = false;
    for (let p = 0; p < data.length; p += 4) {
      const r = data[p], g = data[p + 1], b = data[p + 2];
      sum += (r + g + b) / 3;
      if (!colour && Math.max(r, g, b) - Math.min(r, g, b) > 12) colour = true;
    }
    ink.push(1 - sum / (data.length / 4) / 255);
    if (colour) coloured.push(i);
  }
  void samples;
  return { ink, coloured };
}

async function writeSamples(doc: pdfjs.PDFDocumentProxy, pages: PageInfo[], dir: string, dpi: number): Promise<Record<string, string>> {
  fs.mkdirSync(dir, { recursive: true });
  const body = bodyPages(pages);
  const pick: Record<string, number> = { cover: 0 };
  pick.contents = Math.max(0, pages.findIndex((p) => p.label === "i"));
  if (body.length) {
    pick["chapter-opening"] = body[0].index;
    const share = (p: PageInfo) => p.lines.filter((l) => l.kind === "code").length / (p.lines.filter((l) => ["body", "code", "heading"].includes(l.kind)).length || 1);
    pick["code-heavy"] = body.reduce((a, b) => (share(b) > share(a) ? b : a)).index;
    const bullets = (p: PageInfo) => p.blocks.filter((b) => b.kind === "body" && b.lines[0].bullet).length;
    pick["list-heavy"] = body.reduce((a, b) => (bullets(b) > bullets(a) ? b : a)).index;
  }
  const out: Record<string, string> = {};
  const factory = (doc as unknown as { canvasFactory: { create(w: number, h: number): { canvas: { toBuffer(t: string): Buffer }; context: CanvasRenderingContext2D } } }).canvasFactory;
  for (const [name, idx] of Object.entries(pick)) {
    const page = await doc.getPage(idx + 1);
    const vp = page.getViewport({ scale: dpi / 72 });
    const { canvas, context } = factory.create(Math.ceil(vp.width), Math.ceil(vp.height));
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, vp.width, vp.height);
    await page.render({ canvasContext: context, viewport: vp, canvas: canvas as unknown as HTMLCanvasElement }).promise;
    const file = path.join(dir, `${name}.png`);
    fs.writeFileSync(file, canvas.toBuffer("image/png"));
    out[`${name} (pdf page ${idx + 1})`] = file;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Running everything
// ---------------------------------------------------------------------------------------------------------------

export interface CheckResult {
  title: string;
  status: "pass" | "fail" | "info" | "warn";
  problems: string[];
  note: string;
}

export interface CheckReport {
  /** The PDF's bookmarks with their 1-based page numbers (chapters and their headings). */
  bookmarks: { title: string; page: number }[];
  pdf: string;
  pages: number;
  bodyPages: number;
  results: CheckResult[];
  measure: number;
  inkMedian: number;
  darkest: [number, number][];
  samples: Record<string, string>;
  failures: number;
  ok: boolean;
  problemLines: string[];
}

export interface CheckOptions {
  extraCss?: string[];
  /** The chapters the PDF was built from (a --chapters selection); default all. */
  chapters?: string[];
  minLines?: number;
  minCodeLines?: number;
  shortCode?: number;
  inkFactor?: number;
  inkMax?: number;
  gap?: number;
  samples?: string;
  /** Skip rasterising (ink and colour checks): much faster, used by tests. */
  noRaster?: boolean;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

export async function runChecks(pdfPath: string, book: BookConfig, opts: CheckOptions = {}): Promise<CheckReport> {
  const minLines = opts.minLines ?? 3;
  const minCode = opts.minCodeLines ?? 4;
  const shortCode = opts.shortCode ?? 15;
  const gapShare = opts.gap ?? 0.25;
  const S = styleMetrics(readCss(styleFiles(book, opts.extraCss ?? [], { paged: true })));
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)), useSystemFonts: false, verbosity: 0 }).promise;
  const pages: PageInfo[] = [];
  for (let i = 1; i <= doc.numPages; i++) pages.push(await readPage(await doc.getPage(i), i - 1, S));
  MEASURE = Math.max(0, ...pages.flatMap((p) => p.lines.filter((l) => l.kind === "body" && l.size > 11).map((l) => l.x1 - l.x0)));
  const nBody = bodyPages(pages).length;

  const res = (title: string, problems: string[], note = ""): CheckResult => ({ title, status: problems.length ? "fail" : "pass", problems, note });
  const code = checkCodeSplits(pages, S, minCode, shortCode);
  const toc = await checkToc(doc, pages, S);
  const files = selectChapters(book, opts.chapters);
  const sources = files.map((f) => fs.readFileSync(f, "utf8"));
  const results: CheckResult[] = [
    res("page ends with a heading, or a heading has fewer than 3 lines after it", checkHeadings(pages, S, 3)),
    res(`page starts or ends with fewer than ${minLines} paragraph lines`, checkFragments(pages, minLines)),
    res(`code split with fewer than ${minCode} lines on a side`, code.problems, `${code.splits} split blocks`),
    res("list introducing sentence stranded at the page bottom", checkStrandedIntro(pages)),
    res("list item split across pages", checkListSplits(pages)),
    res("contents page numbers match chapter start pages", toc.problems, toc.note),
    res("no em or en dashes introduced", checkDashes(pages, sources)),
    res("every paragraph, list item and code line of the source is in the printed text", checkTextIntegrity(pages, files.map((f) => ({ name: path.basename(f), text: fs.readFileSync(f, "utf8") })))),
  ];
  const gaps = blankGaps(pages, S, gapShare);
  results.push({
    title: `pages ending with more than ${Math.round(gapShare * 100)}% of the text area empty: ${gaps.length} of ${nBody}`,
    status: gaps.length ? "info" : "pass",
    problems: [...gaps.slice(0, 12), ...(gaps.length > 12 ? [`... and ${gaps.length - 12} more`] : [])],
    note: "",
  });

  let inkMedian = 0;
  let darkest: [number, number][] = [];
  if (!opts.noRaster) {
    const raster = await rasterise(doc, 60);
    const text = raster.ink.filter((v) => v > 0.02);
    inkMedian = median(text);
    const limit = Math.max(opts.inkMax ?? 0.14, (opts.inkFactor ?? 1.8) * inkMedian);
    const flagged = raster.ink.map((v, i) => [i + 1, v] as const).filter(([, v]) => v > limit);
    darkest = raster.ink.map((v, i) => [i + 1, v] as [number, number]).sort((a, b) => b[1] - a[1]).slice(0, 3);
    results.push({ title: "no page has unusually high ink coverage", status: flagged.length ? "warn" : "pass", problems: flagged.map(([pg, v]) => `page ${pg}: ${v.toFixed(3)}`), note: "" });
    results.push(res("every page is strictly monochrome", raster.coloured.length ? [`colour found on page(s) ${raster.coloured.slice(0, 15).join(", ")}`] : []));
  }
  const failures = results.filter((r) => r.status === "fail").length;
  const report: CheckReport = {
    bookmarks: toc.marks.map((m) => ({ title: m.title, page: m.page + 1 })),
    pdf: pdfPath,
    pages: doc.numPages,
    bodyPages: nBody,
    results,
    measure: measure(pages),
    inkMedian,
    darkest,
    samples: opts.samples ? await writeSamples(doc, pages, opts.samples, 110) : {},
    failures,
    ok: failures === 0,
    problemLines: results.filter((r) => r.status === "fail").flatMap((r) => r.problems.map((p) => `${r.title}: ${p}`)),
  };
  await doc.destroy();
  return report;
}

export function formatReport(r: CheckReport): string {
  const out = [`${r.pdf}: ${r.pages} pages (${r.bodyPages} numbered body pages)`, ""];
  for (const x of r.results) {
    const tag = { pass: "PASS", info: "INFO", warn: "WARN", fail: `FAIL (${x.problems.length})` }[x.status];
    out.push(`[${tag}] ${x.title}${x.note ? `  [${x.note}]` : ""}`);
    for (const p of x.problems) out.push(`    - ${p}`);
  }
  const flag = r.measure >= 62 && r.measure <= 78 ? "" : "  <- outside the 65 to 75 target";
  out.push(`\nmeasure: median ${Math.round(r.measure)} characters per full line${flag}`);
  if (r.darkest.length) out.push(`ink: median text page darkness ${r.inkMedian.toFixed(3)} (mean grey level, 0 = white); darkest pages: ${r.darkest.map(([pg, v]) => `${pg} (${v.toFixed(3)})`).join(", ")}`);
  for (const [name, file] of Object.entries(r.samples)) out.push(`sample: ${name.padEnd(28)} -> ${file}`);
  out.push(`\nRESULT: ${r.ok ? "all checks passed" : `${r.failures} check(s) failed`}`);
  return out.join("\n");
}
