import { describe, expect, it } from "vitest";
import { Fragment } from "prosemirror-model";
import { parseChapter, serializeBlock, serializeChapter } from "../core/pm/markdown.ts";
import { schema } from "../core/pm/schema.ts";

const chapter = `# Chapter 2 - Python

## In one sentence

Python is a **programming language** whose code reads like \`plain English\`.
It continues on a second line with *emphasis* and a [link](03-next.md).

<!-- Q: why? [on: "plain English"] -->
<!-- A: done - because -->

## How it works

1. **First.** One thing with a \`code\` span.
2. **Second.** Another thing.
   - nested bullet
   - another nested

- plain bullet
<!-- E: tighten the list -->
- second bullet

| Name | Kind |
| --- | :---: |
| a | b |
| c \\| d | e |

> A quote line

Footnote style text[^1] is kept as written.

[^1]: The note.

---

\`\`\`python
x = 1

y = 2
\`\`\`

Last paragraph without a final newline`;

const blocks = (doc: ReturnType<typeof parseChapter>) => {
  const out: string[] = [];
  doc.forEach((n) => out.push(n.type.name));
  return out;
};

describe("reading a chapter into the editor's model", () => {
  const doc = parseChapter(chapter);
  it("finds the blocks, the notes between them and the ones it keeps as written", () => {
    expect(blocks(doc)).toEqual(["heading", "heading", "paragraph", "note", "heading", "ordered_list", "bullet_list", "table", "blockquote", "raw_block", "raw_block", "horizontal_rule", "code_block", "paragraph"]);
  });
  it("writes an untouched chapter back exactly, byte for byte", () => {
    expect(serializeChapter(doc)).toBe(chapter);
  });
  it("round-trips CRLF files and a missing final newline", () => {
    const crlf = chapter.replace(/\n/g, "\r\n") + "\r\n";
    expect(serializeChapter(parseChapter(crlf))).toBe(crlf);
  });
  it("keeps what follows the last block", () => {
    expect(serializeChapter(parseChapter("# T\n\nOne.\n\n\n"))).toBe("# T\n\nOne.\n\n\n");
    expect(serializeChapter(parseChapter(""))).toBe("");
  });
  it("keeps the note inside a list with its list", () => {
    const list = doc.child(6);
    expect(list.type.name).toBe("bullet_list");
    expect(list.attrs.meta.inner.length).toBe(1);
  });
});

describe("writing an edited chapter", () => {
  const map = (text: string, edit: (n: import("prosemirror-model").Node, index: number) => import("prosemirror-model").Node) => {
    const doc = parseChapter(text);
    const children: import("prosemirror-model").Node[] = [];
    doc.forEach((n, _o, i) => children.push(edit(n, i)));
    return schema.topNodeType.create(null, children);
  };
  const append = (n: import("prosemirror-model").Node, s: string) => n.copy(n.content.append(Fragment.from(schema.text(s))));
  it("changes only the block that was edited", () => {
    const edited = serializeChapter(map(chapter, (n, i) => (i === 2 ? append(n, " More words.") : n)));
    // The paragraph keeps its two lines; only the words added are new, and everything else is untouched.
    const expected = chapter.replace("[link](03-next.md).", "[link](03-next.md). More words.");
    expect(edited).toBe(expected);
    expect(edited).toContain("<!-- Q: why? [on: \"plain English\"] -->");
    expect(edited).toContain("<!-- E: tighten the list -->");
  });
  it("puts a note that sat inside an edited list back after it", () => {
    const item = schema.nodes.list_item.create(null, schema.nodes.paragraph.create(null, schema.text("third")));
    const edited = serializeChapter(map(chapter, (n, i) => (i === 6 ? n.copy(n.content.append(Fragment.from(item))) : n)));
    expect(edited).toContain("- plain bullet\n- second bullet\n- third\n<!-- E: tighten the list -->");
  });
  it("writes new blocks as markdown with a blank line before", () => {
    const doc = parseChapter("# T\n\nOne.\n");
    const kids: import("prosemirror-model").Node[] = [];
    doc.forEach((n) => kids.push(n));
    kids.push(schema.nodes.heading.create({ level: 2 }, schema.text("New")), schema.nodes.paragraph.create(null, [schema.text("a ", [schema.marks.strong.create()]), schema.text("b")]));
    expect(serializeChapter(schema.topNodeType.create(null, kids))).toBe("# T\n\nOne.\n\n## New\n\n**a** b\n");
  });
  it("escapes what would otherwise be read as markdown", () => {
    const doc = parseChapter("# T\n\nOne.\n");
    const out = serializeChapter(map("# T\n\nOne.\n", (n, i) => (i === 1 ? n.copy(Fragment.from(schema.text("a * b _c_ [d]"))) : n)));
    expect(out).toBe("# T\n\na \\* b \\_c\\_ [d]\n");
    void doc;
  });
});

describe("writing blocks", () => {
  it("uses hyphens for bullets, pipes for tables, and keeps the book's conventions", () => {
    const doc = parseChapter("- a\n- b\n\n| x | y |\n| --- | --- |\n| 1 | 2 |\n");
    expect(serializeBlock(doc.child(0))).toBe("- a\n- b");
    expect(serializeBlock(doc.child(1))).toBe("| x | y |\n| --- | --- |\n| 1 | 2 |");
  });
});
