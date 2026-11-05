// How text is made comparable for searching and for finding a note's words on the page: one kind of quote, lower case,
// single spaces. The page-side code (core/browser/reading-bridge.ts) and the book-wide search (core/search.ts) both use
// these, so a match found in a chapter's source is found at the same place on its page.

/** One character, normalised: every quote becomes ', and letters are lower case (when that keeps it one character). */
export function normChar(c: string): string {
  if (/[‘’“”"']/.test(c)) return "'";
  const l = c.toLowerCase();
  return l.length === 1 ? l : c;
}

/** A string run through the same normalising, with runs of white space collapsed and the ends trimmed. */
export function normText(t: string): string {
  let out = "";
  let space = true;
  for (const ch of t) {
    if (/\s/.test(ch)) {
      if (!space) out += " ";
      space = true;
    } else {
      out += normChar(ch);
      space = false;
    }
  }
  return out.trim();
}

/** The words either side of a match, normalised: enough to tell one occurrence from another of the same words. */
export const CONTEXT_CHARS = 24;
export function contextAround(text: string, start: number, end: number): string {
  return `${text.slice(Math.max(0, start - CONTEXT_CHARS), start)}\u0001${text.slice(end, end + CONTEXT_CHARS)}`;
}

/** Start index of every non-overlapping occurrence of `needle` in `text`. */
export function occurrences(text: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) out.push(at);
  return out;
}
