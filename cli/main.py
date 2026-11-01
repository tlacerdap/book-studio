"""book-studio command line.

    uv run book-studio pdf   /path/to/book                 build build/<output>.pdf
    uv run book-studio pdf   /path/to/book --chapters 0-3  quick preview of a subset
    uv run book-studio check /path/to/book                 typographic and ink checks on that PDF
    uv run book-studio lint  /path/to/book                 the author's chapter lint (book-specific rules)

A book is a folder with a book.yaml. Run these from the book-studio folder, or pass
`--project /path/to/book-studio` to `uv run` from anywhere.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from bookcore.native import ensure_native_libs


def _book(path: str):
    from bookcore import ConfigError, load_book

    try:
        return load_book(path)
    except ConfigError as exc:
        sys.exit(f"book-studio: {exc}")


def cmd_pdf(args: argparse.Namespace) -> int:
    from bookcore.pdf import BuildError, build_pdf
    from bookcore.workflow import print_book

    book = _book(args.book)
    try:
        if args.check:
            res = print_book(book, args.chapters, args.out, args.extra_css)
            built = res.build
        else:
            built = build_pdf(book, args.chapters, args.out, args.html, args.extra_css)
    except (BuildError, RuntimeError) as exc:
        sys.exit(f"book-studio: {exc}")
    print(f"{built.pdf}  ({built.pages} pages, {built.chapters} chapters)")
    if args.check:
        print()
        print(res.report.format())
        return 0 if res.report.ok else 1
    return 0


def cmd_check(args: argparse.Namespace) -> int:
    from bookcore.check import run_checks

    book = _book(args.book)
    pdf = args.pdf or book.output_pdf
    if not pdf.is_file():
        sys.exit(f"book-studio: {pdf} does not exist. Build it first: book-studio pdf {args.book}")
    report = run_checks(
        pdf, book, args.extra_css,
        min_lines=args.min_lines, min_code_lines=args.min_code_lines, short_code=args.short_code,
        ink_factor=args.ink_factor, ink_max=args.ink_max, gap=args.gap, samples=args.samples,
    )
    print(report.format())
    return 0 if report.ok else 1


def cmd_lint(args: argparse.Namespace) -> int:
    import os
    import runpy

    book = _book(args.book)
    script = Path(__file__).resolve().parents[1] / "extras" / "lint_chapters.py"
    os.environ["BOOK_DIR"] = str(book.root)
    sys.argv = [str(script), *args.files]
    try:
        runpy.run_path(str(script), run_name="__main__")
    except SystemExit as exc:
        return int(exc.code or 0)
    return 0


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="book-studio", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="command", required=True)

    p = sub.add_parser("pdf", help="build the book's PDF")
    p.add_argument("book", help="the book folder (contains book.yaml)")
    p.add_argument("--chapters", nargs="+", metavar="SPEC", help="subset: numbers (0 1 5), ranges (0-3), commas, or file names")
    p.add_argument("--out", type=Path, help="output PDF (default: <book>/build/<output>.pdf)")
    p.add_argument("--html", type=Path, help="also write the generated HTML here (debugging)")
    p.add_argument("--extra-css", type=Path, action="append", default=[], metavar="FILE", help="stylesheet applied last, to try a tweak (repeatable)")
    p.add_argument("--check", action="store_true", help="run the checker on the result and print its report (exit 1 on failures)")
    p.set_defaults(func=cmd_pdf)

    c = sub.add_parser("check", help="typographic and ink checks on the built PDF")
    c.add_argument("book", help="the book folder (contains book.yaml)")
    c.add_argument("pdf", nargs="?", type=Path, help="PDF to check (default: <book>/build/<output>.pdf)")
    c.add_argument("--extra-css", type=Path, action="append", default=[], metavar="FILE", help="the same extra stylesheets the PDF was built with")
    c.add_argument("--min-lines", type=int, default=3, help="fewest paragraph lines allowed at a page top or bottom (default 3)")
    c.add_argument("--min-code-lines", type=int, default=4, help="fewest code lines on either side of a split (default 4)")
    c.add_argument("--short-code", type=int, default=15, help="code blocks up to this many lines must not split (default 15)")
    c.add_argument("--ink-factor", type=float, default=1.8, help="flag pages darker than this multiple of the median (default 1.8)")
    c.add_argument("--ink-max", type=float, default=0.14, help="flag pages with mean darkness above this (default 0.14)")
    c.add_argument("--gap", type=float, default=0.25, help="report pages ending with more than this share of the text area empty (default 0.25)")
    c.add_argument("--samples", type=Path, help="write PNGs of sample pages (cover, contents, opener, code, list) here")
    c.set_defaults(func=cmd_check)

    l = sub.add_parser("lint", help="chapter lint with the rules of the AI Engineer Field Guide style guide")
    l.add_argument("book", help="the book folder (contains book.yaml)")
    l.add_argument("files", nargs="*", help="chapter files (default: all)")
    l.set_defaults(func=cmd_lint)
    return ap


def main() -> None:
    ensure_native_libs()
    args = build_parser().parse_args()
    sys.exit(args.func(args))


if __name__ == "__main__":
    main()
