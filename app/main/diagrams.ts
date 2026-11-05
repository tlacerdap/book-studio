// Draws the book's diagrams (```mermaid blocks). A hidden window with mermaid in it draws each diagram once; the picture
// is kept in the app's data folder and found again by the diagram's text, so a chapter is never held up twice.

import { BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { diagramKey, diagramsIn, sizeSvg, type DrawnDiagram } from "../../core/diagrams.ts";

export class DiagramPainter {
  private win: BrowserWindow | null = null;
  private ready: Promise<BrowserWindow> | null = null;
  private idle: NodeJS.Timeout | null = null;
  /** Diagrams are drawn one at a time. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private dir: string,
    private assetBase: string,
  ) {}

  /** A drawn diagram, from the data folder, or null if it has not been drawn. Synchronous: page builders call it mid-render. */
  lookup = (code: string): DrawnDiagram | null => {
    const key = diagramKey(code);
    try {
      return { svg: fs.readFileSync(path.join(this.dir, `${key}.svg`), "utf8") };
    } catch {
      /* not drawn, or drawn with an error */
    }
    try {
      return { error: fs.readFileSync(path.join(this.dir, `${key}.err`), "utf8") };
    } catch {
      return null;
    }
  };

  /** Draw every diagram in these chapter texts that has not been drawn yet. */
  async ensure(texts: string[]): Promise<void> {
    const todo = new Map<string, string>();
    for (const text of texts) for (const code of diagramsIn(text)) if (!this.lookup(code)) todo.set(diagramKey(code), code.trim());
    if (!todo.size) return;
    for (const [key, code] of todo) {
      const run = this.chain.then(() => this.draw(key, code));
      this.chain = run.catch(() => undefined);
      await run;
    }
  }

  private async draw(key: string, code: string): Promise<void> {
    if (this.lookup(code)) return;
    let result: { ok: boolean; svg?: string; message?: string };
    try {
      const win = await this.window();
      result = (await win.webContents.executeJavaScript(`window.drawDiagram(${JSON.stringify(code)})`)) as typeof result;
    } catch (e) {
      result = { ok: false, message: `the drawing window failed: ${(e as Error).message}` };
    }
    fs.mkdirSync(this.dir, { recursive: true });
    if (result.ok && result.svg) fs.writeFileSync(path.join(this.dir, `${key}.svg`), sizeSvg(result.svg));
    else fs.writeFileSync(path.join(this.dir, `${key}.err`), result.message ?? "unknown error");
    this.sleepSoon();
  }

  private window(): Promise<BrowserWindow> {
    if (this.idle) clearTimeout(this.idle);
    if (this.win && !this.win.isDestroyed() && this.ready) return this.ready;
    const win = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false, backgroundThrottling: false } });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    this.win = win;
    this.ready = (async () => {
      await win.loadURL(`${this.assetBase}browser/diagram.html`);
      for (let i = 0; i < 100; i++) {
        if ((await win.webContents.executeJavaScript("typeof window.drawDiagram")) === "function") return win;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("mermaid did not start");
    })();
    this.ready.catch(() => {
      this.win?.destroy();
      this.win = null;
      this.ready = null;
    });
    return this.ready;
  }

  /** The drawing window is only kept while it is likely to be needed again. */
  private sleepSoon(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      this.win?.destroy();
      this.win = null;
      this.ready = null;
    }, 30_000);
  }

  stop(): void {
    if (this.idle) clearTimeout(this.idle);
    this.win?.destroy();
    this.win = null;
    this.ready = null;
  }
}
