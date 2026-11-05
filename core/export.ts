// Getting the book out of the app in other shapes: one self-contained web page, an EPUB for e-readers, and (in the app)
// a PDF of a single chapter. The chapters are the same ones the PDF has: known chapters are left out.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { insideBook, readChapters, selectChapters, type Chapter } from "./book.ts";
import { atomicWrite } from "./fsutil.ts";
import type { BookConfig } from "./config.ts";
import { cssOverride } from "./config.ts";
import { buildHtml, chapterHtml, esc } from "./html.ts";
import { STYLES } from "./paths.ts";
import { readCss } from "./style.ts";
import { zip, type ZipEntry } from "./zip.ts";

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".ttf": "font/ttf" };

const webCss = (): string => fs.readFileSync(path.join(STYLES, "web.css"), "utf8");
const ownCss = (book: BookConfig): string => {
  const own = cssOverride(book);
  return own ? "\n" + fs.readFileSync(own, "utf8") : "";
};

function dataUri(abs: string): string {
  return `data:${MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream"};base64,${fs.readFileSync(abs).toString("base64")}`;
}

/** The fonts the web stylesheet names, as @font-face rules with the files inside, so one file is the whole book. */
function embeddedFonts(): string {
  const f = (family: string, weight: number, style: string, file: string) =>
    `@font-face { font-family: "${family}"; font-weight: ${weight}; font-style: ${style}; src: url("${dataUri(path.join(STYLES, "fonts", file))}") format("truetype"); }`;
  return [
    f("Newsreader", 400, "normal", "newsreader/Newsreader-Regular.ttf"),
    f("Newsreader", 400, "italic", "newsreader/Newsreader-Italic.ttf"),
    f("Hanken Grotesk", 400, "normal", "hanken-grotesk/HankenGrotesk-Regular.ttf"),
    f("Hanken Grotesk", 400, "italic", "hanken-grotesk/HankenGrotesk-Italic.ttf"),
    f("Hanken Grotesk", 600, "normal", "hanken-grotesk/HankenGrotesk-Semibold.ttf"),
    f("JetBrains Mono", 400, "normal", "jetbrains-mono/JetBrainsMono-Regular.ttf"),
  ].join("\n");
}

export class ExportError extends Error {}

function chaptersOf(book: BookConfig, imageUrl: (abs: string) => string): Chapter[] {
  const files = selectChapters(book);
  if (!files.length) throw new ExportError(book.known.length ? "Every chapter is marked as known, so there is nothing to export." : "The book has no chapters.");
  return readChapters(book, files, imageUrl);
}

/** The whole book as one HTML file: fonts and pictures are inside it, so it can be sent or opened anywhere. */
export function exportHtml(book: BookConfig, out: string): { chapters: number; bytes: number } {
  const chapters = chaptersOf(book, (abs) => (insideBook(book, abs) && fs.existsSync(abs) ? dataUri(abs) : ""));
  const html = buildHtml(book, chapters, `${embeddedFonts()}\n${webCss()}${ownCss(book)}`, { head: '  <meta name="viewport" content="width=device-width, initial-scale=1">\n' });
  atomicWrite(out, html);
  return { chapters: chapters.length, bytes: Buffer.byteLength(html) };
}

// ---- EPUB ----------------------------------------------------------------------------------------

const XHTML_OPEN = (lang: string, title: string) => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${esc(lang)}" xml:lang="${esc(lang)}">
<head>
  <meta charset="utf-8" />
  <title>${esc(title)}</title>
  <link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body>
`;

/** Text with its tags taken off, for the contents. */
const plain = (html: string): string => html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;|&#34;/g, '"').replace(/&#39;/g, "'");

export function buildEpub(book: BookConfig): Buffer {
  const pictures = new Map<string, string>(); // absolute path -> name inside the book
  const chapters = chaptersOf(book, (abs) => {
    if (!insideBook(book, abs) || !fs.existsSync(abs)) return "";
    let name = pictures.get(abs);
    if (!name) {
      name = `${crypto.createHash("sha1").update(fs.readFileSync(abs)).digest("hex").slice(0, 10)}${path.extname(abs).toLowerCase().replace(".jpeg", ".jpg")}`;
      pictures.set(abs, name);
    }
    return `images/${name}`;
  });
  // A drawn diagram arrives inside the page as a data address; an e-book wants it as a file of its own.
  const drawn = new Map<string, string>(); // file name -> svg text
  const extract = (html: string) =>
    html.replace(/src="data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)"/g, (_m, b64: string) => {
      const name = `diagram-${crypto.createHash("sha1").update(b64).digest("hex").slice(0, 10)}.svg`;
      drawn.set(name, Buffer.from(b64, "base64").toString("utf8"));
      return `src="images/${name}"`;
    });
  const ids = new Set(chapters.map((c) => c.id));
  const fileOf = (c: Chapter) => `${c.id}.xhtml`;
  // Links between chapters pointed at places in one long page; in an e-book each chapter is its own file.
  // The page is XML in an e-book: void tags must close themselves (the printed web addresses carry <wbr> break points).
  const relink = (html: string) => html.replace(/href="#([^"]+)"/g, (m, id: string) => (ids.has(id) ? `href="${id}.xhtml"` : m)).replace(/<wbr>/g, "<wbr />");

  const uid = `urn:uuid:${crypto.createHash("sha1").update(`${book.title}\n${book.author}`).digest("hex").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5")}`;
  const modified = new Date().toISOString().replace(/\.\d+Z$/, "Z");

  const files: ZipEntry[] = [
    { name: "mimetype", data: Buffer.from("application/epub+zip"), store: true },
    { name: "META-INF/container.xml", data: Buffer.from(`<?xml version="1.0" encoding="utf-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n  <rootfiles>\n    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml" />\n  </rootfiles>\n</container>\n`) },
    { name: "OEBPS/style.css", data: Buffer.from(webCss() + ownCss(book)) },
  ];

  // Title page
  const titlePage = `${XHTML_OPEN(book.language, book.title)}<section class="cover">
  <h1 class="cover-title">${esc(book.title)}</h1>
  ${book.subtitle ? `<p class="cover-subtitle">${esc(book.subtitle)}</p>` : ""}
  <div class="cover-rule"></div>
  ${book.author ? `<p class="cover-author">${esc(book.author)}</p>` : ""}
  ${book.date ? `<p class="cover-date">${esc(book.date)}</p>` : ""}
</section>
</body>
</html>
`;
  files.push({ name: "OEBPS/title.xhtml", data: Buffer.from(titlePage) });

  chapters.forEach((c, i) => {
    const doc = `${XHTML_OPEN(book.language, `${c.label ? c.label + ": " : ""}${plain(c.titleHtml)}`)}${extract(relink(chapterHtml(c, i === 0)))}
</body>
</html>
`;
    files.push({ name: `OEBPS/${fileOf(c)}`, data: Buffer.from(doc) });
  });

  // Contents: the e-reader's own menu, and a page of the same list
  const entries = chapters.map((c) => ({ href: fileOf(c), text: `${c.label ? c.label + ": " : ""}${plain(c.titleHtml)}`, part: c.partOpens ? `${c.partLabel}: ${c.partName}` : "" }));
  const nav = `${XHTML_OPEN(book.language, "Contents")}<nav epub:type="toc" id="toc">
  <h1 class="toc-title">Contents</h1>
  <ol class="toc-list">
${entries.map((e) => `${e.part ? `    <li class="toc-part">${esc(e.part)}</li>\n` : ""}    <li class="toc-chapter"><a href="${esc(e.href)}">${esc(e.text)}</a></li>`).join("\n")}
  </ol>
</nav>
</body>
</html>
`;
  files.push({ name: "OEBPS/nav.xhtml", data: Buffer.from(nav) });
  files.push({
    name: "OEBPS/toc.ncx",
    data: Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="${esc(uid)}" /></head>
  <docTitle><text>${esc(book.title)}</text></docTitle>
  <navMap>
${entries.map((e, i) => `    <navPoint id="n${i + 1}" playOrder="${i + 1}"><navLabel><text>${esc(e.text)}</text></navLabel><content src="${esc(e.href)}" /></navPoint>`).join("\n")}
  </navMap>
</ncx>
`),
  });

  for (const [abs, name] of pictures) files.push({ name: `OEBPS/images/${name}`, data: fs.readFileSync(abs) });
  for (const [name, svg] of drawn) files.push({ name: `OEBPS/images/${name}`, data: Buffer.from(svg) });

  const manifest = [
    '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />',
    '    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml" />',
    '    <item id="css" href="style.css" media-type="text/css" />',
    '    <item id="title" href="title.xhtml" media-type="application/xhtml+xml" />',
    ...chapters.map((c) => `    <item id="${esc(c.id)}" href="${esc(fileOf(c))}" media-type="application/xhtml+xml" />`),
    ...[...pictures.values()].map((n, i) => `    <item id="img${i + 1}" href="images/${n}" media-type="${MIME[path.extname(n)] ?? "image/png"}" />`),
    ...[...drawn.keys()].map((n, i) => `    <item id="diagram${i + 1}" href="images/${n}" media-type="image/svg+xml" />`),
  ].join("\n");
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="${esc(book.language)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">${esc(uid)}</dc:identifier>
    <dc:title>${esc(book.title)}</dc:title>
    ${book.author ? `<dc:creator>${esc(book.author)}</dc:creator>` : ""}
    <dc:language>${esc(book.language)}</dc:language>
    ${book.subtitle ? `<dc:description>${esc(book.subtitle)}</dc:description>` : ""}
    <meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest>
${manifest}
  </manifest>
  <spine toc="ncx">
    <itemref idref="title" />
    <itemref idref="nav" />
${chapters.map((c) => `    <itemref idref="${esc(c.id)}" />`).join("\n")}
  </spine>
</package>
`;
  files.splice(3, 0, { name: "OEBPS/content.opf", data: Buffer.from(opf) });
  return zip(files);
}

export function exportEpub(book: BookConfig, out: string): { chapters: number; bytes: number } {
  const bytes = buildEpub(book);
  atomicWrite(out, bytes);
  return { chapters: selectChapters(book).length, bytes: bytes.length };
}
