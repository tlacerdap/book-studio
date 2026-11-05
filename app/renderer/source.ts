// The source view: the chapter's markdown, editable, in CodeMirror 6.

import { defaultKeymap, history, historyKeymap, indentWithTab, redo, undo } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { openSearchPanel, search, searchKeymap, searchPanelOpen, SearchQuery, setSearchQuery } from "@codemirror/search";
import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import { formatEdit, type FormatCommand } from "../../core/format.ts";
import { Prec } from "@codemirror/state";
import { Decoration, drawSelection, EditorView, keymap, MatchDecorator, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";

// Quiet colours: weight and slant for structure, one grey for marks. Headings are not underlined.
const highlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: "700", textDecoration: "none" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.monospace, color: "var(--hl-code)" },
  { tag: tags.quote, color: "var(--hl-quote)" },
  { tag: [tags.processingInstruction, tags.meta, tags.contentSeparator], color: "var(--hl-mark)" },
  { tag: tags.link, textDecoration: "none", color: "var(--hl-link)" },
  { tag: tags.url, color: "var(--hl-link)" },
]);

// Notes (HTML comments and Obsidian %% marks) get a quiet background so they are easy to tell from the text.
const noteMatcher = new MatchDecorator({ regexp: /<!--.*?-->|%%.*?%%/g, decoration: Decoration.mark({ class: "cm-note" }) });
const noteMarks = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = noteMatcher.createDeco(view);
    }
    update(u: ViewUpdate) {
      this.decorations = noteMatcher.updateDeco(u, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

/** Words the writing checks found: marked with a wavy line, with the reason as a tooltip. */
const setHintMarks = StateEffect.define<{ from: number; to: number; message: string }[]>();
const hintMarks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setHintMarks)) {
        value = Decoration.set(
          e.value
            .filter((m) => m.to > m.from && m.to <= tr.state.doc.length)
            .map((m) => Decoration.mark({ class: "cm-hint", attributes: { title: m.message } }).range(m.from, m.to))
            .sort((a, b) => a.from - b.from),
          true,
        );
      }
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export class SourceView {
  private view: EditorView;
  private muted = false;
  private extensions: Extension[];

  constructor(parent: HTMLElement, hooks: { onChange(text: string): void; onCursor?(line: number): void; onFocusChange?(focused: boolean): void; onImages?(files: File[]): void; onKeep?(): void; onCancel?(): void }) {
    this.extensions = [
          history(),
          drawSelection(),
          EditorView.lineWrapping,
          markdown(),
          syntaxHighlighting(highlight),
          search({ top: true }),
          noteMarks,
          hintMarks,
          // A picture pasted or dropped on the text is handed over to be kept in the book; the editor does not insert anything itself.
          EditorView.domEventHandlers({
            paste: (e) => {
              const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
              if (!files.length || !hooks.onImages) return false;
              e.preventDefault();
              hooks.onImages(files);
              return true;
            },
            drop: (e) => {
              const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"));
              if (!files.length || !hooks.onImages) return false;
              e.preventDefault();
              hooks.onImages(files);
              return true;
            },
          }),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
          // When the editor sits on the page, Cmd+Enter keeps the changes and Esc drops them (unless the search box is open: Esc closes that first).
          Prec.high(
            keymap.of([
              { key: "Mod-Enter", run: () => (hooks.onKeep ? (hooks.onKeep(), true) : false) },
              { key: "Escape", run: (v) => (hooks.onCancel && !searchPanelOpen(v.state) ? (hooks.onCancel(), true) : false) },
            ]),
          ),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !this.muted) hooks.onChange(u.state.doc.toString());
            else if (u.selectionSet && !this.muted) hooks.onCursor?.(u.state.doc.lineAt(u.state.selection.main.head).number - 1);
            if (u.focusChanged) hooks.onFocusChange?.(u.view.hasFocus);
          }),
          EditorView.contentAttributes.of({ "aria-label": "Chapter source", spellcheck: "true" }),
    ];
    this.view = new EditorView({ parent, state: EditorState.create({ doc: "", extensions: this.extensions }) });
  }

  /** Forget what can be undone (a new text was loaded; undo should not go back to the one before). */
  resetHistory(): void {
    this.view.setState(
      EditorState.create({ doc: this.view.state.doc, selection: this.view.state.selection, extensions: this.extensions }),
    );
  }

  destroy(): void {
    this.view.destroy();
  }

  get text(): string {
    return this.view.state.doc.toString();
  }

  /** Replace the whole text without telling anyone (used when the app itself changes the file). */
  setText(text: string): void {
    if (text === this.text) return;
    const sel = this.view.state.selection.main;
    this.muted = true;
    try {
      this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text }, selection: { anchor: Math.min(sel.anchor, text.length) } });
    } finally {
      this.muted = false;
    }
  }

  /** Text size, as a multiple of the default (the zoom buttons also size the source view). */
  setScale(scale: number): void {
    this.view.dom.style.fontSize = `${13 * scale}px`;
    this.view.requestMeasure();
  }

  focus(): void {
    this.view.focus();
  }

  /** Mark the words the writing checks found. Lines and columns are 0-based. */
  setHints(hints: { line: number; column: number; length: number; message: string }[]): void {
    const doc = this.view.state.doc;
    const marks = hints
      .filter((h) => h.line >= 0 && h.line < doc.lines)
      .map((h) => {
        const l = doc.line(h.line + 1);
        return { from: l.from + h.column, to: Math.min(l.to, l.from + h.column + h.length), message: h.message };
      });
    this.view.dispatch({ effects: setHintMarks.of(marks) });
  }

  /** Put picture markdown (one or more `![alt](path)`) on its own lines at the cursor, with the alt text selected so it can be written over. */
  insertPictures(lines: string[]): void {
    const doc = this.view.state.doc;
    const sel = this.view.state.selection.main;
    const at = doc.lineAt(sel.head);
    const blank = at.text.trim() === "";
    const insert = (blank ? "" : "\n\n") + lines.join("\n\n") + "\n";
    const from = blank ? at.from : at.to;
    const to = blank ? at.to : at.to;
    const altStart = from + (blank ? 0 : 2) + 2;
    const alt = /^!\[([^\]]*)\]/.exec(lines[0])?.[1] ?? "";
    this.view.dispatch({ changes: { from, to, insert }, selection: { anchor: altStart, head: altStart + alt.length }, scrollIntoView: true, userEvent: "input.paste" });
    this.view.focus();
  }

  undo(): void {
    undo(this.view);
  }

  redo(): void {
    redo(this.view);
  }

  get hasFocus(): boolean {
    return this.view.hasFocus;
  }

  /** Apply a formatting command (bold, a list, a link...) to the selection. */
  format(cmd: FormatCommand): void {
    const sel = this.view.state.selection.main;
    const e = formatEdit(cmd, this.text, sel.from, sel.to);
    this.view.dispatch({ changes: { from: e.from, to: e.to, insert: e.insert }, selection: { anchor: e.select.from, head: e.select.to }, scrollIntoView: true, userEvent: "input.format" });
    this.view.focus();
  }

  openFind(): void {
    openSearchPanel(this.view);
  }

  /** Fill the editor's search box with some words, so every occurrence is marked. */
  setSearch(query: string): void {
    this.view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: query, caseSensitive: false })) });
  }

  /** Go to a 0-based line and select the first occurrence of `query` on it; every other occurrence is marked too. */
  showMatch(line: number, query: string): void {
    const doc = this.view.state.doc;
    const l = doc.line(Math.min(Math.max(1, line + 1), doc.lines));
    const at = l.text.toLowerCase().indexOf(query.trim().toLowerCase());
    const from = at >= 0 ? l.from + at : l.from;
    const to = at >= 0 ? from + query.trim().length : l.from;
    openSearchPanel(this.view);
    this.view.dispatch({
      effects: [setSearchQuery.of(new SearchQuery({ search: query.trim(), caseSensitive: false })), EditorView.scrollIntoView(from, { y: "center" })],
      selection: { anchor: from, head: to },
    });
    this.view.focus();
  }

  /** Scroll to a 0-based line and put the cursor at its start. */
  goToLine(line: number): void {
    const doc = this.view.state.doc;
    const l = doc.line(Math.min(Math.max(1, line + 1), doc.lines));
    this.view.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: "start", yMargin: 80 }) });
  }

  /** The 0-based line at the top of the visible area. */
  topLine(): number {
    const block = this.view.lineBlockAtHeight(this.view.scrollDOM.scrollTop + 20);
    return this.view.state.doc.lineAt(block.from).number - 1;
  }

  get cursorLine(): number {
    return this.view.state.doc.lineAt(this.view.state.selection.main.head).number - 1;
  }
}
