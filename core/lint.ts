// Mechanical checks for chapter files. Port of extras/lint_chapters.py, kept unchanged for now.
//
// BOOK-SPECIFIC. These rules (template headings, banned terms, the PROGRESS.md chapter map) belong to one author's own
// style guide, not to Book Studio. Most books will not use this command; the `rules` setting in book.yaml is the general way.

import fs from "node:fs";
import path from "node:path";
import { chapterFiles, type BookConfig } from "./config.ts";

const HEADINGS = ["Why this matters", "Core concepts", "In practice", "Common mistakes", "Interview angle", "Key takeaways", "Go deeper"];

// variant -> canonical (case-sensitive substring checks on prose, code blocks stripped)
const BANNED: Record<string, string> = {
  "LLM judge": "LLM-as-a-judge",
  "LLM as a judge": "LLM-as-a-judge",
  "vector DB": "vector database",
  vectordb: "vector database",
  "function calling": "tool calling",
  "open source model": "open-weights model",
  Langgraph: "LangGraph",
  Langchain: "LangChain",
  Fastapi: "FastAPI",
  PGVector: "pgvector",
  "Prompt Engineering": "prompt engineering",
  "evals ": "evaluation (or 'eval suite')",
};

const FILLER = ["In today's", "in today's", "fast-paced", "game-changer", "game changer", "delve", "leverage "];
const stripCode = (text: string) => text.replace(/```[\s\S]*?```/g, "");
const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
const count = (text: string, ch: string) => text.split(ch).length - 1;

function plannedNames(book: BookConfig): Set<string> {
  const file = path.join(book.root, "PROGRESS.md");
  if (!fs.existsSync(file)) throw new Error(`${file} does not exist; the chapter lint reads the planned chapter files from it`);
  const out = new Set<string>();
  for (const m of fs.readFileSync(file, "utf8").matchAll(/`chapters\/(\d\d-ch[\w-]+\.md)`/g)) out.add(m[1]);
  return out;
}

export function lintChapter(text: string, planned: Set<string>): string[] {
  const prose = stripCode(text);
  const problems: string[] = [];

  const n = words(text);
  if (n < 1900 || n > 4100) problems.push(`word count ${n} outside 2,000-4,000 (tolerance 100)`);

  for (const [ch, name] of [["\u2014", "em dash"], ["\u2013", "en dash"]] as const) {
    const c = count(text, ch);
    if (c) problems.push(`${c} ${name}(s)`);
  }
  if (/^\s*\|.*\|\s*$/m.test(prose)) problems.push("markdown table detected");

  const lines = text.split(/\r?\n/);
  let inFence = false;
  lines.forEach((line, i) => {
    if (line.trimStart().startsWith("```")) {
      if (!inFence && line.trim() === "```") problems.push(`line ${i + 1}: code fence without a language tag (use text for output)`);
      inFence = !inFence;
    }
  });
  if (!lines.length || !/^# Chapter [\d.]+ - /.test(lines[0])) problems.push("H1 must start with '# Chapter N - '");
  const tag = lines.slice(1, 6).find((l) => l.startsWith("Level:"));
  if (!tag || !/^Level: \[[BIA]( to [BIA])?\] \| Priority: \[(Core|Plus)\]$/.test(tag)) problems.push(`bad tag line: ${tag === undefined ? "None" : JSON.stringify(tag)}`);

  const h2 = [...prose.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  if (JSON.stringify(h2) !== JSON.stringify(HEADINGS)) problems.push(`H2 headings/order wrong: [${h2.map((h) => `'${h}'`).join(", ")}]`);

  const qs = [...prose.matchAll(/^\s*-?\s*\*\*Q:\*\*/gm)].length;
  if (qs < 2 || qs > 4) problems.push(`interview questions: ${qs} (want 2-4)`);

  const takeaways = /## Key takeaways\n([\s\S]*?)(?=\n## )/.exec(prose);
  if (takeaways) {
    const k = [...takeaways[1].matchAll(/^\s*[-*] /gm)].length;
    if (k > 5) problems.push(`${k} key takeaways (max 5)`);
  }

  const bridges = [...prose.matchAll(/^### Bridge:.*$/gm)].map((m) => m[0]);
  for (const b of bridges) if (!/\(Handbook ch \d+\)$/.test(b)) problems.push(`bridge heading format: ${b}`);
  const fulls = [...prose.matchAll(/^Full treatment: Handbook ch \d+\.$/gm)].length;
  if (fulls !== bridges.length) problems.push(`${bridges.length} bridges but ${fulls} 'Full treatment' lines`);

  for (const target of new Set([...text.matchAll(/\]\((\d\d-ch[\w-]+\.md)\)/g)].map((m) => m[1]))) {
    if (!planned.has(target)) problems.push(`link to unknown chapter file: ${target}`);
  }
  for (const [bad, good] of Object.entries(BANNED)) if (prose.includes(bad)) problems.push(`term variant '${bad}' -> use ${good}`);
  for (const needle of FILLER) if (prose.includes(needle)) problems.push(`filler phrase: '${needle}'`);
  return problems;
}

export interface LintResult {
  file: string;
  words: number;
  problems: string[];
}

export function lintBook(book: BookConfig, files?: string[]): LintResult[] {
  const planned = plannedNames(book);
  return (files?.length ? files.map((f) => path.resolve(f)) : chapterFiles(book)).map((file) => {
    const text = fs.readFileSync(file, "utf8");
    return { file: path.basename(file), words: words(text), problems: lintChapter(text, planned) };
  });
}

export function formatLint(results: LintResult[]): string {
  const out: string[] = [];
  for (const r of results) {
    out.push(`${r.problems.length ? "FAIL" : "OK  "} ${r.file} (${r.words} words)`);
    for (const p of r.problems) out.push(`     - ${p}`);
  }
  return out.join("\n");
}
