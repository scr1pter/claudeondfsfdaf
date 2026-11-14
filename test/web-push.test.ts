import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createDecipheriv, createECDH, createHmac, randomBytes, type ECDH } from "node:crypto"
import { decodeProtectedHeader, importJWK, jwtVerify } from "jose"
import { ABUSE_RATE_LIMIT_SCRIPT } from "../api/_lib/abuse"
import { mintCliToken } from "../api/_lib/cli-token"
import { push as pushProvisioner } from "../api/_lib/codium-provisioners"
import { buildSnapshot, snapshotKey, type SnapshotFacts } from "../api/_lib/codium-snapshot"
import { switchKey } from "../api/_lib/codium-switches"
import type { SafeTransport, SafeTransportRequest } from "../api/_lib/safe-fetch"
import {
  encryptPushMessage,
  eraseAccountPushSubscriptions,
  parseEncryptedAlert,
  PUSH_LIMITS,
  PUSH_PLAINTEXT_MAX,
  pushConfigured,
  pushSubscriptionId,
  pushSubscriptionsKey,
  sendServerAlert,
  titleAlert,
  vapidAuthorization,
  vapidConfiguration,
} from "../api/_lib/web-push"
import { handleNotifySend } from "../api/notify/send"
import { handleNotifySubscribe } from "../api/notify/subscribe"
import type { PlanId } from "../packages/schema/src/codium-plan"
import { invoke, jsonHeaders } from "./support-reports-fixture"

// WP A37: phone alerts over Web Push, and invariant P7 ("push payloads carry titles only; desktop alerts are end-to-end
// encrypted"). Messages are encrypted as RFC 8291 says (checked against its Appendix A example) and signed with VAPID
// (RFC 8292). The desktop's /api/notify/send takes only ciphertext; the server's own alerts carry a title and nothing
// else. Each phone below is a real P-256 key pair, and every delivered message is decrypted here, with this file's own
// RFC 8291 code, to see exactly what a push service and the phone receive. The store, Supabase and the push services
// are fakes; nothing reaches a network.

const KV = "https://kv.web-push.invalid"
const SUPABASE = "https://supabase.web-push.invalid"
const PUBLIC_ADDRESS = "93.184.215.14"
const DAY = 86_400_000
const NOW = Date.now()

// RFC 8291 Appendix A. The application server's key pair doubles as this file's VAPID key: a published test key.
const RFC = {
  plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  ecdhSecret: "kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs",
  prkKey: "Snr3JMxaHVDXHWJn5wdC52WjpCtd2EIEGBykDcZW32k",
  ikm: "S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg",
  prk: "09_eUZGrsvxChDCGRCdkLiDXrReGOEVeSCdCcPBSJSc",
  cekInfo: "Q29udGVudC1FbmNvZGluZzogYWVzMTI4Z2NtAA",
  cek: "oIhVW04MRdy2XN9CiKLxTg",
  nonceInfo: "Q29udGVudC1FbmNvZGluZzogbm9uY2UA",
  nonce: "4h_95klXJ5E_qnoN",
  header:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  ciphertext: "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ",
}
const b64 = (value: string) => Buffer.from(value, "base64url")

const ENVIRONMENT: Record<string, string | undefined> = {
  KV_REST_API_URL: KV,
  KV_REST_API_TOKEN: "fixture-kv-token",
  UPSTASH_REDIS_REST_URL: undefined,
  UPSTASH_REDIS_REST_TOKEN: undefined,
  CODIUM_STRIPE_MODE: "test",
  STRIPE_SECRET_KEY: undefined,
  NODE_ENV: "test",
  VERCEL_ENV: "preview",
  VECTOR_CLI_TOKEN_SECRET: "web-push-fixture-cli-secret-".padEnd(48, "x"),
  VECTOR_ABUSE_SECRET: "web-push-fixture-abuse-secret-".padEnd(48, "x"),
  SUPABASE_URL: SUPABASE,
  SUPABASE_PUBLISHABLE_KEY: "fixture-publishable-key",
  SUPABASE_ANON_KEY: undefined,
  VECTOR_VAPID_PUBLIC_KEY: RFC.asPublic,
  VECTOR_VAPID_PRIVATE_KEY: RFC.asPrivate,
  VECTOR_VAPID_SUBJECT: "https://vectordev.ai/support",
  VECTOR_PHONE_APP_ORIGIN: "https://remote.vectordev.ai",
  VECTOR_ALLOWED_ORIGINS: undefined,
  VECTOR_PUBLIC_URL: undefined,
}
const original = new Map(Object.keys(ENVIRONMENT).map((name) => [name, process.env[name]]))
function setEnvironment(values: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

// ── Fakes ───────────────────────────────────────────────────────────────────────────────────────────────────────────

type Entry = { kind: "string"; value: string } | { kind: "hash"; value: Map<string, string> }

/** The Upstash REST commands these routes send. An unexpected command throws, which the client reads as an outage. */
class Store {
  readonly data = new Map<string, Entry>()
  readonly expires = new Map<string, number>()
  readonly commands: string[][] = []
  down = false

  hash(key: string) {
    const entry = this.data.get(key)
    return entry?.kind === "hash" ? entry.value : new Map<string, string>()
  }

  command(input: readonly unknown[]): unknown {
    const command = input.map(String)
    this.commands.push(command)
    if (this.down) throw new Error("store down")
    const [name, key, ...args] = command
    switch (name) {
      case "GET": {
        const entry = this.data.get(key!)
        return entry?.kind === "string" ? entry.value : null
      }
      case "SET":
        this.data.set(key!, { kind: "string", value: args[0]! })
        return "OK"
      case "DEL":
        return [key!, ...args].filter((name) => this.data.delete(name)).length
      case "HSET": {
        const entry = this.data.get(key!)
        const hash = entry?.kind === "hash" ? entry.value : new Map<string, string>()
        if (!entry) this.data.set(key!, { kind: "hash", value: hash })
        let added = 0
        for (let index = 0; index < args.length; index += 2) {
          if (!hash.has(args[index]!)) added++
          hash.set(args[index]!, args[index + 1]!)
        }
        return added
      }
      case "HGETALL":
        return [...this.hash(key!).entries()].flat()
      case "HDEL": {
        const hash = this.hash(key!)
        const removed = args.filter((field) => hash.delete(field)).length
        if (!hash.size) this.data.delete(key!)
        return removed
      }
      case "PEXPIRE":
        if (!this.data.has(key!)) return 0
        this.expires.set(key!, Number(args[0]))
        return 1
      case "EVAL": {
        if (key !== ABUSE_RATE_LIMIT_SCRIPT) throw new Error("Unexpected script")
        const counter = args[1]!
        const count = Number((this.data.get(counter) as { value: string } | undefined)?.value ?? 0) + 1
        this.data.set(counter, { kind: "string", value: String(count) })
        return [count, 3600]
      }
    }
    throw new Error(`Unexpected store command ${name}`)
  }
}

let store = new Store()
const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.origin === KV) {
    try {
      return Response.json({ result: store.command(JSON.parse(String(init?.body)) as unknown[]) })
    } catch {
      return new Response("unavailable", { status: 503 })
    }
  }
  if (url.origin === SUPABASE && url.pathname === "/auth/v1/user") {
    const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? ""
    const account = sessions.get(token)
    if (!account) return new Response("{}", { status: 401 })
    return Response.json({
      id: account,
      email: `${account.slice(-4)}@example.invalid`,
      email_confirmed_at: "2026-01-01T00:00:00Z",
    })
  }
  throw new Error(`Unexpected request to ${url.origin}`)
}) as typeof fetch
const sessions = new Map<string, string>()
/** A new identity per request, so the 30-second switch cache (keyed by fetcher) never carries over between calls. */
const fresh = (): typeof fetch =>
  ((input: RequestInfo | URL, init?: RequestInit) => fetcher(input, init)) as typeof fetch
const SWITCHED_OFF = JSON.stringify({ value: "off", changedAt: NOW, generation: "g1", offSince: NOW })

/** A push service: records each delivery and answers by endpoint. */
let deliveries: SafeTransportRequest[] = []
let answers = new Map<string, number>()
const transport: SafeTransport = async (request) => {
  deliveries.push(request)
  return { status: answers.get(request.url.href) ?? 201, headers: {}, body: new Uint8Array() }
}
let resolved: readonly string[] = [PUBLIC_ADDRESS]
const network = { resolve: async () => resolved, transport }

beforeEach(() => {
  setEnvironment(ENVIRONMENT)
  store = new Store()
  sessions.clear()
  deliveries = []
  answers = new Map()
  resolved = [PUBLIC_ADDRESS]
})
afterEach(() => setEnvironment(Object.fromEntries(original)))

// ── Accounts and phones ─────────────────────────────────────────────────────────────────────────────────────────────

const PLUS = "5e5e5e5e-0000-4000-8000-000000000001"
const OTHER = "5e5e5e5e-0000-4000-8000-000000000002"

function seedPlan(account: string, plan: PlanId | null, state: SnapshotFacts["state"] = "active") {
  const reason = { paused: "payment_failed", frozen: "disputed", ended: "canceled" }[state as string] as
    | SnapshotFacts["reason"]
    | undefined
  const snapshot = buildSnapshot(
    {
      account,
      state,
      ...(reason ? { reason } : {}),
      plan,
      ...(plan ? { subscription: `sub_${account.slice(-4)}` } : {}),
      periodStart: state === "renewing" ? NOW - 30 * DAY : NOW - DAY,
      periodEnd: state === "renewing" ? NOW - 60_000 : NOW + 29 * DAY,
      cancelAtPeriodEnd: false,
      source: "webhook",
    },
    undefined,
    NOW,
  )
  store.command(["SET", snapshotKey(account), JSON.stringify(snapshot)])
}

type Phone = { ecdh: ECDH; auth: Buffer; endpoint: string; json: Record<string, unknown> }
function phone(endpoint = `https://fcm.googleapis.com/fcm/send/${randomBytes(9).toString("base64url")}`): Phone {
  const ecdh = createECDH("prime256v1")
  ecdh.generateKeys()
  const auth = randomBytes(16)
  return {
    ecdh,
    auth,
    endpoint,
    json: {
      endpoint,
      expirationTime: null,
      keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") },
    },
  }
}

const desktopToken = (account: string, client: "desktop" | "cli" | "unmarked" = "desktop") =>
  mintCliToken(
    { id: account, email: `${account.slice(-4)}@example.invalid` },
    Date.now(),
    client === "unmarked" ? undefined : client,
  ).token

function session(account: string) {
  const token = `session-${account}`
  sessions.set(token, account)
  return token
}

function subscribe(
  account: string | undefined,
  body: Record<string, unknown>,
  options: { method?: string; origin?: string } = {},
) {
  return invoke((request, response) => handleNotifySubscribe(request, response, fresh(), () => NOW), {
    method: options.method ?? "POST",
    headers: jsonHeaders("192.0.2.10", {
      ...(account ? { authorization: `Bearer ${session(account)}` } : {}),
      ...(options.origin ? { origin: options.origin } : {}),
    }),
    body,
  })
}

function send(authorization: string | undefined, body: Record<string, unknown>) {
  return invoke((request, response) => handleNotifySend(request, response, fresh(), () => NOW, network), {
    method: "POST",
    headers: jsonHeaders("192.0.2.20", authorization ? { authorization } : {}),
    body,
  })
}

/** A ciphertext the desktop would send: random bytes standing in for its end-to-end encryption, as base64url. */
const ciphertext = (bytes = 96) => randomBytes(bytes).toString("base64url")

// ── This file's own RFC 8291 decryption ────────────────────────────────────────────────────────────────────────────

const hmac = (key: Uint8Array, data: Uint8Array) => createHmac("sha256", key).update(data).digest()
function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number) {
  return hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, length)
}

/** What the phone does with a push message: derive the keys from its own private key and open the one record. */
function decrypt(message: Uint8Array, receiver: ECDH, auth: Uint8Array) {
  const data = Buffer.from(message)
  const salt = data.subarray(0, 16)
  const recordSize = data.readUInt32BE(16)
  const idLength = data[20]!
  const sender = data.subarray(21, 21 + idLength)
  const sealed = data.subarray(21 + idLength)
  const shared = receiver.computeSecret(sender)
  const prkKey = hmac(auth, shared)
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), receiver.getPublicKey(), sender])
  const ikm = hkdfExpand(prkKey, keyInfo, 32)
  const prk = hmac(salt, ikm)
  const cek = hkdfExpand(prk, Buffer.from("Content-Encoding: aes128gcm\0"), 16)
  const nonce = hkdfExpand(prk, Buffer.from("Content-Encoding: nonce\0"), 12)
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce)
  decipher.setAuthTag(sealed.subarray(sealed.length - 16))
  const padded = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()])
  let end = padded.length - 1
  while (end >= 0 && padded[end] === 0) end--
  if (padded[end] !== 2) throw new Error("Not the last record")
  return { recordSize, idLength, sender, plaintext: padded.subarray(0, end), prkKey, ikm, prk, cek, nonce, shared }
}

function opened(delivery: SafeTransportRequest, receiver: Phone) {
  return JSON.parse(decrypt(delivery.body!, receiver.ecdh, receiver.auth).plaintext.toString("utf8")) as Record<
    string,
    unknown
  >
}

// ── Tests ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("RFC 8291 message encryption", () => {
  test("reproduces Appendix A byte for byte", () => {
    const message = encryptPushMessage({ p256dh: RFC.uaPublic, auth: RFC.auth }, b64(RFC.plaintext), {
      salt: b64(RFC.salt),
      privateKey: b64(RFC.asPrivate),
    })
    expect(Buffer.from(message.subarray(0, 86)).toString("base64url")).toBe(RFC.header)
    expect(Buffer.from(message.subarray(86)).toString("base64url")).toBe(RFC.ciphertext)
    expect(message.length).toBe(86 + 41 + 1 + 16)
  })

  test("this file's decryption matches every intermediate value of Appendix A", () => {
    const receiver = createECDH("prime256v1")
    receiver.setPrivateKey(b64(RFC.uaPrivate))
    expect(receiver.getPublicKey().toString("base64url")).toBe(RFC.uaPublic)
    const result = decrypt(Buffer.concat([b64(RFC.header), b64(RFC.ciphertext)]), receiver, b64(RFC.auth))
    expect(result.recordSize).toBe(4096)
    expect(result.idLength).toBe(65)
    expect(result.sender.toString("base64url")).toBe(RFC.asPublic)
    expect(result.shared.toString("base64url")).toBe(RFC.ecdhSecret)
    expect(result.prkKey.toString("base64url")).toBe(RFC.prkKey)
    expect(result.ikm.toString("base64url")).toBe(RFC.ikm)
    expect(result.prk.toString("base64url")).toBe(RFC.prk)
    expect(Buffer.from("Content-Encoding: aes128gcm\0").toString("base64url")).toBe(RFC.cekInfo)
    expect(Buffer.from("Content-Encoding: nonce\0").toString("base64url")).toBe(RFC.nonceInfo)
    expect(result.cek.toString("base64url")).toBe(RFC.cek)
    expect(result.nonce.toString("base64url")).toBe(RFC.nonce)
    expect(result.plaintext.toString("base64url")).toBe(RFC.plaintext)
  })

  test("uses a new key pair and salt for every message, and refuses one that does not fit a record", () => {
    const receiver = phone()
    const keys = receiver.json.keys as { p256dh: string; auth: string }
    const first = encryptPushMessage(keys, Buffer.from("same"))
    const second = encryptPushMessage(keys, Buffer.from("same"))
    expect(first.subarray(0, 16).equals(second.subarray(0, 16))).toBe(false)
    expect(first.subarray(21, 86).equals(second.subarray(21, 86))).toBe(false)
    expect(decrypt(first, receiver.ecdh, receiver.auth).plaintext.toString()).toBe("same")
    expect(decrypt(second, receiver.ecdh, receiver.auth).plaintext.toString()).toBe("same")
    expect(encryptPushMessage(keys, Buffer.alloc(PUSH_PLAINTEXT_MAX)).length).toBe(4096)
    expect(() => encryptPushMessage(keys, Buffer.alloc(PUSH_PLAINTEXT_MAX + 1))).toThrow(
      expect.objectContaining({ code: "PUSH_PAYLOAD_TOO_LARGE" }),
    )
    expect(() => encryptPushMessage({ p256dh: "AAAA", auth: keys.auth }, Buffer.from("x"))).toThrow(
      expect.objectContaining({ code: "PUSH_SUBSCRIPTION_INVALID" }),
    )
  })
})

describe("VAPID", () => {
  test("signs an ES256 token for the endpoint's origin, at most a day long, with the public key alongside", async () => {
    const configuration = vapidConfiguration()!
    expect(configuration.publicKey).toBe(RFC.asPublic)
    const header = await vapidAuthorization("https://web.push.apple.com/QGuQyavXutnMH", configuration, NOW)
    const match = /^vapid t=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+), k=([A-Za-z0-9_-]+)$/.exec(header)
    expect(match).not.toBeNull()
    expect(match![2]).toBe(RFC.asPublic)
    expect(decodeProtectedHeader(match![1]!)).toEqual({ alg: "ES256", typ: "JWT" })
    const point = b64(RFC.asPublic)
    const key = await importJWK(
      {
        kty: "EC",
        crv: "P-256",
        x: point.subarray(1, 33).toString("base64url"),
        y: point.subarray(33).toString("base64url"),
      },
      "ES256",
    )
    const { payload } = await jwtVerify(match![1]!, key, {
      audience: "https://web.push.apple.com",
      currentDate: new Date(NOW),
    })
    expect(payload.sub).toBe("https://vectordev.ai/support")
    expect(payload.exp! * 1000 - NOW).toBeGreaterThan(0)
    expect(payload.exp! * 1000 - NOW).toBeLessThanOrEqual(DAY)
  })

  test("is configured only with all three settings, a valid subject and a private key matching the public one", () => {
    expect(pushConfigured()).toBe(true)
    for (const overrides of [
      { VECTOR_VAPID_PUBLIC_KEY: undefined },
      { VECTOR_VAPID_PRIVATE_KEY: undefined },
      { VECTOR_VAPID_SUBJECT: undefined },
      { VECTOR_VAPID_SUBJECT: "owner" },
      { VECTOR_VAPID_SUBJECT: "http://vectordev.ai" },
      { VECTOR_VAPID_PUBLIC_KEY: RFC.uaPublic }, // another key's public half
      { VECTOR_VAPID_PRIVATE_KEY: "short" },
    ]) {
      setEnvironment({ ...ENVIRONMENT, ...overrides })
      expect(vapidConfiguration()).toBeUndefined()
      expect(pushConfigured()).toBe(false)
    }
    setEnvironment({ ...ENVIRONMENT, VECTOR_VAPID_SUBJECT: "mailto:alerts@example.invalid" })
    expect(pushConfigured()).toBe(true)
    // A key tool that drops a private key's leading zero byte still gives a usable key.
    const scalar = Buffer.concat([Buffer.alloc(1), randomBytes(31)])
    const pair = createECDH("prime256v1")
    pair.setPrivateKey(scalar)
    setEnvironment({
      ...ENVIRONMENT,
      VECTOR_VAPID_PUBLIC_KEY: pair.getPublicKey("base64url"),
      VECTOR_VAPID_PRIVATE_KEY: scalar.subarray(1).toString("base64url"),
    })
    expect(vapidConfiguration()?.jwk.d).toBe(scalar.toString("base64url"))
  })
})

describe("POST /api/notify/subscribe", () => {
  test("GET answers the VAPID public key, and 503 until push is configured", async () => {
    const answer = await subscribe(undefined, {}, { method: "GET" })
    expect(answer).toMatchObject({ status: 200, body: { publicKey: RFC.asPublic } })
    setEnvironment({ ...ENVIRONMENT, VECTOR_VAPID_PRIVATE_KEY: undefined })
    expect((await subscribe(undefined, {}, { method: "GET" })).body.error.code).toBe("PUSH_UNAVAILABLE")
  })

  test("stores a phone's subscription for a signed-in account with an active plan, and only what it needs", async () => {
    seedPlan(PLUS, "vector-10")
    const device = phone()
    const answer = await subscribe(PLUS, { subscription: device.json }, { origin: "https://remote.vectordev.ai" })
    expect(answer.status).toBe(200)
    expect(answer.body).toEqual({ subscribed: true, id: pushSubscriptionId(device.endpoint) })
    const key = `vector:codium:test:notify:subs:${PLUS}`
    expect(pushSubscriptionsKey(PLUS)).toBe(key)
    const stored = JSON.parse(store.hash(key).get(pushSubscriptionId(device.endpoint))!)
    expect(Object.keys(stored).sort()).toEqual(["auth", "createdAt", "endpoint", "id", "p256dh"])
    expect(store.expires.get(key)).toBeGreaterThan(0)
  })

  test("needs a website session, and refuses other origins", async () => {
    seedPlan(PLUS, "vector-10")
    expect((await subscribe(undefined, { subscription: phone().json })).status).toBe(401)
    expect(
      (await subscribe(PLUS, { subscription: phone().json }, { origin: "https://evil.example" })).body.error.code,
    ).toBe("ORIGIN_NOT_ALLOWED")
    expect((await subscribe(PLUS, { subscription: phone().json }, { origin: "https://vectordev.ai" })).status).toBe(200)
    setEnvironment({ ...ENVIRONMENT, VECTOR_PHONE_APP_ORIGIN: undefined })
    expect(
      (await subscribe(PLUS, { subscription: phone().json }, { origin: "https://remote.vectordev.ai" })).body.error
        .code,
    ).toBe("ORIGIN_NOT_ALLOWED")
  })

  test("takes only the browsers' own push services, on https, with valid keys", async () => {
    seedPlan(PLUS, "vector-10")
    for (const endpoint of [
      "https://evil.example.com/push",
      "http://fcm.googleapis.com/fcm/send/x",
      "https://fcm.googleapis.com:8443/fcm/send/x",
      "https://169.254.169.254/latest",
      "https://user:pw@fcm.googleapis.com/x",
      "https://fcm.googleapis.com.evil.example/x",
    ])
      expect((await subscribe(PLUS, { subscription: phone(endpoint).json })).body.error.code).toBe(
        "PUSH_ENDPOINT_NOT_ALLOWED",
      )
    for (const endpoint of [
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://web.push.apple.com/QGuQyavXutnMH",
      "https://wns2-par02p.notify.windows.com/w/?token=abc",
    ])
      expect((await subscribe(PLUS, { subscription: phone(endpoint).json })).status).toBe(200)
    const device = phone()
    const keys = device.json.keys as Record<string, string>
    for (const bad of [
      { ...device.json, keys: { ...keys, auth: "short" } },
      { ...device.json, keys: { ...keys, p256dh: Buffer.alloc(65, 4).toString("base64url") } }, // not on the curve
      { ...device.json, keys: { p256dh: keys.p256dh } },
      { ...device.json, expirationTime: NOW - 1 },
      { endpoint: device.endpoint },
      "not an object",
    ])
      expect((await subscribe(PLUS, { subscription: bad })).body.error.code).toBe("PUSH_SUBSCRIPTION_INVALID")
  })

  test("needs a plan that allows phone alerts now, read from the snapshot (S1), and push switched on", async () => {
    seedPlan(OTHER, null, "none")
    expect((await subscribe(OTHER, { subscription: phone().json })).body.error.code).toBe("MODEL_PLAN_REQUIRED")
    seedPlan(PLUS, "vector-10", "paused")
    expect((await subscribe(PLUS, { subscription: phone().json })).body.error.code).toBe("MODEL_PLAN_PAYMENT_REQUIRED")
    seedPlan(PLUS, "vector-10", "frozen")
    expect((await subscribe(PLUS, { subscription: phone().json })).body.error.code).toBe("MODEL_PLAN_BLOCKED")
    seedPlan(PLUS, "vector-10", "ended")
    expect((await subscribe(PLUS, { subscription: phone().json })).body.error.code).toBe("MODEL_PLAN_REQUIRED")
    seedPlan(PLUS, "vector-10", "renewing")
    expect((await subscribe(PLUS, { subscription: phone().json })).status).toBe(200)
    seedPlan(PLUS, "vector-10")
    store.command(["SET", switchKey("push"), SWITCHED_OFF])
    expect((await subscribe(PLUS, { subscription: phone().json })).body.error.code).toBe("PUSH_UNAVAILABLE")
    expect(store.hash(pushSubscriptionsKey(PLUS)).size).toBe(1)
  })

  test("keeps ten per account: an eleventh replaces the oldest, and the same browser again replaces itself", async () => {
    seedPlan(PLUS, "vector-10")
    const devices = Array.from({ length: 11 }, () => phone())
    for (const [index, device] of devices.entries())
      await invoke((request, response) => handleNotifySubscribe(request, response, fresh(), () => NOW + index), {
        method: "POST",
        headers: jsonHeaders("192.0.2.10", { authorization: `Bearer ${session(PLUS)}` }),
        body: { subscription: device.json },
      })
    const ids = [...store.hash(pushSubscriptionsKey(PLUS)).keys()]
    expect(ids).toHaveLength(PUSH_LIMITS.subscriptions)
    expect(ids).not.toContain(pushSubscriptionId(devices[0]!.endpoint))
    expect(ids).toContain(pushSubscriptionId(devices[10]!.endpoint))
    await subscribe(PLUS, { subscription: devices[5]!.json })
    expect(store.hash(pushSubscriptionsKey(PLUS)).size).toBe(10)
  })

  test("DELETE removes a subscription whatever the plan, so alerts can always be turned off", async () => {
    seedPlan(PLUS, "vector-10")
    const device = phone()
    await subscribe(PLUS, { subscription: device.json })
    seedPlan(PLUS, "vector-10", "ended")
    expect((await subscribe(PLUS, { endpoint: device.endpoint }, { method: "DELETE" })).body).toEqual({ removed: true })
    expect((await subscribe(PLUS, { endpoint: device.endpoint }, { method: "DELETE" })).body).toEqual({
      removed: false,
    })
    expect((await subscribe(PLUS, {}, { method: "DELETE" })).body.error.code).toBe("PUSH_SUBSCRIPTION_INVALID")
    expect((await subscribe(undefined, { endpoint: device.endpoint }, { method: "DELETE" })).status).toBe(401)
  })
})

describe("POST /api/notify/send (P7: the desktop's alerts are end-to-end encrypted)", () => {
  async function twoPhones() {
    seedPlan(PLUS, "vector-10")
    const devices = [phone(), phone("https://web.push.apple.com/QGuQyavXutnMH")]
    for (const device of devices) expect((await subscribe(PLUS, { subscription: device.json })).status).toBe(200)
    return devices
  }

  test("relays the ciphertext untouched to every phone, each copy encrypted for that phone and VAPID-signed", async () => {
    const devices = await twoPhones()
    const sealed = ciphertext(200)
    const answer = await send(`Bearer ${desktopToken(PLUS)}`, { ciphertext: sealed, key: "k1", urgency: "high" })
    expect(answer).toMatchObject({ status: 200, body: { sent: 2, failed: 0, removed: 0 } })
    expect(deliveries).toHaveLength(2)
    for (const device of devices) {
      const delivery = deliveries.find((entry) => entry.url.href === device.endpoint)!
      expect(delivery.method).toBe("POST")
      expect(delivery.address).toBe(PUBLIC_ADDRESS)
      expect(delivery.headers["content-encoding"]).toBe("aes128gcm")
      expect(delivery.headers["content-type"]).toBe("application/octet-stream")
      expect(delivery.headers.urgency).toBe("high")
      expect(Number(delivery.headers.ttl)).toBeGreaterThan(0)
      expect(delivery.headers.authorization).toStartWith("vapid t=")
      expect(delivery.headers.authorization).toEndWith(`, k=${RFC.asPublic}`)
      // The push service sees only the RFC 8291 envelope; the phone opens it and finds the desktop's ciphertext.
      expect(Buffer.from(delivery.body!).includes(Buffer.from(sealed))).toBe(false)
      expect(opened(delivery, device)).toEqual({ v: 1, kind: "e2e", c: sealed, k: "k1" })
    }
    // One phone cannot open another's copy.
    const [first, second] = devices
    const firstDelivery = deliveries.find((entry) => entry.url.href === first!.endpoint)!
    expect(() => opened(firstDelivery, second!)).toThrow()
  })

  test("refuses any plaintext: a title, a message or any field besides the ciphertext", async () => {
    await twoPhones()
    const token = `Bearer ${desktopToken(PLUS)}`
    for (const body of [
      { title: "Build finished" },
      { ciphertext: ciphertext(), title: "Build finished" },
      { ciphertext: ciphertext(), body: "All 42 tests passed" },
      { ciphertext: ciphertext(), message: "x" },
      { ciphertext: "not base64url!" },
      { ciphertext: ciphertext(10) }, // shorter than a nonce and a tag
      { ciphertext: 42 },
      { ciphertext: ciphertext(), key: "has spaces" },
      { ciphertext: ciphertext(), urgency: "very-low" },
      {},
    ])
      expect((await send(token, body)).body.error.code).toBe("PUSH_CIPHERTEXT_REQUIRED")
    const tooLarge = await send(token, { ciphertext: "A".repeat(PUSH_LIMITS.ciphertextChars + 1) })
    expect(tooLarge.status).toBe(413)
    expect(tooLarge.body.error.code).toBe("PUSH_CIPHERTEXT_TOO_LARGE")
    expect(deliveries).toHaveLength(0)
    // 3 KB of ciphertext text is accepted and still fits one push record.
    const largest = Buffer.alloc(2304, 7).toString("base64url")
    expect(largest.length).toBe(PUSH_LIMITS.ciphertextChars)
    expect((await send(token, { ciphertext: largest })).body).toEqual({ sent: 2, failed: 0, removed: 0 })
  })

  test("only the desktop app's own sign-in sends: pasted, CLI and run tokens are refused (S3)", async () => {
    await twoPhones()
    const body = { ciphertext: ciphertext() }
    expect((await send(undefined, body)).status).toBe(401)
    expect((await send(`Bearer ${desktopToken(PLUS, "cli")}`, body)).body.error.code).toBe("DESKTOP_SIGN_IN_REQUIRED")
    expect((await send(`Bearer ${desktopToken(PLUS, "unmarked")}`, body)).body.error.code).toBe(
      "DESKTOP_SIGN_IN_REQUIRED",
    )
    expect((await send("Bearer vrt_abc.def", body)).status).toBe(401)
    expect((await send("Bearer vht_abc.def", body)).status).toBe(401)
    expect((await send(`Bearer ${session(PLUS)}`, body)).status).toBe(401)
    store.command(["SET", `vector:cli-revoked:${PLUS}`, "1"])
    expect((await send(`Bearer ${desktopToken(PLUS)}`, body)).status).toBe(401)
    expect(deliveries).toHaveLength(0)
  })

  test("allows 60 sends an hour per account", async () => {
    await twoPhones()
    const token = `Bearer ${desktopToken(PLUS)}`
    for (let index = 0; index < PUSH_LIMITS.sendsPerHour; index++)
      expect((await send(token, { ciphertext: ciphertext() })).status).toBe(200)
    const limited = await send(token, { ciphertext: ciphertext() })
    expect(limited.status).toBe(429)
    expect(limited.body.error.code).toBe("RATE_LIMITED")
    expect(deliveries).toHaveLength(2 * PUSH_LIMITS.sendsPerHour)
  })

  test("needs an active or renewing plan (S1, §4.4) and push configured and on", async () => {
    await twoPhones()
    const token = `Bearer ${desktopToken(PLUS)}`
    const body = { ciphertext: ciphertext() }
    for (const [state, code] of [
      ["paused", "MODEL_PLAN_PAYMENT_REQUIRED"],
      ["frozen", "MODEL_PLAN_BLOCKED"],
      ["ended", "MODEL_PLAN_REQUIRED"],
    ] as const) {
      seedPlan(PLUS, "vector-10", state)
      expect((await send(token, body)).body.error.code).toBe(code)
    }
    seedPlan(PLUS, null, "none")
    expect((await send(token, body)).body.error.code).toBe("MODEL_PLAN_REQUIRED")
    seedPlan(PLUS, "vector-10", "renewing")
    expect((await send(token, body)).status).toBe(200)
    seedPlan(PLUS, "vector-10")
    store.command(["SET", switchKey("push"), SWITCHED_OFF])
    expect((await send(token, body)).body.error.code).toBe("PUSH_UNAVAILABLE")
    store.data.delete(switchKey("push"))
    setEnvironment({ ...ENVIRONMENT, VECTOR_VAPID_PUBLIC_KEY: undefined })
    expect((await send(token, body)).body.error.code).toBe("PUSH_UNAVAILABLE")
    expect(deliveries).toHaveLength(2)
  })

  test("a push service's 404 or 410 deletes that subscription; other failures keep it", async () => {
    seedPlan(PLUS, "vector-10")
    const devices = [phone(), phone(), phone(), phone(), phone()]
    for (const device of devices) await subscribe(PLUS, { subscription: device.json })
    answers.set(devices[0]!.endpoint, 404)
    answers.set(devices[1]!.endpoint, 410)
    answers.set(devices[2]!.endpoint, 500)
    answers.set(devices[3]!.endpoint, 302) // a redirect is never followed
    const answer = await send(`Bearer ${desktopToken(PLUS)}`, { ciphertext: ciphertext() })
    expect(answer.body).toEqual({ sent: 1, failed: 2, removed: 2 })
    const left = [...store.hash(pushSubscriptionsKey(PLUS)).keys()]
    expect(left.sort()).toEqual(
      [devices[2]!, devices[3]!, devices[4]!].map((device) => pushSubscriptionId(device.endpoint)).sort(),
    )
  })

  test("an endpoint that now resolves to a private address is never contacted (S8)", async () => {
    await twoPhones()
    resolved = ["169.254.169.254"]
    const answer = await send(`Bearer ${desktopToken(PLUS)}`, { ciphertext: ciphertext() })
    expect(answer.body).toEqual({ sent: 0, failed: 2, removed: 0 })
    expect(deliveries).toHaveLength(0)
  })

  test("an account with no phones gets an answer and no deliveries", async () => {
    seedPlan(OTHER, "vector-50")
    expect((await send(`Bearer ${desktopToken(OTHER)}`, { ciphertext: ciphertext() })).body).toEqual({
      sent: 0,
      failed: 0,
      removed: 0,
    })
  })
})

describe("the server's own alerts (P7: titles only)", () => {
  test("carry a title and an optional tag, and nothing else, whatever the caller passes", async () => {
    seedPlan(PLUS, "vector-100")
    const device = phone()
    await subscribe(PLUS, { subscription: device.json })
    const outcome = await sendServerAlert(
      PLUS,
      { title: "  On Call: checkout.example.com is down  ", tag: "on-call", body: "stack trace", url: "/x" } as never,
      { fetcher: fresh(), now: NOW, network },
    )
    expect(outcome).toEqual({ sent: 1, failed: 0, removed: 0 })
    expect(opened(deliveries[0]!, device)).toEqual({
      v: 1,
      kind: "title",
      title: "On Call: checkout.example.com is down",
      tag: "on-call",
    })
  })

  test("titles are short single-line text; tags are lower-case words", () => {
    expect(titleAlert({ title: "Done by Morning finished 3 jobs" })).toEqual({
      v: 1,
      kind: "title",
      title: "Done by Morning finished 3 jobs",
    })
    for (const input of [
      { title: "" },
      { title: "   " },
      { title: "x".repeat(PUSH_LIMITS.titleChars + 1) },
      { title: "line one\nline two" },
      { title: "ok", tag: "Has Caps" },
      { title: "ok", tag: "x".repeat(33) },
    ])
      expect(() => titleAlert(input)).toThrow(expect.objectContaining({ code: "PUSH_TITLE_INVALID" }))
  })

  test("are skipped, never thrown, without a plan, while push is off, and while paused unless On Call asks", async () => {
    const device = phone()
    seedPlan(PLUS, "vector-100")
    await subscribe(PLUS, { subscription: device.json })
    seedPlan(PLUS, "vector-100", "paused")
    expect(
      await sendServerAlert(PLUS, { title: "Ship Desk card ready" }, { fetcher: fresh(), now: NOW, network }),
    ).toEqual({
      skipped: "plan",
    })
    expect(
      await sendServerAlert(
        PLUS,
        { title: "On Call: down" },
        { fetcher: fresh(), now: NOW, network, allowPaused: true },
      ),
    ).toEqual({ sent: 1, failed: 0, removed: 0 })
    seedPlan(PLUS, "vector-100", "frozen")
    expect(
      await sendServerAlert(
        PLUS,
        { title: "On Call: down" },
        { fetcher: fresh(), now: NOW, network, allowPaused: true },
      ),
    ).toEqual({ skipped: "plan" })
    seedPlan(PLUS, "vector-100")
    store.command(["SET", switchKey("push"), SWITCHED_OFF])
    expect(await sendServerAlert(PLUS, { title: "x" }, { fetcher: fresh(), now: NOW, network })).toEqual({
      skipped: "unavailable",
    })
    expect(deliveries).toHaveLength(1)
  })
})

describe("deletion (P5) and the push provisioner", () => {
  test("erasing an account deletes its subscriptions under both prefixes", async () => {
    store.command(["HSET", `vector:codium:live:notify:subs:${PLUS}`, "a", "{}"])
    store.command(["HSET", `vector:codium:test:notify:subs:${PLUS}`, "b", "{}"])
    store.command(["HSET", `vector:codium:test:notify:subs:${OTHER}`, "c", "{}"])
    expect(await eraseAccountPushSubscriptions(PLUS, fetcher)).toBe(2)
    expect([...store.data.keys()].filter((key) => key.includes("notify"))).toEqual([
      `vector:codium:test:notify:subs:${OTHER}`,
    ])
  })

  test("the provisioner is configured with the VAPID keys and erases subscriptions when the account closes", async () => {
    expect(pushProvisioner.id).toBe("push")
    expect(pushProvisioner.configured()).toBe(true)
    seedPlan(PLUS, "vector-10")
    await subscribe(PLUS, { subscription: phone().json })
    const snapshot = (state: SnapshotFacts["state"], reason?: SnapshotFacts["reason"]) =>
      buildSnapshot(
        {
          account: PLUS,
          state,
          ...(reason ? { reason } : {}),
          plan: "vector-10",
          subscription: "sub_0001",
          periodStart: NOW - DAY,
          periodEnd: NOW + 29 * DAY,
          cancelAtPeriodEnd: false,
          source: "webhook",
        },
        undefined,
        NOW,
      )
    await pushProvisioner.apply({ account: PLUS, to: snapshot("ended", "canceled"), cause: "ended" }, fetcher)
    expect(store.hash(pushSubscriptionsKey(PLUS)).size).toBe(1)
    await pushProvisioner.apply({ account: PLUS, to: snapshot("ended", "closing"), cause: "closing" }, fetcher)
    expect(store.hash(pushSubscriptionsKey(PLUS)).size).toBe(0)
    setEnvironment({ ...ENVIRONMENT, VECTOR_VAPID_PRIVATE_KEY: undefined })
    expect(pushProvisioner.configured()).toBe(false)
  })
})

describe("parseEncryptedAlert", () => {
  test("keeps only the ciphertext, the key id and the urgency", () => {
    const sealed = ciphertext()
    expect(parseEncryptedAlert({ ciphertext: sealed })).toEqual({
      payload: { v: 1, kind: "e2e", c: sealed },
      urgency: "normal",
    })
  })
})
