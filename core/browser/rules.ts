// Pagination rules Paged.js does not have: widows, orphans, keep-with-next, and a stricter break-inside.
//
// Paged.js fills a page until content overflows, then cuts at the first overflowing position. This handler
// moves that cut earlier, never later, until no rule is broken:
//   1. break-inside: avoid        the element moves whole to the next page
//   2. orphans / widows           measured in rendered lines, from the computed `orphans` and `widows`
//   3. break-after / break-before: avoid
//                                 a heading, a lead-in sentence or the last two list items move together
// It gives up on a rule when obeying it would leave the page empty (a block taller than a page).

import { BOTTOM_SLACK, cs, firstOutside, isLeaf, leafContaining, type Bounds } from "./geometry.ts";

type Pos = { node: Node; offset: number };

/** Blocks of text in reading order. A code block counts once, however many lines it has. */
function leavesIn(root: Element): Element[] {
  const out: Element[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n as Element;
    if (!isLeaf(el)) continue;
    const unit = codeBlockOf(el) ?? rowOf(el, root) ?? el;
    if (out[out.length - 1] !== unit) out.push(unit);
  }
  return out;
}

/** The outermost flex or grid container between `el` and `root`: a row of the contents list is one unit, not three blocks. */
function rowOf(el: Element, root: Element): Element | null {
  let top: Element | null = null;
  for (let p = el.parentElement; p && p !== root; p = p.parentElement) if (/flex|grid/.test(cs(p).display)) top = p;
  return top;
}

const codeBlockOf = (el: Element): Element | null => (el.classList.contains("cl") ? el.closest("pre") : null);

const isBlank = (el: Element): boolean => !(el.textContent ?? "").trim();

/** The first text position of a leaf (the start of its first non-empty text node). */
function leafStart(leaf: Element): Pos | null {
  const w = document.createTreeWalker(leaf, NodeFilter.SHOW_TEXT);
  for (let t = w.nextNode(); t; t = w.nextNode()) if ((t.textContent ?? "").trim()) return { node: t, offset: (t.textContent ?? "").search(/\S/) };
  return null;
}

interface Line {
  center: number;
  start: Pos;
}

/**
 * The rendered lines of a leaf, in reading order, and which of them contains `at`.
 * Paged.js lets overflowing content flow into a second column to the right, where it starts again at the top, so a
 * new line begins whenever the vertical position jumps by more than most of a line height in either direction.
 */
function linesOf(leaf: Element, at?: Pos): { lines: Line[]; cut: number } {
  const lines: Line[] = [];
  let cut = -1;
  const lh = parseFloat(cs(leaf).lineHeight) || 20;
  const w = document.createTreeWalker(leaf, NodeFilter.SHOW_TEXT);
  const r = document.createRange();
  for (let t = w.nextNode(); t; t = w.nextNode()) {
    const text = t.textContent ?? "";
    for (let i = 0; i < text.length; i++) {
      const isAt = at && at.node === t && at.offset === i;
      if (/\s/.test(text[i]) || text[i] === "\u00ad") {
        continue;
      }
      r.setStart(t, i);
      r.setEnd(t, i + 1);
      const rect = r.getClientRects()[0];
      if (!rect || rect.height === 0) continue;
      const center = rect.top + rect.height / 2;
      const last = lines[lines.length - 1];
      if (!last || Math.abs(center - last.center) > lh * 0.6) lines.push({ center, start: { node: t, offset: i } });
      if (isAt || (at && cut === -1 && at.node === t && at.offset <= i)) cut = lines.length - 1;
    }
  }
  return { lines, cut: cut === -1 ? 0 : cut };
}

function hasContentBefore(root: Element, pos: Pos): boolean {
  const r = document.createRange();
  r.setStart(root, 0);
  try {
    r.setEnd(pos.node, pos.offset);
  } catch {
    return false;
  }
  return r.toString().trim().length > 0 || r.cloneContents().querySelector("img,svg,hr") !== null;
}

function posBefore(el: Element): Pos {
  const parent = el.parentNode!;
  return { node: parent, offset: Array.prototype.indexOf.call(parent.childNodes, el) };
}

/** Is `leaf` the last leaf of `ancestor`, so a break after `ancestor` is a break after `leaf`? */
function endsAncestor(leaf: Element, ancestor: Element): boolean {
  let el: Element | null = leaf;
  while (el && el !== ancestor) {
    if (el.nextElementSibling) return false;
    el = el.parentElement;
  }
  return el === ancestor;
}

function startsAncestor(leaf: Element, ancestor: Element): boolean {
  let el: Element | null = leaf;
  while (el && el !== ancestor) {
    if (el.previousElementSibling) return false;
    el = el.parentElement;
  }
  return el === ancestor;
}

// Paged.js strips break-before and break-after out of the stylesheet and records them as data attributes. orphans,
// widows and break-inside reach the page as custom properties (--pg-*): if Chromium saw the real properties it would
// apply them itself inside Paged.js's column layout and fight its overflow detection (see core/pdf.ts).
const breakValue = (el: Element, prop: "breakAfter" | "breakBefore" | "breakInside"): string =>
  prop === "breakInside" ? cs(el).getPropertyValue("--pg-break-inside").trim() : ((el as HTMLElement).dataset?.[prop] ?? cs(el)[prop]);

const pgInt = (el: Element, name: "orphans" | "widows", fallback: number): number => parseInt(cs(el).getPropertyValue("--pg-" + name), 10) || fallback;

function avoidAfter(leaf: Element, root: Element): boolean {
  for (let el: Element | null = leaf; el && el !== root; el = el.parentElement) {
    if (!endsAncestor(leaf, el)) break;
    if (breakValue(el, "breakAfter") === "avoid") return true;
  }
  return false;
}

function avoidBefore(leaf: Element, root: Element): boolean {
  for (let el: Element | null = leaf; el && el !== root; el = el.parentElement) {
    if (!startsAncestor(leaf, el)) break;
    if (breakValue(el, "breakBefore") === "avoid") return true;
  }
  return false;
}

/** The outermost ancestor of the position (inside `root`) that must not be split, leaving out those in `skip`. */
function avoidInsideAncestor(node: Node, root: Element, skip?: Set<Element>): Element | null {
  let found: Element | null = null;
  let el: Node | null = node.nodeType === Node.ELEMENT_NODE ? node : node.parentNode;
  while (el && el !== root) {
    if (el.nodeType === Node.ELEMENT_NODE && breakValue(el as Element, "breakInside") === "avoid" && !skip?.has(el as Element)) found = el as Element;
    el = el.parentNode;
  }
  return found;
}

/**
 * True when everything on the page before `el` is a chain of blocks that must stay with what follows (a heading, a
 * lead-in sentence). Moving `el` to the next page would then drag the whole page along, and leave nothing here: the
 * chain would only be stranded again on the next page. The element has to be split instead.
 */
function onlyChainBefore(el: Element, root: Element): boolean {
  const leaves = leavesIn(root);
  const first = leaves.findIndex((l) => el.contains(l));
  if (first <= 0) return false;
  for (let i = first - 1; i >= 0; i--) if (!(avoidAfter(leaves[i], root) || avoidBefore(leaves[i + 1], root))) return false;
  return true;
}

/** The first non-blank text position at or after a boundary, inside `root`. */
function textPosAfter(pos: Pos, root: Element): Pos | null {
  if (pos.node.nodeType === Node.TEXT_NODE) return pos;
  const parent = pos.node as Element;
  let from: Node | null = parent.childNodes[pos.offset] ?? null;
  // Walk forward in document order from `from` (or from after `parent` if the boundary is at its end).
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let candidate: Node | null = null;
  if (from) {
    walker.currentNode = from.nodeType === Node.TEXT_NODE ? from : (from.firstChild ? from : from);
    const probe = (n: Node | null): Node | null => {
      for (let t = n; t; t = walker.nextNode()) {
        if (t.nodeType === Node.TEXT_NODE && (t.textContent ?? "").trim() && (from!.contains(t) || from === t || !!(from!.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING))) return t;
      }
      return null;
    };
    candidate = probe(from.nodeType === Node.TEXT_NODE ? from : walker.nextNode());
  } else {
    let n: Node | null = parent;
    while (n && n !== root && !n.nextSibling) n = n.parentNode;
    if (n && n !== root && n.nextSibling) {
      walker.currentNode = n.nextSibling;
      const t0 = n.nextSibling.nodeType === Node.TEXT_NODE ? n.nextSibling : walker.nextNode();
      for (let t: Node | null = t0; t; t = walker.nextNode()) if ((t.textContent ?? "").trim()) { candidate = t; break; }
    }
  }
  if (!candidate) return null;
  return { node: candidate, offset: (candidate.textContent ?? "").search(/\S/) };
}

function atStartOf(el: Element, pos: Pos): boolean {
  const s = leafStart(el);
  return !!s && s.node === pos.node && pos.offset <= s.offset;
}

/**
 * The first character, in reading order, that lies outside the page area: below its bottom, or in the extra column
 * to the right where Paged.js lets overflowing text flow. Paged.js sometimes reports a later cut than this, which
 * would leave the lines in between in the page but clipped away when printed.
 */
/**
 * Where a cut that lands at the very start of `leaf` should go: before the block itself, and further up while the block is
 * the first thing in its parent. Cutting inside the block's text instead would leave an empty shell behind on the page
 * (a bullet with no text, an empty list).
 */
function startBefore(leaf: Element, root: Element): Pos {
  let el: Element = leaf;
  const hasContentBeforeIn = (parent: Element, child: Element): boolean => {
    for (let n = child.previousSibling; n; n = n.previousSibling) {
      if (n.nodeType === Node.ELEMENT_NODE || (n.textContent ?? "").trim()) return true;
    }
    return parent.querySelector(":scope > .pagedjs_ignore") !== null && false;
  };
  while (el.parentElement && el.parentElement !== root && !hasContentBeforeIn(el.parentElement, el)) el = el.parentElement;
  return posBefore(el);
}

export function adjustOverflow(overflow: Range, root: Element, bounds?: Bounds): Range | undefined {
  const range = overflow.cloneRange();
  let moved = false;
  if (bounds) {
    const out = firstOutside(root, bounds);
    if (out && range.comparePoint(out.node, out.offset) < 0) {
      range.setStart(out.node, out.offset);
      moved = true;
    }
  }
  const setStart = (p: Pos) => {
    range.setStart(p.node, p.offset);
    moved = true;
  };

  const unbreakableHere = new Set<Element>(); // elements that are allowed to split on this page, see onlyChainBefore
  for (let guard = 0; guard < 60; guard++) {
    const raw: Pos = { node: range.startContainer, offset: range.startOffset };
    const pos = textPosAfter(raw, root);
    if (!pos) break;

    // 1. break-inside: avoid. The element moves whole, unless it already starts the page (it is taller than a page).
    const avoid = avoidInsideAncestor(pos.node, root, unbreakableHere);
    if (avoid && !atStartOf(avoid, pos)) {
      const before = startBefore(avoid, root);
      if (hasContentBefore(root, before)) {
        // A heading alone on a page, with an element after it too tall to share the page: split the element (between
        // its inner items where it has them) rather than leave the heading stranded.
        if (onlyChainBefore(avoid, root)) {
          unbreakableHere.add(avoid);
          continue;
        }
        setStart(before);
        continue;
      }
    }

    const leaf0 = leafContaining(pos.node, root);
    if (!leaf0) break;

    // a row (flex or grid container) moves whole to the next page
    const row = rowOf(leaf0, root);
    if (row) {
      const before = startBefore(row, root);
      if (!atStartOf(row, pos) && hasContentBefore(root, before)) {
        setStart(before);
        continue;
      }
    }

    // 2a. code: cuts fall between lines; a block keeps at least `orphans` visible lines above and `widows` below
    const pre = codeBlockOf(leaf0);
    if (pre) {
      const cls = Array.from(pre.querySelectorAll(".cl"));
      let k = cls.indexOf(leaf0);
      if (!atStartOf(leaf0, pos)) {
        // mid-line: the whole logical line goes to the next page
        setStart(posBefore(leaf0));
        continue;
      }
      const visible = (a: number, b: number) => cls.slice(a, b).filter((c) => !isBlank(c)).length;
      const orphans = pgInt(pre, "orphans", 4);
      const widows = pgInt(pre, "widows", 4);
      if (k > 0) {
        // the line above the cut ends the fragment, so the frame's bottom padding and border must fit below it
        const slack = (parseFloat(cs(pre).paddingBottom) || 0) + (parseFloat(cs(pre).borderBottomWidth) || 0);
        while (bounds && k > 0 && cls[k - 1].getBoundingClientRect().bottom + slack > bounds.bottom - BOTTOM_SLACK) k--;
        while (k > 0 && visible(k, cls.length) < widows) k--; // move the cut up until `widows` visible lines remain below
        if (visible(0, k) < orphans) {
          const before = startBefore(pre, root);
          if (hasContentBefore(root, before)) {
            setStart(before);
            continue;
          }
          break; // the block starts the page: let it split where it must
        }
        if (cls[k] !== leaf0) {
          setStart(posBefore(cls[k]));
          continue;
        }
        break; // a cut inside a code block that satisfies both counts
      }
      // k === 0: the cut is before the block: fall through to keep-with-next on the block as a unit
    }
    const leaf = pre ?? row ?? leaf0;
    const { lines, cut } = pre ? { lines: [] as Line[], cut: 0 } : linesOf(leaf, pos);

    // A page never ends in a hyphenated word. If the cut is a hyphenated line break (the new page would begin in the
    // middle of a word), the whole line that ends with the hyphen goes to the next page too.
    if (!pre && cut > 0 && pos.node.nodeType === Node.TEXT_NODE) {
      const t = pos.node.textContent ?? "";
      const word = /[\p{L}\p{N}]/u;
      if (pos.offset > 0 && word.test(t[pos.offset - 1]) && word.test(t[pos.offset])) {
        setStart(lines[cut - 1].start);
        continue;
      }
    }

    // 2. orphans and widows, when the cut falls inside a block of text
    if (cut > 0) {
      const orphans = pgInt(leaf, "orphans", 2);
      const widows = pgInt(leaf, "widows", 2);
      let target = cut;
      if (lines.length - cut < widows) target = lines.length - widows;
      if (target < orphans) target = 0; // too few lines would stay on this page: the whole block moves
      if (target !== cut) {
        if (target === 0) {
          const before = startBefore(leaf, root);
          if (hasContentBefore(root, before)) {
            setStart(before);
            continue;
          }
        } else {
          setStart(lines[target].start);
          continue;
        }
      }
      break; // the cut is inside a block and its line counts are fine
    }

    // 3. the cut is exactly before `leaf`: keep with the previous block when either side asks for it
    const leaves = leavesIn(root);
    const idx = leaves.indexOf(leaf);
    const prev = idx > 0 ? leaves[idx - 1] : null;
    if (prev && (avoidAfter(prev, root) || avoidBefore(leaf, root))) {
      const before = startBefore(prev, root);
      if (hasContentBefore(root, before)) {
        setStart(before);
        continue;
      }
    }
    // The cut is at the start of `leaf` and nothing asks to move it: make it a cut before the block, not inside it.
    const clean = startBefore(leaf, root);
    if (hasContentBefore(root, clean) && (clean.node !== range.startContainer || clean.offset !== range.startOffset)) setStart(clean);
    break;
  }
  return moved ? range : undefined;
}

type LayoutLike = {
  hyphenateAtBreak: (node: Node, letter?: string) => void;
  hasOverflow: (el: Element, bounds?: Bounds) => boolean;
  findOverflow: (rendered: Element, bounds?: Bounds) => Range | undefined;
  bounds: Bounds;
  gap: number;
  __patched?: boolean;
};

/**
 * Paged.js decides whether a page overflows from element boxes and scroll sizes, and in this setup it sometimes
 * reports no overflow while text is plainly outside the page area, so the rest of the book piles into one page.
 * Replace its detection with ours: overflow is the text from the first character outside the area onwards.
 */
/** The page area as it is now. The rectangle a layout captured when the page was created can be a pixel off by then. */
function liveBounds(el: Element, fallback: Bounds): Bounds {
  const a = el.closest(".pagedjs_area")?.getBoundingClientRect();
  return a ? { left: a.left, right: a.right, top: a.top, bottom: a.bottom } : fallback;
}

function ownOverflowDetection(layout: LayoutLike): void {
  // Every page's Layout shares one prototype, so patching it once covers all later pages.
  const proto = Object.getPrototypeOf(layout) as LayoutLike & Record<string, unknown>;
  if (proto.__patched) return;
  proto.__patched = true;
  proto.hasOverflow = function (this: LayoutLike, el: Element, b: Bounds = this.bounds) {
    return firstOutside(el, liveBounds(el, b)) !== null;
  };
  proto.findOverflow = function (this: LayoutLike, rendered: Element, b: Bounds = this.bounds) {
    const out = firstOutside(rendered, liveBounds(rendered, b));
    if (!out || !rendered.lastChild) return undefined;
    const range = document.createRange();
    range.setStart(out.node, out.offset);
    range.setEndAfter(rendered.lastChild);
    return range;
  };
  // Paged.js adds a hyphen glyph wherever it splits a text node next to a letter. Keep that for a real mid-word cut
  // (the page ends "depend-" and the next begins "able"), in prose only, and mark the glyph so it is not counted as text.
  proto.hyphenateAtBreak = function (this: LayoutLike, node: Node, letter?: string) {
    if (node.nodeType !== Node.TEXT_NODE) return;
    const el = node.parentElement;
    if (!el || el.closest("pre, code")) return;
    const text = node.textContent ?? "";
    const prev = text.slice(-1);
    const word = /[\p{L}\p{N}]/u;
    if (!letter || !word.test(letter) || !(word.test(prev) || prev === "\u00ad")) return;
    if (prev === "\u00ad") node.textContent = text.slice(0, -1);
    const glyph = document.createElement("span");
    glyph.className = "pg-hy";
    glyph.textContent = "-";
    node.parentNode!.insertBefore(glyph, node.nextSibling);
  };
}

/** `?norules` turns the rules off, to produce a deliberately bad layout for testing the checker. */
const RULES_OFF = typeof location !== "undefined" && new URLSearchParams(location.search).has("norules");

export function PaginationRules(Handler: new (...a: unknown[]) => object) {
  return class PaginationRulesHandler extends Handler {
    // A split code block must not keep blank lines at the cut: they would print as an empty strip inside the frame.
    afterPageLayout(pageElement: Element, _page?: unknown, breakToken?: { node?: Node; offset?: number }): void {
      pageElement.querySelectorAll("pre").forEach((pre) => {
        const cls = Array.from(pre.querySelectorAll(".cl"));
        if (pre.hasAttribute("data-split-from")) for (const c of cls) { if (isBlank(c)) c.remove(); else break; }
        if (pre.hasAttribute("data-split-to")) for (const c of cls.reverse()) { if (isBlank(c)) c.remove(); else break; }
      });
    }

    onOverflow(overflow: Range, rendered: Element, bounds: Bounds, layout: LayoutLike): Range | undefined {
      ownOverflowDetection(layout);
      if (!overflow || RULES_OFF) return undefined;
      try {
        const res = adjustOverflow(overflow, rendered, liveBounds(rendered, bounds));
        return res;
      } catch (e) {
        console.warn("pagination rules failed: " + (e as Error).message);
        return undefined;
      }
    }
  };
}
