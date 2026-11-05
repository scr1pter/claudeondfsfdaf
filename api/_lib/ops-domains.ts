import { domainToASCII } from "node:url"
import { safeFetch, SafeFetchError, type SafeFetchOptions } from "./safe-fetch.js"

/*
 * Domain verification for On Call and Release Guard (WP A47). The ops Worker probes only host names the account proved
 * it controls (A46 matches them exactly). An account proves a host by publishing a token Vector gave it, in either of:
 *
 * - a DNS TXT record at `_vector-verify.<domain>` with the value `vector-verify=<token>`, read over DNS-over-HTTPS
 *   (Cloudflare's resolver, the one the Worker uses), so this server never queries the name through its own resolver;
 * - a file at `https://<domain>/.well-known/vector-verify.txt` with a line `vector-verify=<token>`, fetched through
 *   safeFetch (S8: https on 443, public addresses only, the checked address pinned, no redirect followed). A redirect is
 *   a failure: the file must be served at exactly that address.
 *
 * Either one is enough. A check is "verified", "failed" when both answered and neither shows the token, or
 * "inconclusive" when one could not be read (a timeout, a resolver failure, a 5xx or a bot wall), so a passing outage
 * never takes verification away. A verified domain is checked again weekly (ops-settings.ts) and stays verified for at
 * most 14 days without a successful check.
 */

export const OPS_VERIFY = {
  txtPrefix: "_vector-verify.",
  valuePrefix: "vector-verify=",
  wellKnownPath: "/.well-known/vector-verify.txt",
  /** Each of the two reads gives up after this. */
  timeoutMs: 5_000,
  /** The well-known file is at most this large. */
  fileBytes: 4_096,
  /** A verified domain is checked again this long after its last success, */
  recheckMs: 7 * 24 * 60 * 60_000,
  /** a re-check that could not be read is tried again after this, */
  retryMs: 24 * 60 * 60_000,
  /** and verification lapses this long after the last success, whatever the re-checks said. */
  graceMs: 14 * 24 * 60 * 60_000,
} as const

/** The DNS-over-HTTPS resolver: the ops Worker's (packages/ops-worker/src/ssrf.ts DOH_ENDPOINT). */
export const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query"

// The ops Worker's own host-name rules (packages/ops-worker/src/ssrf.ts validHostname), so a domain this server accepts
// is one the Worker will probe. test/on-call.test.ts compares the two on the same inputs.
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

/** Whether a lower-case ASCII host name is one the ops Worker may verify and probe. */
export function opsHostname(name: unknown): name is string {
  if (typeof name !== "string" || name.length > 253) return false
  const labels = name.split(".")
  if (labels.length < 2 || labels.some((label) => !LABEL.test(label))) return false
  if (/^\d+$/.test(labels.at(-1)!)) return false
  if (BLOCKED_NAMES.has(name)) return false
  return !BLOCKED_SUFFIXES.some((suffix) => name.endsWith(suffix))
}

/**
 * The domain someone typed, as the ops services store it: trimmed, lower-case, one trailing dot dropped, international
 * names in their ASCII form. Undefined when it is not a host name the Worker may probe (a URL, an IP address, a single
 * label, a private zone).
 */
export function normalizeDomain(input: unknown): string | undefined {
  if (typeof input !== "string" || input.length > 260) return undefined
  const trimmed = input.trim().toLowerCase().replace(/\.$/, "")
  if (!trimmed || /[\s/:@?#\\[\]]/.test(trimmed)) return undefined
  const ascii = /^[\x21-\x7e]+$/.test(trimmed) ? trimmed : domainToASCII(trimmed)
  return opsHostname(ascii) ? ascii : undefined
}

/** What the account publishes to prove it controls `domain`: the TXT record and the well-known file. */
export function verificationRecord(domain: string, token: string) {
  const value = `${OPS_VERIFY.valuePrefix}${token}`
  return {
    txt: { name: `${OPS_VERIFY.txtPrefix}${domain}`, value },
    file: { url: `https://${domain}${OPS_VERIFY.wellKnownPath}`, body: value },
  }
}

export type DomainCheck =
  | { result: "verified"; method: "dns" | "http" }
  | { result: "failed" }
  | { result: "inconclusive" }

type Read = "found" | "absent" | "error"

export type DomainCheckOptions = {
  /** For the DNS-over-HTTPS request (a fixed public resolver, not a user's address). */
  fetcher?: typeof fetch
  /** For the well-known file (safeFetch's resolver and connection, replaced in tests). */
  safe?: Pick<SafeFetchOptions, "resolve" | "transport">
}

/** Checks both ways at once. */
export async function checkDomain(
  domain: string,
  token: string,
  options: DomainCheckOptions = {},
): Promise<DomainCheck> {
  const expected = `${OPS_VERIFY.valuePrefix}${token}`
  const [dns, http] = await Promise.all([
    readTxt(domain, expected, options.fetcher ?? fetch),
    readFile(domain, expected, options.safe ?? {}),
  ])
  if (dns === "found") return { result: "verified", method: "dns" }
  if (http === "found") return { result: "verified", method: "http" }
  if (dns === "absent" && http === "absent") return { result: "failed" }
  return { result: "inconclusive" }
}

async function readTxt(domain: string, expected: string, fetcher: typeof fetch): Promise<Read> {
  const name = `${OPS_VERIFY.txtPrefix}${domain}`
  try {
    const response = await fetcher(`${DOH_ENDPOINT}?name=${encodeURIComponent(name)}&type=TXT`, {
      method: "GET",
      headers: { accept: "application/dns-json" },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(OPS_VERIFY.timeoutMs),
    })
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined)
      return "error"
    }
    const text = await response.text()
    if (text.length > 64 * 1024) return "error"
    const answer = JSON.parse(text) as { Status?: unknown; Answer?: unknown }
    // 3 is NXDOMAIN: no such name, so no record. Anything but 0 or 3 (SERVFAIL, REFUSED…) is a lookup that failed.
    if (answer.Status === 3) return "absent"
    if (answer.Status !== 0) return "error"
    const records = Array.isArray(answer.Answer) ? answer.Answer : []
    for (const record of records) {
      if (!record || typeof record !== "object") continue
      const { type, data } = record as { type?: unknown; data?: unknown }
      if (type === 16 && typeof data === "string" && txtValue(data) === expected) return "found"
    }
    return "absent"
  } catch {
    return "error"
  }
}

/**
 * A TXT record's text as resolvers print it: one or more quoted strings (a long value is split into 255-byte pieces),
 * joined, with `\"` and `\\` unescaped. Unquoted data is taken as it is.
 */
export function txtValue(data: string) {
  const parts = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1]!.replace(/\\(.)/g, "$1"))
  return (parts.length ? parts.join("") : data).trim()
}

async function readFile(domain: string, expected: string, safe: DomainCheckOptions["safe"]): Promise<Read> {
  let response: Response
  try {
    response = await safeFetch(
      `https://${domain}${OPS_VERIFY.wellKnownPath}`,
      { method: "GET", headers: { accept: "text/plain", "user-agent": "Vector-Verify/1" } },
      { timeoutMs: OPS_VERIFY.timeoutMs, maxResponseBytes: OPS_VERIFY.fileBytes, ...safe },
    )
  } catch (error) {
    if (error instanceof SafeFetchError)
      // A redirect, an oversized file, a private address or a refused name is an answer: the token is not there. A
      // timeout or a connection or lookup failure says nothing.
      return error.reason === "timeout" || error.reason === "network" ? "error" : "absent"
    return "error"
  }
  if (response.status === 401 || response.status === 403 || response.status === 429 || response.status >= 500) {
    await response.body?.cancel().catch(() => undefined)
    return "error"
  }
  if (response.status < 200 || response.status >= 300) {
    await response.body?.cancel().catch(() => undefined)
    return "absent"
  }
  const text = await response.text().catch(() => undefined)
  if (text === undefined) return "error"
  return text.split(/\r?\n/).some((line) => line.trim() === expected) ? "found" : "absent"
}
