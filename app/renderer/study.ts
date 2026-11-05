// Study mode: the book's interview questions, drill lines and your answered questions, one card at a time. Say the answer,
// reveal it, and mark whether you had it. Cards you miss come back in the same session; cards you know come back after
// longer and longer. Progress is kept on this computer, per book.

import { dueCards, INTERVALS, review, type Card, type Progress } from "../../core/study.ts";
import type { ChapterCards } from "../shared/api.ts";
import { overlay } from "./dialogs.ts";
import { clear, h } from "./dom.ts";
import { paragraphs } from "./inline.ts";

const days = (n: number): string => (n === 0 ? "this session" : n === 1 ? "1 day" : `${n} days`);
const today = (): number => Math.floor(Date.now() / 86_400_000);

function load(key: string): Record<string, Progress> {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, Progress>;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function save(key: string, progress: Record<string, Progress>): void {
  try {
    localStorage.setItem(key, JSON.stringify(progress));
  } catch {
    /* progress is a convenience */
  }
}

function shuffle<T>(list: T[]): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export interface StudyOptions {
  bookRoot: string;
  chapters: ChapterCards[];
  /** The file of the chapter that is open, for "this chapter only". */
  currentFile: string | null;
  chapterTitle(file: string): string;
  /** Jump to the question in the book. */
  onShow(file: string, line: number): void;
}

export function openStudy(opts: StudyOptions): void {
  const key = `study:${opts.bookRoot}`;
  const progress = load(key);
  const { box, close } = overlay("Study flashcards", () => {});
  box.classList.add("study");
  const all = opts.chapters.flatMap((c) => c.cards.map((card) => ({ ...card, file: c.file })));
  let scope: "all" | "chapter" = "all";
  let mix = true;
  let queue: (Card & { file: string })[] = [];
  let done = 0;
  let current: (Card & { file: string }) | null = null;
  let revealed = false;
  const body = h("div", { class: "st-body" });
  const head = h("div", { class: "st-head" });
  box.append(head, body);

  const pool = () => (scope === "chapter" && opts.currentFile ? all.filter((c) => c.file === opts.currentFile) : all);

  const start = () => {
    const due = dueCards(pool(), progress, today());
    queue = mix ? shuffle(due) : due;
    done = 0;
    next();
  };

  const next = () => {
    current = queue.shift() ?? null;
    revealed = false;
    draw();
  };

  const answer = (correct: boolean) => {
    if (!current) return;
    progress[current.id] = review(progress[current.id], correct, today());
    save(key, progress);
    if (!correct) queue.push(current);
    else done++;
    next();
  };

  const counts = () => {
    const p = pool();
    const seen = p.filter((c) => progress[c.id]);
    const known = p.filter((c) => (progress[c.id]?.box ?? 0) >= 3).length;
    return { total: p.length, fresh: p.length - seen.length, known };
  };

  const draw = () => {
    clear(head);
    clear(body);
    const c = counts();
    head.append(
      h("h3", {}, "Study"),
      h("span", { class: "grow" }),
      h(
        "select",
        { "aria-label": "Which cards", onChange: (e: Event) => { scope = (e.target as HTMLSelectElement).value as "all" | "chapter"; start(); } },
        h("option", { value: "all", selected: scope === "all" }, "Every chapter"),
        opts.currentFile ? h("option", { value: "chapter", selected: scope === "chapter" }, `Only: ${opts.chapterTitle(opts.currentFile)}`) : "",
      ),
      h("label", { class: "st-mix" }, h("input", { type: "checkbox", checked: mix, onChange: (e: Event) => { mix = (e.target as HTMLInputElement).checked; start(); } }), " Shuffle"),
      h("button", { class: "icon-btn", type: "button", "aria-label": "Close", onClick: () => close() }, "×"),
    );
    if (!c.total) {
      body.append(h("p", { class: "st-empty" }, "There are no cards yet. Cards come from the interview questions and drill lines of the chapters (the ones not marked as known), and from your own questions that Claude has answered."));
      return;
    }
    if (!current) {
      body.append(
        h("div", { class: "st-done" }, h("h4", {}, queue.length === 0 && done ? "That is all for now." : "Nothing is due."), h("p", {}, done ? `You went through ${done} card${done === 1 ? "" : "s"}. ` : "", `${c.known} of ${c.total} cards are well known. The others come back as their time comes.`)),
        h("div", { class: "row" }, h("button", { class: "tb-btn", type: "button", onClick: () => { for (const id of Object.keys(progress)) progress[id] = { ...progress[id], due: 0 }; save(key, progress); start(); } }, "Go through everything again"), h("button", { class: "tb-btn primary", type: "button", onClick: () => close() }, "Close")),
      );
      return;
    }
    const left = queue.length + 1;
    body.append(
      h("div", { class: "st-meta" }, `${left} to go`, h("span", { class: "dim" }, ` · ${opts.chapterTitle(current.file)}`), h("span", { class: "grow" }), h("button", { class: "st-link", type: "button", title: "Show this question in the book", onClick: () => { close(); opts.onShow(current!.file, current!.line); } }, "In the book")),
      h("div", { class: "st-card" }, h("div", { class: "st-label" }, current.kind === "note" ? "Your question" : "Question"), ...paragraphs(current.front)),
    );
    if (!revealed) {
      body.append(h("div", { class: "row" }, h("span", { class: "small grow" }, "Say the answer out loud first."), h("button", { class: "tb-btn primary", type: "button", onClick: () => { revealed = true; draw(); } }, "Show answer (Space)")));
      return;
    }
    body.append(
      h("div", { class: "st-card back" }, h("div", { class: "st-label" }, "Answer"), ...paragraphs(current.back), current.cue ? h("p", { class: "st-cue" }, h("b", {}, "Cue: "), current.cue) : ""),
      h(
        "div",
        { class: "row" },
        h("span", { class: "small grow" }, `If you had it, it comes back in ${days(INTERVALS[Math.min(INTERVALS.length - 1, (progress[current.id]?.box ?? 0) + 1)])}.`),
        h("button", { class: "tb-btn", type: "button", onClick: () => answer(false) }, "Missed it (1)"),
        h("button", { class: "tb-btn primary", type: "button", onClick: () => answer(true) }, "Got it (2)"),
      ),
    );
  };

  const onKey = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (!document.body.contains(box) || tag === "SELECT" || tag === "INPUT") return;
    if (!current) return;
    if (!revealed && (e.key === " " || e.key === "Enter")) {
      e.preventDefault();
      revealed = true;
      draw();
    } else if (revealed && (e.key === "1" || e.key === "ArrowLeft")) {
      e.preventDefault();
      answer(false);
    } else if (revealed && (e.key === "2" || e.key === "ArrowRight")) {
      e.preventDefault();
      answer(true);
    }
  };
  document.addEventListener("keydown", onKey);
  const observer = new MutationObserver(() => {
    if (!document.body.contains(box)) {
      document.removeEventListener("keydown", onKey);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true });
  start();
}
