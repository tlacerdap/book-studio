// Which stylesheets apply to a book, and the measurements the checker reads back from them.
// The default typography is styles/book.css. A book may add its own book.css next to its book.yaml; it is
// layered after the default. `extra` files (from --extra-css) go last.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { cssOverride, type BookConfig } from "./config.ts";
import { DEFAULT_CSS, PAGED_CSS } from "./paths.ts";

export function styleFiles(book: BookConfig, extra: string[] = [], opts: { paged?: boolean } = {}): string[] {
  const files = [DEFAULT_CSS];
  if (opts.paged && fs.existsSync(PAGED_CSS)) files.push(PAGED_CSS);
  const own = cssOverride(book);
  if (own) files.push(own);
  files.push(...extra);
  return files;
}

/** Relative url(...) values become absolute file URLs, resolved against the stylesheet that contains them. */
function absoluteUrls(css: string, dir: string, urlFor: (abs: string) => string): string {
  return css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/g, (whole, q: string, u: string) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(u)) return whole;
    return `url(${q}${urlFor(path.resolve(dir, u))}${q})`;
  });
}

export function readCss(files: string[], opts: { absoluteUrls?: boolean; urlFor?: (abs: string) => string } = {}): string {
  const urlFor = opts.urlFor ?? ((abs: string) => pathToFileURL(abs).href);
  return files
    .map((f) => {
      const css = fs.readFileSync(f, "utf8");
      return opts.absoluteUrls ? absoluteUrls(css, path.dirname(f), urlFor) : css;
    })
    .join("\n");
}

/** Custom properties declared in the stylesheet text; a later declaration wins. */
export function cssVariables(css: string): Record<string, string> {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Record<string, string> = {};
  for (const m of clean.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const MM = 72 / 25.4;
const UNITS: Record<string, number> = { pt: 1, mm: MM, cm: 10 * MM, in: 72, px: 0.75 };

export function toPt(value: string): number {
  const m = /^\s*(-?[\d.]+)\s*(pt|mm|cm|in|px)\s*$/.exec(value);
  if (!m) throw new Error(`cannot read ${JSON.stringify(value)} as a length in pt, mm, cm, in or px`);
  return parseFloat(m[1]) * UNITS[m[2]];
}

const firstFamily = (v: string) => v.split(",")[0].trim().replace(/^["']|["']$/g, "");

/** What the checker needs to recognise headings, code and the text area in the PDF. */
export interface StyleMetrics {
  topMargin: number;
  bottomMargin: number;
  sideMargin: number;
  codeSize: number;
  headingSerif: string; // first family of --font-heading, hyphens and spaces removed
  mono: string; // first family of --font-mono, likewise
  h1Size: number;
  h2Size: number;
  h3Size: number;
  bulletSize: number;
}

export function styleMetrics(css: string): StyleMetrics {
  const v = cssVariables(css);
  const pt = (name: string): number => {
    if (!(name in v)) throw new Error(`the stylesheet does not define ${name}, which the checker needs`);
    return toPt(v[name]);
  };
  const fam = (name: string): string => {
    if (!(name in v)) throw new Error(`the stylesheet does not define ${name}, which the checker needs`);
    return firstFamily(v[name]).replace(/[- ]/g, "");
  };
  return {
    topMargin: pt("--margin-top"),
    bottomMargin: pt("--margin-bottom"),
    sideMargin: pt("--margin-side"),
    codeSize: pt("--size-code"),
    headingSerif: fam("--font-heading"),
    mono: fam("--font-mono"),
    h1Size: pt("--size-h1"),
    h2Size: pt("--size-h2"),
    h3Size: pt("--size-h3"),
    bulletSize: pt("--bullet-size"),
  };
}

/**
 * Paged.js reads page margins and sizes as plain lengths and cannot resolve `var()` inside `@page`. Replace each
 * `var(--x)` inside an `@page` block (margin boxes included) with the custom property's declared value.
 */
export function resolvePageVars(css: string): string {
  const vars = cssVariables(css);
  const resolve = (text: string, depth = 0): string =>
    depth > 8
      ? text
      : text.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g, (_m, name: string, fallback?: string) =>
          resolve(vars[name] ?? fallback?.trim() ?? "", depth + 1),
        );
  let out = "";
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf("@page", i);
    if (at === -1) break;
    const open = css.indexOf("{", at);
    if (open === -1) break;
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") depth--;
      j++;
    }
    out += css.slice(i, at) + resolve(css.slice(at, j));
    i = j;
  }
  return out + css.slice(i);
}

/**
 * Chromium applies orphans, widows and break-inside itself when it fragments content, and Paged.js fragments content
 * into columns. Its own overflow detection assumes text flows on continuously, so Chromium's adjustments strand
 * blocks in the hidden overflow column. Hand the three properties to our own rules as custom properties instead.
 */
export function forPaged(text: string): string {
  return text
    .replace(/(?<![\w-])orphans(\s*:)/g, "--pg-orphans$1")
    .replace(/(?<![\w-])widows(\s*:)/g, "--pg-widows$1")
    .replace(/(?<![\w-])break-inside(\s*:)/g, "--pg-break-inside$1");
}
