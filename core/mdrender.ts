// Markdown to HTML for the print and reading views. Port of bookcore/mdrender.py.
//
// The rules are about typography and page breaks, not about any one book:
//  - curly quotes and real ellipses, but `--` and `---` are left exactly as written
//  - bare URLs wrapped so they can break anywhere
//  - links to other chapters become in-document links when the target is in this build, and plain text when it is not
//  - the sentence that introduces a list or code block is flagged to stay on the same page
//  - code highlighted with token classes only; the look is in styles/book.css
//  - note comments never reach the page

import MarkdownIt, { type MarkdownIt as Markdown, type StateCore, type Token } from "markdown-it";
import footnote from "markdown-it-footnote";
import frontMatter from "markdown-it-front-matter";
import hljs from "highlight.js/lib/core";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import yaml from "highlight.js/lib/languages/yaml";
import ini from "highlight.js/lib/languages/ini";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import xml from "highlight.js/lib/languages/xml";
import sql from "highlight.js/lib/languages/sql";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";

hljs.registerLanguage("python", python);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("json", json);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("dockerfile", dockerfile);
const LANG_ALIASES: Record<string, string> = { toml: "ini", sh: "bash", shell: "bash", zsh: "bash", html: "xml", ts: "typescript", js: "javascript", py: "python", yml: "yaml", jsonl: "json" };

// Code blocks up to this many visible (non-blank, wrapped) lines stay on one page; longer ones may split.
export const SHORT_CODE_LINES = 15;
// Rough number of monospace columns per line, used only to estimate wrapped line counts.
export const CODE_COLUMNS = 77;
// A split code block keeps at least this many visible (non-blank) lines on each side.
export const MIN_CODE_VISIBLE = 4;
// A paragraph shorter than this (about three lines) after a heading is kept with the next block.
export const SHORT_PARAGRAPH_CHARS = 210;

const URL_RE = /https?:\/\/[^\s<>()[\]]+[^\s<>()[\].,;:!?'"’”]/g;

type Meta = { lead_in?: boolean; drop?: boolean };
const meta = (t: Token): Meta => (t.meta ??= {}) as Meta;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function chapterId(fileName: string): string {
  const stem = fileName.replace(/\.[^.]*$/, "").toLowerCase();
  return "ch-" + stem.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// markdown-it's own `replacements` rule is left off because it would also turn `--` and `---` into
// en and em dashes, and the book uses plain hyphens. Only the ellipsis is applied.
function ellipsisRule(state: StateCore): void {
  for (const block of state.tokens) {
    if (block.type !== "inline" || !block.children) continue;
    for (const tok of block.children) if (tok.type === "text" && tok.content.includes("...")) tok.content = tok.content.replaceAll("...", "…");
  }
}

function wrapUrlsRule(state: StateCore): void {
  for (const block of state.tokens) {
    if (block.type !== "inline" || !block.children) continue;
    const out: Token[] = [];
    let inLink = 0;
    for (const tok of block.children) {
      if (tok.type === "link_open") inLink++;
      else if (tok.type === "link_close") inLink--;
      // A global regex remembers where its last test() stopped, so test with a fresh one.
      if (tok.type !== "text" || inLink || !new RegExp(URL_RE.source).test(tok.content)) {
        out.push(tok);
        continue;
      }
      const mk = (type: string, content: string) => {
        const t = new state.Token(type, "", 0);
        t.content = content;
        return t;
      };
      let pos = 0;
      for (const m of tok.content.matchAll(URL_RE)) {
        if (m.index! > pos) out.push(mk("text", tok.content.slice(pos, m.index)));
        out.push(mk("html_inline", '<span class="url">'), ...urlPieces(state, m[0]), mk("html_inline", "</span>"));
        pos = m.index! + m[0].length;
      }
      if (pos < tok.content.length) out.push(mk("text", tok.content.slice(pos)));
    }
    block.children = out;
  }
}

/** Text tokens for a URL, with a soft break after each slash (Chromium does not break "a/b" by itself). */
function urlPieces(state: StateCore, url: string): Token[] {
  const out: Token[] = [];
  const mk = (type: string, content: string): Token => {
    const t = new state.Token(type, "", 0);
    t.content = content;
    return t;
  };
  let last = 0;
  for (let i = 0; i < url.length; i++) {
    if (url[i] === "/" && url[i + 1] !== "/" && i + 1 < url.length) {
      out.push(mk("text", url.slice(last, i + 1)), mk("html_inline", "<wbr>"));
      last = i + 1;
    }
  }
  if (last < url.length) out.push(mk("text", url.slice(last)));
  return out;
}

function linkRule(builtFiles: Set<string>) {
  return (state: StateCore): void => {
    for (const block of state.tokens) {
      if (block.type !== "inline" || !block.children) continue;
      const stack: Token[] = [];
      const out: Token[] = [];
      for (const tok of block.children) {
        out.push(tok);
        if (tok.type === "link_open") {
          stack.push(tok);
          const href = String(tok.attrGet("href") ?? "");
          const target = href.split("#")[0];
          if (target.endsWith(".md") && !target.includes("://")) {
            const name = target.slice(target.lastIndexOf("/") + 1);
            if (builtFiles.has(name)) {
              tok.attrSet("href", "#" + chapterId(name));
              tok.attrJoin("class", "xref");
            } else meta(tok).drop = true;
          } else if (href.startsWith("http")) tok.attrJoin("class", "ext");
        } else if (tok.type === "link_close" && stack.length) {
          const opener = stack.pop()!;
          if (meta(opener).drop) meta(tok).drop = true;
          else if (String(opener.attrGet("class") ?? "").split(" ").includes("ext")) {
            // Printed pages cannot be clicked: show where an external link goes, as real text so it can wrap at slashes.
            const mk = (type: string, content: string): Token => {
              const t = new state.Token(type, "", 0);
              t.content = content;
              return t;
            };
            out.push(mk("html_inline", '<span class="ext-url"> ('), ...urlPieces(state, String(opener.attrGet("href"))), mk("html_inline", ")</span>"));
          }
        }
      }
      block.children = out;
    }
  };
}

// Flag the sentence that introduces a list or a code block so CSS keeps it on the same page as what follows.
function keepWithNextRule(state: StateCore): void {
  const toks = state.tokens;
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    if (tok.type !== "paragraph_open" || i + 3 >= toks.length) continue;
    const nxt = toks[i + 3];
    // A short paragraph straight after a heading would leave the heading with fewer than three lines of text.
    if (i && toks[i - 1].type === "heading_close" && toks[i + 1].content.length < SHORT_PARAGRAPH_CHARS) meta(tok).lead_in = true;
    if (nxt.type === "bullet_list_open" || nxt.type === "ordered_list_open") meta(tok).lead_in = true;
    else if (toks[i + 1].content.trimEnd().endsWith(":")) {
      let j = i + 3;
      const closers: Token[] = [];
      while (j < toks.length && ["list_item_close", "bullet_list_close", "ordered_list_close"].includes(toks[j].type)) closers.push(toks[j++]);
      if (j < toks.length && (toks[j].type === "fence" || toks[j].type === "code_block")) {
        meta(tok).lead_in = true;
        // The enclosing list item and list too: break-after does not propagate from a last child to its parent.
        for (const close of closers) {
          for (let k = i - 1; k >= 0; k--) {
            if (toks[k].type === close.type.replace("_close", "_open") && toks[k].level === close.level) {
              meta(toks[k]).lead_in = true;
              break;
            }
          }
        }
      }
    }
  }
}

// highlight.js marks Python triple-quoted strings as plain strings. A triple-quoted string that starts a
// line is a docstring (the same rule Pygments uses), so it gets its own class and prints grey italic.
function markDocstrings(html: string): string {
  return html.replace(/(^|\n)([ \t]*)<span class="hljs-string">("""|''')/g, '$1$2<span class="hljs-string hljs-doc">$3');
}

// Layout engines may drop a whitespace-only text node that sits between two inline elements, which glues
// `async` to `def`. Give every such run of whitespace an element of its own.
function keepWhitespace(html: string): string {
  return html.replace(/>(\s+)</g, '><span class="w">$1</span><');
}

/** Split highlighted HTML into lines, closing and reopening any spans that run across a line break. */
export function splitHighlightedLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let cur = "";
  for (const m of html.matchAll(/<span[^>]*>|<\/span>|[^<]+/g)) {
    const tok = m[0];
    if (tok.startsWith("</")) {
      open.pop();
      cur += tok;
    } else if (tok.startsWith("<")) {
      open.push(tok);
      cur += tok;
    } else {
      const parts = tok.split("\n");
      parts.forEach((part, i) => {
        cur += part;
        if (i < parts.length - 1) {
          lines.push(cur + "</span>".repeat(open.length));
          cur = open.join("");
        }
      });
    }
  }
  lines.push(cur);
  return lines;
}

export function highlightCode(code: string, lang: string): string {
  const name = LANG_ALIASES[lang] ?? lang;
  if (!name || name === "text" || name === "plaintext" || !hljs.getLanguage(name)) return escapeHtml(code);
  try {
    const out = hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
    return name === "python" ? markDocstrings(out) : out;
  } catch {
    return escapeHtml(code);
  }
}

export interface RenderOptions {
  /** Add data-src="first-last" (0-based, inclusive, original file lines) to block elements, for the reading view. */
  sourceLines?: boolean;
  /** Maps a line of the note-free text back to the line in the file. */
  lineMap?: number[];
}

export function makeMarkdown(builtFiles: Set<string>, opts: RenderOptions = {}): Markdown {
  const md = new MarkdownIt("commonmark", { typographer: true, html: false });
  md.enable(["table", "strikethrough"]);
  md.use(frontMatter, () => {});
  md.use(footnote);
  md.enable("smartquotes"); // curly quotes and apostrophes; `replacements` stays off on purpose
  md.core.ruler.push("book_ellipsis", ellipsisRule);
  md.core.ruler.push("book_urls", wrapUrlsRule);
  md.core.ruler.push("book_links", linkRule(builtFiles));
  md.core.ruler.push("book_keep_with_next", keepWithNextRule);
  if (opts.sourceLines) {
    md.core.ruler.push("book_source_lines", (state: StateCore) => {
      const map = opts.lineMap;
      const orig = (n: number) => (map ? (map[n] ?? map[map.length - 1] ?? n) : n);
      for (const tok of state.tokens) {
        if (tok.map && tok.nesting >= 0 && (tok.level === 0 || tok.type === "list_item_open")) {
          tok.attrSet("data-src", `${orig(tok.map[0])}-${orig(tok.map[1] - 1)}`);
        }
      }
    });
  }

  const rules = md.renderer.rules;
  const fence = (tokens: Token[], idx: number): string => {
    const tok = tokens[idx];
    const info = tok.info.trim();
    const lang = info ? info.split(/\s+/)[0] : "";
    const code = tok.content.replace(/\n+$/, "");
    const src = code.split("\n");
    // Visible lines only: blank lines inside code do not make a block "long".
    let visible = 0;
    for (const line of src) if (line.trim()) visible += Math.ceil(line.length / CODE_COLUMNS);
    const size = visible <= SHORT_CODE_LINES ? "short" : "long";
    const tiny = src.filter((l) => l.trim()).length <= 2;
    // One block element per source line: a page break can only fall between lines, and counting lines is exact.
    const highlighted = highlightCode(code, lang);
    const body = (highlighted === escapeHtml(code) ? src.map(escapeHtml) : splitHighlightedLines(highlighted))
      .map((l) => `<span class="cl">${l.trim() ? keepWhitespace(l) : " "}</span>`)
      .join("");
    const dataSrc = tok.attrGet("data-src");
    // orphans/widows for a code block count visible (non-blank) lines.
    return `<pre class="code code-${size}${tiny ? " lead-in" : ""}" style="orphans:${MIN_CODE_VISIBLE};widows:${MIN_CODE_VISIBLE}" data-lang="${escapeHtml(lang || "text")}"${dataSrc ? ` data-src="${dataSrc}"` : ""}><code>${body}</code></pre>\n`;
  };
  rules.fence = fence;
  rules.code_block = (tokens, idx) => {
    const t = tokens[idx];
    t.info = "";
    return fence(tokens, idx);
  };
  const withLeadIn = (tokens: Token[], idx: number, options: Markdown["options"], _env: unknown, self: { renderToken: (t: Token[], i: number, o: Markdown["options"]) => string }) => {
    if (meta(tokens[idx]).lead_in) tokens[idx].attrJoin("class", "lead-in");
    return self.renderToken(tokens, idx, options);
  };
  for (const r of ["paragraph_open", "bullet_list_open", "ordered_list_open", "list_item_open"]) rules[r] = withLeadIn;
  rules.link_open = (tokens, idx, options, _env, self) => (meta(tokens[idx]).drop ? "" : self.renderToken(tokens, idx, options));
  rules.link_close = (tokens, idx) => (meta(tokens[idx]).drop ? "" : "</a>");
  return md;
}
