import { lookup } from "node:dns/promises"
import { request as httpsRequest } from "node:https"
import { isIP } from "node:net"

/*
 * Outbound requests to addresses a user can choose (S8): push endpoints, domain verification and anything else the
 * server fetches on someone's behalf. Each request:
 * - goes only to `https:` on an allowed port (443 unless the caller widens it), with no credentials in the URL;
 * - refuses a host that names this machine or a private network (`localhost`, `*.local`, `*.internal`, a single
 *   label, the cloud metadata names);
 * - resolves the host and refuses it when ANY address is private, loopback, link-local, multicast, reserved or a cloud
 *   metadata address, so a record set mixing a public and a private address never gets through;
 * - connects to the address it checked, never resolving the name again, so DNS rebinding cannot swap the target
 *   between the check and the connection (TLS still verifies the certificate against the host name);
 * - never follows a redirect: a 3xx answer is an error;
 * - stops after a timeout (10 s unless the caller says otherwise) and refuses an answer over a size cap.
 *
 * It runs on Node (Vercel's runtime) through `node:https`; the resolver and the connection can be replaced in tests.
 */

export type SafeFetchFailure = "url" | "address" | "redirect" | "timeout" | "too-large" | "network"

export class SafeFetchError extends Error {
  constructor(
    readonly reason: SafeFetchFailure,
    message: string,
  ) {
    super(message)
    this.name = "SafeFetchError"
  }
}

export type SafeFetchInit = {
  method?: "GET" | "HEAD" | "POST" | "PUT" | "DELETE"
  headers?: Readonly<Record<string, string>>
  body?: Uint8Array | string
  signal?: AbortSignal
}

/** One connection to an address safeFetch already checked. */
export type SafeTransportRequest = {
  url: URL
  /** The checked address to connect to; the URL's host is used only for TLS and the Host header. */
  address: string
  method: string
  headers: Record<string, string>
  body?: Uint8Array
  timeoutMs: number
  maxBytes: number
  signal?: AbortSignal
}
export type SafeTransportResponse = { status: number; headers: Record<string, string>; body: Uint8Array }
export type SafeTransport = (request: SafeTransportRequest) => Promise<SafeTransportResponse>

export type SafeFetchOptions = {
  /** Default 10 000 ms. */
  timeoutMs?: number
  /** The largest answer body read, default 64 KiB. */
  maxResponseBytes?: number
  /** Ports a URL may name, default 443 only. */
  ports?: readonly number[]
  /** Resolves a host name to every address it has. Default: the system resolver. */
  resolve?: (hostname: string) => Promise<readonly string[]>
  /** Makes the connection. Default: `node:https` to the checked address. */
  transport?: SafeTransport
}

export const SAFE_FETCH_TIMEOUT_MS = 10_000
export const SAFE_FETCH_MAX_BYTES = 64 * 1024

/** Fetches `input` under the S8 rules above. Throws SafeFetchError when a rule refuses it or the request fails. */
export async function safeFetch(
  input: string | URL,
  init: SafeFetchInit = {},
  options: SafeFetchOptions = {},
): Promise<Response> {
  const url = safeUrl(input, options.ports ?? [443])
  const addresses = await safeAddresses(url, options.resolve ?? systemResolve)
  const body = typeof init.body === "string" ? new TextEncoder().encode(init.body) : init.body
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(init.headers ?? {})) {
    const key = name.toLowerCase()
    // The connection layer owns these; a caller cannot point the request at another host or smuggle a body.
    if (key === "host" || key === "content-length" || key === "transfer-encoding" || key === "connection") continue
    headers[key] = value
  }
  const answer = await (options.transport ?? nodeTransport)({
    url,
    address: addresses[0]!,
    method: init.method ?? "GET",
    headers,
    ...(body ? { body } : {}),
    timeoutMs: options.timeoutMs ?? SAFE_FETCH_TIMEOUT_MS,
    maxBytes: options.maxResponseBytes ?? SAFE_FETCH_MAX_BYTES,
    ...(init.signal ? { signal: init.signal } : {}),
  })
  if (answer.status >= 300 && answer.status < 400 && answer.status !== 304)
    throw new SafeFetchError("redirect", "The address answered with a redirect, which is not followed.")
  if (!Number.isInteger(answer.status) || answer.status < 200 || answer.status > 599)
    throw new SafeFetchError("network", "The address gave an answer that could not be read.")
  const empty = answer.status === 204 || answer.status === 205 || answer.status === 304
  return new Response(empty ? null : new Uint8Array(answer.body), { status: answer.status, headers: answer.headers })
}

/** The URL when the rules allow it: https, an allowed port, no credentials, and a host that is not refused by name. */
export function safeUrl(input: string | URL, ports: readonly number[] = [443]) {
  let url: URL
  try {
    url = new URL(String(input))
  } catch {
    throw new SafeFetchError("url", "That address is not a valid URL.")
  }
  if (url.protocol !== "https:") throw new SafeFetchError("url", "Only https addresses are fetched.")
  if (url.username || url.password) throw new SafeFetchError("url", "Addresses with credentials are not fetched.")
  const port = url.port ? Number(url.port) : 443
  if (!ports.includes(port)) throw new SafeFetchError("url", "That port is not allowed.")
  const host = bareHost(url.hostname)
  if (isIP(host) ? blockedAddress(host) : blockedHostname(host))
    throw new SafeFetchError("address", "That address points at a private or reserved network.")
  return url
}

/** Every address the host resolves to, all of them public, or a refusal. An IP literal is checked as it is. */
export async function safeAddresses(url: URL, resolve: (hostname: string) => Promise<readonly string[]>) {
  const host = bareHost(url.hostname)
  if (isIP(host)) {
    if (blockedAddress(host)) throw new SafeFetchError("address", "That address points at a private network.")
    return [host]
  }
  const addresses = await resolve(host).catch(() => {
    throw new SafeFetchError("network", "That host name could not be resolved.")
  })
  if (!addresses.length) throw new SafeFetchError("network", "That host name could not be resolved.")
  if (addresses.some((address) => !isIP(address) || blockedAddress(address)))
    throw new SafeFetchError("address", "That host name resolves to a private or reserved network.")
  return [...addresses]
}

const BLOCKED_NAMES = new Set(["localhost", "metadata.google.internal", "metadata.goog", "instance-data"])
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".arpa", ".home", ".lan", ".intranet", ".localdomain"]

/** A host name refused before any lookup: this machine, a private zone, a metadata name, or a single label. */
export function blockedHostname(hostname: string) {
  const name = hostname.toLowerCase().replace(/\.$/, "")
  if (!name || !name.includes(".") || BLOCKED_NAMES.has(name)) return true
  return BLOCKED_SUFFIXES.some((suffix) => name.endsWith(suffix))
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
 * not parse, or carries a zone, is refused.
 */
export function blockedAddress(address: string): boolean {
  const kind = isIP(address)
  if (kind === 4) return blockedV4(v4Number(address))
  if (kind !== 6 || address.includes("%")) return true
  const words = v6Words(address)
  if (!words) return true
  // ::ffff:a.b.c.d, the form a resolver may give for an IPv4 address.
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
    return (value & mask) >>> 0 === (v4Number(first) & mask) >>> 0
  })
}

function v4Number(address: string) {
  return address.split(".").reduce((total, part) => ((total << 8) | Number(part)) >>> 0, 0)
}

/** The eight 16-bit words of an IPv6 address, or undefined when it does not parse. */
function v6Words(address: string): number[] | undefined {
  let text = address.toLowerCase()
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1]
  if (dotted) {
    if (isIP(dotted) !== 4) return undefined
    const value = v4Number(dotted)
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

function bareHost(hostname: string) {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname
}

/** The system resolver, every address of a host name (WP A50 reuses it for its TLS reads). */
export async function systemResolve(hostname: string) {
  const answers = await lookup(hostname, { all: true, verbatim: true })
  return answers.map((answer) => answer.address)
}

/**
 * The default connection: `node:https` straight to the checked address. The URL's host name goes in the Host header
 * and as the TLS server name, so the certificate is still checked against it; the name is never resolved again.
 */
export const nodeTransport: SafeTransport = (input) =>
  new Promise<SafeTransportResponse>((resolve, reject) => {
    const host = bareHost(input.url.hostname)
    let settled = false
    const finish = (outcome: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      input.signal?.removeEventListener("abort", abort)
      outcome()
    }
    const fail = (error: SafeFetchError) =>
      finish(() => {
        request.destroy()
        reject(error)
      })
    const request = httpsRequest(
      {
        host: input.address,
        family: isIP(input.address),
        port: input.url.port ? Number(input.url.port) : 443,
        path: `${input.url.pathname}${input.url.search}`,
        method: input.method,
        headers: {
          ...input.headers,
          host: input.url.host,
          ...(input.body ? { "content-length": String(input.body.byteLength) } : {}),
        },
        ...(isIP(host) ? {} : { servername: host }),
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = []
        let size = 0
        response.on("data", (chunk: Buffer) => {
          size += chunk.length
          if (size > input.maxBytes) return fail(new SafeFetchError("too-large", "The answer was too large."))
          chunks.push(chunk)
        })
        response.on("error", () => fail(new SafeFetchError("network", "The connection failed.")))
        response.on("end", () =>
          finish(() =>
            resolve({
              status: response.statusCode ?? 0,
              headers: Object.fromEntries(
                Object.entries(response.headers).flatMap(([name, value]) =>
                  value === undefined ? [] : [[name, Array.isArray(value) ? value.join(", ") : value]],
                ),
              ),
              body: Buffer.concat(chunks),
            }),
          ),
        )
      },
    )
    const abort = () => fail(new SafeFetchError("timeout", "The request was stopped."))
    const timer = setTimeout(
      () => fail(new SafeFetchError("timeout", "The address did not answer in time.")),
      input.timeoutMs,
    )
    input.signal?.addEventListener("abort", abort, { once: true })
    if (input.signal?.aborted) abort()
    request.on("error", () => fail(new SafeFetchError("network", "The connection failed.")))
    request.end(input.body ? Buffer.from(input.body) : undefined)
  })
