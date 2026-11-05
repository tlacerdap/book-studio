// The source view: the chapter's markdown, editable, in CodeMirror 6.

import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { openSearchPanel, search, searchKeymap, SearchQuery, setSearchQuery } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { formatEdit, type FormatCommand } from "../../core/format.ts";
import { Decoration, drawSelection, EditorView, keymap, MatchDecorator, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";

// Quiet colours: weight and slant for structure, one grey for marks. Headings are not underlined.
const highlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: "700", textDecoration: "none" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.monospace, color: "#5d4a2a" },
  { tag: tags.quote, color: "#5d5b57" },
  { tag: [tags.processingInstruction, tags.meta, tags.contentSeparator], color: "#8a8782" },
  { tag: tags.link, textDecoration: "none", color: "#2f4f7a" },
  { tag: tags.url, color: "#2f4f7a" },
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

export class SourceView {
  private view: EditorView;
  private muted = false;

  constructor(parent: HTMLElement, hooks: { onChange(text: string): void; onCursor?(line: number): void; onFocusChange?(focused: boolean): void }) {
    this.view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "",
        extensions: [
          history(),
          drawSelection(),
          EditorView.lineWrapping,
          markdown(),
          syntaxHighlighting(highlight),
          search({ top: true }),
          noteMarks,
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !this.muted) hooks.onChange(u.state.doc.toString());
            else if (u.selectionSet && !this.muted) hooks.onCursor?.(u.state.doc.lineAt(u.state.selection.main.head).number - 1);
            if (u.focusChanged) hooks.onFocusChange?.(u.view.hasFocus);
          }),
          EditorView.contentAttributes.of({ "aria-label": "Chapter source", spellcheck: "true" }),
        ],
      }),
    });
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
