#!/usr/bin/env bash
set -euo pipefail

# Capture only processes in this private network namespace. No interface connects it to the host network.
# Dummy default routes preserve evidence of unexpected outbound attempts instead of failing before packets exist.
if [ "${1:-}" != "--inside" ]; then
  test "$(uname -s)" = Linux || { echo "Packet capture requires the isolated Linux job"; exit 1; }
  test "$(id -u)" != 0 || { echo "Run this wrapper as the workload user, not root"; exit 1; }
  test -n "${1:-}" || { echo "Provide the evidence directory"; exit 1; }
  mkdir -p "$1"
  exec sudo -n unshare --net --mount --fork bash "$0" --inside \
    "$(id -un)" "$PATH" "$(cd "$1" && pwd)" "$(readlink /proc/self/ns/net)" \
    "${DISPLAY:-}" "${XAUTHORITY:-}"
fi

user="$2"
task_path="$3"
output="$4"
parent_network="$5"
display="$6"
authority="$7"
test "$(id -u)" = 0
test "$(readlink /proc/self/ns/net)" != "$parent_network"
mount --make-rprivate /
ip link set lo up
ip link add audit0 type dummy
# Keep the namespace's own IPv6 autoconfiguration out of the app evidence, while retaining an IPv6 sink route.
ip link set audit0 addrgenmode none
sysctl -q -w net.ipv6.conf.audit0.accept_ra=0 net.ipv6.conf.audit0.autoconf=0 net.ipv6.conf.audit0.router_solicitations=0
ip link set audit0 up
ip address add 198.18.0.1/32 dev audit0
ip -6 address add 2001:db8::1/128 dev audit0 nodad
ip route add default dev audit0
ip -6 route add default dev audit0
# A private resolver file stops the host's resolver configuration participating in the experiment. DNS attempts go
# to the namespace's sink and remain visible in the capture; the fixture web uses Chromium's explicit host mapping.
printf 'nameserver 198.18.0.53\noptions attempts:1 timeout:1\n' > "$output/resolv.conf"
mount --bind "$output/resolv.conf" /etc/resolv.conf
# sudo resolves this machine's own host name. Hosted runners do not always list it in /etc/hosts, and the lookup then
# leaks to the DNS sink as harness traffic before the workload starts. A private hosts file maps only that one name.
{ cat /etc/hosts; printf '127.0.1.1 %s\n' "$(hostname)"; } > "$output/hosts"
mount --bind "$output/hosts" /etc/hosts
printf '{"isolated":true,"namespace":"%s","parent":"%s","externalInterface":false}\n' \
  "$(readlink /proc/self/ns/net)" "$parent_network" > "$output/isolation.json"
ip -j address show > "$output/interfaces.json"
ip -j route show table all > "$output/routes.json"
ip -6 -j route show table all > "$output/routes-v6.json"
chown -R "$user" "$output"

tcpdump -i any -n -U -s 0 -w "$output/traffic.pcap" 2> "$output/tcpdump.log" &
capture_pid=$!
finish() {
  kill -INT "$capture_pid" 2>/dev/null || true
  wait "$capture_pid" || true
  chown -R "$user" "$output"
}
trap finish EXIT
sleep 1
kill -0 "$capture_pid"
sudo -n -u "$user" env -i PATH="$task_path" DISPLAY="$display" XAUTHORITY="$authority" \
  VECTOR_CAPTURE_DURATION_MS=1800000 \
  bun --no-env-file scripts/local-mode-capture.ts "$output" > "$output/workload.log" 2>&1
finish
trap - EXIT
# Every workload TCP endpoint is fixture HTTP. Decode all ports so a random fixture port cannot hide a request;
# payload streams that still do not decode are rejected rather than silently excluded from the comparison.
tshark -r "$output/traffic.pcap" -d tcp.port==0-65535,http -T json \
  -e frame.time_epoch -e ip.src -e ipv6.src -e ip.dst -e ipv6.dst \
  -e tcp.srcport -e tcp.dstport -e udp.srcport -e udp.dstport \
  -e tcp.stream -e tcp.len \
  -e http.request.method -e http.host -e http.request.uri > "$output/packets.json"
chown -R "$user" "$output"
sudo -n -u "$user" env -i PATH="$task_path" \
  bun --no-env-file scripts/local-mode-capture.ts "$output" --audit
