#!/bin/sh
set -eu
if ! command -v node >/dev/null 2>&1; then
  echo 'Please install Node.js 22 or newer.' >&2
  exit 1
fi
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$script_dir/scripts/bridge.mjs" "$@"
