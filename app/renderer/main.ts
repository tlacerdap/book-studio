// Book Studio's window: opens a book folder, shows one chapter at a time as the printed page (reading view) or as markdown
// (source view), keeps the reader's notes in the markdown, and makes the PDF.

import { chapterId } from "../../core/ids.ts";
import { openNotes, parseNotes, stripNotes } from "../../core/notes.ts";
import { outline } from "../../core/notemap.ts";
import type { SearchHit } from "../../core/search.ts";
import type { Appearance, BookHints, BookInfo, ExportKind, FormatCommand, MenuCommand, OpenResult, PageCounts, ReadingSnapshot, WritingHint } from "../shared/api.ts";
import { askText, openHistory, openPalette, paletteItems } from "./dialogs.ts";
import { clear, h } from "./dom.ts";
import { Panel } from "./panel.ts";
import { EditView } from "./edit.ts";
import { ReadingView } from "./reading.ts";
import { ReportPanel } from "./report.ts";
import { NotesPanel } from "./inbox.ts";
import { SearchPanel } from "./search.ts";
import { openStudy } from "./study.ts";
import { SourceView } from "./source.ts";
import { setupTitlebar, type Titlebar } from "./titlebar.ts";

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
let titlebar: Titlebar | null = null;
type ViewMode = "reading" | "edit" | "source";
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
let view: ViewMode = stored("view-mode") === "source" ? "source" : stored("view-mode") === "edit" ? "edit" : "reading";
/** The view that shows the markdown. */
let writingMode: "edit" | "source" = view === "source" ? "source" : "edit";
let autosaveOn = stored("autosave") !== "0";
let saving = false;
let saveTimer: number | undefined;
let hints: WritingHint[] = [];
let checkTimer: number | undefined;
/** True while a chapter is being renamed, moved or deleted, so the file changes that causes are not taken for outside edits. */
let restructuring = false;
let busy = false;
let pageCounts: PageCounts | null = null;

const panelEl = $("panel-body");
const reportEl = $("report");
const viewEls = { reading: $("reading"), edit: $("edit"), source: $("source"), welcome: $("welcome") };

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
  onActive: () => {
    renderToolbar();
    pushReading();
  },
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
  onEditRequest: (line) => void openEditAt(line),
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
      searchActive = on;
      showPanelTab();
    },
  },
);

/** The left panel shows the chapters or the notes, unless a search is showing its results instead. */
let panelTab: "chapters" | "notes" = stored("panel-tab") === "notes" ? "notes" : "chapters";
let searchActive = false;

const notesPanel = new NotesPanel($("panel-notes"), {
  load: () => api.allNotes(doc ? { file: doc.file, text: doc.text } : null),
  chapterInfo: (file) => {
    const c = book?.chapters.find((x) => x.path === file);
    return c ? { num: c.label ? c.label.replace(/^Chapter /, "") : "", title: c.title } : null;
  },
  onOpen: (file, note) => void openNote(file, note.anchor),
});

function showPanelTab(): void {
  $("panel-body").hidden = searchActive || panelTab !== "chapters";
  $("panel-notes").hidden = searchActive || panelTab !== "notes";
  $("panel-tabs").hidden = searchActive;
  renderTabs();
}

function setPanelTab(tab: "chapters" | "notes"): void {
  panelTab = tab;
  remember("panel-tab", tab);
  showPanelTab();
  if (tab === "notes") void notesPanel.refresh();
}

function renderTabs(): void {
  const tabs = $("panel-tabs");
  clear(tabs);
  const open = notesPanel.openCount;
  tabs.append(
    h("button", { type: "button", role: "tab", "aria-selected": String(panelTab === "chapters"), onClick: () => setPanelTab("chapters") }, "Chapters"),
    h("button", { type: "button", role: "tab", "aria-selected": String(panelTab === "notes"), title: "Every question and change request in the book", onClick: () => setPanelTab("notes") }, "Notes", open ? h("span", { class: "tab-n" }, String(open)) : ""),
    h("button", { type: "button", class: "tab-study", title: `Flashcards from the interview questions (${mod}+Alt+S)`, onClick: () => void study() }, "Study"),
  );
}

/** Show a note in the book: open its chapter in the Reading view at the paragraph it is about. */
async function openNote(file: string, anchor: number): Promise<void> {
  await openChapter(file);
  if (!doc || doc.file !== file) return;
  if (view !== "reading") await setView("reading");
  reading.revealLine(Math.max(0, anchor));
}

let focusOn = false;
let focusRestore: ViewMode | null = null;

/** Hide everything but the text: only the source view, in a narrow column. Esc (or the same menu item) comes back. */
function toggleFocus(): void {
  if (!doc) return;
  focusOn = !focusOn;
  $("app").classList.toggle("focus", focusOn);
  if (focusOn) {
    focusRestore = view;
    if (view !== "source") void setView("source");
    toast("Focus mode. Press Esc to come back.");
    source.focus();
  } else {
    const back = focusRestore;
    focusRestore = null;
    if (back && back !== view) void setView(back);
  }
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && focusOn && !document.querySelector(".scrim")) {
    e.preventDefault();
    toggleFocus();
  }
});

async function study(): Promise<void> {
  if (!book) return;
  const chapters = await api.studyCards(doc ? { file: doc.file, text: doc.text } : null);
  openStudy({
    bookRoot: book.root,
    chapters,
    currentFile: doc?.file ?? null,
    chapterTitle: (file) => {
      const c = book?.chapters.find((x) => x.path === file);
      return c ? `${c.label ? c.label.replace(/^Chapter /, "") + " " : ""}${c.title}` : file;
    },
    onShow: (file, line) =>
      void (async () => {
        await openChapter(file);
        if (doc && doc.file === file) {
          if (view === "reading") reading.revealLine(line);
          else source.goToLine(line);
        }
      })(),
  });
}

const source = new SourceView(viewEls.source, {
  onChange: (text) => {
    if (!doc) return;
    doc.text = text;
    renderToolbar();
    renderStatus();
    scheduleOutline();
    scheduleAutosave();
    scheduleCheck();
  },
  onImages: (files) => void addPictures(files),
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

const edit = new EditView(viewEls.edit, {
  onChange: (text) => {
    if (!doc) return;
    doc.text = text;
    renderToolbar();
    renderStatus();
    scheduleOutline();
    scheduleAutosave();
    scheduleCheck();
  },
  imageUrl: (src) => pictureUrl(src),
  onPictures: (files) => keepPictures(files),
  askLink: (current) => askText("Link", { initial: current, confirm: "Set", allowEmpty: true, hint: "A web address, or the file name of another chapter. Leave it empty to take the link off." }),
  onFound: (count, index) => showFound(count, index),
  onToast: (m) => toast(m),
});

// ------------------------------------------------------------------------------------------------
// Appearance: the reading theme and the warm tint
// ------------------------------------------------------------------------------------------------

let appearance: Appearance = { theme: "light", warmth: 0 };
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
const warmEl = h("div", { id: "warm", "aria-hidden": "true" });
document.body.append(warmEl);

const THEME_TILES: { theme: Appearance["theme"]; label: string; page: string; ink: string }[] = [
  { theme: "light", label: "Light", page: "#ffffff", ink: "#1f1e1d" },
  { theme: "sepia", label: "Sepia", page: "#f9f2e0", ink: "#3b2f1e" },
  { theme: "dark", label: "Dark", page: "#262523", ink: "#e6e2d9" },
  { theme: "black", label: "Black", page: "#0d0d0d", ink: "#e8e6e1" },
  { theme: "system", label: "System", page: "linear-gradient(135deg, #ffffff 50%, #262523 50%)", ink: "#8a8782" },
];

function resolvedTheme(): "light" | "sepia" | "dark" | "black" {
  return appearance.theme === "system" ? (systemDark.matches ? "dark" : "light") : appearance.theme;
}

function applyAppearance(a: Appearance): void {
  appearance = a;
  const theme = resolvedTheme();
  document.documentElement.dataset.theme = theme;
  reading.setTheme(theme);
  edit.setTheme(theme);
  warmEl.style.opacity = String(Math.round(a.warmth * 35) / 100);
  if (document.getElementById("theme-pop")) showThemePopover(true);
}

systemDark.addEventListener("change", () => applyAppearance(appearance));
api.onAppearance((a) => applyAppearance(a));

/** The reading themes and the warm tint, in a small panel under the toolbar. */
function showThemePopover(reopen = false): void {
  const old = document.getElementById("theme-pop");
  if (old) {
    old.remove();
    if (!reopen) return;
  }
  const pop = h("div", { id: "theme-pop", role: "dialog", "aria-label": "Appearance" }, h("div", { class: "tp-title" }, "Reading theme"));
  const grid = h("div", { class: "tp-grid" });
  for (const t of THEME_TILES) {
    grid.append(
      h(
        "button",
        { class: "tp-tile", type: "button", "aria-pressed": String(appearance.theme === t.theme), onClick: () => void api.setAppearance({ theme: t.theme }) },
        h("span", { class: "tp-swatch", style: `background:${t.page};color:${t.ink}` }, "Aa"),
        h("span", { class: "tp-name" }, t.label),
      ),
    );
  }
  const slider = h("input", { type: "range", min: "0", max: "100", step: "5", value: String(Math.round(appearance.warmth * 100)), "aria-label": "Warm tint" }) as HTMLInputElement;
  const value = h("span", { class: "tp-val" }, appearance.warmth ? `${Math.round(appearance.warmth * 100)}%` : "Off");
  slider.addEventListener("input", () => {
    value.textContent = Number(slider.value) ? `${slider.value}%` : "Off";
    warmEl.style.opacity = String((Number(slider.value) * 0.35) / 100);
  });
  slider.addEventListener("change", () => void api.setAppearance({ warmth: Number(slider.value) / 100 }));
  pop.append(
    grid,
    h("div", { class: "tp-title" }, "Eye comfort"),
    h("div", { class: "tp-row" }, h("span", {}, "Warm tint"), slider, value),
    h("p", { class: "tp-note" }, "A warm tint takes the blue out of the screen, which helps in the evening. Sepia and Dark change the pages too."),
  );
  document.body.append(pop);
}

// One listener for the panel's life: a click anywhere else, or Esc, closes it.
document.addEventListener("mousedown", (e) => {
  const pop = document.getElementById("theme-pop");
  if (pop && !pop.contains(e.target as Node) && !(e.target as HTMLElement).closest(".theme-btn")) pop.remove();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") document.getElementById("theme-pop")?.remove();
});

/** Where a picture written in the open chapter as `src` is served from. */
function pictureUrl(src: string): string {
  if (/^data:image\//i.test(src)) return src;
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || !book || !doc) return "";
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const file = norm(doc.file);
  let rel: string;
  try {
    rel = decodeURI(src);
  } catch {
    rel = src;
  }
  const parts: string[] = [];
  for (const seg of `${file.slice(0, file.lastIndexOf("/"))}/${rel}`.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== "." && seg !== "") parts.push(seg);
  }
  const rootParts = norm(book.root).split("/").filter(Boolean);
  if (rootParts.some((p, i) => parts[i] !== p)) return "";
  return `bookstudio://book/${parts.slice(rootParts.length).map(encodeURIComponent).join("/")}`;
}

const dirty = (): boolean => !!doc && doc.text !== doc.saved;
const isMac = api.platform === "darwin";
const mod = isMac ? "Cmd" : "Ctrl";

function showView(which: ViewMode | "welcome"): void {
  viewEls.reading.hidden = which !== "reading";
  viewEls.edit.hidden = which !== "edit";
  viewEls.source.hidden = which !== "source";
  viewEls.welcome.hidden = which !== "welcome";
  // The format bar is for writing: in the Edit and Source views.
  $("formatbar").hidden = !(which === "edit" || which === "source");
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
  titlebar?.setTitle(book ? book.title : "Book Studio");
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
      h("button", { type: "button", "aria-pressed": String(view === "reading"), title: `The pages as they print, with your notes (${mod}+Alt+1)`, onClick: () => void setView("reading") }, "Reading"),
      h("button", { type: "button", "aria-pressed": String(view === "edit"), title: `Edit the page itself: what you type is written as markdown (${mod}+Alt+2)`, onClick: () => void setView("edit") }, "Edit"),
      h("button", { type: "button", "aria-pressed": String(view === "source"), title: `The whole chapter as markdown (${mod}+Alt+3)`, onClick: () => void setView("source") }, "Source"),
    );
    const pct = Math.round((view === "edit" ? editZoom : reading.zoomLevel) * 100);
    bar.append(
      seg,
      ...(view !== "source"
        ? [h(
            "div",
            { class: "seg zoom", role: "group", "aria-label": "Zoom" },
            h("button", { type: "button", title: `Zoom out (${mod}+-)`, "aria-label": "Zoom out", onClick: () => zoomTo(-0.1) }, "\u2212"),
            h("button", { type: "button", class: "pct", title: view === "edit" ? `Actual size: ${mod}+0` : `Fit page to window (${mod}+9). Actual size: ${mod}+0`, onClick: () => (view === "edit" ? zoomTo(0, true) : reading.fitWidth()) }, `${pct}%`),
            h("button", { type: "button", title: `Zoom in (${mod}++)`, "aria-label": "Zoom in", onClick: () => zoomTo(0.1) }, "+"),
          )]
        : []),
      h("button", { class: "icon-btn theme-btn", type: "button", title: "Reading theme and eye comfort (sepia, dark, warm tint...)", "aria-label": "Appearance", onClick: () => showThemePopover() }, "\u25d0"),
      h("button", { class: "icon-btn", type: "button", title: "How notes for Claude work", "aria-label": "How notes work", onClick: () => toggleHelp() }, "?"),
      h("button", { class: "tb-btn", type: "button", title: `Leave a note for Claude on the selected block (${mod}+Shift+M)`, onClick: () => addNote() }, "Add note"),
      h("button", { class: "tb-btn primary", type: "button", disabled: busy, title: `Make the PDF (${mod}+P)`, onClick: () => void printPdf() }, busy ? "Making PDF..." : "Print PDF"),
    );
  }
}

/** Zoom the page in the reading view, the text size in the source view. */
let editZoom = 1;
function zoomTo(step: number, reset = false): void {
  if (view === "edit") {
    editZoom = reset ? 1 : Math.min(2, Math.max(0.6, Math.round((editZoom + step) * 10) / 10));
    edit.setZoom(editZoom);
    renderToolbar();
    return;
  }
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
  pushReading();
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
    void api.editCss().then((css) => edit.setCss(css));
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
  if (view === "reading") {
    viewEls.reading.scrollTop = 0;
    await reading.show(doc.file, doc.text);
    if (!findbar.hidden && findInput?.value.trim()) reading.findSet(findInput.value);
  } else if (view === "edit") {
    viewEls.edit.scrollTop = 0;
    edit.load(doc.text);
    edit.setZoom(editZoom);
    edit.focus();
  } else {
    source.setText(doc.text);
    source.focus();
  }
  pushReading();
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
  if (view === "edit") edit.flush();
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

/** A note was added, edited or removed in the reading view: keep the whole file in step, on disk too. */
async function changeText(text: string): Promise<void> {
  if (!doc) return;
  doc.text = text;
  source.setText(text);
  await save();
  renderPanel();
  renderStatus();
  scheduleCheck();
  // A paragraph edited in place changes the page; a note does not (the page is only laid out again if its text changed).
  if (view === "reading") await reading.show(doc.file, doc.text);
}

async function refreshBook(): Promise<void> {
  const info = await api.refreshBook();
  if (info) {
    book = info;
    renderPanel();
    renderToolbar();
    searchPanel.refresh();
    if (panelTab === "notes") void notesPanel.refresh();
    else if (!notesPanel.openCount) void notesPanel.refresh().then(renderTabs);
  }
}

async function setView(next: ViewMode): Promise<void> {
  if (!doc || next === view) return;
  // Where the reader was, so the next view opens at the same place.
  const line = view === "reading" ? reading.activeFirstLine() : view === "edit" ? edit.currentLine() : source.cursorLine;
  if (view === "edit") {
    edit.flush();
    window.clearTimeout(saveTimer);
  }
  view = next;
  remember("view-mode", next);
  if (next !== "reading") writingMode = next;
  renderToolbar();
  await showCurrent();
  if (line === null) return;
  if (next === "source") source.goToLine(line);
  else if (next === "edit") edit.scrollToLine(line);
  else reading.revealLine(line);
}

/** The pencil in the Reading view: open that paragraph in the Edit view. */
async function openEditAt(line: number): Promise<void> {
  if (!doc) return;
  if (view !== "edit") {
    view = "edit";
    remember("view-mode", "edit");
    writingMode = "edit";
    renderToolbar();
    await showCurrent();
  }
  edit.scrollToLine(line);
  edit.focus();
}

function goToLine(line: number): void {
  if (view === "source") {
    source.goToLine(line);
    source.focus();
  } else if (view === "edit") {
    edit.scrollToLine(line);
    edit.focus();
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
  if (!book || restructuring) return;
  if (view === "edit") edit.flush();
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
  if (view === "source") {
    if (initial) source.setSearch(initial);
    return source.openFind();
  }
  if (findbar.hidden || !findInput) {
    clear(findbar);
    const input = h("input", { type: "search", placeholder: "Find in this chapter", "aria-label": "Find in this chapter" });
    const status = h("span", { class: "status count", role: "status" });
    const run = () => (view === "edit" ? edit.findSet(input.value) : reading.findSet(input.value));
    input.addEventListener("input", () => {
      window.clearTimeout(findTimer);
      findTimer = window.setTimeout(run, 100);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (input.value.trim() && !status.textContent) run();
        else stepFind(e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape") closeFind();
    });
    findbar.append(
      input,
      h("button", { class: "tb-btn", type: "button", onClick: () => stepFind(-1) }, "Previous"),
      h("button", { class: "tb-btn", type: "button", onClick: () => stepFind(1) }, "Next"),
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

function stepFind(delta: number): void {
  if (view === "edit") edit.findStep(delta);
  else reading.findStep(delta);
}

function closeFind(): void {
  findbar.hidden = true;
  clear(findbar);
  findInput = null;
  findStatus = null;
  reading.clearFind();
  edit.clearFind();
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
  if (view === "edit") {
    openFind(query, { focus: false });
    edit.scrollToLine(hit && hit.ordinal >= 0 ? hit.line - 1 : 0);
    if (hit && hit.ordinal >= 0) edit.findSet(query);
    return;
  }
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
  { cmd: "diagram", label: "Diagram", title: "Insert a diagram, written as text and drawn by the app" },
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

/** Write the book or a chapter in another shape (EPUB, a web page, PDFs). What is open is saved first. */
async function exportBook(kind: ExportKind): Promise<void> {
  if (!book) return;
  if (kind === "chapter-pdf" && !doc) return;
  await save();
  const off = api.onExportProgress((m) => toast(m));
  try {
    const res = await api.exportBook(kind, doc?.file ?? null);
    if (res.ok) toast(res.message);
    else if (!res.cancelled) toast(res.message);
  } finally {
    off();
  }
}

/** Pictures pasted or dropped into the text: keep them in the book and put them in the chapter. */
async function keepPictures(files: File[]): Promise<string[] | null> {
  if (!doc) return null;
  const lines: string[] = [];
  for (const f of files) {
    const res = await api.saveImage(doc.file, new Uint8Array(await f.arrayBuffer()));
    if (!res.ok) {
      toast(res.message);
      return null;
    }
    lines.push(...res.markdown);
  }
  toast(`${lines.length === 1 ? "Picture" : "Pictures"} kept in the book's images folder. Write what it shows between the brackets.`);
  return lines;
}

async function addPictures(files: File[]): Promise<void> {
  const lines = await keepPictures(files);
  if (lines) source.insertPictures(lines);
}

/** Format > Insert Picture: choose files from disk. */
async function insertPicture(): Promise<void> {
  if (!doc) return;
  if (view === "reading") await setView(writingMode);
  const res = await api.pickImages(doc.file);
  if (!res.ok) {
    if (res.message) toast(res.message);
    return;
  }
  if (view === "edit") edit.insertPictures(res.markdown);
  else source.insertPictures(res.markdown);
}

function applyFormat(cmd: FormatCommand): void {
  if (!doc) return;
  if (view === "edit") return edit.command(cmd);
  if (view === "reading") return toast("Switch to the Edit view (Cmd+Alt+2) to format text.");
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
  if (doc && view === "reading") await setView(writingMode);
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
        goToLine(hint.line);
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

function runCommand(cmd: MenuCommand): void {
  switch (cmd) {
    case "toggle-view":
      void setView(view === "reading" ? writingMode : "reading");
      break;
    case "view-reading":
      void setView("reading");
      break;
    case "view-edit":
      void setView("edit");
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
    case "insert-image":
      void insertPicture();
      break;
    case "study":
      void study();
      break;
    case "focus":
      toggleFocus();
      break;
    case "undo":
    case "redo": {
      // The editor keeps its own history; a note box or the find box uses the browser's.
      const el = document.activeElement as HTMLElement | null;
      if (view === "edit") {
        if (cmd === "undo") edit.undo();
        else edit.redo();
        break;
      }
      if (el?.closest("#source")) cmd === "undo" ? source.undo() : source.redo();
      else document.execCommand(cmd);
      break;
    }
    case "goto":
      void gotoPalette();
      break;
    case "save":
      void save();
      break;
    case "add-note":
      addNote();
      break;
    case "edit-block":
      if (view === "reading") reading.editBlock();
      else toast("Editing already: this view is the one for writing.");
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
      else if (cmd.startsWith("export:")) void exportBook(cmd.slice(7) as ExportKind);
  }
}
api.onMenu(runCommand);

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

// ------------------------------------------------------------------------------------------------
// Telling the main process what the reader is on, for the optional MCP server (off unless BOOK_STUDIO_MCP is set)
// ------------------------------------------------------------------------------------------------

/** Where the reader is now: the chapter, the view, the line and nearest heading, and any words selected on the page. */
function readingSnapshot(): ReadingSnapshot {
  if (!doc) return { file: null, name: null, view: null, line: null, heading: null, selection: null };
  const line = view === "reading" ? reading.activeFirstLine() : view === "edit" ? edit.currentLine() : source.cursorLine;
  let heading: string | null = null;
  if (typeof line === "number") {
    for (const hd of outline(doc.text)) {
      if (hd.line <= line) heading = hd.title;
      else break;
    }
  }
  let selection: string | null = null;
  if (view === "reading") selection = reading.selectedText();
  else {
    try {
      const s = window.getSelection()?.toString().trim();
      selection = s ? s.slice(0, 4000) : null;
    } catch {
      /* no selection to read */
    }
  }
  return { file: doc.file, name: doc.name, view, line: typeof line === "number" ? line : null, heading, selection };
}

let readingTimer: number | undefined;
/** Send the snapshot, coalesced so a burst of scrolls or selection changes is one message. */
function pushReading(): void {
  window.clearTimeout(readingTimer);
  readingTimer = window.setTimeout(() => void api.reportReading(readingSnapshot()), 250);
}
document.addEventListener("selectionchange", () => pushReading());

async function start(): Promise<void> {
  applyAppearance(await api.appearance());
  titlebar = await setupTitlebar({ run: runCommand, openFolder: (f) => void openFolder(f) });
  renderFormatbar();
  showPanelTab();
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
