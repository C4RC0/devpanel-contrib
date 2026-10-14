#!/usr/bin/env bash
# Root entry point for host prerequisites. Build the GUI separately as its owner.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if (($# == 0)); then set -- --sandbox; fi
exec "$ROOT/gui/install.sh" "$@"
