// One probe of one URL (WP A46): GET with an 8 s timeout and no redirects followed, judged as ok, a failure or
// inconclusive. Only a failure counts toward "two failures in a row"; inconclusive answers are ones that say nothing
// about whether the site works for its users:
//
//   ok             2xx, 304, or a 3xx whose Location stays on the same origin (not followed)
//   failure        any other 4xx or 5xx, a 3xx to another origin (a cross-domain redirect) or with no usable Location,
//                  a timeout, a network or TLS failure, a host with no address
//   inconclusive   401, 403, 429, a bot challenge (a challenge header, or a 5xx HTML page from a challenge), a host that
//                  resolves to a private address (never probed), a DNS lookup that failed
//
// The body is never stored: it is cancelled unread, except the first 8 KiB of a 5xx HTML answer, read to tell a
// challenge from an outage.

import { discard } from "./internal"
import { OPS_LIMITS } from "./limits"
import type { ProbeOutcome, ProbeReason } from "./protocol"
import type { Fetcher } from "./runtime"
import type { Resolution } from "./ssrf"

export type ProbeResult = { outcome: ProbeOutcome; reason: ProbeReason; status?: number; ms: number }

export const PROBE_HEADERS = Object.freeze({
  "user-agent": "Vector/Ops (+https://vectordev.ai/docs/codium)",
  accept: "*/*",
  "cache-control": "no-cache",
})

/** Headers a bot check sets on the answer it gives instead of the site. */
const CHALLENGE_HEADERS: readonly (readonly [string, RegExp])[] = [
  ["cf-mitigated", /^challenge$/i],
  ["x-vercel-mitigated", /^challenge$/i],
  ["x-amzn-waf-action", /^(?:challenge|captcha)$/i],
]
/** Markers of a challenge page in the first bytes of a 5xx HTML answer. */
const CHALLENGE_BODY = /challenge-platform|cf-chl|cf_chl_opt|_cf_chl|captcha/i

/** What a probe comes to without a request, when the host's lookup did not give a public address. */
export function resolutionResult(resolution: Exclude<Resolution, { kind: "public" }>): ProbeResult {
  if (resolution.kind === "missing") return { outcome: "fail", reason: "dns", ms: 0 }
  if (resolution.kind === "blocked") return { outcome: "inconclusive", reason: "address", ms: 0 }
  return { outcome: "inconclusive", reason: "resolver", ms: 0 }
}

export async function probe(
  url: string,
  deps: { fetch: Fetcher; now: () => number; timeoutMs?: number },
): Promise<ProbeResult> {
  const started = deps.now()
  const signal = AbortSignal.timeout(deps.timeoutMs ?? OPS_LIMITS.probeTimeoutMs)
  let response: Response
  try {
    response = await deps.fetch(url, { method: "GET", headers: { ...PROBE_HEADERS }, redirect: "manual", signal })
  } catch (error) {
    return { outcome: "fail", reason: timedOut(error, signal) ? "timeout" : "network", ms: elapsed(deps, started) }
  }
  const status = response.status
  const ms = () => elapsed(deps, started)
  if (status >= 300 && status < 400 && status !== 304) {
    await discard(response)
    return {
      outcome: sameOrigin(url, response.headers.get("location")) ? "ok" : "fail",
      reason: "redirect",
      status,
      ms: ms(),
    }
  }
  if (challengeHeaders(response.headers)) {
    await discard(response)
    return { outcome: "inconclusive", reason: "challenge", status, ms: ms() }
  }
  if (status === 401 || status === 403) {
    await discard(response)
    return { outcome: "inconclusive", reason: "auth", status, ms: ms() }
  }
  if (status === 429) {
    await discard(response)
    return { outcome: "inconclusive", reason: "rate-limited", status, ms: ms() }
  }
  if (status >= 500 && /text\/html/i.test(response.headers.get("content-type") ?? "")) {
    const head = await sniff(response, OPS_LIMITS.challengeSniffBytes)
    if (head === undefined && signal.aborted) return { outcome: "fail", reason: "timeout", status, ms: ms() }
    if (head !== undefined && CHALLENGE_BODY.test(head))
      return { outcome: "inconclusive", reason: "challenge", status, ms: ms() }
    return { outcome: "fail", reason: "status", status, ms: ms() }
  }
  await discard(response)
  if ((status >= 200 && status < 300) || status === 304) return { outcome: "ok", reason: "status", status, ms: ms() }
  return { outcome: "fail", reason: "status", status, ms: ms() }
}

/** A redirect counts as up only when its Location resolves to the probed URL's own origin (scheme, host and port). */
export function sameOrigin(url: string, location: string | null): boolean {
  if (!location) return false
  try {
    return new URL(location, url).origin === new URL(url).origin
  } catch {
    return false
  }
}

function challengeHeaders(headers: Headers) {
  return CHALLENGE_HEADERS.some(([name, value]) => value.test(headers.get(name)?.trim() ?? ""))
}

/** The first bytes of the body as text, then the rest cancelled. Undefined when it could not be read. */
async function sniff(response: Response, limit: number): Promise<string | undefined> {
  const reader = response.body?.getReader()
  if (!reader) return ""
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (size < limit) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      size += value.byteLength
    }
  } catch {
    return undefined
  } finally {
    try {
      await reader.cancel()
    } catch {
      // Already done.
    }
  }
  const bytes = new Uint8Array(Math.min(size, limit))
  let offset = 0
  for (const chunk of chunks) {
    if (offset >= bytes.byteLength) break
    const part = chunk.subarray(0, bytes.byteLength - offset)
    bytes.set(part, offset)
    offset += part.byteLength
  }
  return new TextDecoder().decode(bytes)
}

function timedOut(error: unknown, signal: AbortSignal) {
  if (signal.aborted) return true
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
}

function elapsed(deps: { now: () => number }, started: number) {
  return Math.max(0, deps.now() - started)
}

/** Runs `work` over `items` with at most `limit` running at once, keeping the order of the answers. */
export async function pool<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await work(items[index]!)
    }
  })
  await Promise.all(lanes)
  return results
}
