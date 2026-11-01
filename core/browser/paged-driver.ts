// Runs inside the page (hidden print window, or the app's reading view) after paged.polyfill.js has loaded with
// auto:false. Registers our pagination rules, paginates the document, and reports when done.

import { charOutside } from "./geometry.ts";
import { PaginationRules } from "./rules.ts";

declare global {
  interface Window {
    Paged: {
      Handler: new (...a: unknown[]) => object;
      Previewer: new () => {
        on?: (e: string, f: (p: any) => void) => void; preview(content?: unknown, stylesheets?: unknown, renderTo?: unknown): Promise<{ total: number; pages: unknown[] }> };
      registerHandlers(...h: unknown[]): void;
    };
    __bookReady?: { pages: number; ms: number; srcChars: number; outChars: number } | { error: string };
  }
}

/**
 * Number the pages once, here, instead of relying on Paged.js's counter arithmetic: the cover has no number, the
 * contents count from i, and the first chapter is 1. Every page gets an absolute counter value (no page depends on
 * the one before), and every contents entry gets the same page's label, so the footer and the contents cannot disagree.
 * (In this setup Paged.js's resets, increments and target-counter() disagreed with each other and with the footer.)
 */
function labelPages(): void {
  const pages = Array.from(document.querySelectorAll<HTMLElement>(".pagedjs_page"));
  const firstWith = (sel: string) => pages.findIndex((p) => p.querySelector(sel));
  const body = Math.max(0, firstWith(".first-chapter"));
  let front = firstWith(".toc");
  if (front < 0) front = body;
  const roman = (n: number): string => {
    let out = "";
    for (const [v, r] of [[10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]] as [number, string][]) while (n >= v) { out += r; n -= v; }
    return out;
  };
  const number = (i: number) => (i < front ? 0 : i < body ? i - front + 1 : i - body + 1);
  const label = (i: number) => (i < front ? "" : i < body ? roman(i - front + 1) : String(i - body + 1));
  pages.forEach((p, i) => {
    p.style.counterIncrement = "none";
    p.style.counterReset = `page ${number(i)}`;
  });
  document.querySelectorAll<HTMLAnchorElement>(".toc-list a[href^='#']").forEach((a) => {
    const target = document.getElementById(a.getAttribute("href")!.slice(1));
    const page = target?.closest(".pagedjs_page") as HTMLElement | null;
    if (page) a.setAttribute("data-page", label(pages.indexOf(page)));
  });
}

/** All the text that should end up on a page, with whitespace and soft hyphens removed so layout cannot change it. */
const squash = (t: string): string => t.replace(/[\s\u00ad]+/g, "");

/**
 * The text that is actually inside a page's content area, in reading order. Text that Paged.js left in the DOM but
 * pushed outside the area (below it, or into its overflow column) is clipped when printed, so it does not count.
 */
function visibleText(): string {
  let out = "";
  const r = document.createRange();
  for (const area of Array.from(document.querySelectorAll(".pagedjs_area"))) {
    const b = area.getBoundingClientRect();
    const walker = document.createTreeWalker(area, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const text = t.textContent ?? "";
      if (!text.trim() || t.parentElement?.classList.contains("pg-hy")) continue;
      r.selectNodeContents(t);
      const rects = Array.from(r.getClientRects());
      const inside = (q: DOMRect) => !charOutside(q, t, b);
      // Text with no box at all (hidden, or zero-size) is not on the page, even though every one of its zero rectangles
      // is trivially "inside".
      if (rects.length && rects.every(inside)) {
        out += text;
        continue;
      }
      for (let i = 0; i < text.length; i++) {
        if (/\s/.test(text[i])) continue;
        r.setStart(t, i);
        r.setEnd(t, i + 1);
        const q = r.getClientRects()[0];
        if (q && inside(q)) out += text[i];
      }
    }
  }
  return squash(out);
}

const describe = (args: unknown[]) =>
  args.map((a) => (a && (a as Node).nodeType ? `<${(a as Node).nodeName}: ${((a as Node).textContent ?? "").slice(0, 70).replace(/\n/g, " ")}>` : a));
for (const level of ["warn", "error"] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => orig(...describe(args));
}

export async function paginate(): Promise<void> {
  const t0 = performance.now();
  try {
    const srcText = squash(document.body.textContent ?? "");
    const srcChars = srcText.length;
    window.Paged.registerHandlers(PaginationRules(window.Paged.Handler));
    const previewer = new window.Paged.Previewer();
    const flow = await previewer.preview();
    await document.fonts.ready;
    labelPages();
    const outText = visibleText();
    const outChars = outText.length;
    if (outText !== srcText) {
      let i = 0;
      while (i < srcText.length && i < outText.length && srcText[i] === outText[i]) i++;
      console.log(`text differs at ${i}: source "${srcText.slice(Math.max(0, i - 30), i + 30)}" pages "${outText.slice(Math.max(0, i - 30), i + 30)}"`);
    }
    window.__bookReady = { pages: flow.total, ms: Math.round(performance.now() - t0), srcChars, outChars };
  } catch (e) {
    window.__bookReady = { error: String((e as Error)?.stack ?? e) };
  }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => void paginate());
else void paginate();
