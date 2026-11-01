// Headless Electron entry: load the book's HTML, paginate it with Paged.js, print it to PDF, exit.
//   electron dist/electron/pdf-main.cjs --html <file> --out <pdf> [--timeout ms] [--log]
// Prints one JSON line on stdout: {"ok":true,"pages":N} or {"ok":false,"error":"..."}.

import { app, BrowserWindow } from "electron";
import fs from "node:fs";

const arg = (name: string, def?: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i === -1 ? def : process.argv[i + 1];
};
const html = arg("--html");
const out = arg("--out");
const timeout = parseInt(arg("--timeout", "300000")!, 10);
const verbose = process.argv.includes("--log");

function finish(result: Record<string, unknown>, code: number): never {
  process.stdout.write(JSON.stringify(result) + "\n");
  app.exit(code);
  process.exit(code);
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("force-color-profile", "srgb");
// Measure text the way it is printed: no hinting, so line breaks decided on screen stay the same in the PDF.
app.commandLine.appendSwitch("font-render-hinting", "none");
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("enable-font-subpixel-positioning");
app.commandLine.appendSwitch("disable-features", "OutOfBlinkCors");

app.whenReady().then(async () => {
  try {
    if (!html || !out) throw new Error("--html and --out are required");
    const win = new BrowserWindow({
      show: false,
      width: 1200,
      height: 1600,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, javascript: true, spellcheck: false },
    });
    // The page may only read local files; anything else is refused.
    win.webContents.session.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !details.url.startsWith("file:") && !details.url.startsWith("devtools:") && !details.url.startsWith("data:") }));
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    if (verbose) win.webContents.on("console-message", (e) => process.stderr.write(`[page] ${e.message}\n`));
    await win.loadFile(html, { query: { ...(process.argv.includes("--trace") ? { trace: "1" } : {}), ...(process.argv.includes("--no-rules") ? { norules: "1" } : {}) } });

    const deadline = Date.now() + timeout;
    let ready: { pages?: number; error?: string; srcChars?: number; outChars?: number } | undefined;
    while (Date.now() < deadline) {
      ready = await win.webContents.executeJavaScript("window.__bookReady");
      if (ready) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!ready) throw new Error(`pagination did not finish within ${timeout / 1000}s`);
    if (ready.error) throw new Error(ready.error);
    // Pagination must never lose text. Anything the pages do not contain is a failed build.
    if (!process.env.BS_FORCE && ready.srcChars !== undefined && ready.outChars !== undefined && ready.outChars !== ready.srcChars) {
      throw new Error(`pagination changed the text: ${ready.srcChars} characters in, ${ready.outChars} on the pages`);
    }

    const pdf = await win.webContents.printToPDF({
      preferCSSPageSize: true,
      printBackground: true,
      generateDocumentOutline: true,
      generateTaggedPDF: true,
    });
    fs.mkdirSync(require("node:path").dirname(out), { recursive: true });
    fs.writeFileSync(out, pdf);
    finish({ ok: true, pages: ready.pages }, 0);
  } catch (e) {
    finish({ ok: false, error: String((e as Error).message ?? e) }, 1);
  }
});
