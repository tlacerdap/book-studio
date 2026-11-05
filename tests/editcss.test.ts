import { describe, expect, it } from "vitest";
import { editorCss } from "../core/editcss.ts";

describe("editorCss", () => {
  const css = `
@font-face { font-family: "X"; src: url(x.ttf); }
@page { size: A4; @bottom-center { content: counter(page); } }
:root { --a: 1pt; }
html { font-size: 12pt; }
body { margin: 0; }
h1, html h2 { color: red; }
/* comment { not a rule } */
.chapter p { margin: 0; }
@media print { p { color: black; } }
@media (min-width: 10px) { p { color: blue; } }
`;
  const out = editorCss(css);
  it("drops page boxes, fonts and print rules", () => {
    expect(out).not.toMatch(/@page|@font-face|counter\(page\)|color: black/);
  });
  it("points html, body and :root at the host", () => {
    expect(out).toContain(":host { --a: 1pt; }");
    expect(out).toContain(":host { font-size: 12pt; }");
    expect(out).toContain(":host { margin: 0; }");
    expect(out).toContain("h1, :host h2 { color: red; }");
  });
  it("keeps the rules for the content, and other media", () => {
    expect(out).toContain(".chapter p { margin: 0; }");
    expect(out).toContain("@media (min-width: 10px)");
  });
});
