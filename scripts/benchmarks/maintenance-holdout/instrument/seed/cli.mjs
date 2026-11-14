import { ApiError, createClient } from "./sdk.mjs"

const args = process.argv.slice(2)
const help = "LedgerDesk v1: accounts list | quote <accountId> <period> | usage add <accountId> <eventId> <units> <occurredAt>"
function usage() {
  throw new ApiError(400, "invalid_command", "Unknown or incomplete command; use --help")
}

async function main() {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "help")) {
    process.stdout.write(help + "\n")
    return
  }
  if (!process.env.LEDGER_URL || !process.env.LEDGER_KEY) {
    throw new ApiError(400, "configuration_required", "LEDGER_URL and LEDGER_KEY must be configured")
  }
  const client = createClient({ baseUrl: process.env.LEDGER_URL, apiKey: process.env.LEDGER_KEY })
  if (args.length === 2 && args[0] === "accounts" && args[1] === "list") return client.listAccounts()
  if (args.length === 3 && args[0] === "quote") return client.quote(args[1], args[2])
  if (args.length === 6 && args[0] === "usage" && args[1] === "add") {
    if (!/^[1-9]\d*$/.test(args[4]) || !Number.isSafeInteger(Number(args[4]))) usage()
    return client.recordUsage(args[2], { eventId: args[3], units: Number(args[4]), occurredAt: args[5] })
  }
  usage()
}

main().then((result) => {
  if (result !== undefined) process.stdout.write(JSON.stringify(result) + "\n")
}).catch((error) => {
  process.stderr.write(JSON.stringify({ error: { code: error instanceof ApiError ? error.code : "client_error",
    message: error instanceof ApiError ? error.message : "Cannot complete the local request" } }) + "\n")
  process.exitCode = 1
})
