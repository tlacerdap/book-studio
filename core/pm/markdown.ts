// Markdown to the visual editor's document and back, without disturbing a character the writer did not touch.
//
// The file is cut into items: blocks (paragraph, list, table...), notes, and anything else kept as it is. Each item
// remembers its original text and the blank lines before it. Writing the document back, an item that was not changed is
// written from that memory, byte for byte; only an item that was edited is written fresh, as markdown.

import MarkdownIt from "markdown-it";
import { MarkdownParser, MarkdownSerializer, MarkdownSerializerState, defaultMarkdownSerializer } from "prosemirror-markdown";
import type { Node as PMNode } from "prosemirror-model";
import { parseNotes, splitLines, stripNotes, type Line } from "../notes.ts";
import { schema } from "./schema.ts";

export interface Meta {
  /** The item's original text (without its last line ending), and the blank lines before it, and its line ending. */
  src: string;
  before: string;
  eol: string;
  /** First line of the item in the file (0-based). */
  line: number;
  /** Note lines that sat inside the item (between list items, say); put back after it if it is rewritten. */
  inner: string[];
}

// ---- parsing ------------------------------------------------------------------------------------

const tokenizer = new MarkdownIt("commonmark", { html: false, typographer: false }).enable(["table", "strikethrough"]);

const listIsTight = (tokens: { type: string; hidden: boolean }[], i: number): boolean => {
  while (++i < tokens.length) if (tokens[i].type !== "list_item_open") return tokens[i].hidden;
  return false;
};
const alignOf = (tok: { attrGet(n: string): string | null }): string | null => /text-align:\s*(\w+)/.exec(tok.attrGet("style") ?? "")?.[1] ?? null;

const parser = new MarkdownParser(schema, tokenizer, {
  blockquote: { block: "blockquote" },
  paragraph: { block: "paragraph" },
  list_item: { block: "list_item" },
  bullet_list: { block: "bullet_list", getAttrs: (_t, tokens, i) => ({ tight: listIsTight(tokens, i) }) },
  ordered_list: { block: "ordered_list", getAttrs: (tok, tokens, i) => ({ order: +(tok.attrGet("start") ?? 1) || 1, tight: listIsTight(tokens, i) }) },
  heading: { block: "heading", getAttrs: (tok) => ({ level: +tok.tag.slice(1) }) },
  code_block: { block: "code_block", noCloseToken: true },
  fence: { block: "code_block", getAttrs: (tok) => ({ params: tok.info || "" }), noCloseToken: true },
  hr: { node: "horizontal_rule" },
  image: { node: "image", getAttrs: (tok) => ({ src: tok.attrGet("src"), title: tok.attrGet("title") || null, alt: (tok.children && tok.children[0] && tok.children[0].content) || null }) },
  hardbreak: { node: "hard_break" },
  softbreak: { node: "soft_break" },
  em: { mark: "em" },
  strong: { mark: "strong" },
  s: { mark: "strike" },
  link: { mark: "link", getAttrs: (tok) => ({ href: tok.attrGet("href"), title: tok.attrGet("title") || null }) },
  code_inline: { mark: "code", noCloseToken: true },
  table: { block: "table" },
  thead: { ignore: true },
  tbody: { ignore: true },
  tr: { block: "table_row" },
  th: { block: "table_header", getAttrs: (tok) => ({ align: alignOf(tok) }) },
  td: { block: "table_cell", getAttrs: (tok) => ({ align: alignOf(tok) }) },
});

/** What a block looked like when it was read, so that "was it changed?" can be answered by comparing. */
const pristine = new WeakMap<Meta, PMNode>();

/** One block's markdown as a node, or null when the editor cannot picture it. */
function blockNode(src: string): PMNode | null {
  // Footnotes ([^1]) mean something to the book's printing: a block that has any is kept exactly as written.
  if (/\[\^[^\]\s]+\]/.test(src)) return null;
  try {
    const doc = parser.parse(src);
    return doc.childCount === 1 ? doc.child(0) : null;
  } catch {
    return null;
  }
}

const frontMatterEnd = (lines: Line[]): number => {
  if (!lines.length || lines[0].body.trim() !== "---") return -1;
  for (let i = 1; i < Math.min(lines.length, 200); i++) if (lines[i].body.trim() === "---") return i;
  return -1;
};

interface Item {
  kind: "block" | "note" | "raw";
  first: number;
  last: number;
  /** For a block: the lines of the note-free text it was parsed from. */
  plain?: string;
  inner: number[];
}

const rawOf = (lines: Line[], first: number, last: number): string => lines.slice(first, last + 1).map((l, i, a) => l.body + (i < a.length - 1 ? l.eol : "")).join("");

export function parseChapter(text: string): PMNode {
  const lines = splitLines(text);
  const fm = frontMatterEnd(lines);
  // Front matter is set aside: it is blanked for the parser and kept as a block of its own.
  const scrubbed = fm < 0 ? text : joinKeep(lines, fm);
  const noteRuns: { start: number; end: number }[] = [];
  for (const n of parseNotes(scrubbed)) {
    const last = noteRuns[noteRuns.length - 1];
    if (last && n.start === last.end + 1) last.end = n.end;
    else noteRuns.push({ start: n.start, end: n.end });
  }
  const { text: plain, lineMap } = stripNotes(scrubbed);
  const plainLines = plain.split(/\r\n|\n|\r/);
  const tokens = tokenizer.parse(plain, {});

  const items: Item[] = [];
  if (fm >= 0) items.push({ kind: "raw", first: 0, last: fm, inner: [] });
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.level !== 0 || !t.map || t.nesting < 0) continue;
    let end = i;
    if (t.nesting === 1) while (end < tokens.length && !(tokens[end].level === 0 && tokens[end].nesting === -1)) end++;
    const first = lineMap[t.map[0]];
    const last = lineMap[t.map[1] - 1];
    if (first === undefined || last === undefined) continue;
    items.push({ kind: "block", first, last, plain: plainLines.slice(t.map[0], t.map[1]).join("\n"), inner: [] });
    i = end;
  }
  const covered = new Set<number>();
  for (const it of items) for (let l = it.first; l <= it.last; l++) covered.add(l);
  // Notes inside a block belong to it; the others stand between blocks.
  for (const run of noteRuns) {
    const host = items.find((it) => it.kind === "block" && run.start > it.first && run.end <= it.last);
    if (host) host.inner.push(run.start);
    else items.push({ kind: "note", first: run.start, last: run.end, inner: [] });
    for (let l = run.start; l <= run.end; l++) covered.add(l);
  }
  // Anything else that is not blank (a link definition, say) is kept as it is.
  let start = -1;
  for (let l = 0; l <= lines.length; l++) {
    const stray = l < lines.length && !covered.has(l) && lines[l].body.trim() !== "";
    if (stray && start < 0) start = l;
    if (!stray && start >= 0) {
      items.push({ kind: "raw", first: start, last: l - 1, inner: [] });
      for (let k = start; k < l; k++) covered.add(k);
      start = -1;
    }
  }
  items.sort((a, b) => a.first - b.first);

  const children: PMNode[] = [];
  let prevEnd = -1;
  for (const it of items) {
    const before = lines.slice(prevEnd + 1, it.first).map((l) => l.body + l.eol).join("");
    const src = rawOf(lines, it.first, it.last);
    const innerLines = it.inner.flatMap((s) => {
      const run = noteRuns.find((r) => r.start === s)!;
      return [rawOf(lines, run.start, run.end)];
    });
    const meta: Meta = { src, before, eol: lines[it.last].eol, line: it.first, inner: innerLines };
    prevEnd = it.last;
    if (it.kind === "note") children.push(schema.nodes.note.create({ source: src, meta }));
    else if (it.kind === "raw") children.push(schema.nodes.raw_block.create({ source: src, meta }));
    else {
      const node = blockNode(it.plain!);
      if (!node) children.push(schema.nodes.raw_block.create({ source: src, meta }));
      else {
        const withMeta = node.type.create({ ...node.attrs, meta }, node.content, node.marks);
        pristine.set(meta, withMeta);
        children.push(withMeta);
      }
    }
  }
  const tail = rawOf(lines, prevEnd + 1, lines.length - 1) + (prevEnd + 1 < lines.length ? lines[lines.length - 1].eol : "");
  return schema.topNodeType.create({ tail }, children.length ? children : [schema.nodes.paragraph.create()]);
}

/** The text with the front matter lines emptied (same number of lines). */
function joinKeep(lines: Line[], fm: number): string {
  return lines.map((l, i) => (i <= fm ? l.eol : l.body + l.eol)).join("");
}

// ---- writing ------------------------------------------------------------------------------------

// Square brackets are only escaped where they could start a link or a reference: `Level: [B]` stays as typed.
const baseEsc = MarkdownSerializerState.prototype.esc;
MarkdownSerializerState.prototype.esc = function (str: string, startOfLine?: boolean): string {
  const out = baseEsc.call(this, str, startOfLine);
  return /\]\(|\]\[|\]:/.test(str) ? out : out.replace(/\\([[\]])/g, "$1");
};

const serializer = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,
    soft_break(state) {
      state.text("\n", false);
    },
    // Numbers are not padded to the width of the largest one ("9." stays "9.").
    ordered_list(state, node) {
      const start = (node.attrs.order as number) ?? 1;
      const space = state.repeat(" ", String(start + node.childCount - 1).length + 2);
      state.renderList(node, space, (i) => `${start + i}. `);
    },
    // The book writes bullets with a hyphen.
    bullet_list(state, node) {
      state.renderList(node, "  ", () => "- ");
    },
    table(state, node) {
      const rows: string[][] = [];
      const aligns: (string | null)[] = [];
      node.forEach((row, _o, r) => {
        const cells: string[] = [];
        row.forEach((cell) => {
          if (r === 0) aligns.push((cell.attrs.align as string | null) ?? null);
          cells.push(inlineText(cell));
        });
        rows.push(cells);
      });
      const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
      state.write(line(rows[0] ?? []));
      state.write("\n");
      state.write(`| ${aligns.map((a) => (a === "center" ? ":---:" : a === "right" ? "---:" : a === "left" ? ":---" : "---")).join(" | ")} |`);
      for (const r of rows.slice(1)) {
        state.write("\n");
        state.write(line(r));
      }
      state.closeBlock(node);
    },
    note(state, node) {
      state.write(String(node.attrs.source));
      state.closeBlock(node);
    },
    raw_block(state, node) {
      state.write(String(node.attrs.source));
      state.closeBlock(node);
    },
  },
  { ...defaultMarkdownSerializer.marks, strike: { open: "~~", close: "~~", mixable: true, expelEnclosingWhitespace: true } },
);

/** A table cell's inline content as one line of markdown. */
function inlineText(cell: PMNode): string {
  const wrapper = schema.nodes.paragraph.create(null, cell.content);
  return serializer.serialize(schema.topNodeType.create(null, [wrapper])).trim().replace(/\n+/g, " ").replace(/\|/g, "\\|");
}

export function serializeBlock(node: PMNode): string {
  return serializer.serialize(schema.topNodeType.create(null, [node])).replace(/\n+$/, "");
}

const sameAttrs = (a: PMNode, b: PMNode): boolean => {
  const keys = new Set([...Object.keys(a.attrs), ...Object.keys(b.attrs)]);
  keys.delete("meta");
  for (const k of keys) if (a.attrs[k] !== b.attrs[k]) return false;
  return true;
};

const unchanged = (meta: Meta, node: PMNode): boolean => {
  const first = pristine.get(meta);
  return !!first && first.type === node.type && sameAttrs(first, node) && first.content.eq(node.content);
};

export function serializeChapter(doc: PMNode): string {
  // An empty file is a document with one empty paragraph.
  if (doc.childCount === 1 && doc.child(0).type === schema.nodes.paragraph && doc.child(0).childCount === 0 && !doc.child(0).attrs.meta) return String(doc.attrs.tail ?? "");
  let out = "";
  const seen = new Set<Meta>();
  let prevEol = "";
  doc.forEach((node, _offset, index) => {
    const meta = (node.attrs.meta as Meta | null) ?? null;
    // Splitting a paragraph copies its memory; the copy is a new block.
    const fresh = !meta || seen.has(meta);
    if (meta) seen.add(meta);
    let src: string;
    if (node.type.name === "note" || node.type.name === "raw_block") src = String(node.attrs.source);
    else if (!fresh && unchanged(meta!, node)) src = meta!.src;
    else {
      src = serializeBlock(node);
      if (!fresh && meta!.inner.length) src += "\n" + meta!.inner.join("\n");
    }
    const before = fresh ? (index === 0 ? "" : "\n") : meta!.before;
    const eol = fresh ? "\n" : meta!.eol;
    if (index > 0 && prevEol === "") out += "\n";
    out += before + src + eol;
    prevEol = eol;
  });
  return out + String(doc.attrs.tail ?? "");
}
