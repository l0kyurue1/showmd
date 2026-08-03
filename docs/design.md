# Design system

How showmd's visual layer is built and how to change it. Read this before proposing a
UI, motion, or color change; see [CONTRIBUTING.md](../CONTRIBUTING.md) for the
contribution process itself.

## Principles

House rules, not universal ones. A PR that breaks one should say why.

- **Motion is state, not decoration.** Something moves because it changed, or to show where it went. Durations sit on four steps — `.15s`, `.2s`, `.25s`, `.3s` — chosen by how far a thing travels; `--spring` goes on anything with a position or size, never on a fade. Motion that causes reflow elsewhere is wrong.
- **Status, not interruption.** One persistent save chip carries most feedback. No `alert()`, no `confirm()`, effectively no toasts. Errors appear where the action was.
- **Recoverable beats confirmable.** History is the safety net, so the app doesn't nag: typing never waits on the network, and restore needs no guard because it is just another revision. Only leaving the net — wiping history — earns a dialog.
- **Focus is borrowed, not taken.** Clicking a control shouldn't move the caret; menus give focus back; a re-render shouldn't drop the focused node. One `:focus-visible` ring, copied onto everything.
- **Emphasis is rationed.** Default hover is a flat tint. Scale transforms are for primary buttons only. Tooltips wait for hover intent.

Known gaps, so nobody copies the wrong pattern: there is no `prefers-reduced-motion`
handling in CSS, border radii and chrome font sizes are untokenized literals, and
shortcut hints are hover-only.

## The Variable Contract

Every visual value — palette, type scale, code token colors — lives in the `:root` block of `client/app.css` and nowhere else. Stylesheets and JS-injected styles read from it with `var(--token)`.

`test/lint/css-guard.mjs` enforces this: a raw hex, `rgb()`, or `hsl()` anywhere in `client/app.css` outside `:root`, or anywhere at all in `index.html` or any `client/*.js` file (except `theme-lab.js`, the dev-only palette workbench below — see its own header for why it's exempt), fails the build. The guard scans `client/*.js` non-recursively, so it picks up new client modules automatically without needing its own list updated; `client/dist/` and `client/vendor/` are never touched since they're one level deeper. If you need a new color, add a token; don't inline the value.

Tokens are written as `light-dark(<light>, <dark>)`. Both sides are required and reviewed, except the deliberately theme-invariant tokens (shadows, tooltip backgrounds, `--white`) — the `THEME_INVARIANT` allowlist in `test/lint/css-guard.mjs` is the source of truth for that exception, and enforces it both ways.

## Theme Lab

Append `?lab` to any showmd URL to open a palette workbench:

```sh
node bin/cli.js --port 4321 .
# then visit http://127.0.0.1:4321/?lab
```

The lab reads the live `:root` block from `app.css`, so its token list can never drift from the source. It gives you a color picker and OKLCH readout per token, edits whichever side of `light-dark()` matches the current theme, and shows contrast and palette-coherence checks that update as you drag.

- **Theme toggle** flips the page theme and which side of `light-dark()` you are editing.
- **Dock** moves the panel left or right so it doesn't cover the part of the UI you're inspecting.
- **I/O** takes a pasted `:root` block or bare `--token: value` lines, and exports the current state as a `:root` block ready to paste back into `app.css`.
- **Reset** restores the values currently in `app.css`.

Edits persist in localStorage and only affect your browser. The panel lives in a shadow root, so the tokens you are editing cannot restyle the panel itself.

`?lab` is a contributor tool. It loads only when the query parameter is present, adds no route, and the server binds to 127.0.0.1, so it is unreachable off your machine.

## Proposing a color change

Make the change in the lab, confirm the checks pass in **both** light and dark, then use I/O → *Fill with current* → *Copy* and paste the block into `client/app.css`. Include the before/after OKLCH values for anything you moved in the PR description.

Two rails exist and should stay separate, because their contrast rules differ:

- **Text roles** (`--accent`, `--add`, `--del`, `--question`, `--warning`) are used for body-size text and need 4.5:1 against their background.
- **Marks** (`--mark-add`, `--mark-warn`, `--mark-del`) are dots and icons — graphical objects, so 3:1 is the floor, which lets them sit lighter and more saturated than the text roles.

Note that equal OKLCH lightness does not mean equal contrast; a green and a blue at the same `L` land at different ratios against white. The mark rail solves per hue for a contrast target rather than a fixed `L`, and new colors should do the same.

The WCAG ratios the lab checks are a standard. The palette-coherence checks next to them — hue gap, chroma spread, lightness spread, neutral tint — are house heuristics tuned to this palette, not rules from anywhere. They are documented at the top of `client/theme-lab.js`. Argue with them if you have a reason; just say so in the PR.

## Icons

Every icon is generated from `icons/mark.svg` (and `icons/mark-grid.svg` for the Helper backdrop) by `scripts/make-icons.js`:

```sh
npm run icons                     # needs rsvg-convert
```

This writes the OS icons (`showmd.icns`, `showmd-helper.icns`, `showmd-doc.icns`, `showmd.ico`, `showmd.png`) into `icons/`, and the browser favicon set (`favicon.svg`, `favicon-32.png`, `favicon-1024.png`, `apple-touch-icon.png`) into `client/`. The split is by consumer: `icons/` is read by `server/install-app.js` at desktop-install time and never served over HTTP, while `client/` is the web root. Edit the SVG source and regenerate — never hand-edit a generated icon.
