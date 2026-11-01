"""Mechanical checks for chapter files. Usage: book-studio lint <book folder> [files...]
(or: BOOK_DIR=<book folder> python3 extras/lint_chapters.py [files...])

BOOK-SPECIFIC. These rules (template headings, banned terms, PROGRESS.md chapter map) belong to the
AI Engineer Field Guide style guide, not to book-studio. Kept as it was; planned to become settings.


Checks: em/en dashes, markdown tables, template headings and order, tag line,
word count, bridge format, relative chapter links, banned glossary variants.
"""

import os
import re
import sys
from pathlib import Path

ROOT = Path(os.environ.get("BOOK_DIR", ".")).resolve()
CHAPTERS = ROOT / "chapters"

HEADINGS = [
    "Why this matters",
    "Core concepts",
    "In practice",
    "Common mistakes",
    "Interview angle",
    "Key takeaways",
    "Go deeper",
]

# variant -> canonical (case-sensitive substring checks on prose, code blocks stripped)
BANNED = {
    "LLM judge": "LLM-as-a-judge",
    "LLM as a judge": "LLM-as-a-judge",
    "vector DB": "vector database",
    "vectordb": "vector database",
    "function calling": "tool calling",
    "open source model": "open-weights model",
    "Langgraph": "LangGraph",
    "Langchain": "LangChain",
    "Fastapi": "FastAPI",
    "PGVector": "pgvector",
    "Prompt Engineering": "prompt engineering",
    "evals ": "evaluation (or 'eval suite')",
}

FENCE = re.compile(r"```.*?```", re.S)


def strip_code(text: str) -> str:
    return FENCE.sub("", text)


def check(path: Path) -> list[str]:
    text = path.read_text(encoding="utf-8")
    prose = strip_code(text)
    problems: list[str] = []

    words = len(text.split())
    if not 1900 <= words <= 4100:
        problems.append(f"word count {words} outside 2,000-4,000 (tolerance 100)")

    for ch, name in (("\u2014", "em dash"), ("\u2013", "en dash")):
        n = text.count(ch)
        if n:
            problems.append(f"{n} {name}(s)")

    if re.search(r"^\s*\|.*\|\s*$", prose, re.M):
        problems.append("markdown table detected")

    lines = text.splitlines()
    in_fence = False
    for i, line in enumerate(lines, 1):
        if line.lstrip().startswith("```"):
            if not in_fence and line.strip() == "```":
                problems.append(f"line {i}: code fence without a language tag (use text for output)")
            in_fence = not in_fence
    if not lines or not re.match(r"^# Chapter [\d.]+ - ", lines[0]):
        problems.append("H1 must start with '# Chapter N - '")
    tag = next((l for l in lines[1:6] if l.startswith("Level:")), None)
    if not tag or not re.match(r"^Level: \[[BIA]( to [BIA])?\] \| Priority: \[(Core|Plus)\]$", tag):
        problems.append(f"bad tag line: {tag!r}")

    h2 = re.findall(r"^## (.+)$", prose, re.M)
    if h2 != HEADINGS:
        problems.append(f"H2 headings/order wrong: {h2}")

    qs = len(re.findall(r"^\s*-?\s*\*\*Q:\*\*", prose, re.M))
    if not 2 <= qs <= 4:
        problems.append(f"interview questions: {qs} (want 2-4)")

    takeaways = re.search(r"## Key takeaways\n(.*?)(?=\n## )", prose, re.S)
    if takeaways:
        n = len(re.findall(r"^\s*[-*] ", takeaways.group(1), re.M))
        if n > 5:
            problems.append(f"{n} key takeaways (max 5)")

    for m in re.finditer(r"^### Bridge: .*\(Handbook ch \d+\)$", prose, re.M):
        pass
    bridges = re.findall(r"^### Bridge:.*$", prose, re.M)
    for b in bridges:
        if not re.search(r"\(Handbook ch \d+\)$", b):
            problems.append(f"bridge heading format: {b}")
    fulls = len(re.findall(r"^Full treatment: Handbook ch \d+\.$", prose, re.M))
    if fulls != len(bridges):
        problems.append(f"{len(bridges)} bridges but {fulls} 'Full treatment' lines")

    for target in set(re.findall(r"\]\((\d\d-ch[\w-]+\.md)\)", text)):
        # only flag names that are not in the planned map in PROGRESS.md
        if target not in PLANNED:
            problems.append(f"link to unknown chapter file: {target}")

    for bad, good in BANNED.items():
        if bad in prose:
            problems.append(f"term variant '{bad}' -> use {good}")

    for needle in ("In today's", "in today's", "fast-paced", "game-changer", "game changer", "delve", "leverage "):
        if needle in prose:
            problems.append(f"filler phrase: {needle!r}")

    return problems


def planned_names() -> set[str]:
    progress = (ROOT / "PROGRESS.md").read_text(encoding="utf-8")
    return set(re.findall(r"`chapters/(\d\d-ch[\w-]+\.md)`", progress))


PLANNED = planned_names()


def main(argv: list[str]) -> int:
    files = [Path(a) for a in argv] or sorted(CHAPTERS.glob("*.md"))
    bad = 0
    for f in files:
        issues = check(f)
        words = len(f.read_text(encoding="utf-8").split())
        status = "OK  " if not issues else "FAIL"
        print(f"{status} {f.name} ({words} words)")
        for i in issues:
            print(f"     - {i}")
        bad += bool(issues)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
