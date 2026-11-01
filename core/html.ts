// The whole book as one HTML document: cover, contents, chapters. Mirrors bookcore/templates/*.j2.

import type { BookConfig } from "./config.ts";
import type { Chapter } from "./book.ts";

export const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&#34;").replace(/'/g, "&#39;");

function cover(b: BookConfig): string {
  return `<section class="cover">
  <h1 class="cover-title">${esc(b.title)}</h1>
  ${b.subtitle ? `<p class="cover-subtitle">${esc(b.subtitle)}</p>` : ""}
  <div class="cover-rule"></div>
  ${b.author ? `<p class="cover-author">${esc(b.author)}</p>` : ""}
  ${b.date ? `<p class="cover-date">${esc(b.date)}</p>` : ""}
</section>`;
}

function toc(chapters: Chapter[]): string {
  const rows = chapters
    .map((ch) => {
      const part = ch.partOpens
        ? `    <li class="toc-part"><a href="#${ch.partId}"><span class="toc-label">${esc(ch.partLabel)}</span> <span class="toc-text">${esc(ch.partName)}</span><span class="toc-leader"></span></a></li>\n`
        : "";
      return `${part}    <li class="toc-chapter"><a href="#${ch.id}"><span class="toc-label">${esc(ch.label)}</span> <span class="toc-text">${ch.titleHtml}</span><span class="toc-leader"></span></a></li>`;
    })
    .join("\n");
  return `<nav class="toc">
  <h1 class="toc-title">Contents</h1>
  <ol class="toc-list">
${rows}
  </ol>
</nav>`;
}

function chapter(ch: Chapter, first: boolean): string {
  return `<article class="chapter${first ? " first-chapter" : ""}" id="${ch.id}">
  <header class="chapter-opener">
    ${ch.partOpens ? `<p class="part-eyebrow" id="${ch.partId}"><span class="part-label">${esc(ch.partLabel)}</span> <span class="part-name">${esc(ch.partName)}</span></p>` : ""}
    <p class="chapter-label">${esc(ch.label)}</p>
    <h1 class="chapter-title">${ch.titleHtml}</h1>
    ${ch.level ? `<p class="chapter-meta"><span>Level: ${esc(ch.level)}</span><span>Priority: ${esc(ch.priority)}</span></p>` : ""}
  </header>
  <div class="chapter-body">
${ch.bodyHtml}
  </div>
</article>`;
}

export interface HtmlOptions {
  /** Extra markup inside <head> (scripts, CSP). */
  head?: string;
  /** Skip the cover and contents (the app's reading view renders one chapter). */
  chaptersOnly?: boolean;
}

export function buildHtml(book: BookConfig, chapters: Chapter[], css: string, opts: HtmlOptions = {}): string {
  return `<!doctype html>
<html lang="${esc(book.language)}">
<head>
  <meta charset="utf-8">
  <title>${esc(book.title)}</title>
  <meta name="author" content="${esc(book.author)}">
  <meta name="description" content="${esc(book.subtitle)}">
${opts.head ?? ""}  <style>
${css}
  </style>
</head>
<body>
${opts.chaptersOnly ? "" : cover(book) + "\n" + toc(chapters) + "\n"}${chapters.map((c, i) => chapter(c, i === 0)).join("\n")}
</body>
</html>
`;
}
