// The document model of the visual editor: the same blocks and marks markdown has, plus tables, and two kinds of block
// the editor shows but does not edit as text (a note, and any markdown it does not understand, kept exactly as written).

import { schema as base } from "prosemirror-markdown";
import { Schema, type MarkSpec, type NodeSpec } from "prosemirror-model";
import { tableNodes } from "prosemirror-tables";

/** Top-level blocks remember where they came from in the file (see markdown.ts). */
const withMeta = (spec: NodeSpec): NodeSpec => ({ ...spec, attrs: { ...(spec.attrs ?? {}), meta: { default: null } } });

const BLOCKS = ["paragraph", "heading", "blockquote", "code_block", "horizontal_rule", "bullet_list", "ordered_list"];

// `tail` is whatever followed the last block in the file (blank lines), so it comes back as it was.
const nodes = base.spec.nodes.update("doc", { content: "block+", attrs: { tail: { default: "" } } });
// Lists the writer makes in the editor are tight (no blank line between items), as the book writes them; lists read from a
// file say for themselves.
const tight = (name: string) => {
  const n = nodes.get(name)!;
  return { ...n, attrs: { ...(n.attrs ?? {}), tight: { default: true } } };
};
let spec = nodes.update("bullet_list", tight("bullet_list")).update("ordered_list", tight("ordered_list"));
const nodesTight = spec;
for (const name of BLOCKS) spec = spec.update(name, withMeta(nodesTight.get(name)!));

const table = tableNodes({ tableGroup: "block", cellContent: "inline*", cellAttributes: { align: { default: null, getFromDOM: (dom) => dom.getAttribute("align"), setDOMAttr: (v, attrs) => { if (v) attrs.align = String(v); } } } });

const extra: Record<string, NodeSpec> = {
  // A line break inside a paragraph (the next line of the same paragraph in the file). It shows as a space, as it prints,
  // and is written back as the line break it was, so a paragraph keeps the lines it had.
  soft_break: { inline: true, group: "inline", selectable: false, parseDOM: [], toDOM: () => ["span", { class: "pm-soft" }, " "] },
  table: withMeta(table.table),
  table_row: table.table_row,
  table_cell: table.table_cell,
  table_header: table.table_header,
  // A note (<!-- Q: ... -->) lies between blocks; it is shown as a small label and never edited here.
  note: { group: "block", atom: true, selectable: true, attrs: { source: { default: "" }, meta: { default: null } }, parseDOM: [], toDOM: (n) => ["div", { class: "pm-note" }, String(n.attrs.source)] },
  // Markdown the editor has no picture of (footnotes, raw HTML, front matter): kept character for character.
  raw_block: { group: "block", atom: true, selectable: true, attrs: { source: { default: "" }, meta: { default: null } }, parseDOM: [], toDOM: (n) => ["pre", { class: "pm-raw" }, String(n.attrs.source)] },
};
for (const [name, s] of Object.entries(extra)) spec = spec.addToEnd(name, s);

const strike: MarkSpec = { parseDOM: [{ tag: "s" }, { tag: "del" }], toDOM: () => ["s", 0] };

export const schema = new Schema({ nodes: spec, marks: base.spec.marks.addToEnd("strike", strike) });
