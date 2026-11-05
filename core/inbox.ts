// Every note of a chapter as one list entry, for the notes inbox.

import { parseNotes, threads, type NoteKind } from "./notes.ts";
import { splitQuote } from "./notemap.ts";

export interface InboxNote {
  kind: Exclude<NoteKind, "A">;
  /** What the reader wrote, without the words it points at. */
  body: string;
  /** The words the note points at, if it points at any. */
  quote: string | null;
  /** Claude's answers, oldest first. A note with none is open. */
  answers: string[];
  /** 0-based line where the note starts, and the last line of the block it is about. */
  line: number;
  anchor: number;
}

export function inboxNotes(text: string): InboxNote[] {
  return threads(parseNotes(text)).map((t) => {
    const { body, quote } = splitQuote(t.note.text);
    return { kind: t.note.kind as InboxNote["kind"], body, quote, answers: t.answers.map((a) => a.text), line: t.note.start, anchor: t.note.anchor };
  });
}
