// Turn a prepared book HTML file into a PDF inside a hidden window: paginate with Paged.js, then print. Used by the
// headless command-line process (pdf-main.ts) and by the app itself.

import { BrowserWindow, session } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { PdfJob } from "../core/pdf.ts";

/** Chromium switches that make the page measure text the way it is printed. Set before the app is ready. */
export function applyPrintSwitches(app: Electron.App): void {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("force-color-profile", "srgb");
  // No hinting, so the line breaks decided on screen stay the same in the PDF.
  app.commandLine.appendSwitch("font-render-hinting", "none");
  app.commandLine.appendSwitch("force-device-scale-factor", "1");
  app.commandLine.appendSwitch("enable-font-subpixel-positioning");
  app.commandLine.appendSwitch("disable-features", "OutOfBlinkCors");
}

export async function renderPdf(job: PdfJob, log?: (line: string) => void): Promise<{ pages: number }> {
  // Its own session, so the rule that this page may only read local files never touches the app's windows.
  const ses = session.fromPartition(`print-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  ses.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !/^(file|data|devtools):/.test(details.url) }));
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 1600,
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, javascript: true, spellcheck: false },
  });
  try {
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    if (job.log && log) win.webContents.on("console-message", (e) => log(`[page] ${e.message}`));
    await win.loadFile(job.html, { query: { ...(job.trace ? { trace: "1" } : {}), ...(job.noRules ? { norules: "1" } : {}) } });

    const deadline = Date.now() + job.timeoutMs;
    let ready: { pages?: number; error?: string; srcChars?: number; outChars?: number } | undefined;
    while (Date.now() < deadline) {
      ready = await win.webContents.executeJavaScript("window.__bookReady");
      if (ready) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!ready) throw new Error(`pagination did not finish within ${job.timeoutMs / 1000}s`);
    if (ready.error) throw new Error(ready.error);
    // Pagination must never lose text. Anything the pages do not contain is a failed build.
    if (!process.env.BS_FORCE && ready.srcChars !== undefined && ready.outChars !== undefined && ready.outChars !== ready.srcChars) {
      throw new Error(`pagination changed the text: ${ready.srcChars} characters in, ${ready.outChars} on the pages`);
    }
    const pdf = await win.webContents.printToPDF({ preferCSSPageSize: true, printBackground: true, generateDocumentOutline: true, generateTaggedPDF: true });
    fs.mkdirSync(path.dirname(job.out), { recursive: true });
    fs.writeFileSync(job.out, pdf);
    return { pages: ready.pages ?? 0 };
  } finally {
    win.destroy();
  }
}
