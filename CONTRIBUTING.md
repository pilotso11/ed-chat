# Contributing to ED Chat

Contributions are welcome: bug reports, ideas, and pull requests. Open an
[issue](https://github.com/pilotso11/ed-chat/issues) to report a problem or suggest a
feature, or a pull request with a change.

## Development

ED Chat is an Electron app in TypeScript, with React for the windows.

```bash
npm ci
npm run dev      # the app, with the windows reloading on change
npm run check    # typecheck, format check and unit tests with coverage
npm run build    # build the app into out/
```

`src/core` holds the logic, with no Electron in it, so the unit tests cover it directly.
`src/main` is Electron's main process, `src/preload` the bridge to the windows, and
`src/renderer` the chat window and the activity panel. Design notes and plans are in
`docs/superpowers/`.

## Pull requests

`main` accepts changes only through pull requests. A pull request needs the CI checks to
pass and one approving review, with every review thread resolved. Use
[Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`),
since release-please builds the changelog from them.

## Tests

- `npm run check`: typecheck, format check, and the unit tests with coverage. It fails if
  coverage of `src/core` or of the React components drops below the minimums in
  `vitest.config.ts`. The HTML report is in `coverage/`.
- The tests in `test/renderer` render the chat window and the activity panel with React Testing
  Library in jsdom, with a fake `window.overlay` in place of the preload API. They push views in
  as main does, and check what the windows show and what they send back to main.
- `npm run test:e2e`: builds the app, then runs the Playwright tests in `e2e/`. They start
  ED Chat in Electron with a fake Claude CLI and temporary folders, so they do not touch your
  settings, your journal or your Claude login. Its windows do show on screen, over whatever is
  in front, so the tests refuse to run while Elite is running; set `E2E_FORCE=1` to run them
  anyway. `npm run check` does not run them.

CI runs `npm run check`, builds and packages the app (without the installers, which only the
release workflow builds), then runs the Playwright tests, and shows the coverage summary on
each run. The release workflow attaches `coverage.json`
(from `scripts/coverage-badge.ts`) to each release, and the README's coverage badge reads it from
the latest release, so CI commits and publishes nothing for it.

## Activity panel pictures

The README's panel pictures are the app's own panel, built from moments in real journals.
`scripts/hud-scenes.ts` replays each scene in `docs/images/hud-scenes.json` through
ed-mcp's journal reader and builds the panel, and `scripts/hud-screenshots.cjs` renders
it in the panel's own page. The usage is at the top of each script. Not every scene is a README
picture: some (a build plan, plans with stop actions) are there to check a change.

To show that a change does not change how the panels look, render the scenes from `main` (in
another worktree) and from the branch at about the same time, since the scenes read Spansh's live
data and the time, then compare them with `scripts/hud-compare.cjs`. It compares each scene's
view and pixels, and can compare a scene with another, such as a plan with stop actions with the
same plan with cargo only (`hud-trade-actions=hud-trade`).

## Releases

Release-please opens a release PR from the commits on `main`. Merge it to tag the
release; the workflow then builds the installer and attaches it.

Release-please acts as a GitHub App that belongs to the repository owner and is
installed on this repository only, with read and write access to Contents, Pull
requests and Issues. Its release PR runs CI, which a PR made with `GITHUB_TOKEN`
does not, and GitHub signs the commits it makes. The release workflow names the
app by its Client ID, and its private key is the repository secret
`RELEASE_APP_KEY`. The key does not expire; to replace it, generate a new one in
the app's settings and set it with `gh secret set RELEASE_APP_KEY < key.pem`.

## Code signing

The files on GitHub Releases are not code signed. The `.exe` is the installer
described in the README's Getting started. The `.appx` is the package for the Microsoft Store and
is not meant to be installed directly; the Store signs it when it publishes it.
For a signed install, use the
[Microsoft Store](https://apps.microsoft.com/detail/9PL5FNGQRJX8).
