# showmd

A local markdown viewer/editor: a CLI serves a directory of markdown files to a browser client that renders them (Read Mode) or edits them with inline preview (Edit Mode).

## Language

**App**:
The installable desktop entry point: `ShowMD.app` on macOS, the Start Menu shortcut on Windows, the `.desktop` entry on Linux. Installed by `showmd install-app`; launches the same CLI server as running `showmd` from a terminal.
_Avoid_: launcher

**Home**:
The rootless picker page served when showmd boots with no root: Open Folder, Open File, and recents. Not a document mode; distinct from the App.
Code still says launcher for this one thing (`--launcher`, `launcher.pid`, `showLauncher()`, `.launcher-view`, "launcher mode"). Deliberate: renaming touches installed apps' launch scripts for no behavior gain.
_Avoid_: launcher in prose and UI copy, where it used to mean the App

**Folder / File / Recents**:
The only nouns UI copy uses for opened content: the user opens a Folder or File, and both live in Recents. A row's X forgets the folder — it leaves Recents and, when the folder is live in this process, stops updating open tabs (confirmed first). Live-ness itself is never labelled; the watcher is plumbing. Raycast copy brands the app as ShowMD. Architecture words stay in code and docs.
_Avoid_: project, root, instance, server, watching (in any UI copy)

**Read Mode**:
The rendered-document view: markdown converted to HTML and enhanced in place. One of the two adapters of the Block Renderer.
_Avoid_: preview mode, view mode

**Edit Mode**:
The CodeMirror-based editing view that conceals markdown syntax and renders blocks inline as you type. The other adapter of the Block Renderer.
_Avoid_: live mode, live preview

**Source Mode**:
The plain CodeMirror view showing raw markdown with no inline rendering. The third state in the mode cycle, and the only one that is not an adapter of the Block Renderer.
_Avoid_: edit mode, raw mode, source view

**View State**:
The pure record of which pane the client is showing: one of the three modes, or the Version View that replaces them while a diff is open. Every button, shortcut and file load hands it an event and gets the next record back; a single writer applies that record to the DOM, so two panes can never be visible at once.
_Avoid_: mode flag, pane toggle, UI state

**Save Flow**:
The client's record of what the server already has, whether the buffer has drifted from it, and the single debounce in front of the write. Every keystroke, shortcut and task-checkbox click hands the text to it instead of writing the file itself, so "dirty" has one meaning, a burst of edits costs one save, and a failed write is still dirty.
_Avoid_: autosave manager, dirty flag, save state

**Block Renderer**:
The single module that turns a markdown block into its enhanced form: highlighted code, math, mermaid diagrams, task checkboxes. Both modes call it; neither owns it.
_Avoid_: enhancement layer, render bridge, liveRender

**Markdown Grammar**:
The pure, DOM-free rules deciding what counts as math, a highlight, or a task marker. The Block Renderer and the markdown-it pipeline both read from it; no mode re-derives these rules locally.
_Avoid_: parser, syntax rules, regexes

**Variable Contract**:
The set of CSS custom properties that is the only source of visual values: palette, type scale, code token colors, and the document geometry both modes must agree on (list indent, task box and gap, quote bar and padding). Every stylesheet and JS-injected style reads from it; nothing defines raw values outside it. A single writer flips the theme, so a change reaches the diagrams too.
_Avoid_: theme variables, design tokens (unless referring to the contract itself)

**Document Store**:
The module every route goes through to reach a markdown file. Each Space gets its own store: a Root Space's store takes a plain `relPath` id, while Skills and Agents each compose several directories into one store and take a `key/relPath` id. The owning Space's URL (`/r/<rootKey>/…`, `/skills/…`, `/agents/<agentKey>/…`) picks the store; the store then owns resolving the id, refusing to leave its root, writing atomically, suppressing the watcher's echo of our own write, and recording History. No caller outside it handles a filesystem path.
_Avoid_: file service, repository, fs layer

**Agent Config View**:
The sidebar view that serves a coding agent's own markdown (global instructions, rules, and per-project memories) from a static registry of agents (Claude, Codex). It builds an Instructions/Memories tree per agent and reads files through the same Document Store; markdown only, so non-markdown agent config like `config.toml` stays out of scope.
_Avoid_: agent browser, memory viewer, settings view

**History**:
The per-file version history kept in a hidden git repository outside the served directory, written on save and readable as diffs. One timeline per file: unpushed history saves on top of the served repo's own commits, each entry tagged with where it came from.
_Avoid_: backup, undo history, shadow history

**Registry**:
The per-instance announcement files (`ports/<pid>.json`, one per running showmd process) that external consumers (Raycast, `--launcher`, the shipped skill) read to discover every live server. The server is the registry's only writer: it announces on listen, retracts on close, and sweeps dead pids on boot. A reader trusts a live probe over the file existing. `GET /api/registry` is that probe, served by every live server: it reads the same directory, probes each entry's `/api/version`, and orders the result with `server/protocol.js`'s `orderRegistry` (protocol match, `mode: "shared"`, then configured port, `startedAt`, `instanceId`). A consumer asks whichever server it can reach and takes the first entry; enumeration order and which server answered never change the result, so no consumer re-derives the ordering itself. The legacy single `port.json` is gone; there is no mixed-version fallback.
_Avoid_: port file, lockfile, primary/isolated (the wire vocabulary is `mode: "shared" | "dedicated"`)

**Capability**:
A named, versioned feature a process advertises in `/api/version` (`roots-v1`, `spaces-v1`). Consumers connect to processes they did not launch, installed by npm or Homebrew and updated on their own schedules, so they ask what a server can do instead of inferring it from a version number. `server/protocol.js` holds the only list; `KNOWN_CAPABILITY_SET` rejects unknown or duplicated names. A published name is a frozen contract: additive changes stay in `v1`, a breaking change mints `roots-v2`, and a migrating server advertises both. The names carry no ordering, so no consumer may compare or range-check them. The separate `protocol` field versions the wire envelope, never a feature.
_Avoid_: version check, semver gate, feature flag

**Space**:
A top-level, URL-addressable area of the app: a Root Space (`/r/<rootKey>/…`, one per open directory), Skills, Agents, Settings, or Home. A process hosts several Spaces at once and can add Root Spaces at runtime (`POST /api/roots`); the Registry still lists one entry per process, not one per Space.
_Avoid_: instance, server (in extension UI copy)

## Security

`/api/shutdown` shares the loopback and Origin trust model documented at its restart check in server.js: any local process able to reach 127.0.0.1 can stop the server, same as it can restart it. This is accepted for a localhost dev tool, since a local process could reach the served files directly anyway.
