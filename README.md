# book-studio

Reads a book folder and renders it: a print-ready A4 PDF, typographic and ink checks on that PDF, and
(next) the reading view of the Mac app. It holds all the code, fonts and CSS; the book repo holds only
the writing.

Pipeline: markdown-it-py (markdown to HTML), Jinja2 templates, WeasyPrint (layout and PDF). No browser.

## TypeScript engine (in progress: Python stays until the output is approved)

A second engine is being built to replace the Python one so the desktop app needs no Python and no native libraries.
It lives in `core/` (shared by the command line and, later, the app) and uses Electron as its layout engine:
markdown-it for HTML, Paged.js for pagination, Chromium's `printToPDF` for the PDF, and pdf.js for the checker.
It reads the same `book.yaml` and the same `styles/book.css` (plus `styles/paged.css`, which only the TypeScript engine loads).

```
core/       config, markdown (mdrender), notes, book, html, check, lint, pdf (spawns Electron)
            browser/  pagination rules that run inside the hidden window (Paged.js handler)
electron/   the hidden-window PDF process
bin/        the `book-studio` command (Node)
tests/      vitest
```

Setup needs Node 22.12 or newer:

```bash
npm install            # Electron is downloaded here
npm run build          # bundles dist/
npm test               # 100 tests
node bin/book-studio.js pdf   /path/to/book --check
node bin/book-studio.js check /path/to/book
node bin/book-studio.js lint  /path/to/book
```

Options match the Python command (`--chapters`, `--out`, `--html`, `--extra-css`, `--check`, `--samples`). Developer aids:
`--trace` (log pagination decisions), `--no-rules` (Paged.js without the book's pagination rules).

Differences from the Python engine that you can see in the PDF:

- Contents page numbers are printed from labels computed by the driver, then verified by the checker against the PDF
  bookmarks and the page footers (Paged.js's own page counters were not reliable). Every entry is verified.
- Bookmarks list chapters and their H2/H3 headings; Chromium cannot make a separate bookmark for a Part.
- External link addresses are real text (so they can wrap at slashes) rather than CSS generated content.

## Layout

```
bookcore/   shared rendering, used by the command line and the app
            config (book.yaml), style, mdrender (markdown), book (chapters, Parts, HTML),
            pdf (WeasyPrint), check (the checker), workflow (build, then check), lint
            templates/ cover, contents and chapter HTML
cli/        `book-studio pdf | check | lint`
app/        the Mac app (not built yet)
styles/     book.css and fonts/: the typography shared by the app view and the PDF
extras/     lint_chapters.py: the Field Guide's own chapter lint, kept as it was (book-specific rules)
```

A **book** is any folder that contains a `book.yaml`. Nothing in this repo is specific to one book.

## Setup

```bash
cd book-studio
uv sync
brew install pango        # one-time; WeasyPrint needs it. The command line finds Homebrew's libraries itself.
```

On Debian or Ubuntu: `apt install libpango-1.0-0 libpangoft2-1.0-0`.

## Command line

Run from this folder, or from anywhere with `uv run --project /path/to/book-studio book-studio ...`.

```bash
uv run book-studio pdf   /path/to/book                    # build/<output>.pdf in the book folder
uv run book-studio pdf   /path/to/book --chapters 0-3     # quick preview: numbers, ranges, commas or file names
uv run book-studio pdf   /path/to/book --check            # build, then run the checker (exit 1 on failures)
uv run book-studio pdf   /path/to/book --out /tmp/x.pdf --html /tmp/x.html --extra-css try.css
uv run book-studio check /path/to/book                    # checks build/<output>.pdf
uv run book-studio check /path/to/book --samples /tmp/pages   # also write PNGs of sample pages
uv run book-studio lint  /path/to/book                    # the Field Guide's own chapter lint
```

Exit status is 0 on success and 1 if a check fails, so Claude Code can build and check without the app.

## book.yaml

```yaml
title: AI Engineer Field Guide     # required
subtitle: From Basics to Production
author: Tabaré Lacerda
date: November 1, 2026             # printed on the cover as written
language: en                       # document language and hyphenation
chapters: chapters/*.md            # glob; chapters are ordered by file name
output: ai-engineer-field-guide    # the PDF is build/ai-engineer-field-guide.pdf
index: INDEX.md                    # optional: groups chapters into Parts (see below)
```

Unknown keys are rejected, so a typo cannot pass silently. A chapter file starts with `# Chapter N - Title`
(or `# Appendix A - Title`); that line becomes the opening-page label and title. A line under it of the form
`Level: [B] | Priority: [Core]` becomes the small level line. Chapter numbers for `--chapters` and for Parts
are the leading digits of the file name.

**Parts.** If `index` names a markdown file, its `## Part I - Name` headings and `**Chapter 3 - Title**` lines
decide which chapters belong to which Part. A Part appears above the title on the opening page of its first
chapter and as a line in the contents; it has no page of its own, so the first chapter is page 1.

**Missing chapters.** Links to chapter files that are not in this build print as plain text.

## Per-book style overrides

Without a `book.css` in the book folder, the book uses `styles/book.css`. A book may add its own `book.css`
next to its `book.yaml`; it is layered after the default, so it can change any custom property or rule
without repeating the fonts. Relative `url(...)` values in it resolve against `styles/`.

## What the checker verifies

`book-studio check` exits non-zero if any of these fail:

- a page ends with a heading, or a heading has fewer than 3 lines after it on the same page
- a page starts or ends with fewer than 3 lines of a paragraph that continues across the break
- a code block is split with fewer than 4 visible lines on one side, or a short block is split
- a sentence that introduces a list or code block is stranded at the bottom of a page
- a list item is split across pages
- contents page numbers differ from the real chapter start pages (checked against both the PDF
  bookmarks and the number printed in the footer of the chapter's first page)
- em or en dashes appear that are not in the source, or any colour appears on any page

It also reports the measure (characters per line), pages that end mostly empty, and the darkest pages.
The PDF has no structure, so lines are classified from the fonts the stylesheet assigns (see the docstring
in `bookcore/check.py`). Known limit: two code blocks that meet exactly at a page break can be read as one
block split in two.

For the app: `bookcore.workflow.print_book(book)` builds and checks and returns the PDF path, the page count and a
`CheckReport` whose `results` and `problem_lines` are ready to show in a panel.

## Tuning the look

Everything is a custom property at the top of `styles/book.css`. Change a value there and rebuild every book,
or put the change in one book's own `book.css` (see "Per-book style overrides").
The type scale and vertical rhythm come from measurements of the Claude Docs reference
(measured values supplied by the author; the reference PDF is not in this repo): 12pt body on an 18pt line,
H1 24/28.5 and H2 16.5 in a regular-weight serif, H3 13.5pt Semibold sans, 9.75pt byline.

| Variable | Controls |
| --- | --- |
| `--font-body`, `--font-heading`, `--font-mono`, `--font-ui` | Font stacks: body sans, heading serif, code, and header/footer/labels |
| `--size-body`, `--leading-body` | Body size and line height (12pt, 1.5 = 18pt) |
| `--size-h1`/`--leading-h1`, `--size-h2`/`--leading-h2`, `--size-h3`/`--leading-h3` | Heading sizes and line heights (h1 is the chapter title) |
| `--size-meta`, `--leading-meta`, `--size-small` | Chapter label and level line; running header, footer, captions |
| `--size-code`, `--leading-code`, `--size-inline-code` | Code blocks (10.5pt), inline code (relative to body) |
| `--weight-heading`, `--weight-strong` | 400 for headings (no bold headings), 600 for bold text |
| `--space-paragraph`, `--space-list-item` | Gap between blocks (7.5pt) and between list items (3pt) |
| `--space-h2-before/after`, `--space-h3-before/after` | Space around headings: tuned so block to H2 is 43.9pt and H2 to text is 30pt, baseline to baseline |
| `--space-code-before/after`, `--code-pad-y`, `--code-pad-x`, `--code-width` | Space around and inside code blocks; width of the frame, which reaches into the side margins |
| `--opener-top`, `--opener-label-after`, `--opener-title-after`, `--opener-meta-after` | Chapter opening page: 48pt from title to level line, 42pt from there to the first H2 |
| `--list-indent`, `--bullet-size`, `--bullet-left`, `--bullet-top` | List geometry: text indent 16.8pt, 3.75pt round bullet 3.8pt in, centred on the x-height |
| `--toc-label-width`, `--toc-number-width` | Contents columns |
| `--color-text`, `--color-meta`, `--color-secondary`, `--color-code-comment`, `--color-code-string`, `--color-rule`, `--color-code-border`, `--hairline` | All ink. Keep them dark enough to print crisply |
| `--margin-top`, `--margin-bottom`, `--margin-side` | Page margins, identical on every page. Vertical values are the reference's; the sides are wider for a 65 to 75 character measure |
| `--orphans`, `--widows` | Minimum paragraph lines at a page bottom or top |

The measure is set by body size, font and `--margin-side` together. The checker prints the current
median. If you change one, expect to change another to stay near 65 to 75 characters. If you change a
vertical-rhythm value, `book-studio check` does not verify it; compare baselines as described in "Checking the rhythm".

Constants in `bookcore/mdrender.py`: `SHORT_CODE_LINES` (code blocks up to this many visible lines never split,
default 15), `MIN_CODE_VISIBLE` (a split keeps this many visible lines on each side, default 4; the exact
`orphans`/`widows` for each block are computed from its content, so blank lines do not count), `CODE_COLUMNS`
(about how many characters fit across a code frame, used to estimate wrapped lines; 77 at 10.5pt in a 178mm
frame) and `SHORT_PARAGRAPH_CHARS` (a paragraph shorter than this directly after a heading is kept with
the block that follows it).

Code highlighting uses Pygments token classes only. The monochrome treatment (bold keywords, grey
italic comments, dark-grey strings) is the `pre .k`, `pre .s`, `pre .c` rules in `styles/book.css`.

## Adding or swapping fonts

1. Put the `.ttf` files and the licence file (`OFL.txt` or equivalent) in `styles/fonts/<family>/`.
   Open licences only, so the build stays reproducible and redistributable. WeasyPrint is most
   reliable with static instances: if a font ships only as a variable file, instantiate the weights
   you need with `fonttools` (`fontTools.varLib.instancer`) and vendor those.
2. Add one `@font-face` per weight and style at the top of `styles/book.css`, pointing at the files.
3. Point the matching `--font-*` variable at the new family name.
4. Rebuild, then run `book-studio check`. The checker reads the heading and code font families, the margins
   and the code and heading sizes back from the stylesheet's custom properties, so nothing needs to be kept
   in step by hand. It does need `--font-heading` and `--font-mono` to start with the real family name.

Bundled: Newsreader (headings, static instance at optical size 24), Hanken Grotesk (body: Regular, Italic,
Semibold), JetBrains Mono (code). All SIL OFL 1.1. Newsreader and Hanken Grotesk were chosen as the closest
open match to the reference's proprietary serif and sans, against Source Serif 4, Literata, Inter and Figtree.

Characters outside the bundled fonts (the Japanese strings in the tokenizer demo, for example) fall back
to whatever the machine has installed, so those few glyphs are not reproducible across machines. To make
them so, vendor a CJK font and add it to `--font-mono` and `--font-body`.

## Checking the rhythm

The spacing values were tuned against baseline-to-baseline distances measured from the reference:
18pt inside paragraphs and list items, 21pt between list items, 25.5pt from a paragraph to a list,
43.9pt from a block to an H2, 30pt from an H2 to its first line, 28.5pt inside the H1, 48pt from the H1
to the byline, 42pt from the byline to the first H2. To re-measure after a change, read the `origin`
(baseline) of each line with PyMuPDF (`page.get_text("dict")`) and take differences between consecutive
lines of the kinds above.

## WeasyPrint behaviours this setup works around

- `counter-reset: page` breaks `target-counter(..., page)`, so front matter uses its own roman
  counter and does not advance `page`; Chapter 0.1 is then arabic 1 and the contents numbers are real.
- `:first` only matches the first page of the document, so "no header on chapter opening pages" uses
  `string(running-title, first-except)`, which is empty on any page where the title is assigned.
- Stylesheets passed to `render()` are user-level and lose to the document's own, so the stylesheets
  (default, the book's own, and `--extra-css` files) are inlined into the HTML.
- Footnotes (supported by the markdown parser) print as a list at the end of the chapter, not at
  the foot of the page. No current chapter uses them.
- Typographic quotes and ellipses are applied to text only. markdown-it's `replacements` rule is off
  on purpose: it would turn `--` and `---` into en and em dashes, and the book uses plain hyphens.
