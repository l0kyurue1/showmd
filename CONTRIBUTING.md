# Contributing to showmd

Thanks for looking. showmd is early and solo-maintained, so the architecture still
moves between releases. Bug reports and small fixes are the most useful things you
can send; larger features are worth an issue before you write code.

## Report a bug

Search [existing issues](https://github.com/l0kyurue1/showmd/issues) first. A good report includes:

- showmd version (`showmd --version`) and Node version
- operating system and browser
- steps to reproduce, ideally against a markdown file you can share
- what you expected, and what actually happened
- a screenshot or recording if the problem is visual

Do not paste API keys, tokens, or private document contents into a public issue. For a
security vulnerability, use GitHub's private vulnerability reporting on this repository
instead of opening a public issue.

## Request a feature

Open an issue describing the problem and the workflow you want to support, not just the
feature you have in mind: the underlying need is usually the more useful half. showmd
deliberately stays small (one runtime dependency, no framework, localhost only), so
some requests will be declined on scope rather than merit.

Documentation fixes need no issue. Send the PR.

## Where to contribute

showmd stays small in depth but grows in breadth. These axes are open and most
additions are a single registry entry:

- **Platforms**: app and file-association integrations for more OSes and
  tools live in `contrib/` and `server/install-app.js`.
- **Agents**: teach showmd a new coding agent. Skill detection is one line in
  `server/agent-registry.js`; config and memory browsing is one entry in
  `server/agent-config.js` (markdown files only).
- **Languages**: syntax highlighting ships highlight.js's common bundle;
  register more languages in `client/hljs-src.js`.

Registry entries need no issue first. Anything structural, open one.

## Pull requests

- **Bug fixes, typos, and docs**: open a PR directly.
- **Features and behavior changes**: open an issue first and wait for a reply. Pre-1.0, a feature that conflicts with a planned direction may be declined after it is written, which is a waste of your time and mine.
- Keep PRs small and focused. Don't bundle unrelated refactors.
- Explain the problem and your solution in the description.
- `npm test` must pass. It builds nothing and needs no network.
- New dependencies need a reason in the PR description. showmd ships with exactly one (`chokidar`).

## Development setup

```sh
git clone https://github.com/l0kyurue1/showmd.git
cd showmd
npm install
npm test                  # guards, lint, typecheck, unit, integration, platform, e2e
node bin/cli.js .         # run it against this repo
```

`npm run test:unit` is the fast loop to iterate against (no server boot or real
OS tools); run the full `npm test` before opening a PR.

Single test file: `node --test test/unit/<name>.test.mjs`.

### Test lanes and value

- `test/unit` is the fast unit + component lane. It may use a temporary
  filesystem or isolated Git repository, but not a ShowMD server, socket,
  external network, real user state, OS application/tool, or bare sleep.
- `test/integration` boots the localhost HTTP server and proves behavior across
  server modules without touching external services or real user state.
- `test/platform` executes real OS tools and applications. Each case must be
  explicitly gated to the operating systems that can prove it.
- `test/e2e` spawns the shipped CLI and is reserved for process/CLI boundaries.

A new test must name a realistic production regression that the current suite
would miss. Prefer the cheapest boundary that detects it. Do not duplicate
centralized middleware per endpoint, re-test a pure classifier through a real
platform install, assert private structure or mock calls without an observable
outcome, rely on arbitrary sleeps, or retain tests for dead/pass-through code.
The detailed audit and examples live in
[`docs/test-audit-2026-08-11.md`](docs/test-audit-2026-08-11.md).

## Design and color changes

Colors are token-only: every visual value lives in the `:root` block of
`client/app.css`, and `test/lint/css-guard.mjs` fails the build on an inlined hex. Use the
`?lab` palette workbench for color work.

The only exception is the print page counter: Chromium page-margin boxes do not
reliably resolve custom properties and remap their colors during PDF output.
`client/print.css` may use only the calibrated literal explicitly allowlisted by
`test/lint/css-guard.mjs`; do not reuse it elsewhere or add new ones without
verifying the generated PDF.

Full rules, contrast targets, and the icon pipeline: **[docs/design.md](docs/design.md)**.

## Domain language

[CONTEXT.md](CONTEXT.md) defines the terms this project uses for its own parts: Read
Mode, Edit Mode, Block Renderer, Variable Contract, History. Use them in code, comments,
and PRs, and prefer them over the alternatives listed there.
