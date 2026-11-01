// The reading view: the chapter exactly as it prints, in a frame, with the reader's notes as cards in the margin.
//
// The frame is a page the main process prepared (same styles, same Paged.js rules as the PDF). It tells us where each
// block is; we draw the cards next to them. Notes are edited by changing the markdown text, never the page, so adding
// a note does not re-render anything.

import { deleteNote, editNote, insertNote, stripNotes, type Note, type NoteKind, type NoteThread } from "../../core/notes.ts";
import { blockStartingAt, insertAfterLine, parseSrc, placeNotes, type BlockRange, type NoteGroup } from "../../core/notemap.ts";
import { clear, h } from "./dom.ts";

export interface ReadingHooks {
  /** The note-bearing text changed: the new full text of the chapter. */
  onTextChange(text: string): void;
  onGotoChapter(id: string): void;
  onOpenExternal(url: string): void;
  onActive(src: string | null): void;
  onError(message: string): void;
  onToast(message: string): void;
}

interface Block extends BlockRange {
  top: number;
  bottom: number;
}

type Editing = { kind: "new"; src: string | null } | { kind: "edit"; note: Note } | null;

const FRAME_WIDTH = 840;

export class ReadingView {
  private scroller: HTMLElement;
  private stage: HTMLElement;
  private frame: HTMLIFrameElement;
  private notesCol: HTMLElement;
  private loading: HTMLElement;
  private key = "";
  private file = "";
  private text = "";
  private blocks: Block[] = [];
  private active: string | null = null;
  private editing: Editing = null;
  private ready = false;
  private findWaiter: ((r: { found: boolean; y: number }) => void) | null = null;
  private pendingScroll: number | null = null;
  private renderToken = 0;

  constructor(
    private root: HTMLElement,
    private api: Window["studio"],
    private hooks: ReadingHooks,
  ) {
    this.scroller = root;
    this.loading = h("div", { class: "loading", text: "Laying out pages..." });
    this.frame = h("iframe", { title: "Chapter", width: FRAME_WIDTH, height: 400, scrolling: "no", tabindex: "-1" });
    this.notesCol = h("div", { class: "notes-col" });
    this.stage = h("div", { class: "stage" }, h("div", { class: "frame-wrap" }, this.frame), this.notesCol);
    this.root.append(this.loading, this.stage);
    window.addEventListener("message", (e) => this.onMessage(e));
  }

  get activeSrc(): string | null {
    return this.active;
  }

  /** Lay the chapter out (or only redraw notes, if the page itself has not changed). */
  async show(file: string, text: string): Promise<void> {
    const plain = stripNotes(text).text;
    const key = `${file}\0${plain}`;
    this.text = text;
    if (key === this.key && this.ready) {
      this.drawNotes();
      return;
    }
    const keepScroll = file === this.file ? this.scroller.scrollTop : 0;
    this.file = file;
    this.key = key;
    this.ready = false;
    this.editing = null;
    this.active = null;
    const token = ++this.renderToken;
    this.loading.hidden = false;
    this.pendingScroll = keepScroll;
    clear(this.notesCol);
    try {
      const { url } = await this.api.prepareReading(file, text);
      if (token !== this.renderToken) return;
      this.frame.src = url;
    } catch (e) {
      this.loading.hidden = true;
      this.hooks.onError((e as Error).message);
    }
  }

  /** The text changed without the page changing (a note was added, edited or removed). */
  setText(text: string): void {
    this.text = text;
    if (this.ready) this.drawNotes();
  }

  clearView(): void {
    this.key = "";
    this.file = "";
    this.ready = false;
    this.frame.removeAttribute("src");
    clear(this.notesCol);
  }

  // ---- messages from the frame ---------------------------------------------------------------

  private onMessage(e: MessageEvent): void {
    if (e.source !== this.frame.contentWindow) return;
    const m = e.data as { source?: string; type?: string } & Record<string, unknown>;
    if (!m || m.source !== "book-studio-reading") return;
    switch (m.type) {
      case "ready": {
        this.blocks = (m.blocks as Block[]).map((b) => ({ ...b, ...parseSrc(b.src) })).sort((a, b) => a.top - b.top);
        const height = Math.ceil(m.height as number);
        this.frame.style.height = `${height}px`;
        this.notesCol.style.height = `${height}px`;
        this.ready = true;
        this.loading.hidden = true;
        if (this.pendingScroll !== null) this.scroller.scrollTop = this.pendingScroll;
        this.pendingScroll = null;
        this.drawNotes();
        break;
      }
      case "error":
        this.loading.hidden = true;
        this.hooks.onError(String(m.message));
        break;
      case "click":
      case "select":
        this.setActive((m.src as string | null) ?? null);
        break;
      case "goto-chapter":
        this.hooks.onGotoChapter(String(m.id));
        break;
      case "open-external":
        this.hooks.onOpenExternal(String(m.url));
        break;
      case "found":
        this.findWaiter?.({ found: !!m.found, y: Number(m.y) });
        this.findWaiter = null;
        break;
    }
  }

  private post(msg: Record<string, unknown>): void {
    this.frame.contentWindow?.postMessage(msg, "*");
  }

  private setActive(src: string | null): void {
    if (this.active === src) return;
    this.active = src;
    this.hooks.onActive(src);
    this.sendMarks();
  }

  private sendMarks(): void {
    const { groups } = placeNotes(this.text, this.blocks);
    const notes: Record<string, "open" | "answered"> = {};
    for (const g of groups) if (g.src) notes[g.src] = g.open ? "open" : "answered";
    this.post({ type: "mark", notes, active: this.active });
  }

  // ---- notes ---------------------------------------------------------------------------------

  /** Start a new note on the active block (or the first block in view). */
  compose(): void {
    if (!this.ready) return this.hooks.onToast("The pages are still being laid out.");
    let src = this.active;
    if (!src) {
      const top = this.scroller.scrollTop + 80;
      src = (this.blocks.find((b) => b.bottom > top) ?? this.blocks[0])?.src ?? null;
      if (!src) return this.hooks.onToast("There is nothing to attach a note to yet.");
      this.setActive(src);
    }
    this.editing = { kind: "new", src };
    this.drawNotes();
    this.notesCol.querySelector<HTMLElement>(".editor .picker button[aria-pressed='true']")?.focus();
    const b = this.blocks.find((x) => x.src === src);
    if (b) this.ensureVisible(b.top);
  }

  private ensureVisible(y: number): void {
    const top = this.scroller.scrollTop;
    if (y < top + 60 || y > top + this.scroller.clientHeight - 160) this.scroller.scrollTop = Math.max(0, y - 120);
  }

  private commit(newText: string): void {
    this.editing = null;
    this.text = newText;
    this.hooks.onTextChange(newText);
    this.drawNotes();
  }

  private drawNotes(): void {
    if (!this.ready) return;
    clear(this.notesCol);
    const { groups } = placeNotes(this.text, this.blocks);
    const items: { y: number; order: number; el: HTMLElement }[] = [];
    const topOf = (src: string | null): number => (src ? (this.blocks.find((b) => b.src === src)?.top ?? 0) : 24);
    for (const g of groups) for (const t of g.threads) items.push({ y: topOf(g.src), order: 0, el: this.card(g, t) });
    if (this.editing?.kind === "new") items.push({ y: topOf(this.editing.src), order: 1, el: this.composer(this.editing.src) });
    items.sort((a, b) => a.y - b.y || a.order - b.order);
    for (const it of items) this.notesCol.append(it.el);
    // Cards sit next to their block; when two would overlap, the later one moves down.
    let floor = 0;
    for (const it of items) {
      it.el.style.top = `${Math.max(it.y, floor)}px`;
      floor = Math.max(it.y, floor) + it.el.offsetHeight + 8;
    }
    this.sendMarks();
  }

  private picker(initial: NoteKind, onPick: (k: NoteKind) => void, onChosen: () => void): HTMLElement {
    const kinds: NoteKind[] = ["Q", "E", "?"];
    const names: Record<string, string> = { Q: "Question", E: "Edit request", "?": "Confused" };
    const wrap = h("div", { class: "picker", role: "group", "aria-label": "Kind of note" });
    const buttons = kinds.map((k) =>
      h("button", { type: "button", title: names[k], "aria-pressed": String(k === initial), onClick: () => select(k) }, k),
    );
    const select = (k: NoteKind) => {
      buttons.forEach((b, i) => b.setAttribute("aria-pressed", String(kinds[i] === k)));
      onPick(k);
    };
    wrap.addEventListener("keydown", (e) => {
      const k = e.key === "q" || e.key === "Q" ? "Q" : e.key === "e" || e.key === "E" ? "E" : e.key === "?" ? "?" : null;
      if (k && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        select(k);
        onChosen();
      }
    });
    wrap.append(...buttons);
    return wrap;
  }

  private editor(opts: { kind: NoteKind; text: string; onSave(kind: NoteKind, text: string): void; onCancel(): void; onDelete?: () => void }): HTMLElement {
    let kind = opts.kind;
    const area = h("textarea", { rows: 2, placeholder: kind === "?" ? "Optional detail" : "Write the note", "aria-label": "Note text" });
    area.value = opts.text;
    const save = () => {
      const text = area.value.trim();
      if (kind !== "?" && !text) return area.focus();
      opts.onSave(kind, text);
    };
    const pick = this.picker(kind, (k) => {
      kind = k;
      area.placeholder = k === "?" ? "Optional detail" : "Write the note";
    }, () => area.focus());
    area.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        save();
      } else if (e.key === "Escape") {
        e.preventDefault();
        opts.onCancel();
      }
    });
    pick.addEventListener("keydown", (e) => {
      if (e.key === "Escape") opts.onCancel();
      else if (e.key === "Enter") {
        e.preventDefault();
        area.focus();
      }
    });
    const row = h(
      "div",
      { class: "row" },
      h("span", { class: "hint", text: "Q, E or ? then Enter to save, Esc to cancel" }),
      opts.onDelete ? h("button", { class: "del", type: "button", onClick: opts.onDelete }, "Delete") : null,
    );
    return h("div", { class: "editor" }, pick, area, row);
  }

  private composer(src: string | null): HTMLElement {
    const card = h("div", { class: "card active k-Q" });
    card.append(
      this.editor({
        kind: "Q",
        text: "",
        onSave: (kind, text) => {
          const at = src ? insertAfterLine(this.text, src) : -1;
          this.commit(insertNote(this.text, at, kind, text));
        },
        onCancel: () => {
          this.editing = null;
          this.drawNotes();
        },
      }),
    );
    return card;
  }

  private card(group: NoteGroup, t: NoteThread): HTMLElement {
    const n = t.note;
    const editing = this.editing?.kind === "edit" && this.editing.note.start === n.start;
    const answered = t.answers.length > 0;
    const card = h("div", { class: `card k-${n.kind}${answered ? " answered" : ""}${group.src && group.src === this.active ? " active" : ""}`, "data-line": n.start });
    if (editing) {
      card.append(
        this.editor({
          kind: n.kind,
          text: n.text,
          onSave: (kind, text) => this.commit(editNote(this.text, n, text, kind)),
          onCancel: () => {
            this.editing = null;
            this.drawNotes();
          },
          onDelete: () => this.commit(this.removeThread(t)),
        }),
      );
      return card;
    }
    card.append(
      h("div", { class: "text" }, h("span", { class: "kind" }, n.kind), n.text || (n.kind === "?" ? "Confused here" : ""), answered ? null : h("span", { class: "open-dot", title: "Not processed yet" })),
    );
    for (const a of t.answers) {
      card.append(
        h(
          "div",
          { class: "answer" },
          h("span", { class: "a" }, "A"),
          h("span", { class: "body" }, a.text),
          h("button", { type: "button", title: "Mark read: removes this note and its answer", "aria-label": "Mark read", onClick: (ev: Event) => { ev.stopPropagation(); this.commit(this.removeThread(t)); } }, "✓"),
        ),
      );
    }
    card.addEventListener("click", () => {
      if (group.src) {
        this.setActive(group.src);
        const b = this.blocks.find((x) => x.src === group.src);
        if (b) this.ensureVisible(b.top);
      }
      this.editing = { kind: "edit", note: n };
      this.drawNotes();
      this.notesCol.querySelector<HTMLElement>(".editor textarea")?.focus();
    });
    return card;
  }

  /** Remove a note and the answers under it, last line first so the line numbers stay right. */
  private removeThread(t: NoteThread): string {
    let text = this.text;
    for (const n of [...t.answers, t.note].sort((a, b) => b.start - a.start)) text = deleteNote(text, n);
    return text;
  }

  // ---- navigation ----------------------------------------------------------------------------

  scrollToLine(origLine: number): void {
    const range = blockStartingAt(this.text, this.blocks, origLine);
    const b = range && this.blocks.find((x) => x.src === range.src);
    if (b) this.scroller.scrollTop = Math.max(0, b.top - 40);
  }

  /** The first line of the file for the active block, so the source view can open where the reader was. */
  activeFirstLine(): number | null {
    if (!this.active) return null;
    const first = parseSrc(this.active).first;
    const { lineMap } = stripNotes(this.text);
    return lineMap[first] ?? null;
  }

  async find(query: string, backwards = false): Promise<boolean> {
    if (!this.ready || !query) return false;
    const result = await new Promise<{ found: boolean; y: number }>((resolve) => {
      this.findWaiter = resolve;
      this.post({ type: "find", query, backwards });
      setTimeout(() => resolve({ found: false, y: 0 }), 1500);
    });
    if (result.found) this.ensureVisible(result.y);
    return result.found;
  }

  clearFind(): void {
    this.post({ type: "clear-selection" });
  }
}
