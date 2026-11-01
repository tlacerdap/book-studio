// Where book-studio's own files live (not the book's): styles/ and the vendored libraries.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function findPackageRoot(): string {
  // The app sets this: inside a packaged app the code is bundled and import.meta.url is not a useful place to start.
  if (process.env.BOOK_STUDIO_ROOT) return process.env.BOOK_STUDIO_ROOT;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "styles", "book.css"))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error("cannot find book-studio's styles/ folder");
}

export const PACKAGE_ROOT = findPackageRoot();
export const STYLES = path.join(PACKAGE_ROOT, "styles");
export const DEFAULT_CSS = path.join(STYLES, "book.css");
// Pagination rules that only the Paged.js engine needs; layered after book.css.
export const PAGED_CSS = path.join(STYLES, "paged.css");
