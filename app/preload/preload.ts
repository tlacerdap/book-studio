// The only bridge between the window and the main process. Every call is one named request; nothing generic is exposed.

import { contextBridge, ipcRenderer } from "electron";
import type { MenuCommand, PrintProgress, StudioApi } from "../shared/api.ts";

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
  writeChapter: (file, text) => call("chapter:write", file, text),
  prepareReading: (file, text) => call("reading:prepare", file, text),
  openExternal: (url) => call("external:open", url),
  copyText: (text) => call("clipboard:write", text),
  print: () => call("print:run"),
  openPdf: (p) => call("pdf:open", p),
  revealPdf: (p) => call("pdf:reveal", p),
  confirmUnsaved: (name) => call("dialog:unsaved", name),
  closeWindow: () => call("window:close"),
  cancelQuit: () => call("window:cancel-quit"),
  onMenu: (cb) => subscribe<[MenuCommand]>("menu", cb),
  onBookChanged: (cb) => subscribe<[string[]]>("book:changed", cb),
  onPrintProgress: (cb) => subscribe<[PrintProgress]>("print:progress", cb),
  onQueryClose: (cb) => subscribe<[]>("window:query-close", cb),
  onOpenFolder: (cb) => subscribe<[string]>("open-folder", cb),
};

contextBridge.exposeInMainWorld("studio", api);
