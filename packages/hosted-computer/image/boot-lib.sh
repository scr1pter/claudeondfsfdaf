# The cloud computer's boot steps (contract WP A54), sourced by boot.sh after the base archive is reinstalled. The image
# test calls them one by one. Each answers non-zero when it could not do its whole job; boot.sh then stops.
# Users: agent 10001, viewer 10002, git 10003, browser 10004, display 10005; groups share 10010, x 10011.

readonly AGENT=10001 VIEWER=10002 GIT=10003 BROWSER=10004 DISPLAY_USER=10005 SHARE=10010 XGROUP=10011
readonly DATA_BYTES=10000000000
readonly X_DISPLAY=:1
readonly XAUTH=/run/vector/x/auth

# spawn_as UID GID GROUPS LOG COMMAND...: starts a command in the background, in its own session, as an unprivileged
# user with no way back up (no new privileges, no capabilities, only the listed groups) and an empty environment.
spawn_as() {
  local uid=$1 gid=$2 groups=$3 log=$4
  shift 4
  local group_flag=--clear-groups
  [[ -n $groups ]] && group_flag="--groups=$groups"
  setsid setpriv --reuid="$uid" --regid="$gid" "$group_flag" --no-new-privs --inh-caps=-all --bounding-set=-all -- \
    env -i PATH=/usr/bin:/bin LANG=C.UTF-8 "$@" </dev/null >>"$log" 2>&1 &
}

# listening PORT: whether something accepts connections on 127.0.0.1:PORT.
listening() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

# check_disk_generation FILE GENERATION MINIMUM
check_disk_generation() {
  local file=$1 generation=$2 minimum=$3 disk
  mkdir -p "$(dirname "$file")"
  if [[ ! -s $file ]]; then
    echo "$generation" >"$file"
    chmod 0644 "$file"
  fi
  disk=$(cat "$file")
  [[ $disk =~ ^[0-9]+$ ]] || return 1
  ((disk >= minimum))
}

# load_firewall CONF RESOLV_CONF: the ruleset plus the resolvers, checked, loaded, then read back.
load_firewall() {
  local conf=$1 resolv=$2 ruleset v4="" v6="" address
  [[ -r $conf ]] || return 1
  while read -r key address _; do
    [[ $key == nameserver ]] || continue
    if [[ $address =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
      v4+="${v4:+, }$address"
    elif [[ $address =~ ^[0-9a-fA-F:]+$ ]]; then
      v6+="${v6:+, }$address"
    fi
  done <"$resolv"
  [[ -n $v4 || -n $v6 ]] || return 1
  ruleset=$(mktemp "${TMPDIR:-/run}/vector-firewall.XXXXXX") || return 1
  {
    cat "$conf"
    [[ -n $v4 ]] && echo "add element inet vector resolvers4 { $v4 }"
    [[ -n $v6 ]] && echo "add element inet vector resolvers6 { $v6 }"
  } >"$ruleset"
  nft -c -f "$ruleset" || { rm -f "$ruleset"; return 1; }
  nft -f "$ruleset" || { rm -f "$ruleset"; return 1; }
  rm -f "$ruleset"
  # Read back whole, not piped into `grep -q`: under boot.sh's pipefail, grep leaving at its first match can kill nft
  # with SIGPIPE mid-listing and fail a firewall that loaded.
  local listed
  listed=$(nft list chain inet vector output) || return 1
  [[ $listed == *'policy drop'* && $listed == *'tcp dport 443 accept'* ]] || return 1
}

# mount_scratch: memory disks for scratch space, hostd's sockets and state, the browser and the recorder. The agent can
# write nowhere on the system disk.
mount_scratch() {
  mountpoint -q /tmp || mount -t tmpfs -o size=512m,mode=1777,nosuid,nodev tmpfs /tmp || return 1
  mountpoint -q /var/tmp || mount -t tmpfs -o size=256m,mode=1777,nosuid,nodev tmpfs /var/tmp || return 1
  mountpoint -q /dev/shm || mount -t tmpfs -o size=512m,mode=1777,nosuid,nodev,noexec tmpfs /dev/shm || return 1
  mkdir -p /run/vector
  mountpoint -q /run/vector || mount -t tmpfs -o size=32m,mode=0755,nosuid,nodev tmpfs /run/vector || return 1
  mkdir -p /run/vector/browser /run/vector/rec
  mountpoint -q /run/vector/browser || mount -t tmpfs -o size=768m,mode=0755,nosuid,nodev tmpfs /run/vector/browser || return 1
  mountpoint -q /run/vector/rec || mount -t tmpfs -o size=256m,mode=0750,nosuid,nodev,noexec tmpfs /run/vector/rec || return 1
  # Each user sees only its own processes (best effort: an older kernel keeps the default).
  mount -o remount,hidepid=2 /proc 2>/dev/null || true
}

# mount_data IMAGE MOUNTPOINT: the agent's disk, a sparse file of exactly 10 GB with its own filesystem, so the
# kernel enforces the quota. Deleted files give their space back (discard).
mount_data() {
  local image=$1 target=$2
  mkdir -p "$(dirname "$image")" "$target"
  if [[ ! -f $image ]]; then
    truncate -s "$DATA_BYTES" "$image" || return 1
    mkfs.ext4 -q -F -m 0 -E root_owner=${AGENT}:${AGENT} "$image" || return 1
  fi
  [[ $(stat -c %s "$image") -eq $DATA_BYTES ]] || return 1
  chmod 0600 "$image"
  mountpoint -q "$target" || mount -o loop,nosuid,nodev,discard "$image" "$target" || return 1
  local options
  options=$(findmnt -no OPTIONS "$target") || return 1
  [[ ,$options, == *,nosuid,* ]] || return 1
}

# prepare_folders: the agent's work and home, the browser's folders, hostd's and the viewer's state, the X cookie.
prepare_folders() {
  install -d -o "$AGENT" -g "$AGENT" -m 0755 /data/work || return 1
  install -d -o "$AGENT" -g "$AGENT" -m 0700 /data/home || return 1
  install -d -o "$AGENT" -g "$SHARE" -m 2770 /data/work/downloads || return 1
  install -d -o 0 -g "$AGENT" -m 0750 /run/vector/hostd || return 1
  install -d -o 0 -g "$VIEWER" -m 0750 /run/vector/viewer || return 1
  install -d -o "$DISPLAY_USER" -g "$VIEWER" -m 2750 /run/vector/vnc || return 1
  install -d -o 0 -g 0 -m 0700 /run/vector/log || return 1
  install -d -o "$BROWSER" -g "$BROWSER" -m 0700 /run/vector/browser/profile /run/vector/browser/home || return 1
  install -d -o "$DISPLAY_USER" -g 0 -m 0750 /run/vector/rec || return 1
  install -d -o 0 -g "$XGROUP" -m 0750 /run/vector/x || return 1
  install -d -o "$GIT" -g "$AGENT" -m 2750 /var/lib/vector/git || return 1
  install -d -o 0 -g 0 -m 1777 /tmp/.X11-unix || return 1
  local cookie
  cookie=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
  [[ ${#cookie} -eq 32 ]] || return 1
  rm -f "$XAUTH"
  xauth -q -f "$XAUTH" add "$X_DISPLAY" . "$cookie" || return 1
  chown 0:"$XGROUP" "$XAUTH" && chmod 0640 "$XAUTH"
}

# write_browser_policy RUN_HOST: the managed policy blocks the run-API host the computer was booted with as well.
write_browser_policy() {
  local host=$1 policy=/etc/chromium/policies/managed/vector.json
  [[ -f $policy ]] || return 1
  node -e '
    const fs = require("fs")
    const [file, host] = process.argv.slice(1)
    const policy = JSON.parse(fs.readFileSync(file, "utf8"))
    if (!policy.URLBlocklist.includes(host)) policy.URLBlocklist.push(host)
    fs.writeFileSync(file, JSON.stringify(policy, null, 2))
  ' "$policy" "$host" || return 1
  chmod 0644 "$policy"
}

# start_display: the virtual display, no TCP, its cookie required.
start_display() {
  spawn_as "$DISPLAY_USER" "$DISPLAY_USER" "$XGROUP" /run/vector/log/display.log \
    Xvfb "$X_DISPLAY" -screen 0 1280x800x24 -auth "$XAUTH" -nolisten tcp -noreset
  local i
  for i in $(seq 1 50); do
    DISPLAY=$X_DISPLAY XAUTHORITY=$XAUTH xdotool getdisplaygeometry >/dev/null 2>&1 && return 0
    sleep 0.2
  done
  return 1
}

# start_vnc: the VNC server on a Unix socket only the viewer user can open (its folder is the display user's, group
# viewer); never TCP.
start_vnc() {
  local socket=/run/vector/vnc/vnc.sock i
  rm -f "$socket"
  (
    umask 0117
    spawn_as "$DISPLAY_USER" "$VIEWER" "$XGROUP" /run/vector/log/vnc.log \
      x11vnc -display "$X_DISPLAY" -auth "$XAUTH" -unixsockonly "$socket" -forever -shared -nopw -norc -quiet
  )
  for i in $(seq 1 50); do
    [[ -S $socket ]] && return 0
    sleep 0.2
  done
  return 1
}

# start_viewer: the viewer proxy, the only network listener.
start_viewer() {
  spawn_as "$VIEWER" "$VIEWER" "" /run/vector/log/viewer.log node /opt/vector/viewer-proxy.mjs
  local i
  for i in $(seq 1 50); do
    listening 6080 && return 0
    sleep 0.2
  done
  return 1
}

# start_hostd RUN_HOST SESSION: hostd, as root, with an empty environment.
start_hostd() {
  setsid env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 \
    node /opt/vector/hostd.mjs --run-host "$1" --session "$2" </dev/null >>/run/vector/log/hostd.log 2>&1 &
  local pid=$!
  sleep 1
  kill -0 "$pid" 2>/dev/null
}
