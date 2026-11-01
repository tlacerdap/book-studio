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
  onZoom(zoom: number, fit: boolean): void;
  /** Put text on the clipboard. */
  onCopy(text: string): void;
}

interface Block extends BlockRange {
  top: number;
  bottom: number;
}

type Editing = { kind: "new"; src: string | null } | { kind: "edit"; note: Note } | null;

const KIND_NAME: Record<string, string> = { Q: "Question", E: "Change this", "?": "Lost me" };
const KIND_KEY: Record<string, string> = { Q: "Q", E: "E", "?": "?" };
const KIND_HELP: Record<string, string> = {
  Q: "Question: you do not understand something. Claude fixes the text so you would not have to ask, and tells you what it changed.",
  E: "Change this: you want it edited. Say what, and Claude makes the edit.",
  "?": "Lost me: this block confused you and you cannot say why. Claude rewrites it more clearly.",
};
const PLACEHOLDER: Record<string, string> = {
  Q: "What do you not understand?",
  E: "What should change?",
  "?": "Optional: what lost you?",
};
const FRAME_WIDTH = 840;
const NOTES_WIDTH = 296;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;

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
  private wrap: HTMLElement;
  private zoom = 1;
  private fit = false;
  private docHeight = 400;
  private resizer: ResizeObserver;

  constructor(
    private root: HTMLElement,
    private api: Window["studio"],
    private hooks: ReadingHooks,
  ) {
    this.scroller = root;
    this.loading = h("div", { class: "loading", text: "Laying out pages..." });
    this.frame = h("iframe", { title: "Chapter", width: FRAME_WIDTH, height: 400, scrolling: "no", tabindex: "-1" });
    this.notesCol = h("div", { class: "notes-col" });
    this.wrap = h("div", { class: "frame-wrap" }, this.frame);
    this.stage = h("div", { class: "stage" }, this.wrap, this.notesCol);
    this.root.append(this.loading, this.stage);
    try {
      const saved = parseFloat(localStorage.getItem("reading-zoom") ?? "");
      if (saved >= MIN_ZOOM && saved <= MAX_ZOOM) this.zoom = saved;
      this.fit = localStorage.getItem("reading-fit") === "1";
    } catch {
      /* no saved zoom */
    }
    // The page stays centred in whatever room the window has, whenever the window or the panel changes size.
    this.resizer = new ResizeObserver(() => this.layout());
    this.resizer.observe(this.scroller);
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

  // ---- zoom and centring ---------------------------------------------------------------------

  get zoomLevel(): number {
    return this.zoom;
  }

  setZoom(z: number, opts: { fit?: boolean } = {}): void {
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 100) / 100));
    const before = this.zoom;
    // Keep the same spot of the chapter in the middle of the window.
    const mid = (this.scroller.scrollTop + this.scroller.clientHeight / 2) / before;
    this.zoom = next;
    this.fit = !!opts.fit;
    try {
      localStorage.setItem("reading-zoom", String(next));
      localStorage.setItem("reading-fit", this.fit ? "1" : "0");
    } catch {
      /* not remembered */
    }
    this.layout();
    this.scroller.scrollTop = Math.max(0, mid * next - this.scroller.clientHeight / 2);
    this.hooks.onZoom(this.zoom, this.fit);
  }

  zoomBy(step: number): void {
    this.setZoom(this.zoom + step);
  }

  /** Scale the page to the width of the window (leaving room for the notes). */
  fitWidth(): void {
    this.setZoom(this.fitZoom(), { fit: true });
  }

  private fitZoom(): number {
    const room = this.scroller.clientWidth - 2 * NOTES_WIDTH * 0.6 - 32;
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, room / FRAME_WIDTH));
  }

  /**
   * The page sits in the middle of the room the window gives it. When the notes need more room than a centred page
   * leaves on its right, the page moves left by just that much, never further.
   */
  private layout(): void {
    const z = this.fit ? this.fitZoom() : this.zoom;
    if (this.fit) this.zoom = z;
    const room = this.scroller.clientWidth;
    const w = FRAME_WIDTH * z;
    const h = this.docHeight * z;
    const needRight = NOTES_WIDTH + 12 + 16;
    let left = (room - w) / 2;
    if (this.notesCol.childElementCount > 0 && left < needRight) left = Math.max(12, room - w - needRight);
    left = Math.max(12, left);
    this.wrap.style.cssText = `left:${left}px;width:${w}px;height:${h}px`;
    this.frame.style.transform = `scale(${z})`;
    this.notesCol.style.cssText = `left:${left + w + 12}px;width:${NOTES_WIDTH}px;height:${h}px`;
    this.wrap.style.transition = this.notesCol.style.transition = "left 0.15s";
    this.stage.style.cssText = `width:${Math.max(room, left + w + needRight + 12)}px;height:${h + 8}px`;
    this.loading.style.zIndex = "3";
  }

  // ---- messages from the frame ---------------------------------------------------------------

  private onMessage(e: MessageEvent): void {
    if (e.source !== this.frame.contentWindow) return;
    const m = e.data as { source?: string; type?: string } & Record<string, unknown>;
    if (!m || m.source !== "book-studio-reading") return;
    switch (m.type) {
      case "ready": {
        this.blocks = (m.blocks as Block[]).map((b) => ({ ...b, ...parseSrc(b.src) })).sort((a, b) => a.top - b.top);
        this.docHeight = Math.ceil(m.height as number);
        this.frame.style.height = `${this.docHeight}px`;
        this.ready = true;
        this.loading.hidden = true;
        this.layout();
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
      const top = (this.scroller.scrollTop + 80) / this.zoom;
      src = (this.blocks.find((b) => b.bottom > top) ?? this.blocks[0])?.src ?? null;
      if (!src) return this.hooks.onToast("There is nothing to attach a note to yet.");
      this.setActive(src);
    }
    this.editing = { kind: "new", src };
    this.drawNotes();
    this.notesCol.querySelector<HTMLElement>(".editor .picker button[aria-pressed='true']")?.focus();
    const b = this.blocks.find((x) => x.src === src);
    if (b) this.ensureVisible(b.top * this.zoom);
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
    const z = this.zoom;
    const topOf = (src: string | null): number => (src ? (this.blocks.find((b) => b.src === src)?.top ?? 0) * z : 24);
    for (const g of groups) for (const t of g.threads) items.push({ y: topOf(g.src), order: 0, el: this.card(g, t) });
    const help = this.helpCard(groups);
    if (help) items.push({ y: 0, order: -1, el: help });
    if (this.editing?.kind === "new") items.push({ y: topOf(this.editing.src), order: 1, el: this.composer(this.editing.src) });
    items.sort((a, b) => a.y - b.y || a.order - b.order);
    for (const it of items) this.notesCol.append(it.el);
    this.layout(); // the page makes room for the margin only while there is something in it
    // Cards sit next to their block; when two would overlap, the later one moves down.
    let floor = 0;
    for (const it of items) {
      it.el.style.top = `${Math.max(it.y, floor)}px`;
      floor = Math.max(it.y, floor) + it.el.offsetHeight + 8;
    }
    this.sendMarks();
  }

  /** The command to give Claude Code for this chapter: the leading digits of the file name are its chapter number. */
  instruction(): string {
    const name = this.file.split(/[\\/]/).pop() ?? "";
    const num = /^\d+/.exec(name)?.[0] ?? name;
    return `process notes in chapter ${num}`;
  }

  /** Top of the margin: how notes work when there are none yet, or what to tell Claude when some are waiting. */
  private helpCard(groups: NoteGroup[]): HTMLElement | null {
    const open = groups.reduce((n, g) => n + g.threads.filter((t) => t.answers.length === 0).length, 0);
    if (open > 0) {
      const text = this.instruction();
      return h(
        "div",
        { class: "card help" },
        h("div", {}, h("b", {}, `${open} note${open === 1 ? "" : "s"} waiting for Claude.`), " They are saved in this chapter's file. To have Claude Code deal with them, tell it:"),
        h("div", { class: "cmd" }, h("code", {}, text), h("button", { type: "button", onClick: () => this.hooks.onCopy(text) }, "Copy")),
      );
    }
    return null;
  }

  private picker(initial: NoteKind, onPick: (k: NoteKind) => void, onChosen: () => void): HTMLElement {
    const kinds: NoteKind[] = ["Q", "E", "?"];
    const wrap = h("div", { class: "picker", role: "group", "aria-label": "Kind of note" });
    const buttons = kinds.map((k) =>
      h("button", { type: "button", title: KIND_HELP[k], "aria-pressed": String(k === initial), onClick: () => select(k) }, h("b", {}, KIND_KEY[k]), ` ${KIND_NAME[k]}`),
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
    const area = h("textarea", { rows: 2, placeholder: PLACEHOLDER[kind], "aria-label": "Note text" });
    area.value = opts.text;
    const save = () => {
      const text = area.value.trim();
      if (kind !== "?" && !text) return area.focus();
      opts.onSave(kind, text);
    };
    const pick = this.picker(kind, (k) => {
      kind = k;
      area.placeholder = PLACEHOLDER[k];
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
      h("span", { class: "hint", text: "Press Q, E or ? to choose. Enter saves, Esc cancels." }),
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
      h("div", { class: "text" }, h("span", { class: "kind" }, KIND_NAME[n.kind]), n.text || (n.kind === "?" ? "This lost me" : ""), answered ? null : h("span", { class: "open-dot", title: "Not processed yet" })),
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
        if (b) this.ensureVisible(b.top * this.zoom);
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
    if (b) this.scroller.scrollTop = Math.max(0, b.top * this.zoom - 40);
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
    if (result.found) this.ensureVisible(result.y * this.zoom);
    return result.found;
  }

  clearFind(): void {
    this.post({ type: "clear-selection" });
  }
}
