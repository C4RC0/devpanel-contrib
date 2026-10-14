#!/usr/bin/env bash
#
# Install a headless Chromium that devpanel owns, for the layout pass.
#
# Two halves, both unprivileged and both landing under gui/.browser:
#
#   .browser/playwright  the browser build, pinned by playwright-core's version
#   .browser/lib         the system libraries it needs, extracted from packages
#
# The libraries are the awkward half: a distribution image that never expected to
# run a browser has none of them, and installing them properly needs root, which
# is not available here. So they are fetched as packages and unpacked into a
# directory of our own — the loader is pointed at it only for the browser process.
#
# Deliberately NOT extracted: glibc, libgcc, libstdc++ and the dynamic loader.
# Mixing a downloaded C library with the running one breaks far more than it fixes,
# so those must come from the system.
#
# Re-running is safe: everything is idempotent, and already-present files are
# overwritten with the same content.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$HERE/.browser"
LIB="$ROOT/lib"
BROWSERS="$ROOT/playwright"
WORK="$ROOT/.packages"

# Provided by the system, and dangerous to shadow.
SYSTEM_ONLY='^(libc|libm|libdl|libpthread|librt|libresolv|libutil|ld-linux|libgcc_s|libstdc\+\+|libanl)\.'

say () { printf '\033[36m%s\033[0m\n' "$*"; }
warn () { printf '\033[33m%s\033[0m\n' "$*"; }

need () {
  command -v "$1" >/dev/null 2>&1 || { echo "this script needs $1"; exit 1; }
}

need node
need npx
need ldd

mkdir -p "$LIB" "$BROWSERS" "$WORK"

# ---------------------------------------------------------------- the browser
say "==> browser build → $BROWSERS"
PLAYWRIGHT_BROWSERS_PATH="$BROWSERS" npx --yes playwright-core install chromium-headless-shell

SHELL_BIN="$(find "$BROWSERS" -type f -name 'chrome-headless-shell' -perm -u+x | head -n1)"
if [ -z "$SHELL_BIN" ]; then
  echo "the browser did not install where it was expected"
  exit 1
fi
say "    $SHELL_BIN"

# ------------------------------------------------------------- the libraries
# Everything the browser needs and cannot find — including what the libraries
# already extracted need in turn, which is where most of the list comes from.
#
# Written without pipelines that can fail: `grep` returning "no matches" is the
# SUCCESS case here, and under `set -o pipefail` it would end the scan early and
# leave the last few libraries permanently missing.
missing () {
  {
    LD_LIBRARY_PATH="$LIB" ldd "$SHELL_BIN" 2>/dev/null || true
    for so in "$LIB"/*.so*; do
      [ -e "$so" ] || continue
      LD_LIBRARY_PATH="$LIB" ldd "$so" 2>/dev/null || true
    done
  } | awk '/not found/ { print $1 }' | { grep -Ev "$SYSTEM_ONLY" || true; } | sort -u
}

extract () {                     # extract <rpm>
  local rpm="$1" stage="$WORK/stage"
  rm -rf "$stage"; mkdir -p "$stage"
  # rpm2archive because this image has no cpio; the payload is a plain tarball.
  rpm2archive - < "$rpm" | tar -xz -C "$stage" 2>/dev/null || return 0
  find "$stage" \( -path '*/lib64/*' -o -path '*/lib/*' \) -name '*.so*' -print0 |
    while IFS= read -r -d '' file; do
      local base; base="$(basename "$file")"
      # Never shadow the system C library or its companions.
      if printf '%s' "$base" | grep -Eq "$SYSTEM_ONLY"; then continue; fi
      cp -a --remove-destination "$file" "$LIB/" 2>/dev/null || true
    done
  rm -rf "$stage"
}

resolve () {                     # resolve <soname> -> package name on stdout
  dnf --quiet provides "$1" 2>/dev/null |
    awk '/^[a-zA-Z0-9]/ { print $1; exit }' |
    sed -E 's/-[0-9][^-]*-[^-]+\.(x86_64|i686|noarch)$//'
}

if command -v dnf >/dev/null 2>&1 && command -v rpm2archive >/dev/null 2>&1; then
  for pass in 1 2 3 4 5 6; do
    mapfile -t wanted < <(missing)
    [ "${#wanted[@]}" -eq 0 ] && break

    say "==> pass $pass: ${#wanted[@]} library/libraries still missing"
    packages=()
    for soname in "${wanted[@]}"; do
      pkg="$(resolve "$soname" || true)"
      if [ -z "$pkg" ]; then warn "    no package provides $soname"; continue; fi
      packages+=("$pkg")
    done
    [ "${#packages[@]}" -eq 0 ] && break

    # No --resolve: it drags in glibc and the whole base system. Anything genuinely
    # needed shows up as a missing soname on the next pass and is fetched then.
    printf '    %s\n' "${packages[@]}" | sort -u
    dnf --quiet download --destdir "$WORK" "${packages[@]}" >/dev/null 2>&1 || true
    for rpm in "$WORK"/*.rpm; do [ -e "$rpm" ] && extract "$rpm"; done
    rm -f "$WORK"/*.rpm
  done
else
  warn "==> no dnf/rpm2archive here; libraries must be provided another way"
fi

rmdir "$WORK" 2>/dev/null || true

# ------------------------------------------------------------------- verdict
remaining="$(missing | tr '\n' ' ' | sed 's/ *$//')"
if [ -n "$remaining" ]; then
  warn "==> still missing: $remaining"
  warn "    the layout pass will skip and say so"
  exit 1
fi

say "==> checking that it launches"
cd "$HERE"                       # the check imports by relative path
DEVPANEL_BROWSER_LIBS="$LIB" PLAYWRIGHT_BROWSERS_PATH="$BROWSERS" node -e '
  const { launchChromium, closeChromium } = await import("./test/browser/chromium.mjs")
  const result = await launchChromium()
  if (!result.ok) { console.error("  " + result.reason); process.exit(1) }
  console.log("    " + result.version)
  await closeChromium()
' --input-type=module 2>/dev/null ||
DEVPANEL_BROWSER_LIBS="$LIB" PLAYWRIGHT_BROWSERS_PATH="$BROWSERS" node --experimental-default-type=module -e '
  import("./test/browser/chromium.mjs").then(async (m) => {
    const result = await m.launchChromium()
    if (!result.ok) { console.error("  " + result.reason); process.exit(1) }
    console.log("    " + result.version)
    await m.closeChromium()
  })
'

say "==> done. npm run visual now finds the browser without any environment set."
