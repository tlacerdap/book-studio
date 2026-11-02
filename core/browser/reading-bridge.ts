// Runs inside the reading view's frame, after the page has been paginated. It is the only channel between the frame and
// the app: it reports where each block of the chapter is, and what the reader clicks or selects; the app tells it which
// blocks carry notes. Messages go to the parent window only, and only the parent's messages are accepted.

type Quote = { id: number; src: string; text: string; done?: boolean };
type Whole = { id: number; src: string; done: boolean };
type Block = { src: string; first: number; last: number; top: number; bottom: number; page: number };

type ToFrame =
  | { type: "mark"; notes: Record<string, "open" | "answered">; active: string | null; quotes: Quote[]; wholes: Whole[]; pending: { src: string; text: string } | null; focus: number[] }
  | { type: "scroll-to"; y: number }
  | { type: "find"; query: string; backwards: boolean }
  | { type: "clear-selection" };

const parentWin = window.parent;
const send = (msg: Record<string, unknown>): void => parentWin.postMessage({ source: "book-studio-reading", ...msg }, "*");

/** Top-level blocks: elements with a data-src that are not inside another one (list items are inside their list). */
function topBlocks(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-src]")).filter((el) => !el.parentElement?.closest("[data-src]"));
}

function blockOf(node: Node | null): HTMLElement | null {
  const el = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement | null);
  const hit = el?.closest<HTMLElement>("[data-src]");
  if (!hit) return null;
  return hit.parentElement?.closest<HTMLElement>("[data-src]") ?? hit;
}

function measure(): Block[] {
  const seen = new Map<string, Block>();
  const pages = Array.from(document.querySelectorAll(".pagedjs_page"));
  for (const el of topBlocks()) {
    const src = el.dataset.src!;
    const [first, last] = src.split("-").map(Number);
    const r = el.getBoundingClientRect();
    const top = r.top + window.scrollY;
    const page = pages.indexOf(el.closest(".pagedjs_page")!);
    const have = seen.get(src);
    // A block split across pages has one fragment per page: the first fragment gives its position.
    if (!have) seen.set(src, { src, first, last, top, bottom: top + r.height, page });
    else have.bottom = Math.max(have.bottom, top + r.height);
  }
  return [...seen.values()];
}

function report(): void {
  const pages = document.querySelectorAll(".pagedjs_page");
  const first = pages[0]?.getBoundingClientRect();
  send({
    type: "ready",
    height: document.documentElement.scrollHeight,
    pageLeft: first ? first.left : 0,
    pageRight: first ? first.right : 0,
    pages: pages.length,
    blocks: measure(),
    headings: Array.from(document.querySelectorAll<HTMLElement>("h2[data-src], h3[data-src]")).map((h) => ({ src: h.dataset.src!, top: h.getBoundingClientRect().top + window.scrollY })),
  });
}

// ---- the page's text, flattened -------------------------------------------------------------------
//
// Notes point at words, so the words are searched in one flat string made of the text of the blocks, in reading order.
// Every character remembers which text node and offset it came from: that is what makes a highlight exact even where the
// page has runs of spaces (code) or a block continues on the next page. Page headers and the printed hyphens that
// pagination adds are left out, so the same text is produced when words are selected and when they are looked up.

const SKIP = ".pg-hy, .ext-url";
const BLOCKISH = "p, li, h1, h2, h3, h4, h5, h6, pre, td, th, blockquote, figcaption, dt, dd, .cl";

interface FlatNode {
  node: Text;
  from: number;
  to: number;
  src: string;
}
interface Flat {
  /** Lower case, one kind of quote, single spaces: what searches run on. */
  text: string;
  /** The same characters as the page shows them (single spaces), for the words saved in a note. */
  shown: string;
  nodeOf: number[];
  rawOf: number[];
  nodes: FlatNode[];
  index: Map<Node, number>;
}

function norm(c: string): string {
  if (/[\u2018\u2019\u201c\u201d"']/.test(c)) return "'";
  const l = c.toLowerCase();
  return l.length === 1 ? l : c;
}

/** A string run through the same normalising as the page text, so it can be searched for. */
function normText(t: string): string {
  let out = "";
  let space = true;
  for (const ch of t) {
    if (/\s/.test(ch)) {
      if (!space) out += " ";
      space = true;
    } else {
      out += norm(ch);
      space = false;
    }
  }
  return out.trim();
}

let cached: Flat | null = null;

function flat(): Flat {
  if (cached) return cached;
  const text: string[] = [];
  const shown: string[] = [];
  const nodeOf: number[] = [];
  const rawOf: number[] = [];
  const nodes: FlatNode[] = [];
  const index = new Map<Node, number>();
  let last: Element | null = null;
  const push = (norm_: string, show: string, node: number, raw: number): void => {
    text.push(norm_);
    shown.push(show);
    nodeOf.push(node);
    rawOf.push(raw);
  };
  for (const top of topBlocks()) {
    const src = top.dataset.src!;
    const walker = document.createTreeWalker(top, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n as Text;
      if (t.parentElement?.closest(SKIP)) continue;
      const blk = t.parentElement?.closest(BLOCKISH) ?? top;
      if (blk !== last) {
        last = blk;
        if (text.length && text[text.length - 1] !== " ") push(" ", " ", -1, 0);
      }
      const from = text.length;
      let space = text.length > 0 && text[text.length - 1] === " ";
      for (let i = 0; i < t.data.length; i++) {
        const ch = t.data[i];
        if (/\s/.test(ch)) {
          if (space) continue;
          space = true;
          push(" ", " ", nodes.length, i);
        } else {
          space = false;
          push(norm(ch), ch, nodes.length, i);
        }
      }
      index.set(t, nodes.length);
      nodes.push({ node: t, from, to: text.length, src });
    }
  }
  cached = { text: text.join(""), shown: shown.join(""), nodeOf, rawOf, nodes, index };
  return cached;
}

/** Where a point in the document falls in the flat text: the first character at or after it. */
function boundary(f: Flat, container: Node, offset: number): number {
  const at = container.nodeType === Node.TEXT_NODE ? f.index.get(container) : undefined;
  if (at !== undefined) {
    const n = f.nodes[at];
    for (let i = n.from; i < n.to; i++) if (f.rawOf[i] >= offset) return i;
    return n.to;
  }
  const r = document.createRange();
  r.setStart(container, offset);
  r.collapse(true);
  for (const n of f.nodes) if (r.comparePoint(n.node, 0) >= 0) return n.from;
  return f.text.length;
}

/**
 * The words the reader selected, as they are saved with a note. Up to 200 characters they are kept whole; longer, the
 * first and last words are kept with " ... " between, which is enough to find the whole stretch again.
 * `src` is the block where the selection ends: the note goes under it.
 */
function selectionQuote(): { src: string; text: string } | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  const f = flat();
  let a = boundary(f, r.startContainer, r.startOffset);
  let b = boundary(f, r.endContainer, r.endOffset);
  while (a < b && f.shown[a] === " ") a++;
  while (b > a && f.shown[b - 1] === " ") b--;
  if (a >= b) return null;
  let end = b - 1;
  while (end > a && f.nodeOf[end] < 0) end--;
  const node = f.nodes[f.nodeOf[end]];
  if (!node) return null;
  const full = f.shown.slice(a, b);
  const text = full.length <= 200 ? full : `${full.slice(0, 90).trimEnd()} ... ${full.slice(-90).trimStart()}`;
  return { src: node.src, text };
}

/** Where a note's words are on the page: indexes into the flat text, or null if they cannot be found any more. */
function locate(f: Flat, q: { src: string; text: string }): [number, number] | null {
  let lo = -1;
  let hi = -1;
  for (const n of f.nodes) {
    if (n.src !== q.src) continue;
    if (lo < 0) lo = n.from;
    hi = n.to;
  }
  if (lo < 0) return null;
  const parts = q.text.split(" ... ");
  if (parts.length === 2) {
    const head = normText(parts[0]);
    const tail = normText(parts[1]);
    if (!head || !tail) return null;
    const t = f.text.indexOf(tail, lo);
    if (t < 0 || t + tail.length > hi) return null;
    const h = f.text.lastIndexOf(head, t - head.length);
    return h < 0 ? null : [h, t + tail.length];
  }
  const needle = normText(q.text);
  if (!needle) return null;
  const i = f.text.indexOf(needle, lo);
  return i < 0 || i + needle.length > hi ? null : [i, i + needle.length];
}

/** Ranges over exactly the characters [a, b), one per text node, so page headers in between are never marked. */
function rangesFor(f: Flat, a: number, b: number): Range[] {
  const out: Range[] = [];
  let i = a;
  while (i < b) {
    const ni = f.nodeOf[i];
    if (ni < 0) {
      i++;
      continue;
    }
    const n = f.nodes[ni];
    const end = Math.min(b, n.to);
    const r = document.createRange();
    r.setStart(n.node, f.rawOf[i]);
    r.setEnd(n.node, f.rawOf[end - 1] + 1);
    out.push(r);
    i = end;
  }
  return out;
}

/** Every fragment of a block (one per page it spans), as ranges over its text. */
function wholeRanges(src: string): Range[] {
  return Array.from(document.querySelectorAll<HTMLElement>(`[data-src="${src}"]`))
    .filter((el) => !el.parentElement?.closest("[data-src]"))
    .map((el) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      return r;
    });
}

/** What the notes cover on the page right now, for finding which note a click landed on. */
let marks: { id: number; src: string; whole: boolean; a: number; b: number }[] = [];

/**
 * What the notes point at stays marked on the page for as long as the note exists: the exact words when the reader
 * selected some, otherwise the whole block. Answered notes are marked more quietly than open ones, and the notes the
 * reader just clicked are marked strongest.
 */
function highlight(quotes: Quote[], wholes: Whole[], pending: { src: string; text: string } | null, focus: number[]): void {
  const css = (window as unknown as { CSS?: { highlights?: Map<string, unknown> } }).CSS;
  const HL = (window as unknown as { Highlight?: new (...r: Range[]) => { priority: number } }).Highlight;
  if (!css?.highlights || !HL) return;
  const set = (name: string, priority: number, ranges: Range[]): void => {
    const h = new HL(...ranges);
    h.priority = priority;
    css.highlights!.set(name, h);
  };
  const f = flat();
  marks = [];
  const quoted: { done: boolean; id: number; ranges: Range[] }[] = [];
  const blocks: { done: boolean; id: number; src: string }[] = [];
  for (const q of quotes) {
    const at = locate(f, q);
    // A note whose words can no longer be found (the text was edited) falls back to marking its block.
    if (at) {
      marks.push({ id: q.id, src: q.src, whole: false, a: at[0], b: at[1] });
      quoted.push({ done: !!q.done, id: q.id, ranges: rangesFor(f, at[0], at[1]) });
    } else blocks.push({ done: !!q.done, id: q.id, src: q.src });
  }
  for (const w of wholes) blocks.push({ done: w.done, id: w.id, src: w.src });
  for (const b of blocks) marks.push({ id: b.id, src: b.src, whole: true, a: 0, b: 0 });
  set("note-block", 0, blocks.filter((b) => !b.done).flatMap((b) => wholeRanges(b.src)));
  set("note-block-done", 0, blocks.filter((b) => b.done).flatMap((b) => wholeRanges(b.src)));
  set("note-quote", 1, quoted.filter((q) => !q.done).flatMap((q) => q.ranges));
  set("note-quote-done", 1, quoted.filter((q) => q.done).flatMap((q) => q.ranges));
  const p = pending ? locate(f, pending) : null;
  set("note-pending", 2, p ? rangesFor(f, p[0], p[1]) : []);
  set("note-focus", 3, [...quoted.filter((q) => focus.includes(q.id)).flatMap((q) => q.ranges), ...blocks.filter((b) => focus.includes(b.id)).flatMap((b) => wholeRanges(b.src))]);
}

function mark(notes: Record<string, "open" | "answered">, active: string | null): void {
  for (const el of document.querySelectorAll<HTMLElement>("[data-note], [data-active]")) {
    delete el.dataset.note;
    delete el.dataset.active;
  }
  for (const el of topBlocks()) {
    const src = el.dataset.src!;
    if (notes[src]) el.dataset.note = notes[src];
    if (active === src) el.dataset.active = "";
  }
}

window.addEventListener("message", (e: MessageEvent) => {
  if (e.source !== parentWin) return;
  const m = e.data as ToFrame;
  if (m.type === "mark") {
    cached = null;
    mark(m.notes, m.active);
    highlight(m.quotes ?? [], m.wholes ?? [], m.pending ?? null, m.focus ?? []);
  }
  else if (m.type === "scroll-to") window.scrollTo({ top: m.y });
  else if (m.type === "clear-selection") window.getSelection()?.removeAllRanges();
  else if (m.type === "find") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).find(m.query, false, m.backwards, true, false, false, false);
    const sel = window.getSelection();
    const r = sel && sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
    send({ type: "found", found: !!r && (r.width > 0 || r.height > 0), y: r ? r.top + window.scrollY : 0 });
  }
});

document.addEventListener("mouseup", (e) => {
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && sel.toString().trim()) {
    const q = selectionQuote();
    const b = q ? null : (blockOf(sel.focusNode) ?? blockOf(sel.anchorNode));
    if (q || b) {
      const rect = sel.getRangeAt(0).getClientRects()[0];
      return send({ type: "select", src: q ? q.src : b!.dataset.src, text: q ? q.text : sel.toString().replace(/\s+/g, " ").trim().slice(0, 200), y: rect ? rect.top + window.scrollY : e.clientY + window.scrollY });
    }
  }
  const b = blockOf(e.target as Node);
  // Which notes cover the spot that was clicked: the ones whose words contain it, else those on the whole block.
  let notes: number[] = [];
  const at = (document as unknown as { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint?.(e.clientX, e.clientY);
  if (at && b) {
    const f = flat();
    const i = boundary(f, at.startContainer, at.startOffset);
    notes = marks.filter((m) => !m.whole && i >= m.a && i <= m.b).map((m) => m.id);
    if (!notes.length) notes = marks.filter((m) => m.whole && m.src === b.dataset.src).map((m) => m.id);
  }
  send({ type: "click", src: b ? b.dataset.src : null, y: e.clientY + window.scrollY, notes });
});

// The frame can hold the keyboard focus (after a click on the page). The keys that matter for writing a note are
// passed to the app, which decides whether a note is being written; nothing else leaves the frame.
document.addEventListener("keydown", (e) => {
  if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key.length === 1 || e.key === "Escape" || e.key === "Enter") send({ type: "key", key: e.key, code: e.code, shift: e.shiftKey });
});

document.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest("a");
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute("href") ?? "";
  if (href.startsWith("#")) {
    const target = document.getElementById(href.slice(1));
    if (target) return window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY - 24 });
    return send({ type: "goto-chapter", id: href.slice(1) });
  }
  if (/^https?:\/\//i.test(href)) send({ type: "open-external", url: href });
});

window.addEventListener("resize", () => report());

async function waitForPages(): Promise<void> {
  for (;;) {
    const ready = window.__bookReady;
    if (ready) {
      if ("error" in ready) return send({ type: "error", message: ready.error });
      await document.fonts.ready;
      return report();
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}
void waitForPages();
