# AGENTS.md

showmd — Read and edit markdown in your browser.

Localhost markdown server: rendered Read Mode, CodeMirror-based Edit Mode,
git-backed save history, and an agent-skills browser (`showmd skills`).

## Commands

- `npm test` — full suite (CSS guard, unit, integration, e2e, pack guard)
- `npm run test:unit` — fast unit loop only (no server boot), use this while iterating
- `npm run build` — bundle client editor + vendor assets into `client/dist/`
- `node bin/cli.js SAMPLE.md --no-open` — run locally
- Single test file: `node --test test/unit/<name>.test.mjs`

## Layout

- `bin/cli.js` — CLI entry
- `server/` — server-side modules (`server.js`, `history.js`, `documents.js`,
  `skills.js`, `dirhash.js`, `agent-registry.js`, `install-skill.js`, `reveal.js`)
- `client/` — browser code; `client/dist/` is generated — never edit it
- `skills/showmd/SKILL.md` — the agent skill shipped with the package
- `test/` — `test/unit/` (pure functions, no server boot), `test/unit/client/`
  (browser modules), `test/integration/` (HTTP server tests), `test/e2e/`
  (spawns the real CLI: smoke, CLI flags, skills mode), `test/lint/`
  (CSS guard, pack guard)
- `CONTEXT.md` — architecture notes; `CONTRIBUTING.md` — dev setup and CSS rules

## Conventions

- Vanilla JS, no framework. Server code is `'use strict'` CommonJS; tests are ESM.
- Single runtime dependency (`chokidar`) — do not add dependencies casually.
- CSS changes must respect the CSS Variable Contract (see CONTRIBUTING.md);
  use the `?lab` palette workbench for color work.

Run `npm test` before claiming any change done.
