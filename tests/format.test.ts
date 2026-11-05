import { describe, expect, it } from "vitest";
import { applyEdit, formatEdit, type FormatCommand } from "../core/format.ts";

const run = (cmd: FormatCommand, text: string, from: number, to = from) => {
  const e = formatEdit(cmd, text, from, to);
  return { text: applyEdit(text, e), sel: e.select };
};

describe("inline marks", () => {
  it("wraps a selection and keeps it selected", () => {
    const r = run("bold", "a big idea", 2, 5);
    expect(r.text).toBe("a **big** idea");
    expect(r.text.slice(r.sel.from, r.sel.to)).toBe("big");
  });
  it("takes the marks off again", () => {
    expect(run("bold", "a **big** idea", 4, 7).text).toBe("a big idea");
    expect(run("bold", "a **big** idea", 2, 9).text).toBe("a big idea");
  });
  it("uses the word under the cursor", () => {
    expect(run("italic", "a big idea", 4).text).toBe("a *big* idea");
  });
  it("leaves a pair of marks with the cursor between when there is no word", () => {
    const r = run("code", "a  b", 2);
    expect(r.text).toBe("a `` b");
    expect(r.sel.from).toBe(3);
  });
  it("keeps spaces outside the marks", () => {
    expect(run("bold", "a big idea", 1, 6).text).toBe("a **big** idea");
  });
  it("does not mistake bold for italic", () => {
    expect(run("italic", "a **big** idea", 4, 7).text).toBe("a ***big*** idea");
  });
});

describe("headings", () => {
  it("sets, switches and removes a heading", () => {
    expect(run("h2", "Title\n\ntext", 2).text).toBe("## Title\n\ntext");
    expect(run("h3", "## Title", 4).text).toBe("### Title");
    expect(run("h2", "## Title", 4).text).toBe("Title");
  });
});

describe("lists and quotes", () => {
  const t = "one\ntwo\nthree";
  it("makes bullets of the lines touched, and undoes it", () => {
    const r = run("bullets", t, 0, 7);
    expect(r.text).toBe("- one\n- two\nthree");
    expect(run("bullets", r.text, 0, 11).text).toBe(t);
  });
  it("numbers lines and replaces other markers", () => {
    expect(run("numbers", "- a\n- b", 0, 7).text).toBe("1. a\n2. b");
  });
  it("quotes", () => {
    expect(run("quote", "a\nb", 0, 3).text).toBe("> a\n> b");
  });
  it("skips blank lines", () => {
    expect(run("bullets", "a\n\nb", 0, 4).text).toBe("- a\n\n- b");
  });
});

describe("links and tables", () => {
  it("makes a link of the selection and selects the address", () => {
    const r = run("link", "see docs now", 4, 8);
    expect(r.text).toBe("see [docs](url) now");
    expect(r.text.slice(r.sel.from, r.sel.to)).toBe("url");
  });
  it("turns a pasted address into a link", () => {
    expect(run("link", "https://a.org", 0, 13).text).toBe("[link text](https://a.org)");
  });
  it("inserts a table after the current paragraph", () => {
    const r = run("table", "text", 2);
    expect(r.text).toBe("text\n\n| Column | Column |\n| --- | --- |\n|  |  |\n");
    expect(r.text.slice(r.sel.from, r.sel.to)).toBe("Column");
  });
});
