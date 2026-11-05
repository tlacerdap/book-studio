// Diagrams written as text (```mermaid blocks) and drawn by the app. Drawing needs a browser, so the app draws each
// diagram once, keeps the picture, and the page builders look the picture up by the diagram's text.

import crypto from "node:crypto";

export interface DrawnDiagram {
  /** The picture as an SVG document, with a fixed size. */
  svg?: string;
  /** Why it could not be drawn, when it could not. */
  error?: string;
}

/** Finds a drawn diagram by its text. Returns null when it has not been drawn yet. */
export type DiagramProvider = (code: string) => DrawnDiagram | null;

let provider: DiagramProvider | null = null;

/** The app installs one; without it (the command line) diagrams are simply left out of the page. */
export function setDiagramProvider(p: DiagramProvider | null): void {
  provider = p;
}

export function getDiagramProvider(): DiagramProvider | null {
  return provider;
}

/** Bump when the way diagrams are drawn changes, so old pictures are drawn again. */
export const DIAGRAM_STYLE_VERSION = "1";

export function diagramKey(code: string): string {
  return crypto.createHash("sha1").update(`${DIAGRAM_STYLE_VERSION}\n${code.trim()}`).digest("hex");
}

/** The text of every ```mermaid block in a chapter. */
export function diagramsIn(text: string): string[] {
  const out: string[] = [];
  const re = /^ {0,3}(`{3,}|~{3,})[ \t]*mermaid[ \t]*\r?\n([\s\S]*?)\r?\n {0,3}\1[`~]*[ \t]*$/gm;
  for (const m of text.matchAll(re)) out.push(m[2]);
  return out;
}

/** Give an SVG an explicit size (from its viewBox), so an <img> knows how big it is; drop the fluid width mermaid writes. */
export function sizeSvg(svg: string): string {
  const vb = /viewBox="\s*[-\d.]+[ ,]+[-\d.]+[ ,]+([\d.]+)[ ,]+([\d.]+)\s*"/.exec(svg);
  if (!vb) return svg;
  const w = Math.ceil(parseFloat(vb[1]));
  const h = Math.ceil(parseFloat(vb[2]));
  return svg
    .replace(/(<svg\b[^>]*?)\swidth="[^"]*"/, "$1")
    .replace(/(<svg\b[^>]*?)\sheight="[^"]*"/, "$1")
    .replace(/(<svg\b[^>]*?)\sstyle="[^"]*"/, "$1")
    .replace(/<svg\b/, `<svg width="${w}" height="${h}"`);
}
