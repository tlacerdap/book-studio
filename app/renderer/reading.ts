// The reading view: the chapter exactly as it prints, in a frame, with the reader's notes as cards in the margin.
//
// The frame is a page the main process prepared (same styles, same Paged.js rules as the PDF). It tells us where each
// block is; we draw the cards next to them. Notes are edited by changing the markdown text, never the page, so adding
// a note does not re-render anything.

import { deleteNote, editNote, insertNote, stripNotes, type Note, type NoteKind, type NoteThread } from "../../core/notes.ts";
import { blockStartingAt, insertAfterLine, parseSrc, placeNotes, splitQuote, withQuote, type BlockRange, type NoteGroup } from "../../core/notemap.ts";
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
  /** How many pages the chapter has, now that it is laid out. */
  onPages(pages: number): void;
  /** Put text on the clipboard. */
  onCopy(text: string): void;
  /** How many times the searched words occur on the page, and which one is the current one (-1 if none). */
  onFound(count: number, index: number): void;
}

interface Block extends BlockRange {
  top: number;
  bottom: number;
}

/** `y` is where on the page the reader clicked or selected (page units), so the box opens next to those words. */
type Editing = { kind: "new"; src: string | null; quote: string | null; initial: NoteKind; reply: boolean; y: number | null } | { kind: "edit"; note: Note } | null;

/** What a note box was holding when it had to be redrawn, so nothing typed is lost. */
interface Draft {
  /** The note box this belongs to: a different box starts empty. */
  owner: object;
  kind: NoteKind;
  text: string;
  focus: "text" | "picker" | null;
  at: number;
}

/** Q, E and ? (capital or not, on any keyboard layout) choose the kind of a note. */
function kindOfKey(key: string, code: string, shift: boolean): NoteKind | null {
  const k = key.toLowerCase();
  if (k === "q" || code === "KeyQ") return "Q";
  if (k === "e" || code === "KeyE") return "E";
  if (key === "?" || ((code === "Slash" || code === "IntlRo") && shift)) return "?";
  return null;
}

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
const MIN_NOTES_WIDTH = 210;
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
  /** Words the reader has selected on the page, which a new note will point at. */
  private selection: { src: string; text: string; y: number } | null = null;
  /** Where the reader last clicked on the page, with the block it was in. */
  private clickAt: { src: string | null; y: number } | null = null;
  private draft: Draft | null = null;
  /** Notes (by the line they start on) the reader just pointed at on the page: shown strongest, both there and here. */
  private focusIds: number[] = [];
  /** The note box that is on screen right now, if any: how the page's keys reach it. */
  private liveEditing: Editing = null;
  private liveBox: { choose(k: NoteKind): void; cancel(): void } | null = null;
  private ready = false;
  /** A search made before the page was laid out: it is run as soon as the page is ready. */
  private pendingFind: { query: string; ordinal: number | null; ctx: string | null } | null = null;
  private findQuery = "";
  private pendingScroll: number | null = null;
  private renderToken = 0;
  private wrap: HTMLElement;
  private zoom = 1;
  private fit = false;
  private docHeight = 400;
  /** How far down the lowest note card reaches, so the page can be made long enough for it. */
  private notesBottom = 0;
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
    this.focusIds = [];
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
    // The whole page and the notes beside it, so adding a first note never makes the view scroll sideways.
    const room = this.scroller.clientWidth - NOTES_WIDTH - 12 - 16 - 24;
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, room / FRAME_WIDTH));
  }

  /**
   * The page sits in the middle of the room the window gives it. The view scrolls sideways only when the page itself
   * is wider than the window. When the page fits, so does everything else:
   *  - the notes use the room to the right of a centred page;
   *  - if that is too little, the page moves left by just what the notes need;
   *  - if even that is not enough, the notes narrow, and in the last resort sit over the page's right edge.
   */
  private layout(): void {
    const z = this.fit ? this.fitZoom() : this.zoom;
    if (this.fit) this.zoom = z;
    const room = this.scroller.clientWidth;
    const w = FRAME_WIDTH * z;
    const h = this.docHeight * z;
    const gap = 12;
    const edge = 16;
    const hasNotes = this.notesCol.childElementCount > 0;
    const fits = w + 24 <= room;
    let left = Math.max(12, (room - w) / 2);
    let notesW = NOTES_WIDTH;
    let notesLeft: number;
    let stageW: number;
    if (!fits) {
      // The page is wider than the window: this is the one case that scrolls sideways.
      left = 12;
      notesLeft = left + w + gap;
      stageW = hasNotes ? notesLeft + NOTES_WIDTH + edge : left + w + 12;
    } else {
      if (hasNotes && left + w + gap + NOTES_WIDTH + edge > room) left = Math.max(12, room - w - gap - NOTES_WIDTH - edge);
      notesLeft = left + w + gap;
      const avail = room - edge - notesLeft;
      if (hasNotes && avail < NOTES_WIDTH) {
        if (avail >= MIN_NOTES_WIDTH) notesW = avail;
        else {
          notesW = MIN_NOTES_WIDTH;
          notesLeft = room - edge - notesW;
        }
      }
      stageW = room;
    }
    this.wrap.style.cssText = `left:${left}px;width:${w}px;height:${h}px`;
    this.frame.style.transform = `scale(${z})`;
    // An empty margin takes no room at all, so it cannot make the view scroll sideways.
    this.notesCol.style.cssText = `left:${notesLeft}px;width:${notesW}px;height:${h}px${hasNotes ? "" : ";display:none"}`;
    this.wrap.style.transition = this.notesCol.style.transition = "left 0.15s";
    this.stage.style.cssText = `width:${stageW}px;height:${Math.max(h + 8, this.notesBottom + 24)}px`;
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
        this.hooks.onPages(Number(m.pages));
        this.layout();
        if (this.pendingScroll !== null) this.scroller.scrollTop = this.pendingScroll;
        this.pendingScroll = null;
        this.drawNotes();
        if (this.pendingFind) {
          const f = this.pendingFind;
          this.pendingFind = null;
          this.sendFind(f.query, f.ordinal, f.ctx);
        }
        break;
      }
      case "error":
        this.loading.hidden = true;
        this.hooks.onError(String(m.message));
        break;
      case "click": {
        this.selection = null;
        this.clickAt = { src: (m.src as string | null) ?? null, y: Number(m.y) };
        this.setActive((m.src as string | null) ?? null);
        this.showNotes(((m.notes as number[] | undefined) ?? []).map(Number));
        break;
      }
      case "select":
        this.selection = m.src ? { src: String(m.src), text: String(m.text ?? ""), y: Number(m.y) } : null;
        this.clickAt = m.src ? { src: String(m.src), y: Number(m.y) } : null;
        this.setActive((m.src as string | null) ?? null);
        this.sendMarks();
        break;
      case "key": {
        // The page kept the keyboard focus (the reader clicked on it): its Q, E, ? and Esc still reach an open note box.
        const box = this.liveBox;
        if (!box) break;
        if (m.key === "Escape") return box.cancel();
        const k = kindOfKey(String(m.key), String(m.code), !!m.shift);
        if (k) box.choose(k);
        break;
      }
      case "goto-chapter":
        this.hooks.onGotoChapter(String(m.id));
        break;
      case "open-external":
        this.hooks.onOpenExternal(String(m.url));
        break;
      case "found": {
        const index = Number(m.index);
        if (index >= 0) this.ensureVisible(Number(m.y) * this.zoom);
        this.hooks.onFound(Number(m.count), index);
        break;
      }
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

  /**
   * The reader clicked marked text: show exactly which note it is. Its card is outlined and brought into view, and its
   * words are marked strongest on the page. Clicking anywhere unmarked clears this.
   */
  private showNotes(ids: number[]): void {
    const same = ids.length === this.focusIds.length && ids.every((i, k) => i === this.focusIds[k]);
    this.focusIds = ids;
    if (!same || ids.length) this.drawNotes();
    const card = ids.length ? this.notesCol.querySelector<HTMLElement>(`.card[data-line="${ids[0]}"]`) : null;
    if (!card) return;
    const top = card.offsetTop;
    const bottom = top + card.offsetHeight;
    const view = this.scroller.scrollTop;
    const height = this.scroller.clientHeight;
    if (top < view + 16 || bottom > view + height - 16) this.scroller.scrollTop = Math.max(0, top - 80);
    card.classList.remove("pulse");
    void card.offsetWidth;
    card.classList.add("pulse");
  }

  private sendMarks(): void {
    const { groups } = placeNotes(this.text, this.blocks);
    const notes: Record<string, "open" | "answered"> = {};
    const quotes: { id: number; src: string; text: string; done: boolean }[] = [];
    const wholes: { id: number; src: string; done: boolean }[] = [];
    for (const g of groups) {
      if (!g.src) continue;
      notes[g.src] = g.open ? "open" : "answered";
      for (const t of g.threads) {
        const q = splitQuote(t.note.text).quote;
        const done = t.answers.length > 0;
        if (q) quotes.push({ id: t.note.start, src: g.src, text: q, done });
        else wholes.push({ id: t.note.start, src: g.src, done });
      }
    }
    // While a note is being written, the words it will point at are shown a little stronger.
    const e = this.editing;
    const pending = e?.kind === "new" && e.quote && e.src ? { src: e.src, text: e.quote } : this.selection;
    this.post({ type: "mark", notes, active: this.active, quotes, wholes, pending, focus: this.focusIds });
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
    const quote = this.selection && this.selection.src === src ? this.selection.text : null;
    // The box opens beside the words the reader picked, or the place they clicked, not at the top of a long block.
    const y = this.selection && this.selection.src === src ? this.selection.y : this.clickAt && this.clickAt.src === src ? this.clickAt.y : null;
    this.editing = { kind: "new", src, quote, initial: "Q", reply: false, y };
    this.draft = null;
    this.drawNotes();
    this.focusBox();
    this.revealBox();
  }

  /** Put the keyboard in the note box (on the kind buttons, so Q, E and ? work at once), even if the page had it. */
  private focusBox(): void {
    this.notesCol.querySelector<HTMLElement>(".editor .picker button[aria-pressed='true']")?.focus();
  }

  /** Scroll just enough that the whole note box can be seen. */
  private revealBox(): void {
    const box = this.notesCol.querySelector<HTMLElement>(".card.composing, .card.editing");
    if (!box) return;
    const top = box.offsetTop;
    const bottom = top + box.offsetHeight;
    const view = this.scroller.scrollTop;
    const height = this.scroller.clientHeight;
    if (top < view + 16) this.scroller.scrollTop = Math.max(0, top - 80);
    else if (bottom > view + height - 16) this.scroller.scrollTop = Math.max(0, Math.min(top - 80, bottom - height + 24));
  }

  private ensureVisible(y: number): void {
    const top = this.scroller.scrollTop;
    if (y < top + 60 || y > top + this.scroller.clientHeight - 160) this.scroller.scrollTop = Math.max(0, y - 120);
  }

  private commit(newText: string): void {
    this.focusIds = [];
    this.editing = null;
    this.draft = null;
    this.selection = null;
    this.post({ type: "clear-selection" });
    this.text = newText;
    this.hooks.onTextChange(newText);
    this.drawNotes();
  }

  private drawNotes(): void {
    if (!this.ready) return;
    this.captureDraft();
    clear(this.notesCol);
    this.liveBox = null;
    this.liveEditing = this.editing;
    const { groups } = placeNotes(this.text, this.blocks);
    const items: { y: number; order: number; el: HTMLElement; box?: boolean }[] = [];
    const z = this.zoom;
    const topOf = (src: string | null): number => (src ? (this.blocks.find((b) => b.src === src)?.top ?? 0) * z : 24);
    for (const g of groups) for (const t of g.threads) items.push({ y: topOf(g.src), order: 0, el: this.card(g, t) });
    const help = this.helpCard(groups);
    if (help) items.push({ y: 0, order: -1, el: help });
    if (this.editing?.kind === "new") items.push({ y: this.boxY(this.editing), order: 1, el: this.composer(this.editing), box: true });
    items.sort((a, b) => a.y - b.y || a.order - b.order);
    for (const it of items) this.notesCol.append(it.el);
    this.layout(); // the page makes room for the margin only while there is something in it
    // Cards sit next to their block. The box being written in stays where the words are; the other cards make room
    // for it, those above it moving up and those below it moving down.
    const gap = 8;
    const at = items.findIndex((i) => i.box);
    let floor = 0;
    if (at >= 0) {
      let top = Math.max(0, items[at].y);
      let ceiling = top - gap;
      const above: [HTMLElement, number][] = [];
      for (let i = at - 1; i >= 0; i--) {
        const t = Math.min(items[i].y, ceiling - items[i].el.offsetHeight);
        above.push([items[i].el, t]);
        ceiling = t - gap;
      }
      const lift = Math.max(0, -ceiling - gap); // when the stack would leave the top of the page, everything moves down together
      top += lift;
      for (const [el, t] of above) el.style.top = `${t + lift}px`;
      items[at].el.style.top = `${top}px`;
      floor = top + items[at].el.offsetHeight + gap;
      for (let i = at + 1; i < items.length; i++) {
        const t = Math.max(items[i].y, floor);
        items[i].el.style.top = `${t}px`;
        floor = t + items[i].el.offsetHeight + gap;
      }
    } else {
      for (const it of items) {
        it.el.style.top = `${Math.max(it.y, floor)}px`;
        floor = Math.max(it.y, floor) + it.el.offsetHeight + gap;
      }
    }
    // The page grows to hold a card that hangs below its end.
    this.notesBottom = Math.max(...items.map((i) => i.el.offsetTop + i.el.offsetHeight), 0);
    this.layout();
    if (!this.editing) this.draft = null;
    this.restoreFocus();
    this.sendMarks();
  }

  /** Where a new note box wants to be: level with the words the reader picked, inside their block. */
  private boxY(e: { src: string | null; y: number | null }): number {
    const b = e.src ? this.blocks.find((x) => x.src === e.src) : null;
    if (!b) return 24 * this.zoom;
    const page = e.y === null ? b.top : Math.min(Math.max(e.y, b.top), Math.max(b.top, b.bottom - 24));
    return Math.max(0, (page - 6) * this.zoom);
  }

  /** Remember what is typed in the open note box before the margin is redrawn. */
  private captureDraft(): void {
    const area = this.notesCol.querySelector<HTMLTextAreaElement>(".editor textarea");
    if (!area || !this.editing || this.editing !== this.liveEditing) return;
    const pressed = this.notesCol.querySelector<HTMLElement>(".editor .picker button[aria-pressed='true']");
    const active = document.activeElement;
    this.draft = {
      owner: this.editing,
      kind: (pressed?.dataset.kind as NoteKind | undefined) ?? "Q",
      text: area.value,
      focus: active === area ? "text" : active && this.notesCol.contains(active) ? "picker" : null,
      at: area.selectionStart ?? area.value.length,
    };
  }

  private restoreFocus(): void {
    const d = this.draft;
    if (!d || d.owner !== this.editing || !d.focus) return;
    const area = this.notesCol.querySelector<HTMLTextAreaElement>(".editor textarea");
    if (d.focus === "text" && area) {
      area.focus({ preventScroll: true });
      area.setSelectionRange(d.at, d.at);
    } else if (d.focus === "picker") {
      this.notesCol.querySelector<HTMLElement>(".editor .picker button[aria-pressed='true']")?.focus({ preventScroll: true });
    }
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

  private picker(initial: NoteKind, onPick: (k: NoteKind) => void): { el: HTMLElement; select(k: NoteKind): void } {
    const kinds: NoteKind[] = ["Q", "E", "?"];
    const wrap = h("div", { class: "picker", role: "group", "aria-label": "Kind of note" });
    const buttons = kinds.map((k) =>
      h("button", { type: "button", "data-kind": k, title: KIND_HELP[k], "aria-pressed": String(k === initial), onClick: () => select(k) }, h("b", {}, KIND_KEY[k]), ` ${KIND_NAME[k]}`),
    );
    const select = (k: NoteKind) => {
      buttons.forEach((b, i) => b.setAttribute("aria-pressed", String(kinds[i] === k)));
      onPick(k);
    };
    wrap.append(...buttons);
    return { el: wrap, select };
  }

  private editor(opts: { kind: NoteKind; text: string; onSave(kind: NoteKind, text: string): void; onCancel(): void; onDelete?: () => void }): HTMLElement {
    const d = this.draft && this.draft.owner === this.editing ? this.draft : null;
    let kind = d ? d.kind : opts.kind;
    const area = h("textarea", { rows: 2, placeholder: PLACEHOLDER[kind], "aria-label": "Note text" });
    area.value = d ? d.text : opts.text;
    const save = () => {
      const text = area.value.trim();
      if (kind !== "?" && !text) return area.focus();
      opts.onSave(kind, text);
    };
    const pick = this.picker(kind, (k) => {
      kind = k;
      area.placeholder = PLACEHOLDER[k];
    });
    const choose = (k: NoteKind) => {
      pick.select(k);
      area.focus();
    };
    this.liveBox = { choose, cancel: () => opts.onCancel() };
    area.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        save();
      } else if (e.key === "Escape") {
        e.preventDefault();
        opts.onCancel();
      } else if ((e.metaKey || e.ctrlKey) && !e.altKey && ["1", "2", "3"].includes(e.key)) {
        // While typing, Ctrl or Cmd with 1, 2 or 3 changes the kind without leaving the text.
        e.preventDefault();
        pick.select((["Q", "E", "?"] as NoteKind[])[Number(e.key) - 1]);
      }
    });
    // Anywhere in the box but the text itself, Q, E and ? choose the kind (capital or small, on any keyboard).
    const root = h("div", { class: "editor" });
    root.addEventListener("keydown", (e) => {
      if (e.target === area || e.isComposing) return;
      if (e.key === "Escape") {
        e.preventDefault();
        return opts.onCancel();
      }
      if (e.key === "Enter") {
        // Enter on a kind button moves on to the text; on any other button it presses it, as usual.
        if (e.target instanceof HTMLElement && e.target.parentElement?.classList.contains("picker")) {
          e.preventDefault();
          area.focus();
        }
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = kindOfKey(e.key, e.code, e.shiftKey);
      if (k) {
        e.preventDefault();
        choose(k);
      }
    });
    const row = h(
      "div",
      { class: "row" },
      h("span", { class: "hint", text: "Q, E or ? picks the kind (Ctrl or Cmd + 1, 2, 3 while typing). Enter saves, Esc cancels." }),
      opts.onDelete ? h("button", { class: "del", type: "button", onClick: opts.onDelete }, "Delete") : null,
    );
    root.append(pick.el, area, row);
    return root;
  }

  private composer(e: { src: string | null; quote: string | null; initial: NoteKind; reply: boolean }): HTMLElement {
    const card = h("div", { class: `card active composing k-${e.initial}` });
    let quote = e.quote;
    const quoteLine = h("div", { class: "quote" });
    const drawQuote = () => {
      clear(quoteLine);
      quoteLine.hidden = !quote;
      if (!quote) return;
      quoteLine.append(
        h("span", {}, e.reply ? "About " : "On "),
        h("q", {}, quote),
        h("button", { type: "button", title: "Do not point at these words", "aria-label": "Remove the quoted words", onClick: () => { quote = null; drawQuote(); if (this.editing?.kind === "new") this.editing.quote = null; this.sendMarks(); } }, "\u00d7"),
      );
    };
    drawQuote();
    card.append(
      h("div", { class: "title" }, e.reply ? "Reply to Claude" : "Note for Claude"),
      quoteLine,
      this.editor({
        kind: e.initial,
        text: "",
        onSave: (kind, text) => {
          const at = e.src ? insertAfterLine(this.text, e.src) : -1;
          this.commit(insertNote(this.text, at, kind, withQuote(text, quote)));
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
    const { body, quote } = splitQuote(n.text);
    const card = h("div", { class: `card k-${n.kind}${answered ? " answered" : ""}${editing ? " editing" : ""}${this.focusIds.includes(n.start) ? " focus" : ""}${group.src && group.src === this.active ? " active" : ""}`, "data-line": n.start });
    if (editing) {
      card.append(
        this.editor({
          kind: n.kind,
          text: body,
          onSave: (kind, text) => this.commit(editNote(this.text, n, withQuote(text, quote), kind)),
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
      h("div", { class: "text" }, h("span", { class: "kind" }, KIND_NAME[n.kind]), body || (n.kind === "?" ? "This lost me" : ""), answered ? null : h("span", { class: "open-dot", title: "Not processed yet" })),
    );
    if (quote) card.append(h("div", { class: "quote" }, h("span", {}, "On "), h("q", {}, quote)));
    for (const a of t.answers) {
      card.append(
        h(
          "div",
          { class: "answer" },
          h("span", { class: "a" }, "A"),
          h("span", { class: "body" }, a.text),
          h("button", { class: "reply", type: "button", title: "Answer Claude with a new note", onClick: (ev: Event) => { ev.stopPropagation(); this.reply(group.src, n, quote); } }, "Reply"),
          h("button", { type: "button", title: "Mark read: removes this note and its answer", "aria-label": "Mark read", onClick: (ev: Event) => { ev.stopPropagation(); this.commit(this.removeThread(t)); } }, "✓ Read"),
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
      this.focusIds = [n.start];
      this.draft = null;
      this.drawNotes();
      this.notesCol.querySelector<HTMLElement>(".editor textarea")?.focus();
    });
    return card;
  }

  /** Answer Claude's answer: a new note under the old ones, which Claude Code finds as it finds any unanswered note. */
  private reply(src: string | null, original: Note, quote: string | null): void {
    this.editing = { kind: "new", src, quote, initial: original.kind === "?" ? "Q" : original.kind, reply: true, y: null };
    this.draft = null;
    this.drawNotes();
    this.focusBox();
    this.revealBox();
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

  /**
   * Mark every occurrence of `query` on the page and go to one: the one a book-wide search result pointed at when
   * `ordinal` is given, else the first at or below what is on screen.
   */
  findSet(query: string, at: { ordinal: number; ctx: string } | null = null): void {
    this.findQuery = query;
    if (!query.trim()) return this.clearFind();
    if (!this.ready) {
      this.pendingFind = { query, ordinal: at?.ordinal ?? null, ctx: at?.ctx ?? null };
      return;
    }
    this.sendFind(query, at?.ordinal ?? null, at?.ctx ?? null);
  }

  private sendFind(query: string, ordinal: number | null, ctx: string | null): void {
    this.post({ type: "find-set", query, ordinal, ctx, fromY: this.scroller.scrollTop / this.zoom });
  }

  /** Go to the next (1) or previous (-1) occurrence. */
  findStep(delta: number): void {
    this.post({ type: "find-step", delta });
  }

  clearFind(): void {
    this.findQuery = "";
    this.pendingFind = null;
    this.post({ type: "find-clear" });
    this.hooks.onFound(0, -1);
  }
}
