// Book Studio's window: opens a book folder, shows one chapter at a time as the printed page (reading view) or as markdown
// (source view), keeps the reader's notes in the markdown, and makes the PDF.

import { chapterId } from "../../core/ids.ts";
import { openNotes, parseNotes, stripNotes } from "../../core/notes.ts";
import { outline } from "../../core/notemap.ts";
import type { SearchHit } from "../../core/search.ts";
import type { BookHints, BookInfo, FormatCommand, MenuCommand, OpenResult, PageCounts, WritingHint } from "../shared/api.ts";
import { askText, openHistory, openPalette, paletteItems } from "./dialogs.ts";
import { clear, h } from "./dom.ts";
import { Panel } from "./panel.ts";
import { ReadingView } from "./reading.ts";
import { ReportPanel } from "./report.ts";
import { SearchPanel } from "./search.ts";
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
type ViewMode = "reading" | "split" | "source";
const stored = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const remember = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* not remembered */
  }
};
let view: ViewMode = stored("view-mode") === "split" || stored("view-mode") === "source" ? (stored("view-mode") as ViewMode) : "reading";
/** The way of writing the reader last used, so one key goes back and forth between reading and writing. */
let writingMode: "split" | "source" = view === "source" ? "source" : "split";
let autosaveOn = stored("autosave") !== "0";
let saving = false;
let saveTimer: number | undefined;
let previewTimer: number | undefined;
let hints: WritingHint[] = [];
let checkTimer: number | undefined;
/** True while a chapter is being renamed, moved or deleted, so the file changes that causes are not taken for outside edits. */
let restructuring = false;
let busy = false;
let pageCounts: PageCounts | null = null;

const panelEl = $("panel-body");
const reportEl = $("report");
const viewEls = { reading: $("reading"), source: $("source"), welcome: $("welcome") };

const panel = new Panel(panelEl, {
  onOpenChapter: (file) => void openChapter(file),
  onOutline: (line) => goToLine(line),
  onOpenBook: () => void openDialog(),
  onNewChapter: () => void newChapter(),
  onMoveChapter: (step) => void moveChapter(step),
  onRenameChapter: () => void renameChapter(),
  onDeleteChapter: () => void deleteChapter(),
  onBudget: () => void setBudget(),
  onToggleKnown: () => void toggleKnown(),
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
  onPages: (n) => {
    if (doc && pageCounts) pageCounts.counts[doc.file] = n;
    if (doc) void api.pagesKnown(doc.file, n);
    renderPanel();
    renderToolbar();
  },
  onCopy: (text) => void api.copyText(text).then(() => toast(`Copied. Paste it to Claude Code: ${text}`)),
  onFound: (count, index) => showFound(count, index),
});

const searchPanel = new SearchPanel(
  $("panel-search"),
  $("panel-results"),
  {
    current: () => (doc ? { file: doc.file, text: doc.text } : null),
    chapterInfo: (file) => {
      const c = book?.chapters.find((x) => x.path === file);
      return c ? { num: c.label ? c.label.replace(/^Chapter /, "") : "", title: c.title } : null;
    },
    search: (query, current) => api.searchBook(query, current),
    onOpen: (file, hit, query) => void openHit(file, hit, query),
    onActive: (on) => {
      $("panel-body").hidden = on;
    },
  },
);

let syncTimer: number | undefined;
const source = new SourceView(viewEls.source, {
  onChange: (text) => {
    if (!doc) return;
    doc.text = text;
    renderToolbar();
    renderStatus();
    scheduleOutline();
    scheduleAutosave();
    schedulePreview();
    scheduleCheck();
  },
  onCursor: (line) => {
    if (view !== "split") return;
    window.clearTimeout(syncTimer);
    syncTimer = window.setTimeout(() => reading.revealLine(line), 150);
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

function showView(which: ViewMode | "welcome"): void {
  viewEls.reading.hidden = !(which === "reading" || which === "split");
  viewEls.source.hidden = !(which === "source" || which === "split");
  viewEls.welcome.hidden = which !== "welcome";
  $("stage").classList.toggle("split", which === "split");
  $("formatbar").hidden = !(which === "source" || which === "split");
  $("statusbar").hidden = which === "welcome";
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
  panel.render(book, doc?.file ?? null, doc ? outline(doc.text) : [], openCount(), pageCounts);
}

function renderToolbar(): void {
  const bar = $("toolbar");
  clear(bar);
  const summary = currentSummary();
  bar.append(
    h("button", { class: "icon-btn", type: "button", title: `Show or hide chapters (${mod}+\\)`, "aria-label": "Show or hide chapters", onClick: () => togglePanel() }, "☰"),
    h(
      "div",
      { class: "tb-title" },
      summary ? `${summary.label ? summary.label + ": " : ""}${summary.title}` : book ? book.title : "Book Studio",
      doc && pageCounts?.counts[doc.file] ? h("span", { class: "pages" }, `${pageCounts.counts[doc.file]} pages`) : null,
      dirty() ? h("span", { class: "dirty" }, "unsaved") : null,
    ),
  );
  if (doc) {
    const seg = h("div", { class: "seg", role: "group", "aria-label": "View" });
    seg.append(
      h("button", { type: "button", "aria-pressed": String(view === "reading"), title: `Reading view, with your notes (${mod}+Alt+1)`, onClick: () => void setView("reading") }, "Reading"),
      h("button", { type: "button", "aria-pressed": String(view === "split"), title: `Write on the left, see the pages on the right (${mod}+Alt+2)`, onClick: () => void setView("split") }, "Write"),
      h("button", { type: "button", "aria-pressed": String(view === "source"), title: `Only the markdown (${mod}+Alt+3)`, onClick: () => void setView("source") }, "Source"),
    );
    const pct = Math.round(reading.zoomLevel * 100);
    bar.append(
      seg,
      ...(view !== "source"
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
  if (view !== "source") {
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
    h("p", { class: "small" }, "In the box: press Q, E or ? to pick the kind, type, then Enter to save (Esc cancels)."),
    h("p", { class: "small", id: "help-version" }),
    h("button", { class: "tb-btn", type: "button", onClick: () => pop.remove() }, "Close"),
  );
  document.body.append(pop);
  void api.version().then((v) => {
    const el = document.getElementById("help-version");
    if (el) el.textContent = `Book Studio ${v}`;
  });
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
  void api.version().then((v) => inner.append(h("p", { class: "small" }, `Version ${v}`)));
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
    if (res.evidence > 0) {
      await renderWelcome({ text: `${res.folder} has no book.yaml, but it holds ${res.evidence} chapter${res.evidence === 1 ? "" : "s"} (markdown files that start with a heading). Create the book.yaml for it?`, folder: res.folder });
    } else {
      await renderWelcome({ text: `${res.folder} does not look like a book: it has no book.yaml and no chapters. Open the folder that holds your book (the one with a chapters folder in it). Nothing was written.` });
    }
  } else if (res.reason === "error") {
    toast(res.message);
  }
}

/** Ask what to do with unsaved edits before leaving them. True if it is fine to go on. */
async function settle(): Promise<boolean> {
  if (!doc || !dirty()) return true;
  // With autosave on, leaving a chapter just saves it; the reader is only asked when the file changed under them.
  if (autosaveOn) {
    await save({ auto: true });
    if (!dirty()) return true;
  }
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
  hints = [];
  source.setHints([]);
  void runCheck();
}

function scrollPanelToCurrent(): void {
  panelEl.querySelector(".chapter.current")?.scrollIntoView({ block: "nearest" });
}

async function showCurrent(): Promise<void> {
  if (!doc) return;
  showView(view);
  renderStatus();
  if (view !== "source") {
    viewEls.reading.scrollTop = 0;
    if (view === "split") source.setText(doc.text);
    await reading.show(doc.file, doc.text);
    if (!findbar.hidden && findInput?.value.trim()) reading.findSet(findInput.value);
    if (view === "split") source.focus();
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

async function save(opts: { auto?: boolean } = {}): Promise<void> {
  if (!doc || !dirty()) return;
  window.clearTimeout(saveTimer);
  const file = doc.file;
  const text = doc.text;
  if (opts.auto) {
    // Someone else (Claude Code, an editor) may have changed the file since it was opened: never write over that unasked.
    try {
      const disk = (await api.readChapter(file)).text;
      if (disk !== doc.saved && disk !== text) {
        void onBookChanged([doc.name]);
        return;
      }
    } catch {
      void onBookChanged([doc.name]);
      return;
    }
  }
  saving = true;
  renderStatus();
  try {
    await api.writeChapter(file, text);
  } catch (e) {
    toast(`Could not save: ${(e as Error).message}`);
    return;
  } finally {
    saving = false;
  }
  if (doc && doc.file === file) {
    doc.saved = text;
    doc.ignoredDisk = null;
  }
  hideBanner();
  renderToolbar();
  renderStatus();
  void refreshBook();
}

function scheduleAutosave(): void {
  window.clearTimeout(saveTimer);
  if (!autosaveOn) return;
  saveTimer = window.setTimeout(() => void save({ auto: true }), 1200);
}

/** In the Write view the pages on the right follow what is typed, a moment after typing stops. */
function schedulePreview(): void {
  if (view !== "split") return;
  window.clearTimeout(previewTimer);
  previewTimer = window.setTimeout(() => {
    if (doc && view === "split") void reading.show(doc.file, doc.text);
  }, 800);
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
    searchPanel.refresh();
  }
}

async function setView(next: ViewMode): Promise<void> {
  if (!doc || next === view) return;
  const line = next !== "reading" && view === "reading" ? reading.activeFirstLine() : null;
  view = next;
  remember("view-mode", next);
  if (next !== "reading") writingMode = next;
  window.clearTimeout(previewTimer);
  renderToolbar();
  await showCurrent();
  if (next !== "reading" && line !== null) source.goToLine(line);
}

function goToLine(line: number): void {
  if (view !== "reading") {
    source.goToLine(line);
    source.focus();
  }
  if (view !== "source") reading.scrollToLine(line);
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
  if (!book || restructuring) return;
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
let findInput: HTMLInputElement | null = null;
let findStatus: HTMLElement | null = null;
let findTimer: number | undefined;

/** "3 of 12" beside the find box. */
function showFound(count: number, index: number): void {
  if (!findStatus) return;
  findStatus.textContent = count > 0 ? `${index + 1} of ${count}` : findInput?.value.trim() ? "Not found" : "";
}

/**
 * The find bar of the reading view: every occurrence is marked on the page, Enter goes to the next one and Shift+Enter to
 * the one before. In the source view the editor's own search box is used.
 */
function openFind(initial?: string, opts: { focus?: boolean } = {}): void {
  if (!doc) return;
  if (view === "source" || (view === "split" && source.hasFocus)) {
    if (initial) source.setSearch(initial);
    return source.openFind();
  }
  if (findbar.hidden || !findInput) {
    clear(findbar);
    const input = h("input", { type: "search", placeholder: "Find in this chapter", "aria-label": "Find in this chapter" });
    const status = h("span", { class: "status count", role: "status" });
    const run = () => reading.findSet(input.value);
    input.addEventListener("input", () => {
      window.clearTimeout(findTimer);
      findTimer = window.setTimeout(run, 100);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (input.value.trim() && !status.textContent) run();
        else reading.findStep(e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape") closeFind();
    });
    findbar.append(
      input,
      h("button", { class: "tb-btn", type: "button", onClick: () => reading.findStep(-1) }, "Previous"),
      h("button", { class: "tb-btn", type: "button", onClick: () => reading.findStep(1) }, "Next"),
      status,
      h("button", { class: "icon-btn", type: "button", "aria-label": "Close find", onClick: closeFind }, "\u00d7"),
    );
    findInput = input;
    findStatus = status;
    findbar.hidden = false;
  }
  if (initial !== undefined) findInput.value = initial;
  if (opts.focus !== false) {
    findInput.focus();
    findInput.select();
  }
}

function closeFind(): void {
  findbar.hidden = true;
  clear(findbar);
  findInput = null;
  findStatus = null;
  reading.clearFind();
}

/**
 * The reader picked a result of the book-wide search: open that chapter and show the match. The find bar fills with the
 * same words, so Next and Previous go on through the matches in this chapter.
 */
async function openHit(file: string, hit: SearchHit | null, query: string): Promise<void> {
  await openChapter(file);
  if (!doc || doc.file !== file) return; // the reader cancelled leaving their unsaved edits
  if (view === "source") {
    if (hit && hit.ordinal >= 0) source.showMatch(hit.line - 1, query);
    else source.goToLine(0);
    return;
  }
  if (view === "split" && hit && hit.ordinal >= 0) source.goToLine(hit.line - 1);
  openFind(query, { focus: false });
  if (hit && hit.ordinal < 0) {
    // the chapter's title: it sits above the page text, so just show the top of the chapter
    reading.clearFind();
    viewEls.reading.scrollTop = 0;
    if (findStatus) findStatus.textContent = "";
    return;
  }
  reading.findSet(query, hit && hit.ordinal >= 0 ? { ordinal: hit.ordinal, ctx: hit.ctx } : null);
}

// ------------------------------------------------------------------------------------------------
// The format bar, the status bar, and what they offer
// ------------------------------------------------------------------------------------------------

const FORMAT_BUTTONS: { cmd: FormatCommand | "-"; label: string; title: string; cls?: string }[] = [
  { cmd: "bold", label: "B", title: "Bold", cls: "b" },
  { cmd: "italic", label: "I", title: "Italic", cls: "i" },
  { cmd: "code", label: "</>", title: "Code", cls: "c" },
  { cmd: "-", label: "", title: "" },
  { cmd: "h2", label: "H2", title: "Section heading" },
  { cmd: "h3", label: "H3", title: "Subheading" },
  { cmd: "-", label: "", title: "" },
  { cmd: "bullets", label: "\u2022 List", title: "Bulleted list" },
  { cmd: "numbers", label: "1. List", title: "Numbered list" },
  { cmd: "quote", label: "\u201c Quote", title: "Quote" },
  { cmd: "-", label: "", title: "" },
  { cmd: "link", label: "Link", title: "Link" },
  { cmd: "table", label: "Table", title: "Insert a table" },
];

const KEY_OF: Partial<Record<FormatCommand, string>> = { bold: "B", italic: "I", code: "Alt+C", h2: "2", h3: "3", bullets: "Shift+8", numbers: "Shift+7", quote: "Shift+.", link: "L" };

function renderFormatbar(): void {
  const bar = $("formatbar");
  clear(bar);
  for (const b of FORMAT_BUTTONS) {
    if (b.cmd === "-") {
      bar.append(h("span", { class: "sep" }));
      continue;
    }
    const cmd = b.cmd;
    const key = KEY_OF[cmd];
    bar.append(h("button", { type: "button", class: `fmt ${b.cls ?? ""}`, title: key ? `${b.title} (${mod}+${key})` : b.title, onMousedown: (e: Event) => e.preventDefault(), onClick: () => applyFormat(cmd) }, b.label));
  }
}

function applyFormat(cmd: FormatCommand): void {
  if (!doc) return;
  if (view === "reading") return toast("Switch to Write or Source to format text.");
  const el = document.activeElement as HTMLElement | null;
  // A format key pressed in the find box or a note box is not meant for the chapter.
  if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA") && !el.closest("#source")) return;
  source.format(cmd);
}

const wordsOf = (text: string): number => stripNotes(text).text.split(/\s+/).filter(Boolean).length;

function renderStatus(): void {
  const bar = $("statusbar");
  clear(bar);
  if (!doc) return;
  const words = wordsOf(doc.text);
  const minutes = Math.max(1, Math.round(words / 200));
  const state = saving ? "Saving..." : dirty() ? (autosaveOn ? "Unsaved, saving soon..." : "Unsaved") : "Saved";
  const chapterPages = pageCounts?.counts[doc.file];
  bar.append(
    h("span", { class: "st" }, `${words.toLocaleString()} words`),
    h("span", { class: "st dim", title: "At 200 words a minute" }, `${minutes} min read`),
    chapterPages ? h("span", { class: "st dim" }, `${chapterPages} page${chapterPages === 1 ? "" : "s"}`) : "",
    h("span", { class: "grow" }),
    h(
      "button",
      { class: `st-btn${hints.length ? " has-hints" : ""}`, type: "button", title: hints.length ? "Open the list of things to look at" : "Nothing to flag in this chapter. Click to check the whole book.", onClick: () => void toggleHints() },
      hints.length ? `${hints.length} hint${hints.length === 1 ? "" : "s"}` : "No hints",
    ),
    h("span", { class: `st${dirty() && !autosaveOn ? " warn" : " dim"}` }, state),
    h(
      "button",
      {
        class: "st-btn",
        type: "button",
        title: autosaveOn ? "Chapters save themselves a moment after you stop typing. Click to turn this off." : "Autosave is off: save with " + mod + "+S. Click to turn it on.",
        onClick: () => {
          autosaveOn = !autosaveOn;
          remember("autosave", autosaveOn ? "1" : "0");
          if (autosaveOn) scheduleAutosave();
          renderStatus();
        },
      },
      autosaveOn ? "Autosave on" : "Autosave off",
    ),
  );
}

// ------------------------------------------------------------------------------------------------
// Chapters: new, rename, move, delete, and go to
// ------------------------------------------------------------------------------------------------

/** Run a change to the chapter files, then pick the book up again and open the chapter it returns. */
async function restructure(change: () => Promise<{ ok: true; file: string } | { ok: false; message: string } | null>): Promise<void> {
  if (!(await settle())) return;
  restructuring = true;
  try {
    const result = await change();
    if (!result) return;
    if (!result.ok) return toast(result.message);
    const info = await api.refreshBook();
    if (info) book = info;
    doc = null;
    reading.clearView();
    await openChapter(result.file, { skipGuard: true });
  } finally {
    restructuring = false;
  }
}

async function newChapter(): Promise<void> {
  if (!book) return;
  const title = await askText("New chapter", { confirm: "Create", hint: "Its file name is built from the title. You can rename it later." });
  if (!title) return;
  await restructure(() => api.createChapter(title));
  if (doc && view === "reading") await setView("split");
}

async function renameChapter(): Promise<void> {
  if (!doc) return;
  const c = currentSummary();
  const title = await askText("Rename chapter", { initial: c?.title ?? "", confirm: "Rename", hint: "This changes the file name. Links from other chapters follow it. The title inside the chapter is yours to edit." });
  if (!title) return;
  const file = doc.file;
  await restructure(() => api.renameChapter(file, title));
}

async function moveChapter(step: -1 | 1): Promise<void> {
  if (!doc) return;
  const file = doc.file;
  await restructure(() => api.moveChapter(file, step));
}

async function deleteChapter(): Promise<void> {
  if (!doc || !book) return;
  const file = doc.file;
  const list = book.chapters;
  const i = list.findIndex((c) => c.path === file);
  const neighbour = list[i + 1] ?? list[i - 1] ?? null;
  if (!(await settle())) return;
  restructuring = true;
  try {
    if (!(await api.deleteChapter(file))) return;
    const info = await api.refreshBook();
    if (info) book = info;
    doc = null;
    reading.clearView();
    if (neighbour) await openChapter(neighbour.path, { skipGuard: true });
    else await renderWelcome({ text: "The book has no chapters now. Add one with File > New Chapter." });
    renderPanel();
  } finally {
    restructuring = false;
  }
}

async function gotoPalette(): Promise<void> {
  if (!book) return;
  const outlines = await api.outlines(doc ? { file: doc.file, text: doc.text } : null);
  const items = paletteItems(book.chapters, outlines);
  openPalette(items, (item) => {
    void (async () => {
      await openChapter(item.file);
      if (doc && doc.file === item.file && item.kind === "heading") goToLine(item.line);
    })();
  });
}

/** The page limit of the book (book.yaml's `pages`). */
async function setBudget(): Promise<void> {
  if (!book) return;
  const answer = await askText("Page limit", {
    initial: book.pages === null ? "" : String(book.pages),
    confirm: "Set",
    allowEmpty: true,
    hint: "How many numbered pages the book should not go beyond. The side panel shows how far you are. Leave it empty for no limit. It is kept in book.yaml.",
  });
  if (answer === null) return;
  const n = answer === "" ? null : Number(answer);
  if (n !== null && (!Number.isInteger(n) || n < 1 || n > 5000)) return toast("Write a whole number of pages, such as 126.");
  try {
    const info = await api.setBudget(n);
    if (info) book = info;
    renderPanel();
    toast(n === null ? "No page limit." : `Page limit: ${n}.`);
  } catch (e) {
    toast((e as Error).message);
  }
}

/** Keep a chapter's file in the folder but leave it out of the PDF, or put it back. */
async function toggleKnown(): Promise<void> {
  if (!doc || !book) return;
  const name = doc.name;
  const now = !book.known.includes(name);
  try {
    const info = await api.setKnown(doc.file, now);
    if (info) book = info;
    renderPanel();
    renderToolbar();
    toast(now ? `${name} is marked as known: it stays in the folder and is left out of the PDF.` : `${name} is back in the PDF.`);
  } catch (e) {
    toast((e as Error).message);
  }
}

// ---- Writing hints --------------------------------------------------------------------------

function scheduleCheck(): void {
  window.clearTimeout(checkTimer);
  checkTimer = window.setTimeout(() => void runCheck(), 900);
}

async function runCheck(): Promise<void> {
  if (!doc) return;
  const file = doc.file;
  try {
    const found = await api.checkWriting({ file, text: doc.text });
    if (!doc || doc.file !== file) return;
    hints = found;
    source.setHints(found);
    renderStatus();
    if (document.getElementById("hints-pop")) void showHints(false);
  } catch {
    /* a check that cannot run is not worth an error */
  }
}

async function toggleHints(): Promise<void> {
  if (document.getElementById("hints-pop")) return void document.getElementById("hints-pop")!.remove();
  await showHints(false);
}

/** A list of what the checks found: in this chapter, or (on request) in every chapter. */
async function showHints(whole: boolean): Promise<void> {
  document.getElementById("hints-pop")?.remove();
  if (!doc || !book) return;
  let groups: BookHints[] = [];
  if (whole) groups = await api.checkBookWriting({ file: doc.file, text: doc.text });
  else groups = hints.length ? [{ file: doc.file, hints }] : [];
  const total = groups.reduce((n, g) => n + g.hints.length, 0);
  const pop = h("div", { id: "hints-pop", role: "dialog", "aria-label": "Writing hints" });
  pop.append(
    h(
      "div",
      { class: "hp-head" },
      h("b", {}, whole ? `${total} hint${total === 1 ? "" : "s"} in the whole book` : total ? `${total} hint${total === 1 ? "" : "s"} in this chapter` : "Nothing to flag in this chapter"),
      h("span", { class: "grow" }),
      whole ? null : h("button", { class: "tb-btn", type: "button", onClick: () => void showHints(true) }, "Check the whole book"),
      h("button", { class: "icon-btn", type: "button", "aria-label": "Close", onClick: () => pop.remove() }, "\u00d7"),
    ),
    h("p", { class: "small" }, "The book's own rules (the `rules` in book.yaml) and acronyms used before they are explained. Words are underlined in the editor."),
  );
  const list = h("div", { class: "hp-list" });
  for (const g of groups) {
    const chapter = book.chapters.find((c) => c.path === g.file);
    if (whole) list.append(h("div", { class: "hp-chapter" }, chapter ? `${chapter.label ? chapter.label.replace(/^Chapter /, "") + "  " : ""}${chapter.title}` : g.file));
    for (const hint of g.hints) {
      const go = async () => {
        if (!doc || doc.file !== g.file) await openChapter(g.file);
        if (view === "reading") await setView(writingMode);
        source.goToLine(hint.line);
        source.focus();
      };
      list.append(
        h(
          "div",
          { class: "hp-item" },
          h("button", { class: "hp-go", type: "button", onClick: () => void go() }, h("span", { class: "hp-word" }, hint.text), h("span", { class: "hp-msg" }, hint.message), h("span", { class: "hp-line" }, `line ${hint.line + 1}`)),
          hint.kind === "term"
            ? h(
                "button",
                {
                  class: "hp-skip",
                  type: "button",
                  title: `${hint.text} is known to the reader: never ask about it again (kept in book.yaml)`,
                  onClick: () =>
                    void api.addTerm(hint.text).then((info) => {
                      if (info) book = info;
                      return runCheck().then(() => showHints(whole));
                    }),
                },
                "Ignore",
              )
            : null,
        ),
      );
    }
  }
  pop.append(list);
  document.body.append(pop);
}

async function showHistory(): Promise<void> {
  if (!doc) return;
  await save();
  const file = doc.file;
  await openHistory(
    api,
    file,
    doc.name,
    () => (doc ? doc.text : ""),
    (text) => {
      if (!doc || doc.file !== file) return;
      doc.text = text;
      source.setText(text);
      void save().then(() => showCurrent());
      toast("Restored. The version you replaced is still in the history.");
    },
  );
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
api.onPageCounts((p) => {
  pageCounts = p;
  renderPanel();
  renderToolbar();
});

// ------------------------------------------------------------------------------------------------
// Menu commands and window events
// ------------------------------------------------------------------------------------------------

api.onMenu((cmd: MenuCommand) => {
  switch (cmd) {
    case "toggle-view":
      void setView(view === "reading" ? writingMode : "reading");
      break;
    case "view-reading":
      void setView("reading");
      break;
    case "view-split":
      void setView("split");
      break;
    case "view-source":
      void setView("source");
      break;
    case "new-chapter":
      void newChapter();
      break;
    case "history":
      void showHistory();
      break;
    case "goto":
      void gotoPalette();
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
    case "find-book":
      if ($("app").classList.contains("panel-closed")) togglePanel();
      searchPanel.focus();
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
      if (view !== "source") reading.fitWidth();
      break;
    default:
      if (cmd.startsWith("format:")) applyFormat(cmd.slice(7) as FormatCommand);
  }
});

api.onBookChanged((files) => void onBookChanged(files));
api.onOpenFolder((folder) => void openFolder(folder));

api.onQueryClose(async () => {
  if (doc && dirty() && autosaveOn) await save({ auto: true });
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
  renderFormatbar();
  renderToolbar();
  pageCounts = await api.pageCounts();
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
