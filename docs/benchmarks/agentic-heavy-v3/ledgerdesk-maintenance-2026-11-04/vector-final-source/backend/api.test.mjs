import test from "node:test"
import assert from "node:assert/strict"
import { once } from "node:events"
import { createServer, request as httpRequest } from "node:http"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createHandler } from "./api.mjs"
import { openStore } from "./store.mjs"

const runtime = process.env.DATA_DIR || join(tmpdir(), "ledgerdesk-api-tests")
const appPath = fileURLToPath(new URL("../app.mjs", import.meta.url))
const plan = { baseCents: 100, includedUnits: 10, unitCents: 3 }

function directory() {
  mkdirSync(runtime, { recursive: true })
  return mkdtempSync(join(runtime, "api-test-"))
}

async function closeServer(server) {
  if (!server?.listening) return
  server.closeAllConnections()
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

async function fixture(t) {
  const dataDirectory = directory()
  let store
  let server
  let baseUrl
  async function start() {
    store = openStore({ directory: dataDirectory })
    server = createServer(createHandler(store))
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    assert.equal(server.address().address, "127.0.0.1")
    baseUrl = `http://127.0.0.1:${server.address().port}`
  }
  await start()
  t.after(async () => {
    await closeServer(server)
    store.close()
    rmSync(dataDirectory, { recursive: true, force: true })
  })
  const api = {
    get store() { return store },
    get server() { return server },
    get baseUrl() { return baseUrl },
    dataDirectory,
    async call(method, path, input, key = "owner-acme", raw = false) {
      const response = await fetch(baseUrl + path, {
        method,
        headers: { ...(key === null ? {} : { authorization: `Bearer ${key}` }), "content-type": "application/json" },
        ...(input === undefined ? {} : { body: raw ? input : JSON.stringify(input) }),
      })
      assert.match(response.headers.get("content-type"), /^application\/json/)
      const value = await response.json()
      if (response.status >= 400) {
        assert.equal(typeof value.error?.code, "string")
        assert.ok(value.error.code.length)
        assert.equal(typeof value.error?.message, "string")
        assert.ok(value.error.message.length)
      }
      return { status: response.status, value }
    },
    async create(name = "Synthetic account", accountPlan = plan, key = "owner-acme") {
      const response = await api.call("POST", "/api/accounts", { name, plan: accountPlan }, key)
      assert.equal(response.status, 201)
      return response.value
    },
    async key(role = "billing", accountIds) {
      const response = await api.call("POST", "/api/access-keys", { role, ...(accountIds ? { accountIds } : {}) })
      assert.equal(response.status, 201)
      return response.value
    },
    async restart() {
      await closeServer(server)
      store.close()
      await start()
    },
  }
  return api
}

async function delayedBody(t, api, path, input, key) {
  const serialized = JSON.stringify(input)
  const incoming = once(api.server, "request")
  let resolveResponse
  let rejectResponse
  const response = new Promise((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject })
  const request = httpRequest(api.baseUrl + path, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "content-length": Buffer.byteLength(serialized) },
  }, (result) => {
    const chunks = []
    result.on("data", (chunk) => chunks.push(chunk))
    result.on("end", () => resolveResponse({ status: result.statusCode, value: JSON.parse(Buffer.concat(chunks).toString()) }))
    result.on("error", rejectResponse)
  })
  request.on("error", rejectResponse)
  t.after(() => request.destroy())
  request.write(serialized.slice(0, 1))
  await incoming
  return { finish() { request.end(serialized.slice(1)); return response } }
}

test("legacy routes, strict objects, authentication, role and workspace isolation", async (t) => {
  const api = await fixture(t)
  assert.deepEqual(await api.call("GET", "/health", undefined, null), { status: 200, value: { ok: true, version: 2 } })
  for (const key of [null, "unknown-synthetic-key"]) {
    assert.equal((await api.call("GET", "/api/accounts", undefined, key)).status, 401)
  }
  for (const raw of ["null", "[]", '"text"', "true", "1", "{", ""]) {
    assert.equal((await api.call("POST", "/api/accounts", raw, "owner-acme", true)).status, 400)
  }
  for (const input of [
    {}, { name: " " , plan }, { name: "x".repeat(201), plan },
    { name: "a", plan: { ...plan, baseCents: -1 } },
    { name: "a", plan: { ...plan, includedUnits: 1.5 } },
    { name: "a", plan: { ...plan, unitCents: Number.MAX_SAFE_INTEGER + 1 } },
    { name: "a", plan: [] },
  ]) assert.equal((await api.call("POST", "/api/accounts", input)).status, 400)
  assert.equal(api.store.snapshot().accounts.length, 0)
  for (const key of ["reader-acme", "billing-acme"]) {
    assert.equal((await api.call("POST", "/api/accounts", { name: "denied", plan }, key)).status, 403)
  }
  const account = await api.create("  Synthetic café  ")
  assert.equal(account.name, "Synthetic café")
  assert.deepEqual(Object.keys(account).sort(), ["id", "name", "plan", "workspaceId"])
  const beta = await api.create("Synthetic beta", plan, "owner-beta")
  assert.deepEqual((await api.call("GET", "/api/accounts", undefined, "reader-acme")).value, [account])
  assert.deepEqual((await api.call("GET", `/api/accounts/${account.id}`, undefined, "billing-acme")).value, account)
  assert.equal((await api.call("GET", `/api/accounts/${beta.id}`)).status, 404)
  assert.equal((await api.call("POST", `/api/accounts/${beta.id}/usage`, { eventId: "x", units: 1, occurredAt: "2026-01-01T00:00:00Z" })).status, 404)
  for (const path of ["/missing", `/api/accounts/${account.id}/missing`]) {
    assert.equal((await api.call("GET", path)).status, 404)
  }
  for (const path of ["/api/accounts/%ZZ", "/api/accounts/%E0%A4%A", "/api/accounts?period=%GG"]) {
    assert.equal((await api.call("GET", path)).status, 400)
  }
})

test("usage exact deduplication, concurrent replay, UTC boundaries and strict dates", async (t) => {
  const api = await fixture(t)
  const account = await api.create()
  const usagePath = `/api/accounts/${account.id}/usage`
  const event = { eventId: "same-event", units: 12, occurredAt: "2024-02-01T00:00:00Z" }
  assert.equal((await api.call("POST", usagePath, event, "reader-acme")).status, 403)
  const attempts = await Promise.all(Array.from({ length: 6 }, () => api.call("POST", usagePath, event, "billing-acme")))
  assert.equal(attempts.filter((item) => item.status === 201).length, 1)
  assert.equal(attempts.filter((item) => item.status === 200).length, 5)
  for (const item of attempts) assert.deepEqual(item.value, attempts[0].value)
  for (const changed of [{ ...event, units: 13 }, { ...event, occurredAt: "2024-02-01T00:00:00+00:00" }]) {
    assert.equal((await api.call("POST", usagePath, changed)).status, 409)
  }
  const invalid = [
    { ...event, eventId: " " }, { ...event, eventId: "x".repeat(201) },
    { ...event, units: 0 }, { ...event, units: -1 }, { ...event, units: 1.1 },
    { ...event, units: Number.MAX_SAFE_INTEGER + 1 },
    ...["2023-02-29T00:00:00Z", "2024-02-30T00:00:00Z", "2024-04-31T00:00:00Z",
      "2024-01-01", "2024-01-01T00:00:00", "2024-13-01T00:00:00Z", "2024-01-01T24:00:00Z",
      "2024-01-01T00:60:00Z", "2024-01-01T00:00:00+24:00", "2024-01-01T00:00:00+01:60"].map((occurredAt) => ({ ...event, occurredAt })),
  ]
  for (const input of invalid) assert.equal((await api.call("POST", usagePath, input)).status, 400, JSON.stringify(input))
  for (const [eventId, occurredAt, units] of [
    ["before", "2024-02-01T00:30:00+01:00", 4],
    ["start-offset", "2024-01-31T23:00:00-01:00", 2],
    ["leap-end", "2024-02-29T23:59:59.999Z", 3],
    ["next", "2024-03-01T00:00:00Z", 8],
  ]) assert.equal((await api.call("POST", usagePath, { eventId, occurredAt, units })).status, 201)
  assert.equal((await api.call("GET", usagePath)).value.length, 5)
  assert.equal((await api.call("GET", usagePath + "?period=2024-02")).value.length, 3)
  assert.deepEqual((await api.call("GET", `/api/accounts/${account.id}/quote?period=2024-02`)).value, {
    accountId: account.id, period: "2024-02", totalUnits: 17, ...plan, overageUnits: 7, totalCents: 121,
  })
  for (const period of ["", "2024-00", "2024-13", "2024-2", "24-02", "2024-02-01"]) {
    for (const action of ["usage", "quote"]) {
      assert.equal((await api.call("GET", `/api/accounts/${account.id}/${action}?period=${period}`)).status, 400)
    }
  }
  assert.equal((await api.call("GET", `/api/accounts/${account.id}/quote`)).status, 400)
  // Four-digit years below 100 must not acquire Date.UTC's 1900 offset.
  assert.equal((await api.call("POST", usagePath, { eventId: "ancient", units: 1, occurredAt: "0001-01-01T00:00:00Z" })).status, 201)
  assert.equal((await api.call("GET", usagePath + "?period=0001-01")).value.length, 1)
  await api.restart()
  assert.equal((await api.call("POST", usagePath, event)).status, 200)
  assert.equal((await api.call("POST", usagePath, { ...event, units: 99 })).status, 409)
})

test("unsafe unit sums, currency products and currency sums fail without issuing", async (t) => {
  const api = await fixture(t)
  for (const [accountPlan, units] of [
    [{ baseCents: 0, includedUnits: 0, unitCents: 0 }, [Number.MAX_SAFE_INTEGER, 1]],
    [{ baseCents: 0, includedUnits: 0, unitCents: Number.MAX_SAFE_INTEGER }, [2]],
    [{ baseCents: Number.MAX_SAFE_INTEGER, includedUnits: 0, unitCents: 1 }, [1]],
  ]) {
    const account = await api.create("Synthetic arithmetic", accountPlan)
    for (const [index, count] of units.entries()) {
      assert.equal((await api.call("POST", `/api/accounts/${account.id}/usage`, {
        eventId: `unsafe-${index}`, units: count, occurredAt: "2026-01-01T00:00:00Z",
      })).status, 201)
    }
    const result = await api.call("GET", `/api/accounts/${account.id}/quote?period=2026-01`)
    assert.equal(result.status, 400)
    assert.equal(result.value.error.code, "unsafe_arithmetic")
    assert.equal((await api.call("POST", `/api/accounts/${account.id}/invoices`, { period: "2026-01", requestId: "unsafe" })).status, 400)
  }
  assert.equal(api.store.snapshot().invoices.length, 0)
  assert.equal(api.store.snapshot().idempotency.length, 0)
})

test("invoice snapshots, replay scopes, conflicting reuse and concurrent uniqueness", async (t) => {
  const api = await fixture(t)
  const account = await api.create()
  const path = `/api/accounts/${account.id}/invoices`
  assert.equal((await api.call("POST", path, { period: "2026-01", requestId: "issue" }, "reader-acme")).status, 403)
  for (const input of [{}, { period: "2026-13", requestId: "x" }, { period: "2026-01", requestId: " " }, { period: "2026-01", requestId: "x".repeat(201) }]) {
    assert.equal((await api.call("POST", path, input)).status, 400)
  }
  const attempts = await Promise.all(Array.from({ length: 5 }, () => api.call("POST", path, { period: "2026-01", requestId: "issue" }, "billing-acme")))
  assert.equal(attempts.filter((item) => item.status === 201).length, 1)
  assert.equal(attempts.filter((item) => item.status === 200).length, 4)
  const issued = attempts[0].value
  assert.equal(issued.status, "issued")
  assert.deepEqual(issued.lines, [
    { kind: "base", quantity: 1, unitCents: 100, amountCents: 100 },
    { kind: "overage", quantity: 0, unitCents: 3, amountCents: 0 },
  ])
  assert.equal(issued.totalCents, issued.lines.reduce((sum, line) => sum + line.amountCents, 0))
  assert.equal(issued.creditedCents, 0)
  assert.equal(issued.balanceCents, 100)
  assert.equal((await api.call("POST", path, { period: "2026-02", requestId: "issue" }, "billing-acme")).status, 409)
  assert.equal((await api.call("POST", path, { period: "2026-01", requestId: "different" }, "billing-acme")).status, 409)
  assert.equal((await api.call("POST", path, { period: "2026-01", requestId: "issue" }, "owner-acme")).status, 409)
  assert.equal((await api.call("GET", `/api/invoices/${issued.id}`, undefined, "owner-beta")).status, 404)
  assert.deepEqual((await api.call("GET", `/api/invoices/${issued.id}`, undefined, "reader-acme")).value, issued)
  const other = await api.create("Other synthetic account")
  assert.equal((await api.call("POST", `/api/accounts/${other.id}/invoices`, { period: "2026-01", requestId: "issue" }, "billing-acme")).status, 201)
  const differentIds = await Promise.all(Array.from({ length: 5 }, (_, index) => api.call("POST", path, { period: "2026-03", requestId: `race-${index}` })))
  assert.equal(differentIds.filter((item) => item.status === 201).length, 1)
  assert.equal(differentIds.filter((item) => item.status === 409).length, 4)
  assert.equal((await api.call("POST", `/api/accounts/${account.id}/usage`, { eventId: "late", units: 30, occurredAt: "2026-01-20T00:00:00Z" })).status, 201)
  assert.equal((await api.call("GET", `/api/accounts/${account.id}/quote?period=2026-01`)).value.totalCents, 160)
  assert.deepEqual((await api.call("GET", `/api/invoices/${issued.id}`)).value, issued)
  await api.restart()
  assert.deepEqual((await api.call("POST", path, { period: "2026-01", requestId: "issue" }, "billing-acme")), { status: 200, value: issued })
})

test("credit normalization, idempotency, atomic racing limits and durable balances", async (t) => {
  const api = await fixture(t)
  const account = await api.create()
  const issued = (await api.call("POST", `/api/accounts/${account.id}/invoices`, { period: "2026-01", requestId: "shared" })).value
  const path = `/api/invoices/${issued.id}/credits`
  for (const input of [{}, { requestId: "x", amountCents: 0, reason: "a" },
    { requestId: "x", amountCents: 1.5, reason: "a" }, { requestId: "x", amountCents: 1, reason: " " },
    { requestId: "x", amountCents: 1, reason: "x".repeat(201) }, { requestId: " ", amountCents: 1, reason: "a" }]) {
    assert.equal((await api.call("POST", path, input)).status, 400)
  }
  assert.equal((await api.call("POST", path, { requestId: "x", amountCents: 1, reason: "a" }, "reader-acme")).status, 403)
  const credit = await api.call("POST", path, { requestId: "shared", amountCents: 20, reason: "  Synthetic adjustment  " })
  assert.equal(credit.status, 201)
  assert.equal(credit.value.reason, "Synthetic adjustment")
  assert.deepEqual(await api.call("POST", path, { requestId: "shared", amountCents: 20, reason: "Synthetic adjustment" }), { status: 200, value: credit.value })
  for (const changed of [{ amountCents: 21, reason: "Synthetic adjustment" }, { amountCents: 20, reason: "Changed" }]) {
    assert.equal((await api.call("POST", path, { requestId: "shared", ...changed })).status, 409)
  }
  // Reusing a failed request ID with valid business input is a new operation.
  assert.equal((await api.call("POST", path, { requestId: "failed", amountCents: 81, reason: "Too much" })).status, 409)
  assert.equal((await api.call("POST", path, { requestId: "failed", amountCents: 10, reason: "Allowed" })).status, 201)
  // A second actor's same request ID does not replay the first actor's credit.
  assert.equal((await api.call("POST", path, { requestId: "shared", amountCents: 10, reason: "Other actor" }, "billing-acme")).status, 201)
  const attempts = await Promise.all(Array.from({ length: 4 }, (_, index) => api.call("POST", path, { requestId: `race-${index}`, amountCents: 40, reason: "Synthetic race" })))
  assert.equal(attempts.filter((item) => item.status === 201).length, 1)
  assert.equal(attempts.filter((item) => item.status === 409).length, 3)
  const credited = (await api.call("GET", `/api/invoices/${issued.id}`)).value
  assert.equal(credited.creditedCents, 80)
  assert.equal(credited.balanceCents, 20)
  for (const property of ["totalUnits", "baseCents", "includedUnits", "unitCents", "overageUnits", "totalCents", "lines"]) {
    assert.deepEqual(credited[property], issued[property])
  }
  assert.equal((await api.call("GET", path, undefined, "reader-acme")).value.length, 4)
  assert.equal((await api.call("GET", path, undefined, "owner-beta")).status, 404)
  assert.equal((await api.call("POST", path, { requestId: "foreign", amountCents: 1, reason: "x" }, "owner-beta")).status, 404)
  const records = api.store.snapshot().idempotency
  assert.equal(records.filter((item) => item.operation === "credit").length, 4)
  await api.restart()
  assert.deepEqual((await api.call("GET", `/api/invoices/${issued.id}`)).value, credited)
  assert.equal((await api.call("POST", path, { requestId: "shared", amountCents: 20, reason: "Synthetic adjustment" })).status, 200)
  assert.equal((await api.call("POST", path, { requestId: "last", amountCents: 20, reason: "Final adjustment" })).status, 201)
  assert.equal((await api.call("POST", path, { requestId: "over", amountCents: 1, reason: "Over" })).status, 409)
  const free = await api.create("Synthetic free account", { baseCents: 0, includedUnits: 0, unitCents: 0 })
  const zero = await api.call("POST", `/api/accounts/${free.id}/invoices`, { period: "2026-01", requestId: "zero" })
  assert.equal(zero.status, 201)
  assert.equal(zero.value.totalCents, 0)
  assert.equal((await api.call("POST", `/api/invoices/${zero.value.id}/credits`, { requestId: "zero", amountCents: 1, reason: "Cannot credit zero" })).status, 409)
})

test("dynamic key public shape, hash-only persistence, account scope and durable revocation", async (t) => {
  const api = await fixture(t)
  const account = await api.create()
  const other = await api.create("Other account")
  const beta = await api.create("Beta account", plan, "owner-beta")
  for (const input of [{ role: "owner" }, { role: "reader", accountIds: [] },
    { role: "billing", accountIds: [account.id, account.id] }, { role: "reader", accountIds: [1] },
    { role: "reader", accountIds: null }]) {
    assert.equal((await api.call("POST", "/api/access-keys", input)).status, 400)
  }
  assert.equal((await api.call("POST", "/api/access-keys", { role: "reader", accountIds: [beta.id] })).status, 404)
  const scoped = await api.key("billing", [account.id])
  const reader = await api.key("reader", [account.id])
  const workspace = await api.key()
  assert.deepEqual(Object.keys(scoped).sort(), ["accountIds", "apiKey", "id", "role"])
  assert.deepEqual(Object.keys(workspace).sort(), ["apiKey", "id", "role"])
  assert.notEqual(scoped.apiKey, workspace.apiKey)
  assert.ok(scoped.apiKey.length >= 32)
  const stored = api.store.snapshot().keys.find((item) => item.id === scoped.id)
  assert.equal(stored.hash, createHash("sha256").update(scoped.apiKey, "utf8").digest("hex"))
  assert.equal(stored.revoked, false)
  assert.equal(Object.hasOwn(stored, "apiKey"), false)
  assert.equal(readFileSync(join(api.dataDirectory, "ledger.json"), "utf8").includes(scoped.apiKey), false)
  assert.deepEqual((await api.call("GET", "/api/accounts", undefined, scoped.apiKey)).value, [account])
  assert.equal((await api.call("GET", "/api/accounts", undefined, workspace.apiKey)).value.length, 2)
  const usage = { eventId: "scoped", units: 2, occurredAt: "2026-01-01T00:00:00Z" }
  assert.equal((await api.call("POST", `/api/accounts/${account.id}/usage`, usage, scoped.apiKey)).status, 201)
  assert.equal((await api.call("POST", `/api/accounts/${account.id}/usage`, { ...usage, eventId: "reader" }, reader.apiKey)).status, 403)
  const mine = (await api.call("POST", `/api/accounts/${account.id}/invoices`, { period: "2026-01", requestId: "scoped" }, scoped.apiKey)).value
  const theirs = (await api.call("POST", `/api/accounts/${other.id}/invoices`, { period: "2026-01", requestId: "other" })).value
  for (const path of [`/api/accounts/${other.id}`, `/api/accounts/${other.id}/usage`, `/api/accounts/${other.id}/quote?period=2026-01`,
    `/api/accounts/${beta.id}`, `/api/invoices/${theirs.id}`, `/api/invoices/${theirs.id}/credits`]) {
    assert.equal((await api.call("GET", path, undefined, scoped.apiKey)).status, 404)
  }
  assert.equal((await api.call("GET", `/api/invoices/${mine.id}`, undefined, reader.apiKey)).status, 200)
  assert.equal((await api.call("POST", `/api/invoices/${theirs.id}/credits`, { requestId: "x", amountCents: 1, reason: "x" }, scoped.apiKey)).status, 404)
  for (const key of [reader.apiKey, scoped.apiKey]) {
    for (const [path, input] of [["/api/accounts", { name: "denied", plan }], ["/api/access-keys", { role: "reader" }], [`/api/access-keys/${scoped.id}/revoke`, {}]]) {
      assert.equal((await api.call("POST", path, input, key)).status, 403)
    }
  }
  await api.restart()
  assert.equal((await api.call("GET", "/api/accounts", undefined, scoped.apiKey)).status, 200)
  const revokePath = `/api/access-keys/${scoped.id}/revoke`
  assert.equal((await api.call("POST", revokePath, {}, "owner-beta")).status, 404)
  assert.equal((await api.call("POST", revokePath, { notEmpty: true })).status, 400)
  assert.deepEqual(await api.call("POST", revokePath, {}), { status: 200, value: { revoked: true } })
  assert.deepEqual(await api.call("POST", revokePath, {}), { status: 200, value: { revoked: true } })
  for (const path of ["/api/accounts", `/api/invoices/${mine.id}`]) assert.equal((await api.call("GET", path, undefined, scoped.apiKey)).status, 401)
  assert.equal((await api.call("POST", `/api/accounts/${account.id}/invoices`, { period: "2026-01", requestId: "scoped" }, scoped.apiKey)).status, 401)
  await api.restart()
  assert.equal((await api.call("GET", "/api/accounts", undefined, scoped.apiKey)).status, 401)
  assert.equal((await api.call("GET", "/api/accounts", undefined, reader.apiKey)).status, 200)
})

test("revocation while bodies are incomplete blocks every dynamic write and cached replay", async (t) => {
  const api = await fixture(t)
  const account = await api.create("Synthetic delayed body", { baseCents: 1000, includedUnits: 0, unitCents: 1 })
  const commonInvoice = (await api.call("POST", `/api/accounts/${account.id}/invoices`, { period: "2026-01", requestId: "common" })).value
  for (const operation of ["usage", "invoice", "credit"]) {
    for (const cached of [false, true]) {
      const key = await api.key("billing", [account.id])
      let path
      let input
      if (operation === "usage") {
        path = `/api/accounts/${account.id}/usage`
        input = { eventId: `delayed-${cached}`, units: 1, occurredAt: "2026-01-01T00:00:00Z" }
      } else if (operation === "invoice") {
        path = `/api/accounts/${account.id}/invoices`
        input = { period: cached ? "2026-03" : "2026-02", requestId: "delayed" }
      } else {
        path = `/api/invoices/${commonInvoice.id}/credits`
        input = { requestId: "delayed", amountCents: 1, reason: "Synthetic delayed credit" }
      }
      if (cached) assert.equal((await api.call("POST", path, input, key.apiKey)).status, 201)
      const before = api.store.snapshot()
      const pending = await delayedBody(t, api, path, input, key.apiKey)
      assert.equal((await api.call("POST", `/api/access-keys/${key.id}/revoke`, {})).status, 200)
      const result = await pending.finish()
      assert.equal(result.status, 401, `${operation} cached=${cached}`)
      assert.equal(result.value.error.code, "unauthorized")
      const after = api.store.snapshot()
      for (const collection of ["accounts", "usage", "invoices", "credits", "idempotency"]) assert.deepEqual(after[collection], before[collection])
    }
  }
})

function childProcess(t, dataDirectory, port, graceful = false) {
  const args = graceful
    ? ["--input-type=module", "-e", `await import(${JSON.stringify(new URL("../app.mjs", import.meta.url).href)}); process.once('message', () => { process.disconnect(); process.emit('SIGTERM'); });`]
    : [appPath]
  const child = spawn(process.execPath, args, {
    env: { ...process.env, DATA_DIR: dataDirectory, PORT: String(port) },
    stdio: graceful ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => { stdout += chunk })
  child.stderr.on("data", (chunk) => { stderr += chunk })
  // close follows process exit and complete draining of both diagnostic streams.
  const exited = once(child, "close")
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await exited
  })
  return { child, exited, get stdout() { return stdout }, get stderr() { return stderr } }
}

test("entrypoint bind failure releases its own store lock", { timeout: 15_000 }, async (t) => {
  const dataDirectory = directory()
  const occupied = createServer()
  occupied.listen(0, "127.0.0.1")
  await once(occupied, "listening")
  t.after(() => closeServer(occupied))
  const running = childProcess(t, dataDirectory, occupied.address().port)
  t.after(() => rmSync(dataDirectory, { recursive: true, force: true }))
  const [code] = await running.exited
  assert.equal(code, 1)
  assert.equal(running.stdout, "")
  assert.match(running.stderr, /server_start_failed/)
  const reopened = openStore({ directory: dataDirectory })
  reopened.close()
})

test("entrypoint advertises loopback readiness and releases its lock on graceful shutdown", { timeout: 15_000 }, async (t) => {
  const dataDirectory = directory()
  const running = childProcess(t, dataDirectory, 0, true)
  t.after(() => rmSync(dataDirectory, { recursive: true, force: true }))
  let ready
  while (!ready) {
    const [event, detail] = await Promise.race([
      once(running.child.stdout, "data").then(() => ["data"]),
      running.exited.then(([code]) => ["exit", code]),
    ])
    ready = /LedgerDesk listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(running.stdout)
    if (event === "exit" && !ready) assert.fail(`Entrypoint exited ${detail}: ${running.stderr}`)
  }
  const response = await fetch(ready[1] + "/health")
  assert.deepEqual(await response.json(), { ok: true, version: 2 })
  running.child.send("shutdown")
  const [code] = await running.exited
  assert.equal(code, 0)
  assert.equal(running.stderr, "")
  const reopened = openStore({ directory: dataDirectory })
  reopened.close()
})
