"""Typographic and ink checks on a built book PDF.

`run_checks()` returns a CheckReport; the command line prints it and the app shows it in a panel.

  1. a page ends with a heading, or a heading has fewer than 3 lines after it on the same page
  2. a page starts or ends with fewer than 3 lines of a paragraph that continues across the break
  3. a code block is split with fewer than 4 visible lines on a side, or a short block is split
  4. a sentence that introduces a list or code block is stranded at the bottom of a page
  5. a list item is split across pages
  6. contents page numbers differ from the real chapter start pages
  7. dashes (em, en) in the PDF that are not in the source chapters; colour on any page
  and information: measure (characters per line), pages that end mostly empty, darkest pages.

How lines are classified. The PDF has no structure, so lines are classified from the fonts the
stylesheet assigns (read back from its custom properties): the heading serif at heading sizes and
the body sans Semibold at H3 size are headings, the mono font at code size is code, drawn dots and
number markers mark list items, and everything else in the text area is body. A paragraph is
"split" across a page break when the next page starts with something that is not a capital, or the
last line is nearly full width and does not end a sentence. A paragraph that ends exactly at a page
break is not a split, so it is never flagged.
"""

from __future__ import annotations

import re
import statistics
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pymupdf

from .config import BookConfig
from .style import StyleMetrics, read_css, style_files

MM = 72 / 25.4
SENTENCE_END = tuple('.!?:;)"”’]')
MARKER = re.compile(r"^\d+\.$")  # ordered-list number, extracted as a line of its own

S: StyleMetrics = None  # type: ignore[assignment]  # set by run_checks() from the active stylesheet


@dataclass
class Line:
    text: str
    x0: float
    y0: float
    x1: float
    y1: float
    size: float
    kind: str  # header | footer | heading | code | body
    bullet: bool = False  # first line of a list item (drawn dot, or a number marker)


@dataclass
class Block:
    kind: str
    lines: list[Line] = field(default_factory=list)

    @property
    def text(self) -> str:
        return " ".join(l.text for l in self.lines)

    @property
    def nlines(self) -> int:
        """Visible lines (blank lines inside code are not counted)."""
        return len(self.lines)


@dataclass
class Page:
    index: int
    lines: list[Line]
    blocks: list[Block]
    label: str  # printed page number, "" if none


def classify(page: pymupdf.Page) -> list[Line]:
    height = page.rect.height
    out: list[Line] = []
    for block in page.get_text("dict")["blocks"]:
        for ln in block.get("lines", []):
            spans = [s for s in ln["spans"] if s["text"].strip()]
            if not spans:
                continue
            text = "".join(s["text"] for s in ln["spans"]).strip()
            x0, y0, x1, y1 = ln["bbox"]
            size = max(s["size"] for s in spans)
            names = [s["font"].replace("-", "").replace(" ", "") for s in spans]  # WeasyPrint writes "Source-Serif-4-..."
            mono = all(S.mono in n for n in names)
            serif = any(S.heading_serif in n for n in names)
            semibold = any("Semibold" in n or "SemiBold" in n for n in names)
            if y1 <= S.top_margin + 2:
                kind = "header"
            elif y0 >= height - S.bottom_margin - 2:
                kind = "footer"
            elif mono and abs(size - S.code_size) < 0.15:
                kind = "code"
            elif (serif and size >= (S.h2_size - 1.5)) or (semibold and size >= (S.h3_size - 0.5) and not mono):
                kind = "heading"
            else:
                kind = "body"
            out.append(Line(text, x0, y0, x1, y1, size, kind))
    out.sort(key=lambda l: (round(l.y0), l.x0))
    dots = [
        ((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2)
        for dr in page.get_drawings()
        if dr.get("fill") and abs((r := dr["rect"]).width - S.bullet_size) < 0.3 and abs(r.height - S.bullet_size) < 0.3
    ]
    for ln in out:
        if any(cx < ln.x0 and ln.y0 - 1 <= cy <= ln.y1 + 1 for cx, cy in dots):
            ln.bullet = True
    merged: list[Line] = []
    for ln in out:  # "1." arrives as its own line: fold it into the item text next to it
        if MARKER.match(ln.text) and ln.kind == "body":
            for other in out:
                if other is not ln and other.kind == "body" and abs(other.y0 - ln.y0) < 4 and other.x0 > ln.x0:
                    other.bullet = True
            continue
        merged.append(ln)
    return merged


def make_blocks(lines: list[Line]) -> list[Block]:
    """Group the text-area lines of one page into headings, code blocks and paragraphs."""
    blocks: list[Block] = []
    prev: Line | None = None
    for ln in lines:
        if ln.kind in ("header", "footer"):
            continue
        new = True
        if prev is not None and prev.kind == ln.kind and blocks:
            gap = ln.y0 - prev.y1
            if ln.kind == "code":
                new = gap > 48  # blank lines inside code leave gaps; separate blocks are rarely adjacent
            elif ln.kind == "heading":
                new = gap > 4 or abs(ln.size - prev.size) > 0.5
            else:
                new = gap > 7.5 or ln.bullet
        if new:
            blocks.append(Block(ln.kind))
        blocks[-1].lines.append(ln)
        prev = ln
    return blocks


def load_pages(doc: pymupdf.Document) -> list[Page]:
    pages = []
    for i, p in enumerate(doc):
        lines = classify(p)
        foot = [l.text for l in lines if l.kind == "footer"]
        label = foot[-1] if foot else ""
        for k in range(1, len(lines) - 1):  # a line of fallback-font text (CJK, say) inside a code block
            a, ln, b = lines[k - 1], lines[k], lines[k + 1]
            if ln.kind == "body" and a.kind == "code" and b.kind == "code" and abs(ln.size - S.code_size) < 0.8:
                ln.kind = "code"
        pages.append(Page(i, lines, make_blocks(lines), label))
    return pages


# --------------------------------------------------------------------------------------
# Checks
# --------------------------------------------------------------------------------------


MEASURE_PT = 0.0  # widest body line in the book, set in main()


def is_continuation(prev_last: Line, nxt_first: Line) -> bool:
    """A paragraph continues over the break if the next page starts with something that is not a
    capital, or the last line is nearly full width and does not end a sentence. A short last line
    that ends without punctuation (a displayed formula, say) is a paragraph of its own."""
    full = (prev_last.x1 - prev_last.x0) >= 0.8 * MEASURE_PT
    return (full and not prev_last.text.endswith(SENTENCE_END)) or not nxt_first.text[:1].isupper()


def check_headings(pages: list[Page], min_after: int) -> list[str]:
    """A heading must not be the last thing on a page, and must be followed on the same page by at
    least `min_after` lines of text or code (the first lines of what it introduces)."""
    out = []
    for p in body_pages(pages):
        heads = [i for i, b in enumerate(p.blocks) if b.kind == "heading" and b.lines[0].size < S.h1_size - 2]
        if not heads:
            continue
        i = heads[-1]
        after = sum(b.nlines for b in p.blocks[i + 1 :] if b.kind != "heading")
        if p.blocks[-1].kind == "heading":
            out.append(f"page {p.index + 1} (printed {p.label or '-'}): ends with heading {p.blocks[-1].text!r}")
        elif after < min_after:
            out.append(f"page {p.index + 1} (printed {p.label or '-'}): heading {p.blocks[i].text!r} has only {after} line(s) after it")
    return out


def blank_gaps(pages: list[Page], height: float, share: float) -> list[str]:
    """Pages that end well short of the bottom margin (not counting the last page of a chapter)."""
    out = []
    body = body_pages(pages)
    area = height - S.top_margin - S.bottom_margin
    for a, b in zip(body, body[1:]):
        used = [l for l in a.lines if l.kind in ("body", "code", "heading")]
        if not used or any(bl.kind == "heading" and bl.lines[0].size >= S.h1_size - 2 for bl in b.blocks):
            continue  # empty page, or the next page opens a chapter
        gap = (height - S.bottom_margin - max(l.y1 for l in used)) / area
        if gap > share:
            out.append(f"page {a.index + 1} (printed {a.label}): {gap:.0%} of the text area is empty at the bottom")
    return out


def body_pages(pages: list[Page]) -> list[Page]:
    return [p for p in pages if p.label.isdigit()]


def check_fragments(pages: list[Page], min_lines: int) -> list[str]:
    out = []
    body = body_pages(pages)
    for a, b in zip(body, body[1:]):
        if not a.blocks or not b.blocks:
            continue
        last, first = a.blocks[-1], b.blocks[0]
        if last.kind != "body" or first.kind != "body" or last.lines[0].bullet or first.lines[0].bullet:
            continue  # list items are never split (checked separately)
        if not is_continuation(last.lines[-1], first.lines[0]):
            continue
        if last.nlines < min_lines:
            out.append(f"page {a.index + 1} (printed {a.label}): ends with {last.nlines} line(s) of a paragraph: {last.text[:70]!r}")
        if first.nlines < min_lines:
            out.append(f"page {b.index + 1} (printed {b.label}): starts with {first.nlines} line(s) of a paragraph: {first.text[:70]!r}")
    return out


def check_stranded_intro(pages: list[Page]) -> list[str]:
    """A page must not end with a sentence that introduces a list or code block (ends with a colon)."""
    out = []
    body = body_pages(pages)
    for k, p in enumerate(body):
        if p.blocks and p.blocks[-1].kind == "body" and p.blocks[-1].lines[-1].text.endswith(":"):
            nxt = body[k + 1] if k + 1 < len(body) else None
            if nxt and nxt.blocks and nxt.blocks[0].kind == "body" and not nxt.blocks[0].lines[0].text[:1].isupper():
                continue  # the sentence continues on the next page
            out.append(f"page {p.index + 1} (printed {p.label}): ends with an introducing sentence {p.blocks[-1].text[-60:]!r}")
    return out


def check_list_splits(pages: list[Page]) -> list[str]:
    """List items must not split: a page must not open with an indented, bullet-less body block
    that continues the previous page's last block."""
    out = []
    body = body_pages(pages)
    lefts = [l.x0 for p in body for l in p.lines if l.kind == "body" and l.size > 10]
    if not lefts:
        return out
    left = statistics.mode(round(x) for x in lefts)
    for a, b in zip(body, body[1:]):
        if not a.blocks or not b.blocks or a.blocks[-1].kind != "body" or b.blocks[0].kind != "body":
            continue
        first = b.blocks[0].lines[0]
        if first.x0 > left + 10 and not b.blocks[0].lines[0].bullet and is_continuation(a.blocks[-1].lines[-1], first):
            out.append(f"pages {a.index + 1}-{b.index + 1}: list item appears to continue across the break: {first.text[:60]!r}")
    return out


def check_code_splits(pages: list[Page], min_code: int, short_limit: int) -> tuple[list[str], int]:
    out, splits = [], 0
    body = body_pages(pages)
    for a, b in zip(body, body[1:]):
        if not a.blocks or not b.blocks:
            continue
        last, first = a.blocks[-1], b.blocks[0]
        if last.kind != "code" or first.kind != "code":
            continue
        splits += 1
        n1, n2 = last.nlines, first.nlines
        if n1 < min_code or n2 < min_code:
            out.append(f"pages {a.index + 1}-{b.index + 1}: code split {n1} + {n2} lines (min {min_code}): {last.lines[0].text[:50]!r}")
        elif n1 + n2 <= short_limit:
            out.append(f"pages {a.index + 1}-{b.index + 1}: short code block ({n1 + n2} lines) split {n1} + {n2}")
    return out, splits


def check_toc(doc: pymupdf.Document, pages: list[Page]) -> tuple[list[str], str]:
    """Compare contents page numbers with where each chapter really starts.

    Truth comes from two independent places: the PDF bookmark target page, and the page number
    printed in the footer of that page. The contents page text must agree with both."""
    problems = []
    bookmarks = doc.get_toc()
    entries: dict[str, int] = {}
    for p in pages:
        if not (p.label and re.fullmatch(r"[ivxlc]+", p.label)):
            continue
        found = [
            ((y0 + y1) / 2, x0, word)
            for x0, y0, x1, y1, word, *_ in doc[p.index].get_text("words")
            if S.top_margin < y1 < doc[p.index].rect.height - S.bottom_margin
        ]
        rows: list[list[tuple[float, str]]] = []
        last_y = None
        for yc, x0, word in sorted(found):
            if last_y is None or yc - last_y > 4:
                rows.append([])
            rows[-1].append((x0, word))
            last_y = yc
        for row in rows:
            words = [w for _, w in sorted(row) if set(w) != {"."}]
            if len(words) < 2 or not words[-1].isdigit():
                continue
            if words[0].lower() == "part" or words[0] == "PART":
                words = words[2:]
            elif words[0] == "Chapter":
                words = words[2:]
            entries[" ".join(words[:-1])] = int(words[-1])
    if not entries:
        return ["no contents entries found in the front matter"], ""
    marks = {t.strip(): pg for lvl, t, pg in bookmarks}
    checked = 0
    for title, printed in entries.items():
        # bookmarks of parts read "Part I Name"; chapter bookmarks are the plain title
        page_no = marks.get(title) or next((pg for t, pg in marks.items() if t.endswith(title)), None)
        if page_no is None:
            problems.append(f"contents entry {title!r} has no matching bookmark")
            continue
        real = pages[page_no - 1].label
        checked += 1
        if str(printed) != real:
            problems.append(f"contents says {title!r} is on page {printed}, but it starts on printed page {real or '?'} (pdf page {page_no})")
    if checked == 0:
        problems.append("no contents entry could be matched with a chapter")
    return problems, f"{checked} of {len(entries)} contents entries verified against bookmarks and footers"


def check_dashes(doc: pymupdf.Document, chapter_files: list[Path]) -> list[str]:
    text = "".join(p.get_text() for p in doc)
    src = "".join(f.read_text(encoding="utf-8") for f in chapter_files)
    out = []
    for ch, name in (("—", "em dash"), ("–", "en dash")):
        if text.count(ch) > src.count(ch):
            out.append(f"{text.count(ch)} {name}(s) in the PDF but {src.count(ch)} in the source")
    return out


def measure(pages: list[Page]) -> tuple[float, int]:
    widths = []
    for p in body_pages(pages):
        for b in p.blocks:
            if b.kind != "body":
                continue
            for ln in b.lines[:-1]:  # last lines of paragraphs are short
                if ln.size > 10 and len(ln.text) > 40 and not ln.bullet:
                    widths.append(len(ln.text))
    if not widths:
        return 0.0, 0
    full = [w for w in widths if w >= 0.8 * max(widths)]
    return statistics.median(full), len(full)


def ink_report(doc: pymupdf.Document, factor: float, absolute: float) -> tuple[list[tuple[int, float]], list[int], float, list[float]]:
    """Mean darkness per page (0 = white, 1 = solid black) and pages that contain colour."""
    ink, colored = [], []
    for i, p in enumerate(doc):
        pm = p.get_pixmap(dpi=60, colorspace=pymupdf.csRGB)
        a = np.frombuffer(pm.samples, dtype=np.uint8).reshape(pm.height, pm.width, 3).astype(np.int16)
        if (a.max(axis=2) - a.min(axis=2)).max() > 12:
            colored.append(i + 1)
        ink.append(1 - a.mean() / 255)
    text_pages = [v for v in ink if v > 0.02]
    median = statistics.median(text_pages) if text_pages else 0
    flagged = [(i + 1, v) for i, v in enumerate(ink) if v > max(absolute, factor * median)]
    return flagged, colored, median, ink


def pick_samples(pages: list[Page]) -> dict[str, int]:
    body = body_pages(pages)
    samples = {"cover": 0}
    toc = next((p.index for p in pages if p.label == "i"), 1)
    samples["toc"] = toc
    if body:
        samples["chapter-opening"] = body[0].index

    def share(p: Page, kind: str) -> float:
        n = len([l for l in p.lines if l.kind in ("body", "code", "heading")]) or 1
        return len([l for l in p.lines if l.kind == kind]) / n

    if body:
        samples["code-heavy"] = max(body, key=lambda p: share(p, "code")).index
        bullets = lambda p: sum(1 for b in p.blocks if b.kind == "body" and b.lines[0].bullet)
        samples["list-heavy"] = max(body, key=bullets).index
    return samples




# --------------------------------------------------------------------------------------
# Running everything
# --------------------------------------------------------------------------------------


@dataclass
class CheckResult:
    title: str
    status: str                        # "pass" | "fail" | "info" | "warn"
    problems: list[str] = field(default_factory=list)
    note: str = ""


@dataclass
class CheckReport:
    pdf: Path
    pages: int
    body_pages: int
    results: list[CheckResult]
    measure: float = 0.0
    ink_median: float = 0.0
    darkest: list[tuple[int, float]] = field(default_factory=list)
    samples: dict[str, Path] = field(default_factory=dict)

    @property
    def failures(self) -> int:
        return sum(r.status == "fail" for r in self.results)

    @property
    def ok(self) -> bool:
        return self.failures == 0

    @property
    def problem_lines(self) -> list[str]:
        return [f"{r.title}: {p}" for r in self.results if r.status == "fail" for p in r.problems]

    def format(self) -> str:
        out = [f"{self.pdf}: {self.pages} pages ({self.body_pages} numbered body pages)", ""]
        for r in self.results:
            tag = {"pass": "PASS", "info": "INFO", "warn": "WARN", "fail": f"FAIL ({len(r.problems)})"}[r.status]
            out.append(f"[{tag}] {r.title}{r.note and '  [' + r.note + ']'}")
            out += [f"    - {p}" for p in r.problems]
        flag = "" if 62 <= self.measure <= 78 else "  <- outside the 65 to 75 target"
        out.append(f"\nmeasure: median {self.measure:.0f} characters per full line{flag}")
        out.append(
            f"ink: median text page darkness {self.ink_median:.3f} (mean grey level, 0 = white); darkest pages: "
            + ", ".join(f"{pg} ({v:.3f})" for pg, v in self.darkest)
        )
        for name, path in self.samples.items():
            out.append(f"sample: {name:16s} -> {path}")
        out.append("\nRESULT: " + ("all checks passed" if self.ok else f"{self.failures} check(s) failed"))
        return "\n".join(out)


def run_checks(
    pdf: Path,
    book: BookConfig,
    extra_css: list[Path] | tuple[Path, ...] = (),
    *,
    min_lines: int = 3,
    min_code_lines: int = 4,
    short_code: int = 15,
    ink_factor: float = 1.8,
    ink_max: float = 0.14,
    gap: float = 0.25,
    samples: Path | None = None,
) -> CheckReport:
    """Check a built PDF against the book's active stylesheet and chapter sources."""
    global S, MEASURE_PT
    S = StyleMetrics.from_css(read_css(style_files(book, extra_css)))
    doc = pymupdf.open(pdf)
    pages = load_pages(doc)
    MEASURE_PT = max((l.x1 - l.x0 for p in pages for l in p.lines if l.kind == "body" and l.size > 11), default=0.0)
    n_body = len(body_pages(pages))

    def result(title: str, problems: list[str], note: str = "") -> CheckResult:
        return CheckResult(title, "fail" if problems else "pass", problems, note)

    code_problems, code_splits = check_code_splits(pages, min_code_lines, short_code)
    toc_problems, toc_note = check_toc(doc, pages)
    results = [
        result("page ends with a heading, or a heading has fewer than 3 lines after it", check_headings(pages, 3)),
        result(f"page starts or ends with fewer than {min_lines} paragraph lines", check_fragments(pages, min_lines)),
        result(f"code split with fewer than {min_code_lines} lines on a side", code_problems, f"{code_splits} split blocks"),
        result("list introducing sentence stranded at the page bottom", check_stranded_intro(pages)),
        result("list item split across pages", check_list_splits(pages)),
        result("contents page numbers match chapter start pages", toc_problems, toc_note),
        result("no em or en dashes introduced", check_dashes(doc, book.chapter_files())),
    ]
    gaps = blank_gaps(pages, doc[0].rect.height, gap)
    results.append(
        CheckResult(
            f"pages ending with more than {gap:.0%} of the text area empty: {len(gaps)} of {n_body}",
            "info" if gaps else "pass",
            gaps[:12] + ([f"... and {len(gaps) - 12} more"] if len(gaps) > 12 else []),
        )
    )
    med, _ = measure(pages)
    flagged, colored, ink_median, ink = ink_report(doc, ink_factor, ink_max)
    results.append(
        CheckResult(
            "no page has unusually high ink coverage",
            "warn" if flagged else "pass",
            [f"page {pg}: {v:.3f}" for pg, v in flagged],
        )
    )
    results.append(
        result("every page is strictly monochrome", [f"colour found on page(s) {colored[:15]}"] if colored else [])
    )
    report = CheckReport(
        pdf=Path(pdf),
        pages=len(doc),
        body_pages=n_body,
        results=results,
        measure=med,
        ink_median=ink_median,
        darkest=sorted(((i + 1, v) for i, v in enumerate(ink)), key=lambda t: -t[1])[:3],
    )
    if samples:
        samples.mkdir(parents=True, exist_ok=True)
        for name, idx in pick_samples(pages).items():
            out = samples / f"{name}.png"
            doc[idx].get_pixmap(dpi=110).save(out)
            report.samples[f"{name} (pdf page {idx + 1})"] = out
    return report
