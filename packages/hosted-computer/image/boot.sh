#!/bin/bash
# The cloud computer's boot step (contract WP A54). Vector runs it as root on every session start, with exactly
# `--run-host <host> --session <id>` and no environment (WP A53's boot step; no credential ever passes through here).
#
# It fails closed: if any step below fails, it stops before the agent, the browser or hostd start, the computer never
# reports, and Vector stops it within minutes (WP A53's boot grace).
#   1. Check the two arguments.
#   2. Reinstall the system components from the base image's verified archive (the archive's digest is fixed in this
#      file when the image is built), so nothing a session changed in them survives into the next.
#   3. Refuse a disk made from a base image older than the minimum generation this image accepts.
#   4. Load the firewall (tcp/443, DNS to the resolver, loopback) and check it is in place.
#   5. Memory disks for scratch space, the browser and the recorder; the agent's 10 GB disk (a loop-mounted file).
#   6. The display, its VNC server on a Unix socket, the viewer proxy, then hostd.
set -euo pipefail
umask 077
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export LANG=C

readonly BASE_SHA256="@BASE_SHA256@"
readonly IMAGE_GENERATION="@IMAGE_GENERATION@"
readonly MIN_DISK_GENERATION="@MIN_DISK_GENERATION@"
readonly BASE_ARCHIVE=/usr/lib/vector/base/base.tar

fail() {
  echo "vector boot: $*" >&2
  exit 1
}

# 1. Exactly two named arguments, each checked.
[[ $# -eq 4 && $1 == --run-host && $3 == --session ]] || fail "usage: boot.sh --run-host <host> --session <id>"
readonly RUN_HOST=$2
readonly SESSION=$4
[[ ${#RUN_HOST} -ge 4 && ${#RUN_HOST} -le 253 ]] || fail "bad run host"
[[ $RUN_HOST =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] || fail "bad run host"
[[ $SESSION =~ ^hs_[a-z2-7]{26}$ ]] || fail "bad session"
[[ $(id -u) -eq 0 ]] || fail "boot.sh runs as root"
[[ $BASE_SHA256 =~ ^[a-f0-9]{64}$ && $IMAGE_GENERATION =~ ^[0-9]+$ && $MIN_DISK_GENERATION =~ ^[0-9]+$ ]] ||
  fail "this boot script was not stamped by the image build"

# One boot at a time.
exec 9>/run/vector-boot.lock
flock -n 9 || fail "another boot is running"

# 2. The system components, reinstalled from the verified archive: /opt/vector (but this script) and the browser's
#    managed policy are replaced as a whole, so a file added or changed there is gone.
echo "${BASE_SHA256}  ${BASE_ARCHIVE}" | sha256sum -c --status - || fail "the base archive does not match this image"
find /opt/vector -mindepth 1 -maxdepth 1 ! -name boot.sh -exec rm -rf {} +
rm -rf /etc/chromium/policies
tar --numeric-owner -xpf "$BASE_ARCHIVE" -C / || fail "the base archive could not be installed"
[[ $(cat /opt/vector/GENERATION) == "$IMAGE_GENERATION" ]] || fail "the base archive is from another image"
# Nothing on the system disk may raise privileges.
find / -xdev -type f -perm /6000 -exec chmod ug-s {} + 2>/dev/null || true

# shellcheck source=boot-lib.sh
. /opt/vector/boot-lib.sh

# 3. The disk's own generation: written on its first boot, refused when older than this image accepts.
check_disk_generation /var/lib/vector/disk-generation "$IMAGE_GENERATION" "$MIN_DISK_GENERATION" || fail "this disk is too old for this image"

# 4. The firewall, or nothing.
load_firewall /opt/vector/nftables.conf /etc/resolv.conf || fail "the firewall did not load"

# 5. Disks.
mount_scratch || fail "the memory disks could not be mounted"
mount_data /var/lib/vector/data.img /data || fail "the agent's disk could not be mounted"
prepare_folders || fail "the folders could not be prepared"
write_browser_policy "$RUN_HOST" || fail "the browser policy could not be written"
rm -rf /var/lib/vector/pack

# 6. The display, the viewer and hostd.
start_display || fail "the display did not start"
start_vnc || fail "the VNC server did not start"
start_viewer || fail "the viewer proxy did not start"
start_hostd "$RUN_HOST" "$SESSION" || fail "hostd did not start"
echo "vector boot: ready (generation ${IMAGE_GENERATION})"
