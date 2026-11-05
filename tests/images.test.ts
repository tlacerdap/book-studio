import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { imageMarkdown, imageName, sniffImage } from "../core/images.ts";
import { loadChapter } from "../core/book.ts";
import { makeMarkdown } from "../core/mdrender.ts";

describe("pictures", () => {
  it("recognises pictures by their first bytes", () => {
    expect(sniffImage(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2]))?.ext).toBe(".png");
    expect(sniffImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))?.mime).toBe("image/jpeg");
    expect(sniffImage(Uint8Array.from([0x47, 0x49, 0x46, 0x38]))?.ext).toBe(".gif");
    expect(sniffImage(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))?.ext).toBe(".webp");
    expect(sniffImage(Uint8Array.from([0x3c, 0x73, 0x76, 0x67]))).toBeNull();
    expect(sniffImage(new Uint8Array())).toBeNull();
  });
  it("names a picture after its chapter and writes an address relative to the chapter", () => {
    expect(imageName("/b/chapters/02-ch02-python-in-plain-words.md", "a1b2c3", ".png")).toBe("ch02-python-in-plain-a1b2c3.png");
    expect(imageName("/b/chapters/02-x.md", "a1b2c3", ".png", "My Diagram.png")).toBe("my-diagram-a1b2c3.png");
    expect(imageMarkdown("/b/chapters/02-x.md", "/b/images/p one.png", "alt")).toBe("![alt](../images/p%20one.png)");
  });
});

describe("pictures in a chapter", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bs-img-")));
  fs.mkdirSync(path.join(dir, "chapters"));
  const file = path.join(dir, "chapters", "01-a.md");
  fs.writeFileSync(file, "# Chapter 1 - A\n\nText.\n\n![A diagram](../images/d%20x.png)\n\nInline ![i](../images/i.png) here.\n\n![web](https://example.org/x.png)\n");
  const urls: string[] = [];
  const html = loadChapter(file, makeMarkdown(new Set()), undefined, (abs) => (urls.push(abs), `x://${path.relative(dir, abs)}`)).bodyHtml;
  it("resolves addresses against the chapter's folder, decoding them", () => {
    expect(urls).toEqual([path.join(dir, "images", "d x.png"), path.join(dir, "images", "i.png")]);
  });
  it("renders the picture and marks a lone one as a figure", () => {
    expect(html).toContain('<p class="figure"><img src="x://images/d x.png" alt="A diagram" /></p>');
    expect(html).toContain('Inline <img src="x://images/i.png" alt="i" /> here.');
  });
  it("never fetches a picture from the web", () => {
    expect(html).toContain("[image not found: https://example.org/x.png]");
    expect(html).not.toContain('src="https://');
  });
  it("adds no text when there is no chapter to resolve against", () => {
    expect(makeMarkdown(new Set()).render("a ![x](y.png) b")).toBe("<p>a  b</p>\n");
  });
});
