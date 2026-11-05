// Writes THIRD_PARTY_LICENSES.md: every package whose code ends up in Book Studio (the app, the installers, the exports),
// with its licence text. Run after changing dependencies:  npm run notices
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const modules = path.join(root, "node_modules");

// 1. The packages the sources import, plus the ones copied into the build whole.
const roots = new Set(["mermaid", "pagedjs", "pdfjs-dist", "@napi-rs/canvas"]);
const scan = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) scan(f);
    else if (/\.(ts|mjs|cjs)$/.test(e.name)) {
      for (const m of fs.readFileSync(f, "utf8").matchAll(/(?:from|import\()\s*["']([^"'.][^"']*)["']/g)) {
        const spec = m[1];
        if (spec.startsWith("node:") || spec === "electron") continue;
        const parts = spec.split("/");
        const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
        if (fs.existsSync(path.join(modules, name, "package.json"))) roots.add(name);
      }
    }
  }
};
for (const d of ["app", "core", "electron"]) scan(path.join(root, d));

// 2. Their runtime dependencies, all the way down.
const seen = new Map();
const read = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
const locate = (name, from) => {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    if (dir === path.dirname(dir) || dir === path.dirname(root)) break;
  }
  return null;
};
const visit = (name, from) => {
  const dir = locate(name, from);
  if (!dir || seen.has(dir)) return;
  seen.set(dir, read(dir));
  for (const dep of Object.keys({ ...(read(dir).dependencies ?? {}), ...(read(dir).optionalDependencies ?? {}) })) visit(dep, dir);
};
for (const r of roots) visit(r, root);

// 3. Licence texts, one copy of each.
const licenceText = (dir) => {
  const names = fs.readdirSync(dir).filter((f) => /^(licen[cs]e|copying|unlicense)/i.test(f) && fs.statSync(path.join(dir, f)).isFile());
  return names.length ? fs.readFileSync(path.join(dir, names[0]), "utf8").trim() : null;
};
const groups = new Map();
const rows = [];
for (const [dir, pkg] of [...seen].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
  const lic = typeof pkg.license === "string" ? pkg.license : pkg.license?.type ?? (pkg.licenses ?? []).map((l) => l.type).join(" OR ");
  const text = licenceText(dir) ?? `(no licence file in the package; it declares ${lic})`;
  const key = crypto.createHash("sha1").update(text).digest("hex");
  if (!groups.has(key)) groups.set(key, { text, pkgs: [] });
  groups.get(key).pkgs.push(`${pkg.name}@${pkg.version}`);
  const shown = lic || (/permission is hereby granted, free of charge/i.test(text) ? "MIT" : "see licence text");
  rows.push(`| ${pkg.name} | ${pkg.version} | ${shown} |`);
}

const fonts = [];
const fontRoot = path.join(root, "styles", "fonts");
for (const family of fs.readdirSync(fontRoot)) {
  const ofl = path.join(fontRoot, family, "OFL.txt");
  if (fs.existsSync(ofl)) fonts.push({ family, text: fs.readFileSync(ofl, "utf8").trim() });
}

const out = [
  "# Third-party licenses",
  "",
  "Book Studio itself is MIT-licensed (see `LICENSE`). It includes the open-source software and fonts below, each under its own licence,",
  "all of which allow free use and redistribution. Nothing in Book Studio is paid, proprietary or needs an account. This file is made by",
  "`npm run notices`.",
  "",
  "## Electron and Chromium",
  "",
  "The installers contain [Electron](https://www.electronjs.org) (MIT) and, inside it, Chromium and Node.js with their own open-source licences.",
  "The installers carry Electron's `LICENSE` and Chromium's `LICENSES.chromium.html` (listing every Chromium component) next to the app.",
  "",
  "## ELK (EPL-2.0)",
  "",
  "The diagram renderer (Mermaid) includes [ELK / elkjs](https://github.com/kieler/elkjs), which is offered under the Eclipse Public License 2.0",
  "(or GPL-3.0-or-later). Book Studio uses it under the EPL-2.0, unmodified. The licence is at <https://www.eclipse.org/legal/epl-2.0/> and its",
  "source code is at <https://github.com/kieler/elkjs>. The EPL covers only that component; the rest of Book Studio stays MIT.",
  "",
  "## Fonts (SIL Open Font License 1.1)",
  "",
  "The fonts in `styles/fonts/` are free under the SIL Open Font License, which allows using, embedding and redistributing them, including in",
  "documents made with Book Studio. They are not sold on their own.",
  "",
  ...fonts.flatMap((f) => [`### ${f.family}`, "", "```text", f.text, "```", ""]),
  "## Icon",
  "",
  "`assets/icon.png` is drawn by `scripts/make-icon.cjs` in this repository and is covered by the MIT licence.",
  "",
  `## Packages (${seen.size})`,
  "",
  "| Package | Version | Licence |",
  "| --- | --- | --- |",
  ...rows,
  "",
  "## Licence texts",
  "",
  ...[...groups.values()].flatMap((g) => [`### ${g.pkgs.length > 6 ? `${g.pkgs.slice(0, 6).join(", ")} and ${g.pkgs.length - 6} more` : g.pkgs.join(", ")}`, "", "```text", g.text, "```", ""]),
];
fs.writeFileSync(path.join(root, "THIRD_PARTY_LICENSES.md"), out.join("\n"));
console.log(`${seen.size} packages, ${groups.size} distinct licence texts, ${fonts.length} font families`);
