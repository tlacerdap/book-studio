import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { atomicWrite } from "../core/fsutil.ts";
import { makeMarkdown } from "../core/mdrender.ts";
import { deleteNote, editNote, insertAnswer, insertNote, joinLines, openNotes, parseNotes, splitLines, stripNotes, threads } from "../core/notes.ts";

// A chapter with every kind of block, so each one can take a note.
const FIXTURE = `---
title: front matter is not a block
---
# Chapter 1 - Title

Level: [B] | Priority: [Core]

## Why this matters

A paragraph with **bold**, \`code\` and a [link](https://example.com).
It runs over two lines.

- first item
- second item
  - nested item
- third item

1. one
2. two

\`\`\`python
x = 1
# <!-- Q: this is code, not a note -->
print(x)
\`\`\`

> A quote
> over two lines

| a | b |
|---|---|
| 1 | 2 |

---

Text with a footnote.[^1]

[^1]: The footnote.

### Last heading
Final paragraph, no blank line above it.
`;

interface Block {
  type: string;
  start: number;
  end: number; // last line, inclusive
}

/** Top-level blocks and list items, from markdown-it's own line map. */
function blocks(text: string): Block[] {
  const md = makeMarkdown(new Set());
  return md
    .parse(text, {})
    .filter((t) => t.map && t.nesting >= 0 && (t.level === 0 || t.type === "list_item_open"))
    .map((t) => {
      const lines = splitLines(text);
      let end = t.map![1] - 1;
      while (end > t.map![0] && lines[end].body.trim() === "") end--; // the line map of a list includes the blank line after it
      return { type: t.type, start: t.map![0], end };
    });
}

const lineAt = (text: string, i: number) => splitLines(text)[i].body;

describe("notes: parsing", () => {
  it("reads all four kinds in the HTML syntax", () => {
    const n = parseNotes("Para\n<!-- Q: why? -->\n<!-- E: fix it -->\n<!-- ? -->\n<!-- A: done - fixed -->\n");
    expect(n.map((x) => [x.kind, x.text])).toEqual([["Q", "why?"], ["E", "fix it"], ["?", ""], ["A", "done - fixed"]]);
    expect(n.every((x) => x.syntax === "html")).toBe(true);
  });

  it("reads all four kinds in the Obsidian syntax", () => {
    const n = parseNotes("Para\n%%Q: why?%%\n%%E: fix it%%\n%%?%%\n%%A: ok%%\n");
    expect(n.map((x) => [x.kind, x.text])).toEqual([["Q", "why?"], ["E", "fix it"], ["?", ""], ["A", "ok"]]);
    expect(n.every((x) => x.syntax === "obsidian")).toBe(true);
  });

  it("anchors each run to the block above it and attaches answers to the note they follow", () => {
    const text = "One\n<!-- Q: a -->\n<!-- A: b -->\n<!-- E: c -->\n\nTwo\n<!-- ? -->\n";
    const n = parseNotes(text);
    expect(n.map((x) => x.anchor)).toEqual([0, 0, 0, 5]);
    expect(n[1].parent).toBe(0);
    expect(n[2].parent).toBeNull(); // E starts its own thread
    const t = threads(n);
    expect(t.map((x) => x.answers.length)).toEqual([1, 0, 0]);
    expect(openNotes(n).map((x) => x.kind)).toEqual(["E", "?"]);
  });

  it("ignores things that merely look like notes", () => {
    expect(parseNotes("<!-- just a comment -->\n<!-- Qx: no -->\ntext <!-- Q: inline --> more\n")).toEqual([]);
  });

  it("never reads a note inside a fenced code block", () => {
    expect(parseNotes("```html\n<!-- Q: in code -->\n```\n~~~\n%%E: also code%%\n~~~\n")).toEqual([]);
  });

  it("joins a multi-line comment into one note", () => {
    const [n] = parseNotes("Para\n<!-- A: first part\nsecond part -->\nNext\n");
    expect(n.text).toBe("first part second part");
    expect([n.start, n.end]).toEqual([1, 2]);
  });

  it("keeps notes out of the rendered page", () => {
    const text = "Para one\n<!-- Q: hidden question -->\n<!-- A: hidden answer -->\n\nPara two\n%%E: hidden edit%%\n";
    const { text: clean } = stripNotes(text);
    const html = makeMarkdown(new Set()).render(clean);
    expect(html).not.toMatch(/hidden|Q:|%%|<!--/);
    expect(html).toContain("Para one");
    expect(html).toContain("Para two");
  });

  it("maps stripped lines back to the original lines", () => {
    const { text, lineMap } = stripNotes("a\n<!-- Q: x -->\nb\n%%?%%\nc\n");
    expect(text).toBe("a\nb\nc\n");
    expect(lineMap).toEqual([0, 2, 4]);
  });
});

describe("notes: open and save with no edits", () => {
  const samples = ["", "one line", "one line\n", "a\r\nb\r\n", "a\nb\r\nc\n", "no final newline\nlast", "\n\n\n", FIXTURE];
  for (const s of samples) {
    it(`split then join is the identity (${JSON.stringify(s.slice(0, 18))})`, () => {
      expect(joinLines(splitLines(s))).toBe(s);
    });
  }
});

describe("notes: insert, edit and delete change only the note's own lines", () => {
  const all = blocks(FIXTURE);

  it("finds a good spread of block types in the fixture", () => {
    const types = new Set(all.map((b) => b.type));
    for (const t of ["heading_open", "paragraph_open", "bullet_list_open", "ordered_list_open", "list_item_open", "fence", "blockquote_open", "table_open", "hr"]) {
      expect(types, t).toContain(t);
    }
  });

  for (const b of all) {
    const name = `${b.type} at lines ${b.start + 1}-${b.end + 1}`;
    for (const syntax of ["html", "obsidian"] as const) {
      it(`${name} (${syntax})`, () => {
        const inserted = insertNote(FIXTURE, b.end, "Q", "what does this mean?", syntax);
        const before = splitLines(FIXTURE);
        const after = splitLines(inserted);

        // exactly one new line, right after the block, and every other line identical
        expect(after.length).toBe(before.length + 1);
        expect(after.slice(0, b.end + 1)).toEqual(before.slice(0, b.end + 1));
        expect(after.slice(b.end + 2)).toEqual(before.slice(b.end + 1));
        expect(after[b.end + 1].body).toMatch(syntax === "html" ? /^\s*<!-- Q: what does this mean\? -->$/ : /^\s*%%Q: what does this mean\?%%$/);

        // it parses back as one note attached to this block
        const [note] = parseNotes(inserted).filter((n) => n.start === b.end + 1);
        expect(note).toMatchObject({ kind: "Q", text: "what does this mean?", anchor: b.end });

        // the rendered page is unchanged
        const md = makeMarkdown(new Set());
        expect(md.render(stripNotes(inserted).text)).toBe(md.render(stripNotes(FIXTURE).text));

        // editing touches only that line
        const edited = editNote(inserted, note, "now it is an edit", "E");
        const e = splitLines(edited);
        expect(e.length).toBe(after.length);
        e.forEach((l, i) => i !== b.end + 1 && expect(l).toEqual(after[i]));
        expect(e[b.end + 1].body).toContain("E: now it is an edit");

        // deleting restores the original, byte for byte
        expect(deleteNote(inserted, note)).toBe(FIXTURE);
        expect(deleteNote(edited, parseNotes(edited).filter((n) => n.start === b.end + 1)[0])).toBe(FIXTURE);
      });
    }
  }

  it("adds a note after the notes already under a block, not before them", () => {
    const one = insertNote("Para\n\nNext\n", 0, "Q", "first");
    const two = insertNote(one, 0, "E", "second");
    expect(two).toBe("Para\n<!-- Q: first -->\n<!-- E: second -->\n\nNext\n");
  });

  it("writes an answer under the note it answers, after existing answers", () => {
    let t = "Para\n<!-- Q: why -->\n<!-- E: also -->\n\nNext\n";
    t = insertAnswer(t, parseNotes(t), 0, "because");
    expect(t).toBe("Para\n<!-- Q: why -->\n<!-- A: because -->\n<!-- E: also -->\n\nNext\n");
    t = insertAnswer(t, parseNotes(t), 0, "and more");
    expect(t).toBe("Para\n<!-- Q: why -->\n<!-- A: because -->\n<!-- A: and more -->\n<!-- E: also -->\n\nNext\n");
  });

  it("keeps the note's indentation inside a list", () => {
    const t = "- item\n  - nested\n";
    expect(insertNote(t, 1, "?", "")).toBe("- item\n  - nested\n  <!-- ? -->\n");
  });

  it("matches the file's line endings", () => {
    const t = "Para\r\n\r\nNext\r\n";
    const out = insertNote(t, 0, "Q", "why");
    expect(out).toBe("Para\r\n<!-- Q: why -->\r\n\r\nNext\r\n");
    expect(deleteNote(out, parseNotes(out)[0])).toBe(t);
  });

  it("works at the end of a file with no final newline, and undoes cleanly", () => {
    const t = "Para\n\nLast line";
    const out = insertNote(t, 2, "Q", "why");
    expect(out).toBe("Para\n\nLast line\n<!-- Q: why -->");
    expect(deleteNote(out, parseNotes(out)[0])).toBe(t);
  });

  it("works on the very first line and in an empty file", () => {
    expect(insertNote("Title\nBody\n", 0, "?", "")).toBe("Title\n<!-- ? -->\nBody\n");
    expect(insertNote("", -1, "Q", "x")).toBe("<!-- Q: x -->\n");
  });

  it("cannot be broken by note text that contains the closing delimiter", () => {
    const out = insertNote("Para\n", 0, "Q", "does --> end it? %% too");
    expect(parseNotes(out)).toHaveLength(1);
    expect(splitLines(out)).toHaveLength(2);
  });

  it("flattens newlines in note text to one line", () => {
    const out = insertNote("Para\n", 0, "Q", "line one\nline two");
    expect(out).toBe("Para\n<!-- Q: line one line two -->\n");
  });
});

describe("atomic writes", () => {
  it("replaces the file, keeps its mode and leaves no temporary file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bs-"));
    const f = path.join(dir, "ch.md");
    fs.writeFileSync(f, "old", { mode: 0o640 });
    atomicWrite(f, "new");
    expect(fs.readFileSync(f, "utf8")).toBe("new");
    expect(fs.statSync(f).mode & 0o777).toBe(0o640);
    expect(fs.readdirSync(dir)).toEqual(["ch.md"]);
    fs.rmSync(dir, { recursive: true });
  });
});
