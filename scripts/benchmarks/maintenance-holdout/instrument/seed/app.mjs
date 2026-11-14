import { createServer } from "node:http"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const directory = process.env.DATA_DIR || join(process.cwd(), "data")
const filename = join(directory, "ledger.json")
mkdirSync(directory, { recursive: true })

function fail(status, code, message) {
  const error = new Error(message)
  error.status = status
  error.code = code
  throw error
}

function text(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200
}

function amount(value, positive = false) {
  return Number.isSafeInteger(value) && value >= (positive ? 1 : 0)
}

function planValid(plan) {
  return plan && typeof plan === "object" && !Array.isArray(plan)
    && amount(plan.baseCents) && amount(plan.includedUnits) && amount(plan.unitCents)
}

function timestampValid(value) {
  if (typeof value !== "string") return false
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (!parts || !Number.isFinite(Date.parse(value))) return false
  const year = Number(parts[1])
  const month = Number(parts[2])
  const day = Number(parts[3])
  const date = new Date(0)
  date.setUTCFullYear(year, month, 0)
  if (month < 1 || month > 12 || day < 1 || day > date.getUTCDate()) return false
  return Number(parts[4]) <= 23 && Number(parts[5]) <= 59 && Number(parts[6]) <= 59
}

function monthBounds(period) {
  if (typeof period !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    fail(400, "invalid_period", "Period must be a valid YYYY-MM month")
  }
  const start = new Date(`${period}-01T00:00:00.000Z`)
  const end = new Date(start)
  end.setUTCMonth(end.getUTCMonth() + 1)
  return [start.valueOf(), end.valueOf()]
}

const state = existsSync(filename)
  ? JSON.parse(readFileSync(filename, "utf8"))
  : { version: 1, accounts: [], usage: [] }
if (state.version !== 1 || !Array.isArray(state.accounts) || !Array.isArray(state.usage)) {
  throw new Error("Legacy LedgerDesk requires a version 1 store with account and usage arrays")
}

function save() {
  writeFileSync(filename, JSON.stringify(state, null, 2) + "\n", "utf8")
}
if (!existsSync(filename)) save()

const bootstrapKeys = new Map([
  ["owner-acme", { workspaceId: "acme", role: "owner" }],
  ["billing-acme", { workspaceId: "acme", role: "billing" }],
  ["reader-acme", { workspaceId: "acme", role: "reader" }],
  ["owner-beta", { workspaceId: "beta", role: "owner" }],
])

function identity(request) {
  const header = request.headers.authorization
  const key = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : ""
  const principal = bootstrapKeys.get(key)
  if (!principal) fail(401, "unauthorized", "A valid API key is required")
  return principal
}

function role(principal, allowed) {
  if (!allowed.includes(principal.role)) fail(403, "forbidden", "This operation requires a different role")
}

function account(principal, id) {
  const found = state.accounts.find((item) => item.id === id && item.workspaceId === principal.workspaceId)
  if (!found) fail(404, "not_found", "Account not found")
  return found
}

function events(found, period) {
  const selected = state.usage.filter((item) => item.workspaceId === found.workspaceId && item.accountId === found.id)
  if (period === null || period === undefined) return selected
  const bounds = monthBounds(period)
  return selected.filter((item) => Date.parse(item.occurredAt) >= bounds[0] && Date.parse(item.occurredAt) < bounds[1])
}

function quote(found, period) {
  const totalUnits = events(found, period).reduce((sum, item) => sum + item.units, 0)
  const overageUnits = Math.max(0, totalUnits - found.plan.includedUnits)
  const totalCents = found.plan.baseCents + overageUnits * found.plan.unitCents
  if (!Number.isSafeInteger(totalUnits) || !Number.isSafeInteger(totalCents)) {
    fail(400, "unsafe_arithmetic", "Quote exceeds safe integer precision")
  }
  return { accountId: found.id, period, totalUnits, ...found.plan, overageUnits, totalCents }
}

async function body(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 1_048_576) fail(413, "body_too_large", "JSON body exceeds the local limit")
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString("utf8")
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    fail(400, "invalid_json", "A valid JSON object is required")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(400, "invalid_body", "A JSON object is required")
  }
  return parsed
}

function respond(response, status, value) {
  const serialized = JSON.stringify(value)
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(serialized) })
  response.end(serialized)
}

async function route(request, response) {
  const url = new URL(request.url, "http://127.0.0.1")
  if (request.method === "GET" && url.pathname === "/health") {
    return respond(response, 200, { ok: true, version: 1 })
  }
  const principal = identity(request)
  if (url.pathname === "/api/accounts" && request.method === "GET") {
    return respond(response, 200, state.accounts.filter((item) => item.workspaceId === principal.workspaceId))
  }
  if (url.pathname === "/api/accounts" && request.method === "POST") {
    role(principal, ["owner"])
    const input = await body(request)
    if (!text(input.name) || !planValid(input.plan)) fail(400, "invalid_account", "Name and nonnegative integer plan values are required")
    const created = { id: randomUUID(), workspaceId: principal.workspaceId, name: input.name.trim(),
      plan: { baseCents: input.plan.baseCents, includedUnits: input.plan.includedUnits, unitCents: input.plan.unitCents } }
    state.accounts.push(created)
    save()
    return respond(response, 201, created)
  }
  const match = /^\/api\/accounts\/([^/]+)(?:\/(usage|quote))?$/.exec(url.pathname)
  if (!match) fail(404, "not_found", "Route not found")
  const found = account(principal, decodeURIComponent(match[1]))
  if (!match[2] && request.method === "GET") return respond(response, 200, found)
  if (match[2] === "usage" && request.method === "GET") return respond(response, 200, events(found, url.searchParams.get("period")))
  if (match[2] === "quote" && request.method === "GET") {
    const period = url.searchParams.get("period")
    monthBounds(period)
    return respond(response, 200, quote(found, period))
  }
  if (match[2] === "usage" && request.method === "POST") {
    role(principal, ["owner", "billing"])
    const input = await body(request)
    if (!text(input.eventId) || !amount(input.units, true) || !timestampValid(input.occurredAt)) {
      fail(400, "invalid_usage", "Event ID, positive integer units and a valid timestamp are required")
    }
    const created = { id: randomUUID(), workspaceId: principal.workspaceId, accountId: found.id,
      eventId: input.eventId, units: input.units, occurredAt: input.occurredAt }
    state.usage.push(created)
    save()
    return respond(response, 201, created)
  }
  fail(404, "not_found", "Route not found")
}

const server = createServer((request, response) => {
  route(request, response).catch((error) => {
    if (response.headersSent) return response.destroy()
    const status = Number.isInteger(error.status) ? error.status : 500
    respond(response, status, { error: { code: error.code || "internal_error",
      message: status < 500 ? error.message : "The local service could not complete the request" } })
  })
})
server.on("error", () => {
  process.stderr.write(JSON.stringify({ error: { code: "server_start_failed", message: "Cannot bind the local service" } }) + "\n")
  process.exitCode = 1
})
server.listen(Number(process.env.PORT || 4125), "127.0.0.1")
process.on("SIGTERM", () => server.close(() => process.exit(0)))
process.on("SIGINT", () => server.close(() => process.exit(0)))
