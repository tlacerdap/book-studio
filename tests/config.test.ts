import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ConfigError, isBook, loadBook, writeDefaultBookYaml } from "../core/config.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bs-config-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function bookWith(yaml: string | null): string {
  const dir = fs.mkdtempSync(path.join(tmp, "b-"));
  if (yaml !== null) fs.writeFileSync(path.join(dir, "book.yaml"), yaml);
  return dir;
}

// Each case is run through both loaders. Where the TypeScript loader accepts, the Python one must too, with the same values.
const CASES: Record<string, string> = {
  full: `title: AI Engineer Field Guide\nsubtitle: From Basics to Production\nauthor: Tabaré Lacerda\ndate: November 1, 2026\nlanguage: en\nchapters: chapters/*.md\noutput: ai-engineer-field-guide\nindex: INDEX.md\n`,
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
    expect(b).toMatchObject({ title: "AI Engineer Field Guide", subtitle: "From Basics to Production", author: "Tabaré Lacerda", date: "November 1, 2026", language: "en", chapters: "chapters/*.md", output: "ai-engineer-field-guide", index: "INDEX.md" });
  });

  it("fills in defaults", () => {
    expect(loadBook(bookWith(CASES["title only"]))).toMatchObject({ subtitle: "", author: "", date: "", language: "en", chapters: "chapters/*.md", output: "book", index: null });
  });

  it("rejects unknown keys, naming them all, sorted", () => {
    expect(() => loadBook(bookWith(CASES["two unknown keys"]))).toThrow(/unknown setting\(s\) alpha, zeta\. Known: title, subtitle, author, date, language, chapters, output, index\./);
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
    writeDefaultBookYaml(dir);
    expect(loadBook(dir)).toMatchObject({ title: "My New Book", chapters: "chapters/*.md", output: "my-new_book" });
    expect(() => writeDefaultBookYaml(dir)).toThrow(/already exists/);
    const flat = path.join(tmp, "flat");
    fs.mkdirSync(flat);
    writeDefaultBookYaml(flat, 'A "quoted": title');
    expect(loadBook(flat)).toMatchObject({ title: 'A "quoted": title', chapters: "*.md" });
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

describe("book.yaml: the TypeScript and Python loaders agree", () => {
  const py = spawnSync("uv", ["--version"], { encoding: "utf8" });
  const available = py.status === 0 && fs.existsSync(path.resolve("bookcore/config.py"));

  it.skipIf(!available)("accepts and rejects the same files, with the same values and messages", () => {
    const dirs: Record<string, string> = {};
    for (const [name, yaml] of Object.entries(CASES)) dirs[name] = bookWith(yaml);
    const script = `
import json, sys
from bookcore import load_book, ConfigError
out = {}
for name, d in json.loads(sys.argv[1]).items():
    try:
        b = load_book(d)
        out[name] = {"ok": True, "v": {k: getattr(b, k) for k in ["title","subtitle","author","date","language","chapters","output","index"]}}
    except ConfigError as e:
        out[name] = {"ok": False, "msg": str(e)}
print(json.dumps(out))`;
    const run = spawnSync("uv", ["run", "--project", path.resolve("."), "python", "-c", script, JSON.stringify(dirs)], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    const python = JSON.parse(run.stdout.trim().split("\n").pop()!) as Record<string, { ok: boolean; v?: Record<string, string | null>; msg?: string }>;
    for (const [name, dir] of Object.entries(dirs)) {
      let ts: { ok: true; v: Record<string, unknown> } | { ok: false; msg: string };
      try {
        const b = loadBook(dir);
        ts = { ok: true, v: { title: b.title, subtitle: b.subtitle, author: b.author, date: b.date, language: b.language, chapters: b.chapters, output: b.output, index: b.index } };
      } catch (e) {
        ts = { ok: false, msg: (e as Error).message };
      }
      const p = python[name];
      expect(ts.ok, `${name}: accepted by both or rejected by both`).toBe(p.ok);
      if (ts.ok) expect(ts.v, name).toEqual(p.v);
      else {
        // The two YAML parsers word their syntax errors differently; every other message must match exactly.
        const norm = (m: string) => m.replaceAll(dir, "<dir>").replace(/(is not valid YAML:)[\s\S]*/, "$1");
        expect(norm(ts.msg), name).toBe(norm(p.msg!));
      }
    }
  });
});
