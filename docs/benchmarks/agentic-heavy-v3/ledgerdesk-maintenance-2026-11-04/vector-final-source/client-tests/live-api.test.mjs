import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { promisify } from "node:util"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { ApiError, createClient } from "../sdk.mjs"

const exec = promisify(execFile)
const cliPath = fileURLToPath(new URL("../cli.mjs", import.meta.url))
const baseUrl = process.env.LEDGER_CLIENT_TEST_URL
const apiKey = process.env.LEDGER_CLIENT_TEST_KEY

test("live SDK and CLI exercise the complete public API workflow", {
  skip: !baseUrl || !apiKey ? "Set LEDGER_CLIENT_TEST_URL and LEDGER_CLIENT_TEST_KEY for the coordinator's running API" : false,
  timeout: 45000,
}, async () => {
  const url = new URL(baseUrl)
  assert.equal(url.protocol, "http:", "Live verification uses local HTTP only")
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Live verification must stay on loopback")
  assert.equal(url.username, "")
  assert.equal(url.password, "")
  assert.equal(url.pathname, "/")
  assert.equal(url.search, "")
  assert.equal(url.hash, "")
  const owner = createClient({ baseUrl, apiKey })
  const run = randomUUID()
  const period = "2026-11"
  const occurredAt = "2026-11-04T10:00:00Z"
  const plan = { baseCents: 1000, includedUnits: 10, unitCents: 25 }
  const keys = []

  async function cli(args, key = apiKey) {
    let result
    try {
      result = await exec(process.execPath, [cliPath, ...args], {
        env: { ...process.env, LEDGER_URL: baseUrl, LEDGER_KEY: key }, timeout: 10000,
      })
    } catch (error) {
      assert.equal(error.stdout, "", "failed CLI must leave stdout empty")
      assert.ok(!error.stderr.includes(key), "CLI errors must not reveal the API key")
      const failure = JSON.parse(error.stderr)
      assert.deepEqual(Object.keys(failure), ["error"])
      assert.equal(typeof failure.error.code, "string")
      assert.equal(typeof failure.error.message, "string")
      throw new ApiError(0, failure.error.code, failure.error.message)
    }
    assert.equal(result.stderr, "")
    const value = JSON.parse(result.stdout)
    assert.equal(result.stdout, JSON.stringify(value) + "\n", "exactly one JSON stdout value")
    return value
  }

  try {
    const account = await owner.createAccount({ name: `Synthetic SDK ${run}`, plan })
    assert.equal(typeof account.id, "string")
    assert.equal(typeof account.workspaceId, "string")
    assert.deepEqual(account.plan, plan)
    const cliAccount = await cli(["accounts", "create", `Synthetic CLI ${run}`, "1000", "10", "25"])
    const accounts = await owner.listAccounts()
    assert.ok(accounts.some((item) => item.id === account.id))
    assert.ok(accounts.some((item) => item.id === cliAccount.id))
    assert.deepEqual(await cli(["accounts", "list"]), accounts)

    const usageInput = { eventId: `sdk-${run}`, units: 25, occurredAt }
    const usage = await owner.recordUsage(account.id, usageInput)
    assert.equal(usage.accountId, account.id)
    assert.equal(usage.units, 25)
    assert.deepEqual(await owner.recordUsage(account.id, usageInput), usage)
    await assert.rejects(owner.recordUsage(account.id, { ...usageInput, units: 26 }), (e) => e instanceof ApiError && e.status === 409)
    const cliUsage = await cli(["usage", "add", account.id, `cli-${run}`, "1", occurredAt])
    assert.equal(cliUsage.units, 1)
    const events = await owner.listUsage(account.id, period)
    assert.equal(events.length, 2)
    assert.deepEqual(await owner.listUsage(account.id), events)
    assert.deepEqual(await cli(["usage", "list", account.id, period]), events)
    assert.deepEqual(await cli(["usage", "list", account.id]), events)
    const quote = await owner.quote(account.id, period)
    assert.equal(quote.totalUnits, 26)
    assert.equal(quote.totalCents, 1400)
    assert.deepEqual(await cli(["quote", account.id, period]), quote)

    const issueInput = { period, requestId: `issue-${run}` }
    const invoice = await owner.issueInvoice(account.id, issueInput)
    assert.equal(invoice.status, "issued")
    assert.equal(invoice.accountId, account.id)
    assert.equal(invoice.totalCents, quote.totalCents)
    assert.equal(invoice.balanceCents, quote.totalCents)
    assert.equal(invoice.creditedCents, 0)
    assert.equal(invoice.lines.length, 2)
    assert.deepEqual(invoice.lines.map((line) => line.kind).sort(), ["base", "overage"])
    assert.equal(invoice.lines.reduce((sum, line) => sum + line.amountCents, 0), quote.totalCents)
    assert.deepEqual(await owner.issueInvoice(account.id, issueInput), invoice)
    await assert.rejects(owner.issueInvoice(account.id, { period, requestId: `other-${run}` }), (e) => e instanceof ApiError && e.status === 409)
    assert.deepEqual(await owner.getInvoice(invoice.id), invoice)
    assert.deepEqual(await cli(["invoice", "show", invoice.id]), invoice)
    assert.deepEqual(await cli(["invoice", "issue", account.id, period, issueInput.requestId]), invoice)
    const cliInvoice = await cli(["invoice", "issue", cliAccount.id, period, `cli-issue-${run}`])
    assert.equal(cliInvoice.accountId, cliAccount.id)
    assert.equal(cliInvoice.totalCents, 1000)

    const creditInput = { requestId: `credit-${run}`, amountCents: 100, reason: "Synthetic SDK adjustment" }
    const credit = await owner.creditInvoice(invoice.id, creditInput)
    assert.equal(credit.invoiceId, invoice.id)
    assert.equal(credit.amountCents, 100)
    assert.equal(credit.reason, creditInput.reason)
    assert.deepEqual(await owner.creditInvoice(invoice.id, creditInput), credit)
    await assert.rejects(owner.creditInvoice(invoice.id, { ...creditInput, amountCents: 101 }), (e) => e instanceof ApiError && e.status === 409)
    const cliCreditArgs = ["credit", "add", invoice.id, `cli-credit-${run}`, "125", "Synthetic CLI reason with spaces"]
    const cliCredit = await cli(cliCreditArgs)
    assert.equal(cliCredit.reason, "Synthetic CLI reason with spaces")
    assert.equal(cliCredit.amountCents, 125)
    assert.deepEqual(await cli(cliCreditArgs), cliCredit)
    const credits = await owner.listCredits(invoice.id)
    assert.equal(credits.length, 2)
    assert.deepEqual(await cli(["credit", "list", invoice.id]), credits)
    await assert.rejects(owner.creditInvoice(invoice.id, { requestId: `overcredit-${run}`, amountCents: 1401, reason: "Synthetic rejected excess" }), (e) => e instanceof ApiError && e.status === 409)
    await owner.recordUsage(account.id, { eventId: `later-${run}`, units: 5, occurredAt })
    assert.equal((await owner.quote(account.id, period)).totalCents, 1525)
    const updated = await owner.getInvoice(invoice.id)
    assert.equal(updated.totalUnits, 26)
    assert.equal(updated.totalCents, 1400)
    assert.deepEqual(updated.lines, invoice.lines)
    assert.equal(updated.creditedCents, 225)
    assert.equal(updated.balanceCents, 1175)

    const readerKey = await owner.createKey({ role: "reader", accountIds: [account.id] })
    keys.push(readerKey.id)
    assert.equal(readerKey.role, "reader")
    assert.deepEqual(readerKey.accountIds, [account.id])
    assert.equal(typeof readerKey.apiKey, "string")
    const reader = createClient({ baseUrl, apiKey: readerKey.apiKey })
    assert.deepEqual((await reader.listAccounts()).map((item) => item.id), [account.id])
    assert.deepEqual(await reader.getInvoice(invoice.id), updated)
    assert.deepEqual(await reader.listCredits(invoice.id), credits)
    await assert.rejects(reader.getInvoice(cliInvoice.id), (e) => e instanceof ApiError && e.status === 404)
    await assert.rejects(reader.recordUsage(account.id, { eventId: `reader-denied-${run}`, units: 1, occurredAt }), (e) => e instanceof ApiError && e.status === 403)
    await assert.rejects(reader.createKey({ role: "billing" }), (e) => e instanceof ApiError && e.status === 403)
    assert.deepEqual(await cli(["invoice", "show", invoice.id], readerKey.apiKey), updated)
    await assert.rejects(cli(["credit", "add", invoice.id, `denied-${run}`, "1", "Synthetic denied credit"], readerKey.apiKey), (e) => e instanceof ApiError)

    const billingKey = await cli(["keys", "create", "billing", account.id])
    keys.push(billingKey.id)
    const billing = createClient({ baseUrl, apiKey: billingKey.apiKey })
    assert.equal((await billing.recordUsage(account.id, { eventId: `billing-${run}`, units: 1, occurredAt })).units, 1)
    const billingInvoice = await billing.issueInvoice(account.id, { period: "2026-12", requestId: `billing-issue-${run}` })
    assert.equal(billingInvoice.totalCents, 1000)
    assert.equal((await billing.creditInvoice(billingInvoice.id, { requestId: `billing-credit-${run}`, amountCents: 1, reason: "Synthetic billing adjustment" })).amountCents, 1)
    await assert.rejects(billing.createKey({ role: "reader" }), (e) => e instanceof ApiError && e.status === 403)
    assert.deepEqual(await owner.revokeKey(readerKey.id), { revoked: true })
    assert.deepEqual(await owner.revokeKey(readerKey.id), { revoked: true })
    await assert.rejects(reader.listAccounts(), (e) => e instanceof ApiError && e.status === 401)
    assert.deepEqual(await cli(["keys", "revoke", billingKey.id]), { revoked: true })
    await assert.rejects(billing.issueInvoice(account.id, { period: "2026-12", requestId: `billing-issue-${run}` }), (e) => e instanceof ApiError && e.status === 401)
  } finally {
    for (const id of keys) await owner.revokeKey(id)
  }
})
