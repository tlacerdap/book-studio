// The only bridge between the window and the main process. Every call is one named request; nothing generic is exposed.

import { contextBridge, ipcRenderer } from "electron";
import type { Appearance, MenuCommand, PageCounts, PrintProgress, ReadingSnapshot, StudioApi } from "../shared/api.ts";

const call = <T>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args) as Promise<T>;

function subscribe<T extends unknown[]>(channel: string, cb: (...a: T) => void): () => void {
  const handler = (_e: unknown, ...a: unknown[]) => cb(...(a as T));
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api: StudioApi = {
  platform: process.platform,
  openBookDialog: () => call("book:open-dialog"),
  openBook: (folder) => call("book:open", folder),
  createBook: (folder) => call("book:create", folder),
  recentBooks: () => call("book:recent"),
  currentBook: () => call("book:current"),
  refreshBook: () => call("book:refresh"),
  readChapter: (file) => call("chapter:read", file),
  createChapter: (title) => call("chapter:create", title),
  renameChapter: (file, title) => call("chapter:rename", file, title),
  moveChapter: (file, step) => call("chapter:move", file, step),
  deleteChapter: (file) => call("chapter:delete", file),
  historyList: (file) => call("history:list", file),
  historyDiff: (file, id, current) => call("history:diff", file, id, current),
  historyRestore: (file, id) => call("history:restore", file, id),
  outlines: (current) => call("book:outlines", current),
  setBudget: (pages) => call("book:set-budget", pages),
  setKnown: (file, known) => call("book:set-known", file, known),
  appearance: () => call("appearance:get"),
  setAppearance: (change) => call("appearance:set", change),
  onAppearance: (cb) => subscribe<[Appearance]>("appearance", cb),
  editCss: () => call("style:edit"),
  exportBook: (kind, file) => call("export:run", kind, file),
  onExportProgress: (cb) => subscribe<[string]>("export:progress", cb),
  saveImage: (file, bytes) => call("image:save", file, bytes),
  pickImages: (file) => call("image:pick", file),
  allNotes: (current) => call("notes:all", current),
  studyCards: (current) => call("study:cards", current),
  addTerm: (term) => call("book:add-term", term),
  checkWriting: (current) => call("rules:check", current),
  checkBookWriting: (current) => call("rules:book", current),
  writeChapter: (file, text) => call("chapter:write", file, text),
  prepareReading: (file, text) => call("reading:prepare", file, text),
  openExternal: (url) => call("external:open", url),
  copyText: (text) => call("clipboard:write", text),
  version: () => call("app:version"),
  searchBook: (query, current) => call("search:book", query, current),
  pageCounts: () => call("pages:get"),
  pagesKnown: (file, pages) => call("pages:known", file, pages),
  print: () => call("print:run"),
  openPdf: (p) => call("pdf:open", p),
  revealPdf: (p) => call("pdf:reveal", p),
  confirmUnsaved: (name) => call("dialog:unsaved", name),
  closeWindow: () => call("window:close"),
  cancelQuit: () => call("window:cancel-quit"),
  onMenu: (cb) => subscribe<[MenuCommand]>("menu", cb),
  onBookChanged: (cb) => subscribe<[string[]]>("book:changed", cb),
  onPageCounts: (cb) => subscribe<[PageCounts]>("pages:update", cb),
  onPrintProgress: (cb) => subscribe<[PrintProgress]>("print:progress", cb),
  onQueryClose: (cb) => subscribe<[]>("window:query-close", cb),
  onOpenFolder: (cb) => subscribe<[string]>("open-folder", cb),
  reportReading: (state: ReadingSnapshot) => call("reading:state", state),
};

contextBridge.exposeInMainWorld("studio", api);
