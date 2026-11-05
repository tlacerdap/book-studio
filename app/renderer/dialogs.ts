// Small modal pieces the window needs: a question with a text box (Electron has no prompt()), the "go to" palette and the
// version history. Each one closes with Escape and gives the keyboard back to where it came from.

import type { DiffLine, OutlineEntry, SnapshotInfo, StudioApi } from "../shared/api.ts";
import { clear, h } from "./dom.ts";

function overlay(label: string, onClose: () => void): { box: HTMLElement; close(): void } {
  const back = document.activeElement as HTMLElement | null;
  const box = h("div", { class: "modal", role: "dialog", "aria-label": label });
  const scrim = h("div", { class: "scrim" }, box);
  const close = () => {
    scrim.remove();
    document.removeEventListener("keydown", onKey, true);
    onClose();
    back?.focus?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  scrim.addEventListener("mousedown", (e) => {
    if (e.target === scrim) close();
  });
  document.addEventListener("keydown", onKey, true);
  document.body.append(scrim);
  return { box, close };
}

/** Ask for one line of text. Resolves to the text, or null if the reader cancelled. */
export function askText(title: string, opts: { initial?: string; confirm?: string; hint?: string; allowEmpty?: boolean } = {}): Promise<string | null> {
  return new Promise((resolve) => {
    let answer: string | null = null;
    const { box, close } = overlay(title, () => resolve(answer));
    const input = h("input", { type: "text", value: opts.initial ?? "", "aria-label": title, spellcheck: "true" });
    const done = () => {
      const v = input.value.trim();
      if (!v && !opts.allowEmpty) return;
      answer = v;
      close();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        done();
      }
    });
    box.append(h("h3", {}, title), input);
    if (opts.hint) box.append(h("p", { class: "small" }, opts.hint));
    box.append(
      h("div", { class: "row" }, h("button", { class: "tb-btn", type: "button", onClick: () => close() }, "Cancel"), h("button", { class: "tb-btn primary", type: "button", onClick: done }, opts.confirm ?? "OK")),
    );
    input.focus();
    input.select();
  });
}

export interface PaletteItem {
  kind: "chapter" | "heading";
  /** What is searched and shown. */
  title: string;
  /** Shown small on the right: the chapter a heading belongs to. */
  where: string;
  file: string;
  line: number;
}

/** Items for the palette: every chapter, then every heading of every chapter. */
export function paletteItems(chapters: { path: string; label: string; title: string }[], outlines: OutlineEntry[]): PaletteItem[] {
  const items: PaletteItem[] = [];
  for (const c of chapters) items.push({ kind: "chapter", title: `${c.label ? c.label.replace(/^Chapter /, "") + "  " : ""}${c.title}`, where: "chapter", file: c.path, line: 0 });
  for (const o of outlines) {
    const c = chapters.find((x) => x.path === o.file);
    for (const hd of o.headings) items.push({ kind: "heading", title: hd.title, where: c ? c.title : "", file: o.file, line: hd.line });
  }
  return items;
}

/** Words that all appear in the text, in any order, ignoring case: "web api" finds "The web and APIs". */
export function matches(items: PaletteItem[], query: string): PaletteItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return items.filter((i) => i.kind === "chapter");
  const scored: { item: PaletteItem; score: number }[] = [];
  for (const item of items) {
    const hay = item.title.toLowerCase();
    if (!words.every((w) => hay.includes(w))) continue;
    const t = item.title.toLowerCase();
    const score = (item.kind === "chapter" ? 0 : 5) + (words.every((w) => t.startsWith(w) || t.includes(` ${w}`)) ? 0 : 3) + t.length / 100;
    scored.push({ item, score });
  }
  return scored.sort((a, b) => a.score - b.score).slice(0, 40).map((s) => s.item);
}

export function openPalette(items: PaletteItem[], onPick: (item: PaletteItem) => void): void {
  const { box, close } = overlay("Go to chapter or heading", () => {});
  box.classList.add("palette");
  const input = h("input", { type: "text", placeholder: "Go to a chapter or a heading...", "aria-label": "Go to chapter or heading", spellcheck: "false" });
  const list = h("div", { class: "pal-list", role: "listbox" });
  let shown: PaletteItem[] = [];
  let at = 0;
  const draw = () => {
    clear(list);
    shown = matches(items, input.value);
    at = Math.min(at, Math.max(0, shown.length - 1));
    if (!shown.length) list.append(h("div", { class: "pal-empty" }, "Nothing matches."));
    shown.forEach((item, i) => {
      const row = h(
        "button",
        { class: `pal-row${i === at ? " on" : ""}`, type: "button", role: "option", "aria-selected": String(i === at), onMousedown: (e: Event) => e.preventDefault(), onClick: () => pick(item) },
        h("span", { class: `pal-kind ${item.kind}` }, item.kind === "chapter" ? "Chapter" : "Heading"),
        h("span", { class: "pal-title" }, item.title),
        item.kind === "heading" ? h("span", { class: "pal-where" }, item.where) : null,
      );
      list.append(row);
    });
    list.querySelector(".on")?.scrollIntoView({ block: "nearest" });
  };
  const pick = (item: PaletteItem) => {
    close();
    onPick(item);
  };
  input.addEventListener("input", () => {
    at = 0;
    draw();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      at = Math.min(shown.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)));
      draw();
    } else if (e.key === "Enter" && shown[at]) {
      e.preventDefault();
      pick(shown[at]);
    }
  });
  box.append(input, list);
  draw();
  input.focus();
}

const when = (t: number): string => {
  const d = new Date(t);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return sameDay ? `Today ${time}` : `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
};

/** Cut the unchanged runs of a diff down to a few lines of context, so only what changed is on screen. */
export function collapseDiff(lines: DiffLine[], context = 2): (DiffLine | { skipped: number })[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.tag === " ") return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out: (DiffLine | { skipped: number })[] = [];
  let skipped = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (skipped) out.push({ skipped });
      skipped = 0;
      out.push(l);
    } else skipped++;
  });
  if (skipped) out.push({ skipped });
  return out;
}

/** The versions of a chapter: pick one to see what changed since, and bring it back if wanted. */
export async function openHistory(api: StudioApi, file: string, name: string, current: () => string, onRestore: (text: string) => void): Promise<void> {
  const versions: SnapshotInfo[] = await api.historyList(file);
  const { box, close } = overlay(`Version history of ${name}`, () => {});
  box.classList.add("history");
  const list = h("div", { class: "hist-list" });
  const view = h("div", { class: "hist-diff" });
  const restore = h("button", { class: "tb-btn primary", type: "button", disabled: true }, "Restore this version");
  let chosen: SnapshotInfo | null = null;
  const show = async (v: SnapshotInfo) => {
    chosen = v;
    restore.disabled = false;
    list.querySelectorAll(".hist-row").forEach((r) => r.classList.toggle("on", (r as HTMLElement).dataset.id === v.id));
    clear(view);
    view.append(h("p", { class: "small" }, "Loading..."));
    const diff = await api.historyDiff(file, v.id, current());
    clear(view);
    const changed = diff.filter((l) => l.tag !== " ").length;
    view.append(h("p", { class: "small" }, changed ? `Compared with what you have now: lines in red are in this version only, lines in green are in your current text.` : "This version is the same as your current text."));
    for (const part of collapseDiff(diff)) {
      if ("skipped" in part) view.append(h("div", { class: "d-skip" }, `${part.skipped} unchanged line${part.skipped === 1 ? "" : "s"}`));
      else view.append(h("div", { class: `d-line d${part.tag === "+" ? "add" : part.tag === "-" ? "del" : "same"}` }, part.text || " "));
    }
  };
  if (!versions.length) list.append(h("p", { class: "small" }, "No earlier versions yet. One is kept each time the chapter is saved."));
  versions.forEach((v, i) => {
    list.append(
      h(
        "button",
        { class: "hist-row", type: "button", "data-id": v.id, onClick: () => void show(v) },
        h("span", { class: "when" }, when(v.time), i === 0 ? h("em", {}, " latest") : null),
        h("span", { class: "what" }, v.label),
        h("span", { class: "meta" }, `${v.words} words`),
      ),
    );
  });
  restore.addEventListener("click", async () => {
    if (!chosen) return;
    const text = await api.historyRestore(file, chosen.id);
    close();
    onRestore(text);
  });
  box.append(
    h("h3", {}, `Version history: ${name}`),
    h("div", { class: "hist-body" }, list, view),
    h("div", { class: "row" }, h("span", { class: "small grow" }, "Restoring keeps the text you have now in the history too."), h("button", { class: "tb-btn", type: "button", onClick: () => close() }, "Close"), restore),
  );
  if (versions[0]) void show(versions[0]);
}
