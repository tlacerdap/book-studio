// The print report: progress while the PDF is made, then what the checker found, each problem a click away from its chapter.

import type { PrintOutcome, PrintProgress } from "../shared/api.ts";
import { clear, h } from "./dom.ts";

export interface ReportHooks {
  onOpenProblem(chapter: string | null, page: number | null): void;
  onOpenPdf(path: string): void;
  onReveal(path: string): void;
  onClose(): void;
}

const STAGES: { id: PrintProgress["stage"]; label: string }[] = [
  { id: "preparing", label: "Saving and preparing the book" },
  { id: "laying-out", label: "Laying out the pages" },
  { id: "checking", label: "Checking the PDF" },
];

export class ReportPanel {
  constructor(
    private root: HTMLElement,
    private hooks: ReportHooks,
    private chapterTitle: (file: string) => string,
  ) {}

  hide(): void {
    this.root.hidden = true;
  }

  progress(stage: PrintProgress["stage"]): void {
    this.root.hidden = false;
    clear(this.root);
    const at = STAGES.findIndex((s) => s.id === stage);
    this.root.append(
      h("h2", {}, "Making the PDF"),
      h("p", { class: "sum" }, "This takes about half a minute for a whole book."),
      h("ul", { class: "steps" }, ...STAGES.map((s, i) => h("li", { class: i < at ? "done" : i === at ? "now" : "" }, s.label))),
    );
  }

  result(o: PrintOutcome): void {
    this.root.hidden = false;
    clear(this.root);
    if (o.error || !o.report) {
      this.root.append(h("h2", {}, "The PDF could not be made"), h("p", { class: "sum bad" }, o.error ?? "Something went wrong."), this.actions(null));
      return;
    }
    const problems = o.problems ?? [];
    this.root.append(
      h("h2", {}, o.ok ? "PDF ready" : "PDF made, with problems"),
      h(
        "p",
        { class: `sum ${o.ok ? "good" : "bad"}` },
        `${o.pages} pages, ${o.chapters} chapter${o.chapters === 1 ? "" : "s"}. ${o.ok ? "Every check passed." : `${problems.length} problem${problems.length === 1 ? "" : "s"} in ${o.report.failures} check${o.report.failures === 1 ? "" : "s"}.`}`,
      ),
    );
    const byCheck = new Map<string, typeof problems>();
    for (const p of problems) byCheck.set(p.check, [...(byCheck.get(p.check) ?? []), p]);
    for (const [check, list] of byCheck) {
      this.root.append(h("div", { class: "group" }, check));
      for (const p of list) {
        const where = [p.chapter ? this.chapterTitle(p.chapter) : null, p.page ? `PDF page ${p.page}` : null].filter(Boolean).join(", ");
        this.root.append(
          h("button", { class: "problem", type: "button", title: p.chapter ? "Open this chapter" : "", onClick: () => this.hooks.onOpenProblem(p.chapter, p.page) }, where ? h("span", { class: "where" }, where) : null, p.text),
        );
      }
    }
    const counted = o.report.results.filter((r) => r.status !== "info");
    const passed = counted.filter((r) => r.status === "pass").length;
    this.root.append(h("p", { class: "passed" }, `${passed} of ${counted.length} checks passed. Line length: ${Math.round(o.report.measure)} characters.`), this.actions(o.pdf ?? null));
  }

  private actions(pdf: string | null): HTMLElement {
    return h(
      "div",
      { class: "actions" },
      pdf ? h("button", { class: "tb-btn primary", type: "button", onClick: () => this.hooks.onOpenPdf(pdf) }, "Open PDF") : null,
      pdf ? h("button", { class: "tb-btn", type: "button", onClick: () => this.hooks.onReveal(pdf) }, "Show in folder") : null,
      h("button", { class: "tb-btn", type: "button", onClick: () => this.hooks.onClose() }, "Close"),
    );
  }
}
