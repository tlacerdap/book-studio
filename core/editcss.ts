// The book's print stylesheet, made fit to style the visual editor: the page-only parts are dropped (page boxes, fonts the app
// already loads, print media) and the rules for the document itself are pointed at the editor's container instead.

/** Split CSS into its top-level rules (each with its braces), keeping comments out. */
function topLevel(css: string): string[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        rules.push(clean.slice(start, i + 1).trim());
        start = i + 1;
      }
    } else if (c === ";" && depth === 0) {
      rules.push(clean.slice(start, i + 1).trim());
      start = i + 1;
    }
  }
  return rules.filter(Boolean);
}

const DROP = /^@(page|font-face|import|charset)\b/i;

/** `html`, `body` and `:root` all become the editor's container. */
function retarget(selector: string): string {
  return selector
    .split(",")
    .map((s) => {
      const t = s.trim();
      if (t === "html" || t === "body" || t === ":root" || t === "html body") return ":host";
      return t.replace(/^(html|body|:root)\s+/, ":host ");
    })
    .join(", ");
}

export function editorCss(css: string): string {
  const out: string[] = [];
  for (const rule of topLevel(css)) {
    if (DROP.test(rule)) continue;
    if (/^@media\b/i.test(rule)) {
      // Rules for print are not for a screen; others are kept as they are.
      if (/^@media[^{]*\bprint\b/i.test(rule)) continue;
      out.push(rule);
      continue;
    }
    if (rule.startsWith("@")) continue;
    const brace = rule.indexOf("{");
    if (brace < 0) continue;
    out.push(`${retarget(rule.slice(0, brace))} ${rule.slice(brace)}`);
  }
  return out.join("\n");
}
