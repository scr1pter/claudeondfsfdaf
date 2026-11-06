# The cloud computer's base image (contract WP A54). Built by the image workflow (WP A58) from packages/hosted-computer
# after `bun run build`, with the Vector CLI for Linux (musl) at bin/vector; pushed to the hosted team's registry; then
# script/bake-snapshot.ts turns it into the base snapshot every computer starts from. The base is pinned by digest, the
# same Alpine the Vector CLI container uses.
#
# What the image guarantees (test/image.test.ts and its Docker job check each):
# - the agent runs as uid 10001 with no sudo, no setuid or setgid file anywhere on the system disk, and no access to the
#   display, the VNC socket, the browser's debugging pipe or a GitHub token;
# - boot.sh reinstalls /opt/vector and the browser policy from an archive whose digest is stamped into boot.sh here;
# - the firewall (image/nftables.conf) allows tcp/443, DNS to the resolver and loopback, and boot fails closed without it;
# - the VNC server listens on a Unix socket only, and the viewer proxy is the one network listener (port 6080).
FROM alpine:3.23@sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0

ARG VECTOR_IMAGE_GENERATION
ARG VECTOR_MIN_DISK_GENERATION=1

RUN set -eu; \
    case "${VECTOR_IMAGE_GENERATION:-}" in ''|*[!0-9]*) echo "VECTOR_IMAGE_GENERATION must be a number" >&2; exit 1;; esac; \
    case "${VECTOR_MIN_DISK_GENERATION}" in ''|*[!0-9]*) echo "VECTOR_MIN_DISK_GENERATION must be a number" >&2; exit 1;; esac; \
    [ "$VECTOR_MIN_DISK_GENERATION" -le "$VECTOR_IMAGE_GENERATION" ]

RUN apk add --no-cache \
      bash ca-certificates coreutils findutils util-linux e2fsprogs tar gzip \
      nftables nodejs git \
      chromium font-dejavu font-liberation \
      xvfb xauth x11vnc xdotool ffmpeg \
    && { [ -x /usr/bin/tar ] || ln -s "$(command -v tar)" /usr/bin/tar; }

RUN set -eu; \
    addgroup -g 10010 share; addgroup -g 10011 x; \
    addgroup -g 10001 agent; adduser -D -H -u 10001 -G agent -h /data/home -s /bin/bash agent; addgroup agent share; \
    addgroup -g 10002 viewer; adduser -D -H -u 10002 -G viewer -h /nonexistent -s /sbin/nologin viewer; \
    addgroup -g 10003 git; adduser -D -H -u 10003 -G git -h /nonexistent -s /sbin/nologin git; \
    addgroup -g 10004 browser; adduser -D -H -u 10004 -G browser -h /run/vector/browser/home -s /sbin/nologin browser; \
    addgroup browser x; addgroup browser share; \
    addgroup -g 10005 display; adduser -D -H -u 10005 -G display -h /nonexistent -s /sbin/nologin display; \
    addgroup display x; \
    rm -f /usr/bin/sudo /usr/bin/doas /bin/su /usr/bin/su

COPY --chmod=755 bin/vector /usr/local/bin/vector
COPY dist/hostd.mjs dist/viewer-proxy.mjs /usr/lib/vector/stage/opt/vector/
COPY image/credential-guard.js image/viewer.html image/viewer.js image/nftables.conf image/chromium-policies.json image/boot-lib.sh /usr/lib/vector/stage/opt/vector/
COPY image/boot.sh /opt/vector/boot.sh

RUN set -eu; \
    stage=/usr/lib/vector/stage; \
    echo "$VECTOR_IMAGE_GENERATION" > "$stage/opt/vector/GENERATION"; \
    mkdir -p "$stage/etc/chromium/policies/managed"; \
    cp "$stage/opt/vector/chromium-policies.json" "$stage/etc/chromium/policies/managed/vector.json"; \
    chmod -R u=rwX,go=rX "$stage"; \
    mkdir -p /usr/lib/vector/base; \
    tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf /usr/lib/vector/base/base.tar -C "$stage" opt/vector etc/chromium; \
    sum=$(sha256sum /usr/lib/vector/base/base.tar | cut -d' ' -f1); \
    sed -i "s/@BASE_SHA256@/$sum/; s/@IMAGE_GENERATION@/$VECTOR_IMAGE_GENERATION/; s/@MIN_DISK_GENERATION@/$VECTOR_MIN_DISK_GENERATION/" /opt/vector/boot.sh; \
    tar --numeric-owner -xpf /usr/lib/vector/base/base.tar -C /; \
    rm -rf "$stage"; \
    echo "$VECTOR_IMAGE_GENERATION" > /usr/lib/vector/GENERATION; \
    chown -R 0:0 /opt/vector /usr/lib/vector; \
    chmod 0444 /usr/lib/vector/base/base.tar /usr/lib/vector/GENERATION; \
    chmod 0755 /opt/vector/boot.sh; \
    mkdir -p /data /var/lib/vector; chmod 0755 /data; chmod 0711 /var/lib/vector; \
    find / -xdev -type f -perm /6000 -exec chmod ug-s {} +; \
    for binary in /usr/bin/setpriv /usr/bin/xdotool /usr/bin/ffmpeg /usr/bin/chromium-browser /usr/bin/git /usr/bin/tar \
      /usr/sbin/nft /usr/bin/node /usr/local/bin/vector /usr/bin/Xvfb /usr/bin/x11vnc /usr/bin/xauth; do \
      [ -x "$binary" ] || { echo "missing $binary" >&2; exit 1; }; \
    done

# No user and no entrypoint: the provider starts the computer, and Vector runs /opt/vector/boot.sh as root.
WORKDIR /
