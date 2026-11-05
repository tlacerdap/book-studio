// Making, renaming, moving and deleting chapter files. Every change keeps the links between chapters (`](04-name.md)`) working,
// and none of it runs unless the file really is one of the book's chapters.

import fs from "node:fs";
import path from "node:path";
import { chapterFiles, renameKnown, type BookConfig } from "./config.ts";
import { atomicWrite } from "./fsutil.ts";

export class ChapterError extends Error {}

/** "Python in plain words" becomes "python-in-plain-words": lower case, letters and digits, one hyphen between words. */
export function slugOf(title: string): string {
  const s = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return s || "chapter";
}

interface Parts {
  num: string;
  rest: string;
}

/** "07-ch07-data.md" is { num: "07", rest: "ch07-data" }. A name without a leading number has an empty `num`. */
function parts(name: string): Parts {
  const m = /^(\d+)[-_ ]?(.*)\.md$/i.exec(name);
  return m ? { num: m[1], rest: m[2] } : { num: "", rest: name.replace(/\.md$/i, "") };
}

function width(files: string[]): number {
  return Math.max(2, ...files.map((f) => parts(path.basename(f)).num.length));
}

function chapterDir(book: BookConfig, files: string[]): string {
  return files.length ? path.dirname(files[0]) : path.join(book.root, "chapters");
}

/** Replace every link to one chapter file by a link to its new name, in all the chapters of the book. */
function rewriteLinks(files: string[], renames: Map<string, string>): void {
  for (const f of files) {
    let text: string;
    try {
      text = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    let next = text;
    for (const [from, to] of renames) next = next.split(`](${from}`).join(`](${to}`).split(`](./${from}`).join(`](./${to}`);
    if (next !== text) atomicWrite(f, next);
  }
}

/** Where a new chapter would go and what it is called: the number after the highest one, or `number` if it is free. */
export function nextName(book: BookConfig, title: string, number?: number): string {
  const files = chapterFiles(book);
  const taken = new Set(files.map((f) => parseInt(parts(path.basename(f)).num, 10)).filter((n) => !Number.isNaN(n)));
  let n = number ?? Math.max(-1, ...taken) + 1;
  if (taken.has(n)) throw new ChapterError(`Chapter number ${n} already exists.`);
  if (n < 0) n = 0;
  return `${String(n).padStart(width(files), "0")}-${slugOf(title)}.md`;
}

/** Make a chapter file with just a title in it. Returns the new file's absolute path. */
export function createChapter(book: BookConfig, title: string, number?: number): string {
  const clean = title.replace(/[\r\n]+/g, " ").trim();
  if (!clean) throw new ChapterError("A chapter needs a title.");
  const files = chapterFiles(book);
  const dir = chapterDir(book, files);
  const name = nextName(book, clean, number);
  const target = path.join(dir, name);
  if (fs.existsSync(target)) throw new ChapterError(`${name} already exists.`);
  const n = parseInt(parts(name).num, 10);
  const label = Number.isNaN(n) ? "" : `Chapter ${n} - `;
  fs.mkdirSync(dir, { recursive: true });
  atomicWrite(target, `# ${label}${clean}\n\n`);
  return target;
}

/** Give a chapter a new name after its number ("07-old.md" to "07-new-title.md"). Links to it follow. */
export function renameChapter(book: BookConfig, file: string, title: string): string {
  const files = chapterFiles(book);
  if (!files.includes(file)) throw new ChapterError("That is not a chapter of this book.");
  const clean = title.trim();
  if (!clean) throw new ChapterError("A chapter needs a name.");
  const p = parts(path.basename(file));
  const name = `${p.num}${p.num ? "-" : ""}${slugOf(clean)}.md`;
  const target = path.join(path.dirname(file), name);
  if (target === file) return file;
  if (fs.existsSync(target)) throw new ChapterError(`${name} already exists.`);
  fs.renameSync(file, target);
  rewriteLinks(chapterFiles(book), new Map([[path.basename(file), name]]));
  renameKnown(book, new Map([[path.basename(file), name]]));
  return target;
}

/**
 * Move a chapter one place up (-1) or down (+1) by trading file numbers with its neighbour. If both chapters open with
 * "# Chapter N - ", those numbers trade too, so the printed number follows the position.
 */
export function moveChapter(book: BookConfig, file: string, step: -1 | 1): string {
  const files = chapterFiles(book);
  const i = files.indexOf(file);
  if (i < 0) throw new ChapterError("That is not a chapter of this book.");
  const j = i + step;
  if (j < 0 || j >= files.length) return file;
  const a = files[i];
  const b = files[j];
  const pa = parts(path.basename(a));
  const pb = parts(path.basename(b));
  if (!pa.num || !pb.num) throw new ChapterError("Only chapters whose file name starts with a number can be moved.");
  const nameA = `${pb.num}-${pa.rest}.md`;
  const nameB = `${pa.num}-${pb.rest}.md`;
  const targetA = path.join(path.dirname(a), nameA);
  const targetB = path.join(path.dirname(b), nameB);
  // Two steps through a temporary name, so the two files never overwrite each other.
  const tmp = `${a}.moving`;
  fs.renameSync(a, tmp);
  fs.renameSync(b, targetB);
  fs.renameSync(tmp, targetA);
  const textA = fs.readFileSync(targetA, "utf8");
  const textB = fs.readFileSync(targetB, "utf8");
  const labelA = /^# Chapter (\d+)(\.\d+)? - /.exec(textA);
  const labelB = /^# Chapter (\d+)(\.\d+)? - /.exec(textB);
  if (labelA && labelB && !labelA[2] && !labelB[2]) {
    atomicWrite(targetA, textA.replace(/^# Chapter \d+ - /, `# Chapter ${labelB[1]} - `));
    atomicWrite(targetB, textB.replace(/^# Chapter \d+ - /, `# Chapter ${labelA[1]} - `));
  }
  const renames = new Map([[path.basename(a), nameA], [path.basename(b), nameB]]);
  rewriteLinks(chapterFiles(book), renames);
  renameKnown(book, renames);
  return targetA;
}

/** The text of every chapter that links to this one, for the warning before it is deleted. */
export function linksTo(book: BookConfig, file: string): string[] {
  const name = path.basename(file);
  return chapterFiles(book)
    .filter((f) => f !== file)
    .filter((f) => {
      try {
        return fs.readFileSync(f, "utf8").includes(`](${name}`);
      } catch {
        return false;
      }
    })
    .map((f) => path.basename(f));
}
