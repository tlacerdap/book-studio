// The left panel: the book's Parts and chapters, with the outline of the chapter that is open and a badge for open notes.

import type { ChapterSummary } from "../../core/book.ts";
import type { BookInfo, PageCounts } from "../shared/api.ts";
import { clear, h } from "./dom.ts";

export interface PanelHooks {
  onOpenChapter(file: string): void;
  onOutline(line: number): void;
  onOpenBook(): void;
  onNewChapter(): void;
  /** Drag and drop: move the dragged chapter to a new position in the list. */
  onReorderChapter(file: string, toIndex: number): void;
  onRenameChapter(): void;
  onDeleteChapter(): void;
  onBudget(): void;
  onToggleKnown(): void;
}

export interface OutlineItem {
  level: 2 | 3;
  title: string;
  line: number;
}

export class Panel {
  private collapsed = new Set<string>();
  /** Set on the mouseup that ends a reorder drag, so the click it would otherwise fire does not open the chapter. */
  private suppressClick = false;

  constructor(
    private root: HTMLElement,
    private hooks: PanelHooks,
  ) {}

  /** "114 of 126 pages" for the whole book (the chapters marked as known are not in the PDF, so they do not count), or how far the counting has got. */
  private length(book: BookInfo, pages: PageCounts | null): HTMLElement | null {
    const chapters = book.chapters.length;
    if (!pages || !chapters) return null;
    const counted = Object.keys(pages.counts).length;
    const inBook = book.chapters.filter((c) => !book.known.includes(c.file));
    const total = inBook.reduce((a, c) => a + (pages.counts[c.path] ?? 0), 0);
    const done = pages.pending === 0 && counted >= chapters;
    const limit = book.pages;
    const over = limit !== null && total > limit;
    const left = limit === null ? 0 : limit - total;
    const note = book.known.length ? `, ${book.known.length} known left out` : "";
    return h(
      "div",
      { class: `length${over ? " over" : ""}` },
      h(
        "button",
        { class: "length-main", type: "button", title: "Numbered pages, from the first chapter to the end (the PDF also has a cover and the contents). Click to set the page limit.", onClick: () => this.hooks.onBudget() },
        h("b", {}, done ? (limit === null ? `${total} pages` : `${total} of ${limit} pages`) : `${total}+ pages`),
        h("span", {}, done ? ` in ${inBook.length} chapters${note}` : ` so far, counting ${counted} of ${chapters}...`),
        book.words ? h("span", { class: "words" }, ` · ${book.words.toLocaleString()} words`) : null,
      ),
      limit !== null && done
        ? h(
            "div",
            { class: "budget", role: "img", "aria-label": over ? `${-left} pages over the limit` : `${left} pages to spare` },
            h("div", { class: "fill", style: `width:${Math.min(100, Math.round((total / limit) * 100))}%` }),
          )
        : null,
      limit !== null && done ? h("div", { class: "left" }, over ? `${-left} page${-left === 1 ? "" : "s"} over the limit` : `${left} page${left === 1 ? "" : "s"} to spare`) : null,
    );
  }

  render(book: BookInfo | null, currentFile: string | null, outline: OutlineItem[], openNotes: number | null, pages: PageCounts | null = null): void {
    clear(this.root);
    if (!book) return;
    // The title, the counts and "New chapter" stay fixed at the top; only the chapter list below them scrolls.
    const head = h(
      "div",
      { class: "panel-head" },
      h("button", { class: "panel-book", type: "button", title: "Open another book", onClick: () => this.hooks.onOpenBook() }, h("span", { class: "t" }, book.title), book.author ? h("span", { class: "a" }, book.author) : null),
      ...[this.length(book, pages)].filter((x): x is HTMLElement => !!x),
      h("button", { class: "new-chapter", type: "button", title: "Add a chapter to the book (Cmd+N)", onClick: () => this.hooks.onNewChapter() }, "+ New chapter"),
    );
    const list = h("div", { class: "panel-list" });
    this.root.append(head, list);
    // Consecutive chapters of one Part are grouped under its name; chapters outside every Part stand alone.
    const groups: { key: string; head: string; chapters: ChapterSummary[] }[] = [];
    for (const c of book.chapters) {
      const key = c.partNumber === null ? "" : `p${c.partNumber}`;
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.chapters.push(c);
      else groups.push({ key, head: c.partNumber === null ? "" : `${c.partLabel}  ${c.partName}`, chapters: [c] });
    }
    for (const g of groups) {
      const part = h("div", { class: `part${this.collapsed.has(g.key) && g.key ? " collapsed" : ""}` });
      if (g.head) {
        part.append(
          h(
            "button",
            {
              class: "part-head",
              type: "button",
              "aria-expanded": String(!this.collapsed.has(g.key)),
              onClick: () => {
                if (this.collapsed.has(g.key)) this.collapsed.delete(g.key);
                else this.collapsed.add(g.key);
                part.classList.toggle("collapsed");
              },
            },
            h("span", { class: "chev" }, "▾"),
            g.head,
          ),
        );
      }
      const body = h("div", { class: "part-body" });
      for (const c of g.chapters) {
        const current = c.path === currentFile;
        const count = current && openNotes !== null ? openNotes : c.openNotes;
        // A div, not a button: Chromium does not reliably start a native drag from a form control, and these rows drag.
        const row = h(
          "div",
          {
            class: `chapter${current ? " current" : ""}${book.known.includes(c.file) ? " known" : ""}`,
            role: "button",
            tabindex: "0",
            "data-file": c.file,
            title: "Drag to reorder",
            onClick: () => {
              if (this.suppressClick) {
                this.suppressClick = false;
                return;
              }
              this.hooks.onOpenChapter(c.path);
            },
            onKeydown: (e: KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                this.hooks.onOpenChapter(c.path);
              }
            },
          },
          h("span", { class: "num" }, c.label ? c.label.replace(/^Chapter /, "") : ""),
          h("span", { class: "name" }, c.title),
          book.known.includes(c.file) ? h("span", { class: "known-tag", title: "Marked as known: left out of the PDF" }, "known") : pages?.counts[c.path] ? h("span", { class: "pp", title: `${pages.counts[c.path]} pages` }, String(pages.counts[c.path])) : null,
          count > 0 ? h("span", { class: "badge", title: `${count} open note${count === 1 ? "" : "s"}` }, String(count)) : null,
        );
        this.makeReorderable(row, book, c);
        body.append(row);
        if (current) {
          body.append(
            h(
              "div",
              { class: "chapter-actions" },
              h("button", { type: "button", title: book.known.includes(c.file) ? "Put this chapter back in the PDF" : "You know this chapter: keep the file, leave it out of the PDF", onClick: () => this.hooks.onToggleKnown() }, book.known.includes(c.file) ? "Unmark known" : "Mark as known"),
              h("button", { type: "button", onClick: () => this.hooks.onRenameChapter() }, "Rename"),
              h("button", { type: "button", class: "danger", onClick: () => this.hooks.onDeleteChapter() }, "Delete"),
            ),
          );
        }
        if (current && outline.length) {
          body.append(
            h(
              "div",
              { class: "outline" },
              ...outline.map((o) => h("button", { class: `h${o.level}`, type: "button", onClick: () => this.hooks.onOutline(o.line) }, o.title)),
            ),
          );
        }
      }
      part.append(body);
      list.append(part);
    }
  }

  /** Clear the drop-position hints from every chapter row. */
  private clearDropHints(): void {
    for (const el of this.root.querySelectorAll(".chapter.drop-before, .chapter.drop-after")) el.classList.remove("drop-before", "drop-after");
  }

  /**
   * Make a chapter row reorderable by dragging it. This uses plain mouse events rather than the HTML5 drag-and-drop API,
   * because that API is unreliable to start from these rows; here a press-and-move always begins a drag, and a press
   * without moving is still an ordinary click that opens the chapter.
   */
  private makeReorderable(row: HTMLElement, book: BookInfo, c: ChapterSummary): void {
    row.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const startY = e.clientY;
      let dragging = false;
      let drop: { before: boolean; onto: ChapterSummary } | null = null;
      const chapterRows = () => Array.from(this.root.querySelectorAll<HTMLElement>(".chapter"));

      const onMove = (ev: MouseEvent) => {
        if (!dragging && Math.abs(ev.clientY - startY) < 5) return;
        if (!dragging) {
          dragging = true;
          row.classList.add("dragging");
          document.body.classList.add("reordering");
        }
        ev.preventDefault();
        this.clearDropHints();
        drop = null;
        for (const el of chapterRows()) {
          const r = el.getBoundingClientRect();
          if (ev.clientY < r.top || ev.clientY > r.bottom) continue;
          const file = el.getAttribute("data-file");
          const onto = file ? book.chapters.find((x) => x.file === file) : undefined;
          if (!onto || onto.file === c.file) break;
          const before = ev.clientY - r.top < r.height / 2;
          el.classList.add(before ? "drop-before" : "drop-after");
          drop = { before, onto };
          break;
        }
      };

      const onUp = () => {
        document.removeEventListener("mousemove", onMove, true);
        document.removeEventListener("mouseup", onUp, true);
        document.body.classList.remove("reordering");
        row.classList.remove("dragging");
        this.clearDropHints();
        if (!dragging) return; // a plain click: the row's onClick opens the chapter
        this.suppressClick = true;
        if (drop) {
          const from = book.chapters.findIndex((x) => x.file === c.file);
          const onto = book.chapters.indexOf(drop.onto);
          let toIndex = drop.before ? onto : onto + 1;
          if (from >= 0 && from < toIndex) toIndex -= 1;
          if (from >= 0 && toIndex !== from) this.hooks.onReorderChapter(c.path, toIndex);
        }
      };

      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("mouseup", onUp, true);
    });
  }
}
