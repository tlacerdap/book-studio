// How many pages each chapter takes, and so how long the book is. A chapter's pages are known only by laying it out, so
// this does it quietly in a hidden window, one chapter at a time, and remembers the answers: a chapter is laid out
// again only when its text, the styles or the app change.

import { BrowserWindow } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chapterFiles, type BookConfig } from "../../core/config.ts";
import { buildReadingHtml } from "../../core/reading.ts";

export interface PageCounts {
  /** Pages per chapter, by file path. Only chapters already counted are present. */
  counts: Record<string, number>;
  /** Chapters still to count. */
  pending: number;
  /** All chapters of the book (so the total can say how much it is based on). */
  chapters: number;
}

export class PageCounter {
  private win: BrowserWindow | null = null;
  private counts = new Map<string, number>();
  private seen = new Map<string, { mtime: number; key: string }>();
  private queue: string[] = [];
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private book: BookConfig | null = null;
  private cache: Record<string, number> = {};
  private generation = 0;
  /** Called with a chapter's text before it is laid out (diagrams are drawn here). */
  prepare: ((text: string) => Promise<void>) | null = null;

  constructor(
    private cacheFile: string,
    private assetBase: string,
    private register: (html: string) => string,
    private onChange: (state: PageCounts) => void,
  ) {
    try {
      this.cache = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as Record<string, number>;
    } catch {
      this.cache = {};
    }
  }

  state(): PageCounts {
    const files = this.book ? chapterFiles(this.book) : [];
    return { counts: Object.fromEntries(this.counts), pending: this.queue.length + (this.running ? 1 : 0), chapters: files.length };
  }

  /** A book was opened, or its files changed: work out which chapters need counting. */
  refresh(book: BookConfig, everything = false): void {
    if (this.book?.root !== book.root) {
      this.counts.clear();
      this.seen.clear();
      this.generation++;
      this.queue = [];
    }
    this.book = book;
    if (everything) this.seen.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.scan(), 600);
  }

  /** The reading view already laid this chapter out: take its answer for free. */
  known(file: string, pages: number): void {
    if (this.counts.get(file) !== pages) {
      this.counts.set(file, pages);
      this.onChange(this.state());
    }
  }

  stop(): void {
    this.generation++;
    this.queue = [];
    this.win?.destroy();
    this.win = null;
  }

  private scan(): void {
    const book = this.book;
    if (!book) return;
    const files = chapterFiles(book);
    for (const f of [...this.counts.keys()]) if (!files.includes(f)) this.counts.delete(f);
    for (const f of files) {
      let mtime = 0;
      try {
        mtime = fs.statSync(f).mtimeMs;
      } catch {
        continue;
      }
      const prev = this.seen.get(f);
      if (prev && prev.mtime === mtime && this.counts.has(f)) continue;
      this.seen.set(f, { mtime, key: "" });
      if (!this.queue.includes(f)) this.queue.push(f);
    }
    this.onChange(this.state());
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const gen = this.generation;
    try {
      while (this.queue.length && gen === this.generation && this.book) {
        const file = this.queue.shift()!;
        await this.count(this.book, file);
        this.onChange(this.state());
        await new Promise((r) => setTimeout(r, 200)); // leave the window room to breathe between chapters
      }
    } finally {
      this.running = false;
      if (gen === this.generation) this.onChange(this.state());
    }
  }

  private async count(book: BookConfig, file: string): Promise<void> {
    let html: string;
    try {
      const text = fs.readFileSync(file, "utf8");
      await this.prepare?.(text);
      html = buildReadingHtml(book, file, text, { assetBase: this.assetBase });
    } catch {
      return; // a chapter that cannot be rendered has no count
    }
    const key = crypto.createHash("sha1").update(html).digest("hex");
    const hit = this.cache[key];
    if (hit !== undefined) {
      this.counts.set(file, hit);
      return;
    }
    const win = this.window();
    try {
      await win.loadURL(this.register(html));
      const deadline = Date.now() + 90_000;
      for (;;) {
        const ready = (await win.webContents.executeJavaScript("window.__bookReady")) as { pages?: number; error?: string } | undefined;
        if (ready) {
          if (ready.pages) {
            this.counts.set(file, ready.pages);
            this.cache[key] = ready.pages;
            this.save();
          }
          return;
        }
        if (Date.now() > deadline) return;
        await new Promise((r) => setTimeout(r, 80));
      }
    } catch {
      /* the window went away (the book was closed): nothing to record */
    }
  }

  private window(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    this.win = new BrowserWindow({
      show: false,
      width: 1200,
      height: 1600,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false, backgroundThrottling: false },
    });
    this.win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    this.win.webContents.on("will-navigate", (e) => {
      if (!e.url.startsWith("bookstudio://reading/")) e.preventDefault();
    });
    return this.win;
  }

  private save(): void {
    const keys = Object.keys(this.cache);
    if (keys.length > 3000) for (const k of keys.slice(0, keys.length - 2000)) delete this.cache[k];
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      fs.writeFileSync(this.cacheFile, JSON.stringify(this.cache));
    } catch {
      /* the cache is only a speed-up */
    }
  }
}
