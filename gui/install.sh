#!/usr/bin/env bash
#
# One-time setup for the devpanel GUI: install dependencies, build the Vue app,
# and install the systemd service. Safe to re-run — it is how you pick up
# dependency changes.
#
#   ./install.sh              dependencies, certificate, build   (as the owner)
#   ./install.sh --service    install/refresh the service        (needs root)
#   ./install.sh --sandbox    install/verify sandbox prerequisites (needs root)
#
# The build half runs as the invoking user and needs no privilege. Writing a unit
# into /etc/systemd/system does need root, so that half is a separate step — and
# the service it writes still runs the panel as the owning user, never as root.

set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

say () { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn () { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die () { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

MODE="${1:-all}"

UNIT_NAME=devpanel.service
UNIT_TEMPLATE="$HERE/systemd/devpanel.service.in"
UNIT_TARGET="/etc/systemd/system/$UNIT_NAME"
UNIT_RENDERED="$HERE/systemd/$UNIT_NAME"

# The panel binds 443 without privilege because this specific binary carries
# cap_net_bind_service. `node` may be a symlink; the capability lives on the
# real file, and that is what the unit has to exec.
resolve_node () {
  local bin; bin="$(command -v node)"
  readlink -f "$bin"
}

render_unit () {
  local node_bin="$1" user="$2" group="$3"
  [[ -f "$UNIT_TEMPLATE" ]] || die "missing unit template at $UNIT_TEMPLATE"
  sed -e "s|@DIR@|$HERE|g" \
      -e "s|@NODE@|$node_bin|g" \
      -e "s|@USER@|$user|g" \
      -e "s|@GROUP@|$group|g" \
      "$UNIT_TEMPLATE" > "$UNIT_RENDERED"
}

install_service () {
  local node_bin user group
  if [[ "$(id -u)" -eq 0 ]]; then
    bash "$HERE/tools/install-sandbox.sh"
  fi
  node_bin="$(resolve_node)"
  # Installed as root, but the service must run as whoever owns the project —
  # deciding that from the directory rather than from who ran the installer,
  # which under sudo would be root.
  user="$(stat -c '%U' "$HERE")"
  group="$(stat -c '%G' "$HERE")"

  [[ "$user" == "root" ]] && warn "this directory is owned by root; the panel is meant to run as an ordinary user"

  say "service will run as ${user}:${group} using ${node_bin}"

  if command -v getcap >/dev/null 2>&1; then
    if getcap "$node_bin" 2>/dev/null | grep -q cap_net_bind_service; then
      say "${node_bin} carries cap_net_bind_service — port 443 works unprivileged"
    else
      warn "${node_bin} has no cap_net_bind_service; port 443 will be refused"
      warn "  grant it with: setcap cap_net_bind_service=+ep ${node_bin}"
      warn "  or run the panel on an unprivileged port with PORT=8443"
    fi
  fi

  render_unit "$node_bin" "$user" "$group"

  if [[ "$(id -u)" -ne 0 ]]; then
    say "the unit is rendered at:"
    say "  $UNIT_RENDERED"
    say "installing it needs root — run:"
    printf '\n    install -m 0644 %s %s\n' "$UNIT_RENDERED" "$UNIT_TARGET"
    printf '    systemctl daemon-reload\n'
    printf '    systemctl enable --now %s\n\n' "$UNIT_NAME"
    return 1
  fi

  install -m 0644 "$UNIT_RENDERED" "$UNIT_TARGET"
  systemctl daemon-reload
  systemctl enable "$UNIT_NAME" >/dev/null
  say "installed $UNIT_TARGET and enabled it at boot"

  # A hand-started panel already holding the port would make the service fail to
  # start for a reason that looks nothing like the cause.
  if pgrep -f 'node.*server/index\.js' >/dev/null 2>&1; then
    local strays; strays="$(pgrep -fc 'node.*server/index\.js')"
    warn "${strays} devpanel process(es) are already running outside systemd"
    warn "  stop them first, or the service cannot take port 443:"
    warn "    pkill -f 'node.*server/index\\.js'"
    warn "  then: systemctl start $UNIT_NAME"
  else
    systemctl restart "$UNIT_NAME"
    say "started — systemctl status $UNIT_NAME"
  fi
  return 0
}

case "$MODE" in
  --sandbox|sandbox)
    exec bash "$HERE/tools/install-sandbox.sh"
    ;;
  --service|service)
    install_service
    exit $?
    ;;
  -h|--help|help)
    sed -n '2,/^set /{ /^#/s/^# \{0,1\}//p; }' "${BASH_SOURCE[0]}"
    exit 0
    ;;
  all|'') ;;
  *) die "unknown mode '$MODE' — expected '--service' or '--sandbox' (see ./install.sh --help)" ;;
esac

[[ "$(id -u)" -eq 0 ]] && die "run the build as the project's owner, not as root — for the service alone use: ./install.sh --service" 

# --- prerequisites ---------------------------------------------------------

command -v node >/dev/null 2>&1 || die "node is not installed or not on PATH"
command -v npm  >/dev/null 2>&1 || die "npm is not installed or not on PATH"

NODE_VERSION="$(node --version)"      # e.g. v22.22.2
NODE_MAJOR="${NODE_VERSION#v}"; NODE_MAJOR="${NODE_MAJOR%%.*}"
NODE_MINOR="${NODE_VERSION#v*.}";  NODE_MINOR="${NODE_MINOR%%.*}"

# Vite 8 requires ^20.19.0 || >=22.12.0.
node_too_old () {
  if   (( NODE_MAJOR >  22 )); then return 1
  elif (( NODE_MAJOR == 22 )); then (( NODE_MINOR < 12 ))
  elif (( NODE_MAJOR == 21 )); then return 0
  elif (( NODE_MAJOR == 20 )); then (( NODE_MINOR < 19 ))
  else return 0
  fi
}

if node_too_old; then
  die "node ${NODE_VERSION} is too old — this project needs ^20.19.0 or >=22.12.0"
fi

say "node ${NODE_VERSION}, npm $(npm --version), user $(id -un)"

# --- dependencies ----------------------------------------------------------

if [[ -f package-lock.json ]]; then
  say "installing dependencies from package-lock.json"
  npm ci --no-audit --no-fund
else
  warn "no package-lock.json — resolving fresh"
  npm install --no-audit --no-fund
fi

# --- certificate -----------------------------------------------------------

# HTTPS is the default, so setup is not complete without a certificate.
if [[ "${DEVPANEL_TLS:-1}" != "0" ]]; then
  ./make-cert.sh
else
  say "DEVPANEL_TLS=0 — skipping certificate generation"
fi

# --- build -----------------------------------------------------------------

say "building the production bundle"
npm run build

# --- service ---------------------------------------------------------------

say "preparing the systemd service"
if install_service; then
  say "done — the panel is running under systemd"
else
  say "done — dependencies and build are ready"
  say "run the command above as root to install the service, or start it by hand with ./start.sh"
fi
