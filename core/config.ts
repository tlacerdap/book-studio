// Read and validate a book's book.yaml. Same keys and rules as the Python engine (bookcore/config.py).

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, YAMLParseError } from "yaml";
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
  const unknown_ = Object.keys(obj).filter((k) => !(k in KEYS)).sort();
  if (unknown_.length) {
    throw new ConfigError(`${file}: unknown setting(s) ${unknown_.join(", ")}. Known: ${Object.keys(KEYS).join(", ")}.`);
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
  return { root, ...(values as Omit<BookConfig, "root">) };
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
export function writeDefaultBookYaml(folder: string, title?: string): string {
  const root = path.resolve(folder);
  const file = path.join(root, BOOK_FILE);
  if (fs.existsSync(file)) throw new ConfigError(`${file} already exists.`);
  const name = path.basename(root);
  const nice = name.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const hasDir = fs.existsSync(path.join(root, "chapters")) && fs.statSync(path.join(root, "chapters")).isDirectory();
  fs.writeFileSync(file, TEMPLATE(title ?? nice, hasDir ? "chapters/*.md" : "*.md", name));
  return file;
}
