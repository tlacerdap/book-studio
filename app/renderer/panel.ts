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
  /** The file being dragged to reorder, between dragstart and drop. */
  private dragFile: string | null = null;

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
        const row = h(
          "button",
          { class: `chapter${current ? " current" : ""}${book.known.includes(c.file) ? " known" : ""}`, type: "button", "data-file": c.file, title: "Drag to reorder", onClick: () => this.hooks.onOpenChapter(c.path) },
          h("span", { class: "num" }, c.label ? c.label.replace(/^Chapter /, "") : ""),
          h("span", { class: "name" }, c.title),
          book.known.includes(c.file) ? h("span", { class: "known-tag", title: "Marked as known: left out of the PDF" }, "known") : pages?.counts[c.path] ? h("span", { class: "pp", title: `${pages.counts[c.path]} pages` }, String(pages.counts[c.path])) : null,
          count > 0 ? h("span", { class: "badge", title: `${count} open note${count === 1 ? "" : "s"}` }, String(count)) : null,
        );
        this.makeDraggable(row, book, c);
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

  /** Wire a chapter row for drag-and-drop reordering. */
  private makeDraggable(row: HTMLElement, book: BookInfo, c: ChapterSummary): void {
    row.draggable = true;
    row.addEventListener("dragstart", (e) => {
      this.dragFile = c.file;
      row.classList.add("dragging");
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", c.file);
      }
    });
    row.addEventListener("dragend", () => {
      this.dragFile = null;
      row.classList.remove("dragging");
      this.clearDropHints();
    });
    row.addEventListener("dragover", (e) => {
      if (!this.dragFile || this.dragFile === c.file) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      const r = row.getBoundingClientRect();
      const before = e.clientY - r.top < r.height / 2;
      this.clearDropHints();
      row.classList.add(before ? "drop-before" : "drop-after");
    });
    row.addEventListener("drop", (e) => {
      if (!this.dragFile || this.dragFile === c.file) return;
      e.preventDefault();
      const r = row.getBoundingClientRect();
      const before = e.clientY - r.top < r.height / 2;
      const from = book.chapters.findIndex((x) => x.file === this.dragFile);
      const onto = book.chapters.indexOf(c);
      let target = before ? onto : onto + 1;
      if (from >= 0 && from < target) target -= 1;
      this.clearDropHints();
      if (from >= 0 && target !== from) this.hooks.onReorderChapter(this.dragFile, target);
      this.dragFile = null;
    });
  }
}
