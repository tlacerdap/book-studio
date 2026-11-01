// Bundles the TypeScript: the CLI/core (node), the headless Electron print process, and the in-page driver.
import { build } from "esbuild";
import fs from "node:fs";

fs.mkdirSync("dist/browser", { recursive: true });
fs.mkdirSync("dist/electron", { recursive: true });

await build({
  entryPoints: { cli: "core/cli.ts" },
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outExtension: { ".js": ".mjs" },
  external: ["electron", "pdfjs-dist", "pdfjs-dist/*"],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "info",
});

await build({
  entryPoints: { "pdf-main": "electron/pdf-main.ts" },
  outdir: "dist/electron",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  outExtension: { ".js": ".cjs" },
  external: ["electron"],
  logLevel: "info",
});

await build({
  entryPoints: { "paged-driver": "core/browser/paged-driver.ts" },
  outdir: "dist/browser",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "chrome140",
  logLevel: "info",
});

fs.copyFileSync("node_modules/pagedjs/dist/paged.polyfill.js", "dist/browser/paged.polyfill.js");
fs.writeFileSync("dist/browser/paged-config.js", "window.PagedConfig = { auto: false };\n");
