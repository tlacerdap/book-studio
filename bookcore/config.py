"""Read and validate a book's book.yaml."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import yaml

BOOK_FILE = "book.yaml"

# key -> (required, default). Anything else in the file is rejected, so a typo cannot pass silently.
_KEYS: dict[str, tuple[bool, object]] = {
    "title": (True, None),
    "subtitle": (False, ""),
    "author": (False, ""),
    "date": (False, ""),
    "language": (False, "en"),
    "chapters": (False, "chapters/*.md"),
    "output": (False, "book"),
    "index": (False, None),
}

TEMPLATE = """\
# book.yaml: the settings that belong to this book. Everything else (layout, fonts, page rules)
# is book-studio's. Paths are relative to this file.

title: {title}
subtitle: ""
author: ""
date: ""              # printed on the cover as written, for example "November 1, 2026"
language: en          # sets hyphenation and the document language

chapters: "{chapters}"  # glob for the chapter files; they are ordered by file name
output: {output_q}      # the PDF is written to build/<output>.pdf

# index: INDEX.md     # optional. A markdown file whose "## Part X - Name" headings and
                      # "**Chapter N - Title**" lines group chapters into Parts in the contents.
"""


class ConfigError(Exception):
    """book.yaml is missing or invalid. The message is written for the person who owns the book."""


@dataclass(frozen=True)
class BookConfig:
    root: Path
    title: str
    subtitle: str = ""
    author: str = ""
    date: str = ""
    language: str = "en"
    chapters: str = "chapters/*.md"
    output: str = "book"
    index: str | None = None

    def chapter_files(self) -> list[Path]:
        return sorted(p for p in self.root.glob(self.chapters) if p.is_file())

    @property
    def build_dir(self) -> Path:
        return self.root / "build"

    @property
    def output_pdf(self) -> Path:
        return self.build_dir / f"{self.output}.pdf"

    @property
    def index_file(self) -> Path | None:
        return (self.root / self.index) if self.index else None

    @property
    def css_override(self) -> Path | None:
        """A book may layer its own book.css over the default styles. Absent means default only."""
        p = self.root / "book.css"
        return p if p.is_file() else None


def is_book(folder: Path) -> bool:
    return (Path(folder) / BOOK_FILE).is_file()


def load_book(folder: str | Path) -> BookConfig:
    root = Path(folder).expanduser().resolve()
    if not root.is_dir():
        raise ConfigError(f"{root} is not a folder.")
    path = root / BOOK_FILE
    if not path.is_file():
        raise ConfigError(f"{root} is not a book: there is no {BOOK_FILE} in it.")
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as exc:
        raise ConfigError(f"{path} is not valid YAML: {exc}") from exc
    if not isinstance(data, dict):
        raise ConfigError(f"{path} must be a list of `key: value` settings.")
    unknown = sorted(set(data) - set(_KEYS))
    if unknown:
        raise ConfigError(f"{path}: unknown setting(s) {', '.join(unknown)}. Known: {', '.join(_KEYS)}.")
    values: dict[str, object] = {}
    for key, (required, default) in _KEYS.items():
        if key in data and data[key] is not None:
            values[key] = str(data[key])
        elif required:
            raise ConfigError(f"{path}: `{key}` is required.")
        else:
            values[key] = default
    out = str(values["output"]).strip()
    values["output"] = out[:-4] if out.lower().endswith(".pdf") else out
    if not values["output"] or "/" in str(values["output"]):
        raise ConfigError(f"{path}: `output` must be a plain file name such as `my-book`.")
    return BookConfig(root=root, **values)  # type: ignore[arg-type]


def write_default_book_yaml(folder: str | Path, title: str | None = None) -> Path:
    """Create a starter book.yaml in a folder that does not have one (the app offers this)."""
    root = Path(folder).expanduser().resolve()
    path = root / BOOK_FILE
    if path.exists():
        raise ConfigError(f"{path} already exists.")
    has_dir = (root / "chapters").is_dir()
    text = TEMPLATE.format(
        title=json.dumps(title or root.name.replace("-", " ").replace("_", " ").title(), ensure_ascii=False),
        chapters="chapters/*.md" if has_dir else "*.md",
        output_q=json.dumps(root.name, ensure_ascii=False),
    )
    path.write_text(text, encoding="utf-8")
    return path
