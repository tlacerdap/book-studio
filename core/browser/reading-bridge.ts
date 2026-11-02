// Runs inside the reading view's frame, after the page has been paginated. It is the only channel between the frame and
// the app: it reports where each block of the chapter is, and what the reader clicks or selects; the app tells it which
// blocks carry notes. Messages go to the parent window only, and only the parent's messages are accepted.

type Quote = { src: string; text: string; done?: boolean };
type Block = { src: string; first: number; last: number; top: number; bottom: number; page: number };

type ToFrame =
  | { type: "mark"; notes: Record<string, "open" | "answered">; active: string | null; quotes: Quote[]; wholes: { src: string; done: boolean }[]; pending: { src: string; text: string } | null }
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

/** Lowercase, plain quotes, single spaces: so words copied from the page are found whatever the typography. */
function plain(t: string): string {
  return t.replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, " ").toLowerCase();
}

/** The range covering `needle` inside the blocks that carry `src` (a block split over pages is searched as one text). */
function findRange(src: string, needle: string): Range | null {
  const nodes: { node: Text; start: number }[] = [];
  let all = "";
  for (const el of document.querySelectorAll<HTMLElement>(`[data-src="${src}"]`)) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n as Text;
      if (t.parentElement?.closest(".pg-hy, .ext-url")) continue;
      nodes.push({ node: t, start: all.length });
      all += t.data.replace(/\s+/g, " ");
    }
  }
  const at = plain(all).indexOf(plain(needle).trim());
  if (at < 0 || !needle.trim()) return null;
  const end = at + plain(needle).trim().length;
  const locate = (pos: number): { node: Text; offset: number } | null => {
    for (let i = nodes.length - 1; i >= 0; i--) if (nodes[i].start <= pos) return { node: nodes[i].node, offset: Math.min(nodes[i].node.length, pos - nodes[i].start) };
    return null;
  };
  const a = locate(at);
  const b = locate(end - 1);
  if (!a || !b) return null;
  const r = document.createRange();
  r.setStart(a.node, a.offset);
  r.setEnd(b.node, Math.min(b.node.length, b.offset + 1));
  return r;
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

/**
 * What the notes point at stays marked on the page for as long as the note exists: the exact words when the reader
 * selected some, otherwise the whole block. Answered notes are marked more quietly than open ones.
 */
function highlight(quotes: Quote[], wholes: { src: string; done: boolean }[], pending: { src: string; text: string } | null): void {
  const css = (window as unknown as { CSS?: { highlights?: Map<string, unknown> } }).CSS;
  const HL = (window as unknown as { Highlight?: new (...r: Range[]) => { priority: number } }).Highlight;
  if (!css?.highlights || !HL) return;
  const set = (name: string, priority: number, ranges: Range[]): void => {
    const h = new HL(...ranges);
    h.priority = priority;
    css.highlights!.set(name, h);
  };
  const found = (list: Quote[]): Range[] => list.map((q) => findRange(q.src, q.text)).filter((r): r is Range => !!r);
  // A note whose words can no longer be found (the text was edited) falls back to marking its block.
  const lost = quotes.filter((q) => !findRange(q.src, q.text)).map((q) => ({ src: q.src, done: !!q.done }));
  const blocks = [...wholes, ...lost];
  set("note-block", 0, blocks.filter((b) => !b.done).flatMap((b) => wholeRanges(b.src)));
  set("note-block-done", 0, blocks.filter((b) => b.done).flatMap((b) => wholeRanges(b.src)));
  set("note-quote", 1, found(quotes.filter((q) => !q.done)));
  set("note-quote-done", 1, found(quotes.filter((q) => q.done)));
  const p = pending ? findRange(pending.src, pending.text) : null;
  set("note-pending", 2, p ? [p] : []);
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
    mark(m.notes, m.active);
    highlight(m.quotes ?? [], m.wholes ?? [], m.pending ?? null);
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
    const b = blockOf(sel.focusNode) ?? blockOf(sel.anchorNode);
    if (b) {
      const rect = sel.getRangeAt(0).getClientRects()[0];
      return send({ type: "select", src: b.dataset.src, text: sel.toString().slice(0, 200), y: rect ? rect.top + window.scrollY : e.clientY + window.scrollY });
    }
  }
  const b = blockOf(e.target as Node);
  send({ type: "click", src: b ? b.dataset.src : null, y: e.clientY + window.scrollY });
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
