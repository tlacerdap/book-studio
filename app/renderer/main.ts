// Book Studio's window: opens a book folder, shows one chapter at a time as the printed page (reading view) or as markdown
// (source view), keeps the reader's notes in the markdown, and makes the PDF.

import { chapterId } from "../../core/ids.ts";
import { openNotes, parseNotes } from "../../core/notes.ts";
import { outline } from "../../core/notemap.ts";
import type { BookInfo, MenuCommand, OpenResult } from "../shared/api.ts";
import { clear, h } from "./dom.ts";
import { Panel } from "./panel.ts";
import { ReadingView } from "./reading.ts";
import { ReportPanel } from "./report.ts";
import { SourceView } from "./source.ts";

const api = window.studio;
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

interface Doc {
  file: string;
  name: string;
  /** What the editor holds now. */
  text: string;
  /** What this app last read from or wrote to the file. */
  saved: string;
  /** A different version that appeared on disk while there were unsaved edits and the reader chose to keep theirs. */
  ignoredDisk: string | null;
}

let book: BookInfo | null = null;
let doc: Doc | null = null;
let view: "reading" | "source" = "reading";
let busy = false;

const panelEl = $("panel");
const reportEl = $("report");
const viewEls = { reading: $("reading"), source: $("source"), welcome: $("welcome") };

const panel = new Panel(panelEl, {
  onOpenChapter: (file) => void openChapter(file),
  onOutline: (line) => goToLine(line),
  onOpenBook: () => void openDialog(),
});

const reading = new ReadingView(viewEls.reading, api, {
  onTextChange: (text) => void changeText(text),
  onGotoChapter: (id) => {
    const target = book?.chapters.find((c) => chapterId(c.file) === id);
    if (target) void openChapter(target.path);
  },
  onOpenExternal: (url) => void api.openExternal(url),
  onActive: () => renderToolbar(),
  onError: (m) => toast(`Could not lay out this chapter: ${m}`),
  onToast: (m) => toast(m),
  onZoom: () => renderToolbar(),
  onCopy: (text) => void api.copyText(text).then(() => toast(`Copied. Paste it to Claude Code: ${text}`)),
});

const source = new SourceView(viewEls.source, {
  onChange: (text) => {
    if (!doc) return;
    doc.text = text;
    renderToolbar();
    scheduleOutline();
  },
});

const report = new ReportPanel(
  reportEl,
  {
    onOpenProblem: (file, page) => {
      const target = book?.chapters.find((c) => c.file === file);
      if (target) void openChapter(target.path);
      else if (page) toast(`Problem on PDF page ${page}`);
    },
    onOpenPdf: (p) => void api.openPdf(p),
    onReveal: (p) => void api.revealPdf(p),
    onClose: () => report.hide(),
  },
  (file) => book?.chapters.find((c) => c.file === file)?.title ?? file,
);

// ------------------------------------------------------------------------------------------------
// Small things
// ------------------------------------------------------------------------------------------------

let toastTimer: number | undefined;
function toast(message: string): void {
  const t = $("toast");
  t.textContent = message;
  t.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 3500);
}

const dirty = (): boolean => !!doc && doc.text !== doc.saved;
const isMac = api.platform === "darwin";
const mod = isMac ? "Cmd" : "Ctrl";

function showView(which: "reading" | "source" | "welcome"): void {
  for (const [k, el] of Object.entries(viewEls)) el.hidden = k !== which;
}

let outlineTimer: number | undefined;
function scheduleOutline(): void {
  window.clearTimeout(outlineTimer);
  outlineTimer = window.setTimeout(renderPanel, 400);
}

function currentSummary() {
  return book?.chapters.find((c) => c.path === doc?.file) ?? null;
}

function openCount(): number | null {
  return doc ? openNotes(parseNotes(doc.text)).length : null;
}

function renderPanel(): void {
  panel.render(book, doc?.file ?? null, doc ? outline(doc.text) : [], openCount());
}

function renderToolbar(): void {
  const bar = $("toolbar");
  clear(bar);
  const summary = currentSummary();
  bar.append(
    h("button", { class: "icon-btn", type: "button", title: `Show or hide chapters (${mod}+\\)`, "aria-label": "Show or hide chapters", onClick: () => togglePanel() }, "☰"),
    h("div", { class: "tb-title" }, summary ? `${summary.label ? summary.label + ": " : ""}${summary.title}` : book ? book.title : "Book Studio", dirty() ? h("span", { class: "dirty" }, "unsaved") : null),
  );
  if (doc) {
    const seg = h("div", { class: "seg", role: "group", "aria-label": "View" });
    seg.append(
      h("button", { type: "button", "aria-pressed": String(view === "reading"), title: `Reading view (${mod}+/)`, onClick: () => void setView("reading") }, "Reading"),
      h("button", { type: "button", "aria-pressed": String(view === "source"), title: `Source view (${mod}+/)`, onClick: () => void setView("source") }, "Source"),
    );
    const pct = Math.round(reading.zoomLevel * 100);
    bar.append(
      seg,
      ...(view === "reading"
        ? [h(
            "div",
            { class: "seg zoom", role: "group", "aria-label": "Zoom" },
            h("button", { type: "button", title: `Zoom out (${mod}+-)`, "aria-label": "Zoom out", onClick: () => reading.zoomBy(-0.1) }, "\u2212"),
            h("button", { type: "button", class: "pct", title: `Fit page to window (${mod}+9). Actual size: ${mod}+0`, onClick: () => reading.fitWidth() }, `${pct}%`),
            h("button", { type: "button", title: `Zoom in (${mod}++)`, "aria-label": "Zoom in", onClick: () => reading.zoomBy(0.1) }, "+"),
          )]
        : []),
      h("button", { class: "icon-btn", type: "button", title: "How notes for Claude work", "aria-label": "How notes work", onClick: () => toggleHelp() }, "?"),
      h("button", { class: "tb-btn", type: "button", title: `Leave a note for Claude on the selected block (${mod}+Shift+M)`, onClick: () => addNote() }, "Add note"),
      h("button", { class: "tb-btn primary", type: "button", disabled: busy, title: `Make the PDF (${mod}+P)`, onClick: () => void printPdf() }, busy ? "Making PDF..." : "Print PDF"),
    );
  }
}

/** Zoom the page in the reading view, the text size in the source view. */
function zoomTo(step: number, reset = false): void {
  if (view === "reading") {
    if (reset) reading.setZoom(1);
    else reading.zoomBy(step);
    return;
  }
  sourceScale = reset ? 1 : Math.min(2, Math.max(0.6, Math.round((sourceScale + step) * 10) / 10));
  source.setScale(sourceScale);
}

let sourceScale = 1;

/** A small explanation of notes, with the command for the open chapter ready to copy. */
function toggleHelp(): void {
  const old = document.getElementById("help-pop");
  if (old) return old.remove();
  const cmd = reading.instruction();
  const pop = h(
    "div",
    { id: "help-pop", role: "dialog", "aria-label": "How notes work" },
    h("h3", {}, "Notes for Claude"),
    h("p", {}, "Select the exact words you mean (or just click a paragraph), then press Add note. The words you selected are highlighted and saved with the note, so Claude knows precisely what to change. Choose what kind of note it is:"),
    h(
      "ul",
      {},
      h("li", {}, h("b", {}, "Question (Q)"), ": you do not understand it. Claude rewrites the text so you would not have to ask, and tells you what it changed."),
      h("li", {}, h("b", {}, "Change this (E)"), ": you want it edited. Say what, and Claude makes the edit."),
      h("li", {}, h("b", {}, "Lost me (?)"), ": it confused you and you cannot say why."),
    ),
    h("p", {}, "The note is written into this chapter's file, as a comment under the paragraph. It does not show in the book or the PDF. Claude Code finds it when you tell it:"),
    h("div", { class: "cmd" }, h("code", {}, cmd), h("button", { class: "tb-btn", type: "button", onClick: () => void api.copyText(cmd).then(() => toast("Copied. Paste it to Claude Code.")) }, "Copy")),
    h("p", { class: "small" }, "Claude answers under each note. If its answer asks something or is not what you wanted, press Reply and write a new note, then give Claude Code the command again. When you are happy with an answer, press Read to clear the note."),
    h("button", { class: "tb-btn", type: "button", onClick: () => pop.remove() }, "Close"),
  );
  document.body.append(pop);
}

function togglePanel(): void {
  $("app").classList.toggle("panel-closed");
}

// ------------------------------------------------------------------------------------------------
// Opening books and chapters
// ------------------------------------------------------------------------------------------------

async function renderWelcome(message?: { text: string; folder?: string }): Promise<void> {
  const box = viewEls.welcome;
  clear(box);
  const recent = await api.recentBooks();
  const inner = h(
    "div",
    { class: "box" },
    h("h1", {}, "Book Studio"),
    message ? h("p", {}, message.text) : h("p", {}, "Read, annotate and print a book written in markdown. Open a folder that has a book.yaml."),
  );
  if (message?.folder) {
    const folder = message.folder;
    inner.append(
      h(
        "p",
        {},
        h("button", { class: "tb-btn primary", type: "button", onClick: async () => handleOpen(await api.createBook(folder)) }, "Create book.yaml here"),
        " ",
        h("button", { class: "tb-btn", type: "button", onClick: () => void renderWelcome() }, "Not now"),
      ),
    );
  } else {
    inner.append(h("p", {}, h("button", { class: "tb-btn primary", type: "button", onClick: () => void openDialog() }, "Open Book Folder...")));
  }
  if (recent.length) {
    inner.append(
      h(
        "div",
        { class: "recent" },
        h("div", { class: "group" }, "Recent"),
        ...recent.map((r) => h("button", { type: "button", onClick: () => void openFolder(r.folder) }, r.title, h("span", { class: "p" }, r.folder))),
      ),
    );
  }
  box.append(inner);
  showView("welcome");
  renderToolbar();
}

async function openDialog(): Promise<void> {
  if (!(await settle())) return;
  await handleOpen(await api.openBookDialog());
}

async function openFolder(folder: string): Promise<void> {
  if (!(await settle())) return;
  await handleOpen(await api.openBook(folder));
}

async function handleOpen(res: OpenResult): Promise<void> {
  if (res.ok) {
    book = res.book;
    doc = null;
    reading.clearView();
    renderPanel();
    const remembered = localStorage.getItem(`chapter:${book.root}`);
    const first = book.chapters.find((c) => c.path === remembered) ?? book.chapters[0];
    if (first) await openChapter(first.path, { skipGuard: true });
    else await renderWelcome({ text: `${book.title} has no chapters yet. Add markdown files that match the \`chapters\` setting in book.yaml.` });
  } else if (res.reason === "not-a-book") {
    await renderWelcome({ text: `${res.folder} is not a book yet: there is no book.yaml in it. Create one?`, folder: res.folder });
  } else if (res.reason === "error") {
    toast(res.message);
  }
}

/** Ask what to do with unsaved edits before leaving them. True if it is fine to go on. */
async function settle(): Promise<boolean> {
  if (!doc || !dirty()) return true;
  const choice = await api.confirmUnsaved(doc.name);
  if (choice === "cancel") return false;
  if (choice === "save") await save();
  else doc.text = doc.saved;
  return true;
}

async function openChapter(file: string, opts: { skipGuard?: boolean } = {}): Promise<void> {
  if (doc && doc.file === file) return;
  if (!opts.skipGuard && !(await settle())) return;
  try {
    const { text } = await api.readChapter(file);
    const name = file.split(/[\\/]/).pop()!;
    doc = { file, name, text, saved: text, ignoredDisk: null };
  } catch (e) {
    toast((e as Error).message);
    return;
  }
  if (book) localStorage.setItem(`chapter:${book.root}`, file);
  hideBanner();
  source.setText(doc.text);
  renderPanel();
  renderToolbar();
  await showCurrent();
  scrollPanelToCurrent();
}

function scrollPanelToCurrent(): void {
  panelEl.querySelector(".chapter.current")?.scrollIntoView({ block: "nearest" });
}

async function showCurrent(): Promise<void> {
  if (!doc) return;
  showView(view);
  if (view === "reading") {
    viewEls.reading.scrollTop = 0;
    await reading.show(doc.file, doc.text);
  } else {
    source.setText(doc.text);
    source.focus();
  }
}

function adjacent(step: number): void {
  if (!book || !doc) return;
  const i = book.chapters.findIndex((c) => c.path === doc!.file);
  const next = book.chapters[i + step];
  if (next) void openChapter(next.path);
}

// ------------------------------------------------------------------------------------------------
// Editing and saving
// ------------------------------------------------------------------------------------------------

async function save(): Promise<void> {
  if (!doc || !dirty()) return;
  const text = doc.text;
  try {
    await api.writeChapter(doc.file, text);
  } catch (e) {
    toast(`Could not save: ${(e as Error).message}`);
    return;
  }
  if (doc) {
    doc.saved = text;
    doc.ignoredDisk = null;
  }
  hideBanner();
  renderToolbar();
  void refreshBook();
}

/** A note was added, edited or removed in the reading view: keep the whole file in step, on disk too. */
async function changeText(text: string): Promise<void> {
  if (!doc) return;
  doc.text = text;
  source.setText(text);
  await save();
  renderPanel();
}

async function refreshBook(): Promise<void> {
  const info = await api.refreshBook();
  if (info) {
    book = info;
    renderPanel();
    renderToolbar();
  }
}

async function setView(next: "reading" | "source"): Promise<void> {
  if (!doc || next === view) return;
  const line = next === "source" ? reading.activeFirstLine() : null;
  view = next;
  renderToolbar();
  await showCurrent();
  if (next === "source" && line !== null) source.goToLine(line);
}

function goToLine(line: number): void {
  if (view === "source") {
    source.goToLine(line);
    source.focus();
  } else reading.scrollToLine(line);
}

function addNote(): void {
  if (!doc) return;
  if (view !== "reading") {
    void setView("reading").then(() => reading.compose());
    return;
  }
  reading.compose();
}

// ------------------------------------------------------------------------------------------------
// Changes made outside the app
// ------------------------------------------------------------------------------------------------

const banner = $("banner");

function hideBanner(): void {
  banner.hidden = true;
  clear(banner);
}

function showBanner(message: string, actions: { label: string; run: () => void }[]): void {
  clear(banner);
  banner.append(
    h("span", { class: "msg" }, message),
    ...actions.map((a) => h("button", { class: "tb-btn", type: "button", onClick: a.run }, a.label)),
  );
  banner.hidden = false;
}

async function onBookChanged(files: string[]): Promise<void> {
  if (!book) return;
  await refreshBook();
  if (!doc) return;
  const touched = files.some((f) => f.endsWith(".md") || f === "book.yaml");
  if (!touched) return;
  let disk: string;
  try {
    disk = (await api.readChapter(doc.file)).text;
  } catch {
    showBanner(`${doc.name} was moved or deleted outside Book Studio.`, [{ label: "Keep my copy", run: hideBanner }]);
    return;
  }
  if (disk === doc.saved) return; // our own write, or a change that did not touch this chapter
  if (!dirty()) {
    doc.text = disk;
    doc.saved = disk;
    source.setText(disk);
    hideBanner();
    await showCurrent();
    renderPanel();
    renderToolbar();
    return;
  }
  if (disk === doc.ignoredDisk) return;
  showBanner(`${doc.name} changed on disk while you have unsaved edits.`, [
    {
      label: "Reload",
      run: () => {
        if (!doc) return;
        doc.text = disk;
        doc.saved = disk;
        doc.ignoredDisk = null;
        source.setText(disk);
        hideBanner();
        void showCurrent();
        renderToolbar();
      },
    },
    {
      label: "Keep mine",
      run: () => {
        if (doc) doc.ignoredDisk = disk;
        hideBanner();
      },
    },
  ]);
}

// ------------------------------------------------------------------------------------------------
// Find
// ------------------------------------------------------------------------------------------------

const findbar = $("findbar");

function openFind(): void {
  if (!doc) return;
  if (view === "source") return source.openFind();
  clear(findbar);
  const input = h("input", { type: "search", placeholder: "Find in this chapter", "aria-label": "Find" });
  const status = h("span", { class: "status" });
  const run = async (backwards = false) => {
    if (!input.value) return;
    const ok = await reading.find(input.value, backwards);
    status.textContent = ok ? "" : "Not found";
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void run(e.shiftKey);
    else if (e.key === "Escape") closeFind();
  });
  findbar.append(input, h("button", { class: "tb-btn", type: "button", onClick: () => void run(true) }, "Previous"), h("button", { class: "tb-btn", type: "button", onClick: () => void run(false) }, "Next"), status, h("button", { class: "icon-btn", type: "button", "aria-label": "Close find", onClick: closeFind }, "×"));
  findbar.hidden = false;
  input.focus();
}

function closeFind(): void {
  findbar.hidden = true;
  clear(findbar);
  reading.clearFind();
}

// ------------------------------------------------------------------------------------------------
// Print
// ------------------------------------------------------------------------------------------------

async function printPdf(): Promise<void> {
  if (!book || busy) return;
  busy = true;
  renderToolbar();
  report.progress("preparing");
  try {
    await save();
    if (dirty()) return; // saving failed, and the reason is on screen
    const outcome = await api.print();
    report.result(outcome);
    if (outcome.pdf) void api.openPdf(outcome.pdf);
  } catch (e) {
    report.result({ ok: false, error: (e as Error).message });
  } finally {
    busy = false;
    renderToolbar();
  }
}

api.onPrintProgress((p) => report.progress(p.stage));

// ------------------------------------------------------------------------------------------------
// Menu commands and window events
// ------------------------------------------------------------------------------------------------

api.onMenu((cmd: MenuCommand) => {
  switch (cmd) {
    case "toggle-view":
      void setView(view === "reading" ? "source" : "reading");
      break;
    case "save":
      void save();
      break;
    case "add-note":
      addNote();
      break;
    case "toggle-panel":
      togglePanel();
      break;
    case "find":
      openFind();
      break;
    case "prev-chapter":
      adjacent(-1);
      break;
    case "next-chapter":
      adjacent(1);
      break;
    case "print":
      void printPdf();
      break;
    case "reload-book":
      void refreshBook().then(() => doc && onBookChanged([doc.name]));
      break;
    case "open-book":
      void openDialog();
      break;
    case "zoom-in":
      zoomTo(+0.1);
      break;
    case "zoom-out":
      zoomTo(-0.1);
      break;
    case "zoom-reset":
      zoomTo(0, true);
      break;
    case "zoom-fit":
      if (view === "reading") reading.fitWidth();
      break;
  }
});

api.onBookChanged((files) => void onBookChanged(files));
api.onOpenFolder((folder) => void openFolder(folder));

api.onQueryClose(async () => {
  if (doc && dirty()) {
    const choice = await api.confirmUnsaved(doc.name);
    if (choice === "cancel") return void api.cancelQuit();
    if (choice === "save") await save();
    if (choice === "save" && dirty()) return void api.cancelQuit();
  }
  await api.closeWindow();
});

// ------------------------------------------------------------------------------------------------
// Start
// ------------------------------------------------------------------------------------------------

async function start(): Promise<void> {
  renderToolbar();
  const current = await api.currentBook();
  if (current) return handleOpen({ ok: true, book: current });
  const recent = await api.recentBooks();
  if (recent[0]) {
    const res = await api.openBook(recent[0].folder);
    if (res.ok) return handleOpen(res);
  }
  await renderWelcome();
}

void start();
