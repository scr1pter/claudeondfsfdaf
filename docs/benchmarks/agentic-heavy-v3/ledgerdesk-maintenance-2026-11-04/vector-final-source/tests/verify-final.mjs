import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { request as httpRequest } from "node:http"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { ApiError, createClient } from "../sdk.mjs"

// Runs against a separately launched local service. Runtime state belongs only in DATA_DIR.
const baseUrl = process.env.LEDGER_URL || `http://127.0.0.1:${process.env.PORT || 4125}`
const parsedUrl = new URL(baseUrl)
assert.equal(parsedUrl.hostname, "127.0.0.1", "Verification must use synthetic loopback service")
const suffix = `${Date.now()}-${process.pid}`
let checks = 0
function check(condition, message) { assert.ok(condition, message); checks++ }
async function http(method, path, key = "owner-acme", input, expected = 200) {
  const response = await fetch(baseUrl + path, {
    method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  })
  const result = await response.json()
  assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(result)}`)
  if (expected >= 400) {
    check(typeof result.error?.code === "string" && result.error.code.length > 0, "Stable error code")
    check(typeof result.error?.message === "string" && result.error.message.length > 0, "Stable error message")
  }
  checks++
  return result
}
function cli(args, key = "owner-acme", success = true) {
  const result = spawnSync(process.env.NODE_EXE || process.execPath,
    [fileURLToPath(new URL("../cli.mjs", import.meta.url)), ...args],
    { encoding: "utf8", env: { ...process.env, LEDGER_URL: baseUrl, LEDGER_KEY: key } })
  assert.ifError(result.error)
  assert.equal(result.status === 0, success, result.stderr)
  assert.equal(success ? result.stderr : result.stdout, "")
  const output = JSON.parse(success ? result.stdout : result.stderr)
  if (!success) check(Boolean(output.error?.code && output.error?.message), "CLI JSON error")
  checks++
  return output
}

const owner = createClient({ baseUrl, apiKey: "owner-acme" })
const billing = createClient({ baseUrl, apiKey: "billing-acme" })
const reader = createClient({ baseUrl, apiKey: "reader-acme" })
assert.deepEqual(await http("GET", "/health"), { ok: true, version: 2 })
await http("GET", "/api/accounts", "unknown", undefined, 401)
const account = await owner.createAccount({ name: `Synthetic final ${suffix}`, plan: { baseCents: 100, includedUnits: 10, unitCents: 3 } })
const other = await owner.createAccount({ name: `Synthetic hidden ${suffix}`, plan: { baseCents: 0, includedUnits: 0, unitCents: 0 } })
check((await owner.listAccounts()).some(item => item.id === account.id), "SDK account list")
await http("GET", `/api/accounts/${account.id}`, "owner-beta", undefined, 404)
await http("POST", "/api/accounts", "reader-acme", { name: "Disallowed", plan: account.plan }, 403)
await http("POST", "/api/accounts", "owner-acme", [], 400)
await http("POST", `/api/accounts/${account.id}/usage`, "billing-acme", { eventId: "impossible", units: 1, occurredAt: "2026-02-30T00:00:00Z" }, 400)
const input = { eventId: `event-${suffix}`, units: 30, occurredAt: "2026-01-10T00:00:00Z" }
const usageResponses = await Promise.all(Array.from({ length: 8 }, async () => {
  const response = await fetch(`${baseUrl}/api/accounts/${account.id}/usage`, {
    method: "POST", headers: { authorization: "Bearer billing-acme", "content-type": "application/json" }, body: JSON.stringify(input),
  })
  return { status: response.status, body: await response.json() }
}))
check(usageResponses.filter(item => item.status === 201).length === 1, "Exactly one concurrent usage creation")
check(usageResponses.filter(item => item.status === 200).length === 7, "Concurrent usage exact replay")
check(new Set(usageResponses.map(item => item.body.id)).size === 1, "Concurrent usage original identity")
await http("POST", `/api/accounts/${account.id}/usage`, "billing-acme", { ...input, units: 31 }, 409)
assert.equal((await billing.recordUsage(account.id, input)).id, usageResponses[0].body.id)
check((await reader.listUsage(account.id, "2026-01")).length === 1, "SDK usage filter")
assert.equal((await owner.quote(account.id, "2026-01")).totalCents, 160)
const invoiceInput = { period: "2026-01", requestId: `issue-${suffix}` }
const issued = await Promise.all(Array.from({ length: 6 }, () => billing.issueInvoice(account.id, invoiceInput)))
check(new Set(issued.map(item => item.id)).size === 1, "Concurrent invoice idempotency")
const invoice = issued[0]
assert.equal(invoice.totalCents, 160)
assert.equal(invoice.lines.reduce((sum, line) => sum + line.amountCents, 0), 160)
await http("POST", `/api/accounts/${account.id}/invoices`, "billing-acme", { ...invoiceInput, period: "2026-02" }, 409)
await http("POST", `/api/accounts/${account.id}/invoices`, "billing-acme", { ...invoiceInput, requestId: `different-${suffix}` }, 409)
await billing.recordUsage(account.id, { ...input, eventId: `late-${suffix}`, units: 5 })
assert.equal((await owner.quote(account.id, "2026-01")).totalCents, 175)
assert.equal((await reader.getInvoice(invoice.id)).totalCents, 160)
check(true, "Immutable issued invoice versus live quote")
const creditInput = { requestId: `credit-${suffix}`, amountCents: 60, reason: "Synthetic adjustment" }
const credit = await billing.creditInvoice(invoice.id, creditInput)
assert.equal((await billing.creditInvoice(invoice.id, creditInput)).id, credit.id)
assert.equal((await reader.listCredits(invoice.id)).length, 1)
await http("POST", `/api/invoices/${invoice.id}/credits`, "billing-acme", { ...creditInput, amountCents: 61 }, 409)
const attempts = await Promise.all(Array.from({ length: 4 }, (_, i) =>
  fetch(`${baseUrl}/api/invoices/${invoice.id}/credits`, {
    method: "POST", headers: { authorization: "Bearer billing-acme", "content-type": "application/json" },
    body: JSON.stringify({ requestId: `race-${suffix}-${i}`, amountCents: 70, reason: "Concurrent synthetic credit" }),
  }).then(async response => ({ status: response.status, body: await response.json() }))))
check(attempts.filter(item => item.status === 201).length === 1, "Concurrent credits cannot exceed total")
check(attempts.filter(item => item.status === 409).length === 3, "Credit race failures conflict")
const balance = await reader.getInvoice(invoice.id)
assert.equal(balance.creditedCents, 130)
assert.equal(balance.balanceCents, 30)
const key = await owner.createKey({ role: "billing", accountIds: [account.id] })
const scoped = createClient({ baseUrl, apiKey: key.apiKey })
assert.deepEqual((await scoped.listAccounts()).map(item => item.id), [account.id])
await http("GET", `/api/accounts/${other.id}`, key.apiKey, undefined, 404)
await http("POST", "/api/access-keys", key.apiKey, { role: "reader" }, 403)
const scopedInvoice = await scoped.issueInvoice(account.id, { period: "2026-02", requestId: `scope-${suffix}` })
assert.equal(scopedInvoice.totalCents, 100)
await owner.revokeKey(key.id)
assert.deepEqual(await owner.revokeKey(key.id), { revoked: true })
await assert.rejects(scoped.issueInvoice(account.id, { period: "2026-02", requestId: `scope-${suffix}` }), error => error instanceof ApiError && error.status === 401 && typeof error.code === "string")
await assert.rejects(reader.createAccount({ name: "No", plan: account.plan }), error => error instanceof ApiError && error.status === 403)
check(true, "SDK typed ApiError, scope, revocation and replay authorization")

const pendingKey = await owner.createKey({ role: "billing", accountIds: [account.id] })
const pendingInput = JSON.stringify({ eventId: `revoked-in-flight-${suffix}`, units: 1, occurredAt: "2026-01-01T00:00:00Z" })
let partialRequest
const pendingResponse = new Promise((resolve, reject) => {
  partialRequest = httpRequest(`${baseUrl}/api/accounts/${account.id}/usage`, {
    method: "POST", headers: { authorization: `Bearer ${pendingKey.apiKey}`, "content-type": "application/json", "content-length": Buffer.byteLength(pendingInput) },
  }, response => {
    const chunks = []
    response.on("data", chunk => chunks.push(chunk))
    response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }))
  })
  partialRequest.on("error", reject)
  partialRequest.setTimeout(5000, () => partialRequest.destroy(new Error("Slow-body verification timed out")))
  partialRequest.write(pendingInput.slice(0, -1))
})
await delay(80)
await owner.revokeKey(pendingKey.id)
partialRequest.end(pendingInput.slice(-1))
const denied = await pendingResponse
assert.equal(denied.status, 401)
assert.ok(denied.body.error.code)
check(!(await owner.listUsage(account.id)).some(item => item.eventId === `revoked-in-flight-${suffix}`), "Revoked in-flight body cannot commit")

assert.ok(cli(["accounts", "list"]).some(item => item.id === account.id))
assert.equal(cli(["quote", account.id, "2026-01"]).totalCents, 175)
assert.equal(cli(["usage", "add", account.id, `cli-${suffix}`, "2", "2026-03-10T00:00:00Z"]).units, 2)
const cliInvoice = cli(["invoice", "issue", account.id, "2026-03", `cli-issue-${suffix}`])
assert.equal(cli(["invoice", "show", cliInvoice.id]).id, cliInvoice.id)
assert.equal(cli(["credit", "add", cliInvoice.id, `cli-credit-${suffix}`, "10", "Synthetic CLI adjustment"]).amountCents, 10)
const statusInvoiceInput = { period: "2026-04", requestId: `status-${suffix}` }
await http("POST", `/api/accounts/${account.id}/invoices`, "reader-acme", statusInvoiceInput, 403)
const statusInvoice = await http("POST", `/api/accounts/${account.id}/invoices`, "billing-acme", statusInvoiceInput, 201)
assert.equal((await http("POST", `/api/accounts/${account.id}/invoices`, "billing-acme", statusInvoiceInput, 200)).id, statusInvoice.id)
// The same ID under another actor is not a replay of the billing actor's operation.
await http("POST", `/api/accounts/${account.id}/invoices`, "owner-acme", statusInvoiceInput, 409)
const statusCreditInput = { requestId: `status-credit-${suffix}`, amountCents: 10, reason: "Synthetic status check" }
const statusCredit = await http("POST", `/api/invoices/${statusInvoice.id}/credits`, "billing-acme", statusCreditInput, 201)
assert.equal((await http("POST", `/api/invoices/${statusInvoice.id}/credits`, "billing-acme", statusCreditInput, 200)).id, statusCredit.id)
assert.notEqual((await http("POST", `/api/invoices/${statusInvoice.id}/credits`, "owner-acme", statusCreditInput, 201)).id, statusCredit.id)
check((await reader.getInvoice(statusInvoice.id)).creditedCents === 20, "Idempotency is actor-isolated")
await http("POST", `/api/invoices/${statusInvoice.id}/credits`, "billing-acme", { requestId: `retry-${suffix}`, amountCents: 81, reason: "Synthetic retry" }, 409)
await http("POST", `/api/invoices/${statusInvoice.id}/credits`, "billing-acme", { requestId: `retry-${suffix}`, amountCents: 80, reason: "Synthetic retry" }, 201)
check((await reader.getInvoice(statusInvoice.id)).balanceCents === 0, "Failed credit does not reserve request ID")
cli(["invoice", "issue"], "owner-acme", false)
cli(["quote", account.id, "2026-13"], "owner-acme", false)
cli(["usage", "add", account.id, "invalid", "1.5", "2026-01-01T00:00:00Z"], "owner-acme", false)
cli(["invoice", "show", invoice.id], "owner-beta", false)

if (process.env.DATA_DIR) {
  const text = readFileSync(join(process.env.DATA_DIR, "ledger.json"), "utf8")
  const stored = JSON.parse(text)
  const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : value !== null && typeof value === "object" ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`
      : JSON.stringify(value)
  assert.equal(stored.version, 2)
  assert.equal(stored.checksum, createHash("sha256").update(canonical(stored.payload), "utf8").digest("hex"))
  check(!text.includes(key.apiKey) && !text.includes(pendingKey.apiKey), "Only dynamic key hash persisted")
}
const report = { ok: true, checks, suffix, accountId: account.id, invoiceId: invoice.id, cliInvoiceId: cliInvoice.id }
if (process.env.DATA_DIR) writeFileSync(join(process.env.DATA_DIR, "lead-verification.json"), JSON.stringify(report) + "\n")
process.stdout.write(JSON.stringify(report) + "\n")
