// Formatting commands for the editor, as plain text edits: given the text and the selection, what to replace and what to
// select afterwards. The editor applies the result; nothing here knows about the editor.

export type FormatCommand = "bold" | "italic" | "code" | "h2" | "h3" | "bullets" | "numbers" | "quote" | "link" | "table" | "diagram";

export interface Edit {
  from: number;
  to: number;
  insert: string;
  /** What to select after the change, in the new text. */
  select: { from: number; to: number };
}

const WRAP: Record<"bold" | "italic" | "code", string> = { bold: "**", italic: "*", code: "`" };

const isWord = (c: string | undefined) => !!c && /[\p{L}\p{N}_'-]/u.test(c);

/** The word around a position, when nothing is selected. */
function wordAt(text: string, pos: number): { from: number; to: number } {
  let from = pos;
  let to = pos;
  while (from > 0 && isWord(text[from - 1])) from--;
  while (to < text.length && isWord(text[to])) to++;
  return { from, to };
}

/** True if `marker` stands right before `at` as a mark of its own (a single `*` is not the first half of `**`). */
function markBefore(text: string, at: number, marker: string): boolean {
  if (text.slice(at - marker.length, at) !== marker) return false;
  return marker !== "*" || text[at - 2] !== "*";
}

function markAfter(text: string, at: number, marker: string): boolean {
  if (text.slice(at, at + marker.length) !== marker) return false;
  return marker !== "*" || text[at + 1] !== "*";
}

function wrap(cmd: "bold" | "italic" | "code", text: string, a: number, b: number): Edit {
  const m = WRAP[cmd];
  let from = a;
  let to = b;
  if (from === to) ({ from, to } = wordAt(text, a));
  if (from === to) {
    // Nothing to wrap: leave the marks with the cursor between them.
    return { from, to, insert: m + m, select: { from: from + m.length, to: from + m.length } };
  }
  // Already wrapped, with the marks outside the selection: take them off.
  if (markBefore(text, from, m) && markAfter(text, to, m)) {
    return { from: from - m.length, to: to + m.length, insert: text.slice(from, to), select: { from: from - m.length, to: to - m.length } };
  }
  // Already wrapped, with the marks inside the selection.
  const inner = text.slice(from, to);
  if (inner.length > 2 * m.length && inner.startsWith(m) && inner.endsWith(m) && (m !== "*" || (inner[1] !== "*" && inner[inner.length - 2] !== "*"))) {
    const plain = inner.slice(m.length, inner.length - m.length);
    return { from, to, insert: plain, select: { from, to: from + plain.length } };
  }
  // Keep spaces at the edges of the selection outside the marks.
  const lead = /^\s*/.exec(inner)![0].length;
  const trail = /\s*$/.exec(inner)![0].length;
  const core = inner.slice(lead, inner.length - trail);
  if (!core) return { from, to, insert: m + m, select: { from: from + m.length, to: from + m.length } };
  const insert = inner.slice(0, lead) + m + core + m + inner.slice(inner.length - trail);
  return { from, to, insert, select: { from: from + lead + m.length, to: from + lead + m.length + core.length } };
}

/** The whole lines the selection touches: where they start and end, and their text. */
function lineSpan(text: string, a: number, b: number): { from: number; to: number; lines: string[] } {
  const from = text.lastIndexOf("\n", a - 1) + 1;
  let end = text.indexOf("\n", b > a && text[b - 1] === "\n" ? b - 1 : b);
  if (end < 0) end = text.length;
  return { from, to: end, lines: text.slice(from, end).split("\n") };
}

const LIST_RE = /^(\s*)(?:[-*+] |\d+[.)] |> ?)/;

function heading(level: 2 | 3, text: string, a: number, b: number): Edit {
  const span = lineSpan(text, a, a);
  const line = span.lines[0];
  const prefix = "#".repeat(level) + " ";
  const m = /^(#{1,6}) +/.exec(line);
  const rest = m ? line.slice(m[0].length) : line;
  const next = m && m[1].length === level ? rest : prefix + rest;
  const caret = Math.min(span.from + next.length, span.from + next.length);
  return { from: span.from, to: span.to, insert: next, select: { from: caret, to: caret } };
}

function prefixLines(cmd: "bullets" | "numbers" | "quote", text: string, a: number, b: number): Edit {
  const span = lineSpan(text, a, b);
  const marked = (l: string) => (cmd === "bullets" ? /^\s*[-*+] /.test(l) : cmd === "numbers" ? /^\s*\d+[.)] /.test(l) : /^\s*> ?/.test(l));
  const body = span.lines.filter((l) => l.trim() !== "");
  const remove = body.length > 0 && body.every(marked);
  let n = 0;
  const lines = span.lines.map((l) => {
    if (l.trim() === "") return l;
    if (remove) return l.replace(cmd === "bullets" ? /^(\s*)[-*+] / : cmd === "numbers" ? /^(\s*)\d+[.)] / : /^(\s*)> ?/, "$1");
    const bare = l.replace(LIST_RE, "$1");
    n++;
    return (cmd === "bullets" ? "- " : cmd === "numbers" ? `${n}. ` : "> ") + bare;
  });
  const insert = lines.join("\n");
  return { from: span.from, to: span.to, insert, select: { from: span.from, to: span.from + insert.length } };
}

function link(text: string, a: number, b: number): Edit {
  const chosen = text.slice(a, b);
  if (/^https?:\/\/\S+$/.test(chosen)) {
    const insert = `[link text](${chosen})`;
    return { from: a, to: b, insert, select: { from: a + 1, to: a + 10 } };
  }
  const label = chosen || "link text";
  const insert = `[${label}](url)`;
  const urlFrom = a + label.length + 3;
  return { from: a, to: b, insert, select: { from: urlFrom, to: urlFrom + 3 } };
}

function table(text: string, a: number): Edit {
  const span = lineSpan(text, a, a);
  const atBlank = span.lines[0].trim() === "";
  const before = atBlank ? "" : "\n\n";
  const grid = "| Column | Column |\n| --- | --- |\n|  |  |\n";
  const at = atBlank ? span.from : span.to;
  const insert = before + grid;
  const cell = at + before.length + "| ".length;
  return { from: at, to: at, insert, select: { from: cell, to: cell + "Column".length } };
}

/** A starter diagram, as text: the app draws it. */
function diagram(text: string, a: number): Edit {
  const span = lineSpan(text, a, a);
  const atBlank = span.lines[0].trim() === "";
  const before = atBlank ? "" : "\n\n";
  const at = atBlank ? span.from : span.to;
  const block = "```mermaid\nflowchart LR\n  A[Client] --> B[Server]\n  B --> C[(Database)]\n```\n";
  const insert = before + block;
  const from = at + before.length + "```mermaid\nflowchart LR\n  A[".length;
  return { from: at, to: at, insert, select: { from, to: from + "Client".length } };
}

export function formatEdit(cmd: FormatCommand, text: string, from: number, to: number): Edit {
  const a = Math.min(from, to);
  const b = Math.max(from, to);
  switch (cmd) {
    case "bold":
    case "italic":
    case "code":
      return wrap(cmd, text, a, b);
    case "h2":
      return heading(2, text, a, b);
    case "h3":
      return heading(3, text, a, b);
    case "bullets":
    case "numbers":
    case "quote":
      return prefixLines(cmd, text, a, b);
    case "link":
      return link(text, a, b);
    case "table":
      return table(text, a);
    case "diagram":
      return diagram(text, a);
  }
}

/** Apply an edit to plain text (used by the tests; the editor applies it as a transaction). */
export function applyEdit(text: string, e: Edit): string {
  return text.slice(0, e.from) + e.insert + text.slice(e.to);
}
