#!/bin/bash
## The Chromium layout suite against a build in the run's scratch directory, so gui/dist never
## becomes part of a candidate. One script rather than `build && test` in projects/<id>.yaml:
## a seat runs a declared command as one operation, and the Claude CLI sends a compound
## command to approval, which a seat never gets.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
: "${DEVPANEL_SCRATCH_DIR:?names the scratch directory of the run}"
# The test helpers copy configuration into os.tmpdir(); inside a seat fence the CLI's own TMPDIR
# is not writable, the scratch directory is.
export TMPDIR="$DEVPANEL_SCRATCH_DIR/tmp"
mkdir -p "$TMPDIR"
npx vite build --configLoader runner --outDir "$DEVPANEL_SCRATCH_DIR/dist" --emptyOutDir
DEVPANEL_DIST_DIR="$DEVPANEL_SCRATCH_DIR/dist" DEVPANEL_REQUIRE_BROWSER=1 exec node test/run.mjs visual.chromium
