"""A book as a list of chapters: reading them, grouping them into Parts, assembling the HTML."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape
from markdown_it import MarkdownIt

from .config import BookConfig
from .mdrender import chapter_id, make_markdown
from .notes import strip_notes
from .paths import TEMPLATES

ROMAN = ["0", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"]
# "Chapter 3 - Title" or "Appendix A - Title" at the top of a chapter file is split into a label and a title.
TITLE_RE = re.compile(r"^((?:Chapter|Appendix) [\w.]+) - (.+)$")
# The line under a chapter title, if it has this shape, becomes the small level/priority line.
META_RE = re.compile(r"^Level: \[(.+?)\] \| Priority: \[(.+?)\]$")


@dataclass
class Chapter:
    file: str
    id: str
    label: str
    title_html: str
    title_text: str
    level: str
    priority: str
    body_html: str
    part_number: int | None = None
    part_label: str = ""
    part_name: str = ""
    part_id: str = ""
    part_opens: bool = False


def file_number(name: str) -> int | None:
    """The leading number of a chapter file name (`07-ch07-data.md` is 7), used to order and select."""
    m = re.match(r"\d+", name)
    return int(m.group(0)) if m else None


def read_index(book: BookConfig) -> dict[int, tuple[int, str]]:
    """{chapter file number: (part number, part name)} from the book's index file, if it has one."""
    path = book.index_file
    mapping: dict[int, tuple[int, str]] = {}
    if not path or not path.exists():
        return mapping
    part: tuple[int, str] | None = None
    for line in path.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^## Part ([0IVX]+) - (.+?)\s*(\(.*\))?$", line)
        if m:
            roman = m.group(1)
            part = (0 if roman == "0" else _roman_to_int(roman), m.group(2))
            continue
        if line.startswith("## "):
            part = None
            continue
        m = re.match(r"^\*\*Chapter (\d+)(?:\.\d+)? - ", line)
        if m and part:
            mapping[int(m.group(1))] = part
    return mapping


def _roman_to_int(s: str) -> int:
    values = {"I": 1, "V": 5, "X": 10}
    total = 0
    for a, b in zip(s, s[1:] + " "):
        total += -values[a] if values.get(b, 0) > values[a] else values[a]
    return total


def select_chapters(book: BookConfig, spec: list[str] | None) -> list[Path]:
    """All chapter files, or the subset named by `spec`: numbers (7), ranges (0-3), commas, file names."""
    files = book.chapter_files()
    if not spec:
        return files
    wanted: set[Path] = set()
    for item in ",".join(spec).split(","):
        item = item.strip()
        if not item:
            continue
        if re.fullmatch(r"\d+", item):
            nums = {int(item)}
        elif m := re.fullmatch(r"(\d+)-(\d+)", item):
            nums = set(range(int(m.group(1)), int(m.group(2)) + 1))
        else:
            hits = [f for f in files if f.name == Path(item).name or f.match(item)]
            if not hits:
                raise ValueError(f"no chapter matches {item!r}")
            wanted.update(hits)
            continue
        hits = [f for f in files if file_number(f.name) in nums]
        if not hits:
            raise ValueError(f"no chapter file for {item!r}")
        wanted.update(hits)
    return [f for f in files if f in wanted]


def load_chapter(path: Path, md: MarkdownIt) -> Chapter:
    tokens = md.parse(strip_notes(path.read_text(encoding="utf-8")), {})
    h1 = next((i for i, t in enumerate(tokens) if t.type == "heading_open" and t.tag == "h1"), None)
    if h1 is None:
        raise ValueError(f"{path.name} has no `# ` title line")
    raw_title = tokens[h1 + 1].content
    m = TITLE_RE.match(raw_title)
    label, title_src = (m.group(1), m.group(2)) if m else ("", raw_title)
    # Re-parse only the title text so smart quotes and inline code are handled the same way.
    title_children = md.parseInline(title_src, {})[0].children or []
    title_html = md.renderer.renderInline(title_children, md.options, {})
    title_text = "".join(t.content for t in title_children if t.type in ("text", "code_inline"))
    del tokens[h1 : h1 + 3]

    level = priority = ""
    if h1 < len(tokens) and tokens[h1].type == "paragraph_open":
        meta = META_RE.match(tokens[h1 + 1].content)
        if meta:
            level, priority = meta.groups()
            del tokens[h1 : h1 + 3]

    return Chapter(
        file=path.name,
        id=chapter_id(path.name),
        label=label,
        title_html=title_html,
        title_text=title_text,
        level=level,
        priority=priority,
        body_html=md.renderer.render(tokens, md.options, {}),
    )


def assign_parts(chapters: list[Chapter], mapping: dict[int, tuple[int, str]]) -> None:
    previous: int | None = None
    for ch in chapters:
        n = file_number(ch.file)
        entry = mapping.get(n) if n is not None else None
        if not entry:
            continue
        number, name = entry
        ch.part_number, ch.part_name = number, name
        ch.part_label = f"Part {ROMAN[number]}" if number < len(ROMAN) else f"Part {number}"
        ch.part_id = f"part-{number}"
        ch.part_opens = number != previous
        previous = number


def read_chapters(book: BookConfig, files: list[Path]) -> list[Chapter]:
    md = make_markdown({f.name for f in files})
    chapters = [load_chapter(f, md) for f in files]
    assign_parts(chapters, read_index(book))
    return chapters


def build_html(book: BookConfig, chapters: list[Chapter], css: str) -> str:
    """The whole book as one HTML document. The CSS is inlined as author-level styles: stylesheets
    handed to WeasyPrint's render() are user-level and would lose to it."""
    env = Environment(loader=FileSystemLoader(TEMPLATES), autoescape=select_autoescape(["j2"], default=True))
    meta = {
        "title": book.title,
        "subtitle": book.subtitle,
        "author": book.author,
        "date": book.date,
        "language": book.language,
    }
    return env.get_template("base.html.j2").render(book=meta, chapters=chapters, css=css)
