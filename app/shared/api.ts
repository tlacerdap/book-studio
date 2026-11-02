// What the window and the main process say to each other. The preload script exposes exactly this, and nothing else.

import type { ChapterSummary } from "../../core/book.ts";
import type { Problem } from "../../core/print.ts";
import type { CheckReport } from "../../core/check.ts";

export interface BookInfo {
  root: string;
  title: string;
  author: string;
  output: string;
  chapters: ChapterSummary[];
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

export type MenuCommand =
  | "toggle-view"
  | "save"
  | "add-note"
  | "toggle-panel"
  | "find"
  | "prev-chapter"
  | "next-chapter"
  | "print"
  | "reload-book"
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
  writeChapter(file: string, text: string): Promise<{ mtimeMs: number }>;
  prepareReading(file: string, text: string): Promise<{ url: string }>;
  openExternal(url: string): Promise<void>;
  copyText(text: string): Promise<void>;
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
}
