#!/bin/bash
# Live proof, second half of pidns-probe.sh: a join into a PrivatePIDs= service.
# Run as the staging SSH account, naming the test drive's unit user:
#   ssh root@staging.example.invalid DEVPANEL_PROBE_USER=<unit user> bash -s < gui/tools/pidns-join-probe.sh
# Starts one transient service (60 s lifetime), joins it the way remote-check-process.mjs
# does when the launcher is root, then stops it. Leaves nothing behind.
set -u
U="${DEVPANEL_PROBE_USER:?set DEVPANEL_PROBE_USER to the test drive unit user}"
unit=devpanel-pidns-probe-$$
BW='/usr/bin/bwrap --die-with-parent --tmpfs / --ro-bind /usr /usr --symlink usr/lib64 /lib64 --symlink usr/bin /bin --proc /proc --dev /dev'
systemd-run --quiet --collect --unit="$unit" -p RuntimeMaxSec=60 -p KillMode=control-group -p PrivatePIDs=yes -p PrivateNetwork=yes -p User="$U" -p NoNewPrivileges=yes -- $BW -- /bin/sh -c 'sleep 50' || { echo "service start failed"; exit 1; }
sleep 1
main=$(systemctl show "$unit" -p MainPID --value)
join_pid=$(awk '{print $1}' "/proc/$main/task/$main/children")
echo "== service: main=$main ($(cat /proc/$main/comm)) join=$join_pid ($(cat /proc/$join_pid/comm))"
echo "== pid namespaces: service $(readlink /proc/$join_pid/ns/pid), host $(readlink /proc/self/ns/pid)"
echo "== join as root -> setuid $U"
systemd-run --quiet --wait --pipe --collect -p PrivateNetwork=yes -p JoinsNamespaceOf="$unit.service" -p NoNewPrivileges=yes -- \
  /usr/bin/nsenter --target "$join_pid" --mount --pid --setuid "$(id -u "$U")" --setgid "$(id -g "$U")" --root -- \
  /bin/sh -c 'echo "uid=$(id -u) gid=$(id -g) pid1=$(cat /proc/1/comm) caps=$(grep CapEff /proc/self/status)"; echo "visible pids: $(ls /proc | grep -c "^[0-9]")"; for p in /proc/[0-9]*; do echo "  ${p#/proc/} $(cat $p/comm)"; done; echo "ifaces: $(ls /sys/class/net | tr "\n" " ")"'
echo "[join exit $?]"
systemctl stop "$unit"; echo "== stopped; LoadState=$(systemctl show "$unit" -p LoadState --value)"
