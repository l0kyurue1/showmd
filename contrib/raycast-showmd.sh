#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Open in showmd
# @raycast.mode silent

# Optional parameters:
# @raycast.icon 📄
# @raycast.packageName showmd

# Documentation:
# @raycast.description Open the selected Finder file in showmd
# @raycast.author showmd

# GUI apps (Raycast included) don't inherit your shell's PATH, so `showmd`
# must be called via its absolute path. Run `command -v showmd` in a
# terminal and substitute the result below.
SHOWMD="/opt/homebrew/bin/showmd"

selected_file=$(osascript <<'ENDAPPLE'
tell application "Finder"
    set selectedItems to selection
    if (count of selectedItems) is 0 then
        return ""
    end if
    return POSIX path of (item 1 of selectedItems as alias)
end tell
ENDAPPLE
)

if [ -z "$selected_file" ]; then
    exit 1
fi

"$SHOWMD" "$selected_file"
