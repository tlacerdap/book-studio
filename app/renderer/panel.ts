// The left panel: the book's Parts and chapters, with the outline of the chapter that is open and a badge for open notes.

import type { ChapterSummary } from "../../core/book.ts";
import type { BookInfo, PageCounts } from "../shared/api.ts";
import { clear, h } from "./dom.ts";

export interface PanelHooks {
  onOpenChapter(file: string): void;
  onOutline(line: number): void;
  onOpenBook(): void;
  onNewChapter(): void;
  onMoveChapter(step: -1 | 1): void;
  onRenameChapter(): void;
  onDeleteChapter(): void;
}

export interface OutlineItem {
  level: 2 | 3;
  title: string;
  line: number;
}

export class Panel {
  private collapsed = new Set<string>();

  constructor(
    private root: HTMLElement,
    private hooks: PanelHooks,
  ) {}

  /** "660 pages" for the whole book, or how far the counting has got. */
  private length(pages: PageCounts | null, chapters: number): HTMLElement | null {
    if (!pages || !chapters) return null;
    const counted = Object.keys(pages.counts).length;
    const total = Object.values(pages.counts).reduce((a, b) => a + b, 0);
    const done = pages.pending === 0 && counted >= chapters;
    return h(
      "div",
      { class: "length", title: "Numbered pages, from the first chapter to the end. The PDF also has a cover and the contents." },
      h("b", {}, done ? `${total} pages` : `${total}+ pages`),
      h("span", {}, done ? ` in ${chapters} chapters` : ` so far, counting ${counted} of ${chapters}...`),
    );
  }

  render(book: BookInfo | null, currentFile: string | null, outline: OutlineItem[], openNotes: number | null, pages: PageCounts | null = null): void {
    clear(this.root);
    if (!book) return;
    this.root.append(
      h("button", { class: "panel-book", type: "button", title: "Open another book", onClick: () => this.hooks.onOpenBook() }, h("span", { class: "t" }, book.title), book.author ? h("span", { class: "a" }, book.author) : null),
      ...[this.length(pages, book.chapters.length)].filter((x): x is HTMLElement => !!x),
      h("button", { class: "new-chapter", type: "button", title: "Add a chapter to the book (Cmd+N)", onClick: () => this.hooks.onNewChapter() }, "+ New chapter"),
    );
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
        body.append(
          h(
            "button",
            { class: `chapter${current ? " current" : ""}`, type: "button", "data-file": c.file, title: c.file, onClick: () => this.hooks.onOpenChapter(c.path) },
            h("span", { class: "num" }, c.label ? c.label.replace(/^Chapter /, "") : ""),
            h("span", { class: "name" }, c.title),
            pages?.counts[c.path] ? h("span", { class: "pp", title: `${pages.counts[c.path]} pages` }, String(pages.counts[c.path])) : null,
            count > 0 ? h("span", { class: "badge", title: `${count} open note${count === 1 ? "" : "s"}` }, String(count)) : null,
          ),
        );
        if (current) {
          const index = book.chapters.indexOf(c);
          body.append(
            h(
              "div",
              { class: "chapter-actions" },
              h("button", { type: "button", title: "Move this chapter up", "aria-label": "Move chapter up", disabled: index === 0, onClick: () => this.hooks.onMoveChapter(-1) }, "\u2191"),
              h("button", { type: "button", title: "Move this chapter down", "aria-label": "Move chapter down", disabled: index === book.chapters.length - 1, onClick: () => this.hooks.onMoveChapter(1) }, "\u2193"),
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
      this.root.append(part);
    }
  }
}
