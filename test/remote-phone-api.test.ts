import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { listedPerks, perkServices } from "../api/_lib/codium-perks"
import { switchKey } from "../api/_lib/codium-switches"
import { createStatusMeterRegistry, registerStatusMeter } from "../api/_lib/model-plan-status"
import { readRemoteMeter } from "../api/_lib/remote-meter"
import { remoteConfigured } from "../api/_lib/remote-ticket"
import { ENTITLEMENTS, type EntitlementSnapshot } from "../packages/schema/src/codium-entitlements"
import { RELAY_HOST, relayAllowed } from "../packages/app/src/phone/remote/model"

// WP A42, the server's part of Remote's phone UI and Settings → Remote: Remote becomes listable once both halves can
// connect (tickets can be minted and phones have their app's origin), the status carries the paired count
// (`meters.remote {computers, limit}`, §4.11) for "N of limit", and the phone origin's CSP names exactly the relay
// host the phone app accepts. Listing Remote stays the owner's step after the outside security review (§1.2).

const ROOT = path.resolve(import.meta.dir, "..")
const RELAY = "relay.remote-phone.invalid"
const keys = generateKeyPairSync("ed25519")
const SIGNING_KEY = keys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url")

const NAMES = [
  "VECTOR_REMOTE_ENABLED",
  "VECTOR_REMOTE_TICKET_SIGNING_KEY",
  "VECTOR_REMOTE_RELAY_URL",
  "VECTOR_HOSTED_INTERNAL_SECRET",
  "VECTOR_PHONE_APP_ORIGIN",
  "MODEL_PLANS_ENABLED",
  "CODIUM_LISTED_PERKS",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "CODIUM_STRIPE_MODE",
  "STRIPE_SECRET_KEY",
  "VERCEL_ENV",
  "NODE_ENV",
]
const saved = new Map(NAMES.map((name) => [name, process.env[name]]))
beforeEach(() => {
  for (const name of NAMES) delete process.env[name]
})
afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

const configure = () =>
  Object.assign(process.env, {
    VECTOR_REMOTE_ENABLED: "true",
    VECTOR_REMOTE_TICKET_SIGNING_KEY: SIGNING_KEY,
    VECTOR_REMOTE_RELAY_URL: `wss://${RELAY}`,
    VECTOR_HOSTED_INTERNAL_SECRET: "remote-phone-fixture-internal-secret-".padEnd(48, "i"),
    VECTOR_PHONE_APP_ORIGIN: "https://remote.vectordev.ai",
  })

describe("Remote becomes listable (A40 to A42)", () => {
  test("ready only when tickets can be minted and phones have their app's origin", async () => {
    const ready = () => perkServices.remote?.(fetch)
    expect(await ready()).toBe(false)
    configure()
    expect(remoteConfigured()).toBe(true)
    expect(await ready()).toBe(true)
    for (const name of [
      "VECTOR_REMOTE_ENABLED",
      "VECTOR_REMOTE_TICKET_SIGNING_KEY",
      "VECTOR_REMOTE_RELAY_URL",
      "VECTOR_HOSTED_INTERNAL_SECRET",
      "VECTOR_PHONE_APP_ORIGIN",
    ]) {
      configure()
      delete process.env[name]
      expect({ name, ready: await ready() }).toEqual({ name, ready: false })
    }
  })

  test("listed once the owner lists it, and gone while the remote switch is off", async () => {
    configure()
    Object.assign(process.env, {
      MODEL_PLANS_ENABLED: "true",
      CODIUM_LISTED_PERKS: "remote",
      KV_REST_API_URL: "https://store.example.test",
      KV_REST_API_TOKEN: "fixture-kv-token",
      CODIUM_STRIPE_MODE: "test",
      VERCEL_ENV: "preview",
    })
    const switches = new Map<string, string>()
    const store = () => async (_url: string | URL | Request, init?: RequestInit) => {
      const [command, key] = JSON.parse(String(init?.body)) as string[]
      const result = command === "SMEMBERS" ? [] : command === "GET" ? (switches.get(key) ?? null) : null
      return new Response(JSON.stringify({ result }), { headers: { "content-type": "application/json" } })
    }
    expect(await listedPerks(store() as typeof fetch)).toEqual(new Set(["remote"]))
    switches.set(switchKey("remote"), "off")
    expect(await listedPerks(store() as typeof fetch)).toEqual(new Set())
    switches.delete(switchKey("remote"))
    // Not listed by the owner: never shown, however ready.
    process.env.CODIUM_LISTED_PERKS = "alerts"
    expect((await listedPerks(store() as typeof fetch)).has("remote")).toBe(false)
  })
})

const snapshot = (plan: keyof typeof ENTITLEMENTS) =>
  ({ account: "a42a42a4-0000-4000-8000-000000000001", caps: ENTITLEMENTS[plan] }) as unknown as EntitlementSnapshot

/** The relay's internal `devices` action as A39's Worker answers it; nothing else is reachable. */
function relayFetch(devices: unknown[], seen: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    seen.push(`${url.host}${url.pathname}`)
    if (url.host !== RELAY || url.pathname !== "/internal/v1/devices") return new Response("{}", { status: 404 })
    // A signed internal call (A37's HMAC), never a bare request.
    expect(new Headers(init?.headers).get("x-vector-internal-signature")).toBeTruthy()
    return Response.json({ devices, limits: { computers: 3, phones: 5 }, fairUse: "ok" })
  }) as typeof fetch
}

const device = (seed: number, role: "computer" | "phone", online = false) => ({
  device: Buffer.alloc(16, seed).toString("base64url"),
  role,
  name: role === "computer" ? "Mac" : "iPhone",
  pairedAt: 1_000 + seed,
  lastSeen: 2_000 + seed,
  online,
  overLimit: false,
})

describe("the paired count in the status (meters.remote)", () => {
  test("counts the computers the relay holds against the plan's limit; phones are not counted", async () => {
    configure()
    const seen: string[] = []
    const meter = await readRemoteMeter(
      snapshot("vector-50"),
      relayFetch([device(1, "computer", true), device(2, "computer"), device(3, "phone", true)], seen),
    )
    expect(meter).toEqual({ computers: 2, limit: 3 })
    expect(seen).toEqual([`${RELAY}/internal/v1/devices`])
    expect(await readRemoteMeter(snapshot("vector-10"), relayFetch([]))).toEqual({ computers: 0, limit: 1 })
  })

  test("no relay configured, or a relay that fails, leaves the meter out rather than guessing", async () => {
    expect(await readRemoteMeter(snapshot("vector-100"), relayFetch([device(1, "computer")]))).toBeUndefined()
    configure()
    const failing = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch
    await expect(readRemoteMeter(snapshot("vector-100"), failing)).rejects.toThrow()
    // Through the status's registry, a failing reader drops only that meter.
    const registry = createStatusMeterRegistry()
    registry.register("remote", "remote", (value, fetcher, signal) => readRemoteMeter(value, fetcher, signal))
    expect(await registry.read(snapshot("vector-100"), ["remote"], failing)).toBeUndefined()
    expect(await registry.read(snapshot("vector-100"), ["remote"], relayFetch([device(4, "computer")]))).toEqual({
      remote: { computers: 1, limit: 5 },
    })
    // Hidden while Remote is not listed (H1).
    expect(await registry.read(snapshot("vector-100"), [], relayFetch([device(4, "computer")]))).toBeUndefined()
  })

  test("the status route registers it once; nothing else reads the plan to show it", async () => {
    await import("../api/model-plans/status")
    expect(() => registerStatusMeter("remote", "remote", async () => undefined)).toThrow(/exactly one reader/)
    const route = await readFile(path.join(ROOT, "api/model-plans/status.ts"), "utf8")
    expect(route).toContain('import "../_lib/remote-meter.js"')
    // The provisioners module must not register it: model-plan-status imports it through model-plan-account.
    const provisioners = await readFile(path.join(ROOT, "api/_lib/codium-provisioners.ts"), "utf8")
    expect(provisioners).not.toContain("remote-meter")
  })

  test("the meter carries counts only (P1)", async () => {
    configure()
    const meter = await readRemoteMeter(snapshot("vector-200"), relayFetch([device(1, "computer")]))
    expect(JSON.stringify(meter)).not.toMatch(/\$|usd|credit|cents|Mac|iPhone/i)
  })
})

describe("the phone origin's CSP and the relay host the phone app accepts", () => {
  test("the CSP's only socket host is the relay the phone app connects to", async () => {
    const vercel = JSON.parse(await readFile(path.join(ROOT, "vercel.json"), "utf8")) as {
      headers: { source: string; has?: { type: string; value: string }[]; headers: { key: string; value: string }[] }[]
    }
    const csp = vercel.headers
      .flatMap((rule) => rule.headers)
      .filter((header) => header.key === "Content-Security-Policy")
      .map((header) => header.value)
    expect(csp).toHaveLength(1)
    const connect = csp[0]!
      .split(";")
      .map((part) => part.trim().split(/\s+/))
      .find(([name]) => name === "connect-src")!
      .slice(1)
    expect(connect.filter((value) => value.startsWith("wss:"))).toEqual([`wss://${RELAY_HOST}`])
    expect(connect.some((value) => value.startsWith("ws:"))).toBe(false)
  })

  test("the phone app opens only that relay, over wss, and a local one only from a local page", () => {
    const origin = "https://remote.vectordev.ai"
    expect(relayAllowed(new URL(`wss://${RELAY_HOST}/v1/connect`), origin)).toBe(true)
    for (const url of [
      `ws://${RELAY_HOST}/v1/connect`,
      `wss://${RELAY_HOST}:8443/v1/connect`,
      "wss://vector-remote-relay.someone.workers.dev/v1/connect",
      "wss://localhost:8787/v1/connect",
      `wss://evil.${RELAY_HOST}/v1/connect`,
    ])
      expect({ url, allowed: relayAllowed(new URL(url), origin) }).toEqual({ url, allowed: false })
    expect(relayAllowed(new URL("ws://localhost:8787/v1/connect"), "http://localhost:3000")).toBe(true)
  })
})
