// Runs inside the reading view's frame, after the page has been paginated. It is the only channel between the frame and
// the app: it reports where each block of the chapter is, and what the reader clicks or selects; the app tells it which
// blocks carry notes. Messages go to the parent window only, and only the parent's messages are accepted.

type Block = { src: string; first: number; last: number; top: number; bottom: number; page: number };

type ToFrame =
  | { type: "mark"; notes: Record<string, "open" | "answered">; active: string | null }
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
  if (m.type === "mark") mark(m.notes, m.active);
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
    if (b) return send({ type: "select", src: b.dataset.src, text: sel.toString().slice(0, 200) });
  }
  const b = blockOf(e.target as Node);
  send({ type: "click", src: b ? b.dataset.src : null });
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
