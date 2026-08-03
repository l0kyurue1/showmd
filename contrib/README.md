# contrib

For a double-clickable app and a `.md` file handler on macOS, Windows, or
Linux, run `showmd install-app` (see the main [README](../README.md#desktop-app)).

`contrib/` holds lighter-weight extras that `install-app` doesn't cover:

| OS | File | Install |
|---|---|---|
| macOS (Raycast) | `raycast-showmd.sh` | Raycast → Extensions → Script Commands → *Add Directories*, select `contrib/`; `raycast-showmd.sh` shows up as "Open in showmd" |
| Windows | `showmd.reg` | Double-click `showmd.reg`, accept the prompt, adds a "showmd" entry to the `.md` right-click menu (no admin required) |

Both need `showmd` on `PATH` (`npm install -g showmd`). Before using the
Raycast script, run `command -v showmd` and paste the result over the
placeholder path in the file, GUI apps don't inherit your shell's `PATH`.

## Homebrew

`brew install l0kyurue1/tap/showmd`, the formula lives in the tap repo,
[l0kyurue1/homebrew-tap](https://github.com/l0kyurue1/homebrew-tap).
