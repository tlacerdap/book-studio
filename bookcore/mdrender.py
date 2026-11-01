"""Markdown to HTML for the print and reading views.

The rules here are about typography and page breaks, not about any one book:
 - curly quotes and real ellipses, but `--` and `---` are left exactly as written
 - bare URLs wrapped so they can break anywhere
 - links to other chapters become in-document links when the target is in this build, and plain
   text when it is not (a preview build, or a chapter that is not written yet)
 - the sentence that introduces a list or code block is flagged to stay on the same page
 - code highlighted with Pygments token classes only; the look is in styles/book.css
"""

from __future__ import annotations

import re
from math import ceil

from markdown_it import MarkdownIt
from markdown_it.token import Token
from mdit_py_plugins.footnote import footnote_plugin
from mdit_py_plugins.front_matter import front_matter_plugin
from pygments import highlight
from pygments.formatters import HtmlFormatter
from pygments.lexers import TextLexer, get_lexer_by_name
from pygments.util import ClassNotFound

# Code blocks up to this many visible (non-blank, wrapped) lines stay on one page; longer ones may split.
SHORT_CODE_LINES = 15
# Rough number of monospace columns per line, used only to estimate wrapped line counts.
CODE_COLUMNS = 77
# A split code block keeps at least this many visible (non-blank) lines on each side.
MIN_CODE_VISIBLE = 4

# A paragraph shorter than this (about three lines) after a heading is kept with the next block.
SHORT_PARAGRAPH_CHARS = 210

URL_RE = re.compile(r"https?://[^\s<>()\[\]]+[^\s<>()\[\].,;:!?'\"’”]")


# ---------------------------------------------------------------------------------------
# Markdown
# ---------------------------------------------------------------------------------------


def _ellipsis_rule(state) -> None:
    """Typographic ellipsis. markdown-it's own `replacements` rule is left off because it
    would also turn `--` and `---` into en and em dashes, and the book uses plain hyphens."""
    for block in state.tokens:
        if block.type != "inline" or not block.children:
            continue
        for tok in block.children:
            if tok.type == "text" and "..." in tok.content:
                tok.content = tok.content.replace("...", "…")


def _wrap_urls_rule(state) -> None:
    """Wrap bare URLs in a span so CSS can let them break anywhere."""
    for block in state.tokens:
        if block.type != "inline" or not block.children:
            continue
        out: list[Token] = []
        in_link = 0
        for tok in block.children:
            if tok.type == "link_open":
                in_link += 1
            elif tok.type == "link_close":
                in_link -= 1
            if tok.type != "text" or in_link or not URL_RE.search(tok.content):
                out.append(tok)
                continue
            pos = 0
            for m in URL_RE.finditer(tok.content):
                if m.start() > pos:
                    t = Token("text", "", 0)
                    t.content = tok.content[pos : m.start()]
                    out.append(t)
                o = Token("html_inline", "", 0)
                o.content = '<span class="url">'
                out.append(o)
                t = Token("text", "", 0)
                t.content = m.group(0)
                out.append(t)
                c = Token("html_inline", "", 0)
                c.content = "</span>"
                out.append(c)
                pos = m.end()
            if pos < len(tok.content):
                t = Token("text", "", 0)
                t.content = tok.content[pos:]
                out.append(t)
        block.children = out


def _lines_for_visible(lines: list[str]) -> int:
    """How many lines from the start of `lines` it takes to include MIN_CODE_VISIBLE non-blank ones."""
    seen = 0
    for i, line in enumerate(lines, 1):
        seen += bool(line.strip())
        if seen >= MIN_CODE_VISIBLE:
            return i
    return len(lines)


def chapter_id(file_name: str) -> str:
    """Anchor id for a chapter file, for example `ch-01-ch01-python-for-ai-engineering`."""
    stem = file_name.rsplit(".", 1)[0].lower()
    return "ch-" + re.sub(r"[^a-z0-9]+", "-", stem).strip("-")


def make_markdown(built_files: set[str]) -> MarkdownIt:
    md = MarkdownIt("commonmark", {"typographer": True, "html": False}).enable(["table", "strikethrough"])
    md.use(front_matter_plugin).use(footnote_plugin)
    md.enable("smartquotes")  # curly quotes and apostrophes; `replacements` stays off on purpose
    md.core.ruler.push("book_ellipsis", _ellipsis_rule)
    md.core.ruler.push("book_urls", _wrap_urls_rule)
    md.core.ruler.push("book_links", _make_link_rule(built_files))
    md.core.ruler.push("book_keep_with_next", _keep_with_next_rule)

    formatter = HtmlFormatter(nowrap=True)  # token classes only; the look is in book.css

    def fence(self, tokens, idx, options, env):
        tok = tokens[idx]
        lang = tok.info.strip().split(maxsplit=1)[0] if tok.info.strip() else ""
        try:
            lexer = get_lexer_by_name(lang) if lang else TextLexer()
        except ClassNotFound:
            lexer = TextLexer()
        code = tok.content.rstrip("\n")
        # Visible lines only: blank lines inside code do not make a block "long".
        lines = sum(ceil(len(line) / CODE_COLUMNS) for line in code.split("\n") if line.strip())
        size = "short" if lines <= SHORT_CODE_LINES else "long"
        # Exact orphans/widows for this block: enough lines at each end to include MIN_CODE_VISIBLE
        # visible lines, however many blank lines the code has there.
        src = code.split("\n")
        orphans = _lines_for_visible(src)
        widows = _lines_for_visible(src[::-1])
        tiny = sum(1 for line in src if line.strip()) <= 2
        body = highlight(code, lexer, formatter).rstrip("\n")
        cls = f"code code-{size}" + (" lead-in" if tiny else "")
        return f'<pre class="{cls}" style="orphans:{orphans};widows:{widows}" data-lang="{lang or "text"}"><code>{body}</code></pre>\n'

    md.add_render_rule("fence", fence)
    md.add_render_rule("code_block", fence)

    def paragraph_open(self, tokens, idx, options, env):
        tok = tokens[idx]
        if tok.meta.get("lead_in"):
            tok.attrJoin("class", "lead-in")
        return self.renderToken(tokens, idx, options, env)

    md.add_render_rule("paragraph_open", paragraph_open)

    def list_open(self, tokens, idx, options, env):
        if tokens[idx].meta.get("lead_in"):
            tokens[idx].attrJoin("class", "lead-in")
        return self.renderToken(tokens, idx, options, env)

    for rule in ("bullet_list_open", "ordered_list_open", "list_item_open"):
        md.add_render_rule(rule, list_open)

    def link_open(self, tokens, idx, options, env):
        tok = tokens[idx]
        if tok.meta.get("drop"):
            return ""
        return self.renderToken(tokens, idx, options, env)

    def link_close(self, tokens, idx, options, env):
        if tokens[idx].meta.get("drop"):
            return ""
        return "</a>"

    md.add_render_rule("link_open", link_open)
    md.add_render_rule("link_close", link_close)
    return md


def _make_link_rule(built_files: set[str]):
    """Links to chapter files (relative `.md` paths): in-document links when the target is in this
    build, plain text when it is not. External links get a class so print can show the address."""

    def rule(state) -> None:
        for block in state.tokens:
            if block.type != "inline" or not block.children:
                continue
            stack: list[Token] = []
            for tok in block.children:
                if tok.type == "link_open":
                    stack.append(tok)
                    href = tok.attrGet("href") or ""
                    target = href.split("#")[0]
                    if target.endswith(".md") and "://" not in target:
                        name = target.rsplit("/", 1)[-1]
                        if name in built_files:
                            tok.attrSet("href", "#" + chapter_id(name))
                            tok.attrJoin("class", "xref")
                        else:
                            tok.meta["drop"] = True
                    elif href.startswith("http"):
                        tok.attrJoin("class", "ext")
                elif tok.type == "link_close" and stack:
                    opener = stack.pop()
                    if opener.meta.get("drop"):
                        tok.meta["drop"] = True

    return rule


def _keep_with_next_rule(state) -> None:
    """Flag the sentence that introduces a list or a code block so CSS keeps it on the same page
    as what follows. When the sentence is the last paragraph of a list item and the code block
    comes after the list, the enclosing list item and list are flagged too, because WeasyPrint
    does not propagate `break-after: avoid` from a last child to its parent."""
    toks = state.tokens
    for i, tok in enumerate(toks):
        if tok.type != "paragraph_open" or i + 3 >= len(toks):
            continue
        nxt = toks[i + 3]
        # A short paragraph straight after a heading would leave the heading with fewer than three
        # lines of text before a page break, so it stays with whatever comes next.
        if i and toks[i - 1].type == "heading_close" and len(toks[i + 1].content) < SHORT_PARAGRAPH_CHARS:
            tok.meta["lead_in"] = True
        if nxt.type in ("bullet_list_open", "ordered_list_open"):
            tok.meta["lead_in"] = True
        elif toks[i + 1].content.rstrip().endswith(":"):
            j = i + 3
            closers = []
            while j < len(toks) and toks[j].type in ("list_item_close", "bullet_list_close", "ordered_list_close"):
                closers.append(toks[j])
                j += 1
            if j < len(toks) and toks[j].type in ("fence", "code_block"):
                tok.meta["lead_in"] = True
                for close in closers:
                    opener = next(
                        t for t in reversed(toks[:i]) if t.type == close.type.replace("_close", "_open") and t.level == close.level
                    )
                    opener.meta["lead_in"] = True

