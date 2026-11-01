// The left panel: the book's Parts and chapters, with the outline of the chapter that is open and a badge for open notes.

import type { ChapterSummary } from "../../core/book.ts";
import type { BookInfo } from "../shared/api.ts";
import { clear, h } from "./dom.ts";

export interface PanelHooks {
  onOpenChapter(file: string): void;
  onOutline(line: number): void;
  onOpenBook(): void;
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

  render(book: BookInfo | null, currentFile: string | null, outline: OutlineItem[], openNotes: number | null): void {
    clear(this.root);
    if (!book) return;
    this.root.append(
      h("button", { class: "panel-book", type: "button", title: "Open another book", onClick: () => this.hooks.onOpenBook() }, h("span", { class: "t" }, book.title), book.author ? h("span", { class: "a" }, book.author) : null),
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
            count > 0 ? h("span", { class: "badge", title: `${count} open note${count === 1 ? "" : "s"}` }, String(count)) : null,
          ),
        );
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
