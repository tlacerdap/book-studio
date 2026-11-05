import { describe, expect, it } from "vitest";
import { searchFiles } from "../core/search.ts";

const CH1 = `# Chapter 1 - Embeddings and search

## In one sentence

An **embedding** turns text into numbers. Search compares the numbers.
<!-- Q: what is an embedding? [on: "embedding"] -->

## How it works

1. First, the "embedding model" reads the text.
2. Then a vector database finds the nearest vectors.

\`\`\`python
def embed(text):
    return model.embed(text)   # embedding call
\`\`\`

A [link to chapter two](02-ch02.md) and https://example.com/embedding-guide are here.
`;

const CH2 = `# Chapter 2 - Retrieval

## In one sentence

Retrieval finds passages. Nothing about numbers here.
`;

describe("book-wide search", () => {
  const files = [
    { file: "01-ch01.md", text: CH1 },
    { file: "02-ch02.md", text: CH2 },
  ];

  it("finds words in the page text, whatever the markdown marks around them", () => {
    const r = searchFiles(files, "embedding");
    expect(r.chapters.map((c) => c.file)).toEqual(["01-ch01.md"]);
    // title, the bold word, the quoted "embedding model", the code comment, the printed address: not the note, not the link target
    const c = r.chapters[0];
    expect(c.hits.map((h) => h.ordinal)).toEqual([-1, 0, 1, 2, 3]);
    expect(c.hits[1].match).toBe("embedding");
    expect(c.hits[1].before.endsWith("An ")).toBe(true);
  });

  it("is case-insensitive and ignores typography and runs of spaces", () => {
    expect(searchFiles(files, "EMBEDDING   MODEL").total).toBe(1);
    expect(searchFiles(files, 'the "embedding model" reads').total).toBe(1);
  });

  it("gives the line of each match in the original file, notes included in the count", () => {
    const hit = searchFiles(files, "nearest vectors").chapters[0].hits[0];
    expect(hit.line).toBe(CH1.split("\n").findIndex((l) => l.includes("nearest vectors")) + 1);
    const inCode = searchFiles(files, "model.embed").chapters[0].hits[0];
    expect(inCode.line).toBe(CH1.split("\n").findIndex((l) => l.includes("model.embed")) + 1);
  });

  it("knows which section a match is in", () => {
    expect(searchFiles(files, "nearest vectors").chapters[0].hits[0].section).toBe("How it works");
  });

  it("never finds the text of a note, nor a link's target", () => {
    expect(searchFiles(files, "what is an").total).toBe(0);
    expect(searchFiles(files, "02-ch02").total).toBe(0);
  });

  it("finds a chapter's title as its own kind of match", () => {
    const hit = searchFiles(files, "retrieval").chapters.find((c) => c.file === "02-ch02.md")!;
    expect(hit.hits[0]).toMatchObject({ ordinal: -1, section: "Chapter title" });
    expect(hit.hits.map((h) => h.ordinal)).toEqual([-1, 0]);
  });

  it("gives words around a match that tell two occurrences apart", () => {
    const hits = searchFiles(files, "numbers").chapters.map((c) => c.hits.map((h) => h.ctx)).flat();
    expect(new Set(hits).size).toBe(hits.length);
  });

  it("ignores a query that is too short or empty", () => {
    expect(searchFiles(files, "e").total).toBe(0);
    expect(searchFiles(files, "   ").total).toBe(0);
  });
});
