import { describe, expect, it } from "vitest";
import { allCards, cardId, cardsFromText, dueCards, review } from "../core/study.ts";
import { inboxNotes } from "../core/inbox.ts";

const chapter = `# Chapter 2 - Python

## In the interview

**Q:** I know Java. How does Python OOP differ?
**A:** Python has no private keyword. A leading underscore means "internal".
It also has properties.

**Cue line: Underscore, property.**

**Q:** A function with \`items=[]\` misbehaves. Why?
**A:** A default is created once.
<!-- E: remove this [on: "x"] -->
<!-- A: done -->

A second paragraph of the answer.

**Cue line: Created once, shared.**

**Q:** No answer follows this one.

**Rapid-fire drill, 2 questions.**

- **1. What does calling an \`async def\` give you?** A coroutine; nothing runs until awaited.
- **2. What is \`gather\`?** It waits for several
  and collects the results.

\`\`\`text
**Q:** inside code is not a card
**A:** nope
\`\`\`
`;

describe("cards from the book", () => {
  const cards = cardsFromText(chapter);
  it("reads interview answers with their cue lines", () => {
    expect(cards[0]).toMatchObject({ kind: "interview", front: "I know Java. How does Python OOP differ?", cue: "Underscore, property." });
    expect(cards[0].back).toBe('Python has no private keyword. A leading underscore means "internal". It also has properties.');
  });
  it("keeps a second paragraph and ignores notes inside the answer", () => {
    expect(cards[1].back).toBe("A default is created once.\n\nA second paragraph of the answer.");
    expect(cards[1].cue).toBe("Created once, shared.");
  });
  it("reads the drill lines, with wrapped ones", () => {
    const drill = cards.filter((c) => c.kind === "drill");
    expect(drill.map((c) => c.front)).toEqual(["What does calling an `async def` give you?", "What is `gather`?"]);
    expect(drill[1].back).toBe("It waits for several and collects the results.");
  });
  it("skips a question with no answer and anything in code", () => {
    expect(cards.length).toBe(4);
  });
  it("gives the same id when only punctuation or case changes", () => {
    expect(cardId("What is gather?")).toBe(cardId("what is  GATHER"));
    expect(cardId("a")).not.toBe(cardId("b"));
  });
});

describe("cards from notes, and the inbox", () => {
  const text = `# T\n\nA block of text.\n<!-- Q: why a set? [on: "a set"] -->\n<!-- A: done - because it is fast -->\n\nAnother block.\n<!-- E: tighten this -->\n\nThird.\n<!-- ? -->\n`;
  it("makes a card of an answered question", () => {
    const c = allCards(text);
    expect(c.length).toBe(1);
    expect(c[0]).toMatchObject({ kind: "note", front: 'why a set?\n\nAbout: "a set"', back: "because it is fast" });
  });
  it("lists every note with its answers", () => {
    const n = inboxNotes(text);
    expect(n.map((x) => [x.kind, x.body, x.quote, x.answers.length])).toEqual([["Q", "why a set?", "a set", 1], ["E", "tighten this", null, 0], ["?", "", null, 0]]);
    expect(n[0].anchor).toBe(2);
  });
});

describe("remembering cards", () => {
  it("moves a card up a box when known, and back to the start when missed", () => {
    expect(review(undefined, true, 100)).toEqual({ box: 1, due: 101 });
    expect(review({ box: 3, due: 0 }, true, 100)).toEqual({ box: 4, due: 116 });
    expect(review({ box: 3, due: 0 }, false, 100)).toEqual({ box: 0, due: 100 });
  });
  it("offers what is due first, then what is new, never what is waiting", () => {
    const cards = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
    const progress = { a: { box: 2, due: 90 }, b: { box: 3, due: 120 }, c: { box: 1, due: 95 } };
    expect(dueCards(cards, progress, 100).map((c) => c.id)).toEqual(["a", "c", "d"]);
  });
});
