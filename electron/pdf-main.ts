// Headless Electron entry for the command line: load the book's HTML, paginate it with Paged.js, print it to PDF, exit.
//   electron dist/electron/pdf-main.cjs --html <file> --out <pdf> [--timeout ms] [--log]
// Prints one JSON line on stdout: {"ok":true,"pages":N} or {"ok":false,"error":"..."}.

import { app } from "electron";
import { applyPrintSwitches, renderPdf } from "./render-pdf.ts";

const arg = (name: string, def?: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i === -1 ? def : process.argv[i + 1];
};

function finish(result: Record<string, unknown>, code: number): never {
  process.stdout.write(JSON.stringify(result) + "\n");
  app.exit(code);
  process.exit(code);
}

applyPrintSwitches(app);

app.whenReady().then(async () => {
  try {
    const html = arg("--html");
    const out = arg("--out");
    if (!html || !out) throw new Error("--html and --out are required");
    const { pages } = await renderPdf(
      { html, out, timeoutMs: parseInt(arg("--timeout", "300000")!, 10), log: process.argv.includes("--log"), trace: process.argv.includes("--trace"), noRules: process.argv.includes("--no-rules") },
      (line) => process.stderr.write(line + "\n"),
    );
    finish({ ok: true, pages }, 0);
  } catch (e) {
    finish({ ok: false, error: String((e as Error).message ?? e) }, 1);
  }
});
