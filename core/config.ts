// Read and validate a book's book.yaml. Same keys and rules as the Python engine (bookcore/config.py).

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, parseDocument, YAMLParseError } from "yaml";
import { atomicWrite } from "./fsutil.ts";
import { globFiles } from "./glob.ts";

export const BOOK_FILE = "book.yaml";

export class ConfigError extends Error {}

// key -> [required, default]. Anything else in the file is rejected, so a typo cannot pass silently.
const KEYS: Record<string, [boolean, string | null]> = {
  title: [true, null],
  subtitle: [false, ""],
  author: [false, ""],
  date: [false, ""],
  language: [false, "en"],
  chapters: [false, "chapters/*.md"],
  output: [false, "book"],
  index: [false, null],
};

/** Keys that hold a number or a list rather than a piece of text. They are read separately (see `structured` below). */
const STRUCTURED = ["pages", "known", "rules", "terms"];

/** A writing rule of the book: words that must not appear, with the reason to show. */
export interface BookRule {
  /** Plain text, or a regular expression when `regex` is true. Matched without regard to case. */
  forbid: string;
  regex: boolean;
  message: string;
}

export interface BookConfig {
  root: string;
  title: string;
  subtitle: string;
  author: string;
  date: string;
  language: string;
  chapters: string;
  output: string;
  index: string | null;
  /** How many numbered pages the book should not go beyond, or null for no limit. */
  pages: number | null;
  /** Chapters (file names) marked as known: kept in the book's folder, left out of the PDF. */
  known: string[];
  rules: BookRule[];
  /** Words and acronyms the reader is assumed to know, so the checks do not ask for an explanation. */
  terms: string[];
}

export function isBook(folder: string): boolean {
  return fs.existsSync(path.join(folder, BOOK_FILE)) && fs.statSync(path.join(folder, BOOK_FILE)).isFile();
}

export function loadBook(folder: string): BookConfig {
  const wanted = path.resolve(folder.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
  if (!fs.existsSync(wanted) || !fs.statSync(wanted).isDirectory()) throw new ConfigError(`${wanted} is not a folder.`);
  const root = fs.realpathSync(wanted); // like Python's Path.resolve(): symlinks followed
  const file = path.join(root, BOOK_FILE);
  if (!fs.existsSync(file)) throw new ConfigError(`${root} is not a book: there is no ${BOOK_FILE} in it.`);
  let data: unknown;
  try {
    data = parseYaml(fs.readFileSync(file, "utf8")) ?? {};
  } catch (e) {
    const msg = e instanceof YAMLParseError ? e.message : String(e);
    throw new ConfigError(`${file} is not valid YAML: ${msg}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new ConfigError(`${file} must be a list of \`key: value\` settings.`);
  }
  const obj = data as Record<string, unknown>;
  const unknown_ = Object.keys(obj).filter((k) => !(k in KEYS) && !STRUCTURED.includes(k)).sort();
  if (unknown_.length) {
    throw new ConfigError(`${file}: unknown setting(s) ${unknown_.join(", ")}. Known: ${[...Object.keys(KEYS), ...STRUCTURED].join(", ")}.`);
  }
  const values: Record<string, string | null> = {};
  for (const [key, [required, def]] of Object.entries(KEYS)) {
    if (key in obj && obj[key] !== null && obj[key] !== undefined) values[key] = String(obj[key]);
    else if (required) throw new ConfigError(`${file}: \`${key}\` is required.`);
    else values[key] = def;
  }
  let out = (values.output ?? "book").trim();
  if (out.toLowerCase().endsWith(".pdf")) out = out.slice(0, -4);
  if (!out || out.includes("/")) throw new ConfigError(`${file}: \`output\` must be a plain file name such as \`my-book\`.`);
  values.output = out;
  const structured = readStructured(file, obj);
  return { root, ...(values as Omit<BookConfig, "root" | keyof typeof structured>), ...structured };
}

function listOfText(file: string, key: string, value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((x) => typeof x !== "string" && typeof x !== "number")) throw new ConfigError(`${file}: \`${key}\` must be a list of names.`);
  return value.map((x) => String(x).trim()).filter(Boolean);
}

function readStructured(file: string, obj: Record<string, unknown>): { pages: number | null; known: string[]; rules: BookRule[]; terms: string[] } {
  let pages: number | null = null;
  if (obj.pages !== undefined && obj.pages !== null) {
    const n = Number(obj.pages);
    if (!Number.isInteger(n) || n < 1 || n > 5000) throw new ConfigError(`${file}: \`pages\` must be a whole number of pages, such as 126.`);
    pages = n;
  }
  const rules: BookRule[] = [];
  if (obj.rules !== undefined && obj.rules !== null) {
    if (!Array.isArray(obj.rules)) throw new ConfigError(`${file}: \`rules\` must be a list.`);
    for (const r of obj.rules) {
      if (typeof r === "string") rules.push({ forbid: r, regex: false, message: `"${r}" is not allowed in this book` });
      else if (r && typeof r === "object" && typeof (r as Record<string, unknown>).forbid === "string") {
        const o = r as Record<string, unknown>;
        const forbid = String(o.forbid);
        const regex = o.regex === true;
        if (regex) {
          try {
            new RegExp(forbid, "iu");
          } catch {
            throw new ConfigError(`${file}: the rule \`${forbid}\` is not a valid pattern.`);
          }
        }
        rules.push({ forbid, regex, message: typeof o.message === "string" && o.message ? o.message : `"${forbid}" is not allowed in this book` });
      } else throw new ConfigError(`${file}: each rule needs a \`forbid:\` text, and may have a \`message:\`.`);
    }
  }
  return { pages, known: listOfText(file, "known", obj.known), rules, terms: listOfText(file, "terms", obj.terms) };
}

/**
 * Change settings in an existing book.yaml, keeping its comments and layout. `change` receives the parsed document.
 * Never creates the file: a folder is only a book once it has one.
 */
export function updateBookYaml(book: BookConfig, change: (doc: ReturnType<typeof parseDocument>) => void): void {
  const file = path.join(book.root, BOOK_FILE);
  if (!fs.existsSync(file)) throw new ConfigError(`${file} does not exist.`);
  const doc = parseDocument(fs.readFileSync(file, "utf8"));
  if (doc.errors.length) throw new ConfigError(`${file} is not valid YAML, so it was not changed.`);
  change(doc);
  atomicWrite(file, doc.toString());
}

/** Set or clear the page budget. */
export function setPageBudget(book: BookConfig, pages: number | null): void {
  updateBookYaml(book, (doc) => {
    if (pages === null) doc.delete("pages");
    else doc.set("pages", pages);
  });
}

/** Mark a chapter as known (or not). */
export function setKnown(book: BookConfig, file: string, known: boolean): void {
  const name = path.basename(file);
  updateBookYaml(book, (doc) => {
    const now = new Set(listOfText("book.yaml", "known", (doc.toJS() as Record<string, unknown> | null)?.known));
    if (known) now.add(name);
    else now.delete(name);
    if (now.size) doc.set("known", [...now].sort());
    else doc.delete("known");
  });
}

/** Tell the writing checks that the reader knows this word, so it never asks for an explanation of it. */
export function addTerm(book: BookConfig, term: string): void {
  const word = term.trim();
  if (!word) return;
  updateBookYaml(book, (doc) => {
    const now = listOfText("book.yaml", "terms", (doc.toJS() as Record<string, unknown> | null)?.terms);
    if (!now.some((t) => t.toUpperCase() === word.toUpperCase())) now.push(word);
    doc.set("terms", now.sort());
  });
}

/** After a chapter file is renamed, keep the list of known chapters pointing at it. */
export function renameKnown(book: BookConfig, renames: Map<string, string>): void {
  if (!book.known.some((k) => renames.has(k))) return;
  updateBookYaml(book, (doc) => {
    const list = listOfText("book.yaml", "known", (doc.toJS() as Record<string, unknown> | null)?.known).map((k) => renames.get(k) ?? k);
    doc.set("known", [...new Set(list)].sort());
  });
}

export function chapterFiles(book: BookConfig): string[] {
  return globFiles(book.root, book.chapters).sort(byCodePoint);
}

export function outputPdf(book: BookConfig): string {
  return path.join(book.root, "build", `${book.output}.pdf`);
}

export function indexFile(book: BookConfig): string | null {
  return book.index ? path.join(book.root, book.index) : null;
}

/** A book may layer its own book.css over the default styles. Absent means default only. */
export function cssOverride(book: BookConfig): string | null {
  const p = path.join(book.root, "book.css");
  return fs.existsSync(p) && fs.statSync(p).isFile() ? p : null;
}

// Python sorts paths by code point; JavaScript's default sort compares UTF-16 units. Same for file names in practice.
export function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const TEMPLATE = (title: string, chapters: string, output: string) => `# book.yaml: the settings that belong to this book. Everything else (layout, fonts, page rules)
# is book-studio's. Paths are relative to this file.

title: ${JSON.stringify(title)}
subtitle: ""
author: ""
date: ""              # printed on the cover as written, for example "November 1, 2026"
language: en          # sets hyphenation and the document language

chapters: ${JSON.stringify(chapters)}  # glob for the chapter files; they are ordered by file name
output: ${JSON.stringify(output)}      # the PDF is written to build/<output>.pdf

# index: INDEX.md     # optional. A markdown file whose "## Part X - Name" headings and
                      # "**Chapter N - Title**" lines group chapters into Parts in the contents.
`;

/** Create a starter book.yaml in a folder that does not have one (the app offers this). */
/**
 * What proves a folder holds a book: markdown files that start with a heading, either in a `chapters` folder or, failing
 * that, at least two numbered files (01-intro.md) in the folder itself. A README alone, or a folder of loose notes, is
 * not proof. Returns the evidence (relative file names), empty when there is none.
 */
export function bookEvidence(folder: string): string[] {
  const root = path.resolve(folder);
  const startsWithHeading = (file: string): boolean => {
    try {
      const head = fs.readFileSync(file, "utf8").slice(0, 4000).replace(/^\uFEFF/, "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
      return /^\s*#{1,2} \S/.test(head);
    } catch {
      return false;
    }
  };
  const mdIn = (dir: string, numbered: boolean): string[] => {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.endsWith(".md") && (!numbered || /^\d/.test(d.name)))
        .map((d) => d.name)
        .filter((n) => startsWithHeading(path.join(dir, n)))
        .sort(byCodePoint);
    } catch {
      return [];
    }
  };
  const inChapters = mdIn(path.join(root, "chapters"), false).map((n) => `chapters/${n}`);
  if (inChapters.length > 0) return inChapters;
  const flat = mdIn(root, true);
  return flat.length >= 2 ? flat : [];
}

/** Write a starter book.yaml, but only into a folder that visibly holds a book. */
export function writeDefaultBookYaml(folder: string, title?: string): string {
  const root = path.resolve(folder);
  if (bookEvidence(root).length === 0 && !fs.existsSync(path.join(root, BOOK_FILE))) {
    throw new ConfigError(`${root} does not look like a book: there are no chapters in it (markdown files that start with a heading), so no book.yaml was written.`);
  }
  const file = path.join(root, BOOK_FILE);
  if (fs.existsSync(file)) throw new ConfigError(`${file} already exists.`);
  const name = path.basename(root);
  const nice = name.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const hasDir = fs.existsSync(path.join(root, "chapters")) && fs.statSync(path.join(root, "chapters")).isDirectory();
  fs.writeFileSync(file, TEMPLATE(title ?? nice, hasDir ? "chapters/*.md" : "*.md", name));
  return file;
}
