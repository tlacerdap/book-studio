import { describe, expect, it } from "vitest";
import { chapterId, highlightCode, makeMarkdown, splitHighlightedLines } from "../core/mdrender.ts";
import { stripNotes } from "../core/notes.ts";

const render = (src: string, built: string[] = ["01-ch01-x.md"]) => makeMarkdown(new Set(built)).render(stripNotes(src).text);

describe("typography", () => {
  it("curls quotes and apostrophes and turns three dots into an ellipsis", () => {
    expect(render(`He said "it's fine" and 'quoted'... Done.`)).toContain("He said “it’s fine” and ‘quoted’… Done.");
  });

  it("leaves hyphens exactly as written: -- and --- are never turned into dashes", () => {
    const html = render("a -- b --- c - d 2-4 and `x--y`");
    expect(html).toContain("a -- b --- c - d 2-4");
    expect(html).toContain("<code>x--y</code>");
    expect(html).not.toMatch(/[–—]/);
  });

  it("leaves code alone", () => {
    expect(render('`"keep"` and ...')).toContain("<code>&quot;keep&quot;</code>");
  });

  it("swallows front matter", () => {
    expect(render("---\ntitle: x\n---\nBody\n")).toBe("<p>Body</p>\n");
  });
});

describe("links and URLs", () => {
  it("turns a link to a chapter in this build into an in-document link, and to a chapter that is not into plain text", () => {
    const html = render("See [Chapter 1](01-ch01-x.md) and [Chapter 2](02-ch02-y.md) and [site](https://example.com/a).");
    expect(html).toContain(`<a href="#${chapterId("01-ch01-x.md")}" class="xref">Chapter 1</a>`);
    expect(html).toContain("and Chapter 2 and");
    expect(html).toContain('<a href="https://example.com/a" class="ext">site</a>');
  });

  it("wraps a bare URL so it can break, including the first URL in a run of text (regression)", () => {
    const html = render("Read https://example.com/a-very-long/path-here for more, or https://other.example/x.");
    expect(html.match(/<span class="url">/g)).toHaveLength(2);
    // soft breaks after single slashes only; the text itself is unchanged
    expect(html).toContain('<span class="url">https://<wbr>example.com/<wbr>a-very-long/<wbr>path-here</span> for more');
    expect(html).toContain('<span class="url">https://<wbr>other.example/<wbr>x</span>.');
    expect(html.replace(/<[^>]+>/g, "")).toContain("https://example.com/a-very-long/path-here for more");
  });

  it("prints the address of an external link as real text that can wrap at slashes", () => {
    const html = render("See [the docs](https://example.com/docs/page) now.");
    expect(html).toContain('<a href="https://example.com/docs/page" class="ext">the docs</a>');
    expect(html).toContain('<span class="ext-url"> (https://<wbr>example.com/<wbr>docs/<wbr>page)</span>');
  });

  it("does not print an address for a link to another chapter", () => {
    expect(render("See [ch](01-intro.md).")).not.toContain("ext-url");
  });

  it("does not double-wrap a URL that is a link", () => {
    expect(render("[https://example.com](https://example.com)")).not.toContain('class="url"');
  });
});

describe("page-break hints", () => {
  it("flags the sentence that introduces a list, and a code block", () => {
    expect(render("Intro:\n\n- a\n- b\n")).toContain('<p class="lead-in">Intro:</p>');
    expect(render("Run this:\n\n```bash\nls\n```\n")).toContain('<p class="lead-in">Run this:</p>');
    expect(render("Plain.\n\n- a\n")).toContain('<p class="lead-in">Plain.</p>'); // directly before a list
    expect(render("Plain.\n\nNext paragraph.\n")).not.toContain("lead-in");
  });

  it("keeps a short paragraph after a heading with what follows it", () => {
    expect(render("## Head\n\nShort.\n\nMore text here.\n")).toContain('<p class="lead-in">Short.</p>');
    expect(render(`## Head\n\n${"Long sentence here. ".repeat(14)}\n`)).not.toContain("lead-in");
  });

  it("flags the list item and list when the introduction is the last paragraph of an item and code follows the list", () => {
    const html = render("- item\n- last item that ends with a colon:\n\n```text\nx\n```\n");
    expect(html).toContain('<li class="lead-in">last item');
    expect(html).toContain('<ul class="lead-in">');
  });
});

describe("code blocks", () => {
  it("renders one block element per source line, blank lines included", () => {
    const html = render("```python\nimport os\n\n\nx = 1\n```\n");
    expect(html.match(/<span class="cl">/g)).toHaveLength(4);
    expect(html).toContain('<span class="cl"> </span>');
  });

  it("splits highlighted spans that run across lines and keeps them balanced", () => {
    const lines = splitHighlightedLines(highlightCode('x = """a\nb\nc"""', "python"));
    expect(lines).toHaveLength(3);
    for (const l of lines) expect((l.match(/<span/g) ?? []).length).toBe((l.match(/<\/span>/g) ?? []).length);
  });

  it("keeps the space between two highlighted words", () => {
    const html = render("```python\nasync def f(): ...\n```\n");
    expect(html.replace(/<[^>]+>/g, "")).toContain("async def f(): ...");
  });

  it("classes a block short or long by its visible lines, and counts wrapped lines", () => {
    expect(render("```text\n" + "a\n".repeat(15) + "```\n")).toContain("code-short");
    expect(render("```text\n" + "a\n".repeat(16) + "```\n")).toContain("code-long");
    expect(render("```text\n" + "x".repeat(200) + "\n" + "a\n".repeat(13) + "```\n")).toContain("code-long"); // 3 wrapped + 13 = 16
  });

  it("marks a one or two line block as belonging with the sentence before it", () => {
    expect(render("```bash\nuv add x\n```\n")).toContain("code-short lead-in");
    expect(render("```bash\na\nb\nc\n```\n")).not.toContain("lead-in");
  });

  it("does not highlight an unknown language or plain text", () => {
    expect(render("```text\n<b>&</b>\n```\n")).toContain("&lt;b&gt;&amp;&lt;/b&gt;");
    expect(render("```nonsense\nx\n```\n")).toContain('data-lang="nonsense"');
  });
});

describe("notes never reach the page", () => {
  it("drops note comments in both syntaxes, and keeps real HTML in code", () => {
    const html = render("Para\n<!-- Q: hidden -->\n%%E: hidden too%%\n\n```html\n<!-- Q: kept, it is code -->\n```\n");
    expect(html).not.toContain("hidden");
    expect(html).toContain("kept, it is code");
  });
});
