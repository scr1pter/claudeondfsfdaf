import { describe, expect, test } from "bun:test"
import { pool, probe, resolutionResult, sameOrigin } from "../src/check"
import { OPS_LIMITS } from "../src/limits"
import { html } from "./fakes"

// WP A46: one probe is a GET with an 8 s timeout that never follows a redirect. 401, 403, 429 and bot challenges are
// inconclusive; a cross-domain redirect fails; only failures count toward "two failures in a row".

const URL_ = "https://status.vector-fixture.com/health"

function run(answer: Response | (() => Promise<Response>) | Error, timeoutMs?: number) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const clock = { now: 1_000 }
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    clock.now += 120
    if (answer instanceof Error) throw answer
    return typeof answer === "function" ? answer() : answer
  }
  return probe(URL_, { fetch, now: () => clock.now, ...(timeoutMs ? { timeoutMs } : {}) }).then((result) => ({
    result,
    calls,
  }))
}

describe("probe", () => {
  test("a GET with no redirects followed, an abort signal and no credentials", async () => {
    const { result, calls } = await run(new Response("ok"))
    expect(result).toEqual({ outcome: "ok", reason: "status", status: 200, ms: 120 })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(URL_)
    expect(calls[0]!.init.method).toBe("GET")
    expect(calls[0]!.init.redirect).toBe("manual")
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal)
    const headers = new Headers(calls[0]!.init.headers)
    expect(headers.get("authorization")).toBeNull()
    expect(headers.get("cookie")).toBeNull()
    expect(headers.get("user-agent")).toMatch(/^Vector\/Ops /)
  })

  test("2xx and 304 are up", async () => {
    for (const status of [200, 201, 204, 304]) {
      const { result } = await run(new Response(status === 204 || status === 304 ? null : "x", { status }))
      expect({ status, outcome: result.outcome }).toEqual({ status, outcome: "ok" })
    }
  })

  test("a redirect on the same origin is up and is not followed", async () => {
    for (const location of [
      "/login",
      "https://status.vector-fixture.com/next",
      "https://STATUS.vector-fixture.com:443/x",
    ]) {
      const { result, calls } = await run(new Response(null, { status: 302, headers: { location } }))
      expect({ location, result }).toEqual({
        location,
        result: { outcome: "ok", reason: "redirect", status: 302, ms: 120 },
      })
      expect(calls).toHaveLength(1)
    }
  })

  test("a cross-domain redirect fails, and so does one to http, another port or nowhere", async () => {
    for (const location of [
      "https://parked.example-registrar.com/",
      "https://other.vector-fixture.com/health",
      "http://status.vector-fixture.com/health",
      "https://status.vector-fixture.com:8443/health",
      "",
      "https://[bad",
    ]) {
      const headers: Record<string, string> = location ? { location } : {}
      const { result, calls } = await run(new Response(null, { status: 301, headers }))
      expect({ location, outcome: result.outcome, reason: result.reason }).toEqual({
        location,
        outcome: "fail",
        reason: "redirect",
      })
      expect(calls).toHaveLength(1)
    }
  })

  test("401, 403 and 429 are inconclusive", async () => {
    expect((await run(new Response("no", { status: 401 }))).result).toMatchObject({
      outcome: "inconclusive",
      reason: "auth",
    })
    expect((await run(new Response("no", { status: 403 }))).result).toMatchObject({
      outcome: "inconclusive",
      reason: "auth",
    })
    expect((await run(new Response("slow", { status: 429 }))).result).toMatchObject({
      outcome: "inconclusive",
      reason: "rate-limited",
    })
  })

  test("challenge pages are inconclusive: by header on any status, or by a 5xx HTML page's markers", async () => {
    const challenges: Record<string, string>[] = [
      { "cf-mitigated": "challenge" },
      { "x-vercel-mitigated": "challenge" },
      { "x-amzn-waf-action": "captcha" },
    ]
    for (const headers of challenges) {
      const { result } = await run(html(503, "<html></html>", headers))
      expect(result).toMatchObject({ outcome: "inconclusive", reason: "challenge", status: 503 })
    }
    const { result } = await run(html(503, `<html><script src="/cdn-cgi/challenge-platform/h/b"></script></html>`))
    expect(result).toMatchObject({ outcome: "inconclusive", reason: "challenge" })
    // A plain 5xx page is the outage it says it is.
    expect((await run(html(503, "<h1>Service Unavailable</h1>"))).result).toMatchObject({
      outcome: "fail",
      reason: "status",
      status: 503,
    })
    // Markers past the first 8 KiB are not looked for.
    const late = "x".repeat(OPS_LIMITS.challengeSniffBytes + 10) + "challenge-platform"
    expect((await run(html(502, late))).result).toMatchObject({ outcome: "fail", reason: "status" })
  })

  test("other 4xx and 5xx fail", async () => {
    for (const status of [400, 404, 410, 500, 502, 504, 520, 526]) {
      const { result } = await run(new Response("x", { status }))
      expect({ status, result: { outcome: result.outcome, reason: result.reason } }).toEqual({
        status,
        result: { outcome: "fail", reason: "status" },
      })
    }
  })

  test("a network or TLS failure fails, and a probe past its timeout fails as a timeout", async () => {
    expect((await run(new TypeError("Network connection lost."))).result).toMatchObject({
      outcome: "fail",
      reason: "network",
    })
    const abortable = async (_url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))
    const started = Date.now()
    const result = await probe(URL_, { fetch: abortable, now: () => Date.now(), timeoutMs: 40 })
    expect(result).toMatchObject({ outcome: "fail", reason: "timeout" })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  test("the default timeout is 8 seconds", () => {
    expect(OPS_LIMITS.probeTimeoutMs).toBe(8_000)
  })

  test("bodies are never read except a 5xx HTML page's first bytes", async () => {
    let pulled = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(new TextEncoder().encode("a".repeat(1024)))
      },
    })
    const { result } = await run(new Response(body, { status: 200 }))
    expect(result.outcome).toBe("ok")
    expect(pulled).toBeLessThanOrEqual(1)
  })
})

describe("helpers", () => {
  test("sameOrigin compares scheme, host and port", () => {
    expect(sameOrigin(URL_, "/x")).toBe(true)
    expect(sameOrigin(URL_, "//status.vector-fixture.com/x")).toBe(true)
    expect(sameOrigin(URL_, "//evil.vector-fixture.com/x")).toBe(false)
    expect(sameOrigin(URL_, null)).toBe(false)
  })

  test("a host that did not resolve to a public address is never fetched", () => {
    expect(resolutionResult({ kind: "missing" })).toEqual({ outcome: "fail", reason: "dns", ms: 0 })
    expect(resolutionResult({ kind: "blocked" })).toEqual({ outcome: "inconclusive", reason: "address", ms: 0 })
    expect(resolutionResult({ kind: "error" })).toEqual({ outcome: "inconclusive", reason: "resolver", ms: 0 })
  })

  test("pool keeps at most `limit` running and the answers in order", async () => {
    let running = 0
    let peak = 0
    const results = await pool([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 6, async (item) => {
      running++
      peak = Math.max(peak, running)
      await Bun.sleep(5)
      running--
      return item * 2
    })
    expect(peak).toBe(6)
    expect(results).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20])
  })
})
