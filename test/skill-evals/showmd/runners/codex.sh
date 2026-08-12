#!/bin/sh
set -eu

runner_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
exec node "$runner_dir/../run-agent.mjs" codex "$@"
