import { describe, expect, test } from "bun:test"
import { AccountRelay } from "../src/account-relay"
import { handleRequest } from "../src/index"
import {
  INTERNAL_HEADERS,
  internalCanonical,
  sha256Hex,
  signInternal,
  verifyInternalRequest,
  verifyInternalSignature,
} from "../src/internal"
import { base64url, fromUtf8, utf8 } from "../src/bytes"
import { RELAY_LIMITS } from "../src/limits"
import { CLOSE, DEVICE_BYTES, FRAME, decodeFrame, encodeFrame } from "../src/protocol"
import { accountHandle, signTicket } from "../src/ticket"
import {
  ACCOUNT,
  ACCOUNT_KEY,
  EPOCH,
  INTERNAL_SECRET,
  NOW,
  FakeKV,
  FakeNamespace,
  FakeRuntime,
  Harness,
  type FakeSocket,
  type FakeState,
  type UpgradeResponse,
  deviceId,
  frame,
  ticketKeys,
  token,
} from "./fakes"

// WP A39: the API's calls to the relay (kill, suspend, presence, devices, revoke, erase, the kill flag and, for R-C1,
// job offers) carry WP A37's HMAC: the service, method, path, timestamp, nonce and a hash of the body, 300 s of skew,
// each nonce once. test/remote-relay-contract.test.ts at the repository root checks the same bytes against the API's
// own signer.

const PATH = "/internal/v1/presence"

/** An offer in the API's shape (`vef1.<payload>.<86-character signature>`); the relay checks only its form. */
const OFFER = () => `vef1.${token()}${token()}.${base64url(crypto.getRandomValues(new Uint8Array(64)))}`

/** The API's signed call through the real Worker to the account's object, the path relayCall takes. */
async function viaWorker(h: Harness, action: string, body: Record<string, unknown>) {
  const text = JSON.stringify(body)
  const path = `/internal/v1/${action}`
  const signed = await signInternal(INTERNAL_SECRET, { method: "POST", path, body: text, now: h.clock.now })
  const response = await handleRequest(
    new Request(`https://relay.example${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...signed },
      body: text,
    }),
    h.env,
    h.runtime,
  )
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

async function headersFor(body: string, input: { now?: number; nonce?: string; path?: string; secret?: string } = {}) {
  return signInternal(input.secret ?? INTERNAL_SECRET, {
    method: "POST",
    path: input.path ?? PATH,
    body,
    now: input.now ?? NOW,
    ...(input.nonce ? { nonce: input.nonce } : {}),
  })
}

async function check(
  body: string,
  headers: Record<string, string>,
  input: { now?: number; path?: string; method?: string } = {},
) {
  return verifyInternalRequest(
    INTERNAL_SECRET,
    { method: input.method ?? "POST", path: input.path ?? PATH, headers: new Headers(headers), body: utf8(body) },
    input.now ?? NOW,
  )
}

describe("internal signature", () => {
  test("the canonical string is A37's seven lines", async () => {
    expect(
      internalCanonical({
        service: "relay",
        method: "post",
        path: "/internal/v1/kill?x=1",
        timestamp: 1_790_000_000,
        nonce: "n".repeat(22),
        bodyHash: await sha256Hex(new Uint8Array(0)),
      }),
    ).toBe(
      [
        "vector-internal-v1",
        "relay",
        "POST",
        "/internal/v1/kill?x=1",
        "1790000000",
        "n".repeat(22),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      ].join("\n"),
    )
  })

  test("a request signed for the relay passes and gives its nonce", async () => {
    const body = JSON.stringify({ account: ACCOUNT })
    const headers = await headersFor(body, { nonce: "a".repeat(22) })
    expect(await check(body, headers)).toEqual({ ok: true, nonce: "a".repeat(22), signedAt: NOW })
  })

  test("the existing nonce-only verifier keeps its exact public reply", async () => {
    const body = "{}"
    const headers = await headersFor(body, { nonce: "c".repeat(22) })
    expect(
      await verifyInternalSignature(
        INTERNAL_SECRET,
        {
          method: "POST",
          path: PATH,
          headers: new Headers(headers),
          body: utf8(body),
        },
        NOW,
      ),
    ).toEqual({ ok: true, nonce: "c".repeat(22) })
  })

  test("a changed body, path, method, timestamp or nonce fails", async () => {
    const body = JSON.stringify({ account: ACCOUNT })
    const headers = await headersFor(body)
    expect(await check(JSON.stringify({ account: `${ACCOUNT}x` }), headers)).toEqual({ ok: false })
    expect(await check(body, headers, { path: "/internal/v1/kill" })).toEqual({ ok: false })
    expect(await check(body, headers, { method: "PUT" })).toEqual({ ok: false })
    expect(await check(body, { ...headers, [INTERNAL_HEADERS.timestamp]: String(Math.floor(NOW / 1000) + 1) })).toEqual(
      {
        ok: false,
      },
    )
    expect(await check(body, { ...headers, [INTERNAL_HEADERS.nonce]: "b".repeat(22) })).toEqual({ ok: false })
  })

  test("a signature for another service or with another secret fails", async () => {
    const body = "{}"
    const forOps = await signInternal(INTERNAL_SECRET, { method: "POST", path: PATH, body, now: NOW, service: "ops" })
    const forHosted = await signInternal(INTERNAL_SECRET, {
      method: "POST",
      path: PATH,
      body,
      now: NOW,
      service: "hosted",
    })
    expect(await check(body, forOps)).toEqual({ ok: false })
    expect(await check(body, forHosted)).toEqual({ ok: false })
    expect(await check(body, await headersFor(body, { secret: `${INTERNAL_SECRET}x` }))).toEqual({ ok: false })
  })

  test("300 s of clock skew either way, and no more", async () => {
    const body = "{}"
    const headers = await headersFor(body)
    expect((await check(body, headers, { now: NOW + 300_000 })).ok).toBe(true)
    expect((await check(body, headers, { now: NOW - 300_000 })).ok).toBe(true)
    expect(await check(body, headers, { now: NOW + 301_000 })).toEqual({ ok: false })
    expect(await check(body, headers, { now: NOW - 301_000 })).toEqual({ ok: false })
  })

  test("missing or malformed headers fail", async () => {
    const body = "{}"
    const headers = await headersFor(body)
    for (const name of Object.values(INTERNAL_HEADERS)) {
      const without = { ...headers }
      delete without[name]
      expect(await check(body, without)).toEqual({ ok: false })
    }
    expect(await check(body, { ...headers, [INTERNAL_HEADERS.nonce]: "short" })).toEqual({ ok: false })
    expect(await check(body, { ...headers, [INTERNAL_HEADERS.signature]: "x".repeat(42) })).toEqual({ ok: false })
    expect(await check(body, { ...headers, [INTERNAL_HEADERS.timestamp]: "12.5" })).toEqual({ ok: false })
  })
})

describe("internal routes", () => {
  async function worker(options: { secret?: string } = {}) {
    const keys = await ticketKeys()
    const clock = { now: NOW }
    const runtime = new FakeRuntime(clock)
    const kv = new FakeKV()
    let env: ConstructorParameters<typeof AccountRelay>[1]
    const namespace = new FakeNamespace((state: FakeState) => new AccountRelay(state, env, runtime))
    env = {
      ACCOUNT_RELAY: namespace,
      REMOTE_FLAGS: kv,
      TICKET_PUBLIC_KEYS: keys.publicText,
      ACCOUNT_KEY,
      ...(options.secret !== "" ? { INTERNAL_SECRET: options.secret ?? INTERNAL_SECRET } : {}),
    }
    const call = async (
      action: string,
      body: unknown,
      input: { headers?: Record<string, string>; method?: string; raw?: string; now?: number } = {},
    ) => {
      const text = input.raw ?? JSON.stringify(body)
      const path = `/internal/v1/${action}`
      const signed = await signInternal(INTERNAL_SECRET, {
        method: input.method ?? "POST",
        path,
        body: text,
        now: input.now ?? clock.now,
      })
      const response = await handleRequest(
        new Request(`https://relay.example${path}`, {
          method: input.method ?? "POST",
          headers: { "content-type": "application/json", ...signed, ...input.headers },
          ...(input.method === "GET" ? {} : { body: text }),
        }),
        env,
        runtime,
      )
      return { status: response.status, body: (await response.json()) as Record<string, unknown>, signed }
    }
    // A computer of `sub` through the Worker's connect path, so that account's object knows its account.
    const computer = async (sub: string) => {
      const iat = Math.floor(clock.now / 1000)
      const ticket = await signTicket(
        {
          v: 1,
          aud: "vector-relay",
          sub,
          role: "computer",
          dev: deviceId(),
          computers: 3,
          rank: 2,
          epoch: EPOCH,
          periodEnd: NOW + 86_400_000,
          iat,
          exp: iat + 300,
          jti: token(),
        },
        keys.privateKey,
      )
      const response = (await handleRequest(
        new Request("https://relay.example/v1/connect", {
          headers: { upgrade: "websocket", "sec-websocket-protocol": `vector.v1, ${ticket}` },
        }),
        env,
        runtime,
      )) as UpgradeResponse
      return runtime.servers.get(response.webSocket!) as FakeSocket
    }
    return { call, computer, namespace, kv, clock, env, runtime }
  }

  test("a signed call reaches the account's object, named by the account's HMAC", async () => {
    const { call, namespace } = await worker()
    const result = await call("presence", { account: ACCOUNT })
    expect(result).toMatchObject({ status: 200, body: { online: false, computers: [], viewers: 0 } })
    expect(namespace.calls.map((entry) => entry.name)).toEqual([(await accountHandle(ACCOUNT_KEY, ACCOUNT))!])
    // The object gets the nonce, not the signature, and never the account in its name.
    expect(namespace.calls[0]!.headers.get("x-vector-relay-nonce")).toBe(result.signed[INTERNAL_HEADERS.nonce]!)
    expect(namespace.calls[0]!.headers.get(INTERNAL_HEADERS.signature)).toBeNull()
  })

  test("an absent or understated length stops at the body cap and cancels without reaching an object", async () => {
    for (const length of [undefined, "1"]) {
      const { env, runtime, namespace } = await worker()
      const stream = { pulled: 0, cancelled: 0 }
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (stream.pulled === 1024) return controller.close()
            stream.pulled++
            controller.enqueue(new Uint8Array(1024))
          },
          cancel() {
            stream.cancelled++
          },
        },
        { highWaterMark: 0 },
      )
      const response = await handleRequest(
        new Request(`https://relay.example${PATH}`, {
          method: "POST",
          headers: length ? { "content-length": length } : {},
          body,
        }),
        env,
        runtime,
      )
      expect(response.status).toBe(413)
      expect(stream).toEqual({ pulled: RELAY_LIMITS.internalBodyBytes / 1024 + 1, cancelled: 1 })
      expect(namespace.calls).toEqual([])
    }
  })

  test("one oversized chunk is refused even if cancelling its open stream never settles", async () => {
    const { env, runtime, namespace } = await worker()
    const cancellation = Promise.withResolvers<void>()
    let cancelled = false
    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          controller.enqueue(new Uint8Array(RELAY_LIMITS.internalBodyBytes * 64))
        },
        cancel() {
          cancelled = true
          return cancellation.promise
        },
      },
      { highWaterMark: 0 },
    )
    try {
      const response = await handleRequest(
        new Request(`https://relay.example${PATH}`, { method: "POST", body }),
        env,
        runtime,
      )
      expect(response.status).toBe(413)
      expect(cancelled).toBe(true)
      expect(namespace.calls).toEqual([])
    } finally {
      cancellation.resolve()
    }
  }, 1000)

  test("a streamed signed body of exactly the byte limit keeps its raw HMAC bytes", async () => {
    const { env, runtime, namespace } = await worker()
    const json = JSON.stringify({ account: ACCOUNT, note: "é" })
    const text = json + " ".repeat(RELAY_LIMITS.internalBodyBytes - utf8(json).byteLength)
    const signed = await headersFor(text)
    const bytes = utf8(text)
    let offset = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.byteLength) return controller.close()
        const end = Math.min(offset + 1024, bytes.byteLength)
        controller.enqueue(bytes.subarray(offset, end))
        offset = end
      },
    })
    const response = await handleRequest(
      new Request(`https://relay.example${PATH}`, { method: "POST", headers: signed, body }),
      env,
      runtime,
    )
    expect(response.status).toBe(200)
    expect(namespace.calls).toHaveLength(1)
    expect(namespace.calls[0]!.headers.get("x-vector-relay-nonce")).toBe(signed[INTERNAL_HEADERS.nonce]!)
  })

  test("a failed body read is refused before signature or object state", async () => {
    const { env, runtime, namespace } = await worker()
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("fixture body read failure"))
      },
    })
    const response = await handleRequest(
      new Request(`https://relay.example${PATH}`, { method: "POST", body }),
      env,
      runtime,
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: { code: "INTERNAL_BAD_REQUEST" } })
    expect(namespace.calls).toEqual([])
  })

  test("method, action, secret and declared-size guards still reject before reading a body", async () => {
    for (const input of [
      { method: "PUT", action: "presence", status: 405 },
      { method: "POST", action: "unknown", status: 404 },
      { method: "POST", action: "presence", secret: "", status: 503 },
      { method: "POST", action: "presence", length: String(RELAY_LIMITS.internalBodyBytes + 1), status: 413 },
    ]) {
      const { env, runtime, namespace } = await worker({ secret: input.secret })
      let pulled = 0
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulled++
            controller.error(new Error("early guards must not read the body"))
          },
        },
        { highWaterMark: 0 },
      )
      const response = await handleRequest(
        new Request(`https://relay.example/internal/v1/${input.action}`, {
          method: input.method,
          headers: input.length ? { "content-length": input.length } : {},
          body,
        }),
        env,
        runtime,
      )
      expect(response.status).toBe(input.status)
      expect(pulled).toBe(0)
      expect(namespace.calls).toEqual([])
    }
  })

  test("an oversized body consumes no nonce before a later valid signed request", async () => {
    const { env, runtime, namespace } = await worker()
    const text = JSON.stringify({ account: ACCOUNT })
    const signed = await headersFor(text, { nonce: "z".repeat(22) })
    const oversized = await handleRequest(
      new Request(`https://relay.example${PATH}`, {
        method: "POST",
        headers: signed,
        body: new Uint8Array(RELAY_LIMITS.internalBodyBytes + 1),
      }),
      env,
      runtime,
    )
    expect(oversized.status).toBe(413)
    expect(namespace.calls).toEqual([])
    const valid = await handleRequest(
      new Request(`https://relay.example${PATH}`, { method: "POST", headers: signed, body: text }),
      env,
      runtime,
    )
    expect(valid.status).toBe(200)
    expect(namespace.calls).toHaveLength(1)
  })

  test("unsigned, badly signed or replayed calls are refused", async () => {
    const { call, env, runtime, namespace } = await worker()
    const forged = await call(
      "presence",
      { account: ACCOUNT },
      { headers: { [INTERNAL_HEADERS.signature]: "A".repeat(43) } },
    )
    expect(forged.status).toBe(401)
    const missing = await handleRequest(
      new Request("https://relay.example/internal/v1/presence", {
        method: "POST",
        body: JSON.stringify({ account: ACCOUNT }),
      }),
      env,
      runtime,
    )
    expect(missing.status).toBe(401)
    expect(namespace.calls).toHaveLength(0)
    const body = JSON.stringify({ account: ACCOUNT })
    const first = await call("kill", null, { raw: body })
    expect(first.status).toBe(200)
    // The same signed request again, inside the skew window: the object has seen its nonce.
    const again = await handleRequest(
      new Request("https://relay.example/internal/v1/kill", { method: "POST", headers: first.signed, body }),
      env,
      runtime,
    )
    expect(again.status).toBe(401)
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe("INTERNAL_SIGNATURE_INVALID")
  })

  test("job-offer is a signed internal action: unsigned, forged or replayed offers answer 401", async () => {
    const { call, env, runtime, namespace } = await worker()
    const body = JSON.stringify({ account: ACCOUNT, offer: OFFER() })
    const unsigned = await handleRequest(
      new Request("https://relay.example/internal/v1/job-offer", { method: "POST", body }),
      env,
      runtime,
    )
    expect(unsigned.status).toBe(401)
    const forged = await call("job-offer", null, {
      raw: body,
      headers: { [INTERNAL_HEADERS.signature]: "A".repeat(43) },
    })
    expect(forged.status).toBe(401)
    expect(namespace.calls).toHaveLength(0)
    const first = await call("job-offer", null, { raw: body })
    expect({ status: first.status, body: first.body }).toEqual({ status: 200, body: { delivered: 0 } })
    // The same signed request again, inside the skew window: the object has seen its nonce.
    const again = await handleRequest(
      new Request("https://relay.example/internal/v1/job-offer", { method: "POST", headers: first.signed, body }),
      env,
      runtime,
    )
    expect(again.status).toBe(401)
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe("INTERNAL_SIGNATURE_INVALID")
  })

  test("the hourly offer cap is per account: the 31st offer to one account answers 429 RELAY_OFFER_LIMIT", async () => {
    const { call, computer, namespace } = await worker()
    const first = await computer(ACCOUNT)
    const second = await computer("acct_fixture_0002")
    const send = async (account: string) => {
      const result = await call("job-offer", { account, offer: OFFER() })
      return { status: result.status, body: result.body }
    }
    for (let index = 0; index < RELAY_LIMITS.offersPerHour; index++)
      expect(await send(ACCOUNT)).toEqual({ status: 200, body: { delivered: 1 } })
    expect(await send(ACCOUNT)).toEqual({ status: 429, body: { error: { code: "RELAY_OFFER_LIMIT" } } })
    expect(await send("acct_fixture_0002")).toEqual({ status: 200, body: { delivered: 1 } })
    expect(first.frames()).toHaveLength(RELAY_LIMITS.offersPerHour)
    expect(second.frames()).toHaveLength(1)
    expect(new Set(namespace.calls.map((entry) => entry.name))).toEqual(
      new Set([(await accountHandle(ACCOUNT_KEY, ACCOUNT))!, (await accountHandle(ACCOUNT_KEY, "acct_fixture_0002"))!]),
    )
  })

  test("other methods, unknown actions, bad bodies and an unset secret are refused", async () => {
    const { call } = await worker()
    expect((await call("presence", null, { method: "GET" })).status).toBe(405)
    expect((await call("everything", { account: ACCOUNT })).status).toBe(404)
    expect((await call("presence", {})).status).toBe(400)
    expect((await call("presence", { account: "has space" })).status).toBe(400)
    expect((await call("presence", null, { raw: "not json" })).status).toBe(400)
    expect((await call("presence", null, { raw: "[1]" })).status).toBe(400)
    expect((await call("presence", { account: ACCOUNT, pad: "x".repeat(17_000) })).status).toBe(413)
    expect((await (await worker({ secret: "too-short" })).call("presence", { account: ACCOUNT })).status).toBe(503)
    expect((await (await worker({ secret: "" })).call("presence", { account: ACCOUNT })).status).toBe(503)
  })

  for (const kill of [true, false])
    test(`a delayed signed flag cannot undo the newer ${kill ? "kill" : "clear"}, including after restart`, async () => {
      const h = await worker()
      expect(await h.call("flags", { kill }, { now: NOW + 1000 })).toMatchObject({ status: 200, body: { kill } })
      const object = h.namespace.objects.get("control")!
      object.relay = new AccountRelay(object.state, h.env, h.runtime)
      expect(await h.call("flags", { kill: !kill }, { now: NOW })).toMatchObject({
        status: 200,
        body: { kill, applied: false },
      })
      expect(h.kv.values.get("kill") ?? null).toBe(kill ? "1" : null)
      // Equal whole-second signatures deliberately follow arrival order, with the old {kill} response.
      expect(await h.call("flags", { kill: !kill }, { now: NOW + 1000 })).toMatchObject({
        status: 200,
        body: { kill: !kill },
      })
      expect(h.kv.values.get("kill") ?? null).toBe(kill ? null : "1")
    })

  test("only the HMAC-verified timestamp reaches the flag object, never an external forward header", async () => {
    const h = await worker()
    const result = await h.call(
      "flags",
      { kill: true },
      {
        now: NOW + 1000,
        headers: { "x-vector-relay-signed-at": String(NOW + 290_000) },
      },
    )
    expect(result.status).toBe(200)
    expect(h.namespace.calls[0]!.headers.get("x-vector-relay-signed-at")).toBe(String(NOW + 1000))
    expect(await h.call("flags", { kill: false }, { now: NOW + 2000 })).toMatchObject({
      status: 200,
      body: { kill: false },
    })
    const count = h.namespace.calls.length
    expect(
      (
        await h.call(
          "flags",
          { kill: true },
          {
            headers: {
              "x-vector-relay-signed-at": String(NOW + 290_000),
              [INTERNAL_HEADERS.signature]: "A".repeat(43),
            },
          },
        )
      ).status,
    ).toBe(401)
    expect(h.namespace.calls).toHaveLength(count)
    expect(h.kv.values.has("kill")).toBe(false)
  })

  for (const kill of [true, false])
    test(`equal-stamp flag arrival order survives a delayed first body decode (${kill})`, async () => {
      const h = await worker()
      expect((await h.call("flags", { kill: false }, { now: NOW - 1000 })).status).toBe(200)
      const relay = h.namespace.objects.get("control")!.relay
      const fetch = relay.fetch.bind(relay)
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const arrived = Promise.withResolvers<void>()
      let arrivals = 0
      let secondDecoded = false
      relay.fetch = (request) => {
        const arrival = ++arrivals
        const json = request.json.bind(request)
        request.json = async () => {
          if (arrival === 1) {
            entered.resolve()
            await release.promise
          } else secondDecoded = true
          return json()
        }
        const operation = fetch(request)
        if (arrival === 2) arrived.resolve()
        return operation
      }
      const first = h.call("flags", { kill }, { now: NOW })
      await entered.promise
      const second = h.call("flags", { kill: !kill }, { now: NOW })
      try {
        await arrived.promise
        expect(secondDecoded).toBe(false)
      } finally {
        release.resolve()
      }
      expect((await first).status).toBe(200)
      expect((await second).status).toBe(200)
      expect(secondDecoded).toBe(true)
      expect(h.kv.values.get("kill") ?? null).toBe(kill ? null : "1")
    })

  for (const kill of [true, false])
    test(`overlapping flag writes keep KV in arrival order when ${kill ? "put" : "delete"} waits`, async () => {
      const h = await worker()
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const writes: boolean[] = []
      const snapshots: unknown[] = []
      const mutate = async (value: boolean) => {
        writes.push(value)
        const rows = h.namespace.objects
          .get("control")!
          .state.sql.rows<{ v: string }>("SELECT v FROM meta WHERE k = ?", "flags")
        snapshots.push(rows.length ? JSON.parse(rows[0]!.v) : undefined)
        if (writes.length === 1) {
          entered.resolve()
          await release.promise
        }
        if (value) h.kv.values.set("kill", "1")
        else h.kv.values.delete("kill")
      }
      h.kv.put = async () => mutate(true)
      h.kv.delete = async () => mutate(false)
      const first = h.call("flags", { kill }, { now: NOW })
      await entered.promise
      // Observe the second arrival at the real object; it must not decode or write while KV is held.
      const arrived = Promise.withResolvers<void>()
      let secondDecoded = false
      const relay = h.namespace.objects.get("control")!.relay
      const fetch = relay.fetch.bind(relay)
      relay.fetch = (request) => {
        const json = request.json.bind(request)
        request.json = () => {
          secondDecoded = true
          return json()
        }
        const operation = fetch(request)
        arrived.resolve()
        return operation
      }
      const second = h.call("flags", { kill: !kill }, { now: NOW + 1000 })
      try {
        await arrived.promise
        expect(secondDecoded).toBe(false)
        expect(writes).toEqual([kill])
        expect(snapshots).toEqual([{ kill, signedAt: NOW, confirmed: false }])
      } finally {
        release.resolve()
      }
      expect((await first).status).toBe(200)
      expect((await second).status).toBe(200)
      expect(writes).toEqual([kill, !kill])
      expect(snapshots).toEqual([
        { kill, signedAt: NOW, confirmed: false },
        { kill: !kill, signedAt: NOW + 1000, confirmed: false },
      ])
      expect(h.kv.values.get("kill") ?? null).toBe(kill ? null : "1")
    })

  for (const kill of [true, false])
    for (const advance of [0, 1000])
      for (const restart of [false, true])
        test(`an unconfirmed ${kill ? "kill" : "clear"} fences stale calls and permits ${advance ? "newer" : "same-stamp"} reapply ${restart ? "after restart" : "without restart"}`, async () => {
          const h = await worker()
          const writes: boolean[] = []
          let failing = true
          const mutate = async (value: boolean) => {
            writes.push(value)
            if (value) h.kv.values.set("kill", "1")
            else h.kv.values.delete("kill")
            if (failing) throw new Error("fixture lost KV reply")
          }
          h.kv.put = async () => mutate(true)
          h.kv.delete = async () => mutate(false)
          expect(await h.call("flags", { kill }, { now: NOW + 1000 })).toMatchObject({
            status: 503,
            body: { error: { code: "INTERNAL_UNAVAILABLE" } },
          })
          const object = h.namespace.objects.get("control")!
          if (restart) object.relay = new AccountRelay(object.state, h.env, h.runtime)
          expect((await h.call("flags", { kill: !kill }, { now: NOW })).status).toBe(503)
          expect(writes).toEqual([kill])
          failing = false
          expect(await h.call("flags", { kill }, { now: NOW + 1000 + advance })).toMatchObject({
            status: 200,
            body: { kill },
          })
          expect(writes).toEqual([kill, kill])
          expect(await h.call("flags", { kill: !kill }, { now: NOW })).toMatchObject({
            status: 200,
            body: { kill, applied: false },
          })
          expect(h.kv.values.get("kill") ?? null).toBe(kill ? "1" : null)
        })

  test("malformed durable flag metadata refuses without resetting the fence or writing KV", async () => {
    const h = await worker()
    expect((await h.call("flags", { kill: true })).status).toBe(200)
    const state = h.namespace.objects.get("control")!.state
    let writes = 0
    h.kv.put = async () => {
      writes++
    }
    h.kv.delete = async () => {
      writes++
    }
    for (const raw of [
      "not json",
      "null",
      JSON.stringify({ kill: true, signedAt: NOW }),
      JSON.stringify({ kill: true, signedAt: NOW + 0.5, confirmed: true }),
      JSON.stringify({ kill: true, signedAt: -1000, confirmed: true }),
      JSON.stringify({ kill: true, signedAt: NOW, confirmed: "true" }),
    ]) {
      state.sql.exec("UPDATE meta SET v = ? WHERE k = ?", raw, "flags")
      expect((await h.call("flags", { kill: false }, { now: NOW + 2000 })).status).toBe(503)
      expect(state.sql.rows("SELECT v FROM meta WHERE k = ?", "flags")).toEqual([{ v: raw }])
      expect(h.kv.values.get("kill")).toBe("1")
      expect(writes).toBe(0)
    }
  })

  test("the kill flag is written through a control object, not an account's", async () => {
    const { call, namespace, kv } = await worker()
    expect(await call("flags", { kill: true })).toMatchObject({ status: 200, body: { kill: true } })
    expect(kv.values.get("kill")).toBe("1")
    expect(await call("flags", { kill: false })).toMatchObject({ status: 200, body: { kill: false } })
    expect(kv.values.has("kill")).toBe(false)
    expect(new Set(namespace.calls.map((entry) => entry.name))).toEqual(new Set(["control"]))
    expect((await call("flags", { kill: "yes" })).status).toBe(400)
  })
})

describe("presence honours the kill flag and the suspension (R-C4)", () => {
  // The API's signed presence call through the real Worker to the account's object, the path relayPresence takes.
  const presence = (h: Harness) => viaWorker(h, "presence", { account: ACCOUNT })

  test("the kill flag: no computer is online while an idle computer's socket is still open", async () => {
    const h = await Harness.create()
    const computer = await h.computer({ name: "Studio" })
    h.kv.values.set("kill", "1")
    expect(await presence(h)).toEqual({
      status: 200,
      body: { online: false, computers: [], viewers: 0, reason: "killed" },
    })
    // The scenario's precondition: the socket is still open and, with no viewer, no alarm runs, so this is the
    // hibernating idle computer that meets the flag only at its next refresh. Before R-C4 presence said online here.
    expect(computer.socket.readyState).toBe(1)
    expect(computer.socket.closed).toBeUndefined()
    expect(h.state.alarm).toBeNull()
    h.kv.values.delete("kill")
    expect((await presence(h)).body).toEqual({
      online: true,
      computers: [{ device: computer.dev, name: "Studio" }],
      viewers: 0,
    })
  })

  test("an unreadable kill flag counts as set", async () => {
    const h = await Harness.create()
    const computer = await h.computer({ name: "Studio" })
    await h.phone()
    h.kv.failing = true
    const reads = h.kv.reads
    expect(await presence(h)).toEqual({
      status: 200,
      body: { online: false, computers: [], viewers: 1, reason: "killed" },
    })
    // The object reads the flag once; the Worker's internal route reads none.
    expect(h.kv.reads).toBe(reads + 1)
    expect(computer.socket.closed).toBeUndefined()
  })

  test("a suspended account: offline with the suspension as the reason, until it is lifted", async () => {
    const h = await Harness.create()
    const computer = await h.computer({ name: "Studio" })
    const at = h.clock.now
    expect((await h.internal("suspend", { account: ACCOUNT, suspended: true, reason: "owner", at })).status).toBe(200)
    // The suspend route closes every socket (and the internal path's sweep closes any left while the suspension is
    // stored, and connect refuses one), so a live computer cannot meet a stored suspension. The `reason` is what
    // tells the explicit check apart from those closes.
    expect(computer.socket.closed?.code).toBe(CLOSE.REMOTE_PAUSED)
    expect(await presence(h)).toEqual({
      status: 200,
      body: { online: false, computers: [], viewers: 0, reason: "suspended" },
    })
    // An unreadable flag on top of the suspension is offline too; which reason wins is not pinned.
    h.kv.failing = true
    expect((await presence(h)).body.online).toBe(false)
    h.kv.failing = false
    expect((await h.internal("suspend", { account: ACCOUNT, suspended: false, at: at + 1 })).status).toBe(200)
    const again = await h.computer({ name: "Studio", dev: computer.dev })
    expect(again.socket.closed).toBeUndefined()
    expect((await presence(h)).body).toEqual({
      online: true,
      computers: [{ device: computer.dev, name: "Studio" }],
      viewers: 0,
    })
  })

  test("with no flag and no suspension, presence is unchanged", async () => {
    const h = await Harness.create()
    const computer = await h.computer({ name: "Studio" })
    await h.phone()
    const reads = h.kv.reads
    expect(await presence(h)).toEqual({
      status: 200,
      body: { online: true, computers: [{ device: computer.dev, name: "Studio" }], viewers: 1 },
    })
    expect(h.kv.reads).toBe(reads + 1)
    await h.disconnect(computer.socket)
    // Offline for want of a computer carries no reason.
    expect((await presence(h)).body).toEqual({ online: false, computers: [], viewers: 1 })
  })
})

describe("job offers reach the account's computers (R-C1)", () => {
  const offer = (h: Harness, text: unknown) => viaWorker(h, "job-offer", { account: ACCOUNT, offer: text })
  const offers = (h: Harness) => h.state.sql.rows<{ v: string }>("SELECT v FROM meta WHERE k = 'offers'")

  test("an offer reaches every live computer, never a phone, byte for byte; only its time is kept", async () => {
    const h = await Harness.create()
    const first = await h.computer()
    const second = await h.computer()
    const phone = await h.phone()
    const text = OFFER()
    expect(await offer(h, text)).toEqual({ status: 200, body: { delivered: 2 } })
    for (const computer of [first, second]) {
      const frames = computer.socket.frames()
      expect(frames).toHaveLength(1)
      expect(frames[0]!.byteLength).toBe(1 + DEVICE_BYTES + text.length)
      const decoded = decodeFrame(frames[0]!)!
      expect(decoded.kind).toBe(FRAME.JOB_OFFER)
      expect(decoded.device).toEqual(new Uint8Array(DEVICE_BYTES))
      expect(fromUtf8(decoded.ciphertext)).toBe(text)
    }
    expect(phone.socket.frames()).toHaveLength(0)
    // Storage keeps the offer's time and nothing of the offer or the account.
    expect(offers(h)).toEqual([{ v: JSON.stringify([h.clock.now]) }])
    const [, payload, signature] = text.split(".")
    const stored = JSON.stringify(h.state.sql.tables().map((table) => h.state.sql.rows(`SELECT * FROM ${table}`)))
    for (const needle of [payload!, signature!, ACCOUNT]) {
      expect(stored).not.toContain(needle)
      for (const entry of h.state.entries)
        expect(JSON.stringify(entry.socket.deserializeAttachment())).not.toContain(needle)
    }
  })

  test("with no phone: no alarm, viewer time or NO_VIEWER place; a lapsed ticket receives; awake time", async () => {
    const h = await Harness.create()
    const computer = await h.computer()
    for (let index = 0; index < RELAY_LIMITS.noViewerFrames; index++)
      expect(await offer(h, OFFER())).toEqual({ status: 200, body: { delivered: 1 } })
    expect(computer.socket.frames()).toHaveLength(RELAY_LIMITS.noViewerFrames)
    expect(computer.socket.readyState).toBe(1)
    expect(computer.socket.closed).toBeUndefined()
    expect(h.state.alarm).toBeNull()
    expect(h.meter("viewer")).toBe(0)
    expect(h.state.sql.rows("SELECT v FROM meta WHERE k = 'viewing_since'")).toEqual([])
    // The offers took no NO_VIEWER place: this data frame with no viewer is the first, so it gets a notice and the
    // computer stays open (twenty offers plus it would have closed it).
    await h.message(computer.socket, frame(FRAME.DATA, deviceId(), new Uint8Array([1])))
    expect(computer.socket.last("error")).toEqual({ t: "error", code: "no-viewer" })
    expect(computer.socket.closed).toBeUndefined()
    // Awake time pins fetch's existing touch for internal calls (R-C1: offers count toward awake time), not
    // offer-specific code. Connecting wrote the meters at NOW and every call since came at NOW, so nothing is pending
    // here; six minutes on, the next call adds one idle tail and writes it.
    const before = h.meter("awake")
    await h.run(6 * 60_000)
    expect((computer.socket.deserializeAttachment() as { exp: number }).exp * 1000).toBeLessThan(h.clock.now)
    expect(await offer(h, OFFER())).toEqual({ status: 200, body: { delivered: 1 } })
    expect(computer.socket.frames()).toHaveLength(RELAY_LIMITS.noViewerFrames + 1)
    expect(h.meter("awake")).toBe(before + RELAY_LIMITS.idleTailMs)
  })

  test("the kill flag, set or unreadable, sends nothing and closes nothing", async () => {
    const h = await Harness.create()
    const computer = await h.computer()
    const phone = await h.phone()
    h.kv.values.set("kill", "1")
    expect(await offer(h, OFFER())).toEqual({ status: 200, body: { delivered: 0, reason: "killed" } })
    h.kv.values.delete("kill")
    h.kv.failing = true
    expect(await offer(h, OFFER())).toEqual({ status: 200, body: { delivered: 0, reason: "killed" } })
    expect(computer.socket.frames()).toHaveLength(0)
    expect(phone.socket.frames()).toHaveLength(0)
    expect(computer.socket.readyState).toBe(1)
    expect(computer.socket.closed).toBeUndefined()
    h.kv.failing = false
    expect(await offer(h, OFFER())).toEqual({ status: 200, body: { delivered: 1 } })
    expect(computer.socket.frames()).toHaveLength(1)
  })

  test("a suspended account gets no offer until the suspension is lifted", async () => {
    const h = await Harness.create()
    const computer = await h.computer()
    const at = h.clock.now
    expect((await h.internal("suspend", { account: ACCOUNT, suspended: true, reason: "owner", at })).status).toBe(200)
    expect(computer.socket.closed?.code).toBe(CLOSE.REMOTE_PAUSED)
    expect(await offer(h, OFFER())).toEqual({ status: 200, body: { delivered: 0, reason: "suspended" } })
    expect(computer.socket.frames()).toHaveLength(0)
    expect((await h.internal("suspend", { account: ACCOUNT, suspended: false, at: at + 1 })).status).toBe(200)
    const again = await h.computer({ dev: computer.dev })
    expect(await offer(h, OFFER())).toEqual({ status: 200, body: { delivered: 1 } })
    expect(again.socket.frames()).toHaveLength(1)
  })

  test("at most 30 offers in a sliding hour, kept across hibernation; refused offers take no place", async () => {
    const h = await Harness.create()
    const computer = await h.computer()
    // Straight to the object: h.wake() replaces the instance, and the Worker's fake namespace keeps the first one.
    const send = (text: unknown) => h.internal("job-offer", { account: ACCOUNT, offer: text })
    h.kv.values.set("kill", "1")
    for (let index = 0; index < 3; index++)
      expect(await send(OFFER())).toEqual({ status: 200, body: { delivered: 0, reason: "killed" } })
    h.kv.values.delete("kill")
    expect((await send("vef1.a b")).status).toBe(400)
    expect((await send(42)).status).toBe(400)
    for (let index = 0; index < RELAY_LIMITS.offersPerHour; index++)
      expect(await send(OFFER())).toEqual({ status: 200, body: { delivered: 1 } })
    h.wake()
    expect(await send(OFFER())).toEqual({ status: 429, body: { error: { code: "RELAY_OFFER_LIMIT" } } })
    expect(computer.socket.frames()).toHaveLength(RELAY_LIMITS.offersPerHour)
    await h.run(RELAY_LIMITS.offerWindowMs - 1)
    expect((await send(OFFER())).status).toBe(429)
    h.wake()
    await h.run(1)
    expect(await send(OFFER())).toEqual({ status: 200, body: { delivered: 1 } })
    expect(computer.socket.frames()).toHaveLength(RELAY_LIMITS.offersPerHour + 1)
    expect(computer.socket.closed).toBeUndefined()
  })

  test("malformed offers answer 400, send nothing and take no place", async () => {
    const h = await Harness.create()
    const computer = await h.computer()
    const refused = { status: 400, body: { error: { code: "INTERNAL_BAD_REQUEST" } } }
    for (const text of [
      undefined,
      42,
      ["vef1.x"],
      "",
      "vef2.abc",
      "vef1.",
      "vef1.a b",
      "vef1.\u00e9",
      "vef1.a\n",
      " vef1.a",
    ])
      expect(await offer(h, text)).toEqual(refused)
    // Longer than any internal body, so the Worker would answer 413 first: this one goes straight to the object.
    const long = `vef1.${"A".repeat(RELAY_LIMITS.internalBodyBytes)}`
    expect(await h.internal("job-offer", { account: ACCOUNT, offer: long })).toEqual(refused)
    // No account: the Worker refuses before any object.
    expect(await viaWorker(h, "job-offer", { offer: OFFER() })).toEqual(refused)
    expect(computer.socket.frames()).toHaveLength(0)
    expect(offers(h)).toEqual([])
  })

  test("an object that knows no account (never connected, or erased) sends nothing and stores no offer", async () => {
    const h = await Harness.create()
    expect(await offer(h, OFFER())).toEqual({ status: 200, body: { delivered: 0 } })
    expect(offers(h)).toEqual([])
    const computer = await h.computer()
    expect(await offer(h, OFFER())).toEqual({ status: 200, body: { delivered: 1 } })
    expect(offers(h)).toHaveLength(1)
    expect((await h.internal("erase", { account: ACCOUNT })).body).toEqual({ erased: true })
    expect(computer.socket.closed?.code).toBe(CLOSE.REMOTE_REVOKED)
    expect(await offer(h, OFFER())).toEqual({ status: 200, body: { delivered: 0 } })
    expect(computer.socket.frames()).toHaveLength(1)
    // What erase left (the revocation time, the used ids) is all there is: no offer time came back.
    expect(h.state.sql.rows("SELECT k FROM meta")).toEqual([{ k: "revoked_before" }])
    expect(h.state.sql.rows("SELECT * FROM meters")).toEqual([])
  })

  test("a computer cannot inject an offer: a 0x02 frame it sends reaches no other computer and no phone", async () => {
    const h = await Harness.create()
    const sender = await h.computer()
    const other = await h.computer()
    const phone = await h.phone()
    const forged = utf8(OFFER())
    await h.message(sender.socket, frame(FRAME.JOB_OFFER, other.dev, forged))
    h.advance(1500)
    await h.message(sender.socket, frame(FRAME.JOB_OFFER, phone.dev, forged))
    h.advance(1500)
    // The exact shape of a relay-sent offer frame: sixteen zero device bytes.
    await h.message(sender.socket, encodeFrame(FRAME.JOB_OFFER, new Uint8Array(DEVICE_BYTES), forged))
    expect(other.socket.frames()).toHaveLength(0)
    expect(phone.socket.frames()).toHaveLength(0)
    expect(sender.socket.messages().filter((message) => message.t === "error")).toEqual([
      { t: "error", code: "reserved" },
      { t: "error", code: "reserved" },
      { t: "error", code: "reserved" },
    ])
    expect(sender.socket.closed).toBeUndefined()
  })
})
