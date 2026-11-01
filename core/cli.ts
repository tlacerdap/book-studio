// book-studio command line:  book-studio pdf|check|lint <book folder> ...

import path from "node:path";
import { parseArgs } from "node:util";
import { ConfigError, loadBook } from "./config.ts";
import { formatReport, runChecks } from "./check.ts";
import { formatLint, lintBook } from "./lint.ts";
import { BuildError, buildPdf } from "./pdf.ts";
import { outputPdf } from "./config.ts";

const USAGE = `book-studio pdf   <book> [--chapters SPEC...] [--out FILE] [--html FILE] [--extra-css FILE] [--check]
book-studio check <book> [PDF] [--samples DIR]
book-studio lint  <book> [FILES...]

A book is a folder with a book.yaml. SPEC is a number (7), a range (0-3), a comma list, or a file name.`;

function die(msg: string): never {
  process.stderr.write(`book-studio: ${msg}\n`);
  process.exit(1);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(USAGE + "\n");
    return command ? 0 : 1;
  }
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      chapters: { type: "string", multiple: true },
      out: { type: "string" },
      html: { type: "string" },
      "extra-css": { type: "string", multiple: true },
      check: { type: "boolean" },
      samples: { type: "string" },
      log: { type: "boolean" },
      trace: { type: "boolean" },
    },
  });
  const [bookArg, ...more] = positionals;
  if (!bookArg) die(`${command}: which book folder?\n\n${USAGE}`);
  let book;
  try {
    book = loadBook(bookArg);
  } catch (e) {
    if (e instanceof ConfigError) die(e.message);
    throw e;
  }
  try {
    if (command === "pdf") {
      const res = await buildPdf(book, {
        chapters: values.chapters,
        out: values.out,
        htmlOut: values.html,
        extraCss: (values["extra-css"] ?? []).map((f) => path.resolve(f)),
        log: values.log,
        trace: values.trace,
      });
      process.stdout.write(`${res.pdf}  (${res.pages} pages, ${res.chapters} chapters)\n`);
      if (values.check) {
        const report = await runChecks(res.pdf, book, { extraCss: (values["extra-css"] ?? []).map((f) => path.resolve(f)), samples: values.samples, chapters: values.chapters });
        process.stdout.write("\n" + formatReport(report) + "\n");
        return report.ok ? 0 : 1;
      }
      return 0;
    }
    if (command === "check") {
      const pdf = more[0] ? path.resolve(more[0]) : outputPdf(book);
      const fs = await import("node:fs");
      if (!fs.existsSync(pdf)) die(`${pdf} does not exist. Build it first: book-studio pdf ${bookArg}`);
      const report = await runChecks(pdf, book, { extraCss: (values["extra-css"] ?? []).map((f) => path.resolve(f)), samples: values.samples, chapters: values.chapters });
      process.stdout.write(formatReport(report) + "\n");
      return report.ok ? 0 : 1;
    }
    if (command === "lint") {
      const results = lintBook(book, more);
      process.stdout.write(formatLint(results) + "\n");
      return results.some((r) => r.problems.length) ? 1 : 0;
    }
    die(`unknown command '${command}'\n\n${USAGE}`);
  } catch (e) {
    if (e instanceof BuildError) die(e.message);
    throw e;
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
  process.stderr.write(`book-studio: ${(e as Error).stack ?? e}\n`);
  process.exit(1);
});
