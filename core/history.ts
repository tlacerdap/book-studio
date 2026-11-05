// Version history of a chapter. Snapshots are kept outside the book (in the app's own data folder), so the book folder
// stays clean, and a snapshot is only taken when the text really differs from the last one.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicWrite } from "./fsutil.ts";

export interface Snapshot {
  /** File name of the snapshot, which is also its id. */
  id: string;
  /** Milliseconds since 1970. */
  time: number;
  bytes: number;
  words: number;
  /** The first words that differ from the next older version, for the list. */
  label: string;
}

/** Keep at most this many snapshots of one chapter, newest first. */
export const KEEP = 60;
/** A change within this many milliseconds of the last snapshot replaces it instead of adding a new one. */
export const MERGE_MS = 90_000;

const words = (t: string) => t.split(/\s+/).filter(Boolean).length;

export function chapterDir(store: string, bookRoot: string, file: string): string {
  const book = crypto.createHash("sha1").update(bookRoot).digest("hex").slice(0, 10);
  const rel = path.relative(bookRoot, file).split(path.sep).join("/");
  const name = rel.replace(/[^A-Za-z0-9._-]+/g, "_");
  return path.join(store, "history", book, name);
}

function list(dir: string): { id: string; time: number }[] {
  try {
    return fs
      .readdirSync(dir)
      .map((id) => ({ id, time: parseInt(id, 10) }))
      .filter((x) => /^\d+\.md$/.test(x.id) && Number.isFinite(x.time))
      .sort((a, b) => b.time - a.time);
  } catch {
    return [];
  }
}

/**
 * Remember `text` as a version of the chapter. Returns true if a snapshot was written.
 * `force` always adds a new one (used before a restore, so the restore itself can be undone).
 */
export function snapshot(store: string, bookRoot: string, file: string, text: string, now = Date.now(), force = false): boolean {
  const dir = chapterDir(store, bookRoot, file);
  const have = list(dir);
  if (have[0]) {
    const last = fs.readFileSync(path.join(dir, have[0].id), "utf8");
    if (last === text) return false;
    if (!force && now - have[0].time < MERGE_MS && have.length > 1) fs.rmSync(path.join(dir, have[0].id), { force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
  atomicWrite(path.join(dir, `${now}.md`), text);
  for (const old of list(dir).slice(KEEP)) fs.rmSync(path.join(dir, old.id), { force: true });
  return true;
}

export function listSnapshots(store: string, bookRoot: string, file: string): Snapshot[] {
  const dir = chapterDir(store, bookRoot, file);
  const have = list(dir);
  return have.map((s, i) => {
    const text = fs.readFileSync(path.join(dir, s.id), "utf8");
    const older = have[i + 1] ? fs.readFileSync(path.join(dir, have[i + 1].id), "utf8") : "";
    return { id: s.id, time: s.time, bytes: Buffer.byteLength(text), words: words(text), label: firstDifference(older, text) };
  });
}

export function readSnapshot(store: string, bookRoot: string, file: string, id: string): string {
  if (!/^\d+\.md$/.test(id)) throw new Error("not a snapshot");
  return fs.readFileSync(path.join(chapterDir(store, bookRoot, file), id), "utf8");
}

/** A few words from the first line where the newer text differs from the older one. */
export function firstDifference(older: string, newer: string): string {
  if (!older) return "first version";
  const a = older.split("\n");
  const b = newer.split("\n");
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const line = (b[i] ?? a[i] ?? "").replace(/<!--.*?-->/g, "").replace(/[#*_`>]+/g, "").trim();
  const shown = line.length > 70 ? `${line.slice(0, 70)}...` : line;
  return b[i] === undefined ? `removed: ${shown}` : shown || "blank lines";
}

/** Added and removed lines between two texts, as a flat list of lines tagged `+`, `-` or ` `, for the history view. */
export function lineDiff(older: string, newer: string): { tag: "+" | "-" | " "; text: string }[] {
  const a = older.split("\n");
  const b = newer.split("\n");
  // Trim the common head and tail first; the middle is what the longest-common-subsequence has to look at.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const ma = a.slice(head, a.length - tail);
  const mb = b.slice(head, b.length - tail);
  const out: { tag: "+" | "-" | " "; text: string }[] = a.slice(0, head).map((text) => ({ tag: " ", text }));
  if (ma.length * mb.length > 4_000_000) {
    // Too big to compare line by line: show the middle as removed then added.
    ma.forEach((text) => out.push({ tag: "-", text }));
    mb.forEach((text) => out.push({ tag: "+", text }));
  } else {
    const w = mb.length + 1;
    const lcs = new Uint32Array((ma.length + 1) * w);
    for (let i = ma.length - 1; i >= 0; i--) {
      for (let j = mb.length - 1; j >= 0; j--) {
        lcs[i * w + j] = ma[i] === mb[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < ma.length && j < mb.length) {
      if (ma[i] === mb[j]) {
        out.push({ tag: " ", text: ma[i] });
        i++;
        j++;
      } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) out.push({ tag: "-", text: ma[i++] });
      else out.push({ tag: "+", text: mb[j++] });
    }
    while (i < ma.length) out.push({ tag: "-", text: ma[i++] });
    while (j < mb.length) out.push({ tag: "+", text: mb[j++] });
  }
  for (const text of a.slice(a.length - tail)) out.push({ tag: " ", text });
  return out;
}
