import type { Sandbox } from "@vercel/sandbox"
import { randomBytes } from "node:crypto"
import { AGENT_UID, BROWSER_UID, DATA_QUOTA_BYTES } from "../src/limits"

/*
 * The real-microVM check (contract WP A54's e2e item): what a Docker container cannot show, on the provider's own
 * microVM. It starts one throwaway computer from the base snapshot (never tagged `vector-mode`, so the reconciler leaves
 * it alone), boots it with a session id that exists nowhere and a run host that does not resolve, then checks, inside:
 * the firewall is loaded with its drop policy; the agent's user reaches tcp/443 but not port 80, another DNS server
 * or the metadata address; nothing listens on the VNC port; the agent's disk is the 10 GB loop mount; the agent has no
 * sudo; and Chromium starts with its own sandbox on as the browser user. The computer is stopped at the end, whatever
 * happened. Runs from vector-codium-e2e.yml (input `hosted`), in the protected codium-test environment.
 *
 *   bun script/microvm-check.ts   (CODIUM_E2E_HOSTED_VERCEL_TOKEN, _TEAM_ID, _PROJECT_ID, CODIUM_E2E_HOSTED_SNAPSHOT)
 */

export type CheckSdk = Pick<typeof Sandbox, "create">

/** Node code the agent's user runs: each probe prints one line, `<name> open|closed`. */
export const PROBES = `
const net = require("net"), dgram = require("dgram")
const tcp = (name, host, port) => new Promise((done) => {
  const socket = net.connect({ host, port, timeout: 4000 })
  const end = (state) => { socket.destroy(); console.log(name + " " + state); done() }
  socket.on("connect", () => end("open")); socket.on("timeout", () => end("closed")); socket.on("error", () => end("closed"))
})
const dns = (name, host) => new Promise((done) => {
  const socket = dgram.createSocket("udp4")
  const query = Buffer.from("abcd01000001000000000000076578616d706c6503636f6d0000010001", "hex")
  const timer = setTimeout(() => { socket.close(); console.log(name + " closed"); done() }, 4000)
  socket.on("message", () => { clearTimeout(timer); socket.close(); console.log(name + " open"); done() })
  socket.on("error", () => { clearTimeout(timer); console.log(name + " closed"); done() })
  socket.send(query, 53, host)
})
;(async () => {
  await tcp("https", "1.1.1.1", 443)
  await tcp("http", "1.1.1.1", 80)
  await tcp("metadata", "169.254.169.254", 80)
  await tcp("vnc", "127.0.0.1", 5900)
  await tcp("viewer", "127.0.0.1", 6080)
  await dns("other-dns", "9.9.9.9")
})()
`

/** What each probe must answer for the agent's user. The viewer proxy is refused even on loopback. */
export const EXPECTED: Readonly<Record<string, "open" | "closed">> = {
  https: "open",
  http: "closed",
  metadata: "closed",
  vnc: "closed",
  viewer: "closed",
  "other-dns": "closed",
}

export function parseProbes(output: string) {
  const found: Record<string, string> = {}
  for (const line of output.split("\n")) {
    const match = /^([a-z-]+) (open|closed)$/.exec(line.trim())
    if (match) found[match[1]!] = match[2]!
  }
  return found
}

const as = (uid: number, command: string) =>
  `setpriv --reuid=${uid} --regid=${uid} --clear-groups --no-new-privs --inh-caps=-all --bounding-set=-all -- ${command}`

export async function microvmCheck(input: {
  sdk: CheckSdk
  credentials: { token: string; teamId: string; projectId: string }
  snapshotId: string
  log?: (line: string) => void
}) {
  const log = input.log ?? (() => {})
  const failures: string[] = []
  const sandbox = await input.sdk.create({
    name: `vector-check-${randomBytes(4).toString("hex")}`,
    source: { type: "snapshot", snapshotId: input.snapshotId },
    persistent: false,
    resources: { vcpus: 2 },
    timeout: 20 * 60_000,
    region: "iad1",
    ports: [6080],
    networkPolicy: "allow-all",
    tags: { "vector-check": "1" },
    ...input.credentials,
  })
  const root = async (script: string) => {
    const result = await sandbox.runCommand({ cmd: "/bin/sh", args: ["-c", script], sudo: true })
    return { code: result.exitCode, out: (await result.stdout()).trim() }
  }
  const expect = (name: string, ok: boolean) => {
    log(`${ok ? "pass" : "FAIL"} ${name}`)
    if (!ok) failures.push(name)
  }
  try {
    const session = `hs_${Array.from(randomBytes(26), (byte) => "abcdefghijklmnopqrstuvwxyz234567"[byte % 32]).join("")}`
    const boot = await root(`/opt/vector/boot.sh --run-host vector-check.invalid --session ${session}`)
    expect("boot.sh finishes", boot.code === 0)
    const firewall = await root("nft list chain inet vector output")
    expect("the firewall is loaded with a drop policy", firewall.code === 0 && firewall.out.includes("policy drop"))
    const probes = parseProbes((await root(as(AGENT_UID, `node -e '${PROBES.replace(/'/g, "'\\''")}'`))).out)
    for (const [name, state] of Object.entries(EXPECTED)) expect(`agent: ${name} is ${state}`, probes[name] === state)
    const listeners = await root("netstat -ltn 2>/dev/null || ss -ltn")
    expect("nothing listens on the VNC port", !/[:.]5900\s/.test(listeners.out))
    expect("the viewer proxy listens", /[:.]6080\s/.test(listeners.out))
    const data = await root("findmnt -no SOURCE,OPTIONS /data && df -B1 --output=size /data | tail -n 1")
    const size = Number(data.out.split("\n").pop()?.trim())
    expect("the agent's disk is a nosuid loop mount", /^\/dev\/loop\d+ .*nosuid/m.test(data.out))
    expect("the agent's disk is at most 10 GB", size > 0 && size <= DATA_QUOTA_BYTES)
    const sudo = await root(as(AGENT_UID, "sh -c 'command -v sudo || echo none'"))
    expect("the agent has no sudo", sudo.out === "none")
    const chromium = await root(
      as(BROWSER_UID, "env HOME=/run/vector/browser/home chromium-browser --headless=new --dump-dom about:blank"),
    )
    expect("Chromium starts with its sandbox on", chromium.code === 0)
  } finally {
    await sandbox.stop().catch(() => {})
  }
  return failures
}

async function main() {
  const env = (name: string) => process.env[name]?.trim() ?? ""
  const { Sandbox } = await import("@vercel/sandbox")
  const failures = await microvmCheck({
    sdk: Sandbox,
    credentials: {
      token: env("CODIUM_E2E_HOSTED_VERCEL_TOKEN"),
      teamId: env("CODIUM_E2E_HOSTED_VERCEL_TEAM_ID"),
      projectId: env("CODIUM_E2E_HOSTED_VERCEL_PROJECT_ID"),
    },
    snapshotId: env("CODIUM_E2E_HOSTED_SNAPSHOT"),
    log: (line) => console.log(line),
  })
  if (failures.length) {
    console.error(`${failures.length} check(s) failed`)
    process.exit(1)
  }
}

if (import.meta.main) await main()
