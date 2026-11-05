// Pictures in a book: what counts as one, where it is kept, and the markdown that points at it.

import path from "node:path";
import { slugOf } from "./chapters.ts";

export const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"];
/** A picture larger than this is refused (it would only make the book heavy). */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

/** The kind of picture some bytes are, from their first bytes, or null. Pasted data is only trusted when it looks like a picture. */
export function sniffImage(b: Uint8Array): { ext: string; mime: string } | null {
  const is = (...bytes: number[]) => bytes.every((v, i) => b[i] === v);
  if (is(0x89, 0x50, 0x4e, 0x47)) return { ext: ".png", mime: "image/png" };
  if (is(0xff, 0xd8, 0xff)) return { ext: ".jpg", mime: "image/jpeg" };
  if (is(0x47, 0x49, 0x46, 0x38)) return { ext: ".gif", mime: "image/gif" };
  if (is(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return { ext: ".webp", mime: "image/webp" };
  return null;
}

/** "02-ch02-python-in-plain-words.md" and a short fingerprint of the picture give "ch02-python-in-plain-a1b2c3.png". */
export function imageName(chapterFile: string, fingerprint: string, ext: string, hint?: string): string {
  const slug = slugOf(hint ? hint.replace(/\.[^.]+$/, "") : path.basename(chapterFile).replace(/\.md$/i, "").replace(/^\d+-/, ""));
  // Keep it short, cutting between words rather than inside one.
  let base = slug;
  if (slug.length > 24) {
    const cut = slug.slice(0, 24);
    base = slug[24] === "-" ? cut : cut.includes("-") ? cut.slice(0, cut.lastIndexOf("-")) : cut;
  }
  return `${base.replace(/-+$/, "") || "image"}-${fingerprint}${ext}`;
}

/** The markdown for a picture kept in `imagePath`, written in a chapter: the address is relative to the chapter's folder. */
export function imageMarkdown(chapterFile: string, imagePath: string, alt = ""): string {
  const rel = path.relative(path.dirname(chapterFile), imagePath).split(path.sep).join("/");
  return `![${alt}](${rel.split("/").map(encodeURIComponent).join("/")})`;
}
