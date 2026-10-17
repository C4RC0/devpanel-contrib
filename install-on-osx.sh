#!/bin/bash
#
# Install devpanel natively on macOS and run it as a per-user launchd agent.
#
#   bash install-on-osx.sh     check, install what is missing, sync, build, (re)start
#
# Every step is idempotent, so the same command installs the first time and
# afterwards only pulls the source again: tools are installed only when absent,
# npm ci runs only when package-lock.json changed.
#
# Runs on the Mac, as the person who will own the panel, never with sudo.
# First time, fetch it from the panel host that serves the source:
#   scp <user>@<panel-host>:<panel checkout>/install-on-osx.sh ~
#   DEVPANEL_SOURCE=<user>@<panel-host>:<panel checkout>/ bash ~/install-on-osx.sh
#
# Environment:
#   DEVPANEL_SOURCE        rsync source, required: <user>@<panel-host>:<path>/ of a
#                          checkout of https://github.com/LaKing/devpanel that this Mac reaches over SSH
#   DEVPANEL_HOME          install directory     (~/devpanel; optional, as are the rest)
#   DEVPANEL_PROJECTS_DIR  projects directory    (~/projects; each project is <name>-project)
#   PORT / HOST            listen address        (8443 / 127.0.0.1)
#   DEVPANEL_LAUNCHD_LABEL the agent's label     (an installed *.devpanel agent's own, else local.devpanel)
#   DEVPANEL_UNFENCED      'acknowledged' opts this install in to unfenced operation, 'no' opts it
#                          out; unset keeps what the installed agent has (off on a first install)
#
# Written for /bin/bash 3.2, the one macOS ships: no associative arrays, no mapfile.
#
# The seat fence is bubblewrap, which macOS does not have. Without it the panel
# REFUSES seat turns, tooling commands and local checks (owner decision
# 2026-10-13), until this install opts in, explicitly and per install:
#   DEVPANEL_UNFENCED=acknowledged bash install-on-osx.sh
# Then seats run unfenced: confined only by the CLIs' own sandboxes and
# permission rules, recorded on every run (namespace 0, checks
# local-unconfined, tooling unconfined) and flagged on every page of the panel.
# The opt-in is kept in the agent's plist across reinstalls; DEVPANEL_UNFENCED=no
# withdraws it. Gemini seats are refused on macOS either way. A Seatbelt fence
# comes later.
# The panel runs with DEVPANEL_AUTH=local: same-origin loopback requests need no
# token (server/local-login.mjs); the token still works and guards the rest.
# Risk: every local process is the operator then, unfenced seats and candidate
# code included (they could read the token anyway); it is refused off loopback.

set -euo pipefail

say () { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn () { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die () { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

SOURCE="${DEVPANEL_SOURCE:-}"
DEST="${DEVPANEL_HOME:-$HOME/devpanel}"
PROJECTS="${DEVPANEL_PROJECTS_DIR:-$HOME/projects}"
PORT="${PORT:-8443}"
HOST="${HOST:-127.0.0.1}"
SELF_SUM="$(shasum -a 256 < "$0")"
# The label of an agent this script installed before is kept, whatever it was named,
# so a reinstall replaces it rather than starting a second panel beside it.
LABEL="${DEVPANEL_LAUNCHD_LABEL:-}"
if [[ -z "$LABEL" ]]; then
  for existing in "$HOME"/Library/LaunchAgents/*.devpanel.plist; do
    [[ -f "$existing" ]] && LABEL="$(basename "$existing" .plist)" && break
  done
fi
LABEL="${LABEL:-local.devpanel}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/devpanel.log"
# The unfenced opt-in: given now, else what the installed agent already has.
# An older agent's DEVPANEL_FENCE=off is not an opt-in: it was never asked for.
UNFENCED="${DEVPANEL_UNFENCED:-}"
if [[ -z "$UNFENCED" && -f "$PLIST" ]]; then
  UNFENCED="$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:DEVPANEL_UNFENCED' "$PLIST" 2>/dev/null || true)"
fi
case "$UNFENCED" in
  acknowledged) ;;
  no|'') UNFENCED='' ;;
  *) die "DEVPANEL_UNFENCED is 'acknowledged' (opt in to unfenced seats) or 'no' (opt out), not '$UNFENCED'" ;;
esac

# --- environment -----------------------------------------------------------

[[ "$(uname -s)" == Darwin ]] || die "this installer is for macOS; on Linux use ./install.sh"
[[ "$(id -u)" -ne 0 ]] || die "run as the panel's owner, not as root"
(( $# == 0 )) || die "no arguments are taken (got: $*); configure through the environment"
[[ -n "$SOURCE" ]] || die "set DEVPANEL_SOURCE to the rsync source of the panel, <user>@<panel-host>:<path>/ (a checkout of https://github.com/LaKing/devpanel)"

# Homebrew's own installer asks for an admin password, so it is not run from here.
if ! command -v brew >/dev/null 2>&1; then
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [[ -x "$b" ]] && eval "$("$b" shellenv)" && break; done
fi
command -v brew >/dev/null 2>&1 || die 'Homebrew is missing. Install it first:
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
BREW_PREFIX="$(brew --prefix)"

# node@22 is keg-only: it is never linked into the brew prefix, so every PATH
# below names its keg. Global npm packages go to ~/.local, which needs no
# privilege and is where runtime/command.mjs looks after PATH.
NODE_BIN="$BREW_PREFIX/opt/node@22/bin"
RUSTUP_BIN="$BREW_PREFIX/opt/rustup/bin"
SVC_PATH="$HOME/.local/bin:$NODE_BIN:$HOME/.cargo/bin:$RUSTUP_BIN:$BREW_PREFIX/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH="$SVC_PATH"

say "Homebrew packages"
for pkg in node@22 git rsync rustup; do
  if brew list --versions "$pkg" >/dev/null 2>&1; then say "  $pkg present"; else brew install "$pkg"; fi
done
NODE_VERSION="$(node --version)"
case "$NODE_VERSION" in v22.*) ;; *) die "expected node 22 from $NODE_BIN, got $NODE_VERSION" ;; esac
minor="${NODE_VERSION#v22.}"; minor="${minor%%.*}"
(( minor >= 12 )) || die "node $NODE_VERSION is too old; Vite needs >= 22.12 (brew upgrade node@22)"
say "node $NODE_VERSION, npm $(npm --version)"

if ! cargo --version >/dev/null 2>&1; then
  say "Rust toolchain (stable)"
  rustup default stable
fi
say "$(cargo --version)"

say "agent CLIs"
mkdir -p "$HOME/.local/bin"
command -v claude >/dev/null 2>&1 || npm install -g --prefix "$HOME/.local" @anthropic-ai/claude-code
command -v codex >/dev/null 2>&1 || npm install -g --prefix "$HOME/.local" @openai/codex
say "claude $(claude --version 2>/dev/null || echo '?'), codex $(codex --version 2>/dev/null || echo '?')"

# --- source ----------------------------------------------------------------

# Host data and build output are excluded, and rsync never deletes an excluded
# path on the receiving side, so the Mac's own issues, token, certificate,
# node_modules and build survive every sync. So does its own configuration,
# projects/ and host-config/ (docs/host-config.md): the server's project configs,
# release targets and live reports describe the server, the Mac's describe the Mac.
say "syncing $SOURCE -> $DEST"
ssh -o BatchMode=yes -o ConnectTimeout=10 "${SOURCE%%:*}" true 2>/dev/null \
  || die "cannot ssh to ${SOURCE%%:*} without a password; add this Mac's public key to its ~/.ssh/authorized_keys"
mkdir -p "$DEST" "$PROJECTS"
rsync -a --delete \
  --exclude node_modules/ --exclude dist/ --exclude .browser/ --exclude .cache/ --exclude __pycache__/ \
  --exclude /issues/ --exclude /logs/ --exclude /cert/ --exclude /runtime/ --exclude /.devpanel-token --exclude /.devpanel-url \
  --exclude /gui/live/ --exclude /projects/ --exclude /host-config/ --exclude '*.key' --exclude '*.pem' \
  "$SOURCE" "$DEST/"

# rsync replaces this file by rename, and bash keeps executing the old bytes it
# already opened: without a re-exec the old version would write the plist. The
# sum is taken at start, because by now $0 may already name the new file.
if [[ -z "${DEVPANEL_REEXEC:-}" && "$(shasum -a 256 < "$DEST/install-on-osx.sh")" != "$SELF_SUM" ]]; then
  say "the installer itself changed; continuing with the new version"
  DEVPANEL_REEXEC=1 exec /bin/bash "$DEST/install-on-osx.sh"
fi

cd "$DEST/gui"
# The stamp lives inside node_modules, so a removed node_modules also means a fresh npm ci.
LOCK_SUM="$(shasum -a 256 package-lock.json | cut -d' ' -f1)"
if [[ "$(cat node_modules/.devpanel-lock.sha256 2>/dev/null)" != "$LOCK_SUM" ]]; then
  say "dependencies"
  npm ci --include=dev --no-audit --no-fund  # NODE_ENV=production would drop the build tools
  echo "$LOCK_SUM" > node_modules/.devpanel-lock.sha256
else
  say "dependencies unchanged"
fi
[[ -f "$DEST/cert/localhost.crt" ]] || ./make-cert.sh
say "building the front end"
npm run build

# --- command-line client ---------------------------------------------------

# skills/devpanel/devpanel.mjs reads the panel's address from here, since it is not the hosts' :443.
echo "https://$HOST:$PORT" > "$DEST/.devpanel-url"
# The devpanel skill for Claude Code on this Mac; an existing real directory there is left alone.
SKILL_LINK="$HOME/.claude/skills/devpanel"
if [[ -L "$SKILL_LINK" || ! -e "$SKILL_LINK" ]]; then
  mkdir -p "$(dirname "$SKILL_LINK")"
  ln -sfn "$DEST/skills/devpanel" "$SKILL_LINK"
else
  warn "$SKILL_LINK exists and is not a link; the devpanel skill was not linked"
fi

# --- service ---------------------------------------------------------------

# The token is created by the server on first start (server/auth.mjs) at
# $DEST/.devpanel-token, mode 0600.
say "launchd agent $LABEL"
mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE_BIN/node</string><string>server/index.js</string></array>
  <key>WorkingDirectory</key><string>$DEST/gui</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$SVC_PATH</string>
    <key>NODE_ENV</key><string>production</string>
    <key>PORT</key><string>$PORT</string>
    <key>HOST</key><string>$HOST</string>
    <key>DEVPANEL_PROJECTS_DIR</key><string>$PROJECTS</string>
    <key>DEVPANEL_AUTH</key><string>local</string>
${UNFENCED:+    <key>DEVPANEL_UNFENCED</key><string>acknowledged</string>
}    <key>DEVPANEL_SHUTDOWN_GRACE_MS</key><string>20000</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>5</integer>
  <!-- Above the shutdown grace, as in the systemd unit: the supervisor stops its runs before exit. -->
  <key>ExitTimeOut</key><integer>45</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
plutil -lint "$PLIST" >/dev/null || die "generated plist is invalid: $PLIST"

# bootout can return while the old panel is still shutting down (it stops its
# runs first, up to DEVPANEL_SHUTDOWN_GRACE_MS, and launchd allows ExitTimeOut),
# and bootstrap fails while the job is still known. So wait for it to be gone.
DOMAIN="gui/$(id -u)"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
for _ in $(seq 1 60); do launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break; sleep 1; done
launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 && die "the previous $LABEL is still loaded after 60 s; see $LOG"
launchctl bootstrap "$DOMAIN" "$PLIST" || die "launchctl bootstrap failed; retry with: launchctl bootstrap $DOMAIN $PLIST"

say "waiting for https://$HOST:$PORT/"
for _ in $(seq 1 30); do
  code="$(curl -sk -o /dev/null -w '%{http_code}' "https://$HOST:$PORT/" || true)"
  if [[ "$code" == 200 ]]; then
    say "devpanel is up: https://$HOST:$PORT/"
    say "  token:   $DEST/.devpanel-token"
    say "  log:     $LOG"
    say "  stop:    launchctl bootout gui/$(id -u)/$LABEL"
    say "  projects go in $PROJECTS/<name>-project (each a git repository)"
    say "  log in once to each CLI if not yet done:  claude   and   codex login"
    if [[ -n "$UNFENCED" ]]; then
      warn "seats run UNFENCED (opted in): only the CLIs' own sandboxes confine them; DEVPANEL_UNFENCED=no withdraws it"
    else
      say "  seats are refused: macOS has no seat fence. To run them unfenced, opt in:"
      say "    DEVPANEL_UNFENCED=acknowledged bash $DEST/install-on-osx.sh"
    fi
    exit 0
  fi
  sleep 1
done
warn "no answer after 30 s; last lines of $LOG:"
tail -n 30 "$LOG" >&2 || true
exit 1
