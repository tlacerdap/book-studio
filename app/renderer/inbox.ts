// The notes inbox: every question, change request and "lost me" of the whole book in one list. Filter by open or
// answered, by kind, or by words; click one and the chapter opens at the paragraph it is about.

import type { InboxNote } from "../../core/inbox.ts";
import type { ChapterNotes } from "../shared/api.ts";
import { clear, h } from "./dom.ts";

export interface NotesHooks {
  load(): Promise<ChapterNotes[]>;
  chapterInfo(file: string): { num: string; title: string } | null;
  onOpen(file: string, note: InboxNote): void;
}

const clip = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n).trimEnd()}...` : t);

type Status = "open" | "all" | "answered";
const KIND_NAME: Record<string, string> = { Q: "Question", E: "Change this", "?": "Lost me" };

export class NotesPanel {
  private data: ChapterNotes[] = [];
  private status: Status = "open";
  private kinds = new Set<string>(["Q", "E", "?"]);
  private query = "";
  private bar: HTMLElement;
  private list: HTMLElement;
  private token = 0;

  constructor(
    private root: HTMLElement,
    private hooks: NotesHooks,
  ) {
    this.bar = h("div", { class: "nb-bar" });
    this.list = h("div", { class: "nb-list" });
    this.root.append(this.bar, this.list);
  }

  /** Count of notes that have no answer yet, across the book (as last loaded). */
  get openCount(): number {
    return this.data.reduce((n, c) => n + c.notes.filter((x) => x.answers.length === 0).length, 0);
  }

  async refresh(): Promise<void> {
    const token = ++this.token;
    const data = await this.hooks.load();
    if (token !== this.token) return;
    this.data = data;
    this.draw();
  }

  private matches(n: InboxNote): boolean {
    if (!this.kinds.has(n.kind)) return false;
    const answered = n.answers.length > 0;
    if (this.status === "open" && answered) return false;
    if (this.status === "answered" && !answered) return false;
    const q = this.query.trim().toLowerCase();
    if (!q) return true;
    return [n.body, n.quote ?? "", ...n.answers].join(" ").toLowerCase().includes(q);
  }

  private draw(): void {
    clear(this.bar);
    clear(this.list);
    const input = h("input", { type: "search", placeholder: "Search your notes", "aria-label": "Search your notes", value: this.query, spellcheck: "false" });
    input.addEventListener("input", () => {
      this.query = input.value;
      this.drawList();
    });
    const seg = h("div", { class: "seg small", role: "group", "aria-label": "Show" });
    for (const [key, label] of [["open", "Open"], ["answered", "Answered"], ["all", "All"]] as const) {
      seg.append(h("button", { type: "button", "aria-pressed": String(this.status === key), onClick: () => ((this.status = key), this.draw()) }, label));
    }
    const kinds = h("div", { class: "nb-kinds" });
    for (const k of ["Q", "E", "?"]) {
      kinds.append(
        h("button", { type: "button", class: `nb-kind k-${k === "?" ? "c" : k}`, title: KIND_NAME[k], "aria-pressed": String(this.kinds.has(k)), onClick: () => (this.kinds.has(k) ? this.kinds.delete(k) : this.kinds.add(k), this.draw()) }, k),
      );
    }
    this.bar.append(input, h("div", { class: "nb-row" }, seg, kinds));
    this.drawList();
  }

  private drawList(): void {
    clear(this.list);
    let shown = 0;
    const total = this.data.reduce((n, c) => n + c.notes.length, 0);
    for (const c of this.data) {
      const notes = c.notes.filter((n) => this.matches(n));
      if (!notes.length) continue;
      const info = this.hooks.chapterInfo(c.file);
      const group = h("div", { class: "nb-group" }, h("div", { class: "nb-head" }, h("span", { class: "num" }, info?.num ?? ""), h("span", { class: "name" }, info?.title ?? c.file), h("span", { class: "n" }, String(notes.length))));
      for (const n of notes) {
        shown++;
        const answered = n.answers.length > 0;
        group.append(
          h(
            "button",
            { class: `nb-item${answered ? " answered" : ""}`, type: "button", onClick: () => this.hooks.onOpen(c.file, n) },
            h("span", { class: `nb-badge k-${n.kind === "?" ? "c" : n.kind}`, title: KIND_NAME[n.kind] }, n.kind),
            h(
              "span",
              { class: "nb-text" },
              n.quote ? h("q", {}, n.quote.length > 90 ? `${n.quote.slice(0, 90)}...` : n.quote) : "",
              n.body ? h("span", { class: "nb-body" }, n.body) : n.quote ? "" : h("span", { class: "nb-body dim" }, "Lost me (no words)"),
              answered ? h("span", { class: "nb-answer" }, h("b", {}, "Answer: "), clip(n.answers[n.answers.length - 1].replace(/^done\s*-\s*/i, ""), 180)) : "",
            ),
          ),
        );
      }
      this.list.append(group);
    }
    if (!shown) this.list.append(h("p", { class: "nb-empty" }, total ? "No notes match these filters." : "No notes in this book yet. Select some words in the Reading view and press Add note."));
    else this.list.prepend(h("div", { class: "search-summary" }, `${shown} of ${total} note${total === 1 ? "" : "s"}`));
  }
}
