import { describe, expect, it } from "vitest";
import { splitLines, joinLines } from "../core/notes.ts";
import { paragraphAt, paragraphs, rangeFor, replaceRange, sectionAt } from "../core/ranges.ts";

const text = `# Title

Intro line one
intro line two

## First

Para A

- item 1
- item 2

\`\`\`python
x = 1

y = 2
\`\`\`

### Sub

Para B

## Second

Para C
`;
const lines = splitLines(text);

describe("paragraphs", () => {
  it("are runs of lines between blank lines, with a code block kept whole", () => {
    const p = paragraphs(lines).map((r) => lines.slice(r.from, r.to + 1).map((l) => l.body)[0]);
    expect(p).toEqual(["# Title", "Intro line one", "## First", "Para A", "- item 1", "```python", "### Sub", "Para B", "## Second", "Para C"]);
    const code = paragraphs(lines).find((r) => lines[r.from].body.startsWith("```"))!;
    expect(lines[code.to].body).toBe("```");
  });
  it("finds the one a line is in, or the next after a blank", () => {
    expect(paragraphAt(lines, 3)).toEqual({ from: 2, to: 3 });
    expect(paragraphAt(lines, 4)).toEqual({ from: 5, to: 5 });
  });
});

describe("sections", () => {
  it("run from a heading to the next one of the same or higher rank", () => {
    const first = sectionAt(lines, 7);
    expect(lines[first.from].body).toBe("## First");
    expect(lines[first.to].body).toBe("Para B");
    const sub = sectionAt(lines, 20);
    expect(lines[sub.from].body).toBe("### Sub");
    expect(lines[sub.to].body).toBe("Para B");
  });
  it("start at the top for text above any heading, and end at the file's end", () => {
    expect(sectionAt(lines, 0).from).toBe(0);
    const last = sectionAt(lines, lines.length - 2);
    expect(lines[last.to].body).toBe("Para C");
  });
  it("the whole chapter is every line", () => {
    expect(rangeFor("chapter", lines, 5)).toEqual({ from: 0, to: lines.length - 1 });
  });
});

describe("replacing a range", () => {
  it("keeps line endings and the rest of the file", () => {
    const crlf = splitLines("a\r\nb\r\n\r\nc\r\n");
    expect(joinLines(replaceRange(crlf, { from: 0, to: 1 }, "x\ny\nz\n"))).toBe("x\r\ny\r\nz\r\n\r\nc\r\n");
  });
  it("keeps a missing final newline missing", () => {
    expect(joinLines(replaceRange(splitLines("a\n\nb"), { from: 2, to: 2 }, "B2\nB3"))).toBe("a\n\nB2\nB3");
  });
});
