import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runChecks } from "../core/check.ts";
import { loadBook, type BookConfig } from "../core/config.ts";
import { lintChapter } from "../core/lint.ts";
import { buildPdf } from "../core/pdf.ts";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "bs-engine-"));
afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

// Deterministic prose: sentences of varying length, so paragraphs run to different numbers of lines and page breaks
// land in awkward places.
const WORDS = "model prompt token context window latency cache retrieval agent tool call schema output eval judge trace cost budget queue retry limit vector index chunk rank".split(" ");
function sentence(seed: number, len: number): string {
  const w = Array.from({ length: len }, (_, i) => WORDS[(seed * 7 + i * 5 + (i * i) % 11) % WORDS.length]);
  return w[0][0].toUpperCase() + w[0].slice(1) + " " + w.slice(1).join(" ") + ".";
}
function paragraph(seed: number): string {
  const n = 1 + (seed % 5);
  return Array.from({ length: n }, (_, i) => sentence(seed + i * 3, 9 + ((seed + i) % 14))).join(" ");
}
function chapter(n: number): string {
  const out = [`# Chapter ${n} - Generated chapter ${n}`, "", "Level: [B] | Priority: [Core]", ""];
  for (let s = 0; s < 14; s++) {
    out.push(`## Section ${n}.${s}`, "", paragraph(n * 31 + s * 3), "");
    out.push(`### Detail ${n}.${s}`, "", paragraph(n * 17 + s * 5 + 1), "", paragraph(n * 13 + s * 11 + 2), "");
    if (s % 3 === 0) out.push("Items to remember:", "", ...[1, 2, 3, 4].map((i) => `- ${sentence(s + i + n, 7 + i)}`), "");
    if (s % 4 === 1) out.push("```python", ...Array.from({ length: 6 + s }, (_, i) => `value_${i} = compute(${i}, "${WORDS[(i + s) % WORDS.length]}")`), "```", "");
  }
  return out.join("\n");
}

let book: BookConfig;
let good: string;
let bad: string;

beforeAll(async () => {
  const dir = path.join(work, "book");
  fs.mkdirSync(path.join(dir, "chapters"), { recursive: true });
  fs.writeFileSync(path.join(dir, "book.yaml"), 'title: "Generated"\nsubtitle: Test book\nauthor: Nobody\noutput: gen\n');
  fs.writeFileSync(path.join(work, "wrong.css"), '.toc-list a::after { content: "999"; }\n');
  for (const n of [1, 2, 3]) fs.writeFileSync(path.join(dir, "chapters", `0${n}-ch0${n}-generated.md`), chapter(n));
  book = loadBook(dir);
  good = path.join(work, "good.pdf");
  bad = path.join(work, "bad.pdf");
  await buildPdf(book, { out: good });
  await buildPdf(book, { out: bad, noRules: true });
}, 240_000);

describe("the engine and its checker", () => {
  it("lays the generated book out without breaking any rule", async () => {
    const r = await runChecks(good, book, { noRaster: true });
    expect(r.problemLines).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.bodyPages).toBeGreaterThan(15);
  }, 120_000);

  it("catches a planted widow or orphan and a stranded heading when the rules are switched off", async () => {
    const r = await runChecks(bad, book, { noRaster: true });
    const failed = (needle: string) => r.results.find((x) => x.title.includes(needle))!.problems;
    expect(failed("paragraph lines").length, "widows and orphans").toBeGreaterThan(0);
    expect(failed("page ends with a heading").length, "stranded headings").toBeGreaterThan(0);
    expect(r.ok).toBe(false);
  }, 120_000);

  it("checks the monochrome and ink rules on the pages it builds", async () => {
    const r = await runChecks(good, book);
    const mono = r.results.find((x) => x.title.includes("monochrome"))!;
    expect(mono.status).toBe("pass");
    expect(r.inkMedian).toBeGreaterThan(0.01);
    expect(r.inkMedian).toBeLessThan(0.08);
  }, 180_000);

  it("verifies every contents entry against the real chapter start pages", async () => {
    const r = await runChecks(good, book, { noRaster: true });
    const toc = r.results.find((x) => x.title.includes("contents"))!;
    expect(toc.status).toBe("pass");
    expect(toc.note).toMatch(/^3 of 3 contents entries verified/);
  }, 120_000);

  it("fails a wrong contents number (the checker is not blind to it)", async () => {
    const wrong = path.join(work, "wrong-toc.pdf");
    await buildPdf(book, { out: wrong, extraCss: [path.join(work, "wrong.css")] });
    const r = await runChecks(wrong, book, { noRaster: true, extraCss: [path.join(work, "wrong.css")] });
    expect(r.results.find((x) => x.title.includes("contents"))!.status).toBe("fail");
  }, 120_000);
});

describe("chapter lint", () => {
  const planned = new Set(["01-ch01-x.md"]);
  const good = (): string => {
    const para = Array.from({ length: 2000 }, () => "word").join(" ");
    return ["# Chapter 1 - X", "", "Level: [B] | Priority: [Core]", "", "## Why this matters", para, "## Core concepts", "## In practice", "## Common mistakes", "## Interview angle", "- **Q:** one", "- **Q:** two", "## Key takeaways", "- a", "## Go deeper", ""].join("\n");
  };
  it("accepts a chapter that follows the template", () => expect(lintChapter(good(), planned)).toEqual([]));
  it("reports dashes, tables, wrong headings and banned terms", () => {
    const t = good().replace("## In practice\n", "## Practice\n") + "\nA \u2014 dash.\n| a | b |\nUse Langchain.\n";
    const p = lintChapter(t, planned).join("\n");
    expect(p).toMatch(/1 em dash/);
    expect(p).toMatch(/markdown table/);
    expect(p).toMatch(/H2 headings\/order wrong/);
    expect(p).toMatch(/Langchain/);
  });
});

import { locateProblems } from "../core/print.ts";
import type { CheckReport } from "../core/check.ts";

describe("print report: which chapter a problem belongs to", () => {
  const report = {
    bookmarks: [
      { title: "First chapter", page: 4 },
      { title: "Second chapter", page: 20 },
    ],
    results: [
      { title: "a check", status: "fail", note: "", problems: ["page 25 (printed 22): heading 'X' has only 2 line(s) after it", "colour found on page(s) 5, 30", "pages 21-22: code split 12 + 2 lines", "contents entry 'Second chapter' has no matching bookmark", "01-first.md: 'some line' is missing", "nothing to locate here"] },
      { title: "fine", status: "pass", note: "", problems: [] },
    ],
  } as unknown as CheckReport;
  const chapters = [
    { file: "01-first.md", title: "First chapter" },
    { file: "02-second.md", title: "Second chapter" },
  ];

  it("uses the page, a quoted chapter title or a file name", () => {
    const got = locateProblems(report, chapters).map((p) => [p.chapter, p.page]);
    expect(got).toEqual([
      ["02-second.md", 25],
      ["01-first.md", 5],
      ["02-second.md", 21],
      ["02-second.md", null],
      ["01-first.md", null],
      [null, null],
    ]);
  });

  it("ignores checks that passed", () => {
    expect(locateProblems(report, chapters).every((p) => p.check === "a check")).toBe(true);
  });
});

import { tableWordsMissing } from "../core/check.ts";

describe("table cell words in the printed text", () => {
  // A narrow table: the lines of its cells come out interleaved, with words broken at line ends.
  const printed = "everyNameexplaDescriptionthingfixedcostlyWhenIsdoneEmbeddingmodel".replace(/[^A-Za-z0-9]/g, "");
  it("accepts words broken across lines or by ligatures", () => {
    expect(tableWordsMissing("everything is fixed", printed)).toEqual([]);
    expect(tableWordsMissing("explanation", printed)).toEqual([]); // 'expla' and the end are both there
  });
  it("finds a word that was lost", () => {
    expect(tableWordsMissing("embedding quarantine", printed)).toEqual(["quarantine"]);
  });
  it("skips short words and punctuation", () => {
    expect(tableWordsMissing("a to of, it", printed)).toEqual([]);
  });
});
