import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addTerm, loadBook, setKnown, setPageBudget, renameKnown } from "../core/config.ts";
import { selectChapters } from "../core/book.ts";
import { checkText, proseOnly } from "../core/writing-rules.ts";

const none = { rules: [], terms: [] };

describe("prose only", () => {
  it("blanks code, notes and link targets but keeps positions", () => {
    const text = "a `code` b\n```py\nx = 1\n```\nc <!-- Q: hi -->\n[t](http://x.org)";
    const p = proseOnly(text);
    expect(p.length).toBe(text.length);
    expect(p).not.toContain("x = 1");
    expect(p).not.toContain("Q: hi");
    expect(p).not.toContain("http");
    expect(p.split("\n").length).toBe(text.split("\n").length);
  });
});

describe("rules", () => {
  const rules = [
    { forbid: "C#", regex: false, message: "no C# in this book" },
    { forbid: "^Remember:", regex: true, message: "no Remember sections" },
  ];
  it("finds forbidden words with their place, ignoring code and notes", () => {
    const text = "One line.\nUse c# here.\nRemember: this\n`C#` in code is fine\n<!-- E: drop C# -->\n";
    const hints = checkText(text, { rules, terms: [] });
    expect(hints.map((h) => [h.line, h.column, h.text, h.message])).toEqual([
      [1, 4, "c#", "no C# in this book"],
      [2, 0, "Remember:", "no Remember sections"],
    ]);
  });
});

describe("acronyms", () => {
  it("flags one used twice without being explained, once, at its first use", () => {
    const hints = checkText("We use RAG here.\n\nLater RAG again.\n", none);
    expect(hints.length).toBe(1);
    expect(hints[0]).toMatchObject({ line: 0, text: "RAG", kind: "term" });
  });
  it("accepts an explanation at the first use", () => {
    expect(checkText("Retrieval-augmented generation (RAG) is used. RAG again.", none)).toEqual([]);
    expect(checkText("RAG (retrieval-augmented generation) is used. RAG again.", none)).toEqual([]);
    expect(checkText("RAG stands for it. RAG again.", none)).toEqual([]);
    expect(checkText("**RAG** is it. RAG again.", none)).toEqual([]);
  });
  it("does not ask again in later chapters, nor for common ones or the author's own terms", () => {
    expect(checkText("RAG and RAG.", none, "Earlier chapter used RAG.")).toEqual([]);
    expect(checkText("PDF and PDF, HTML and HTML.", none)).toEqual([]);
    expect(checkText("MCP and MCP.", { rules: [], terms: ["mcp"] })).toEqual([]);
  });
  it("ignores a single use, numerals and shouting", () => {
    expect(checkText("Only RAG once.", none)).toEqual([]);
    expect(checkText("Part II and Part II again", none)).toEqual([]);
    expect(checkText("THIS IS A HEADING IN CAPITALS\nTHIS IS A HEADING IN CAPITALS", none)).toEqual([]);
  });
});

describe("book.yaml settings", () => {
  const make = (yaml: string) => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bs-set-")));
    fs.writeFileSync(path.join(dir, "book.yaml"), yaml);
    fs.mkdirSync(path.join(dir, "chapters"));
    for (const n of ["01-a.md", "02-b.md", "03-c.md"]) fs.writeFileSync(path.join(dir, "chapters", n), `# ${n}\n`);
    return dir;
  };
  it("reads pages, known, rules and terms", () => {
    const b = loadBook(make('title: T\npages: 126\nknown: [02-b.md]\nterms: [MCP]\nrules:\n  - "C#"\n  - forbid: "^Remember"\n    regex: true\n    message: no\n'));
    expect(b.pages).toBe(126);
    expect(b.known).toEqual(["02-b.md"]);
    expect(b.terms).toEqual(["MCP"]);
    expect(b.rules.map((r) => [r.forbid, r.regex, r.message])).toEqual([["C#", false, '"C#" is not allowed in this book'], ["^Remember", true, "no"]]);
  });
  it("rejects bad values", () => {
    expect(() => loadBook(make("title: T\npages: lots\n"))).toThrow(/pages/);
    expect(() => loadBook(make("title: T\nrules:\n  - forbid: '('\n    regex: true\n"))).toThrow(/pattern/);
    expect(() => loadBook(make("title: T\nknown: 3\n"))).toThrow(/known/);
  });
  it("changes settings and keeps the comments", () => {
    const dir = make('# my comment\ntitle: T   # trailing\n');
    setPageBudget(loadBook(dir), 126);
    setKnown(loadBook(dir), "/x/chapters/02-b.md", true);
    const text = fs.readFileSync(path.join(dir, "book.yaml"), "utf8");
    expect(text).toContain("# my comment");
    expect(text).toContain("# trailing");
    const b = loadBook(dir);
    expect([b.pages, b.known]).toEqual([126, ["02-b.md"]]);
    setKnown(b, "02-b.md", false);
    setPageBudget(loadBook(dir), null);
    expect(loadBook(dir)).toMatchObject({ pages: null, known: [] });
  });
  it("leaves known chapters out of the book, unless they are asked for by name", () => {
    const b = loadBook(make("title: T\nknown: [02-b.md]\n"));
    expect(selectChapters(b).map((f) => path.basename(f))).toEqual(["01-a.md", "03-c.md"]);
    expect(selectChapters(b, ["2"]).map((f) => path.basename(f))).toEqual(["02-b.md"]);
  });
  it("keeps known names right when a chapter is renamed", () => {
    const dir = make("title: T\nknown: [02-b.md]\n");
    renameKnown(loadBook(dir), new Map([["02-b.md", "02-new.md"]]));
    expect(loadBook(dir).known).toEqual(["02-new.md"]);
  });
  it("remembers a term once, whatever its case", () => {
    const dir = make("title: T\n");
    addTerm(loadBook(dir), "MCP");
    addTerm(loadBook(dir), "mcp");
    addTerm(loadBook(dir), "RAG");
    expect(loadBook(dir).terms).toEqual(["MCP", "RAG"]);
  });
  it("never creates a book.yaml", () => {
    const dir = make("title: T\n");
    const b = loadBook(dir);
    fs.rmSync(path.join(dir, "book.yaml"));
    expect(() => setPageBudget(b, 5)).toThrow();
    expect(fs.existsSync(path.join(dir, "book.yaml"))).toBe(false);
  });
});
