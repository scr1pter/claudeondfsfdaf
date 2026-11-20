import { describe, expect, test } from "bun:test"
import { utf8 } from "../src/bytes"
import { handleRequest } from "../src/index"
import {
  INTERNAL_HEADERS,
  accountHandle,
  callbackOrigin,
  internalCanonical,
  sha256Hex,
  signInternal,
  verifyInternalSignature,
} from "../src/internal"
import { OPS_LIMITS } from "../src/limits"
import { OpsAccount } from "../src/ops-account"
import type { Env } from "../src/runtime"
import {
  ACCOUNT,
  ACCOUNT_KEY,
  API_ORIGIN,
  FakeKV,
  FakeNamespace,
  FakeNet,
  Harness,
  INTERNAL_SECRET,
  NOW,
  SHA,
  planFor,
  token,
} from "./fakes"

// WP A46: the API's calls carry WP A37's HMAC under the `ops` service key (300 s of skew, each nonce once), and so do the
// Worker's reports back. The Worker's kill flag is set through a control object; erase (delete) leaves nothing about
// the account. test/ops-worker-contract.test.ts at the repository root checks the same bytes against the API's signer.

const HOST = "status.vector-fixture.com"
const HOME = `https://${HOST}/`

function worker(options: { env?: Partial<Env> } = {}) {
  const clock = { now: NOW }
  const net = new FakeNet()
  const kv = new FakeKV()
  const runtime = { now: () => clock.now, fetch: net.fetch }
  const namespace: FakeNamespace = new FakeNamespace((state) => new OpsAccount(state, env, runtime))
  const env: Env = { OPS_ACCOUNT: namespace, OPS_FLAGS: kv, INTERNAL_SECRET, ACCOUNT_KEY, API_ORIGIN, ...options.env }
  async function send(
    action: string,
    body: unknown,
    input: { secret?: string; now?: number; nonce?: string; path?: string } = {},
  ) {
    const text = typeof body === "string" ? body : JSON.stringify(body)
    const path = input.path ?? `/internal/v1/${action}`
    const headers = await signInternal(input.secret ?? INTERNAL_SECRET, {
      method: "POST",
      path,
      body: text,
      now: input.now ?? clock.now,
      ...(input.nonce ? { nonce: input.nonce } : {}),
    })
    const response = await handleRequest(
      new Request(`https://vector-ops.workers.dev${path}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: text,
      }),
      env,
      runtime,
    )
    return { status: response.status, body: (await response.json()) as Record<string, any>, headers }
  }
  return { clock, net, kv, env, namespace, runtime, send }
}

/** A body that arrives in 1 KiB chunks only as it is read (nothing is queued ahead), counting the reads and cancels. */
function trickle(bytes: Uint8Array) {
  const counts = { pulled: 0, cancelled: 0 }
  let offset = 0
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        counts.pulled++
        if (offset >= bytes.byteLength) return controller.close()
        controller.enqueue(bytes.slice(offset, offset + 1024))
        offset += 1024
      },
      cancel() {
        counts.cancelled++
      },
    },
    { highWaterMark: 0 },
  )
  return { body, counts }
}

/** Waits (a few ms at a time) until `ready` holds: a wake or a call is now waiting where the test holds it. */
async function until(ready: () => boolean) {
  while (!ready()) await Bun.sleep(1)
}

/** What an erased object may hold: the erasure time and nothing else. */
function expectErased(harness: Harness) {
  expect(harness.rows<{ k: string }>("SELECT k FROM meta").map((row) => row.k)).toEqual(["erased_at"])
  const stored = JSON.stringify(harness.rows("SELECT * FROM meta"))
  expect(stored).not.toContain(HOST)
  expect(stored).not.toContain(ACCOUNT)
  for (const table of ["monitors", "changes", "hourly", "releases", "baselines", "outbox"])
    expect({ table, rows: harness.rows(`SELECT * FROM ${table}`) }).toEqual({ table, rows: [] })
  expect(harness.state.alarm).toBeNull()
}

describe("internal signature", () => {
  test("the canonical string is A37's seven lines with the ops service", async () => {
    expect(
      internalCanonical({
        service: "ops",
        method: "post",
        path: "/internal/v1/plan?x=1",
        timestamp: 1_790_000_000,
        nonce: "n".repeat(22),
        bodyHash: await sha256Hex(new Uint8Array(0)),
      }),
    ).toBe(
      [
        "vector-internal-v1",
        "ops",
        "POST",
        "/internal/v1/plan?x=1",
        "1790000000",
        "n".repeat(22),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      ].join("\n"),
    )
  })

  test("a signed request passes and gives its nonce and signed time; any change fails", async () => {
    const body = JSON.stringify({ account: ACCOUNT })
    const path = "/internal/v1/state"
    const headers = await signInternal(INTERNAL_SECRET, { method: "POST", path, body, now: NOW, nonce: "a".repeat(22) })
    const check = (input: {
      body?: string
      path?: string
      method?: string
      now?: number
      headers?: Record<string, string>
    }) =>
      verifyInternalSignature(
        INTERNAL_SECRET,
        {
          method: input.method ?? "POST",
          path: input.path ?? path,
          headers: new Headers(input.headers ?? headers),
          body: utf8(input.body ?? body),
        },
        input.now ?? NOW,
      )
    expect(await check({})).toEqual({ ok: true, nonce: "a".repeat(22), signedAt: Math.floor(NOW / 1000) * 1000 })
    expect(await check({ body: JSON.stringify({ account: `${ACCOUNT}x` }) })).toEqual({ ok: false })
    expect(await check({ path: "/internal/v1/erase" })).toEqual({ ok: false })
    expect(await check({ method: "PUT" })).toEqual({ ok: false })
    expect(await check({ now: NOW + 301_000 })).toEqual({ ok: false })
    expect(await check({ headers: { ...headers, [INTERNAL_HEADERS.nonce]: "b".repeat(22) } })).toEqual({ ok: false })
    expect(await check({ headers: { ...headers, [INTERNAL_HEADERS.signature]: "x" } })).toEqual({ ok: false })
    // Signed for another service with the same secret.
    const relay = await signInternal(INTERNAL_SECRET, { method: "POST", path, body, now: NOW, service: "relay" })
    expect(await check({ headers: relay })).toEqual({ ok: false })
  })

  test("object names are an HMAC of the account under ACCOUNT_KEY, never the account itself", async () => {
    const handle = await accountHandle(ACCOUNT_KEY, ACCOUNT)
    expect(handle).toMatch(/^[0-9a-f]{64}$/)
    expect(await accountHandle(ACCOUNT_KEY, `${ACCOUNT}2`)).not.toBe(handle)
    expect(await accountHandle("short", ACCOUNT)).toBeUndefined()
    expect(await accountHandle(undefined, ACCOUNT)).toBeUndefined()
  })
})

describe("routes", () => {
  test("health, unknown paths and methods", async () => {
    const { env } = worker()
    const runtime = { now: () => NOW, fetch: new FakeNet().fetch }
    expect((await handleRequest(new Request("https://w.dev/health"), env, runtime)).status).toBe(200)
    expect((await handleRequest(new Request("https://w.dev/health", { method: "POST" }), env, runtime)).status).toBe(
      405,
    )
    expect((await handleRequest(new Request("https://w.dev/"), env, runtime)).status).toBe(404)
    expect((await handleRequest(new Request("https://w.dev/internal/v1/plan"), env, runtime)).status).toBe(405)
    expect(
      (await handleRequest(new Request("https://w.dev/internal/v1/nope", { method: "POST" }), env, runtime)).status,
    ).toBe(404)
  })

  test("a signed call reaches the account's object by its HMAC name, carrying only the body, nonce and signed time", async () => {
    const { send, namespace } = worker()
    const result = await send("plan", { account: ACCOUNT, plan: planFor("vector-200") })
    expect(result).toMatchObject({ status: 200, body: { applied: true, version: 1 } })
    const call = namespace.calls.at(-1)!
    expect(call.name).toBe((await accountHandle(ACCOUNT_KEY, ACCOUNT))!)
    expect(call.url).toBe("https://ops.invalid/internal/plan")
    expect(call.headers.get("x-vector-ops-nonce")).toBe(result.headers[INTERNAL_HEADERS.nonce]!)
    expect(call.headers.get("x-vector-ops-signed-at")).toBe(String(Math.floor(NOW / 1000) * 1000))
    expect(call.headers.get(INTERNAL_HEADERS.signature)).toBeNull()
  })

  test("refusals: bad signature 401, replayed nonce 401, no secret 503, too large 413, bad JSON or account 400", async () => {
    const { send } = worker()
    expect((await send("state", { account: ACCOUNT }, { secret: "other-secret-".padEnd(48, "o") })).status).toBe(401)
    expect((await send("state", { account: ACCOUNT }, { now: NOW - 400_000 })).status).toBe(401)
    const nonce = token()
    expect((await send("state", { account: ACCOUNT }, { nonce })).status).toBe(200)
    expect((await send("state", { account: ACCOUNT }, { nonce })).status).toBe(401)
    expect((await send("state", "not json")).status).toBe(400)
    expect((await send("state", [ACCOUNT])).status).toBe(400)
    expect((await send("state", { account: "has space" })).status).toBe(400)
    expect((await send("state", { account: ACCOUNT, pad: "x".repeat(OPS_LIMITS.internalBodyBytes) })).status).toBe(413)
    expect((await worker({ env: { INTERNAL_SECRET: "short" } }).send("state", { account: ACCOUNT })).status).toBe(503)
    expect((await worker({ env: { ACCOUNT_KEY: undefined } }).send("state", { account: ACCOUNT })).status).toBe(503)
  })

  test("a body sent with no length is read only to 32 KiB and one more byte, and the rest is cancelled", async () => {
    const { env, runtime, clock } = worker()
    const large = trickle(new Uint8Array(1024 * 1024).fill(0x20))
    const request = new Request("https://vector-ops.workers.dev/internal/v1/state", {
      method: "POST",
      body: large.body,
    })
    expect(request.headers.get("content-length")).toBeNull()
    const refused = await handleRequest(request, env, runtime)
    expect({ status: refused.status, ...large.counts }).toEqual({ status: 413, pulled: 33, cancelled: 1 })
    // A signed body of exactly 32 KiB, sent the same way, is still taken.
    const prefix = JSON.stringify({ account: ACCOUNT, pad: "" })
    const text = JSON.stringify({ account: ACCOUNT, pad: "x".repeat(OPS_LIMITS.internalBodyBytes - prefix.length) })
    expect(utf8(text).byteLength).toBe(OPS_LIMITS.internalBodyBytes)
    const path = "/internal/v1/state"
    const headers = await signInternal(INTERNAL_SECRET, { method: "POST", path, body: text, now: clock.now })
    const exact = trickle(utf8(text))
    const taken = await handleRequest(
      new Request(`https://vector-ops.workers.dev${path}`, { method: "POST", headers, body: exact.body }),
      env,
      runtime,
    )
    expect(taken.status).toBe(200)
    expect(exact.counts.cancelled).toBe(0)
  })

  test("a delayed call to the kill flag cannot undo a newer one, either way", async () => {
    const { send, kv, clock } = worker()
    expect((await send("flags", { kill: true })).body).toEqual({ kill: true })
    // The clear the API gave up on, signed a minute before the raise, arrives after it.
    expect((await send("flags", { kill: false }, { now: clock.now - 60_000 })).body).toEqual({
      kill: true,
      applied: false,
    })
    expect(kv.values.get("kill")).toBe("1")
    expect((await send("flags", { kill: true }, { now: clock.now - 120_000 })).body).toEqual({
      kill: true,
      applied: false,
    })
    expect((await send("flags", { kill: false }, { now: clock.now - 30_000 })).body).toEqual({
      kill: true,
      applied: false,
    })
    expect(kv.values.get("kill")).toBe("1")
    clock.now += 1_000
    expect((await send("flags", { kill: false })).body).toEqual({ kill: false })
    expect(kv.values.has("kill")).toBe(false)
    // A raise signed before that newer clear is refused the same way.
    expect((await send("flags", { kill: true }, { now: clock.now - 30_000 })).body).toEqual({
      kill: false,
      applied: false,
    })
    expect(kv.values.has("kill")).toBe(false)
    clock.now += 1_000
    expect((await send("flags", { kill: true })).body).toEqual({ kill: true })
    expect(kv.values.get("kill")).toBe("1")
  })

  test("the kill flag is set and cleared through the control object, and read on every wake", async () => {
    const { send, kv, namespace } = worker()
    expect((await send("flags", { kill: true })).body).toEqual({ kill: true })
    expect(kv.values.get("kill")).toBe("1")
    expect(namespace.calls.at(-1)!.name).toBe("control")
    expect((await send("flags", { kill: false })).body).toEqual({ kill: false })
    expect(kv.values.has("kill")).toBe(false)
    expect((await send("flags", { kill: "yes" })).status).toBe(400)
  })
})

describe("the object's internal calls", () => {
  test("a nonce is applied once, even straight to the object", async () => {
    const harness = new Harness()
    const nonce = token()
    expect((await harness.call("state", { account: ACCOUNT }, { nonce })).status).toBe(200)
    expect((await harness.call("state", { account: ACCOUNT }, { nonce })).status).toBe(401)
    expect((await harness.call("state", { account: ACCOUNT }, { nonce: "short" })).status).toBe(401)
  })

  test("an object answers for one account only", async () => {
    const harness = new Harness()
    await harness.plan(planFor("vector-200"))
    expect((await harness.call("state", { account: "acct_someone_else" })).status).toBe(409)
    expect((await harness.call("erase", { account: "acct_someone_else" })).status).toBe(409)
  })

  test("config is validated: verified host names, https URLs on 443, unique ids, at most 10 of each", async () => {
    const harness = new Harness()
    const bad = [
      { domains: ["Upper.com"], monitors: [] },
      { domains: ["10.0.0.1"], monitors: [] },
      { domains: ["a.com", "a.com"], monitors: [] },
      { domains: Array.from({ length: 11 }, (_, index) => `d${index}.com`), monitors: [] },
      { domains: [HOST], monitors: [{ id: "a", url: "http://status.vector-fixture.com/" }] },
      { domains: [HOST], monitors: [{ id: "a", url: "https://127.0.0.1/" }] },
      { domains: [HOST], monitors: [{ id: "a b", url: HOME }] },
      {
        domains: [HOST],
        monitors: [
          { id: "a", url: HOME },
          { id: "a", url: HOME },
        ],
      },
      { domains: [HOST], monitors: Array.from({ length: 11 }, (_, index) => ({ id: `m${index}`, url: HOME })) },
    ]
    for (const body of bad)
      expect({ body, status: (await harness.call("config", { account: ACCOUNT, ...body })).status }).toEqual({
        body,
        status: 400,
      })
    expect((await harness.config([HOST], [{ id: "home", url: HOME }])).body).toEqual({ monitors: 1, probed: 0 })
  })
})

describe("erase (delete)", () => {
  test("everything about the account goes; a call signed before the erasure is refused, a later one works", async () => {
    const harness = new Harness()
    await harness.plan(planFor("vector-200"))
    await harness.config([HOST], [{ id: "home", url: HOME }])
    harness.net.sites.set(HOME, () => new Response("x", { status: 500 }))
    harness.net.reportStatus = 503
    await harness.runFor(5 * 60_000)
    await harness.release({ sha: SHA("1"), urls: [HOME] })
    expect(harness.rows("SELECT * FROM outbox").length).toBeGreaterThan(0)
    const signedBefore = Math.floor(harness.clock.now / 1000) * 1000
    harness.advance(2_000)
    expect((await harness.call("erase", { account: ACCOUNT })).body).toEqual({ erased: true })
    expect(harness.state.alarm).toBeNull()
    for (const table of ["monitors", "changes", "hourly", "releases", "baselines", "outbox"])
      expect({ table, rows: harness.rows(`SELECT * FROM ${table}`) }).toEqual({ table, rows: [] })
    expect(harness.rows<{ k: string }>("SELECT k FROM meta").map((row) => row.k)).toEqual(["erased_at"])
    expect(JSON.stringify(harness.rows("SELECT * FROM seen"))).not.toContain(ACCOUNT)
    // Late calls signed before the erasure cannot fill the object again.
    expect(
      (await harness.call("plan", { account: ACCOUNT, plan: planFor("vector-200") }, { signedAt: signedBefore }))
        .status,
    ).toBe(409)
    expect(
      (await harness.call("config", { account: ACCOUNT, domains: [HOST], monitors: [] }, { signedAt: signedBefore }))
        .status,
    ).toBe(409)
    expect((await harness.state_()).body).toMatchObject({ active: false, plan: null, monitors: [] })
    // A later account with the same id (a re-subscription) starts clean.
    harness.advance(1_000)
    expect((await harness.plan(planFor("vector-200", { validUntil: harness.clock.now + 86_400_000 }))).status).toBe(200)
  })

  test("an erasure while a wake waits on its probes leaves nothing of that wake", async () => {
    const harness = new Harness()
    await harness.plan(planFor("vector-200"))
    await harness.config([HOST], [{ id: "home", url: HOME }])
    const gate = Promise.withResolvers<Response>()
    harness.net.sites.set(HOME, () => gate.promise)
    const wake = harness.fire()
    await until(() => harness.net.probes(HOME) === 1)
    expect((await harness.call("erase", { account: ACCOUNT })).body).toEqual({ erased: true })
    gate.resolve(new Response("x", { status: 500 }))
    await wake
    expectErased(harness)
  })

  test("an erasure while a wake waits on the kill flag leaves nothing of that wake, with the flag set or not", async () => {
    for (const flag of ["1", null]) {
      const harness = new Harness()
      await harness.plan(planFor("vector-200"))
      await harness.config([HOST], [{ id: "home", url: HOME }])
      await harness.fire()
      const gate = Promise.withResolvers<void>()
      let waiting = false
      harness.kv.get = async () => {
        waiting = true
        await gate.promise
        return flag
      }
      const wake = harness.fire()
      await until(() => waiting)
      expect((await harness.call("erase", { account: ACCOUNT })).body).toEqual({ erased: true })
      gate.resolve()
      await wake
      expectErased(harness)
    }
  })

  test("an erasure while a release waits on the kill flag stores neither the release nor the account", async () => {
    const harness = new Harness()
    const gate = Promise.withResolvers<void>()
    let waiting = false
    harness.kv.get = async () => {
      waiting = true
      await gate.promise
      return null
    }
    // A fresh object: the first release would have stored the account id with its answer.
    const fresh = harness.release({ sha: SHA("1"), urls: [HOME] })
    await until(() => waiting)
    expect((await harness.call("erase", { account: ACCOUNT })).body).toEqual({ erased: true })
    gate.resolve()
    expect(await fresh).toEqual({ status: 409, body: { error: { code: "OPS_ERASED" } } })
    expectErased(harness)
    // A re-subscription while a release signed before the erasure waits: the release is still refused.
    const later = new Harness()
    await later.plan(planFor("vector-200"))
    await later.config([HOST], [])
    const held = Promise.withResolvers<void>()
    waiting = false
    later.kv.get = async () => {
      waiting = true
      await held.promise
      return null
    }
    const delayed = later.release({ sha: SHA("2"), urls: [HOME] })
    await until(() => waiting)
    expect((await later.call("erase", { account: ACCOUNT })).body).toEqual({ erased: true })
    later.advance(1_000)
    expect((await later.plan(planFor("vector-200", { validUntil: later.clock.now + 86_400_000 }))).status).toBe(200)
    held.resolve()
    expect(await delayed).toEqual({ status: 409, body: { error: { code: "OPS_ERASED" } } })
    expect(later.rows("SELECT * FROM releases")).toEqual([])
  })

  test("a repeated erase answers the same and keeps only the erasure time", async () => {
    const { send, namespace, clock } = worker()
    await send("plan", { account: ACCOUNT, plan: planFor("vector-200") })
    const entry = async () => namespace.objects.get((await accountHandle(ACCOUNT_KEY, ACCOUNT))!)!
    const erasedAt = async () =>
      JSON.parse((await entry()).state.sql.rows<{ v: string }>("SELECT v FROM meta WHERE k = 'erased_at'")[0]!.v)
    expect((await send("erase", { account: ACCOUNT })).body).toEqual({ erased: true })
    const first = await erasedAt()
    clock.now += 1_000
    expect((await send("erase", { account: ACCOUNT })).body).toEqual({ erased: true })
    expect((await entry()).state.sql.rows<{ k: string }>("SELECT k FROM meta").map((row) => row.k)).toEqual([
      "erased_at",
    ])
    expect(await erasedAt()).toBe(first + 1_000)
    expect((await entry()).state.alarm).toBeNull()
  })

  test("erase through the Worker reaches the account's object", async () => {
    const { send, namespace } = worker()
    await send("plan", { account: ACCOUNT, plan: planFor("vector-200") })
    expect((await send("erase", { account: ACCOUNT })).body).toEqual({ erased: true })
    const entry = namespace.objects.get((await accountHandle(ACCOUNT_KEY, ACCOUNT))!)!
    expect(entry.state.sql.rows<{ k: string }>("SELECT k FROM meta").map((row) => row.k)).toEqual(["erased_at"])
  })
})

describe("reports to the API", () => {
  test("a report is signed for the ops service, names the account and is retried until a 2xx, with the same event id", async () => {
    const harness = new Harness()
    await harness.plan(planFor("vector-200"))
    await harness.config([HOST], [{ id: "home", url: HOME }])
    harness.net.sites.set(HOME, () => new Response("x", { status: 500 }))
    harness.net.reportStatus = 500
    await harness.fire()
    await harness.fire()
    expect(harness.net.reports).toHaveLength(1)
    const first = harness.net.reports[0]!
    expect(first.url).toBe(`${API_ORIGIN}/api/ops/worker`)
    const signed = await verifyInternalSignature(
      INTERNAL_SECRET,
      { method: "POST", path: "/api/ops/worker", headers: first.headers, body: utf8(first.body) },
      harness.clock.now,
    )
    expect(signed.ok).toBe(true)
    const report = JSON.parse(first.body)
    expect(report).toMatchObject({ v: 1, account: ACCOUNT, events: [{ kind: "monitor.down", monitor: "home" }] })
    // Backoff: not resent on the very next wake if it is under 30 s later, then doubling.
    const retries: number[] = []
    for (let wake = 0; wake < 12 && harness.net.reports.length < 4; wake++) {
      const count = harness.net.reports.length
      await harness.fire()
      if (harness.net.reports.length > count) retries.push(harness.clock.now)
    }
    expect(retries.length).toBeGreaterThanOrEqual(2)
    for (let index = 1; index < retries.length; index++)
      expect(retries[index]! - retries[index - 1]!).toBeGreaterThanOrEqual(OPS_LIMITS.outboxRetryBaseMs * 2 ** index)
    harness.net.reportStatus = 200
    await harness.runFor(10 * 60_000)
    const ids = harness.net.events().map((event) => event.id)
    expect(new Set(ids).size).toBe(1)
    expect(harness.rows("SELECT * FROM outbox")).toEqual([])
  })

  test("a redirect from the API is not a delivery; reports older than a day are dropped", async () => {
    const harness = new Harness()
    await harness.plan(planFor("vector-200"))
    await harness.config([HOST], [{ id: "home", url: HOME }])
    harness.net.sites.set(HOME, () => new Response("x", { status: 500 }))
    harness.net.reportStatus = 302
    await harness.fire()
    await harness.fire()
    expect(harness.rows("SELECT * FROM outbox")).toHaveLength(1)
    harness.net.sites.set(HOME, () => new Response("ok"))
    await harness.runFor(25 * 60 * 60_000)
    expect(harness.rows("SELECT * FROM outbox").length).toBeLessThanOrEqual(1)
    const oldest = harness.rows<{ created_at: number }>("SELECT min(created_at) AS created_at FROM outbox")[0]!
      .created_at
    if (oldest !== null) expect(harness.clock.now - oldest).toBeLessThanOrEqual(OPS_LIMITS.outboxKeepMs)
  })

  test("without API_ORIGIN reports wait, and no alarm is set just for them", async () => {
    const harness = new Harness({ API_ORIGIN: undefined })
    await harness.plan(planFor("vector-200", { validUntil: NOW + 3 * 60_000 }))
    await harness.config([HOST], [{ id: "home", url: HOME }])
    harness.net.sites.set(HOME, () => new Response("x", { status: 500 }))
    await harness.runFor(10 * 60_000)
    expect(harness.net.reports).toEqual([])
    expect(harness.rows("SELECT * FROM outbox")).toHaveLength(1)
    expect(harness.state.alarm).toBeNull()
  })

  test("API_ORIGIN is https with no path; plain http only to this machine", () => {
    expect(callbackOrigin("https://vectordev.ai")).toBe("https://vectordev.ai")
    expect(callbackOrigin("https://vectordev.ai/")).toBe("https://vectordev.ai")
    expect(callbackOrigin("http://127.0.0.1:8899")).toBe("http://127.0.0.1:8899")
    for (const value of [
      "http://vectordev.ai",
      "https://vectordev.ai/api",
      "https://u:p@vectordev.ai",
      "https://vectordev.ai?x=1",
      "",
      undefined,
      "nope",
    ])
      expect({ value, origin: callbackOrigin(value) }).toEqual({ value, origin: undefined })
  })

  test("the outbox keeps at most 200 reports", async () => {
    const harness = new Harness({ API_ORIGIN: undefined })
    await harness.plan(planFor("vector-200"))
    await harness.config(
      [HOST],
      Array.from({ length: 10 }, (_, index) => ({ id: `m${index}`, url: `${HOME}p${index}` })),
    )
    let failing = true
    for (let index = 0; index < 10; index++)
      harness.net.sites.set(`${HOME}p${index}`, () => new Response("x", { status: failing ? 500 : 200 }))
    for (let round = 0; round < 12; round++) {
      failing = true
      await harness.fire()
      await harness.fire()
      failing = false
      await harness.fire()
    }
    expect(harness.rows("SELECT * FROM outbox").length).toBe(OPS_LIMITS.outboxMax)
  })
})
