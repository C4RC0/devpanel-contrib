#!/bin/bash
# Probe: which way gives a candidate a private pid namespace on a systemd-nspawn staging host.
# Run as the staging SSH account, naming the test drive's unit user:
#   ssh root@staging.example.invalid DEVPANEL_PROBE_USER=<unit user> bash -s < gui/tools/pidns-probe.sh
# Transient units only (--wait --collect); it leaves nothing behind.
set -u
U="${DEVPANEL_PROBE_USER:?set DEVPANEL_PROBE_USER to the test drive unit user}"
echo "== host"; id -un; systemctl --version | head -1; bwrap --version; uname -r
run() { echo; echo "== $1"; shift; systemd-run --quiet --wait --pipe --collect "$@" 2>&1 | head -20; echo "[exit ${PIPESTATUS[0]}]"; }
BW='/usr/bin/bwrap --die-with-parent --tmpfs / --ro-bind /usr /usr --symlink usr/lib64 /lib64 --symlink usr/bin /bin --proc /proc --dev /dev'
run "A PrivatePIDs as $U: pid 1 and process count" -p PrivatePIDs=yes -p User="$U" -p NoNewPrivileges=yes -- /bin/sh -c 'cat /proc/1/comm; ls /proc | grep -c "^[0-9]"'
run "B PrivatePIDs + bwrap (no --unshare-pid)" -p PrivatePIDs=yes -p User="$U" -p NoNewPrivileges=yes -- $BW -- /bin/sh -c 'cat /proc/1/comm; ls /proc | grep -c "^[0-9]"'
run "C PrivatePIDs + bwrap --unshare-pid" -p PrivatePIDs=yes -p User="$U" -p NoNewPrivileges=yes -- $BW --unshare-pid -- /bin/sh -c 'cat /proc/1/comm; ls /proc | grep -c "^[0-9]"'
run "D control: no PrivatePIDs, bwrap --unshare-pid (expected: proc mount refused)" -p User="$U" -p NoNewPrivileges=yes -- $BW --unshare-pid -- /bin/sh -c 'cat /proc/1/comm'
run "E PrivatePIDs + PrivateNetwork" -p PrivatePIDs=yes -p PrivateNetwork=yes -p User="$U" -p NoNewPrivileges=yes -- $BW -- /bin/sh -c 'cat /proc/1/comm; grep -i ^cap /proc/self/status; ip -o link 2>/dev/null | wc -l'
