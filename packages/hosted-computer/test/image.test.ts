import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Hosted } from "@vectordevai/schema/hosted"
import {
  AGENT_UID,
  BINARIES,
  BROWSER_UID,
  DATA_QUOTA_BYTES,
  DISPLAY_UID,
  DOWNLOADS_DIR,
  GIT_UID,
  IMAGE_MAX_BYTES,
  SHARE_GID,
  VIEWER_UID,
  X_GID,
} from "../src/limits"

// WP A54, S7: the cloud computer's image. Static checks run everywhere: the base pinned by digest, the users, no sudo
// and no setuid file, boot.sh failing closed (run here up to the point where it would need root), the firewall
// allowing tcp/443, DNS to the resolver and loopback only, the browser policy barring the run-API host. With
// VECTOR_TEST_HOSTED_IMAGE naming a built image (the Codium lane's image job), the same image is booted in Docker and
// checked inside: ports, sudo, the VNC bind, viewer tokens, the credential guard and the profile wipe.

const root = path.join(import.meta.dir, "..")
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8")
const dockerfile = read("image/Dockerfile")
const boot = read("image/boot.sh")
const lib = read("image/boot-lib.sh")
const firewall = read("image/nftables.conf")
const policy = JSON.parse(read("image/chromium-policies.json")) as Record<string, unknown>

const cleanups: string[] = []
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const bash = (script: string, env: Record<string, string> = {}) =>
  Bun.spawnSync(["bash", "-c", script], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env }, stdout: "pipe", stderr: "pipe" })

describe("the Dockerfile", () => {
  test("the base is pinned by digest, the same Alpine the Vector CLI container uses", () => {
    const from = /^FROM (\S+)$/m.exec(dockerfile)?.[1]
    expect(from).toMatch(/^alpine:[\d.]+@sha256:[a-f0-9]{64}$/)
    expect(read("../cloud/container/Dockerfile")).toContain(`FROM ${from}`)
    expect(dockerfile.match(/^FROM /gm)).toHaveLength(1)
  })

  test("the users and groups are the ones hostd and boot.sh use; the agent gets no sudo, doas or su", () => {
    for (const [name, uid] of [
      ["agent", AGENT_UID],
      ["viewer", VIEWER_UID],
      ["git", GIT_UID],
      ["browser", BROWSER_UID],
      ["display", DISPLAY_UID],
    ] as const)
      expect(dockerfile).toContain(`adduser -D -H -u ${uid} -G ${name}`)
    expect(dockerfile).toContain(`addgroup -g ${SHARE_GID} share`)
    expect(dockerfile).toContain(`addgroup -g ${X_GID} x`)
    expect(dockerfile).toContain("rm -f /usr/bin/sudo /usr/bin/doas /bin/su /usr/bin/su")
    expect(dockerfile).not.toMatch(/apk add[^\n]*\b(sudo|doas)\b/)
    expect(dockerfile).not.toMatch(/^USER /m)
    expect(dockerfile).toContain("find / -xdev -type f -perm /6000 -exec chmod ug-s {} +")
  })

  test("the image generation is required and stamped into boot.sh with the base archive's digest", () => {
    expect(dockerfile).toContain("VECTOR_IMAGE_GENERATION must be a number")
    expect(dockerfile).toContain('s/@BASE_SHA256@/$sum/')
    expect(dockerfile).toContain("s/@IMAGE_GENERATION@/$VECTOR_IMAGE_GENERATION/")
    expect(dockerfile).toContain("s/@MIN_DISK_GENERATION@/$VECTOR_MIN_DISK_GENERATION/")
    expect(dockerfile).toContain("-cf /usr/lib/vector/base/base.tar -C \"$stage\" opt/vector etc/chromium")
  })

  test("every program hostd runs is checked to be where hostd looks for it", () => {
    for (const binary of Object.values(BINARIES)) expect(dockerfile).toContain(binary)
  })
})

describe("boot.sh", () => {
  test("fails closed: every step stops the boot, and the firewall comes before anything starts", () => {
    expect(boot).toStartWith("#!/bin/bash")
    expect(boot).toContain("set -euo pipefail")
    const order = [
      'sha256sum -c --status - || fail "the base archive does not match this image"',
      ". /opt/vector/boot-lib.sh",
      "check_disk_generation",
      "load_firewall /opt/vector/nftables.conf /etc/resolv.conf || fail",
      "mount_scratch || fail",
      "mount_data /var/lib/vector/data.img /data || fail",
      "start_display || fail",
      "start_vnc || fail",
      "start_viewer || fail",
      'start_hostd "$RUN_HOST" "$SESSION" || fail',
    ]
    const at = order.map((line) => boot.indexOf(line))
    expect(at.every((index) => index > 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(boot).not.toContain("--no-sandbox")
  })

  test("takes exactly WP A53's two arguments and refuses anything else, before touching anything", () => {
    const script = path.join(root, "image", "boot.sh")
    for (const args of [
      [],
      ["--run-host", "hosted-run.vectordev.ai"],
      ["--run-host", "hosted-run.vectordev.ai", "--session", "hs_short"],
      ["--run-host", "http://x", "--session", `hs_${"a".repeat(26)}`],
      ["--session", `hs_${"a".repeat(26)}`, "--run-host", "hosted-run.vectordev.ai"],
      ["--run-host", "hosted-run.vectordev.ai", "--session", `hs_${"a".repeat(26)}`, "--extra"],
    ]) {
      const result = Bun.spawnSync(["bash", script, ...args], { stdout: "pipe", stderr: "pipe" })
      expect({ args, code: result.exitCode, said: result.stderr.toString().includes("vector boot:") }).toEqual({ args, code: 1, said: true })
    }
    // Good arguments, but not root (these tests never are): it stops there.
    const unprivileged = Bun.spawnSync(["bash", script, "--run-host", "hosted-run.vectordev.ai", "--session", `hs_${"a".repeat(26)}`], { stderr: "pipe" })
    expect(unprivileged.exitCode).toBe(1)
    expect(unprivileged.stderr.toString()).toContain(process.getuid?.() === 0 ? "not stamped" : "runs as root")
  })

  test("an unstamped boot script never runs: the image build must fill in the digest and generations", () => {
    expect(boot).toContain('readonly BASE_SHA256="@BASE_SHA256@"')
    expect(boot).toContain("this boot script was not stamped by the image build")
  })
})

describe("the boot steps (boot-lib.sh), with stand-in programs", () => {
  function sandbox(nft: string) {
    const dir = mkdtempSync(path.join(tmpdir(), "vector-boot-"))
    cleanups.push(dir)
    const bin = path.join(dir, "bin")
    mkdirSync(bin)
    writeFileSync(path.join(bin, "nft"), `#!/bin/bash\n${nft}\n`)
    chmodSync(path.join(bin, "nft"), 0o755)
    return { dir, bin, lib: path.join(root, "image", "boot-lib.sh") }
  }
  const resolv = (dir: string, text: string) => {
    writeFileSync(path.join(dir, "resolv.conf"), text)
    return path.join(dir, "resolv.conf")
  }

  test("the firewall loads with the resolvers added, and is read back", () => {
    const s = sandbox(`
      if [ "$1" = "list" ]; then printf 'chain output {\\n type filter hook output priority 0; policy drop;\\n tcp dport 443 accept\\n}\\n'; exit 0; fi
      if [ "$1" = "-c" ] || [ "$1" = "-f" ]; then file="\${@: -1}"; cp "$file" "${"$"}{RECORD}"; exit 0; fi
      exit 1`)
    const record = path.join(s.dir, "ruleset")
    const conf = resolv(s.dir, "# provider\nnameserver 10.11.12.13\nnameserver fd00::53\nsearch example\n")
    const result = bash(`. ${s.lib}; load_firewall ${path.join(root, "image", "nftables.conf")} ${conf}`, {
      PATH: `${s.bin}:/usr/bin:/bin`,
      TMPDIR: s.dir,
      RECORD: record,
    })
    expect(result.exitCode).toBe(0)
    const ruleset = readFileSync(record, "utf8")
    expect(ruleset).toContain(firewall)
    expect(ruleset).toContain("add element inet vector resolvers4 { 10.11.12.13 }")
    expect(ruleset).toContain("add element inet vector resolvers6 { fd00::53 }")
  })

  test("it fails closed: a ruleset the kernel refuses, no resolver, or a chain without its drop policy", () => {
    const failing = sandbox("exit 1")
    expect(bash(`. ${failing.lib}; load_firewall ${path.join(root, "image", "nftables.conf")} ${resolv(failing.dir, "nameserver 1.2.3.4\n")}`, { PATH: `${failing.bin}:/usr/bin:/bin`, TMPDIR: failing.dir }).exitCode).not.toBe(0)
    const fine = sandbox(`[ "$1" = "list" ] && echo "policy drop; tcp dport 443 accept"; exit 0`)
    expect(bash(`. ${fine.lib}; load_firewall ${path.join(root, "image", "nftables.conf")} ${resolv(fine.dir, "search only\n")}`, { PATH: `${fine.bin}:/usr/bin:/bin`, TMPDIR: fine.dir }).exitCode).not.toBe(0)
    const open = sandbox(`[ "$1" = "list" ] && echo "policy accept; tcp dport 443 accept"; exit 0`)
    expect(bash(`. ${open.lib}; load_firewall ${path.join(root, "image", "nftables.conf")} ${resolv(open.dir, "nameserver 1.2.3.4\n")}`, { PATH: `${open.bin}:/usr/bin:/bin`, TMPDIR: open.dir }).exitCode).not.toBe(0)
  })

  test("a disk records its generation on first boot and is refused below the image's minimum", () => {
    const s = sandbox("exit 1")
    const file = path.join(s.dir, "state", "disk-generation")
    expect(bash(`. ${s.lib}; check_disk_generation ${file} 3 1`).exitCode).toBe(0)
    expect(readFileSync(file, "utf8").trim()).toBe("3")
    expect(bash(`. ${s.lib}; check_disk_generation ${file} 5 3`).exitCode).toBe(0)
    expect(bash(`. ${s.lib}; check_disk_generation ${file} 5 4`).exitCode).not.toBe(0)
    writeFileSync(file, "garbage\n")
    expect(bash(`. ${s.lib}; check_disk_generation ${file} 5 1`).exitCode).not.toBe(0)
  })

  test("the agent's disk is exactly 10 GB, mounted nosuid, nodev; scratch space is on memory disks", () => {
    expect(lib).toContain(`readonly DATA_BYTES=${DATA_QUOTA_BYTES}`)
    expect(lib).toContain("mount -o loop,nosuid,nodev,discard")
    expect(lib).toMatch(/mount -t tmpfs -o size=512m,mode=1777,nosuid,nodev tmpfs \/tmp/)
    expect(lib).toContain("hidepid=2")
  })

  test("the display has no TCP, VNC is a Unix socket only, and the services drop to their own users", () => {
    expect(lib).toContain("-nolisten tcp")
    expect(lib).toContain("-unixsockonly")
    expect(lib).not.toMatch(/x11vnc[^\n]*-rfbport/)
    expect(lib).toContain('spawn_as "$VIEWER" "$VIEWER" "" /run/vector/log/viewer.log node /opt/vector/viewer-proxy.mjs')
    expect(lib).toContain("--no-new-privs --inh-caps=-all --bounding-set=-all")
    expect(lib).toContain(`install -d -o "$DISPLAY_USER" -g "$VIEWER" -m 2750 /run/vector/vnc`)
  })
})

describe("the firewall", () => {
  const output = firewall.slice(firewall.indexOf("chain output"), firewall.indexOf("chain input"))
  const input = firewall.slice(firewall.indexOf("chain input"), firewall.indexOf("chain forward"))

  test("every chain drops by default", () => {
    expect(output).toContain("policy drop;")
    expect(input).toContain("policy drop;")
    expect(firewall.slice(firewall.indexOf("chain forward"))).toContain("policy drop;")
  })

  test("out: loopback, replies, DNS to the resolvers, tcp/443 and IPv6 neighbour discovery; nothing else", () => {
    const accepts = output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.endsWith("accept"))
    expect(accepts).toEqual([
      'oif "lo" accept',
      "ct state established,related accept",
      "ip daddr @resolvers4 udp dport 53 accept",
      "ip daddr @resolvers4 tcp dport 53 accept",
      "ip6 daddr @resolvers6 udp dport 53 accept",
      "ip6 daddr @resolvers6 tcp dport 53 accept",
      "tcp dport 443 accept",
      "icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert, nd-router-solicit } accept",
    ])
    expect(output).not.toMatch(/udp dport 443|dport 80\b|dport 25\b/)
  })

  test("the agent and the browser cannot reach the viewer proxy even on loopback; their egress is counted", () => {
    const lines = output.split("\n").map((line) => line.trim())
    const drop = lines.indexOf(`oif "lo" meta skuid { ${AGENT_UID}, ${BROWSER_UID} } tcp dport ${Hosted.VIEWER_PORT} drop`)
    expect(drop).toBeGreaterThan(0)
    expect(drop).toBeLessThan(lines.indexOf('oif "lo" accept'))
    expect(lines).toContain(`meta skuid { ${AGENT_UID}, ${GIT_UID}, ${BROWSER_UID} } oif != "lo" counter name "egress"`)
  })

  test("in: the viewer port only", () => {
    expect(input).toContain(`tcp dport ${Hosted.VIEWER_PORT} accept`)
    expect(input.match(/dport \d+ accept/g)).toEqual([`dport ${Hosted.VIEWER_PORT} accept`])
  })
})

describe("the browser policy", () => {
  test("bars the run-API host and the local viewer; no password manager, autofill, devtools or extensions", () => {
    expect(policy.URLBlocklist).toEqual(expect.arrayContaining([Hosted.RUN_API_HOST, "localhost:6080", "127.0.0.1:6080", "file://*"]))
    expect(policy).toMatchObject({
      PasswordManagerEnabled: false,
      AutofillCreditCardEnabled: false,
      AutofillAddressEnabled: false,
      DeveloperToolsAvailability: 2,
      ExtensionInstallBlocklist: ["*"],
      BrowserSignin: 0,
      SyncDisabled: true,
      DownloadDirectory: DOWNLOADS_DIR,
      QuicAllowed: false,
    })
    // hostd drives the browser over its debugging pipe; the policy must not take that away.
    expect(policy.RemoteDebuggingAllowed).toBeUndefined()
  })

  test("boot.sh adds the run host it was booted with (a preview's own host) to the blocklist", () => {
    expect(lib).toContain("if (!policy.URLBlocklist.includes(host)) policy.URLBlocklist.push(host)")
  })
})

describe("sizes", () => {
  test("the image and the agent's disk fit the 16 GB the nightly storage charge assumes (WP A53)", () => {
    const rates = read("../../api/_lib/hosted-rates.ts")
    const max = Number(/HOSTED_DISK_GB_MAX = (\d+)/.exec(rates)?.[1])
    expect(max).toBe(16)
    expect(IMAGE_MAX_BYTES + DATA_QUOTA_BYTES).toBeLessThanOrEqual(max * 1_000_000_000)
  })
})

describe("the live view page", () => {
  test("the token is read from the fragment, removed from the address and sent as the first message", () => {
    const html = read("image/viewer.html")
    const script = read("image/viewer.js")
    expect(html).toContain('<script src="/viewer.js"></script>')
    expect(html).not.toMatch(/<script>(?!<\/script>)/)
    expect(script).toContain('new URLSearchParams(location.hash.slice(1)).get("vt")')
    expect(script.indexOf("history.replaceState")).toBeLessThan(script.indexOf("new WebSocket"))
    expect(script).toContain("socket.send(token)")
    expect(script).not.toMatch(/socket\?|[?&]vt=/)
  })
})

// ── The built image, in Docker (CI) ────────────────────────────────────────────────────────────────────────────────

const IMAGE = process.env.VECTOR_TEST_HOSTED_IMAGE
const docker = IMAGE ? describe : describe.skip

docker("the built image (Docker, CI only)", () => {
  test("booted in a privileged container, every check inside passes", () => {
    const result = Bun.spawnSync(
      ["docker", "run", "--rm", "--privileged", "-v", `${path.join(root, "test", "docker")}:/checks:ro`, IMAGE!, "node", "/checks/in-image.mjs"],
      { stdout: "pipe", stderr: "pipe", timeout: 600_000 },
    )
    const lines = result.stdout.toString().split("\n").filter(Boolean)
    const failed = lines.map((line) => JSON.parse(line) as { check: string; ok: boolean; detail?: string }).filter((line) => !line.ok)
    expect({ failed, stderr: failed.length ? result.stderr.toString().slice(-2000) : "" }).toEqual({ failed: [], stderr: "" })
    expect(result.exitCode).toBe(0)
    expect(lines.length).toBeGreaterThan(30)
  }, 600_000)

  test("without the right to load a firewall, boot fails closed and starts nothing", () => {
    const result = Bun.spawnSync(
      ["docker", "run", "--rm", IMAGE!, "/opt/vector/boot.sh", "--run-host", "vector-check.invalid", "--session", `hs_${"a".repeat(26)}`],
      { stdout: "pipe", stderr: "pipe", timeout: 300_000 },
    )
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain("the firewall did not load")
    expect(result.stdout.toString()).not.toContain("ready")
  }, 300_000)

  test("the image holds no build leftovers or test files", () => {
    const result = Bun.spawnSync(["docker", "run", "--rm", IMAGE!, "sh", "-c", "ls /usr/lib/vector/stage /checks 2>&1; ls /opt/vector"], { stdout: "pipe" })
    const text = result.stdout.toString()
    expect(text).toContain("No such file")
    expect(text).toContain("hostd.mjs")
    expect(existsSync(path.join(root, "test", "docker", "in-image.mjs"))).toBe(true)
  }, 120_000)
})
