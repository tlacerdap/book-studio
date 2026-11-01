// A small glob for `chapters` in book.yaml: `*`, `?` and `**` over a directory tree. Returns absolute paths of files.

import fs from "node:fs";
import path from "node:path";

function toRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") i++;
        re += "(?:.*/)?";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function globFiles(root: string, pattern: string): string[] {
  const norm = pattern.replace(/^\.\//, "");
  const parts = norm.split("/");
  const wild = parts.findIndex((p) => /[*?]/.test(p));
  // The directory to start walking from: everything before the first wildcard (or the parent of a literal path).
  const baseParts = wild === -1 ? parts.slice(0, -1) : parts.slice(0, wild);
  const base = path.join(root, ...baseParts);
  const re = toRegExp(norm);
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        walk(full);
      } else if (e.isFile() || e.isSymbolicLink()) {
        const rel = path.relative(root, full).split(path.sep).join("/");
        if (re.test(rel)) out.push(full);
      }
    }
  };
  walk(base);
  return out;
}
