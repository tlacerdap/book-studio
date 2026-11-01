// The app's reading view: one chapter, laid out exactly as it prints (same styles, same pagination rules), as a page
// the app shows in a frame. Line numbers in `data-src` are lines of the note-free text, so adding or answering a note
// never changes the page and never needs a re-render.

import fs from "node:fs";
import path from "node:path";
import { chapterFiles, type BookConfig } from "./config.ts";
import { assignParts, fileNumber, loadChapter, readIndex } from "./book.ts";
import { buildHtml } from "./html.ts";
import { makeMarkdown } from "./mdrender.ts";
import { stripNotes } from "./notes.ts";
import { STYLES } from "./paths.ts";
import { forPaged, readCss, resolvePageVars, styleFiles } from "./style.ts";

export interface ReadingOptions {
  /** URL prefix the app serves styles/ and dist/browser/ under, with a trailing slash: `bookstudio://assets/`. */
  assetBase: string;
}

const CSP = (assets: string) => `default-src 'none'; script-src ${assets}; style-src 'unsafe-inline' ${assets}; font-src ${assets}; img-src ${assets} data:; connect-src 'none'; frame-src 'none'; form-action 'none'`;

export function buildReadingHtml(book: BookConfig, file: string, text: string, opts: ReadingOptions): string {
  const files = chapterFiles(book);
  const md = makeMarkdown(new Set(files.map((f) => path.basename(f))), { sourceLines: true });
  const { text: plain } = stripNotes(text);
  const chapter = loadChapter(file, md, { text: plain, lineMap: [] });

  // A Part's name shows above the title only on the Part's first chapter, as in the printed book.
  const mapping = readIndex(book);
  assignParts([chapter], mapping);
  const n = fileNumber(path.basename(file));
  const idx = files.findIndex((f) => path.basename(f) === path.basename(file));
  const prev = idx > 0 ? fileNumber(path.basename(files[idx - 1])) : null;
  const here = n === null ? undefined : mapping.get(n);
  const before = prev === null ? undefined : mapping.get(prev);
  chapter.partOpens = !!here && here[0] !== before?.[0];

  const urlFor = (abs: string) => `${opts.assetBase}styles/${path.relative(STYLES, abs).split(path.sep).join("/")}`;
  const screen = fs.readFileSync(path.join(STYLES, "reading.css"), "utf8");
  const css = forPaged(resolvePageVars(readCss(styleFiles(book, [], { paged: true }), { absoluteUrls: true, urlFor }))) + "\n" + screen;
  const a = opts.assetBase;
  const head = `  <meta http-equiv="Content-Security-Policy" content="${CSP(a)}">
  <base href="${a}styles/">
  <script src="${a}browser/paged-config.js"></script>
  <script src="${a}browser/paged.polyfill.js"></script>
  <script src="${a}browser/paged-driver.js"></script>
  <script src="${a}browser/reading-bridge.js"></script>
`;
  return buildHtml(book, [chapter], css, { head, chaptersOnly: true }).replace(/style="orphans:(\d+);widows:(\d+)"/g, 'style="--pg-orphans:$1;--pg-widows:$2"');
}
