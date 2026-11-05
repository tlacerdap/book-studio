// Build the book's PDF: assemble the HTML, paginate it with Paged.js in a hidden Electron window, print to PDF.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { outputPdf, type BookConfig } from "./config.ts";
import { readChapters, selectChapters } from "./book.ts";
import { buildHtml } from "./html.ts";
import { PACKAGE_ROOT, STYLES } from "./paths.ts";
import { forPaged, readCss, resolvePageVars, styleFiles } from "./style.ts";

export { forPaged };

export class BuildError extends Error {}

export interface BuildOptions {
  chapters?: string[];
  out?: string;
  htmlOut?: string;
  extraCss?: string[];
  /** Print the page console to stderr. */
  log?: boolean;
  /** Print a line per page (first and last block, where the next page starts). */
  trace?: boolean;
  /** Paginate without the widow/orphan/keep-with-next rules (test fixture for the checker). */
  noRules?: boolean;
  /** Report where a piece of text ended up in the paginated page (developer aid). */
  timeoutMs?: number;
  /** How the HTML becomes a PDF; the command line's default starts a headless Electron. */
  render?: PdfRenderer;
}

export interface BuildResult {
  pdf: string;
  pages: number;
  chapters: number;
  html?: string;
}

const CSP = "default-src 'none'; script-src file:; style-src 'unsafe-inline' file:; font-src file: data:; img-src file: data:";

function electronBinary(): string {
  // `electron` exports the path of its binary when required from node.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const p = require("electron") as unknown;
  if (typeof p !== "string") throw new BuildError("Electron is not installed. Run `npm install` in the book-studio folder.");
  return p;
}

/** The HTML document Paged.js paginates: the book plus the scripts that run the pagination. */
export function pagedHead(distBrowser: string): string {
  const u = (f: string) => pathToFileURL(path.join(distBrowser, f)).href;
  return `  <meta http-equiv="Content-Security-Policy" content="${CSP}">
  <base href="${pathToFileURL(STYLES + path.sep).href}">
  <script src="${u("paged-config.js")}"></script>
  <script src="${u("paged.polyfill.js")}"></script>
  <script src="${u("paged-driver.js")}"></script>
`;
}

export async function buildPdf(book: BookConfig, opts: BuildOptions = {}): Promise<BuildResult> {
  let files: string[];
  try {
    files = selectChapters(book, opts.chapters);
  } catch (e) {
    throw new BuildError(`--chapters: ${(e as Error).message}`);
  }
  if (!files.length) {
    throw new BuildError(book.known.length ? "every chapter is marked as known, so there is nothing to print. Unmark one first." : `no chapter files match \`chapters: ${book.chapters}\` in ${book.root}`);
  }
  let chapters;
  try {
    chapters = readChapters(book, files);
  } catch (e) {
    throw new BuildError((e as Error).message);
  }
  const distBrowser = path.join(PACKAGE_ROOT, "dist", "browser");
  if (!fs.existsSync(path.join(distBrowser, "paged-driver.js"))) throw new BuildError("book-studio is not built. Run `npm run build` in the book-studio folder.");
  const css = forPaged(resolvePageVars(readCss(styleFiles(book, opts.extraCss ?? [], { paged: true }), { absoluteUrls: true })));
  // The stylesheet is already converted; in the markup only the inline style the code-block renderer writes needs it.
  const html = buildHtml(book, chapters, css, { head: pagedHead(distBrowser) }).replace(/style="orphans:(\d+);widows:(\d+)"/g, 'style="--pg-orphans:$1;--pg-widows:$2"');

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "book-studio-"));
  const htmlFile = path.join(work, "book.html");
  fs.writeFileSync(htmlFile, html);
  if (opts.htmlOut) {
    fs.mkdirSync(path.dirname(opts.htmlOut), { recursive: true });
    fs.copyFileSync(htmlFile, opts.htmlOut);
  }
  const pdf = opts.out ? path.resolve(opts.out) : outputPdf(book);
  fs.mkdirSync(path.dirname(pdf), { recursive: true });

  const job: PdfJob = { html: htmlFile, out: pdf, timeoutMs: opts.timeoutMs ?? 600000, log: opts.log, trace: opts.trace, noRules: opts.noRules };
  let pages: number;
  try {
    pages = (await (opts.render ?? spawnRenderer)(job)).pages;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  return { pdf, pages, chapters: chapters.length, html: opts.htmlOut };
}

export interface PdfJob {
  html: string;
  out: string;
  timeoutMs: number;
  log?: boolean;
  trace?: boolean;
  noRules?: boolean;
}

/** Turns a prepared HTML file into a PDF. The command line starts a headless Electron; the app does it in-process. */
export type PdfRenderer = (job: PdfJob) => Promise<{ pages: number }>;

const spawnRenderer: PdfRenderer = async (job) => {
  const args = [path.join(PACKAGE_ROOT, "dist", "electron", "pdf-main.cjs"), "--html", job.html, "--out", job.out, "--timeout", String(job.timeoutMs)];
  if (job.log) args.push("--log");
  if (job.trace) args.push("--trace", "--log");
  if (job.noRules) args.push("--no-rules");
  const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" };
  delete (env as Record<string, string | undefined>).ELECTRON_RUN_AS_NODE;
  const result = await new Promise<{ ok: boolean; pages?: number; error?: string }>((resolve, reject) => {
    const child = spawn(electronBinary(), process.platform === "linux" ? ["--no-sandbox", ...args] : args, { env, stdio: ["ignore", "pipe", job.log || job.trace ? "inherit" : "pipe"] });
    let stdout = "";
    child.stdout!.on("data", (d) => (stdout += d));
    child.on("error", reject);
    child.on("close", (code) => {
      const line = stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop();
      if (line) resolve(JSON.parse(line));
      else resolve({ ok: false, error: `the print process exited with code ${code} and no result` });
    });
  });
  if (!result.ok) throw new BuildError(result.error ?? "the print process failed");
  return { pages: result.pages ?? 0 };
};
