// Flashcards made from the book itself: the interview questions with their answers and cue lines, the rapid-fire drill
// lines, and the reader's own Q notes that Claude has answered. Nothing is stored in the book; cards are read from the text.

import { parseNotes, stripNotes, threads } from "./notes.ts";
import { splitQuote } from "./notemap.ts";

export interface Card {
  /** Stays the same while the question's words stay the same, so progress is kept across edits elsewhere. */
  id: string;
  kind: "interview" | "drill" | "note";
  front: string;
  back: string;
  /** The one-line recall hint under an interview answer. */
  cue: string | null;
  /** 0-based line of the question in the file. */
  line: number;
}

/** A short stable id from the question's words (case and punctuation do not matter). */
export function cardId(front: string): string {
  const norm = front.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  let a = 5381;
  let b = 52711;
  for (let i = 0; i < norm.length; i++) {
    a = ((a * 33) ^ norm.charCodeAt(i)) >>> 0;
    b = ((b * 31) ^ norm.charCodeAt(i)) >>> 0;
  }
  return a.toString(36) + b.toString(36);
}

const Q_START = /^\s*(?:[-*] )?\*\*Q:\*\*\s*(.*)$/;
const A_START = /^\s*(?:[-*] )?\*\*A:\*\*\s*(.*)$/;
const CUE = /^\s*\*\*Cue line:\s*(.+?)\*\*\s*$/;
const DRILL = /^\s*[-*] \*\*(\d+)\.\s+(.+?)\*\*\s+(.+)$/;

/** A paragraph that starts a new thing (a question, a cue line, a heading, a bold lead-in) ends the answer before it. */
const STARTS_NEW = (l: string) => Q_START.test(l) || CUE.test(l) || /^\s*#{1,6} /.test(l) || /^\s*[-*] \*\*/.test(l) || /^\s*\*\*[^*]+\*\*/.test(l);

export function cardsFromText(text: string): Card[] {
  const { text: plain, lineMap } = stripNotes(text);
  const lines = plain.split(/\r?\n/);
  const cards: Card[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) inFence = !inFence;
    if (inFence) continue;
    const q = Q_START.exec(lines[i]);
    if (q) {
      let front = q[1].trim();
      let j = i + 1;
      while (j < lines.length && !A_START.test(lines[j]) && lines[j].trim() !== "" && !Q_START.test(lines[j])) front += ` ${lines[j].trim()}`, j++;
      const a = j < lines.length ? A_START.exec(lines[j]) : null;
      if (!a) continue;
      let back = a[1].trim();
      j++;
      // The rest of the answer: more lines of the same paragraph, then further paragraphs that do not start something new.
      for (;;) {
        while (j < lines.length && lines[j].trim() !== "" && !STARTS_NEW(lines[j])) back += ` ${lines[j].trim()}`, j++;
        let k = j;
        while (k < lines.length && lines[k].trim() === "") k++;
        if (k > j && k < lines.length && !STARTS_NEW(lines[k]) && lines[k].trim() !== "" && !DRILL.test(lines[k])) {
          back += `\n\n${lines[k].trim()}`;
          j = k + 1;
          continue;
        }
        j = k;
        break;
      }
      let cue: string | null = null;
      if (j < lines.length) {
        const c = CUE.exec(lines[j]);
        if (c) cue = c[1].trim();
      }
      if (front && back) cards.push({ id: cardId(front), kind: "interview", front, back, cue, line: lineMap[i] ?? i });
      continue;
    }
    const d = DRILL.exec(lines[i]);
    if (d) {
      let back = d[3].trim();
      let j = i + 1;
      while (j < lines.length && /^\s{2,}\S/.test(lines[j])) back += ` ${lines[j].trim()}`, j++;
      cards.push({ id: cardId(d[2]), kind: "drill", front: d[2].trim(), back, cue: null, line: lineMap[i] ?? i });
    }
  }
  return cards;
}

/** The reader's own questions that have an answer: the question (with the words it pointed at) and what Claude answered. */
export function cardsFromNotes(text: string): Card[] {
  const out: Card[] = [];
  for (const t of threads(parseNotes(text))) {
    if (t.note.kind !== "Q" || !t.answers.length) continue;
    const { body, quote } = splitQuote(t.note.text);
    if (!body) continue;
    const front = quote ? `${body}\n\nAbout: "${quote}"` : body;
    out.push({ id: cardId(body), kind: "note", front, back: t.answers.map((a) => a.text.replace(/^done\s*-\s*/i, "")).join("\n\n"), cue: null, line: t.note.start });
  }
  return out;
}

export function allCards(text: string): Card[] {
  return [...cardsFromText(text), ...cardsFromNotes(text)];
}

// ---- Leitner boxes: a missed card comes back soon, a known card comes back later and later --------

export interface Progress {
  box: number;
  /** Day number (days since 1970) when the card is next due. */
  due: number;
}

/** Days until a card in each box comes back. */
export const INTERVALS = [0, 1, 3, 7, 16, 35];

export function review(p: Progress | undefined, correct: boolean, today: number): Progress {
  const box = correct ? Math.min(INTERVALS.length - 1, (p?.box ?? 0) + 1) : 0;
  return { box, due: today + INTERVALS[box] };
}

/** The cards to go through now: ones never seen first, then the ones that are due, oldest due first. */
export function dueCards<T extends { id: string }>(cards: T[], progress: Record<string, Progress>, today: number): T[] {
  const fresh = cards.filter((c) => !progress[c.id]);
  const due = cards.filter((c) => progress[c.id] && progress[c.id].due <= today).sort((a, b) => progress[a.id].due - progress[b.id].due);
  return [...due, ...fresh];
}
