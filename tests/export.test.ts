import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadBook } from "../core/config.ts";
import { buildEpub, exportHtml } from "../core/export.ts";
import { zip } from "../core/zip.ts";

const have = (cmd: string) => spawnSync("which", [cmd]).status === 0;

function makeBook(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bs-exp-")));
  fs.writeFileSync(path.join(dir, "book.yaml"), 'title: "Test & Book"\nauthor: "A <Writer>"\nknown: [03-known.md]\n');
  fs.mkdirSync(path.join(dir, "chapters"));
  fs.mkdirSync(path.join(dir, "images"));
  fs.writeFileSync(path.join(dir, "images", "p.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mNk+M9Qz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC", "base64"));
  fs.writeFileSync(path.join(dir, "chapters", "01-a.md"), "# Chapter 1 - Alpha & Omega\n\nSee [the next](02-b.md) and [web](https://example.org).\n\n```python\nx = 1 < 2\n```\n\n![A picture](../images/p.png)\n\nLine one  \nLine two[^1]\n\n[^1]: A note.\n");
  fs.writeFileSync(path.join(dir, "chapters", "02-b.md"), "# Chapter 2 - Beta\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nBack to [one](01-a.md).\n");
  fs.writeFileSync(path.join(dir, "chapters", "03-known.md"), "# Chapter 3 - Known\n\nNot in the book.\n");
  return dir;
}

describe("zip", () => {
  it("writes a file that unzip accepts, with the mimetype first and stored", () => {
    if (!have("unzip")) return;
    const f = path.join(os.tmpdir(), `bs-zip-${process.pid}.zip`);
    fs.writeFileSync(f, zip([{ name: "mimetype", data: Buffer.from("application/epub+zip"), store: true }, { name: "a/b.txt", data: Buffer.from("hello ".repeat(500)) }, { name: "é.txt", data: Buffer.from("x") }]));
    expect(execFileSync("unzip", ["-t", f]).toString()).toMatch(/No errors detected/);
    expect(execFileSync("unzip", ["-p", f, "a/b.txt"]).toString()).toBe("hello ".repeat(500));
    expect(execFileSync("unzip", ["-Z1", f]).toString().split("\n")[0]).toBe("mimetype");
    fs.rmSync(f);
  });
});

describe("EPUB", () => {
  const book = loadBook(makeBook());
  const epub = path.join(os.tmpdir(), `bs-${process.pid}.epub`);
  fs.writeFileSync(epub, buildEpub(book));
  const read = (name: string) => execFileSync("unzip", ["-p", epub, name]).toString();
  it("is a well-formed zip with the parts an e-reader needs", () => {
    if (!have("unzip")) return;
    expect(execFileSync("unzip", ["-t", epub]).toString()).toMatch(/No errors detected/);
    const names = execFileSync("unzip", ["-Z1", epub]).toString().split("\n").filter(Boolean);
    expect(names[0]).toBe("mimetype");
    expect(names).toEqual(expect.arrayContaining(["META-INF/container.xml", "OEBPS/content.opf", "OEBPS/nav.xhtml", "OEBPS/style.css", "OEBPS/title.xhtml"]));
    expect(names.filter((n) => n.startsWith("OEBPS/images/")).length).toBe(1);
  });
  it("leaves out known chapters and points links at chapter files", () => {
    if (!have("unzip")) return;
    const opf = read("OEBPS/content.opf");
    expect(opf).toContain("Test &amp; Book");
    expect(opf).toContain("A &lt;Writer&gt;");
    expect(opf).not.toMatch(/known/i);
    const one = read("OEBPS/ch-01-a.xhtml");
    expect(one).toMatch(/href="[^"#]*02-b[^"#]*\.xhtml"/);
  });
  it("is well-formed XML throughout", () => {
    if (!have("unzip") || !have("xmllint")) return;
    for (const n of ["META-INF/container.xml", "OEBPS/content.opf", "OEBPS/nav.xhtml", "OEBPS/toc.ncx", "OEBPS/title.xhtml"]) {
      expect(spawnSync("xmllint", ["--noout", "-"], { input: read(n) }).status, n).toBe(0);
    }
    const names = execFileSync("unzip", ["-Z1", epub]).toString().split("\n").filter((n) => n.endsWith(".xhtml"));
    for (const n of names) expect(spawnSync("xmllint", ["--noout", "-"], { input: read(n) }).status, n).toBe(0);
  });
});

describe("single-file HTML", () => {
  it("has everything inside: fonts, pictures, chapters, and not the known one", () => {
    const dir = makeBook();
    const out = path.join(dir, "build", "book.html");
    fs.mkdirSync(path.dirname(out));
    const r = exportHtml(loadBook(dir), out);
    expect(r.chapters).toBe(2);
    const html = fs.readFileSync(out, "utf8");
    expect(html).toContain("data:font/ttf;base64,");
    expect(html).toContain('src="data:image/png;base64,');
    expect(html).toContain("Alpha &amp; Omega");
    expect(html).not.toContain("Not in the book");
    expect(html).not.toMatch(/https?:\/\/[^"'\s]*\.(png|ttf)/);
  });
});
