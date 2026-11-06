// What the window and the main process say to each other. The preload script exposes exactly this, and nothing else.

import type { ChapterSummary } from "../../core/book.ts";
import type { Problem } from "../../core/print.ts";
import type { CheckReport } from "../../core/check.ts";
import type { SearchResult } from "../../core/search.ts";
import type { FormatCommand } from "../../core/format.ts";
import type { InboxNote } from "../../core/inbox.ts";
import type { Card } from "../../core/study.ts";
import type { MenuSection } from "./menu.ts";

export interface BookInfo {
  root: string;
  title: string;
  author: string;
  output: string;
  chapters: ChapterSummary[];
  /** The page budget from book.yaml, or null. */
  pages: number | null;
  /** File names of the chapters marked as known (left out of the PDF). */
  known: string[];
}

/** A finding about the writing: where, and what to tell the author. */
export interface WritingHint {
  line: number;
  column: number;
  length: number;
  text: string;
  kind: "rule" | "term";
  message: string;
}

export interface BookHints {
  file: string;
  hints: WritingHint[];
}

export type OpenResult =
  | { ok: true; book: BookInfo }
  | { ok: false; reason: "cancelled" }
  /** `evidence` is how many chapters were found: only a folder that shows some can be turned into a book. */
  | { ok: false; reason: "not-a-book"; folder: string; evidence: number }
  | { ok: false; reason: "error"; message: string };

export interface ChapterText {
  text: string;
  mtimeMs: number;
}

export interface PageCounts {
  counts: Record<string, number>;
  pending: number;
  chapters: number;
}

export type PrintProgress = { stage: "preparing" | "laying-out" | "checking" | "done" };

export interface PrintOutcome {
  ok: boolean;
  error?: string;
  pdf?: string;
  pages?: number;
  chapters?: number;
  report?: Pick<CheckReport, "results" | "measure" | "bodyPages" | "pages" | "failures" | "ok" | "inkMedian">;
  problems?: Problem[];
}

export type UnsavedChoice = "save" | "discard" | "cancel";

export interface SnapshotInfo {
  id: string;
  time: number;
  bytes: number;
  words: number;
  label: string;
}

export interface DiffLine {
  tag: "+" | "-" | " ";
  text: string;
}

export interface OutlineEntry {
  file: string;
  headings: { level: 2 | 3; title: string; line: number }[];
}

export interface ChapterNotes {
  file: string;
  notes: InboxNote[];
}

export interface ChapterCards {
  file: string;
  cards: Card[];
}

export type FileResult = { ok: true; file: string } | { ok: false; message: string };

export type { FormatCommand };

/** What the reader is looking at right now, sent from the window to the main process for the optional MCP server. */
export interface ReadingSnapshot {
  /** Absolute path of the open chapter, or null if none is open. */
  file: string | null;
  /** The chapter's file name. */
  name: string | null;
  view: "reading" | "edit" | "source" | null;
  /** 0-based top line in the note-free text, if known. */
  line: number | null;
  /** The nearest heading at or above the reader's position. */
  heading: string | null;
  /** Text the reader has selected on the page right now, if any. */
  selection: string | null;
}

/** Whether the window draws its own title bar and menu (Windows, Linux) instead of the operating system's (macOS). */
export interface ChromeInfo {
  /** True on Windows and Linux: the renderer draws the title bar and the menu, themed with the rest of the app. */
  custom: boolean;
  platform: string;
  /** Height of the title bar in pixels. */
  height: number;
  /** On Windows the native min/max/close buttons sit in an overlay this many pixels wide, on the right. */
  controlsWidth: number;
}

export type Theme = "light" | "sepia" | "dark" | "black" | "system";

export interface Appearance {
  theme: Theme;
  /** 0 to 1: how strong the warm eye-comfort tint is. */
  warmth: number;
}

export type ExportKind = "epub" | "html" | "chapter-pdf" | "all-pdf";

export type ExportOutcome = { ok: true; message: string } | { ok: false; cancelled?: boolean; message: string };

export type MenuCommand =
  | `export:${ExportKind}`
  | "insert-image"
  | "study"
  | "undo"
  | "redo"
  | "focus"
  | "new-chapter"
  | "history"
  | "goto"
  | "view-reading"
  | "edit-block"
  | "view-edit"
  | "view-source"
  | `format:${FormatCommand}`
  | "toggle-view"
  | "save"
  | "add-note"
  | "toggle-panel"
  | "find"
  | "find-book"
  | "prev-chapter"
  | "next-chapter"
  | "print"
  | "reload-book"
  | "toggle-mcp"
  | "open-book"
  | "zoom-in"
  | "zoom-out"
  | "zoom-reset"
  | "zoom-fit";

export interface StudioApi {
  platform: string;
  openBookDialog(): Promise<OpenResult>;
  openBook(folder: string): Promise<OpenResult>;
  createBook(folder: string): Promise<OpenResult>;
  recentBooks(): Promise<{ folder: string; title: string }[]>;
  currentBook(): Promise<BookInfo | null>;
  refreshBook(): Promise<BookInfo | null>;
  readChapter(file: string): Promise<ChapterText>;
  createChapter(title: string): Promise<FileResult>;
  renameChapter(file: string, title: string): Promise<FileResult>;
  moveChapter(file: string, step: -1 | 1): Promise<FileResult>;
  /** Asks first; true if the chapter went to the Trash. */
  deleteChapter(file: string): Promise<boolean>;
  historyList(file: string): Promise<SnapshotInfo[]>;
  /** The changed lines between an old version and the text as it is now. */
  historyDiff(file: string, id: string, current: string): Promise<DiffLine[]>;
  /** The text of an old version. The version it replaces is kept in the history. */
  historyRestore(file: string, id: string): Promise<string>;
  outlines(current: { file: string; text: string } | null): Promise<OutlineEntry[]>;
  /** The page budget; null removes it. */
  setBudget(pages: number | null): Promise<BookInfo | null>;
  /** Mark a chapter as known (left out of the PDF) or not. */
  setKnown(file: string, known: boolean): Promise<BookInfo | null>;
  /** Every note of every chapter, for the inbox. */
  allNotes(current: { file: string; text: string } | null): Promise<ChapterNotes[]>;
  /** Flashcards from every chapter that is not marked as known. */
  studyCards(current: { file: string; text: string } | null): Promise<ChapterCards[]>;
  appearance(): Promise<Appearance>;
  /** Change the theme and/or the warm tint; the new state is returned (and every window is told). */
  setAppearance(change: Partial<Appearance>): Promise<Appearance>;
  onAppearance(cb: (a: Appearance) => void): () => void;
  /** The book's page styles, made fit to style the Edit view. */
  editCss(): Promise<string>;
  /** Write the book (or a chapter) in another shape. Asks where to put it; `file` is the open chapter, for "chapter-pdf". */
  exportBook(kind: ExportKind, file: string | null): Promise<ExportOutcome>;
  onExportProgress(cb: (message: string) => void): () => void;
  /** Keep a pasted or dropped picture in the book's images folder; gives the markdown to put in the chapter. */
  saveImage(file: string, bytes: Uint8Array): Promise<{ ok: true; markdown: string[] } | { ok: false; message: string }>;
  /** Choose picture files from disk and copy them in; gives the markdown for each. */
  pickImages(file: string): Promise<{ ok: true; markdown: string[] } | { ok: false; message: string }>;
  /** The reader knows this word: the checks stop asking for an explanation of it. */
  addTerm(term: string): Promise<BookInfo | null>;
  /** Writing hints for a chapter, as the editor holds it. */
  checkWriting(current: { file: string; text: string }): Promise<WritingHint[]>;
  /** Writing hints for every chapter. */
  checkBookWriting(current: { file: string; text: string } | null): Promise<BookHints[]>;
  writeChapter(file: string, text: string): Promise<{ mtimeMs: number }>;
  prepareReading(file: string, text: string): Promise<{ url: string }>;
  openExternal(url: string): Promise<void>;
  copyText(text: string): Promise<void>;
  /** Search every chapter of the book for some words. `current` is the open chapter as the editor holds it (it may have unsaved edits). */
  searchBook(query: string, current: { file: string; text: string } | null): Promise<SearchResult>;
  /** The version of the app that is running, so a reader can tell which build they have. */
  version(): Promise<string>;
  pageCounts(): Promise<PageCounts>;
  pagesKnown(file: string, pages: number): Promise<void>;
  print(): Promise<PrintOutcome>;
  openPdf(path: string): Promise<void>;
  revealPdf(path: string): Promise<void>;
  confirmUnsaved(name: string): Promise<UnsavedChoice>;
  closeWindow(): Promise<void>;
  cancelQuit(): Promise<void>;
  onMenu(cb: (cmd: MenuCommand) => void): () => void;
  onBookChanged(cb: (files: string[]) => void): () => void;
  onPageCounts(cb: (p: PageCounts) => void): () => void;
  onPrintProgress(cb: (p: PrintProgress) => void): () => void;
  onQueryClose(cb: () => void): () => void;
  onOpenFolder(cb: (folder: string) => void): () => void;
  /** Tell the main process what the reader is looking at now (for the optional MCP server). A no-op when it is off. */
  reportReading(state: ReadingSnapshot): Promise<void>;
  /** Whether this window draws its own title bar and menu (Windows/Linux) or uses the system's (macOS). */
  chromeInfo(): Promise<ChromeInfo>;
  /** The application menu as data, for the custom in-window menu bar. Rebuilt on every call (recent books, theme state). */
  menuModel(): Promise<MenuSection[]>;
  minimizeWindow(): Promise<void>;
  /** Maximize the window, or restore it if it is already maximized. */
  toggleMaximizeWindow(): Promise<void>;
  isWindowMaximized(): Promise<boolean>;
  onMaximizeChange(cb: (maximized: boolean) => void): () => void;
  /** Open or close the developer tools (unpackaged builds only). */
  toggleDevTools(): Promise<void>;
  /** Turn the "let Claude read along" MCP server on or off; returns the new state. */
  toggleMcp(): Promise<boolean>;
}
