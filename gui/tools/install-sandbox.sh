#!/usr/bin/env bash
# Install Linux sandbox prerequisites; run as root inside the authoring host.
set -euo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
die () { printf 'error: %s\n' "$*" >&2; exit 1; }
[[ "$(id -u)" == 0 ]] || die 'run this installer as root'

service_user="${DEVPANEL_USER:-}"
if [[ -z "$service_user" ]]; then
  service_user="$(systemctl show devpanel.service --property=User --value 2>/dev/null || true)"
  service_user="${service_user:-$(stat -c '%U' "$HERE")}"
fi
service_uid="$(id -u "$service_user")" || die "unknown service account: $service_user"
[[ "$service_uid" != 0 ]] || die 'devpanel must run as an ordinary user; set DEVPANEL_USER to that account'
command -v runuser >/dev/null || die 'runuser is required (util-linux)'

missing=()
command -v bwrap >/dev/null || missing+=(bubblewrap)
command -v socat >/dev/null || missing+=(socat)
if ((${#missing[@]})); then
  if command -v dnf >/dev/null; then
    dnf install -y "${missing[@]}"
  elif command -v apt-get >/dev/null; then
    apt-get update
    apt-get install -y "${missing[@]}"
  else
    die "install these packages with your package manager: ${missing[*]}"
  fi
fi
command -v bwrap >/dev/null && command -v socat >/dev/null || die 'sandbox dependencies are still missing'

container="$(systemd-detect-virt --container 2>/dev/null || true)"
if [[ "$container" == systemd-nspawn ]]; then
  # An additional unmasked proc mount lets nested user namespaces mount proc.
  # Keep the existing /proc and its mount protections in place.
  if mountpoint -q /run/devpanel/proc; then
    [[ "$(findmnt -n -o FSTYPE --mountpoint /run/devpanel/proc)" == proc ]] || die '/run/devpanel/proc is already mounted with an unexpected filesystem'
  fi
  install -m 0644 "$HERE/systemd/run-devpanel-proc.mount" /etc/systemd/system/run-devpanel-proc.mount
  install -d -m 0755 /etc/systemd/system/devpanel.service.d
  install -m 0644 "$HERE/systemd/devpanel-sandbox.conf" /etc/systemd/system/devpanel.service.d/sandbox.conf
  systemctl daemon-reload
  systemctl enable --now run-devpanel-proc.mount
  systemctl is-active --quiet run-devpanel-proc.mount || die 'sandbox proc mount is not active'
  printf 'Persistent sandbox proc mount installed; devpanel will require it at startup.\n'
fi

if ! runuser -u "$service_user" -- bwrap --ro-bind / / --unshare-user --unshare-pid --proc /proc -- /usr/bin/true; then
  die "Bubblewrap cannot initialize as $service_user; check the outer container's namespace and mount restrictions"
fi
printf 'Sandbox prerequisites verified as %s. No model calls were made.\n' "$service_user"
