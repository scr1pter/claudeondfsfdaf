import { ApiError, createClient } from "./sdk.mjs"

const args = process.argv.slice(2)
const help = `LedgerDesk:
  accounts list
  accounts create <name> <baseCents> <includedUnits> <unitCents>
  quote <accountId> <period>
  usage add <accountId> <eventId> <units> <occurredAt>
  usage list <accountId> [period]
  invoice issue <accountId> <period> <requestId>
  invoice show <invoiceId>
  credit add <invoiceId> <requestId> <amountCents> <reason>
  credit list <invoiceId>
  keys create <billing|reader> [accountId ...]
  keys revoke <keyId>
Use LEDGER_URL and LEDGER_KEY. Quote names and reasons containing spaces.`
function usage() {
  throw new ApiError(400, "invalid_command", "Unknown, incomplete or invalid command; use --help")
}
function integer(value, positive = false) {
  if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)) || (positive && Number(value) === 0)) usage()
  return Number(value)
}

async function main() {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "help")) {
    process.stdout.write(help + "\n")
    return
  }
  let execute
  if (args.length === 2 && args[0] === "accounts" && args[1] === "list") execute = (client) => client.listAccounts()
  else if (args.length === 6 && args[0] === "accounts" && args[1] === "create") {
    const plan = { baseCents: integer(args[3]), includedUnits: integer(args[4]), unitCents: integer(args[5]) }
    execute = (client) => client.createAccount({ name: args[2], plan })
  }
  else if (args.length === 3 && args[0] === "quote") execute = (client) => client.quote(args[1], args[2])
  else if (args.length === 6 && args[0] === "usage" && args[1] === "add") {
    const units = integer(args[4], true)
    execute = (client) => client.recordUsage(args[2], { eventId: args[3], units, occurredAt: args[5] })
  }
  else if ((args.length === 3 || args.length === 4) && args[0] === "usage" && args[1] === "list") execute = (client) => client.listUsage(args[2], args[3])
  else if (args.length === 5 && args[0] === "invoice" && args[1] === "issue") execute = (client) => client.issueInvoice(args[2], { period: args[3], requestId: args[4] })
  else if (args.length === 3 && args[0] === "invoice" && args[1] === "show") execute = (client) => client.getInvoice(args[2])
  else if (args.length === 6 && args[0] === "credit" && args[1] === "add") {
    const amountCents = integer(args[4], true)
    execute = (client) => client.creditInvoice(args[2], { requestId: args[3], amountCents, reason: args[5] })
  }
  else if (args.length === 3 && args[0] === "credit" && args[1] === "list") execute = (client) => client.listCredits(args[2])
  else if (args.length >= 3 && args[0] === "keys" && args[1] === "create" && ["billing", "reader"].includes(args[2])) {
    execute = (client) => client.createKey({ role: args[2], ...(args.length === 3 ? {} : { accountIds: args.slice(3) }) })
  }
  else if (args.length === 3 && args[0] === "keys" && args[1] === "revoke") execute = (client) => client.revokeKey(args[2])
  else usage()
  if (!process.env.LEDGER_URL || !process.env.LEDGER_KEY) {
    throw new ApiError(400, "configuration_required", "LEDGER_URL and LEDGER_KEY must be configured")
  }
  return execute(createClient({ baseUrl: process.env.LEDGER_URL, apiKey: process.env.LEDGER_KEY }))
}

main().then((result) => {
  if (result !== undefined) process.stdout.write(JSON.stringify(result) + "\n")
}).catch((error) => {
  const redact = (value) => process.env.LEDGER_KEY ? value.replaceAll(process.env.LEDGER_KEY, "[redacted]") : value
  process.stderr.write(JSON.stringify({ error: { code: error instanceof ApiError ? redact(error.code) : "client_error",
    message: error instanceof ApiError ? redact(error.message) : "Cannot complete the local request" } }) + "\n")
  process.exitCode = 1
})
