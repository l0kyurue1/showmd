# contrib

For a double-clickable app and a `.md` file handler on macOS, Windows, or
Linux, run `showmd install-app` (see the main [README](../README.md#desktop-app)).

`contrib/` holds lighter-weight extras that `install-app` doesn't cover:

| OS | Path | Install |
|---|---|---|
| macOS, Windows (Raycast) | `raycast/` | A full Raycast extension: six commands, three AI tools, and a menu bar extra (macOS only). See its [README](raycast/README.md) |
| Windows | `showmd.reg` | Double-click `showmd.reg`, accept the prompt, adds a "showmd" entry to the `.md` right-click menu (no admin required) |

The `.reg` handler needs `showmd` on `PATH` (`npm install -g showmd-cli`).
The Raycast extension finds an installed copy on its own, takes an explicit
path in its ShowMD Path preference, and falls back to `npx -y showmd-cli`
when it finds nothing.

## Homebrew

`brew install l0kyurue1/tap/showmd`, the formula lives in the tap repo,
[l0kyurue1/homebrew-tap](https://github.com/l0kyurue1/homebrew-tap).
