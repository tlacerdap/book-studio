// The notes protocol. Notes live in the markdown, each on its own line(s) directly after the block it refers to:
//
//   <!-- Q: text -->   a question: I don't understand something
//   <!-- E: text -->   an edit request
//   <!-- ? -->         this block confused me, no detail (it may carry words: <!-- ? [on: "..."] -->)
//   <!-- A: text -->   an answer, written under the note it answers
//
// Obsidian forms are accepted too: %%Q: ...%%, %%E: ...%%, %%?%%, %%A: ...%%.
//
// Everything here works on whole lines and touches nothing else: line endings, indentation and every
// other byte of the file come out exactly as they went in. Notes inside fenced code are code, not notes.

export type NoteKind = "Q" | "E" | "?" | "A";
export type NoteSyntax = "html" | "obsidian";

export interface Note {
  kind: NoteKind;
  /** The note text, on one line (a multi-line comment is joined with single spaces). Empty for "?". */
  text: string;
  syntax: NoteSyntax;
  /** First and last line of the note in the file, 0-based, inclusive. */
  start: number;
  end: number;
  /** The last non-blank, non-note line above the note's run: the end of the block it is about. -1 at the top of the file. */
  anchor: number;
  /** For an answer: index into the notes array of the note it answers, or null. */
  parent: number | null;
}

export interface NoteThread {
  note: Note;
  answers: Note[];
}

export interface Line {
  /** The line without its terminator. */
  body: string;
  /** "\n", "\r\n", or "" for a last line with no terminator. */
  eol: string;
}

const OPEN: Record<NoteSyntax, [string, string]> = { html: ["<!--", "-->"], obsidian: ["%%", "%%"] };
const MAX_SPAN = 40; // a multi-line note longer than this is not treated as a note

export function splitLines(text: string): Line[] {
  const out: Line[] = [];
  const re = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0] === "" && m.index >= text.length) break;
    out.push({ body: m[1], eol: m[2] });
    if (m.index + m[0].length >= text.length) break;
  }
  return out;
}

export function joinLines(lines: Line[]): string {
  return lines.map((l) => l.body + l.eol).join("");
}

/** Which lines are inside a fenced code block (including the fence lines themselves). */
function fencedLines(lines: Line[]): boolean[] {
  const inside = new Array<boolean>(lines.length).fill(false);
  let fence: { ch: string; len: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i].body);
    if (fence) {
      inside[i] = true;
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len && m[2].trim() === "") fence = null;
    } else if (m && !(m[1][0] === "`" && m[2].includes("`"))) {
      inside[i] = true;
      fence = { ch: m[1][0], len: m[1].length };
    }
  }
  return inside;
}

const KIND_RE = /^(Q|E|A)\s*:\s?(.*)$/s;

/** Parse the text between the comment delimiters. Returns null if it is not a note. */
function parseInner(inner: string): { kind: NoteKind; text: string } | null {
  const t = inner.trim();
  if (t === "?") return { kind: "?", text: "" };
  // A "?" note may carry words too, such as the text it points at: `<!-- ? [on: "..."] -->`.
  const q = /^\?\s+(\S[\s\S]*)$/.exec(t);
  if (q) return { kind: "?", text: q[1].trim().replace(/\s*\n\s*/g, " ") };
  const m = KIND_RE.exec(t);
  if (!m) return null;
  return { kind: m[1] as NoteKind, text: m[2].trim().replace(/\s*\n\s*/g, " ") };
}

interface Found extends Omit<Note, "anchor" | "parent"> {}

/** Try to read a note that starts on line `i`. Returns it (with its last line) or null. */
function noteAt(lines: Line[], i: number, inFence: boolean[], syntax: NoteSyntax): Found | null {
  const [o, c] = OPEN[syntax];
  const trimmed = lines[i].body.trim();
  if (!trimmed.startsWith(o)) return null;
  const rest = trimmed.slice(o.length);
  const closeAt = rest.indexOf(c);
  if (closeAt !== -1) {
    // Single line: the comment closes on this line, and nothing follows the closer.
    if (closeAt + c.length !== rest.length) return null;
    const parsed = parseInner(rest.slice(0, closeAt));
    return parsed ? { ...parsed, syntax, start: i, end: i } : null;
  }
  // Multi-line: opens here, closes at the end of a later line.
  for (let j = i + 1; j < Math.min(lines.length, i + MAX_SPAN); j++) {
    if (inFence[j]) return null;
    const tj = lines[j].body.trim();
    const k = tj.indexOf(c);
    if (k === -1) continue;
    if (k + c.length !== tj.length) return null;
    const inner = [rest, ...lines.slice(i + 1, j).map((l) => l.body.trim()), tj.slice(0, k)].join("\n");
    const parsed = parseInner(inner);
    return parsed ? { ...parsed, syntax, start: i, end: j } : null;
  }
  return null;
}

function findNotes(lines: Line[]): Found[] {
  const inFence = fencedLines(lines);
  const found: Found[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (inFence[i]) continue;
    const note = noteAt(lines, i, inFence, "html") ?? noteAt(lines, i, inFence, "obsidian");
    if (note) {
      found.push(note);
      i = note.end;
    }
  }
  return found;
}

export function parseNotes(text: string): Note[] {
  const lines = splitLines(text);
  const found = findNotes(lines);
  const notes: Note[] = [];
  let runFirstNonAnswer: number | null = null;
  let anchor = -1;
  let prevEnd = -2;
  for (const f of found) {
    // A run continues while only blank lines separate notes.
    const gapBlank = prevEnd >= 0 && lines.slice(prevEnd + 1, f.start).every((l) => l.body.trim() === "");
    if (!gapBlank) {
      anchor = f.start - 1;
      while (anchor >= 0 && lines[anchor].body.trim() === "") anchor--;
      runFirstNonAnswer = null;
    }
    let parent: number | null = null;
    if (f.kind === "A") parent = runFirstNonAnswer;
    else runFirstNonAnswer = notes.length;
    notes.push({ ...f, anchor, parent });
    prevEnd = f.end;
  }
  return notes;
}

export function threads(notes: Note[]): NoteThread[] {
  const out: NoteThread[] = [];
  const byIndex = new Map<number, NoteThread>();
  notes.forEach((n, i) => {
    if (n.kind !== "A") {
      const t = { note: n, answers: [] };
      byIndex.set(i, t);
      out.push(t);
    } else if (n.parent !== null) byIndex.get(n.parent)?.answers.push(n);
  });
  return out;
}

/** Notes (Q, E, ?) that have no answer yet. */
export function openNotes(notes: Note[]): Note[] {
  return threads(notes).filter((t) => t.answers.length === 0).map((t) => t.note);
}

/** The source with note lines removed, plus for each remaining line the original line number it came from. */
export function stripNotes(text: string): { text: string; lineMap: number[] } {
  const lines = splitLines(text);
  const drop = new Set<number>();
  for (const n of findNotes(lines)) for (let i = n.start; i <= n.end; i++) drop.add(i);
  const kept: Line[] = [];
  const lineMap: number[] = [];
  lines.forEach((l, i) => {
    if (!drop.has(i)) {
      kept.push(l);
      lineMap.push(i);
    }
  });
  return { text: joinLines(kept), lineMap };
}

function render(kind: NoteKind, body: string, syntax: NoteSyntax): string {
  const [o, c] = OPEN[syntax];
  const clean = body.replace(/\s*[\r\n]+\s*/g, " ").trim();
  // The closing delimiter cannot appear inside a note; break it so the comment stays one comment.
  const safe = syntax === "html" ? clean.replace(/--(?=>)/g, "-​-").replace(/-->/g, "-- >") : clean.replace(/%%/g, "% %");
  // HTML comments get a space inside the delimiters; Obsidian's %% marks sit tight against the text.
  const pad = syntax === "html" ? " " : "";
  if (kind === "?") return clean ? `${o}${pad}? ${safe}${pad}${c}` : `${o}${pad}?${pad}${c}`;
  return `${o}${pad}${kind}: ${safe}${pad}${c}`;
}

function indentOf(line: Line): string {
  return /^[ \t]*/.exec(line.body)![0];
}

function insertAt(lines: Line[], index: number, noteBody: string, indent: string): Line[] {
  const out = lines.slice();
  const prev = out[index - 1];
  let eol = prev?.eol || "\n";
  if (prev && prev.eol === "") {
    // Inserting after a last line that has no terminator: it gains one, and the new line becomes the unterminated last line.
    out[index - 1] = { body: prev.body, eol };
    out.splice(index, 0, { body: indent + noteBody, eol: "" });
  } else {
    out.splice(index, 0, { body: indent + noteBody, eol });
  }
  return out;
}

/** Where a new note about the block ending at `afterLine` goes: after the block and after any notes already there. */
function insertionIndex(lines: Line[], notes: Note[], afterLine: number): number {
  let idx = afterLine + 1;
  for (const n of notes) if (n.anchor === afterLine && n.end + 1 > idx) idx = n.end + 1;
  return idx;
}

/** Add a note after the block whose last line is `afterLine` (0-based). */
export function insertNote(text: string, afterLine: number, kind: NoteKind, body: string, syntax: NoteSyntax = "html"): string {
  const lines = splitLines(text);
  if (afterLine < -1 || afterLine >= lines.length) throw new RangeError(`line ${afterLine} is outside the file`);
  const notes = parseNotes(text);
  const idx = insertionIndex(lines, notes, afterLine);
  const indent = afterLine >= 0 ? indentOf(lines[afterLine]) : "";
  return joinLines(insertAt(lines, idx, render(kind, body, syntax), indent));
}

/** Write an answer directly under the note at `notes[noteIndex]` (after its existing answers). */
export function insertAnswer(text: string, notes: Note[], noteIndex: number, body: string, syntax?: NoteSyntax): string {
  const lines = splitLines(text);
  const target = notes[noteIndex];
  let end = target.end;
  notes.forEach((n) => {
    if (n.kind === "A" && n.parent === noteIndex && n.end > end) end = n.end;
  });
  return joinLines(insertAt(lines, end + 1, render("A", body, syntax ?? target.syntax), indentOf(lines[target.start])));
}

/** Replace the text (and optionally the kind) of one note. Only the note's own lines change. */
export function editNote(text: string, note: Note, body: string, kind: NoteKind = note.kind): string {
  const lines = splitLines(text);
  const first = lines[note.start];
  const last = lines[note.end];
  const replacement: Line = { body: indentOf(first) + render(kind, body, note.syntax), eol: last.eol };
  lines.splice(note.start, note.end - note.start + 1, replacement);
  return joinLines(lines);
}

/** Remove one note's lines. If it was the unterminated last line, the line above stops being terminated too. */
export function deleteNote(text: string, note: Note): string {
  const lines = splitLines(text);
  const wasLastUnterminated = note.end === lines.length - 1 && lines[note.end].eol === "";
  lines.splice(note.start, note.end - note.start + 1);
  if (wasLastUnterminated && lines.length && note.start > 0) lines[lines.length - 1] = { body: lines[lines.length - 1].body, eol: "" };
  return joinLines(lines);
}
