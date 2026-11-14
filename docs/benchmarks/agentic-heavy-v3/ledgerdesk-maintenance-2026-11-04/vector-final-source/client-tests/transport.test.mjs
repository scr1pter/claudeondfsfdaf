import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createServer } from "node:http"
import { promisify } from "node:util"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { ApiError, createClient } from "../sdk.mjs"
import { account, usageInput, usage, quote, invoice, credit, accessKey, plan } from "./fixtures.mjs"

const exec = promisify(execFile)
const cliPath = fileURLToPath(new URL("../cli.mjs", import.meta.url))
const syntheticKey = "synthetic-client-test-key"

async function serverFor(t, handler) {
  const server = createServer(async (req, res) => {
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined
      await handler(req, res, body)
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { code: "fixture_failure", message: error.message } }))
    }
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  return `http://127.0.0.1:${server.address().port}`
}

function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(value))
}

async function runCli(args, baseUrl, key = syntheticKey) {
  const env = { ...process.env }
  delete env.LEDGER_URL
  delete env.LEDGER_KEY
  if (baseUrl !== undefined) env.LEDGER_URL = baseUrl
  if (key !== undefined) env.LEDGER_KEY = key
  try {
    const result = await exec(process.execPath, [cliPath, ...args], { env, timeout: 10000 })
    return { ...result, code: 0 }
  } catch (error) {
    return { stdout: error.stdout, stderr: error.stderr, code: error.code }
  }
}

function assertFailure(result, code) {
  assert.notEqual(result.code, 0)
  assert.equal(result.stdout, "")
  const parsed = JSON.parse(result.stderr)
  assert.deepEqual(Object.keys(parsed), ["error"])
  assert.deepEqual(Object.keys(parsed.error).sort(), ["code", "message"])
  assert.equal(parsed.error.code, code)
  assert.equal(typeof parsed.error.message, "string")
  assert.ok(parsed.error.message.length > 0)
  assert.ok(!result.stderr.includes(syntheticKey))
}

test("SDK exports the error class and sends every public method over real local HTTP", async (t) => {
  const error = new ApiError(409, "conflict", "Synthetic conflict")
  assert.ok(error instanceof Error)
  assert.equal(error.name, "ApiError")
  assert.equal(error.status, 409)
  assert.equal(error.code, "conflict")
  const unusualId = "account /?#ü"
  const encodedId = encodeURIComponent(unusualId)
  const extras = { apiKey: "must-not-send", workspaceId: "beta", status: "issued", scopes: ["owner"] }
  const steps = [
    ["GET", "/api/accounts", undefined, 200, [account], (c) => c.listAccounts()],
    ["POST", "/api/accounts", { name: account.name, plan }, 201, account,
      (c) => c.createAccount({ name: account.name, plan: { ...plan, ...extras }, ...extras })],
    ["POST", `/api/accounts/${encodedId}/usage`, usageInput, 201, usage,
      (c) => c.recordUsage(unusualId, { ...usageInput, ...extras })],
    ["POST", "/api/accounts/account-1/usage", usageInput, 200, usage, (c) => c.recordUsage(account.id, usageInput)],
    ["GET", `/api/accounts/${encodedId}/usage`, undefined, 200, [usage], (c) => c.listUsage(unusualId)],
    ["GET", `/api/accounts/${encodedId}/usage?period=2026-11`, undefined, 200, [usage], (c) => c.listUsage(unusualId, "2026-11")],
    ["GET", `/api/accounts/${encodedId}/quote?period=2026-11%26x%3D1`, undefined, 200, quote, (c) => c.quote(unusualId, "2026-11&x=1")],
    ["POST", `/api/accounts/${encodedId}/invoices`, { period: "2026-11", requestId: "issue-1" }, 201, invoice,
      (c) => c.issueInvoice(unusualId, { period: "2026-11", requestId: "issue-1", ...extras })],
    ["POST", "/api/accounts/account-1/invoices", { period: "2026-11", requestId: "issue-1" }, 200, invoice,
      (c) => c.issueInvoice(account.id, { period: "2026-11", requestId: "issue-1" })],
    ["GET", `/api/invoices/${encodedId}`, undefined, 200, invoice, (c) => c.getInvoice(unusualId)],
    ["POST", `/api/invoices/${encodedId}/credits`, { requestId: "credit-1", amountCents: 100, reason: credit.reason }, 201, credit,
      (c) => c.creditInvoice(unusualId, { requestId: "credit-1", amountCents: 100, reason: credit.reason, ...extras })],
    ["POST", "/api/invoices/invoice-1/credits", { requestId: "credit-1", amountCents: 100, reason: credit.reason }, 200, credit,
      (c) => c.creditInvoice(invoice.id, { requestId: "credit-1", amountCents: 100, reason: credit.reason })],
    ["GET", `/api/invoices/${encodedId}/credits`, undefined, 200, [credit], (c) => c.listCredits(unusualId)],
    ["POST", "/api/access-keys", { role: "reader", accountIds: [account.id] }, 201, accessKey,
      (c) => c.createKey({ role: "reader", accountIds: [account.id], ...extras })],
    ["POST", "/api/access-keys", { role: "billing" }, 201, { ...accessKey, role: "billing", accountIds: undefined },
      (c) => c.createKey({ role: "billing", ...extras })],
    ["POST", `/api/access-keys/${encodedId}/revoke`, {}, 200, { revoked: true }, (c) => c.revokeKey(unusualId)],
  ]
  let index = 0
  const baseUrl = await serverFor(t, (req, res, body) => {
    const [method, path, input, status, result] = steps[index++]
    assert.equal(req.method, method)
    assert.equal(req.url, path)
    assert.equal(req.headers.authorization, `Bearer ${syntheticKey}`)
    assert.equal(req.headers["content-type"], input === undefined ? undefined : "application/json")
    assert.deepEqual(body, input)
    json(res, status, result)
  })
  const client = createClient({ baseUrl: baseUrl + "///", apiKey: syntheticKey })
  for (const [, , , , result, invoke] of steps) {
    assert.deepEqual(await invoke(client), JSON.parse(JSON.stringify(result)))
  }
  assert.equal(index, steps.length)
})

test("SDK API, malformed response, network and redacted diagnostic errors", async (t) => {
  let status = 400
  let result = { error: { code: "invalid_input", message: "Synthetic failure" } }
  let raw
  let disconnect = false
  const baseUrl = await serverFor(t, (req, res) => {
    if (disconnect) return req.socket.destroy()
    if (raw !== undefined) { res.writeHead(status); res.end(raw); return }
    json(res, status, result)
  })
  const client = createClient({ baseUrl, apiKey: syntheticKey })
  for (status of [400, 401, 403, 404, 409, 500]) {
    await assert.rejects(client.listAccounts(), (e) => e instanceof ApiError && e.status === status && e.code === "invalid_input" && e.message === "Synthetic failure")
  }
  result = { error: { code: `echo-${syntheticKey}`, message: `Do not reveal ${syntheticKey}` } }
  await assert.rejects(client.listAccounts(), (e) => e instanceof ApiError && !e.stack.includes(syntheticKey) && !e.code.includes(syntheticKey))
  result = { error: { code: 123, message: { private: syntheticKey } } }
  await assert.rejects(client.listAccounts(), (e) => e instanceof ApiError && e.code === "api_error" && e.message === "Request failed")
  result = null
  await assert.rejects(client.listAccounts(), (e) => e instanceof ApiError && e.status === 500 && e.code === "api_error")
  raw = "not JSON"
  await assert.rejects(client.listAccounts(), (e) => e instanceof ApiError && e.status === 500 && e.code === "api_error")
  status = 200
  await assert.rejects(client.listAccounts(), (e) => e instanceof ApiError && e.status === 200 && e.code === "invalid_response")
  disconnect = true
  await assert.rejects(client.listAccounts(), (e) => e instanceof ApiError && e.status === 0 && e.code === "network_error" && !e.message.includes(syntheticKey))
})

test("CLI connects legacy, invoice, credit, account and key workflows to actual HTTP", async (t) => {
  const steps = [
    [["accounts", "list"], "GET", "/api/accounts", undefined, [account]],
    [["accounts", "create", account.name, "1000", "10", "25"], "POST", "/api/accounts", { name: account.name, plan }, account],
    [["quote", account.id, "2026-11"], "GET", "/api/accounts/account-1/quote?period=2026-11", undefined, quote],
    [["usage", "add", account.id, usageInput.eventId, "25", usageInput.occurredAt], "POST", "/api/accounts/account-1/usage", usageInput, usage],
    [["usage", "list", account.id], "GET", "/api/accounts/account-1/usage", undefined, [usage]],
    [["usage", "list", account.id, "2026-11"], "GET", "/api/accounts/account-1/usage?period=2026-11", undefined, [usage]],
    [["invoice", "issue", account.id, "2026-11", "request-1"], "POST", "/api/accounts/account-1/invoices", { period: "2026-11", requestId: "request-1" }, invoice],
    [["invoice", "show", invoice.id], "GET", "/api/invoices/invoice-1", undefined, invoice],
    [["credit", "add", invoice.id, "credit-request", "100", credit.reason], "POST", "/api/invoices/invoice-1/credits", { requestId: "credit-request", amountCents: 100, reason: credit.reason }, credit],
    [["credit", "list", invoice.id], "GET", "/api/invoices/invoice-1/credits", undefined, [credit]],
    [["keys", "create", "reader", account.id], "POST", "/api/access-keys", { role: "reader", accountIds: [account.id] }, accessKey],
    [["keys", "create", "billing"], "POST", "/api/access-keys", { role: "billing" }, { ...accessKey, role: "billing", accountIds: undefined }],
    [["keys", "revoke", accessKey.id], "POST", "/api/access-keys/key-1/revoke", {}, { revoked: true }],
  ]
  let index = 0
  const baseUrl = await serverFor(t, (req, res, body) => {
    const [, method, path, input, output] = steps[index++]
    assert.equal(req.method, method)
    assert.equal(req.url, path)
    assert.equal(req.headers.authorization, `Bearer ${syntheticKey}`)
    assert.deepEqual(body, input)
    json(res, method === "POST" && !path.endsWith("/revoke") ? 201 : 200, output)
  })
  for (const [args, , , , output] of steps) {
    const result = await runCli(args, baseUrl)
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.stderr, "")
    assert.equal(result.stdout, JSON.stringify(output) + "\n")
  }
  assert.equal(index, steps.length)
})

test("CLI rejects unknown, incomplete, extra and unsafe numeric arguments without HTTP", async (t) => {
  let requests = 0
  const baseUrl = await serverFor(t, (req, res) => { requests++; json(res, 500, {}) })
  const invalid = [
    [], ["unknown"], ["--help", "extra"], ["accounts"], ["accounts", "list", "extra"],
    ["accounts", "create", "Synthetic", "0", "0"], ["accounts", "create", "Synthetic", "-1", "0", "0"],
    ["quote", "a"], ["quote", "a", "2026-11", "extra"],
    ["usage", "add", "a", "e", "1"], ["usage", "add", "a", "e", "1", "2026-11-04T10:00:00Z", "extra"],
    ["usage", "list"], ["usage", "list", "a", "2026-11", "extra"],
    ["invoice"], ["invoice", "issue", "a", "2026-11"], ["invoice", "issue", "a", "2026-11", "r", "extra"],
    ["invoice", "show"], ["invoice", "show", "i", "extra"],
    ["credit", "add", "i", "r", "1"], ["credit", "add", "i", "r", "1", "reason", "extra"],
    ["credit", "list"], ["credit", "list", "i", "extra"],
    ["keys", "create"], ["keys", "create", "owner"], ["keys", "revoke"], ["keys", "revoke", "k", "extra"],
  ]
  for (const number of ["0", "-1", "1.5", "1e3", "NaN", "Infinity", "9007199254740992", "", " 1", "+1"]) {
    invalid.push(["usage", "add", "a", "e", number, "2026-11-04T10:00:00Z"])
    invalid.push(["credit", "add", "i", "r", number, "reason"])
  }
  for (const args of invalid) assertFailure(await runCli(args, baseUrl), "invalid_command")
  assert.equal(requests, 0)
})

test("CLI help, missing configuration and API failures have correct streams and exit status", async (t) => {
  for (const arg of ["--help", "help"]) {
    const result = await runCli([arg], undefined, undefined)
    assert.equal(result.code, 0)
    assert.equal(result.stderr, "")
    for (const command of ["accounts list", "quote", "usage add", "invoice issue", "invoice show", "credit add"]) assert.ok(result.stdout.includes(command))
  }
  assertFailure(await runCli(["accounts", "list"], undefined), "configuration_required")
  let status = 403
  let raw
  let disconnect = false
  let response = { error: { code: "forbidden", message: "Synthetic reader cannot write" } }
  const baseUrl = await serverFor(t, (req, res) => {
    if (disconnect) return req.socket.destroy()
    if (raw !== undefined) { res.writeHead(status); res.end(raw); return }
    json(res, status, response)
  })
  assertFailure(await runCli(["invoice", "issue", "a", "2026-11", "r"], baseUrl), "forbidden")
  status = 409
  response = { error: { code: "conflict", message: `Rejected key ${syntheticKey}` } }
  const redacted = await runCli(["credit", "add", "i", "r", "1", "reason"], baseUrl)
  assertFailure(redacted, "conflict")
  assert.ok(redacted.stderr.includes("[redacted]"))
  raw = "not JSON"
  assertFailure(await runCli(["accounts", "list"], baseUrl), "api_error")
  status = 200
  assertFailure(await runCli(["accounts", "list"], baseUrl), "invalid_response")
  disconnect = true
  assertFailure(await runCli(["accounts", "list"], baseUrl), "network_error")
})
