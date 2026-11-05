// Searching the whole book from the left panel. Type some words: every chapter that has them is listed with how many
// times, and under it the sentences where they occur, with the words marked. Click one (or move through them with the
// arrow keys) and the chapter opens at that spot.

import type { SearchChapter, SearchHit, SearchResult } from "../../core/search.ts";
import { MIN_QUERY } from "../../core/search.ts";
import { clear, h } from "./dom.ts";

export interface SearchHooks {
  /** The open chapter as the editor holds it (it may have edits that are not saved yet). */
  current(): { file: string; text: string } | null;
  /** The chapter's number and title for the list. */
  chapterInfo(file: string): { num: string; title: string } | null;
  /** The reader picked a match (or a chapter, when `hit` is null): show it. */
  onOpen(file: string, hit: SearchHit | null, query: string): void;
  search(query: string, current: { file: string; text: string } | null): Promise<SearchResult>;
  /** Whether the results are showing instead of the chapter list. */
  onActive(active: boolean): void;
}

const SHOWN_FIRST = 5;

export class SearchPanel {
  private input: HTMLInputElement;
  private summary: HTMLElement;
  private timer: number | undefined;
  private token = 0;
  private result: SearchResult | null = null;
  private expanded = new Set<string>();
  /** The matches in the order they are listed, for moving through them with the keys. */
  private rows: { file: string; hit: SearchHit; el: HTMLElement }[] = [];
  private active = -1;
  /** Which match was last shown (chapter and place), so a fresh list can mark it again without jumping. */
  private activeKey = "";

  constructor(
    private bar: HTMLElement,
    private results: HTMLElement,
    private hooks: SearchHooks,
  ) {
    this.input = h("input", { type: "search", placeholder: "Search the whole book", "aria-label": "Search the whole book", spellcheck: "false" });
    this.summary = h("div", { class: "search-summary", role: "status" });
    this.bar.append(this.input, this.summary);
    this.input.addEventListener("input", () => this.schedule(160));
    this.input.addEventListener("keydown", (e) => this.onKey(e));
  }

  get query(): string {
    return this.input.value.trim();
  }

  get isActive(): boolean {
    return this.query.length >= MIN_QUERY;
  }

  /** Put the cursor in the box (and select what is there), for Cmd+Shift+F. */
  focus(): void {
    this.input.focus();
    this.input.select();
  }

  clear(): void {
    this.input.value = "";
    this.result = null;
    this.rows = [];
    this.active = -1;
    this.activeKey = "";
    this.token++;
    this.render();
  }

  /** Run the search again, because the book changed. */
  refresh(): void {
    if (this.isActive) this.schedule(250);
  }

  private schedule(ms: number): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.run(), ms);
  }

  private async run(): Promise<void> {
    const q = this.query;
    if (q.length < MIN_QUERY) {
      this.result = null;
      this.expanded.clear();
      return this.render();
    }
    const mine = ++this.token;
    let res: SearchResult;
    try {
      res = await this.hooks.search(q, this.hooks.current());
    } catch {
      return;
    }
    if (mine !== this.token) return; // a newer search is already under way
    if (!this.result || this.result.query !== res.query) this.expanded.clear();
    this.result = res;
    this.render();
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      if (this.input.value) this.clear();
      else this.input.blur();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!this.rows.length) return;
      e.preventDefault();
      this.move(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!this.rows.length) return void this.run();
      // The first Enter opens the first match; each one after goes on to the next (Shift goes back).
      this.move(this.active < 0 ? 0 : e.shiftKey ? -1 : 1, this.active < 0);
    }
  }

  /** Select a match, and show it. */
  private move(step: number, absolute = false): void {
    const n = this.rows.length;
    const next = absolute ? step : (this.active + step + n) % n;
    this.select(next);
  }

  private select(i: number): void {
    const row = this.rows[i];
    if (!row) return;
    this.rows[this.active]?.el.classList.remove("active");
    this.active = i;
    this.activeKey = `${row.file}\0${row.hit.ordinal}\0${row.hit.line}`;
    row.el.classList.add("active");
    row.el.scrollIntoView({ block: "nearest" });
    this.hooks.onOpen(row.file, row.hit, this.result?.query ?? this.query);
  }

  private render(): void {
    clear(this.results);
    this.rows = [];
    this.active = -1;
    const on = this.isActive;
    this.results.hidden = !on;
    this.hooks.onActive(on);
    if (!on) {
      this.summary.textContent = this.query ? `Type at least ${MIN_QUERY} letters.` : "";
      return;
    }
    const r = this.result;
    if (!r) {
      this.summary.textContent = "Searching...";
      return;
    }
    if (r.total === 0) {
      this.summary.textContent = `No chapter has "${r.query}".`;
      return;
    }
    this.summary.textContent = `${r.total} match${r.total === 1 ? "" : "es"} in ${r.chapters.length} chapter${r.chapters.length === 1 ? "" : "s"}`;
    const here = this.hooks.current()?.file;
    for (const c of r.chapters) this.results.append(this.group(c, c.file === here, r.query));
    const again = this.rows.findIndex((x) => `${x.file}\0${x.hit.ordinal}\0${x.hit.line}` === this.activeKey);
    if (again >= 0) {
      this.active = again;
      this.rows[again].el.classList.add("active");
    }
  }

  private group(c: SearchChapter, current: boolean, query: string): HTMLElement {
    const info = this.hooks.chapterInfo(c.file);
    const box = h("div", { class: `sr-group${current ? " current" : ""}` });
    box.append(
      h(
        "button",
        { class: "sr-head", type: "button", title: "Open this chapter at its first match", onClick: () => this.hooks.onOpen(c.file, c.hits[0] ?? null, query) },
        h("span", { class: "num" }, info?.num ?? ""),
        h("span", { class: "name" }, info?.title ?? c.file.split(/[\\/]/).pop()!),
        h("span", { class: "n" }, String(c.count)),
      ),
    );
    const all = this.expanded.has(c.file);
    const shown = all ? c.hits : c.hits.slice(0, SHOWN_FIRST);
    for (const hit of shown) box.append(this.row(c.file, hit));
    if (c.hits.length > SHOWN_FIRST && !all) {
      box.append(h("button", { class: "sr-more", type: "button", onClick: () => (this.expanded.add(c.file), this.render()) }, `Show all ${c.count}${c.count > c.hits.length ? ` (first ${c.hits.length})` : ""}`));
    }
    return box;
  }

  private row(file: string, hit: SearchHit): HTMLElement {
    const el = h(
      "button",
      { class: "sr-hit", type: "button", onClick: () => this.select(this.rows.findIndex((r) => r.el === el)) },
      h("span", { class: "snip" }, hit.before, h("mark", {}, hit.match), hit.after),
      h("span", { class: "where" }, hit.section ? `${hit.section} · line ${hit.line}` : `line ${hit.line}`),
    );
    this.rows.push({ file, hit, el });
    return el;
  }
}
