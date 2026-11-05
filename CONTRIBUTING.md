# Contributing

Thanks for wanting to help. Book Studio is a small project; the goal is a calm, offline tool for writing books in markdown.

## Set up

You need Node.js 22.12 or newer.

```bash
git clone https://github.com/tlacerdap/book-studio.git
cd book-studio
npm install
npm start          # builds and opens the app
npm test           # vitest: the automated tests
npm run typecheck  # TypeScript
```

## How the code is laid out

See the *Layout* section of the [README](README.md#layout). In short: `core/` is shared by the command line and the app, `app/` is the
Electron app (`main/` for files and windows, `renderer/` for the interface), `styles/` is the typography shared by the screen and the PDF.

## Ground rules

- **Everything stays free and offline.** No paid services, no API keys, no telemetry, nothing downloaded when the app runs. A new dependency
  must have a permissive open-source licence (MIT, ISC, BSD, Apache-2.0 and similar); run `npm run notices` and commit the updated
  `THIRD_PARTY_LICENSES.md`.
- **Never change a file the writer did not touch.** Saving must leave every byte they did not edit exactly as it was (see `core/notes.ts`,
  `core/pm/markdown.ts` and their tests). A change that reformats a chapter is a bug.
- **Add a test** for behaviour you add or fix. Tests that drive the real app live outside the repo today; unit tests go in `tests/`.
- Keep the interface plain: short sentences, no jargon, nothing that needs a manual.

## Sending a change

Open an issue first for anything big. For a fix, a pull request with a short description and the test is perfect. By contributing you agree
that your contribution is released under the MIT licence.
