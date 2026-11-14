import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash, createHmac } from "node:crypto"
import { Readable } from "node:stream"
import type { ApiRequest } from "../api/_lib/http"
import {
  INTERNAL_HEADERS,
  INTERNAL_NONCE_KEEP_MS,
  INTERNAL_TIMEOUT_MS,
  internalCanonical,
  internalFetch,
  requireInternalRequest,
  signInternal,
  verifyInternal,
  type InternalNonceCheck,
} from "../api/_lib/hosted-internal"

// WP A37: the HMAC on calls between Vector's server and its services (relay, ops, hosted). The signature covers the
// service, method, path, timestamp, nonce and a hash of the body; a receiver allows 300 s of clock skew and each
// nonce once; outbound calls never follow a redirect and stop after 10 s. The store is a fake.

const KV = "https://kv.internal.invalid"
const HOSTED_SECRET = "hosted-internal-fixture-secret-".padEnd(48, "h")
const OPS_SECRET = "ops-internal-fixture-secret-".padEnd(48, "o")
const NOW = Date.UTC(2026, 10, 3, 12, 0, 0)
const NAMES = [
  "VECTOR_HOSTED_INTERNAL_SECRET",
  "VECTOR_OPS_SHARED_SECRET",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "CODIUM_STRIPE_MODE",
  "STRIPE_SECRET_KEY",
  "VERCEL_ENV",
  "NODE_ENV",
] as const
const saved = new Map(NAMES.map((name) => [name, process.env[name]]))
beforeEach(() => {
  process.env.VECTOR_HOSTED_INTERNAL_SECRET = HOSTED_SECRET
  process.env.VECTOR_OPS_SHARED_SECRET = OPS_SECRET
  process.env.KV_REST_API_URL = KV
  process.env.KV_REST_API_TOKEN = "fixture-kv-token"
  delete process.env.UPSTASH_REDIS_REST_URL
  delete process.env.UPSTASH_REDIS_REST_TOKEN
  process.env.CODIUM_STRIPE_MODE = "test"
  delete process.env.STRIPE_SECRET_KEY
  process.env.VERCEL_ENV = "preview"
  process.env.NODE_ENV = "test"
})
afterEach(() =>
  saved.forEach((value, name) => {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }),
)

/** A store that knows SET … NX PX, as the nonce check sends it. */
function nonceStore() {
  const keys = new Map<string, number>()
  const commands: string[][] = []
  let down = false
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(String(input)).origin !== KV) throw new Error(`Unexpected request to ${String(input)}`)
    if (down) return new Response("down", { status: 503 })
    const command = (JSON.parse(String(init?.body)) as unknown[]).map(String)
    commands.push(command)
    const [name, key, , nx, px, ttl] = command
    if (name !== "SET" || nx !== "NX" || px !== "PX") throw new Error(`Unexpected command ${command.join(" ")}`)
    const expires = keys.get(key!)
    if (expires !== undefined && expires > Date.now()) return Response.json({ result: null })
    keys.set(key!, Date.now() + Number(ttl))
    return Response.json({ result: "OK" })
  }) as typeof fetch
  return {
    fetcher,
    commands,
    goDown() {
      down = true
    },
  }
}

const memoryNonces = (): InternalNonceCheck => {
  const seen = new Set<string>()
  return async (service, nonce) => {
    const key = `${service}:${nonce}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }
}

function signed(overrides: { method?: string; path?: string; body?: string; now?: number; nonce?: string } = {}) {
  const request = { method: "POST", path: "/api/ops/worker?event=incident", body: '{"a":1}', ...overrides }
  return { ...request, headers: signInternal("ops", { ...request, now: overrides.now ?? NOW }) }
}

async function code(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  )
  return (error as { code?: string } | undefined)?.code ?? "accepted"
}

describe("signing", () => {
  test("follows the documented canonical string and per-service key, so the Workers can match it byte for byte", () => {
    const headers = signInternal("relay", {
      method: "post",
      path: "/kill?account=a",
      body: "{}",
      now: NOW + 999,
      nonce: "n".repeat(22),
    })
    expect(headers[INTERNAL_HEADERS.timestamp]).toBe(String(NOW / 1000))
    expect(headers[INTERNAL_HEADERS.nonce]).toBe("n".repeat(22))
    const canonical = [
      "vector-internal-v1",
      "relay",
      "POST",
      "/kill?account=a",
      String(NOW / 1000),
      "n".repeat(22),
      createHash("sha256").update("{}").digest("hex"),
    ].join("\n")
    expect(
      internalCanonical("relay", {
        method: "post",
        path: "/kill?account=a",
        timestamp: NOW / 1000,
        nonce: "n".repeat(22),
        body: "{}",
      }),
    ).toBe(canonical)
    const key = createHmac("sha256", HOSTED_SECRET).update("vector-internal-v1/relay").digest()
    expect(headers[INTERNAL_HEADERS.signature]).toBe(createHmac("sha256", key).update(canonical).digest("base64url"))
    // A body-less request hashes zero bytes.
    expect(
      internalCanonical("ops", { method: "GET", path: "/", timestamp: 1, nonce: "n".repeat(22) }).split("\n")[6],
    ).toBe(createHash("sha256").update("").digest("hex"))
  })

  test("refuses to sign without a secret of at least 32 characters, or with a bad path or nonce", () => {
    delete process.env.VECTOR_OPS_SHARED_SECRET
    expect(() => signInternal("ops", { method: "GET", path: "/" })).toThrow(
      expect.objectContaining({ statusCode: 503, code: "INTERNAL_UNAVAILABLE" }),
    )
    process.env.VECTOR_OPS_SHARED_SECRET = "short"
    expect(() => signInternal("ops", { method: "GET", path: "/" })).toThrow(
      expect.objectContaining({ statusCode: 503 }),
    )
    expect(() => signInternal("hosted", { method: "GET", path: "relative" })).toThrow("starts with /")
    expect(() => signInternal("hosted", { method: "GET", path: "/", nonce: "short" })).toThrow("nonce")
    // Each request gets a fresh nonce.
    const a = signInternal("hosted", { method: "GET", path: "/" })
    const b = signInternal("hosted", { method: "GET", path: "/" })
    expect(a[INTERNAL_HEADERS.nonce]).not.toBe(b[INTERNAL_HEADERS.nonce])
  })
})

describe("verifying", () => {
  test("accepts a correctly signed request once, then refuses the replay", async () => {
    const nonces = memoryNonces()
    const request = signed()
    expect(await code(verifyInternal("ops", request, { now: NOW, nonces }))).toBe("accepted")
    expect(await code(verifyInternal("ops", request, { now: NOW + 1_000, nonces }))).toBe("INTERNAL_SIGNATURE_INVALID")
  })

  test("refuses any change to the method, path, query, body, timestamp or nonce", async () => {
    const request = signed()
    const variants = [
      { ...request, method: "PUT" },
      { ...request, path: "/api/ops/worker?event=other" },
      { ...request, path: "/api/ops/worker" },
      { ...request, body: '{"a":2}' },
      { ...request, body: "" },
      { ...request, headers: { ...request.headers, [INTERNAL_HEADERS.timestamp]: String(NOW / 1000 + 1) } },
      { ...request, headers: { ...request.headers, [INTERNAL_HEADERS.nonce]: "z".repeat(22) } },
      { ...request, headers: { ...request.headers, [INTERNAL_HEADERS.signature]: "A".repeat(43) } },
      { ...request, headers: { ...request.headers, [INTERNAL_HEADERS.signature]: undefined } },
      { ...request, headers: {} },
    ]
    for (const variant of variants)
      expect(await code(verifyInternal("ops", variant, { now: NOW, nonces: memoryNonces() }))).toBe(
        "INTERNAL_SIGNATURE_INVALID",
      )
  })

  test("allows 300 seconds of clock skew either way and no more", async () => {
    for (const offset of [-300_000, 300_000, 0])
      expect(
        await code(verifyInternal("ops", signed({ now: NOW + offset }), { now: NOW, nonces: memoryNonces() })),
      ).toBe("accepted")
    for (const offset of [-301_000, 301_000, -86_400_000])
      expect(
        await code(verifyInternal("ops", signed({ now: NOW + offset }), { now: NOW, nonces: memoryNonces() })),
      ).toBe("INTERNAL_SIGNATURE_INVALID")
  })

  test("a request signed for one service never passes at another, even where they share a secret", async () => {
    const request = signed()
    expect(await code(verifyInternal("hosted", request, { now: NOW, nonces: memoryNonces() }))).toBe(
      "INTERNAL_SIGNATURE_INVALID",
    )
    const relay = { method: "POST", path: "/kill", body: "{}" }
    const relayHeaders = signInternal("relay", { ...relay, now: NOW })
    expect(
      await code(verifyInternal("hosted", { ...relay, headers: relayHeaders }, { now: NOW, nonces: memoryNonces() })),
    ).toBe("INTERNAL_SIGNATURE_INVALID")
    expect(
      await code(verifyInternal("relay", { ...relay, headers: relayHeaders }, { now: NOW, nonces: memoryNonces() })),
    ).toBe("accepted")
  })

  test("checks the nonce last, so a forged request cannot use up a real nonce", async () => {
    let asked = 0
    const nonces: InternalNonceCheck = async () => {
      asked++
      return true
    }
    const request = signed()
    await verifyInternal("ops", { ...request, body: "forged" }, { now: NOW, nonces }).catch(() => {})
    expect(asked).toBe(0)
    await verifyInternal("ops", request, { now: NOW, nonces })
    expect(asked).toBe(1)
  })

  test("remembers nonces in the store for twice the skew, under the Codium prefix, and fails closed when it is down", async () => {
    const store = nonceStore()
    const request = signed()
    expect(await code(verifyInternal("ops", request, { now: NOW, fetcher: store.fetcher }))).toBe("accepted")
    expect(store.commands[0]).toEqual([
      "SET",
      `vector:codium:test:internal:nonce:ops:${request.headers[INTERNAL_HEADERS.nonce]}`,
      "1",
      "NX",
      "PX",
      String(INTERNAL_NONCE_KEEP_MS),
    ])
    expect(INTERNAL_NONCE_KEEP_MS).toBe(600_000)
    expect(await code(verifyInternal("ops", request, { now: NOW, fetcher: store.fetcher }))).toBe(
      "INTERNAL_SIGNATURE_INVALID",
    )
    store.goDown()
    expect(await code(verifyInternal("ops", signed(), { now: NOW, fetcher: store.fetcher }))).toBe(
      "PERSISTENT_STORE_UNAVAILABLE",
    )
  })

  test("answers 503 when the receiver has no secret", async () => {
    const request = signed()
    delete process.env.VECTOR_OPS_SHARED_SECRET
    expect(await code(verifyInternal("ops", request, { now: NOW, nonces: memoryNonces() }))).toBe(
      "INTERNAL_UNAVAILABLE",
    )
  })

  test("an API route reads the raw body from the stream and checks it", async () => {
    const store = nonceStore()
    const body = '{"incident":"i_1","state":"down"}'
    const headers = signInternal("ops", { method: "POST", path: "/api/ops/worker", body, now: NOW })
    const request = Object.assign(Readable.from([Buffer.from(body)]), {
      method: "POST",
      url: "/api/ops/worker",
      headers,
    }) as unknown as ApiRequest
    const read = await requireInternalRequest("ops", request, { now: NOW, fetcher: store.fetcher })
    expect(read.toString("utf8")).toBe(body)
    const tampered = Object.assign(Readable.from([Buffer.from(body.replace("down", "up"))]), {
      method: "POST",
      url: "/api/ops/worker",
      headers: signInternal("ops", { method: "POST", path: "/api/ops/worker", body, now: NOW }),
    }) as unknown as ApiRequest
    expect(await code(requireInternalRequest("ops", tampered, { now: NOW, fetcher: store.fetcher }))).toBe(
      "INTERNAL_SIGNATURE_INVALID",
    )
  })
})

describe("internalFetch", () => {
  test("signs the path and body it sends, never follows a redirect and stops after 10 seconds", async () => {
    const seen: { url: string; init: RequestInit }[] = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), init: init ?? {} })
      return Response.json({ ok: true })
    }) as typeof fetch
    const answer = await internalFetch(
      "relay",
      "https://relay.example.com/internal/kill?account=a",
      { body: '{"reason":"revoked"}' },
      fetcher,
      NOW,
    )
    expect(answer.status).toBe(200)
    expect(seen).toHaveLength(1)
    const { url, init } = seen[0]!
    expect(url).toBe("https://relay.example.com/internal/kill?account=a")
    expect(init.method).toBe("POST")
    expect(init.redirect).toBe("error")
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(INTERNAL_TIMEOUT_MS).toBe(10_000)
    const headers = init.headers as Record<string, string>
    expect(headers["content-type"]).toBe("application/json")
    // What was sent verifies at the receiver.
    expect(
      await code(
        verifyInternal(
          "relay",
          { method: "POST", path: "/internal/kill?account=a", headers, body: String(init.body) },
          { now: NOW, nonces: memoryNonces() },
        ),
      ),
    ).toBe("accepted")
  })

  test("goes to https only (plain http only to this machine outside production) and refuses credentials", async () => {
    const fetcher = (async () => Response.json({})) as typeof fetch
    await expect(internalFetch("ops", "http://ops.example.com/x", {}, fetcher, NOW)).rejects.toThrow("https")
    await expect(internalFetch("ops", "https://user:pw@ops.example.com/x", {}, fetcher, NOW)).rejects.toThrow(
      "credentials",
    )
    expect((await internalFetch("ops", "http://127.0.0.1:8787/x", { method: "GET" }, fetcher, NOW)).status).toBe(200)
    process.env.VERCEL_ENV = "production"
    await expect(internalFetch("ops", "http://127.0.0.1:8787/x", {}, fetcher, NOW)).rejects.toThrow("https")
    delete process.env.VECTOR_OPS_SHARED_SECRET
    process.env.VERCEL_ENV = "preview"
    await expect(internalFetch("ops", "https://ops.example.com/x", {}, fetcher, NOW)).rejects.toThrow(
      expect.objectContaining({ code: "INTERNAL_UNAVAILABLE" }),
    )
  })
})
