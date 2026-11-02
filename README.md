# book-studio

Book Studio reads a book folder and renders it: a print-ready A4 PDF, typographic and ink checks on that PDF, and
a desktop app (macOS, Windows, Linux, Electron and TypeScript) for reading, annotating and printing. It holds all the code, fonts and
CSS; the book repo holds only the writing. It is fully offline and needs no Python.

Pipeline: markdown-it (markdown to HTML), Paged.js (pagination), Chromium's `printToPDF` through Electron (PDF),
pdf.js (checker).

## The app

```bash
npm run build && npm run app      # or: npm start
```

Open a book folder (File > Open Book Folder, or Open Recent). A folder is a book if it has a `book.yaml`. If it has
none, the app offers to create one only when the folder visibly holds a book (a `chapters` folder with markdown files
that start with a heading, or at least two numbered ones like `01-intro.md`); otherwise it writes nothing and says so. The folder is watched: a chapter changed outside the app (by Claude Code, say)
reloads silently, or, if you have unsaved edits, a banner asks Reload or Keep mine.

- **Left panel:** Parts and chapters, the open chapter's H2/H3 outline, a badge with its count of open notes, and how long the book is: pages per chapter and a total. The count comes from laying every chapter out quietly in the background (about 20 seconds the first time, remembered after that) and matches the numbered pages of the PDF; the PDF also has a cover and the contents.
- **Sideways scrolling:** the reading view scrolls sideways only when the page itself is wider than the window. Otherwise the page is centred, and the notes use the room beside it (narrowing, or sitting over the page's blank right margin, when room is short). Fit (`9`) shows the whole page with room for the notes.
- **Reading view:** the chapter laid out exactly as it prints (same styles, same pagination rules). Read only; click a
  block, or select text, then add a note. Blocks with notes get a thin rule on their left; notes are cards in the margin.
- **Source view:** the markdown in CodeMirror, editable. Cmd/Ctrl+S saves; leaving a chapter or closing the window with
  unsaved edits asks first.
- **Print PDF:** saves, builds `build/<output>.pdf`, runs the checker, shows a report whose lines open the chapter
  they belong to, then opens the PDF in your viewer.

| Keys (Cmd on macOS, Ctrl elsewhere) | |
| --- | --- |
| `/` | switch Reading and Source |
| `S` | save |
| `Shift+M` | add a note to the selected block |
| `\` | show or hide the left panel |
| `F` | find in the chapter |
| `[` and `]` | previous and next chapter |
| `P` | print PDF |
| `O` | open a book folder |
| `=` and `-` | zoom the page in and out (the text size in the source view) |
| `0` | actual size |
| `9` | fit the page to the window |

**Notes** are kept in the markdown, one comment on its own line directly after the block: `<!-- Q: ... -->` a question,
`<!-- E: ... -->` an edit request, `<!-- ? -->` confused, `<!-- A: ... -->` an answer written by Claude Code. The
Obsidian forms (`%%Q: ...%%`, `%%?%%`) work the same. Adding, editing or removing a note changes only its own lines and
never reformats anything else; files are written atomically. In the reading view pick Question (Q), Change this (E) or Lost me (?), type,
press Enter. The keys Q, E and ? (capital or not) pick the kind even while the page has the keyboard; while typing, Ctrl or Cmd with 1, 2, 3 does the same. The box opens next to the words you selected (or the place you clicked), keeps what you typed if the window is redrawn, and the words or block a note is about stay highlighted until you press Read. The `?` button in the toolbar explains this and copies the command to give Claude Code (`process notes in chapter NN`). Select exact words first and the note carries them as `[on: "..."]`, shown highlighted on the page, so Claude Code knows what to change. A selection of more than 200 characters (it may run over several paragraphs) is saved as its first and last words with ` ... ` between them, and the whole stretch is highlighted. Click highlighted text to see its note: the card is outlined and brought into view, and its words are marked strongest. An answer shows under its note; **Reply** writes a follow-up note under it, and **Read** removes the note and its answer.
`CLAUDE.md` in the book repo tells Claude Code how to process them.

**Safety.** The window is sandboxed, with context isolation, no Node, a strict content security policy and a narrow
preload bridge (`app/shared/api.ts` lists every call). It loads only its own files, the shared styles and the prepared
pages; the network is blocked outright. Links in the book open in your own browser.

## Installers

Every build that is handed out has its own version (`npm version patch --no-git-tag-version`, or `minor` for features), so
the installed copy can always be told apart from the one before: the version is in the `?` popover, on the welcome screen
and in the About box.

| System | File | Built with |
| --- | --- | --- |
| macOS | `Book-Studio-<version>-mac-arm64.dmg` and `-mac-x64.dmg` | electron-builder |
| Windows | `Book-Studio-<version>-win-x64.exe` (NSIS installer) | electron-builder |
| Linux | `Book-Studio-<version>-linux-x86_64.AppImage` and `Book-Studio-<version>-linux-amd64.deb` | electron-builder |

```bash
npm run dist          # everything this machine can build, into release/
npx electron-builder --mac --publish never      # or --win, or --linux
npm run pack          # an unpacked app in release/mac-arm64/ (or similar), quick to test
```

`electron-builder.yml` holds the settings. A macOS build holds both Mac architectures, so it needs the native canvas
module (used by the checker's ink and colour checks) for both: `npm install --no-save --force
@napi-rs/canvas-darwin-x64@0.1.100 @napi-rs/canvas-darwin-arm64@0.1.100` before building on a Mac. The `.deb` needs a
Linux machine (its packaging tool fails on macOS); the other installers build anywhere. The icon is `assets/icon.png`,
drawn by `npm run icon`.

**CI.** `.github/workflows/build.yml` builds on macOS, Windows and Linux for each push to `main`, each pull request and
on demand (Actions > build > Run workflow). Every job uploads its installers as an artifact of the run, and the Linux job
also runs the tests under `xvfb`. Nothing is published or released automatically.

## First launch

The installers are **not signed or notarized**, so each system warns once. The app itself is the same on all three.

- **macOS:** open the `.dmg`, drag Book Studio to Applications. The first time, right-click (or Control-click) the app and
  choose **Open**, then **Open** again in the dialog. If macOS says the app "is damaged", run
  `xattr -dr com.apple.quarantine "/Applications/Book Studio.app"` once.
- **Windows:** run the installer. If SmartScreen shows "Windows protected your PC", click **More info**, then **Run anyway**.
- **Linux:** `chmod +x Book-Studio-*.AppImage && ./Book-Studio-*.AppImage`, or `sudo apt install ./Book-Studio-*.deb`.
  The AppImage starts Chromium without its process sandbox (an AppImage cannot carry the helper it needs); the window
  keeps its own sandbox, context isolation and content security policy. The `.deb` should use the normal sandbox (untested here).

Nothing is sent anywhere; the app works without a network connection.

## Layout

```
core/       shared by the command line and the app
            config (book.yaml), mdrender (markdown), book (chapters, Parts), html, notes, check, lint,
            pdf (spawns Electron); browser/ holds the pagination rules that run inside the hidden window
electron/   the hidden-window PDF renderer
app/        the desktop app: main/ (windows, menu, files, print), preload/, renderer/ (the UI), shared/
bin/        the `book-studio` command
scripts/    build script
styles/     book.css, paged.css and fonts/: the typography shared by the app view and the PDF
tests/      vitest
```

A **book** is any folder that contains a `book.yaml`. Nothing in this repo is specific to one book.

## Setup

Node 22.12 or newer.

```bash
npm install            # downloads Electron
npm run build          # bundles dist/
npm test
npm run app            # starts the desktop app
```

## Command line

```bash
npx book-studio pdf   /path/to/book                    # build/<output>.pdf in the book folder
npx book-studio pdf   /path/to/book --chapters 0-3     # quick preview: numbers, ranges, commas or file names
npx book-studio pdf   /path/to/book --check            # build, then run the checker (exit 1 on failures)
npx book-studio pdf   /path/to/book --out /tmp/x.pdf --html /tmp/x.html --extra-css try.css
npx book-studio check /path/to/book                    # checks build/<output>.pdf
npx book-studio check /path/to/book --samples /tmp/pages   # also write PNGs of sample pages
npx book-studio lint  /path/to/book                    # the Field Guide's own chapter lint
```

Run it from this folder, or by path (`node /path/to/book-studio/bin/book-studio.js ...`). Exit status is 0 on success
and 1 if a check fails, so Claude Code can build and check without the app. Developer aids: `--trace` logs pagination
decisions and `--no-rules` runs Paged.js without the book's pagination rules.

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
in `core/check.ts`). A split code frame is told apart from two blocks that meet at a page break by the frame borders drawn on each page.

It also checks that every paragraph, list item and code line of the source is in the printed text, and that every contents entry matches the PDF bookmarks and footers.

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

Constants in `core/mdrender.ts`: `SHORT_CODE_LINES` (code blocks up to this many visible lines never split,
default 15), `MIN_CODE_VISIBLE` (a split keeps this many visible lines on each side, default 4; the exact
`orphans`/`widows` for each block are computed from its content, so blank lines do not count), `CODE_COLUMNS`
(about how many characters fit across a code frame, used to estimate wrapped lines; 77 at 10.5pt in a 178mm
frame) and `SHORT_PARAGRAPH_CHARS` (a paragraph shorter than this directly after a heading is kept with
the block that follows it).

Code highlighting uses highlight.js token classes only. The monochrome treatment (bold keywords, grey
italic comments, dark-grey strings) is the `pre .hljs-*` rules in `styles/paged.css`.

## Adding or swapping fonts

1. Put the `.ttf` files and the licence file (`OFL.txt` or equivalent) in `styles/fonts/<family>/`.
   Open licences only, so the build stays reproducible and redistributable. Prefer static
   instances: if a font ships only as a variable file, instantiate the weights you need with `fonttools`
   and vendor those. Give each weight its own PostScript name, so the checker can tell weights apart.
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
to the byline, 42pt from the byline to the first H2. To re-measure after a change, read the baseline
of each line from the PDF (pdf.js text items, or PyMuPDF `page.get_text("dict")`) and take differences between consecutive
lines of the kinds above.

## Pagination notes

- Paged.js lays pages out in a hidden Chromium window; `core/browser/rules.ts` adds what it lacks: widows and orphans,
  keep-with-next, short code blocks whole, code splits that keep four visible lines on each side, no page ending in
  half a hyphenated word. `orphans`, `widows` and `break-inside` are renamed to `--pg-*` properties before Chromium
  sees them, so Chromium's own fragmentation does not fight the rules.
- Page numbers are printed from labels the driver computes (cover none, contents roman, first chapter arabic 1),
  and the checker verifies each contents entry against the PDF bookmarks and the footers.
- Bookmarks come from headings: chapters, H2 and H3. Chromium cannot make a bookmark for a Part.
- Typographic quotes and ellipses are applied to text only. markdown-it's `replacements` rule is off
  on purpose: it would turn `--` and `---` into en and em dashes, and the book uses plain hyphens.
- Footnotes print as a list at the end of the chapter.

- A heading followed by an unsplittable element (a list item) too tall to share the page with it no longer ends up alone on a page: the element is split, between its inner items where it has them.
- A heading always keeps at least three lines of what follows it on its page; a heading followed by a single two-line list item moves to the next page with it.
