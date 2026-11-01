// Page geometry shared by the pagination rules and the integrity check.

/**
 * A line must end at least this many pixels above the bottom of the page area to count as fitting. Pagination is
 * measured on screen and then printed by laying the page out again; a line that fits by a pixel or two can flip into
 * the hidden overflow column there, and the text is lost. A few pixels of slack never change where a page of
 * ordinary text breaks (a line is 24px) but make the result stable.
 */
export const BOTTOM_SLACK = 4;

export interface Bounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const BLOCKISH = new Set(["block", "list-item", "table-cell", "flow-root", "table", "flex", "grid"]);

export const cs = (el: Element): CSSStyleDeclaration => getComputedStyle(el);

function isInlineLevel(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").trim().length > 0;
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const d = cs(node as Element).display;
  return d === "inline" || d === "inline-block" || d === "contents";
}

/** A block that holds lines of text directly: a paragraph, heading, code line, or a list item with inline content. */
export function isLeaf(el: Element): boolean {
  if (!BLOCKISH.has(cs(el).display)) return false;
  for (const child of el.childNodes) if (isInlineLevel(child)) return true;
  return false;
}

export function leafContaining(node: Node, root: Element): Element | null {
  let el: Node | null = node.nodeType === Node.ELEMENT_NODE ? node : node.parentNode;
  while (el && el !== root) {
    if (el.nodeType === Node.ELEMENT_NODE && isLeaf(el as Element)) return el as Element;
    el = el.parentNode;
  }
  return null;
}

/**
 * The padding and border below the last line of a code block's frame. They have to fit on the page too: a fragment
 * that ends flush with the bottom of the area would otherwise spill over, and Chromium would push the block away.
 */
export function frameBelow(leaf: Element | null): number {
  if (!leaf || !leaf.classList.contains("cl") || leaf.nextElementSibling) return 0;
  const pre = leaf.closest("pre");
  if (!pre) return 0;
  const k = cs(pre);
  return (parseFloat(k.paddingBottom) || 0) + (parseFloat(k.borderBottomWidth) || 0);
}

/**
 * Is this character outside the page area? Below its bottom, or in the extra column to the right where Paged.js lets
 * overflowing text flow. A code frame reaches past the right edge of the area into the margin, so a character there is
 * still on the page as long as the block fragment that holds it starts in the first column.
 */
export function charOutside(q: DOMRect, textNode: Node, bounds: Bounds): boolean {
  const leaf = leafContaining(textNode, document.body);
  if (q.bottom + frameBelow(leaf) > bounds.bottom - BOTTOM_SLACK) return true;
  if (q.left < bounds.right - 1) return false;
  if (!leaf) return true;
  const cx = q.left + q.width / 2;
  const cy = q.top + q.height / 2;
  for (const r of Array.from(leaf.getClientRects())) {
    if (cx >= r.left && cx <= r.right && cy >= r.top - 1 && cy <= r.bottom + 1) return r.left >= bounds.right - 1;
  }
  return true;
}

/** The first character, in reading order, that lies outside the page area. */
export function firstOutside(root: Element, bounds: Bounds): { node: Node; offset: number } | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const r = document.createRange();
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const text = t.textContent ?? "";
    if (!text.trim()) continue;
    r.selectNodeContents(t);
    if (!Array.from(r.getClientRects()).some((q) => charOutside(q, t, bounds))) continue;
    for (let i = 0; i < text.length; i++) {
      if (/\s/.test(text[i]) || text[i] === "\u00ad") continue;
      r.setStart(t, i);
      r.setEnd(t, i + 1);
      const q = r.getClientRects()[0];
      if (q && q.height > 0 && charOutside(q, t, bounds)) return { node: t, offset: i };
    }
  }
  return null;
}
