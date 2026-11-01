"""HTML to PDF with WeasyPrint."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .book import build_html, read_chapters, select_chapters
from .config import BookConfig
from .native import import_weasyprint
from .paths import STYLES
from .style import read_css, style_files


class BuildError(Exception):
    """The book could not be built. The message says what to fix."""


@dataclass
class BuildResult:
    pdf: Path
    pages: int
    chapters: int
    html: Path | None = None


def build_pdf(
    book: BookConfig,
    chapters: list[str] | None = None,
    out: Path | None = None,
    html_out: Path | None = None,
    extra_css: list[Path] | tuple[Path, ...] = (),
) -> BuildResult:
    """Build the book (or the subset named by `chapters`) to `out`, default <book>/build/<output>.pdf."""
    try:
        files = select_chapters(book, chapters)
    except ValueError as exc:
        raise BuildError(f"--chapters: {exc}") from exc
    if not files:
        raise BuildError(f"no chapter files match `chapters: {book.chapters}` in {book.root}")
    try:
        chapter_list = read_chapters(book, files)
    except ValueError as exc:
        raise BuildError(str(exc)) from exc
    html = build_html(book, chapter_list, read_css(style_files(book, extra_css)))

    if html_out:
        html_out.parent.mkdir(parents=True, exist_ok=True)
        html_out.write_text(html, encoding="utf-8")

    weasyprint = import_weasyprint()
    from weasyprint.text.fonts import FontConfiguration

    # base_url is styles/, so the stylesheet's url(fonts/...) values find the vendored fonts.
    doc = weasyprint.HTML(string=html, base_url=str(STYLES) + "/").render(font_config=FontConfiguration())
    pdf = Path(out) if out else book.output_pdf
    pdf.parent.mkdir(parents=True, exist_ok=True)
    doc.write_pdf(str(pdf))
    return BuildResult(pdf=pdf, pages=len(doc.pages), chapters=len(chapter_list), html=html_out)
