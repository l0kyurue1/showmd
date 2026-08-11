# AGENTS.md

showmd — Read and edit markdown in your browser.

Localhost markdown server: rendered Read Mode, CodeMirror-based Edit Mode,
git-backed save history, an agent-skills browser (`showmd skills`), and an
agent-config browser (`showmd agents`). One process serves several roots at
once, each addressed as its own Space under `/r/<rootKey>/`.

## Commands

- `npm test` — full suite (CSS/pack/proc-seam guards, oxlint, tsc, unit,
  integration, platform, e2e)
- `npm run test:unit` — fast unit + component loop (no server boot or real OS tools)
- `npm run test:platform` — real OS tools/apps, gated per operating system
- `npm run build` — bundle client editor + vendor assets into `client/dist/`
- `node bin/cli.js SAMPLE.md --no-open` — run locally
- Single test file: `node --test test/unit/<name>.test.mjs`

The shipped CLI (`bin/cli.js --help` is the source of truth):

- `showmd [dir|file.md]` — serve a folder or single file
- `showmd skills [all|global|<dir>...]` — browse installed agent skills
- `showmd agents` — show your agent's config/memory
- `showmd prune <dir> | --all` — delete saved history
- `showmd install-app` — add a double-clickable ShowMD app
- `showmd install-skill [--copy]` — teach your agents to use showmd
- Flags: `--port <n>`, `--new` (a dedicated server, not the shared one),
  `--no-open`, `-h`, `-v`

## Layout

- `bin/cli.js` — CLI entry
- `server/` — server-side modules (`server.js`, `history.js`, `documents.js`,
  `skills.js`, `root-identity.js`, `agent-registry.js`, `install-skill.js`, `reveal.js`);
  the Spaces layer is `spaces.js`, `root-manager.js`, `root-runtime.js`,
  `route-context.js`, `route-resolution.js`, `registry.js`, `protocol.js`
- `client/` — browser code; `client/dist/` is generated — never edit it
- `skills/showmd/SKILL.md` — the agent skill shipped with the package
- `test/` — `test/unit/` (fast unit/component tests; temporary filesystems and
  isolated Git repositories are allowed), `test/unit/client/` (browser modules),
  `test/integration/` (localhost HTTP server tests), `test/platform/` (real OS
  tools and applications), `test/e2e/` (spawns the real CLI: smoke, CLI flags,
  skills mode, agents mode), `test/lint/` (CSS, pack, process-seam, lane guards)
- `CONTEXT.md` — architecture notes; `CONTRIBUTING.md` — dev setup and CSS rules

## Conventions

- Vanilla JS, no framework. Server code is `'use strict'` CommonJS; tests are ESM.
- Single runtime dependency (`chokidar`) — do not add dependencies casually.
- CSS changes must respect the CSS Variable Contract (see CONTRIBUTING.md);
  use the `?lab` palette workbench for color work.

## Test policy

- Every new test must protect a concrete production failure mode and use the
  cheapest lane that can detect it.
- `test/unit` must not boot a ShowMD server, bind a socket, inspect real user
  state, invoke OS applications/tools, or wait on bare sleeps. Temporary
  filesystems and isolated Git repositories are allowed when deterministic and
  cleaned up.
- Localhost server behavior belongs in `test/integration`; real OS tools/apps
  belong in `test/platform`; real ShowMD CLI lifecycles belong in `test/e2e`.
- Do not add tests that duplicate an existing behavior at the same or a cheaper
  boundary, repeat centralized middleware per endpoint, assert private
  structure or mock call order without an observable outcome, enumerate
  equivalent inputs without a distinct failure mode, or test dead/pass-through
  code and language behavior.
- Exceptions are appropriate for historical regressions, security boundaries,
  concurrency, migrations, and data-loss risks that cannot be detected more
  cheaply. See `docs/test-audit-2026-08-11.md` for examples and current verdicts.

Run `npm test` before claiming any change done.
