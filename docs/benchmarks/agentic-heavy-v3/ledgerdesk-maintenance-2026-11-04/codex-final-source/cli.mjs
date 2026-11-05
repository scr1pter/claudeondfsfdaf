import { ApiError, createClient } from "./sdk.mjs"

const args = process.argv.slice(2)
const help = `LedgerDesk v2 (synthetic local billing)
Configure LEDGER_URL and LEDGER_KEY, then run:
  accounts list
  accounts create <name> <baseCents> <includedUnits> <unitCents>
  accounts show <accountId>
  quote <accountId> <period>
  usage add <accountId> <eventId> <units> <occurredAt>
  usage list <accountId> [period]
  invoice issue <accountId> <period> <requestId>
  invoice show <invoiceId>
  credit add <invoiceId> <requestId> <amountCents> <reason>
  credit list <invoiceId>
  key create <billing|reader> [accountId ...]
  key revoke <keyId>
Quote periods use YYYY-MM. Quote multiword names and reasons in your shell.
Use --help or help for this message.`
function usage() {
  throw new ApiError(400, "invalid_command", "Unknown or incomplete command; use --help")
}
function integer(value, positive = false) {
  if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)) || (positive && Number(value) === 0)) {
    throw new ApiError(400, "invalid_input", "Amounts and units must be safe integers in the permitted range")
  }
  return Number(value)
}

function command() {
  if (args.length === 2 && args[0] === "accounts" && args[1] === "list") return (client) => client.listAccounts()
  if (args.length === 6 && args[0] === "accounts" && args[1] === "create") {
    const input = { name: args[2], plan: { baseCents: integer(args[3]), includedUnits: integer(args[4]), unitCents: integer(args[5]) } }
    return (client) => client.createAccount(input)
  }
  if (args.length === 3 && args[0] === "accounts" && args[1] === "show") return (client) => client.getAccount(args[2])
  if (args.length === 3 && args[0] === "quote") return (client) => client.quote(args[1], args[2])
  if (args.length === 6 && args[0] === "usage" && args[1] === "add") {
    const input = { eventId: args[3], units: integer(args[4], true), occurredAt: args[5] }
    return (client) => client.recordUsage(args[2], input)
  }
  if ((args.length === 3 || args.length === 4) && args[0] === "usage" && args[1] === "list") {
    return (client) => client.listUsage(args[2], args[3])
  }
  if (args.length === 5 && args[0] === "invoice" && args[1] === "issue") {
    return (client) => client.issueInvoice(args[2], { period: args[3], requestId: args[4] })
  }
  if (args.length === 3 && args[0] === "invoice" && args[1] === "show") return (client) => client.getInvoice(args[2])
  if (args.length === 6 && args[0] === "credit" && args[1] === "add") {
    const input = { requestId: args[3], amountCents: integer(args[4], true), reason: args[5] }
    return (client) => client.creditInvoice(args[2], input)
  }
  if (args.length === 3 && args[0] === "credit" && args[1] === "list") return (client) => client.listCredits(args[2])
  if (args.length >= 3 && args[0] === "key" && args[1] === "create") {
    if (args[2] !== "billing" && args[2] !== "reader") usage()
    const input = { role: args[2], ...(args.length > 3 ? { accountIds: args.slice(3) } : {}) }
    return (client) => client.createKey(input)
  }
  if (args.length === 3 && args[0] === "key" && args[1] === "revoke") return (client) => client.revokeKey(args[2])
  usage()
}

async function main() {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "help")) {
    process.stdout.write(help + "\n")
    return
  }
  const execute = command()
  if (!process.env.LEDGER_URL || !process.env.LEDGER_KEY) {
    throw new ApiError(400, "configuration_required", "LEDGER_URL and LEDGER_KEY must be configured")
  }
  const client = createClient({ baseUrl: process.env.LEDGER_URL, apiKey: process.env.LEDGER_KEY })
  return execute(client)
}

main().then((result) => {
  if (result !== undefined) process.stdout.write(JSON.stringify(result) + "\n")
}).catch((error) => {
  process.stderr.write(JSON.stringify({ error: { code: error instanceof ApiError ? error.code : "client_error",
    message: error instanceof ApiError ? error.message : "Cannot complete the local request" } }) + "\n")
  process.exitCode = 1
})
