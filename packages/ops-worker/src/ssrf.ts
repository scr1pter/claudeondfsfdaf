// Which addresses the ops Worker may probe (S8, WP A46). A probe goes only to:
// - an `https:` URL on port 443 with no credentials, at most 2,048 characters;
// - a host name, never an IP literal (the URL parser has already turned forms like 2130706433 or 0x7f.1 into a dotted
//   address, which the numeric last label catches), and never a name that points at a private zone or a metadata
//   service (`localhost`, `*.local`, `*.internal`, a single label, …);
// - a host the account verified (A47: DNS TXT or a well-known file), matched exactly, never a subdomain or a parent;
// - a host whose every address, looked up over DNS-over-HTTPS just before, is on the public internet: private,
//   loopback, link-local, carrier-grade NAT, documentation, benchmarking, multicast, reserved, the cloud metadata
//   addresses, and IPv6 outside 2000::/3 or in its special blocks are refused, and one such address among public ones
//   refuses the host.
// Redirects are never followed (check.ts). Cloudflare's own fetch also refuses private and prohibited addresses; the
// lookup here makes the rule explicit instead of relying on that.

import { OPS_LIMITS } from "./limits"
import type { Fetcher } from "./runtime"

export type TargetRefusal = "url" | "scheme" | "port" | "credentials" | "address" | "not-verified"
export type Target = { ok: true; url: string; host: string } | { ok: false; reason: TargetRefusal }

const BLOCKED_NAMES = new Set(["localhost", "metadata.google.internal", "metadata.goog", "instance-data"])
const BLOCKED_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".arpa",
  ".home",
  ".lan",
  ".intranet",
  ".localdomain",
  ".invalid",
  ".test",
  ".example",
]
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * A host name the Worker may ever probe or keep as verified: lower-case letters, digits and hyphens in two or more
 * labels, not all-numeric at the end (no IP address), and not a private or reserved name.
 */
export function validHostname(name: unknown): name is string {
  if (typeof name !== "string" || name.length > 253) return false
  const labels = name.split(".")
  if (labels.length < 2 || labels.some((label) => !LABEL.test(label))) return false
  if (/^\d+$/.test(labels.at(-1)!)) return false
  return !blockedHostname(name)
}

/** A host name refused whatever it resolves to: this machine, a private zone, a metadata name, or a single label. */
export function blockedHostname(hostname: string) {
  const name = hostname.toLowerCase().replace(/\.$/, "")
  if (!name || !name.includes(".") || BLOCKED_NAMES.has(name)) return true
  return BLOCKED_SUFFIXES.some((suffix) => name.endsWith(suffix))
}

/**
 * The URL the Worker may probe, normalised (no fragment), or why not. Without `verified` only the shape is checked, as
 * when a config is stored; a probe always passes the account's verified hosts.
 */
export function probeTarget(input: unknown, verified?: ReadonlySet<string>): Target {
  if (typeof input !== "string" || input.length > OPS_LIMITS.urlMaxLength) return { ok: false, reason: "url" }
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return { ok: false, reason: "url" }
  }
  if (url.protocol !== "https:") return { ok: false, reason: "scheme" }
  if (url.username || url.password) return { ok: false, reason: "credentials" }
  if (url.port !== "" && url.port !== "443") return { ok: false, reason: "port" }
  const host = url.hostname.toLowerCase().replace(/\.$/, "")
  if (host.startsWith("[") || !validHostname(host)) return { ok: false, reason: "address" }
  if (verified && !verified.has(host)) return { ok: false, reason: "not-verified" }
  url.hash = ""
  return { ok: true, url: url.href, host }
}

// [first address, prefix length] for every IPv4 block that is not the public internet, plus Azure's host address.
const BLOCKED_V4: readonly (readonly [string, number])[] = [
  ["0.0.0.0", 8], // this network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT (also Alibaba Cloud's metadata address)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, including the 169.254.169.254 metadata address
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments (also Oracle Cloud's metadata address)
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved and broadcast
  ["168.63.129.16", 32], // Azure's host services address
]

/**
 * Whether an IP address is anything but the public internet. IPv6 is allowed only inside global unicast (2000::/3),
 * minus its special blocks; an IPv4-mapped address (::ffff:a.b.c.d) is judged by its IPv4 address. Anything that does
 * not parse, or carries a zone, is refused. The same rules as the API's safe-fetch.ts.
 */
export function blockedAddress(address: string): boolean {
  const v4 = v4Number(address)
  if (v4 !== undefined) return blockedV4(v4)
  if (address.includes("%")) return true
  const words = v6Words(address)
  if (!words) return true
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff)
    return blockedV4(((words[6]! << 16) | words[7]!) >>> 0)
  if ((words[0]! & 0xe000) !== 0x2000) return true // outside 2000::/3: loopback, ULA, link-local, multicast, NAT64…
  if (words[0] === 0x2001 && words[1]! < 0x0200) return true // 2001::/23 protocol assignments, Teredo included
  if (words[0] === 0x2001 && words[1] === 0x0db8) return true // documentation
  if (words[0] === 0x2002) return true // 6to4, which embeds an IPv4 address that could be private
  if (words[0] === 0x3fff && words[1]! < 0x1000) return true // documentation (3fff::/20)
  return false
}

function blockedV4(value: number) {
  return BLOCKED_V4.some(([first, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    return (value & mask) >>> 0 === (v4Number(first)! & mask) >>> 0
  })
}

/** A dotted IPv4 address as a number, or undefined when it is not one. */
function v4Number(address: string): number | undefined {
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address)
  if (!parts) return undefined
  const octets = parts.slice(1).map(Number)
  if (octets.some((octet) => octet > 255)) return undefined
  return octets.reduce((total, octet) => ((total << 8) | octet) >>> 0, 0)
}

/** The eight 16-bit words of an IPv6 address, or undefined when it does not parse. */
function v6Words(address: string): number[] | undefined {
  let text = address.toLowerCase()
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1]
  if (dotted) {
    const value = v4Number(dotted)
    if (value === undefined) return undefined
    text = `${text.slice(0, -dotted.length)}${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`
  }
  const halves = text.split("::")
  if (halves.length > 2) return undefined
  const head = halves[0] ? halves[0].split(":") : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined
  const words = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail]
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return undefined
  return words.map((word) => parseInt(word, 16))
}

export const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query"

/**
 * What a host resolves to: public (with how long the answer may be reused), blocked (some address is not public),
 * missing (no address at all, which a probe counts as a failure) or error (the lookup failed, which is inconclusive).
 */
export type Resolution =
  | { kind: "public"; ttlMs: number }
  | { kind: "blocked" }
  | { kind: "missing" }
  | { kind: "error" }

type Lookup = { kind: "answer"; addresses: string[]; ttl: number } | { kind: "none" } | { kind: "error" }

/** Looks the host up over DNS-over-HTTPS (A and AAAA together) and judges every address. */
export async function resolvePublic(
  host: string,
  fetcher: Fetcher,
  timeoutMs = OPS_LIMITS.probeTimeoutMs,
): Promise<Resolution> {
  const [v4, v6] = await Promise.all([lookup(host, "A", fetcher, timeoutMs), lookup(host, "AAAA", fetcher, timeoutMs)])
  const answers = [v4, v6].filter((entry): entry is Extract<Lookup, { kind: "answer" }> => entry.kind === "answer")
  if (answers.some((entry) => entry.addresses.some(blockedAddress))) return { kind: "blocked" }
  const addresses = answers.flatMap((entry) => entry.addresses)
  if (addresses.length) {
    const ttl = Math.min(...answers.filter((entry) => entry.addresses.length).map((entry) => entry.ttl)) * 1000
    return { kind: "public", ttlMs: Math.max(OPS_LIMITS.dnsMinCacheMs, Math.min(OPS_LIMITS.dnsMaxCacheMs, ttl)) }
  }
  // No address: a name that does not exist (or has no address records) is the site's outage; a lookup that failed, for
  // either kind of address, leaves it unknown.
  if (v4.kind === "error" || v6.kind === "error") return { kind: "error" }
  return { kind: "missing" }
}

async function lookup(host: string, type: "A" | "AAAA", fetcher: Fetcher, timeoutMs: number): Promise<Lookup> {
  try {
    const response = await fetcher(`${DOH_ENDPOINT}?name=${encodeURIComponent(host)}&type=${type}`, {
      method: "GET",
      headers: { accept: "application/dns-json" },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {})
      return { kind: "error" }
    }
    const text = await response.text()
    if (text.length > 64 * 1024) return { kind: "error" }
    const answer = JSON.parse(text) as { Status?: unknown; Answer?: unknown }
    // 3 is NXDOMAIN: the name does not exist. Anything but 0 or 3 (SERVFAIL, REFUSED…) is a failed lookup.
    if (answer.Status === 3) return { kind: "none" }
    if (answer.Status !== 0) return { kind: "error" }
    const wanted = type === "A" ? 1 : 28
    const records = Array.isArray(answer.Answer) ? answer.Answer : []
    const addresses: string[] = []
    let ttl = Infinity
    for (const record of records) {
      if (!record || typeof record !== "object") continue
      const { type: kind, data, TTL } = record as { type?: unknown; data?: unknown; TTL?: unknown }
      if (kind !== wanted) continue
      if (typeof data !== "string") return { kind: "error" }
      addresses.push(data)
      if (typeof TTL === "number" && Number.isFinite(TTL) && TTL >= 0) ttl = Math.min(ttl, TTL)
    }
    if (!addresses.length) return { kind: "none" }
    return { kind: "answer", addresses, ttl: Number.isFinite(ttl) ? ttl : 0 }
  } catch {
    return { kind: "error" }
  }
}
