"""Print PDF: build the book, check it, report. Used by the command line and by the app."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .check import CheckReport, run_checks
from .config import BookConfig
from .pdf import BuildResult, build_pdf


@dataclass
class PrintResult:
    build: BuildResult
    report: CheckReport

    @property
    def pdf(self) -> Path:
        return self.build.pdf


def print_book(book: BookConfig, chapters: list[str] | None = None, out: Path | None = None, extra_css: list[Path] | tuple[Path, ...] = ()) -> PrintResult:
    """Build to <book>/build/<output>.pdf (or `out`), then run the checker on what was built."""
    built = build_pdf(book, chapters=chapters, out=out, extra_css=extra_css)
    return PrintResult(built, run_checks(built.pdf, book, extra_css))
