"""Note comments in chapter markdown (`<!-- Q: ... -->`, `%%E: ...%%`, and so on).

The Python engine only needs to keep them off the page. Reading and editing notes is done by the TypeScript core
(core/notes.ts); this is the same detection, kept short: one note per line or per multi-line comment, and nothing
inside fenced code counts.
"""

from __future__ import annotations

import re

_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")
_KIND = re.compile(r"^(?:[QEA]\s*:\s?.*|\?)$", re.S)
_SYNTAX = (("<!--", "-->"), ("%%", "%%"))
_MAX_SPAN = 40


def _note_at(lines: list[str], i: int, in_fence: list[bool]) -> int | None:
    """If a note starts on line i, return the index of its last line."""
    text = lines[i].strip()
    for opener, closer in _SYNTAX:
        if not text.startswith(opener):
            continue
        rest = text[len(opener):]
        close_at = rest.find(closer)
        if close_at != -1:
            if close_at + len(closer) == len(rest) and _KIND.match(rest[:close_at].strip()):
                return i
            continue
        for j in range(i + 1, min(len(lines), i + _MAX_SPAN)):
            if in_fence[j]:
                break
            tj = lines[j].strip()
            k = tj.find(closer)
            if k == -1:
                continue
            if k + len(closer) == len(tj):
                inner = "\n".join([rest, *[l.strip() for l in lines[i + 1:j]], tj[:k]]).strip()
                if _KIND.match(inner):
                    return j
            break
    return None


def strip_notes(text: str) -> str:
    lines = text.splitlines(keepends=True)
    bare = [l.rstrip("\r\n") for l in lines]
    in_fence = [False] * len(lines)
    fence: tuple[str, int] | None = None
    for i, line in enumerate(bare):
        m = _FENCE.match(line)
        if fence:
            in_fence[i] = True
            if m and m.group(1)[0] == fence[0] and len(m.group(1)) >= fence[1] and not m.group(2).strip():
                fence = None
        elif m and not (m.group(1)[0] == "`" and "`" in m.group(2)):
            in_fence[i] = True
            fence = (m.group(1)[0], len(m.group(1)))
    drop: set[int] = set()
    i = 0
    while i < len(bare):
        if not in_fence[i]:
            end = _note_at(bare, i, in_fence)
            if end is not None:
                drop.update(range(i, end + 1))
                i = end
        i += 1
    return "".join(l for k, l in enumerate(lines) if k not in drop)
