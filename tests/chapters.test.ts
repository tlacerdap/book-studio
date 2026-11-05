import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createChapter, linksTo, moveChapter, nextName, renameChapter, slugOf } from "../core/chapters.ts";
import { chapterFiles, loadBook, type BookConfig } from "../core/config.ts";
import { firstDifference, lineDiff, listSnapshots, readSnapshot, snapshot } from "../core/history.ts";

let dir: string;
let book: BookConfig;

const write = (name: string, text: string) => {
  fs.mkdirSync(path.join(dir, "chapters"), { recursive: true });
  fs.writeFileSync(path.join(dir, "chapters", name), text);
};
const read = (name: string) => fs.readFileSync(path.join(dir, "chapters", name), "utf8");

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bs-ch-")));
  fs.writeFileSync(path.join(dir, "book.yaml"), 'title: "T"\n');
  write("00-intro.md", "# Chapter 0 - Intro\n\nSee [next](01-python.md) and [last](02-web.md).\n");
  write("01-python.md", "# Chapter 1 - Python\n\nBack to [intro](00-intro.md).\n");
  write("02-web.md", "# Chapter 2 - Web\n\nText.\n");
  book = loadBook(dir);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("chapter files", () => {
  it("makes slugs", () => {
    expect(slugOf("Python in plain words!")).toBe("python-in-plain-words");
    expect(slugOf("Café déjà vu")).toBe("cafe-deja-vu");
    expect(slugOf("???")).toBe("chapter");
  });

  it("creates a chapter after the highest number, with a numbered title", () => {
    const file = createChapter(book, "Vector search");
    expect(path.basename(file)).toBe("03-vector-search.md");
    expect(fs.readFileSync(file, "utf8")).toBe("# Chapter 3 - Vector search\n\n");
    expect(chapterFiles(loadBook(dir)).map((f) => path.basename(f))).toContain("03-vector-search.md");
  });

  it("refuses a taken number and an empty title", () => {
    expect(() => createChapter(book, "  ")).toThrow();
    expect(() => nextName(book, "x", 1)).toThrow(/already exists/);
  });

  it("renames after the number and fixes the links that point at it", () => {
    const file = renameChapter(book, path.join(dir, "chapters", "01-python.md"), "Python in plain words");
    expect(path.basename(file)).toBe("01-python-in-plain-words.md");
    expect(read("00-intro.md")).toContain("](01-python-in-plain-words.md)");
    expect(read("00-intro.md")).toContain("](02-web.md)");
  });

  it("moves a chapter down: numbers trade, headings follow, links follow", () => {
    const moved = moveChapter(book, path.join(dir, "chapters", "01-python.md"), 1);
    expect(path.basename(moved)).toBe("02-python.md");
    const names = chapterFiles(loadBook(dir)).map((f) => path.basename(f));
    expect(names).toEqual(["00-intro.md", "01-web.md", "02-python.md"]);
    expect(read("02-python.md").split("\n")[0]).toBe("# Chapter 2 - Python");
    expect(read("01-web.md").split("\n")[0]).toBe("# Chapter 1 - Web");
    expect(read("00-intro.md")).toContain("](02-python.md)");
    expect(read("00-intro.md")).toContain("](01-web.md)");
    expect(read("02-python.md")).toContain("](00-intro.md)");
  });

  it("does nothing at the ends", () => {
    const first = path.join(dir, "chapters", "00-intro.md");
    expect(moveChapter(book, first, -1)).toBe(first);
  });

  it("says which chapters link to one", () => {
    expect(linksTo(book, path.join(dir, "chapters", "01-python.md"))).toEqual(["00-intro.md"]);
    expect(linksTo(book, path.join(dir, "chapters", "02-web.md"))).toEqual(["00-intro.md"]);
  });
});

describe("history", () => {
  let store: string;
  const file = () => path.join(dir, "chapters", "01-python.md");
  beforeEach(() => {
    store = fs.mkdtempSync(path.join(os.tmpdir(), "bs-hist-"));
  });
  afterEach(() => fs.rmSync(store, { recursive: true, force: true }));

  it("keeps a version only when the text changed", () => {
    expect(snapshot(store, dir, file(), "one", 1000)).toBe(true);
    expect(snapshot(store, dir, file(), "one", 2000)).toBe(false);
    expect(snapshot(store, dir, file(), "two", 3_000_000)).toBe(true);
    const list = listSnapshots(store, dir, file());
    expect(list.map((s) => s.time)).toEqual([3_000_000, 1000]);
    expect(readSnapshot(store, dir, file(), list[1].id)).toBe("one");
  });

  it("folds quick saves into one version but never loses the first", () => {
    snapshot(store, dir, file(), "a", 1000);
    snapshot(store, dir, file(), "ab", 2000); // only one older version: kept as a second
    snapshot(store, dir, file(), "abc", 3000); // within the window of the last: replaces it
    const list = listSnapshots(store, dir, file());
    expect(list.length).toBe(2);
    expect(readSnapshot(store, dir, file(), list[0].id)).toBe("abc");
    expect(readSnapshot(store, dir, file(), list[1].id)).toBe("a");
  });

  it("rejects ids that are not snapshots", () => {
    expect(() => readSnapshot(store, dir, file(), "../../etc/passwd")).toThrow();
  });

  it("describes what changed", () => {
    expect(firstDifference("", "x")).toBe("first version");
    expect(firstDifference("# A\n\nold", "# A\n\nnew words")).toBe("new words");
  });

  it("diffs by line", () => {
    const d = lineDiff("a\nb\nc\nd", "a\nB\nc\nd\ne");
    expect(d.filter((x) => x.tag !== " ")).toEqual([
      { tag: "-", text: "b" },
      { tag: "+", text: "B" },
      { tag: "+", text: "e" },
    ]);
  });
});

import { collapseDiff, matches, paletteItems } from "../app/renderer/dialogs.ts";

describe("go to palette", () => {
  const chapters = [
    { path: "/b/01.md", label: "Chapter 1", title: "How the web and APIs work" },
    { path: "/b/02.md", label: "Chapter 2", title: "Python in plain words" },
  ];
  const items = paletteItems(chapters, [
    { file: "/b/01.md", headings: [{ level: 2, title: "How it works", line: 4 }] },
    { file: "/b/02.md", headings: [{ level: 2, title: "Decorators", line: 9 }] },
  ]);
  it("lists only chapters when nothing is typed", () => {
    expect(matches(items, "").map((i) => i.kind)).toEqual(["chapter", "chapter"]);
  });
  it("finds by words in any order, in titles only", () => {
    expect(matches(items, "web api").map((i) => i.title)).toEqual(["1  How the web and APIs work"]);
    expect(matches(items, "decor")[0].line).toBe(9);
    expect(matches(items, "zzz")).toEqual([]);
  });
});

describe("history view", () => {
  it("collapses long unchanged runs", () => {
    const lines = [...Array(10).fill({ tag: " ", text: "x" }), { tag: "+", text: "new" }, ...Array(10).fill({ tag: " ", text: "y" })] as { tag: "+" | "-" | " "; text: string }[];
    const out = collapseDiff(lines, 2);
    expect(out[0]).toEqual({ skipped: 8 });
    expect(out.filter((x) => "tag" in x).length).toBe(5);
    expect(out[out.length - 1]).toEqual({ skipped: 8 });
  });
});
