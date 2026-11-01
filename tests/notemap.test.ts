import { describe, expect, it } from "vitest";
import { blockForLine, insertAfterLine, outline, parseSrc, placeNotes } from "../core/notemap.ts";
import { insertNote, parseNotes, stripNotes } from "../core/notes.ts";

const DOC = ["# Chapter 1 - T", "", "Level: [B] | Priority: [Core]", "", "## Why", "", "First paragraph.", "<!-- Q: why? -->", "<!-- A: because -->", "", "- a", "- b", "", "```python", "x = 1", "```", "", "<!-- E: shorten -->", ""].join("\n");

// Blocks as the renderer reports them: lines of the note-free text.
const blocks = ["4-4", "6-6", "8-9", "11-13"].map(parseSrc);

describe("note placement", () => {
  it("puts each note on the block it follows, whatever block type", () => {
    const { groups } = placeNotes(DOC, blocks);
    expect(groups.map((g) => [g.src, g.threads.length, g.open])).toEqual([
      ["6-6", 1, false], // question with its answer
      ["11-13", 1, true], // edit request after the code block, not yet processed
    ]);
  });

  it("finds the block for a line and the insertion point for a note", () => {
    expect(blockForLine(blocks, 6)?.src).toBe("6-6");
    expect(blockForLine(blocks, 2)).toBeNull();
    const at = insertAfterLine(DOC, "6-6");
    expect(DOC.split("\n")[at]).toBe("First paragraph.");
  });

  it("adds a note after the block and after notes already there, without touching any other line", () => {
    for (const src of ["4-4", "6-6", "8-9", "11-13"]) {
      const after = insertNote(DOC, insertAfterLine(DOC, src), "Q", "new");
      const rest = after.split("\n").filter((l) => l !== "<!-- Q: new -->");
      expect(rest.join("\n")).toBe(DOC);
      expect(stripNotes(after).text).toBe(stripNotes(DOC).text);
      expect(parseNotes(after).filter((n) => n.text === "new")).toHaveLength(1);
    }
  });
});

describe("outline", () => {
  it("lists H2 and H3 outside code, with file line numbers", () => {
    const text = "# T\n\n## One\n\n```md\n## not a heading\n```\n\n### Two\n";
    expect(outline(text)).toEqual([
      { level: 2, title: "One", line: 2 },
      { level: 3, title: "Two", line: 8 },
    ]);
  });
});
