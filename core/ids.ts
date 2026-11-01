// Small shared helpers that the app window and the engine both need, kept apart so the window does not load the markdown engine.

/** The id a chapter file's `<article>` gets, and the target of links to it. */
export function chapterId(fileName: string): string {
  const stem = fileName.replace(/\.[^.]*$/, "").toLowerCase();
  return "ch-" + stem.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
