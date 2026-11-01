"""bookcore: everything that turns a book folder into pages.

A book is a folder with a `book.yaml` and markdown chapters. Nothing in this package knows about a
particular book; every book-specific value comes from that folder.

    config   read and validate book.yaml
    style    which stylesheets apply, and the measurements the checker needs from them
    mdrender markdown to HTML, with the typographic and page-break rules
    book     chapters, Parts, and the assembled HTML document
    pdf      HTML to PDF (WeasyPrint)
    check    typographic and ink checks on a built PDF
    workflow build, then check (what Print PDF does)
"""

from .config import BookConfig, ConfigError, is_book, load_book, write_default_book_yaml

__all__ = ["BookConfig", "ConfigError", "is_book", "load_book", "write_default_book_yaml"]
