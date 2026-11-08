// Book Studio's main process: windows, the menu, the book on disk, and the print job. The window itself never touches
// the file system; it asks for one named thing at a time through the preload bridge (see app/shared/api.ts).

import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, protocol, session, shell, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { searchFiles, type SearchResult } from "../../core/search.ts";
import { bookEvidence, chapterFiles, ConfigError, isBook, loadBook, outputPdf, addTerm, setKnown, setPageBudget, writeDefaultBookYaml, type BookConfig } from "../../core/config.ts";
import { checkText } from "../../core/writing-rules.ts";
import { inboxNotes } from "../../core/inbox.ts";
import { stripNotes } from "../../core/notes.ts";
import { exportEpub, exportHtml } from "../../core/export.ts";
import { setDiagramProvider } from "../../core/diagrams.ts";
import { editorCss } from "../../core/editcss.ts";
import { readCss, styleFiles } from "../../core/style.ts";
import { DiagramPainter } from "./diagrams.ts";
import { buildPdf } from "../../core/pdf.ts";
import { selectChapters } from "../../core/book.ts";
import crypto from "node:crypto";
import { IMAGE_EXTENSIONS, imageMarkdown, imageName, MAX_IMAGE_BYTES, sniffImage } from "../../core/images.ts";
import { allCards } from "../../core/study.ts";
import { listChapters } from "../../core/book.ts";
import { ChapterError, createChapter, linksTo, moveChapter, renameChapter, reorderChapter } from "../../core/chapters.ts";
import { lineDiff, listSnapshots, readSnapshot, snapshot } from "../../core/history.ts";
import { outline } from "../../core/notemap.ts";
import { atomicWrite } from "../../core/fsutil.ts";
import { locateProblems, printBook } from "../../core/print.ts";
import { buildReadingHtml } from "../../core/reading.ts";
import { PACKAGE_ROOT, STYLES } from "../../core/paths.ts";
import type { CheckReport } from "../../core/check.ts";
import { PageCounter, type PageCounts } from "./pagecount.ts";
import { applyPrintSwitches, renderPdf } from "../../electron/render-pdf.ts";
import type { Appearance, BookInfo, ChapterText, ChromeInfo, ExportKind, ExportOutcome, Theme, MenuCommand, OpenResult, PrintOutcome, ReadingSnapshot, UnsavedChoice } from "../shared/api.ts";
import { startMcpServer } from "./mcp.ts";
import { buildMenuModel, type MenuItem } from "../shared/menu.ts";

const SCHEME = "bookstudio";
const APP_ORIGIN = `${SCHEME}://app/`;

// On Windows and Linux the window draws its own title bar and menu, so they can follow the reading theme and the warm
// tint; macOS keeps its native menu at the top of the screen. These sizes are shared with the renderer (see titlebar.ts).
const CUSTOM_CHROME = process.platform !== "darwin";
const TITLEBAR_H = 40;
// The width Windows reserves for the native minimise/maximise/close buttons in the Window-Controls-Overlay.
const WINDOW_CONTROLS_W = 138;

// The title bar's own colours per theme (a touch away from the page, like a real chrome bar), as RGB so the warm tint
// can be multiplied in for the Windows native buttons. The renderer tints its own bar with the same #warm veil over it.
const CHROME_BG: Record<Exclude<Theme, "system">, [number, number, number]> = {
  light: [0xef, 0xed, 0xe9],
  sepia: [0xea, 0xde, 0xbf],
  dark: [0x2b, 0x2a, 0x28],
  black: [0x0a, 0x0a, 0x0a],
};
const CHROME_INK: Record<Exclude<Theme, "system">, string> = {
  light: "#1f1e1d",
  sepia: "#3b2f1e",
  dark: "#ecebe8",
  black: "#e8e6e1",
};

function resolvedTheme(a: Appearance): Exclude<Theme, "system"> {
  if (a.theme === "system") return nativeTheme.shouldUseDarkColors ? "dark" : "light";
  return a.theme;
}

/** The warm tint is a multiply of rgb(255,150,40) at warmth*0.35 — the same veil the renderer lays over the window. */
function tinted(rgb: [number, number, number], warmth: number): string {
  const over = [255, 150, 40];
  const a = Math.max(0, Math.min(1, warmth)) * 0.35;
  const hex = rgb.map((c, i) => Math.round(c * (1 - a) + ((c * over[i]) / 255) * a).toString(16).padStart(2, "0")).join("");
  return `#${hex}`;
}

/** Colours for the Windows native min/max/close buttons, following the theme and the warm tint. */
function overlayColors(a: Appearance): { color: string; symbolColor: string } {
  const t = resolvedTheme(a);
  return { color: tinted(CHROME_BG[t], a.warmth), symbolColor: CHROME_INK[t] };
}

protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
// The reading view is laid out with the same Chromium settings the PDF is printed with, so a page breaks in the same place on both.
applyPrintSwitches(app);
app.setName("Book Studio");
// An AppImage cannot carry the setuid helper Chromium's own sandbox needs on many Linux systems, and the app would not
// start at all. The window stays sandboxed at the renderer level (see webPreferences); only this process-level layer is dropped.
if (process.platform === "linux" && process.env.APPIMAGE) app.commandLine.appendSwitch("no-sandbox");

let mainWindow: BrowserWindow | null = null;
let book: BookConfig | null = null;
let allowClose = false;
let quitting = false;
let printing = false;
let watcher: fs.FSWatcher | null = null;
/** Until this time a change to book.yaml is the app's own (the budget, a known chapter) and moves no page. */
let ownYamlUntil = 0;
let counter: PageCounter | null = null;
let painter: DiagramPainter | null = null;
/** The last thing the window told us the reader is looking at, for the optional MCP server. In memory only. */
let readingState: ReadingSnapshot & { at: number } = { file: null, name: null, view: null, line: null, heading: null, selection: null, at: 0 };

/** Draw the diagrams of some chapters (every one of the book's when no list is given) before a page is built from them. */
async function drawDiagrams(texts?: string[]): Promise<void> {
  if (!painter || !book) return;
  const all = texts ?? chapterFiles(book).map((f) => {
    try {
      return fs.readFileSync(f, "utf8");
    } catch {
      return "";
    }
  });
  await painter.ensure(all);
}

// ------------------------------------------------------------------------------------------------
// What the window may load: its own files, the shared styles and scripts, the prepared reading pages. Nothing else.
// ------------------------------------------------------------------------------------------------

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
};

const APP_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: ${SCHEME}://book`,
  `font-src ${SCHEME}://assets`,
  `frame-src ${SCHEME}://reading`,
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

const readingPages = new Map<string, string>();
let readingCounter = 0;

function inside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function serve(root: string, rel: string, headers: Record<string, string> = {}): Response {
  const file = path.resolve(root, rel);
  if (!inside(root, file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response("not found", { status: 404 });
  return new Response(new Uint8Array(fs.readFileSync(file)), {
    headers: { "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream", "access-control-allow-origin": "*", ...headers },
  });
}

function handleProtocol(req: Request): Response {
  const url = new URL(req.url);
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  switch (url.hostname) {
    case "app":
      return serve(path.join(PACKAGE_ROOT, "dist", "renderer"), rel || "index.html", { "content-security-policy": APP_CSP });
    case "assets":
      if (rel.startsWith("styles/")) return serve(STYLES, rel.slice("styles/".length));
      if (rel.startsWith("browser/")) return serve(path.join(PACKAGE_ROOT, "dist", "browser"), rel.slice("browser/".length));
      return new Response("not found", { status: 404 });
    case "book": {
      // The pictures of the open book, and only pictures, only inside the book's folder.
      if (!book || !IMAGE_EXTENSIONS.includes(path.extname(rel).toLowerCase())) return new Response("not found", { status: 404 });
      return serve(book.root, rel);
    }
    case "reading": {
      const html = readingPages.get(rel.replace(/\.html$/, ""));
      return html === undefined ? new Response("not found", { status: 404 }) : new Response(html, { headers: { "content-type": TYPES[".html"] } });
    }
    default:
      return new Response("not found", { status: 404 });
  }
}

// ------------------------------------------------------------------------------------------------
// Recent books
// ------------------------------------------------------------------------------------------------

// ------------------------------------------------------------------------------------------------
// Settings of the app itself (not of a book)
// ------------------------------------------------------------------------------------------------

const settingsFile = () => path.join(app.getPath("userData"), "settings.json");

const THEMES: Theme[] = ["light", "sepia", "dark", "black", "system"];
const DEFAULT_APPEARANCE: Appearance = { theme: "light", warmth: 0 };
let appearance: Appearance = DEFAULT_APPEARANCE;

function readAppearance(): Appearance {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), "utf8")) as { theme?: string; warmth?: number };
    const theme = THEMES.includes(raw.theme as Theme) ? (raw.theme as Theme) : DEFAULT_APPEARANCE.theme;
    const warmth = typeof raw.warmth === "number" && raw.warmth >= 0 && raw.warmth <= 1 ? Math.round(raw.warmth * 100) / 100 : 0;
    return { theme, warmth };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

/** Merge a few fields into settings.json, keeping everything else (so the theme write does not drop the UI zoom). */
function writeSettings(patch: Record<string, unknown>): void {
  let cur: Record<string, unknown> = {};
  try {
    cur = JSON.parse(fs.readFileSync(settingsFile(), "utf8")) as Record<string, unknown>;
  } catch {
    /* no settings yet */
  }
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify({ ...cur, ...patch }, null, 2));
  } catch {
    /* not remembered */
  }
}

// The zoom of the whole interface — the menus, the panels and the page together — set with Ctrl and the mouse wheel. This
// is separate from the reading view's own zoom (the toolbar %), which sizes just the book page.
const MIN_UI_ZOOM = 0.5;
const MAX_UI_ZOOM = 2.5;
let uiZoom = 1;

function readUiZoom(): number {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), "utf8")) as { uiZoom?: number };
    if (typeof raw.uiZoom === "number" && raw.uiZoom >= MIN_UI_ZOOM && raw.uiZoom <= MAX_UI_ZOOM) return raw.uiZoom;
  } catch {
    /* default */
  }
  return 1;
}

/** Chromium resets the zoom on every load, so it is re-applied once the page is ready. */
function applyUiZoom(): void {
  try {
    mainWindow?.webContents.setZoomFactor(uiZoom);
  } catch {
    /* the window is not ready yet */
  }
}

// "Let Claude read along": the optional, read-only MCP server (see mcp.ts). It is now a remembered setting with a menu
// toggle, so a normal launch can keep it on; the BOOK_STUDIO_MCP env var only sets what the very first run defaults to.
let mcpEnabled = false;
let mcpStop: (() => void) | null = null;

const mcpPort = (): number => Number(process.env.BOOK_STUDIO_MCP_PORT) || 4319;

function readMcpEnabled(): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), "utf8")) as { mcpEnabled?: boolean };
    if (typeof raw.mcpEnabled === "boolean") return raw.mcpEnabled;
  } catch {
    /* no setting yet */
  }
  return !!process.env.BOOK_STUDIO_MCP;
}

function startMcp(): void {
  if (mcpStop) return;
  mcpStop = startMcpServer({ version: app.getVersion(), book: () => book, reading: () => readingState }, mcpPort());
}

function stopMcp(): void {
  mcpStop?.();
  mcpStop = null;
}

function setMcpEnabled(on: boolean): void {
  mcpEnabled = on;
  writeSettings({ mcpEnabled: on });
  if (on) startMcp();
  else stopMcp();
  buildMenu();
}

/** Change how the app looks (the theme, the warm tint) and remember it. The window is told; the menu follows. */
function setAppearance(change: Partial<Appearance>): Appearance {
  appearance = { ...appearance, ...change };
  // Native parts (scroll bars, the spell-check menu) follow whether the theme is a dark one.
  nativeTheme.themeSource = appearance.theme === "system" ? "system" : appearance.theme === "dark" || appearance.theme === "black" ? "dark" : "light";
  writeSettings({ ...appearance });
  if (process.platform === "win32" && mainWindow) {
    try {
      mainWindow.setTitleBarOverlay(overlayColors(appearance));
    } catch {
      /* the window may not be ready yet; it is set again from createWindow's options */
    }
  }
  mainWindow?.webContents.send("appearance", appearance);
  buildMenu();
  return appearance;
}

const recentFile = () => path.join(app.getPath("userData"), "recent.json");

function readRecent(): { folder: string; title: string }[] {
  try {
    const list = JSON.parse(fs.readFileSync(recentFile(), "utf8")) as { folder: string; title: string }[];
    return list.filter((r) => typeof r.folder === "string" && isBook(r.folder)).slice(0, 10);
  } catch {
    return [];
  }
}

function remember(b: BookConfig): void {
  const list = [{ folder: b.root, title: b.title }, ...readRecent().filter((r) => r.folder !== b.root)].slice(0, 10);
  try {
    fs.mkdirSync(path.dirname(recentFile()), { recursive: true });
    fs.writeFileSync(recentFile(), JSON.stringify(list, null, 2));
  } catch {
    /* losing the recent list is not worth an error */
  }
  app.addRecentDocument(b.root);
  buildMenu();
}

// ------------------------------------------------------------------------------------------------
// The open book
// ------------------------------------------------------------------------------------------------

/** Every chapter's words added up, with the reader's notes stripped out so they do not inflate the count. */
function totalWords(b: BookConfig): number {
  let n = 0;
  for (const f of chapterFiles(b)) {
    try {
      n += (stripNotes(fs.readFileSync(f, "utf8")).text.match(/\S+/g) ?? []).length;
    } catch {
      /* an unreadable chapter adds nothing */
    }
  }
  return n;
}

function bookInfo(b: BookConfig): BookInfo {
  return { root: b.root, title: b.title, author: b.author, output: b.output, chapters: listChapters(b, chapterFiles(b)), pages: b.pages, known: b.known, words: totalWords(b) };
}

function watch(b: BookConfig): void {
  watcher?.close();
  let pending = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  try {
    watcher = fs.watch(b.root, { recursive: true }, (_event, name) => {
      if (!name) return;
      const rel = name.toString();
      if (/(^|[\\/])(build|\.git|node_modules)([\\/]|$)/.test(rel) || /\.tmp$/.test(rel) || /(^|[\\/])\.DS_Store$/.test(rel)) return;
      if (rel === "book.yaml" && Date.now() < ownYamlUntil) return;
      pending.add(rel);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const files = [...pending];
        pending = new Set();
        mainWindow?.webContents.send("book:changed", files);
        // A change to the book's settings, index or styles can move every page; a chapter file moves only its own.
        if (book) counter?.refresh(book, files.some((f) => !f.endsWith(".md") || /INDEX/i.test(f)));
      }, 250);
    });
    watcher.on("error", () => watcher?.close());
  } catch {
    /* a platform without recursive watching: the app still works, it just does not notice outside edits */
  }
}

const historyStore = () => app.getPath("userData");

/** A chapter's text: as the editor holds it if that is the open chapter, else from disk. */
function textOf(file: string, current: { file: string; text: string } | null): string {
  if (current && typeof current.text === "string" && current.file === file) return current.text;
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/**
 * The writing hints of one chapter. The acronym check needs the chapters before it (an acronym explained there is
 * explained for good), so they are read in book order, with the open chapter as the editor holds it.
 */
function hintsFor(b: BookConfig, file: string, text: string | null, current: { file: string; text: string } | null) {
  const read = (f: string): string => {
    if (current && current.file === f) return String(current.text);
    try {
      return fs.readFileSync(f, "utf8");
    } catch {
      return "";
    }
  };
  const files = chapterFiles(b);
  const at = files.indexOf(file);
  const earlier = files.slice(0, Math.max(0, at)).map(read).join("\n");
  return checkText(text ?? read(file), { rules: b.rules, terms: b.terms }, earlier);
}

/** Remember this text as a version of the chapter. Losing a version must never get in the way of saving. */
function keepVersion(file: string, text: string, force = false): void {
  if (!book) return;
  try {
    snapshot(historyStore(), book.root, file, text, Date.now(), force);
  } catch {
    /* the history is a convenience */
  }
}

function registerReading(html: string): string {
  const id = `r${++readingCounter}`;
  readingPages.set(id, html);
  for (const old of [...readingPages.keys()].slice(0, -12)) readingPages.delete(old);
  return `${SCHEME}://reading/${id}.html`;
}

function openBook(folder: string): OpenResult {
  try {
    const b = loadBook(folder);
    book = b;
    watch(b);
    remember(b);
    counter?.refresh(b);
    mainWindow?.setTitle(`${b.title} - Book Studio`);
    return { ok: true, book: bookInfo(b) };
  } catch (e) {
    if (e instanceof ConfigError && !fs.existsSync(path.join(path.resolve(folder), "book.yaml")) && fs.existsSync(folder) && fs.statSync(folder).isDirectory()) {
      return { ok: false, reason: "not-a-book", folder: path.resolve(folder), evidence: bookEvidence(folder).length };
    }
    return { ok: false, reason: "error", message: (e as Error).message };
  }
}

function requireBook(): BookConfig {
  if (!book) throw new Error("no book is open");
  return book;
}

/** A chapter the open book actually owns: the window cannot ask for any other file. */
function chapterPath(file: string): string {
  const b = requireBook();
  const hit = chapterFiles(b).find((f) => f === file);
  if (!hit) throw new Error("that is not a chapter of the open book");
  return hit;
}

// ------------------------------------------------------------------------------------------------
// Checking runs in a worker, so a long check never freezes the window
// ------------------------------------------------------------------------------------------------

function checkInWorker(pdf: string, b: BookConfig): Promise<CheckReport> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(fileURLToPath(new URL("./check-worker.mjs", import.meta.url)), { workerData: { pdf, root: b.root } });
    worker.once("message", (m: { ok: boolean; report?: CheckReport; error?: string }) => (m.ok ? resolve(m.report!) : reject(new Error(m.error))));
    worker.once("error", reject);
    worker.once("exit", (code) => code !== 0 && reject(new Error(`the checker stopped (exit ${code})`)));
  });
}

async function print(): Promise<PrintOutcome> {
  if (printing) return { ok: false, error: "A PDF is already being made." };
  const b = requireBook();
  printing = true;
  try {
    await drawDiagrams();
    const result = await printBook(b, {
      render: (job) => renderPdf(job),
      check: checkInWorker,
      onProgress: (stage) => mainWindow?.webContents.send("print:progress", { stage }),
    });
    const chapters = listChapters(b, chapterFiles(b)).map((c) => ({ file: c.file, title: c.title }));
    const { report } = result;
    return {
      ok: report.ok,
      pdf: result.pdf,
      pages: result.pages,
      chapters: result.chapters,
      report: { results: report.results, measure: report.measure, bodyPages: report.bodyPages, pages: report.pages, failures: report.failures, ok: report.ok, inkMedian: report.inkMedian },
      problems: locateProblems(report, chapters),
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    printing = false;
  }
}

// ------------------------------------------------------------------------------------------------
// IPC
// ------------------------------------------------------------------------------------------------

function trusted(e: IpcMainInvokeEvent): void {
  const url = e.senderFrame?.url ?? "";
  if (!url.startsWith(APP_ORIGIN)) throw new Error("untrusted sender");
}

function handle<A extends unknown[], R>(channel: string, fn: (...a: A) => R | Promise<R>): void {
  ipcMain.handle(channel, (e, ...args) => {
    trusted(e);
    return fn(...(args as A));
  });
}

/** Write the book, or a chapter, in another shape. Asks where to put it, and shows the result in the folder. */
async function exportRun(kind: ExportKind, file: string | null): Promise<ExportOutcome> {
  const b = requireBook();
  const win = mainWindow!;
  const build = path.join(b.root, "build");
  const cancelled = { ok: false as const, cancelled: true, message: "" };
  const say = (m: string) => win.webContents.send("export:progress", m);
  try {
    await drawDiagrams();
    if (kind === "epub" || kind === "html") {
      const ext = kind === "epub" ? "epub" : "html";
      fs.mkdirSync(build, { recursive: true });
      const r = await dialog.showSaveDialog(win, { title: kind === "epub" ? "Export as EPUB" : "Export as one web page", defaultPath: path.join(build, `${b.output}.${ext}`), filters: [{ name: kind === "epub" ? "EPUB e-book" : "Web page", extensions: [ext] }] });
      if (r.canceled || !r.filePath) return cancelled;
      const done = kind === "epub" ? exportEpub(b, r.filePath) : exportHtml(b, r.filePath);
      shell.showItemInFolder(r.filePath);
      return { ok: true, message: `${path.basename(r.filePath)} written: ${done.chapters} chapter${done.chapters === 1 ? "" : "s"}, ${(done.bytes / 1048576).toFixed(1)} MB.` };
    }
    if (printing) return { ok: false, message: "A PDF is already being made." };
    printing = true;
    try {
      if (kind === "chapter-pdf") {
        const f = chapterPath(String(file));
        fs.mkdirSync(build, { recursive: true });
        const r = await dialog.showSaveDialog(win, { title: "Export this chapter as PDF", defaultPath: path.join(build, `${path.basename(f, ".md")}.pdf`), filters: [{ name: "PDF", extensions: ["pdf"] }] });
        if (r.canceled || !r.filePath) return cancelled;
        say("Making the PDF of this chapter...");
        const built = await buildPdf(b, { chapters: [path.basename(f)], out: r.filePath, bare: true, render: (job) => renderPdf(job) });
        shell.showItemInFolder(built.pdf);
        return { ok: true, message: `${path.basename(built.pdf)} written: ${built.pages} page${built.pages === 1 ? "" : "s"}.` };
      }
      const files = selectChapters(b);
      if (!files.length) return { ok: false, message: "There are no chapters to export (every one is marked as known)." };
      const r = await dialog.showOpenDialog(win, { title: "Choose a folder for the chapter PDFs", defaultPath: build, properties: ["openDirectory", "createDirectory"], buttonLabel: "Export Here" });
      if (r.canceled || !r.filePaths[0]) return cancelled;
      let pages = 0;
      for (const [i, f] of files.entries()) {
        say(`Chapter PDFs: ${i + 1} of ${files.length} (${path.basename(f, ".md")})...`);
        pages += (await buildPdf(b, { chapters: [path.basename(f)], out: path.join(r.filePaths[0], `${path.basename(f, ".md")}.pdf`), bare: true, render: (job) => renderPdf(job) })).pages;
      }
      shell.openPath(r.filePaths[0]);
      return { ok: true, message: `${files.length} PDFs written, ${pages} pages in all.` };
    } finally {
      printing = false;
    }
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

function registerIpc(): void {
  handle("book:open-dialog", async (): Promise<OpenResult> => {
    const r = await dialog.showOpenDialog(mainWindow!, { title: "Open Book Folder", properties: ["openDirectory", "createDirectory"] });
    if (r.canceled || !r.filePaths[0]) return { ok: false, reason: "cancelled" };
    return openBook(r.filePaths[0]);
  });
  handle("book:open", (folder: string) => openBook(String(folder)));
  handle("book:create", (folder: string): OpenResult => {
    try {
      writeDefaultBookYaml(String(folder));
      return openBook(String(folder));
    } catch (e) {
      return { ok: false, reason: "error", message: (e as Error).message };
    }
  });
  handle("book:recent", () => readRecent());
  handle("book:current", () => (book ? bookInfo(book) : null));
  handle("book:refresh", () => {
    if (!book) return null;
    try {
      book = loadBook(book.root);
    } catch {
      /* a broken book.yaml keeps the last good settings until it is fixed */
    }
    return bookInfo(book);
  });
  handle("chapter:read", (file: string): ChapterText => {
    const f = chapterPath(String(file));
    const text = fs.readFileSync(f, "utf8");
    // What the chapter looks like when it is opened or when someone else changes it is a version worth keeping.
    keepVersion(f, text);
    return { text, mtimeMs: fs.statSync(f).mtimeMs };
  });
  handle("chapter:write", (file: string, text: string) => {
    const f = chapterPath(String(file));
    atomicWrite(f, String(text));
    keepVersion(f, String(text));
    return { mtimeMs: fs.statSync(f).mtimeMs };
  });
  handle("chapter:create", (title: string) => {
    const b = requireBook();
    try {
      return { ok: true as const, file: createChapter(b, String(title).slice(0, 120)) };
    } catch (e) {
      if (e instanceof ChapterError) return { ok: false as const, message: e.message };
      throw e;
    }
  });
  handle("chapter:rename", (file: string, title: string) => {
    const b = requireBook();
    try {
      return { ok: true as const, file: renameChapter(b, chapterPath(String(file)), String(title).slice(0, 120)) };
    } catch (e) {
      if (e instanceof ChapterError) return { ok: false as const, message: e.message };
      throw e;
    }
  });
  handle("chapter:move", (file: string, step: number) => {
    const b = requireBook();
    try {
      return { ok: true as const, file: moveChapter(b, chapterPath(String(file)), step < 0 ? -1 : 1) };
    } catch (e) {
      if (e instanceof ChapterError) return { ok: false as const, message: e.message };
      throw e;
    }
  });
  handle("chapter:reorder", (file: string, toIndex: number) => {
    const b = requireBook();
    try {
      return { ok: true as const, file: reorderChapter(b, chapterPath(String(file)), Number(toIndex)) };
    } catch (e) {
      if (e instanceof ChapterError) return { ok: false as const, message: e.message };
      throw e;
    }
  });
  handle("chapter:delete", async (file: string): Promise<boolean> => {
    const b = requireBook();
    const f = chapterPath(String(file));
    const linked = linksTo(b, f);
    const r = await dialog.showMessageBox(mainWindow!, {
      type: "warning",
      message: `Move ${path.basename(f)} to the Trash?`,
      detail: linked.length ? `${linked.join(", ")} link${linked.length === 1 ? "s" : ""} to it, and those links will stop working. You can get the file back from the Trash.` : "You can get the file back from the Trash.",
      buttons: ["Move to Trash", "Cancel"],
      defaultId: 1,
      cancelId: 1,
    });
    if (r.response !== 0) return false;
    keepVersion(f, fs.readFileSync(f, "utf8"), true);
    await shell.trashItem(f);
    return true;
  });
  handle("history:list", (file: string) => {
    const b = requireBook();
    return listSnapshots(historyStore(), b.root, chapterPath(String(file)));
  });
  handle("history:diff", (file: string, id: string, current: string) => {
    const b = requireBook();
    const old = readSnapshot(historyStore(), b.root, chapterPath(String(file)), String(id));
    return lineDiff(old, String(current));
  });
  handle("history:restore", (file: string, id: string) => {
    const b = requireBook();
    const f = chapterPath(String(file));
    const text = readSnapshot(historyStore(), b.root, f, String(id));
    keepVersion(f, fs.readFileSync(f, "utf8"), true); // the version being replaced stays in the history
    return text;
  });
  handle("style:edit", () => editorCss(readCss(styleFiles(requireBook(), [], { paged: false }))));
  handle("appearance:get", () => appearance);
  handle("appearance:set", (change: Partial<Appearance>) => {
    const next: Partial<Appearance> = {};
    if (change && THEMES.includes(change.theme as Theme)) next.theme = change.theme;
    if (change && typeof change.warmth === "number" && change.warmth >= 0 && change.warmth <= 1) next.warmth = Math.round(change.warmth * 100) / 100;
    return setAppearance(next);
  });
  handle("export:run", (kind: ExportKind, file: string | null) => exportRun(kind, file));
  handle("image:save", (chapter: string, bytes: Uint8Array) => {
    const b = requireBook();
    const f = chapterPath(String(chapter));
    const data = Buffer.from(bytes as Uint8Array);
    if (!data.length || data.length > MAX_IMAGE_BYTES) return { ok: false as const, message: "That picture is empty or larger than 25 MB." };
    const kind = sniffImage(data);
    if (!kind) return { ok: false as const, message: "That is not a PNG, JPEG, GIF or WebP picture." };
    const target = path.join(b.root, "images", imageName(f, crypto.createHash("sha1").update(data).digest("hex").slice(0, 6), kind.ext));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target)) fs.writeFileSync(target, data);
    return { ok: true as const, markdown: [imageMarkdown(f, target)] };
  });
  handle("image:pick", async (chapter: string) => {
    const b = requireBook();
    const f = chapterPath(String(chapter));
    const r = await dialog.showOpenDialog(mainWindow!, { title: "Insert Picture", properties: ["openFile", "multiSelections"], filters: [{ name: "Pictures", extensions: IMAGE_EXTENSIONS.map((e) => e.slice(1)) }] });
    if (r.canceled || !r.filePaths.length) return { ok: false as const, message: "" };
    const out: string[] = [];
    for (const src of r.filePaths) {
      const data = fs.readFileSync(src);
      if (data.length > MAX_IMAGE_BYTES) return { ok: false as const, message: `${path.basename(src)} is larger than 25 MB.` };
      const ext = path.extname(src).toLowerCase();
      if (!IMAGE_EXTENSIONS.includes(ext)) continue;
      if (ext !== ".svg" && !sniffImage(data)) return { ok: false as const, message: `${path.basename(src)} is not a picture.` };
      const target = path.join(b.root, "images", imageName(f, crypto.createHash("sha1").update(data).digest("hex").slice(0, 6), ext === ".jpeg" ? ".jpg" : ext, path.basename(src)));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (!fs.existsSync(target)) fs.writeFileSync(target, data);
      out.push(imageMarkdown(f, target, path.basename(src, ext).replace(/[-_]+/g, " ")));
    }
    return out.length ? { ok: true as const, markdown: out } : { ok: false as const, message: "No pictures were chosen." };
  });
  handle("book:set-budget", (pages: number | null) => {
    const b = requireBook();
    ownYamlUntil = Date.now() + 2500;
    setPageBudget(b, pages === null ? null : Math.round(Number(pages)));
    book = loadBook(b.root);
    return bookInfo(book);
  });
  handle("book:set-known", (file: string, known: boolean) => {
    const b = requireBook();
    ownYamlUntil = Date.now() + 2500;
    setKnown(b, chapterPath(String(file)), !!known);
    book = loadBook(b.root);
    return bookInfo(book);
  });
  handle("notes:all", (current: { file: string; text: string } | null) => {
    const b = requireBook();
    return chapterFiles(b)
      .map((f) => ({ file: f, notes: inboxNotes(textOf(f, current)) }))
      .filter((c) => c.notes.length);
  });
  handle("study:cards", (current: { file: string; text: string } | null) => {
    const b = requireBook();
    return chapterFiles(b)
      .filter((f) => !b.known.includes(path.basename(f)))
      .map((f) => ({ file: f, cards: allCards(textOf(f, current)) }))
      .filter((c) => c.cards.length);
  });
  handle("book:add-term", (term: string) => {
    const b = requireBook();
    ownYamlUntil = Date.now() + 2500;
    addTerm(b, String(term).slice(0, 40));
    book = loadBook(b.root);
    return bookInfo(book);
  });
  handle("rules:check", (current: { file: string; text: string }) => {
    const b = requireBook();
    const f = chapterPath(String(current.file));
    return hintsFor(b, f, String(current.text), null);
  });
  handle("rules:book", (current: { file: string; text: string } | null) => {
    const b = requireBook();
    const out: { file: string; hints: ReturnType<typeof hintsFor> }[] = [];
    for (const f of chapterFiles(b)) out.push({ file: f, hints: hintsFor(b, f, current && current.file === f ? String(current.text) : null, current) });
    return out.filter((x) => x.hints.length);
  });
  handle("book:outlines", (current: { file: string; text: string } | null) => {
    const b = requireBook();
    return chapterFiles(b).map((f) => {
      let text = "";
      try {
        text = current && current.file === f ? String(current.text) : fs.readFileSync(f, "utf8");
      } catch {
        /* a chapter that cannot be read has no headings to offer */
      }
      return { file: f, headings: outline(text) };
    });
  });
  handle("reading:prepare", async (file: string, text: string) => {
    const b = requireBook();
    const f = chapterPath(String(file));
    await drawDiagrams([String(text)]);
    const html = buildReadingHtml(b, f, String(text), { assetBase: `${SCHEME}://assets/` });
    return { url: registerReading(html) };
  });
  handle("external:open", async (url: string) => {
    if (/^https?:\/\//i.test(String(url))) await shell.openExternal(String(url));
  });
  handle("app:version", () => app.getVersion());
  handle("search:book", (query: string, current: { file: string; text: string } | null): SearchResult => {
    const b = requireBook();
    const own = current && typeof current.file === "string" && typeof current.text === "string" ? current : null;
    const files = chapterFiles(b).map((f) => {
      if (own && own.file === f) return { file: f, text: own.text };
      try {
        return { file: f, text: fs.readFileSync(f, "utf8") };
      } catch {
        return { file: f, text: "" };
      }
    });
    return searchFiles(files, String(query).slice(0, 200));
  });
  handle("clipboard:write", (text: string) => clipboard.writeText(String(text).slice(0, 2000)));
  handle("pages:get", (): PageCounts => counter?.state() ?? { counts: {}, pending: 0, chapters: 0 });
  handle("pages:known", (file: string, pages: number) => {
    if (book && Number.isInteger(pages) && pages > 0 && pages < 5000) counter?.known(chapterPath(String(file)), pages);
  });
  handle("print:run", () => print());
  handle("pdf:open", async (p: string) => {
    const b = requireBook();
    if (path.resolve(String(p)) === outputPdf(b) || inside(path.join(b.root, "build"), path.resolve(String(p)))) await shell.openPath(path.resolve(String(p)));
  });
  handle("pdf:reveal", (p: string) => {
    const b = requireBook();
    if (inside(path.join(b.root, "build"), path.resolve(String(p)))) shell.showItemInFolder(path.resolve(String(p)));
  });
  handle("dialog:unsaved", async (name: string): Promise<UnsavedChoice> => {
    const r = await dialog.showMessageBox(mainWindow!, {
      type: "warning",
      message: `Save changes to ${String(name)}?`,
      detail: "Your changes will be lost if you do not save them.",
      buttons: ["Save", "Don't Save", "Cancel"],
      defaultId: 0,
      cancelId: 2,
    });
    return (["save", "discard", "cancel"] as const)[r.response];
  });
  handle("window:close", () => {
    allowClose = true;
    mainWindow?.close();
  });
  handle("window:cancel-quit", () => {
    quitting = false;
  });
  handle("reading:state", (s: ReadingSnapshot) => {
    const str = (v: unknown, max: number): string | null => (typeof v === "string" ? v.slice(0, max) : null);
    const view = s && (s.view === "reading" || s.view === "edit" || s.view === "source") ? s.view : null;
    readingState = {
      file: str(s?.file, 4096),
      name: str(s?.name, 512),
      view,
      line: typeof s?.line === "number" && Number.isFinite(s.line) ? Math.max(0, Math.floor(s.line)) : null,
      heading: str(s?.heading, 512),
      selection: str(s?.selection, 4000),
      at: Date.now(),
    };
  });
  handle("chrome:info", (): ChromeInfo => ({ custom: CUSTOM_CHROME, platform: process.platform, height: TITLEBAR_H, controlsWidth: process.platform === "win32" ? WINDOW_CONTROLS_W : 0 }));
  handle("menu:model", () => buildMenuModel({ recent: readRecent(), appearance, packaged: app.isPackaged, mcpEnabled }));
  handle("window:minimize", () => mainWindow?.minimize());
  handle("window:toggle-maximize", () => toggleMaximize());
  handle("window:is-maximized", () => !!mainWindow?.isMaximized());
  handle("devtools:toggle", () => {
    if (!app.isPackaged) mainWindow?.webContents.toggleDevTools();
  });
  handle("mcp:toggle", () => {
    setMcpEnabled(!mcpEnabled);
    return mcpEnabled;
  });
}

// ------------------------------------------------------------------------------------------------
// Window and menu
// ------------------------------------------------------------------------------------------------

function send(cmd: MenuCommand): void {
  mainWindow?.webContents.send("menu", cmd);
}

function toggleMaximize(): void {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
}

/** Turn the shared menu model into an Electron template (Windows/Linux). The native menu's bar is hidden but it still
 *  provides the keyboard shortcuts; the renderer draws the matching visual menu from the very same model. */
function toTemplate(items: MenuItem[]): MenuItemConstructorOptions[] {
  return items.map((it): MenuItemConstructorOptions => {
    if (it.type === "separator") return { type: "separator" };
    if (it.type === "submenu") return { label: it.label, enabled: it.enabled, submenu: toTemplate(it.submenu) };
    const out: MenuItemConstructorOptions = { label: it.label, accelerator: it.accelerator, enabled: it.enabled };
    if (it.type === "radio" || it.type === "checkbox") {
      out.type = it.type;
      out.checked = it.checked;
    }
    const a = it.action;
    switch (a.kind) {
      case "role":
        if (a.role === "togglemaximize") out.click = () => toggleMaximize();
        else out.role = a.role;
        break;
      case "command":
        out.click = () => send(a.cmd);
        break;
      case "open-folder":
        out.click = () => mainWindow?.webContents.send("open-folder", a.folder);
        break;
      case "set-theme":
        out.click = () => setAppearance({ theme: a.theme });
        break;
      case "set-warmth":
        out.click = () => setAppearance({ warmth: a.warmth });
        break;
    }
    return out;
  });
}

function winLinuxTemplate(): MenuItemConstructorOptions[] {
  return buildMenuModel({ recent: readRecent(), appearance, packaged: app.isPackaged, mcpEnabled }).map((s) => ({ label: s.label, submenu: toTemplate(s.submenu) }));
}

function buildMenu(): void {
  const mac = process.platform === "darwin";
  if (!mac) {
    Menu.setApplicationMenu(Menu.buildFromTemplate(winLinuxTemplate()));
    return;
  }
  const recent = readRecent();
  const openRecent: MenuItemConstructorOptions[] = recent.length
    ? recent.map((r) => ({ label: `${r.title} (${path.basename(r.folder)})`, click: () => mainWindow?.webContents.send("open-folder", r.folder) }))
    : [{ label: "No recent books", enabled: false }];
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: "appMenu" } as MenuItemConstructorOptions] : []),
    {
      label: "File",
      submenu: [
        { label: "New Chapter...", accelerator: "CmdOrCtrl+N", click: () => send("new-chapter") },
        { type: "separator" },
        { label: "Open Book Folder...", accelerator: "CmdOrCtrl+O", click: () => send("open-book") },
        { label: "Open Recent", submenu: openRecent },
        { type: "separator" },
        { label: "Save", accelerator: "CmdOrCtrl+S", click: () => send("save") },
        { label: "Version History...", accelerator: "CmdOrCtrl+Shift+H", click: () => send("history") },
        { label: "Print PDF", accelerator: "CmdOrCtrl+P", click: () => send("print") },
        {
          label: "Export",
          submenu: [
            { label: "Book as EPUB...", click: () => send("export:epub") },
            { label: "Book as One Web Page...", click: () => send("export:html") },
            { type: "separator" },
            { label: "This Chapter as PDF...", click: () => send("export:chapter-pdf") },
            { label: "Every Chapter as Its Own PDF...", click: () => send("export:all-pdf") },
          ],
        },
        { type: "separator" },
        mac ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { label: "Undo", accelerator: "CmdOrCtrl+Z", click: () => send("undo") },
        { label: "Redo", accelerator: "Shift+CmdOrCtrl+Z", click: () => send("redo") },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
        { type: "separator" },
        { label: "Edit This Paragraph", accelerator: "CmdOrCtrl+E", click: () => send("edit-block") },
        { label: "Add Note", accelerator: "CmdOrCtrl+Shift+M", click: () => send("add-note") },
        { label: "Find in Chapter", accelerator: "CmdOrCtrl+F", click: () => send("find") },
        { label: "Find in Book", accelerator: "CmdOrCtrl+Shift+F", click: () => send("find-book") },
        { label: "Go to Chapter or Heading...", accelerator: "CmdOrCtrl+K", click: () => send("goto") },
        { type: "separator" },
        { label: "Study Flashcards...", accelerator: "CmdOrCtrl+Alt+S", click: () => send("study") },
      ],
    },
    {
      label: "Format",
      submenu: [
        { label: "Bold", accelerator: "CmdOrCtrl+B", click: () => send("format:bold") },
        { label: "Italic", accelerator: "CmdOrCtrl+I", click: () => send("format:italic") },
        { label: "Code", accelerator: "CmdOrCtrl+Alt+C", click: () => send("format:code") },
        { type: "separator" },
        { label: "Section Heading", accelerator: "CmdOrCtrl+2", click: () => send("format:h2") },
        { label: "Subheading", accelerator: "CmdOrCtrl+3", click: () => send("format:h3") },
        { type: "separator" },
        { label: "Bulleted List", accelerator: "CmdOrCtrl+Shift+8", click: () => send("format:bullets") },
        { label: "Numbered List", accelerator: "CmdOrCtrl+Shift+7", click: () => send("format:numbers") },
        { label: "Quote", accelerator: "CmdOrCtrl+Shift+.", click: () => send("format:quote") },
        { label: "Link", accelerator: "CmdOrCtrl+L", click: () => send("format:link") },
        { label: "Insert Table", click: () => send("format:table") },
        { label: "Insert Picture...", click: () => send("insert-image") },
        { label: "Insert Diagram", click: () => send("format:diagram") },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Reading", accelerator: "CmdOrCtrl+Alt+1", click: () => send("view-reading") },
        { label: "Edit", accelerator: "CmdOrCtrl+Alt+2", click: () => send("view-edit") },
        { label: "Source", accelerator: "CmdOrCtrl+Alt+3", click: () => send("view-source") },
        { label: "Switch View", accelerator: "CmdOrCtrl+/", click: () => send("toggle-view") },
        { type: "separator" },
        { label: "Show or Hide Chapters", accelerator: "CmdOrCtrl+\\", click: () => send("toggle-panel") },
        { label: "Focus Mode", accelerator: "CmdOrCtrl+Alt+F", click: () => send("focus") },
        {
          label: "Appearance",
          submenu: THEMES.map((t) => ({
            label: { light: "Light", sepia: "Sepia (warm paper)", dark: "Dark", black: "Black", system: "Match the System" }[t],
            type: "radio" as const,
            checked: appearance.theme === t,
            click: () => setAppearance({ theme: t }),
          })),
        },
        {
          label: "Eye Comfort",
          submenu: ([["Off", 0], ["Low", 0.25], ["Medium", 0.5], ["High", 0.75]] as const).map(([label, w]) => ({
            label: `Warm Tint: ${label}`,
            type: "radio" as const,
            checked: Math.abs(appearance.warmth - w) < 0.13 && (w === 0 ? appearance.warmth === 0 : appearance.warmth > 0),
            click: () => setAppearance({ warmth: w }),
          })),
        },
        { label: "Previous Chapter", accelerator: "CmdOrCtrl+[", click: () => send("prev-chapter") },
        { label: "Next Chapter", accelerator: "CmdOrCtrl+]", click: () => send("next-chapter") },
        { type: "separator" },
        { label: "Zoom In", accelerator: "CmdOrCtrl+=", click: () => send("zoom-in") },
        { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: () => send("zoom-out") },
        { label: "Actual Size", accelerator: "CmdOrCtrl+0", click: () => send("zoom-reset") },
        { label: "Fit Page to Window", accelerator: "CmdOrCtrl+9", click: () => send("zoom-fit") },
        { type: "separator" },
        { label: "Let Claude Read Along", type: "checkbox", checked: mcpEnabled, click: () => setMcpEnabled(!mcpEnabled) },
        { label: "Reload Book", click: () => send("reload-book") },
        ...(app.isPackaged ? [] : [{ type: "separator" } as MenuItemConstructorOptions, { role: "toggleDevTools" } as MenuItemConstructorOptions]),
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 900,
    minHeight: 600,
    title: "Book Studio",
    backgroundColor: resolvedTheme(appearance) === "dark" ? "#242321" : resolvedTheme(appearance) === "black" ? "#000000" : resolvedTheme(appearance) === "sepia" ? "#f2e8d2" : "#f6f5f3",
    show: false,
    // Windows: hide the system title bar and keep only the native buttons, coloured to match the theme (see overlayColors).
    // Linux: no system frame at all; the renderer draws its own buttons. macOS: the standard frame and traffic lights.
    ...(process.platform === "win32" ? { titleBarStyle: "hidden" as const, titleBarOverlay: { ...overlayColors(appearance), height: TITLEBAR_H } } : {}),
    ...(process.platform === "linux" ? { frame: false } : {}),
    // The native menu still exists (it carries the keyboard shortcuts) but its bar is hidden; the renderer draws the menu.
    ...(CUSTOM_CHROME ? { autoHideMenuBar: true } : {}),
    webPreferences: {
      preload: fileURLToPath(new URL("../preload/preload.cjs", import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true,
    },
  });
  mainWindow = win;
  if (CUSTOM_CHROME) win.setMenuBarVisibility(false);
  win.on("maximize", () => win.webContents.send("window:maximize-changed", true));
  win.on("unmaximize", () => win.webContents.send("window:maximize-changed", false));
  // Ctrl + mouse wheel is handled in the renderer now: it zooms only the region under the pointer (the book, the left
  // panel, the menu bar or the report), each independently. The whole-interface zoom factor stays at its saved value.
  win.webContents.on("did-finish-load", applyUiZoom);
  win.once("ready-to-show", () => win.show());
  // Only the app's own pages may load in the window; links go to the operating system's browser.
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(APP_ORIGIN)) e.preventDefault();
  });
  win.webContents.on("will-frame-navigate", (e) => {
    if (!e.url.startsWith(`${SCHEME}://`)) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.on("close", (e) => {
    if (allowClose) return;
    e.preventDefault();
    win.webContents.send("window:query-close");
  });
  win.on("closed", () => {
    counter?.stop();
    mainWindow = null;
    watcher?.close();
    if (quitting) app.quit();
  });
  void win.loadURL(`${APP_ORIGIN}index.html`);
}

app.whenReady().then(() => {
  const ses = session.defaultSession;
  ses.protocol.handle(SCHEME, (req) => handleProtocol(req));
  // Nothing from the network, ever: the book is read offline.
  ses.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !/^(bookstudio|devtools|data|blob):/.test(details.url) }));
  ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  counter = new PageCounter(
    path.join(app.getPath("userData"), "page-counts.json"),
    `${SCHEME}://assets/`,
    registerReading,
    (state) => mainWindow?.webContents.send("pages:update", state),
  );
  painter = new DiagramPainter(path.join(app.getPath("userData"), "diagrams"), `${SCHEME}://assets/`);
  setDiagramProvider(painter.lookup);
  setAppearance(readAppearance());
  uiZoom = readUiZoom();
  if (counter) counter.prepare = (text) => drawDiagrams([text]);
  registerIpc();
  mcpEnabled = readMcpEnabled();
  if (mcpEnabled) startMcp();
  buildMenu();
  createWindow();
  app.on("activate", () => {
    if (!BrowserWindow.getAllWindows().length) {
      allowClose = false;
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
  else allowClose = false;
});

app.on("before-quit", (e) => {
  // Quitting goes through the window's close, so unsaved work is asked about once.
  if (mainWindow && !allowClose) {
    e.preventDefault();
    quitting = true;
    mainWindow.webContents.send("window:query-close");
  }
});

