import { describe, expect, test } from "bun:test"
import { AccountRelay } from "../src/account-relay"
import { handleRequest } from "../src/index"
import { INTERNAL_HEADERS, internalCanonical, sha256Hex, signInternal, verifyInternalSignature } from "../src/internal"
import { utf8 } from "../src/bytes"
import { accountHandle } from "../src/ticket"
import {
  ACCOUNT,
  ACCOUNT_KEY,
  INTERNAL_SECRET,
  NOW,
  FakeKV,
  FakeNamespace,
  FakeRuntime,
  type FakeState,
  ticketKeys,
} from "./fakes"

// WP A39: the API's calls to the relay (kill, suspend, presence, devices, revoke, erase, the kill flag) carry WP A37's
// HMAC: the service, method, path, timestamp, nonce and a hash of the body, 300 s of skew, each nonce once.
// test/remote-relay-contract.test.ts at the repository root checks the same bytes against the API's own signer.

const PATH = "/internal/v1/presence"

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
  return verifyInternalSignature(
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
    expect(await check(body, headers)).toEqual({ ok: true, nonce: "a".repeat(22) })
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
      input: { headers?: Record<string, string>; method?: string; raw?: string } = {},
    ) => {
      const text = input.raw ?? JSON.stringify(body)
      const path = `/internal/v1/${action}`
      const signed = await signInternal(INTERNAL_SECRET, {
        method: input.method ?? "POST",
        path,
        body: text,
        now: clock.now,
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
    return { call, namespace, kv, clock, env, runtime }
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

  test("job.offer is reserved: a signed offer answers 501 and reaches no object", async () => {
    const { call, namespace } = await worker()
    const result = await call("job-offer", { account: ACCOUNT })
    expect(result).toMatchObject({ status: 501, body: { error: { code: "RELAY_JOB_OFFER_RESERVED" } } })
    expect(namespace.calls).toHaveLength(0)
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
