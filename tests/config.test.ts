import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { bookEvidence, ConfigError, isBook, loadBook, writeDefaultBookYaml } from "../core/config.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bs-config-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function bookWith(yaml: string | null): string {
  const dir = fs.mkdtempSync(path.join(tmp, "b-"));
  if (yaml !== null) fs.writeFileSync(path.join(dir, "book.yaml"), yaml);
  return dir;
}

// Each case is run through both loaders. Where the TypeScript loader accepts, the Python one must too, with the same values.
const CASES: Record<string, string> = {
  full: `title: Example Book\nsubtitle: A subtitle\nauthor: Jane Writer\ndate: November 1, 2026\nlanguage: en\nchapters: chapters/*.md\noutput: example-book\nindex: INDEX.md\n`,
  "title only": `title: Just a title\n`,
  "missing title": `subtitle: no title here\n`,
  "unknown key": `title: X\nautor: me\n`,
  "two unknown keys": `title: X\nzeta: 1\nalpha: 2\n`,
  "output with .pdf": `title: X\noutput: my-book.pdf\n`,
  "output with .PDF": `title: X\noutput: My-Book.PDF\n`,
  "output with slash": `title: X\noutput: a/b\n`,
  "empty output": `title: X\noutput: ""\n`,
  "only .pdf": `title: X\noutput: .pdf\n`,
  "empty file": ``,
  "a list": `- title\n- x\n`,
  "a scalar": `just text\n`,
  "bad yaml": `title: [unclosed\n`,
  "numeric title": `title: 123\n`,
  "iso date": `title: X\ndate: 2026-11-01\n`,
  "null values": `title: X\nsubtitle: ~\nchapters: ~\n`,
  "other glob": `title: X\nchapters: "docs/**/*.md"\n`,
  "language": `title: X\nlanguage: pl\n`,
  "trailing spaces in output": `title: X\noutput: "  spaced  "\n`,
};

describe("book.yaml", () => {
  it("loads a full file", () => {
    const b = loadBook(bookWith(CASES.full));
    expect(b).toMatchObject({ title: "Example Book", subtitle: "A subtitle", author: "Jane Writer", date: "November 1, 2026", language: "en", chapters: "chapters/*.md", output: "example-book", index: "INDEX.md" });
  });

  it("fills in defaults", () => {
    expect(loadBook(bookWith(CASES["title only"]))).toMatchObject({ subtitle: "", author: "", date: "", language: "en", chapters: "chapters/*.md", output: "book", index: null });
  });

  it("rejects unknown keys, naming them all, sorted", () => {
    expect(() => loadBook(bookWith(CASES["two unknown keys"]))).toThrow(/unknown setting\(s\) alpha, zeta\. Known: title, subtitle, author, date, language, chapters, output, index, pages, known, rules, terms\./);
  });

  it("says what is wrong in plain words", () => {
    expect(() => loadBook(bookWith(CASES["missing title"]))).toThrow(/`title` is required\./);
    expect(() => loadBook(bookWith(null))).toThrow(/is not a book: there is no book\.yaml in it\./);
    expect(() => loadBook(path.join(tmp, "nope"))).toThrow(/is not a folder\./);
    expect(() => loadBook(bookWith(CASES["a list"]))).toThrow(/must be a list of `key: value` settings\./);
    expect(() => loadBook(bookWith(CASES["output with slash"]))).toThrow(/`output` must be a plain file name/);
    expect(() => loadBook(bookWith(CASES["bad yaml"]))).toThrow(ConfigError);
  });

  it("recognises a book by its book.yaml", () => {
    expect(isBook(bookWith("title: X\n"))).toBe(true);
    expect(isBook(bookWith(null))).toBe(false);
  });

  it("writes a starter book.yaml that loads", () => {
    const dir = path.join(tmp, "my-new_book");
    fs.mkdirSync(path.join(dir, "chapters"), { recursive: true });
    fs.writeFileSync(path.join(dir, "chapters", "01-a.md"), "# One\n\nText.\n");
    writeDefaultBookYaml(dir);
    expect(loadBook(dir)).toMatchObject({ title: "My New Book", chapters: "chapters/*.md", output: "my-new_book" });
    expect(() => writeDefaultBookYaml(dir)).toThrow(/already exists/);
    const flat = path.join(tmp, "flat");
    fs.mkdirSync(flat);
    for (const f of ["01-a.md", "02-b.md"]) fs.writeFileSync(path.join(flat, f), "# Chapter\n");
    writeDefaultBookYaml(flat, 'A "quoted": title');
    expect(loadBook(flat)).toMatchObject({ title: 'A "quoted": title', chapters: "*.md" });
  });

  it("refuses to write a book.yaml where no book can be seen", () => {
    const md = (dir: string, name: string, text: string) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), text);
    };
    const empty = path.join(tmp, "empty");
    fs.mkdirSync(empty);
    const readme = path.join(tmp, "readme-only");
    md(readme, "README.md", "# A project\n");
    const notes = path.join(tmp, "notes");
    md(notes, "ideas.md", "# Ideas\n");
    md(notes, "todo.md", "# Todo\n");
    const noHeadings = path.join(tmp, "no-headings");
    md(path.join(noHeadings, "chapters"), "01-a.md", "just words, no heading\n");
    for (const dir of [empty, readme, notes, noHeadings]) {
      expect(bookEvidence(dir)).toEqual([]);
      expect(() => writeDefaultBookYaml(dir)).toThrow(/does not look like a book/);
      expect(fs.existsSync(path.join(dir, "book.yaml"))).toBe(false);
    }
    const oneNumbered = path.join(tmp, "one-numbered");
    md(oneNumbered, "01-a.md", "# One\n");
    expect(bookEvidence(oneNumbered)).toEqual([]);
    const real = path.join(tmp, "real");
    md(path.join(real, "chapters"), "01-a.md", "---\ntitle: x\n---\n# One\n");
    expect(bookEvidence(real)).toEqual(["chapters/01-a.md"]);
  });

  it("lists chapter files in file-name order", () => {
    const dir = bookWith("title: X\n");
    fs.mkdirSync(path.join(dir, "chapters"));
    for (const f of ["10-b.md", "02-a.md", "01-a.md", "notes.txt"]) fs.writeFileSync(path.join(dir, "chapters", f), "# x\n");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return import("../core/config.ts").then(({ chapterFiles }) => {
      expect(chapterFiles(loadBook(dir)).map((f) => path.basename(f))).toEqual(["01-a.md", "02-a.md", "10-b.md"]);
    });
  });
});
