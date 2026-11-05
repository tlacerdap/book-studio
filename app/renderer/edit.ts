// The Edit view: the chapter as it looks on the page (the book's own styles), edited directly. What is typed is written back
// as markdown, and only the paragraph, list or table that was edited is rewritten: the rest of the file stays exactly as it was.
// The page is one long page here; where the printed pages break is shown in the Reading view.

import { baseKeymap, chainCommands, createParagraphNear, liftEmptyBlock, newlineInCode, setBlockType, splitBlock, toggleMark, wrapIn, lift } from "prosemirror-commands";
import { dropCursor } from "prosemirror-dropcursor";
import { gapCursor } from "prosemirror-gapcursor";
import { history, redo, undo } from "prosemirror-history";
import { InputRule, inputRules, textblockTypeInputRule, wrappingInputRule } from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import { Fragment, type MarkType, type Node as PMNode, type NodeType } from "prosemirror-model";
import { liftListItem, sinkListItem, splitListItem, wrapInList } from "prosemirror-schema-list";
import { EditorState, Plugin, PluginKey, TextSelection, type Command, type Transaction } from "prosemirror-state";
import { goToNextCell, tableEditing } from "prosemirror-tables";
import { Decoration, DecorationSet, EditorView, type NodeView } from "prosemirror-view";
import type { FormatCommand } from "../../core/format.ts";
import { parseChapter, serializeChapter, type Meta } from "../../core/pm/markdown.ts";
import { schema } from "../../core/pm/schema.ts";

export interface EditHooks {
  /** The chapter's markdown after a change (a moment after typing stops). */
  onChange(text: string): void;
  /** Where a picture written as `src` in the chapter is served from. */
  imageUrl(src: string): string;
  /** Pictures pasted or dropped: keep them in the book and give back the markdown for each. */
  onPictures(files: File[]): Promise<string[] | null>;
  /** Ask for a web address (the current one is given); null if the reader cancelled, "" to take the link off. */
  askLink(current: string): Promise<string | null>;
  onFound(count: number, index: number): void;
  onToast(message: string): void;
}

const findKey = new PluginKey<{ query: string }>("find");

const UI_CSS = `
:host { display: block; }
.desk { padding: 28px 16px 120px; display: flex; justify-content: center; }
.paper { width: 100%; max-width: 760px; background: #fff; color: #1f1e1d; box-shadow: 0 0 0 1px rgba(0,0,0,.08), 0 4px 16px rgba(0,0,0,.10); padding: 64px 76px 80px; box-sizing: border-box; min-height: 600px; }
.ProseMirror { outline: none; white-space: pre-wrap; word-wrap: break-word; caret-color: #1f1e1d; }
.ProseMirror > :first-child { margin-top: 0; }
.chapter-body h1 { font-family: var(--font-heading); font-weight: 400; font-size: var(--size-h1, 24pt); line-height: 1.2; margin: 0 0 0.8em; }
.ProseMirror .pm-soft { white-space: normal; }
.ProseMirror img { display: block; margin: 1em auto; max-width: 100%; max-height: 110mm; height: auto; }
.ProseMirror img.ProseMirror-selectednode { outline: 2px solid #5b8def; }
.ProseMirror table { width: 100%; table-layout: auto; }
.ProseMirror td, .ProseMirror th { position: relative; vertical-align: top; }
.ProseMirror .selectedCell { background: rgba(91, 141, 239, 0.18); }
.ProseMirror pre { white-space: pre-wrap; }
.ProseMirror pre::before { content: attr(data-lang); display: block; font: 600 9px/1 var(--font-ui, sans-serif); letter-spacing: 0.08em; text-transform: uppercase; color: #8a8782; margin-bottom: 6px; }
.ProseMirror pre[data-lang=""]::before { display: none; }
.pm-note { margin: 0 0 0.9em; padding: 3px 8px; border-left: 3px solid #1f1e1d; background: rgba(0,0,0,.04); border-radius: 3px; font: 12px/1.4 var(--font-ui, sans-serif); color: #5d5b57; user-select: none; }
.pm-note.k-Q { border-left-color: #2f4f7a; } .pm-note.k-E { border-left-color: #7a4a1f; } .pm-note.k-c { border-left-color: #6b3b6b; } .pm-note.k-A { border-left-color: #2d5a35; }
.pm-note b { margin-right: 6px; }
.pm-raw { margin: 0 0 0.9em; padding: 6px 10px; background: #f6f1e6; border: 1px dashed #c9b98d; border-radius: 4px; font: 12px/1.5 var(--font-mono, monospace); color: #5d4a2a; white-space: pre-wrap; user-select: none; position: relative; }
.pm-raw::after { content: "kept exactly as written: edit it in the Source view"; display: block; margin-top: 4px; font: 10.5px var(--font-ui, sans-serif); color: #8a7a52; }
.ProseMirror-selectednode.pm-note, .ProseMirror-selectednode.pm-raw { outline: 2px solid #5b8def; }
/* Themes, as on the Reading pages. */
:host([data-theme="sepia"]) { --color-text: #3b2f1e; --color-meta: #2a2013; --color-secondary: #66573f; --color-code-comment: #7a6a4e; --color-code-string: #4a3b22; --color-rule: #a89670; --color-code-border: #c9b78f; }
:host([data-theme="sepia"]) .paper { background: #f9f2e0; color: #3b2f1e; caret-color: #3b2f1e; }
:host([data-theme="dark"]) { --color-text: #e6e2d9; --color-meta: #f3f0e8; --color-secondary: #b3afa6; --color-code-comment: #9a968c; --color-code-string: #cfd6c1; --color-rule: #6b6860; --color-code-border: #55524c; }
:host([data-theme="dark"]) .paper { background: #262523; color: #e6e2d9; caret-color: #e6e2d9; box-shadow: 0 0 0 1px rgba(255,255,255,.08); }
:host([data-theme="black"]) { --color-text: #e8e6e1; --color-meta: #f5f3ee; --color-secondary: #aeaba5; --color-code-comment: #928f89; --color-code-string: #cfd6c1; --color-rule: #5a5853; --color-code-border: #44423e; }
:host([data-theme="black"]) .paper { background: #0d0d0d; color: #e8e6e1; caret-color: #e8e6e1; box-shadow: 0 0 0 1px rgba(255,255,255,.10); }
:host([data-theme="dark"]) .pm-note, :host([data-theme="black"]) .pm-note { background: rgba(255,255,255,.07); color: #b3afa6; border-left-color: #b3afa6; }
:host([data-theme="dark"]) .pm-raw, :host([data-theme="black"]) .pm-raw { background: #2c2a24; border-color: #5c5538; color: #d8b57a; }
:host([data-theme="dark"]) .ProseMirror pre::before, :host([data-theme="black"]) .ProseMirror pre::before { color: #8f8c86; }
.find-match { background: rgba(120,170,255,.38); }
.find-current { background: rgba(60,120,255,.6); }
.ProseMirror-gapcursor { display: none; pointer-events: none; position: absolute; }
.ProseMirror-gapcursor:after { content: ""; display: block; position: absolute; top: -2px; width: 20px; border-top: 1px solid #1f1e1d; animation: ProseMirror-cursor-blink 1.1s steps(2, start) infinite; }
@keyframes ProseMirror-cursor-blink { to { visibility: hidden; } }
.ProseMirror-focused .ProseMirror-gapcursor { display: block; }
.ProseMirror-dropcursor { background: #5b8def; }
`;

/** A rule that turns `**words**`, `*words*` or `` `words` `` typed into the mark as the closing mark is typed. */
const markRule = (re: RegExp, mark: MarkType, open: number): InputRule =>
  new InputRule(re, (state, match, start, end) => {
    const text = match[1];
    const tr = state.tr.delete(start, end);
    const from = tr.mapping.map(start);
    tr.insertText(text, from).addMark(from, from + text.length, mark.create());
    tr.removeStoredMark(mark);
    void open;
    return tr;
  });

function rules(): Plugin {
  const s = schema.nodes;
  const m = schema.marks;
  return inputRules({
    rules: [
      textblockTypeInputRule(/^(#{1,3})\s$/, s.heading, (match) => ({ level: match[1].length })),
      wrappingInputRule(/^\s*([-+*])\s$/, s.bullet_list),
      wrappingInputRule(/^(\d+)\.\s$/, s.ordered_list, (match) => ({ order: +match[1] }), (match, node) => node.childCount + (node.attrs.order as number) === +match[1]),
      wrappingInputRule(/^\s*>\s$/, s.blockquote),
      textblockTypeInputRule(/^```([a-z]*)$/, s.code_block, (match) => ({ params: match[1] })),
      markRule(/(?<!\*)\*\*([^*\s][^*]*)\*\*$/, m.strong, 2),
      markRule(/(?<![*\w])\*([^*\s][^*]*)\*$/, m.em, 1),
      markRule(/`([^`]+)`$/, m.code, 1),
    ],
  });
}

/** Whether a mark applies to the whole selection (for toggling). */
const hasMark = (state: EditorState, type: MarkType): boolean => {
  const { from, to, empty, $from } = state.selection;
  return empty ? !!type.isInSet(state.storedMarks || $from.marks()) : state.doc.rangeHasMark(from, to, type);
};

export class EditView {
  private view: EditorView | null = null;
  private host: HTMLElement;
  private paper: HTMLElement;
  private mount: HTMLElement;
  private bookStyle: HTMLStyleElement;
  private timer: number | undefined;
  private zoom = 1;
  private matches: { from: number; to: number }[] = [];
  private current = -1;
  private findQuery = "";

  constructor(
    private root: HTMLElement,
    private hooks: EditHooks,
  ) {
    this.host = document.createElement("div");
    const shadow = this.host.attachShadow({ mode: "open" });
    this.bookStyle = document.createElement("style");
    const ui = document.createElement("style");
    ui.textContent = UI_CSS;
    const desk = document.createElement("div");
    desk.className = "desk";
    this.paper = document.createElement("div");
    this.paper.className = "paper";
    const article = document.createElement("article");
    article.className = "chapter";
    this.mount = document.createElement("div");
    this.mount.className = "chapter-body";
    article.append(this.mount);
    this.paper.append(article);
    desk.append(this.paper);
    shadow.append(this.bookStyle, ui, desk);
    this.root.append(this.host);
  }

  /** The book's styles, as the page uses them (see core/editcss.ts). */
  setCss(css: string): void {
    this.bookStyle.textContent = css;
  }

  /** The page takes the reader's theme (light, sepia, dark, black). */
  setTheme(theme: string): void {
    this.host.dataset.theme = theme;
  }

  setZoom(z: number): void {
    this.zoom = z;
    this.paper.style.zoom = String(z);
  }

  // ---- the document --------------------------------------------------------------------------

  /** Show a chapter (markdown text). Nothing is reported as a change. */
  load(text: string, line?: number): void {
    window.clearTimeout(this.timer);
    const state = EditorState.create({ doc: parseChapter(text), plugins: this.plugins() });
    if (this.view) this.view.updateState(state);
    else this.view = this.createView(state);
    this.matches = [];
    this.current = -1;
    if (line !== undefined) this.scrollToLine(line);
  }

  get text(): string {
    return this.view ? serializeChapter(this.view.state.doc) : "";
  }

  /** Report a pending change now. */
  flush(): void {
    if (this.timer === undefined) return;
    window.clearTimeout(this.timer);
    this.timer = undefined;
    this.hooks.onChange(this.text);
  }

  focus(): void {
    this.view?.focus();
  }

  get hasFocus(): boolean {
    return !!this.view?.hasFocus();
  }

  destroyView(): void {
    window.clearTimeout(this.timer);
    this.view?.destroy();
    this.view = null;
  }

  private createView(state: EditorState): EditorView {
    const hooks = this.hooks;
    const view = new EditorView(this.mount, {
      state,
      attributes: { spellcheck: "true", "aria-label": "Chapter" },
      dispatchTransaction: (tr: Transaction) => {
        const next = view.state.apply(tr);
        view.updateState(next);
        if (tr.docChanged) {
          window.clearTimeout(this.timer);
          this.timer = window.setTimeout(() => {
            this.timer = undefined;
            hooks.onChange(this.text);
          }, 350);
        }
      },
      nodeViews: {
        image: (node): NodeView => {
          const img = document.createElement("img");
          img.src = hooks.imageUrl(String(node.attrs.src));
          img.alt = String(node.attrs.alt ?? "");
          return { dom: img };
        },
        note: (node): NodeView => {
          const src = String(node.attrs.source);
          const first = /^(?:<!--|%%)\s*([QEA?])/.exec(src)?.[1] ?? "?";
          const dom = document.createElement("div");
          dom.className = `pm-note k-${first === "?" ? "c" : first}`;
          const label = document.createElement("b");
          label.textContent = first === "?" ? "Lost me" : first === "Q" ? "Question" : first === "E" ? "Change this" : "Answer";
          const body = src.replace(/^(?:<!--|%%)\s*(?:[QEA]:|\?)?\s*/, "").split("\n")[0].replace(/\s*(?:-->|%%)\s*$/, "");
          dom.append(label, document.createTextNode(body));
          return { dom };
        },
        raw_block: (node): NodeView => {
          const dom = document.createElement("pre");
          dom.className = "pm-raw";
          dom.textContent = String(node.attrs.source);
          return { dom };
        },
        code_block: (node): NodeView => {
          const pre = document.createElement("pre");
          pre.className = "code";
          pre.dataset.lang = String(node.attrs.params || "");
          const code = document.createElement("code");
          pre.append(code);
          return { dom: pre, contentDOM: code };
        },
      },
      handlePaste: (_v, event) => this.pictures(event.clipboardData?.files),
      handleDrop: (_v, event) => this.pictures((event as DragEvent).dataTransfer?.files),
      decorations: (state) => this.decorations(state),
    });
    return view;
  }

  private pictures(list: FileList | undefined | null): boolean {
    const files = [...(list ?? [])].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return false;
    void this.hooks.onPictures(files).then((md) => md && this.insertPictures(md));
    return true;
  }

  private plugins(): Plugin[] {
    const s = schema.nodes;
    const enter = chainCommands(newlineInCode, splitListItem(s.list_item), createParagraphNear, liftEmptyBlock, splitBlock);
    const hardBreak: Command = (state, dispatch) => {
      dispatch?.(state.tr.replaceSelectionWith(s.hard_break.create()).scrollIntoView());
      return true;
    };
    return [
      rules(),
      keymap({
        Enter: enter,
        "Shift-Enter": hardBreak,
        Tab: chainCommands(goToNextCell(1), sinkListItem(s.list_item)),
        "Shift-Tab": chainCommands(goToNextCell(-1), liftListItem(s.list_item)),
        "Mod-b": toggleMark(schema.marks.strong),
        "Mod-i": toggleMark(schema.marks.em),
        "Mod-z": undo,
        "Shift-Mod-z": redo,
      }),
      keymap(baseKeymap),
      history(),
      tableEditing(),
      gapCursor(),
      dropCursor({ color: "#5b8def" }),
      new Plugin({ key: findKey, state: { init: () => ({ query: "" }), apply: (tr, v) => (tr.getMeta(findKey) ?? v) } }),
    ];
  }

  // ---- commands ------------------------------------------------------------------------------

  undo(): void {
    if (this.view) undo(this.view.state, this.view.dispatch);
  }

  redo(): void {
    if (this.view) redo(this.view.state, this.view.dispatch);
  }

  /** Apply a formatting command (the bold button, a list...) to the selection. */
  command(cmd: FormatCommand): void {
    const view = this.view;
    if (!view) return;
    const { state, dispatch } = view;
    const s = schema.nodes;
    const m = schema.marks;
    const run = (c: Command) => c(state, dispatch, view);
    switch (cmd) {
      case "bold":
        run(toggleMark(m.strong));
        break;
      case "italic":
        run(toggleMark(m.em));
        break;
      case "code":
        run(toggleMark(m.code));
        break;
      case "h2":
      case "h3": {
        const level = cmd === "h2" ? 2 : 3;
        const here = state.selection.$from.parent;
        run(here.type === s.heading && here.attrs.level === level ? setBlockType(s.paragraph) : setBlockType(s.heading, { level }));
        break;
      }
      case "bullets":
        this.toggleList(s.bullet_list);
        break;
      case "numbers":
        this.toggleList(s.ordered_list);
        break;
      case "quote":
        run(this.inside(s.blockquote) ? lift : wrapIn(s.blockquote));
        break;
      case "link":
        void this.link();
        break;
      case "table": {
        this.insertBlock(this.newTable());
        // The first header's placeholder is selected, ready to be typed over.
        const at = this.view!.state.selection.from;
        this.view!.dispatch(this.view!.state.tr.setSelection(TextSelection.create(this.view!.state.doc, at, at + "Column".length)));
        break;
      }
      case "diagram":
        this.insertBlock(s.code_block.create({ params: "mermaid" }, schema.text("flowchart LR\n  A[Client] --> B[Server]\n  B --> C[(Database)]")));
        break;
    }
    view.focus();
  }

  private inside(type: NodeType): boolean {
    const { $from } = this.view!.state.selection;
    for (let d = $from.depth; d > 0; d--) if ($from.node(d).type === type) return true;
    return false;
  }

  private toggleList(type: NodeType): void {
    const view = this.view!;
    const { state, dispatch } = view;
    if (this.inside(type)) liftListItem(schema.nodes.list_item)(state, dispatch);
    else {
      if (this.inside(schema.nodes.bullet_list) || this.inside(schema.nodes.ordered_list)) liftListItem(schema.nodes.list_item)(view.state, dispatch);
      wrapInList(type)(view.state, dispatch);
    }
  }

  private async link(): Promise<void> {
    const view = this.view!;
    const { from, to, empty } = view.state.selection;
    const type = schema.marks.link;
    let href = "";
    view.state.doc.nodesBetween(from, to, (n) => {
      const mk = n.marks.find((x) => x.type === type);
      if (mk) href = String(mk.attrs.href);
    });
    if (empty && !href) return this.hooks.onToast("Select the words to link first.");
    const url = await this.hooks.askLink(href);
    if (url === null) return;
    const tr = view.state.tr.removeMark(from, to, type);
    if (url) tr.addMark(from, to, type.create({ href: url }));
    view.dispatch(tr);
    view.focus();
  }

  private newTable(): PMNode {
    const s = schema.nodes;
    const cell = (type: NodeType, text: string) => type.create(null, text ? schema.text(text) : Fragment.empty);
    return s.table.create(null, [s.table_row.create(null, [cell(s.table_header, "Column"), cell(s.table_header, "Column")]), s.table_row.create(null, [cell(s.table_cell, ""), cell(s.table_cell, "")])]);
  }

  /** Put a block after the one the cursor is in. */
  private insertBlock(node: PMNode): void {
    const view = this.view!;
    const { $from } = view.state.selection;
    const pos = $from.depth >= 1 ? $from.after(1) : view.state.doc.content.size;
    const tr = view.state.tr.insert(pos, node);
    view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1))).scrollIntoView());
  }

  /** Pictures kept in the book, as markdown (`![alt](path)`), put in after the current block. */
  insertPictures(markdown: string[]): void {
    const view = this.view;
    if (!view) return;
    for (const md of markdown) {
      const m = /^!\[([^\]]*)\]\(([^)\s]+)\)/.exec(md);
      if (!m) continue;
      // The editor's schema has pictures inside a paragraph, as markdown does.
      this.insertBlock(schema.nodes.paragraph.create(null, schema.nodes.image.create({ src: m[2], alt: m[1] || null })));
    }
  }

  // ---- places in the chapter -----------------------------------------------------------------

  /** Bring the block that starts at (or before) a line of the file into view, with the cursor in it. */
  scrollToLine(line: number): void {
    const view = this.view;
    if (!view) return;
    let target = 0;
    view.state.doc.forEach((n, offset) => {
      const meta = n.attrs.meta as Meta | null;
      if (meta && meta.line <= line) target = offset;
    });
    const tr = view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(Math.min(target + 1, view.state.doc.content.size))));
    view.dispatch(tr);
    this.reveal(target + 1, "start");
  }

  /** The line of the file where the block with the cursor starts (a new block counts as the one before it). */
  currentLine(): number | null {
    const view = this.view;
    if (!view) return null;
    const idx = view.state.selection.$from.index(0);
    for (let i = Math.min(idx, view.state.doc.childCount - 1); i >= 0; i--) {
      const meta = view.state.doc.child(i).attrs.meta as Meta | null;
      if (meta) return meta.line;
    }
    return null;
  }

  private reveal(pos: number, block: "start" | "center"): void {
    const view = this.view;
    if (!view) return;
    try {
      const rect = view.coordsAtPos(pos);
      const box = this.root.getBoundingClientRect();
      const y = rect.top - box.top + this.root.scrollTop;
      if (block === "start") this.root.scrollTop = Math.max(0, y - 80);
      else if (rect.top < box.top + 40 || rect.bottom > box.bottom - 40) this.root.scrollTop = Math.max(0, y - box.height / 3);
    } catch {
      /* the position is not on screen yet */
    }
  }

  // ---- find ----------------------------------------------------------------------------------

  private decorations(state: EditorState): DecorationSet | null {
    if (!this.matches.length) return null;
    return DecorationSet.create(
      state.doc,
      this.matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === this.current ? "find-match find-current" : "find-match" })),
    );
  }

  findSet(query: string): void {
    const view = this.view;
    this.findQuery = query;
    this.matches = [];
    this.current = -1;
    if (view && query.trim().length >= 1) {
      const q = query.toLowerCase();
      view.state.doc.descendants((node, pos) => {
        if (!node.isText || !node.text) return;
        const t = node.text.toLowerCase();
        for (let i = t.indexOf(q); i >= 0; i = t.indexOf(q, i + q.length)) this.matches.push({ from: pos + i, to: pos + i + q.length });
      });
      if (this.matches.length) {
        const top = this.root.scrollTop;
        const at = this.matches.findIndex((m) => view.coordsAtPos(m.from).top - this.root.getBoundingClientRect().top + top >= top);
        this.current = at >= 0 ? at : 0;
      }
    }
    this.refreshFind();
  }

  findStep(delta: number): void {
    if (!this.matches.length) return;
    this.current = (this.current + delta + this.matches.length) % this.matches.length;
    this.refreshFind();
  }

  clearFind(): void {
    this.findSet("");
  }

  private refreshFind(): void {
    const view = this.view;
    if (!view) return;
    view.dispatch(view.state.tr.setMeta(findKey, { query: this.findQuery }).setMeta("addToHistory", false));
    if (this.current >= 0) this.reveal(this.matches[this.current].from, "center");
    this.hooks.onFound(this.matches.length, this.current);
  }

  /** Is anything the mark of this type in the selection (for the format bar to show). */
  isActive(cmd: "bold" | "italic" | "code"): boolean {
    if (!this.view) return false;
    const type = cmd === "bold" ? schema.marks.strong : cmd === "italic" ? schema.marks.em : schema.marks.code;
    return hasMark(this.view.state, type);
  }
}
