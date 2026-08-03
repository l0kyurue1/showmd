---
name: showmd
description: Use when the user wants to see, read, or edit a markdown file (open, preview, view, write in a proper editor — any ask where a rendered page or editor UI serves better than raw text), when you want to show the user a doc you just wrote or edited, or when the user asks to browse installed agent skills, memories, or agent config (CLAUDE.md, AGENTS.md, rules). Not for your own file access — when you only need a file's contents to do your work, use the Read/Edit tools, no server.
---

# showmd

Serves markdown from disk over localhost with live reload, so a browser tab
stays in sync as you edit the file.

## Steps

1. **Check for a running showmd first**, don't start a second one:
   - `curl -s http://localhost:4321/api/root`: a JSON response like
     `{"dir":"/path/served"}` means showmd owns port 4321 and tells you
     which directory it serves; HTML, an error page, or connection refused
     means some other dev server (or nothing) is there. Don't assume 4321
     is showmd.
   - If its `dir` covers the file you need, reuse it.
2. **Start one if none is running**, in the background, without stealing focus:
   - `npx -y showmd-cli <dir> --no-open` (`-y` skips the first-run install
     prompt; npx fetches showmd automatically if it isn't installed)
   - `<dir>` is the folder containing the markdown file(s). If 4321 is busy,
     showmd falls back to a free port on its own; read the actual URL from
     its stdout instead of assuming the port.
3. **Point the user at the file**:
   `http://localhost:<port>/<path-relative-to-served-root>.md`
   You can open it yourself: `open <url>` (macOS), `xdg-open <url>`
   (Linux), `start <url>` (Windows).

## Notes

- Live reload is automatic: after you edit the served `.md` file on disk,
  the open tab updates itself. Never tell the user to refresh.
- Edits are versioned automatically (git-backed, stored centrally, never
  touches the served folder). Never back up the file before editing; the
  user restores earlier versions from the UI.

## Other modes

- `npx -y showmd-cli skills` — browse the user's installed agent skills
  (Claude Code, Codex, the shared `~/.agents/skills` store, ...). Modes:
  `skills all`, `skills global`, `skills <dir>`. Same server rules as above.
- `npx -y showmd-cli agents` — render the user's agent configuration (Claude
  Code's `CLAUDE.md`, rules, and project memories, Codex's `AGENTS.md`).
  Also reachable in-app via the sidebar's Agents button or `⇧⌘A`. Same
  server rules as above.
