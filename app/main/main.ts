// Book Studio's main process: windows, the menu, the book on disk, and the print job. The window itself never touches
// the file system; it asks for one named thing at a time through the preload bridge (see app/shared/api.ts).

import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session, shell, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { chapterFiles, ConfigError, isBook, loadBook, outputPdf, writeDefaultBookYaml, type BookConfig } from "../../core/config.ts";
import { listChapters } from "../../core/book.ts";
import { atomicWrite } from "../../core/fsutil.ts";
import { locateProblems, printBook } from "../../core/print.ts";
import { buildReadingHtml } from "../../core/reading.ts";
import { PACKAGE_ROOT, STYLES } from "../../core/paths.ts";
import type { CheckReport } from "../../core/check.ts";
import { applyPrintSwitches, renderPdf } from "../../electron/render-pdf.ts";
import type { BookInfo, ChapterText, MenuCommand, OpenResult, PrintOutcome, UnsavedChoice } from "../shared/api.ts";

const SCHEME = "bookstudio";
const APP_ORIGIN = `${SCHEME}://app/`;

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
  `img-src 'self' data:`,
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

function bookInfo(b: BookConfig): BookInfo {
  return { root: b.root, title: b.title, author: b.author, output: b.output, chapters: listChapters(b, chapterFiles(b)) };
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
      pending.add(rel);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const files = [...pending];
        pending = new Set();
        mainWindow?.webContents.send("book:changed", files);
      }, 250);
    });
    watcher.on("error", () => watcher?.close());
  } catch {
    /* a platform without recursive watching: the app still works, it just does not notice outside edits */
  }
}

function openBook(folder: string): OpenResult {
  try {
    const b = loadBook(folder);
    book = b;
    watch(b);
    remember(b);
    mainWindow?.setTitle(`${b.title} - Book Studio`);
    return { ok: true, book: bookInfo(b) };
  } catch (e) {
    if (e instanceof ConfigError && !fs.existsSync(path.join(path.resolve(folder), "book.yaml")) && fs.existsSync(folder) && fs.statSync(folder).isDirectory()) {
      return { ok: false, reason: "not-a-book", folder: path.resolve(folder) };
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
    return { text: fs.readFileSync(f, "utf8"), mtimeMs: fs.statSync(f).mtimeMs };
  });
  handle("chapter:write", (file: string, text: string) => {
    const f = chapterPath(String(file));
    atomicWrite(f, String(text));
    return { mtimeMs: fs.statSync(f).mtimeMs };
  });
  handle("reading:prepare", (file: string, text: string) => {
    const b = requireBook();
    const f = chapterPath(String(file));
    const html = buildReadingHtml(b, f, String(text), { assetBase: `${SCHEME}://assets/` });
    const id = `r${++readingCounter}`;
    readingPages.set(id, html);
    for (const old of [...readingPages.keys()].slice(0, -6)) readingPages.delete(old);
    return { url: `${SCHEME}://reading/${id}.html` };
  });
  handle("external:open", async (url: string) => {
    if (/^https?:\/\//i.test(String(url))) await shell.openExternal(String(url));
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
}

// ------------------------------------------------------------------------------------------------
// Window and menu
// ------------------------------------------------------------------------------------------------

function send(cmd: MenuCommand): void {
  mainWindow?.webContents.send("menu", cmd);
}

function buildMenu(): void {
  const mac = process.platform === "darwin";
  const recent = readRecent();
  const openRecent: MenuItemConstructorOptions[] = recent.length
    ? recent.map((r) => ({ label: `${r.title} (${path.basename(r.folder)})`, click: () => mainWindow?.webContents.send("open-folder", r.folder) }))
    : [{ label: "No recent books", enabled: false }];
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: "appMenu" } as MenuItemConstructorOptions] : []),
    {
      label: "File",
      submenu: [
        { label: "Open Book Folder...", accelerator: "CmdOrCtrl+O", click: () => send("open-book") },
        { label: "Open Recent", submenu: openRecent },
        { type: "separator" },
        { label: "Save", accelerator: "CmdOrCtrl+S", click: () => send("save") },
        { label: "Print PDF", accelerator: "CmdOrCtrl+P", click: () => send("print") },
        { type: "separator" },
        mac ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
        { type: "separator" },
        { label: "Add Note", accelerator: "CmdOrCtrl+Shift+M", click: () => send("add-note") },
        { label: "Find", accelerator: "CmdOrCtrl+F", click: () => send("find") },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Switch Reading / Source", accelerator: "CmdOrCtrl+/", click: () => send("toggle-view") },
        { label: "Show or Hide Chapters", accelerator: "CmdOrCtrl+\\", click: () => send("toggle-panel") },
        { label: "Previous Chapter", accelerator: "CmdOrCtrl+[", click: () => send("prev-chapter") },
        { label: "Next Chapter", accelerator: "CmdOrCtrl+]", click: () => send("next-chapter") },
        { type: "separator" },
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
    backgroundColor: "#f6f5f3",
    show: false,
    webPreferences: {
      preload: fileURLToPath(new URL("../preload/preload.cjs", import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  mainWindow = win;
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
  registerIpc();
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

