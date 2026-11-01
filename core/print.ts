// "Print PDF": build the book, check the result, and hand back what the app shows in its report panel.

import type { BookConfig } from "./config.ts";
import { runChecks, type CheckReport } from "./check.ts";
import { buildPdf, type PdfRenderer } from "./pdf.ts";

export type PrintStage = "preparing" | "laying-out" | "checking" | "done";

export interface PrintOptions {
  render?: PdfRenderer;
  /** Runs the checks; the app runs them off the main thread. */
  check?: (pdf: string, book: BookConfig) => Promise<CheckReport>;
  onProgress?: (stage: PrintStage) => void;
}

/** One line of the report panel, with the chapter it points at when it can be told. */
export interface Problem {
  check: string;
  text: string;
  /** File name of the chapter the problem is in, if known. */
  chapter: string | null;
  /** Page in the PDF (1-based), if the line names one. */
  page: number | null;
}

export interface PrintResult {
  pdf: string;
  pages: number;
  chapters: number;
  report: CheckReport;
}

const squash = (t: string): string => t.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();

/** Which chapter each problem line belongs to: a file it names, a chapter title it quotes, or the chapter that owns the PDF page it names. */
export function locateProblems(report: CheckReport, chapters: { file: string; title: string }[]): Problem[] {
  const starts = chapters
    .map((c) => ({ file: c.file, page: report.bookmarks.find((b) => squash(b.title) === squash(c.title))?.page ?? Infinity }))
    .filter((c) => c.page !== Infinity)
    .sort((a, b) => a.page - b.page);
  const out: Problem[] = [];
  for (const r of report.results) {
    if (r.status !== "fail" && r.status !== "warn") continue;
    for (const text of r.problems) {
      let chapter: string | null = null;
      const named = /(\d+-[\w.-]+\.md)/.exec(text);
      if (named) chapter = named[1];
      const pm = /\bpage(?:s|\(s\))? (\d+)/.exec(text);
      const page = pm ? parseInt(pm[1], 10) : null;
      if (!chapter) {
        const quoted = /'([^']+)'/.exec(text);
        const hit = quoted && chapters.find((c) => squash(c.title) === squash(quoted[1]));
        if (hit) chapter = hit.file;
      }
      if (!chapter && page !== null) {
        for (const s of starts) if (s.page <= page) chapter = s.file;
      }
      out.push({ check: r.title, text, chapter, page });
    }
  }
  return out;
}

export async function printBook(book: BookConfig, opts: PrintOptions = {}): Promise<PrintResult> {
  opts.onProgress?.("preparing");
  opts.onProgress?.("laying-out");
  const built = await buildPdf(book, { render: opts.render });
  opts.onProgress?.("checking");
  const report = await (opts.check ?? ((pdf, b) => runChecks(pdf, b)))(built.pdf, book);
  opts.onProgress?.("done");
  return { pdf: built.pdf, pages: built.pages, chapters: built.chapters, report };
}

