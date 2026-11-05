// Just enough markdown to show a card or a note: paragraphs, `code`, **bold** and *italic*. Built as DOM nodes, never as HTML.

import { h } from "./dom.ts";

const TOKEN = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)/g;

export function inline(text: string): (Node | string)[] {
  const out: (Node | string)[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(h("code", {}, m[1].slice(1, -1)));
    else if (m[2]) out.push(h("strong", {}, m[2].slice(2, -2)));
    else out.push(h("em", {}, m[3].slice(1, -1)));
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Paragraphs (separated by a blank line) of inline markdown. */
export function paragraphs(text: string): HTMLElement[] {
  return text
    .split(/\n{2,}/)
    .filter((p) => p.trim())
    .map((p) => h("p", {}, ...inline(p.replace(/\n/g, " "))));
}
