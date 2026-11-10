import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { createClient } from "../sdk.mjs"

assert.ok(process.env.DATA_DIR, "Set DATA_DIR to the restarted verification instance")
const report = JSON.parse(readFileSync(join(process.env.DATA_DIR, "lead-verification.json"), "utf8"))
const baseUrl = process.env.LEDGER_URL || `http://127.0.0.1:${process.env.PORT || 4125}`
assert.equal(new URL(baseUrl).hostname, "127.0.0.1")
const client = createClient({ baseUrl, apiKey: "billing-acme" })
const invoice = await client.getInvoice(report.invoiceId)
assert.equal(invoice.totalCents, 160)
assert.equal(invoice.creditedCents, 130)
assert.equal(invoice.balanceCents, 30)
assert.equal((await client.listCredits(invoice.id)).length, 2)
assert.equal((await client.listUsage(report.accountId, "2026-01")).length, 2)
const replay = await fetch(`${baseUrl}/api/accounts/${report.accountId}/invoices`, {
  method: "POST", headers: { authorization: "Bearer billing-acme", "content-type": "application/json" },
  body: JSON.stringify({ period: "2026-01", requestId: `issue-${report.suffix}` }),
})
assert.equal(replay.status, 200)
assert.equal((await replay.json()).id, invoice.id)
const credit = await client.creditInvoice(invoice.id, {
  requestId: `credit-${report.suffix}`, amountCents: 60, reason: "Synthetic adjustment",
})
assert.equal(credit.amountCents, 60)
assert.equal((await client.listCredits(invoice.id)).length, 2)
const cli = spawnSync(process.env.NODE_EXE || process.execPath,
  [fileURLToPath(new URL("../cli.mjs", import.meta.url)), "invoice", "show", report.invoiceId],
  { encoding: "utf8", env: { ...process.env, LEDGER_URL: baseUrl, LEDGER_KEY: "reader-acme" } })
assert.ifError(cli.error)
assert.equal(cli.status, 0, cli.stderr)
assert.equal(cli.stderr, "")
assert.equal(JSON.parse(cli.stdout).balanceCents, 30)
process.stdout.write(JSON.stringify({ ok: true, checks: 13, description: "Post-restart API, CLI and SDK preserve invoices, credits, usage and idempotency" }) + "\n")
