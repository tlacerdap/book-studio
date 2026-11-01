#!/usr/bin/env node
// Entry point for `npx book-studio`. The real work is in dist/cli.mjs (built from core/cli.ts).
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.mjs");
if (!existsSync(dist)) {
  process.stderr.write("book-studio is not built. Run `npm install && npm run build` in the book-studio folder first.\n");
  process.exit(1);
}
await import(dist);
