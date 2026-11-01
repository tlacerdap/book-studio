"""Which stylesheets apply to a book, and the measurements the checker reads back from them.

The default typography is styles/book.css. A book may add its own book.css next to its book.yaml;
it is layered after the default, so it can change any custom property or rule without having to
repeat the fonts. `extra` files (from --extra-css) go last."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from .config import BookConfig
from .paths import DEFAULT_CSS

_MM = 72 / 25.4
_UNITS = {"pt": 1.0, "mm": _MM, "cm": 10 * _MM, "in": 72.0, "px": 0.75}


def style_files(book: BookConfig, extra: list[Path] | tuple[Path, ...] = ()) -> list[Path]:
    files = [DEFAULT_CSS]
    if book.css_override:
        files.append(book.css_override)
    files.extend(Path(p) for p in extra)
    return files


def read_css(files: list[Path]) -> str:
    return "\n".join(f.read_text(encoding="utf-8") for f in files)


def css_variables(css: str) -> dict[str, str]:
    """Custom properties declared in the stylesheet text; a later declaration wins."""
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    return {m.group(1): m.group(2).strip() for m in re.finditer(r"(--[\w-]+)\s*:\s*([^;{}]+);", css)}


def to_pt(value: str) -> float:
    m = re.fullmatch(r"\s*(-?[\d.]+)\s*(pt|mm|cm|in|px)\s*", value)
    if not m:
        raise ValueError(f"cannot read {value!r} as a length in pt, mm, cm, in or px")
    return float(m.group(1)) * _UNITS[m.group(2)]


def first_family(value: str) -> str:
    return value.split(",")[0].strip().strip("\"'")


@dataclass(frozen=True)
class StyleMetrics:
    """What check.py needs to recognise headings, code and the text area in the PDF."""

    top_margin: float
    bottom_margin: float
    code_size: float
    heading_serif: str        # first family of --font-heading, hyphens and spaces removed
    mono: str                 # first family of --font-mono, likewise
    h1_size: float
    h2_size: float
    h3_size: float
    bullet_size: float

    @classmethod
    def from_css(cls, css: str) -> "StyleMetrics":
        v = css_variables(css)

        def pt(name: str) -> float:
            if name not in v:
                raise ValueError(f"the stylesheet does not define {name}, which the checker needs")
            return to_pt(v[name])

        def fam(name: str) -> str:
            if name not in v:
                raise ValueError(f"the stylesheet does not define {name}, which the checker needs")
            return first_family(v[name]).replace("-", "").replace(" ", "")

        return cls(
            top_margin=pt("--margin-top"),
            bottom_margin=pt("--margin-bottom"),
            code_size=pt("--size-code"),
            heading_serif=fam("--font-heading"),
            mono=fam("--font-mono"),
            h1_size=pt("--size-h1"),
            h2_size=pt("--size-h2"),
            h3_size=pt("--size-h3"),
            bullet_size=pt("--bullet-size"),
        )
