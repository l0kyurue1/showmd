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
The module every route goes through to reach a markdown file. It takes a document id (`relPath`, or `key/relPath` across multiple roots) and owns resolving it, refusing to leave its root, writing atomically, suppressing the watcher's echo of our own write, and recording History. No caller outside it handles a filesystem path.
_Avoid_: file service, repository, fs layer

**Agent Config View**:
The sidebar view that serves a coding agent's own markdown (global instructions, rules, and per-project memories) from a static registry of agents (Claude, Codex). It builds an Instructions/Memories tree per agent and reads files through the same Document Store; markdown only, so non-markdown agent config like `config.toml` stays out of scope.
_Avoid_: agent browser, memory viewer, settings view

**History**:
The per-file version history kept in a hidden git repository outside the served directory, written on save and readable as diffs. One timeline per file: unpushed history saves on top of the served repo's own commits, each entry tagged with where it came from.
_Avoid_: backup, undo history, shadow history
