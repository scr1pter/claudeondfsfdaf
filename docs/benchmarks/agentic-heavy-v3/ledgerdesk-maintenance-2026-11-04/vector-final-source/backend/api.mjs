import { createHash, randomBytes, randomUUID } from "node:crypto"
import { amount, fail, isObject, monthBounds, planValid, text, timestampValid } from "./validation.mjs"

const bootstrapKeys = new Map([
  ["owner-acme", { workspaceId: "acme", role: "owner" }],
  ["billing-acme", { workspaceId: "acme", role: "billing" }],
  ["reader-acme", { workspaceId: "acme", role: "reader" }],
  ["owner-beta", { workspaceId: "beta", role: "owner" }],
])

function identity(request, state) {
  const header = request.headers.authorization
  const key = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : ""
  const bootstrap = bootstrapKeys.get(key)
  if (bootstrap) return { ...bootstrap, actorId: key }
  const hash = createHash("sha256").update(key, "utf8").digest("hex")
  const found = key && state.keys.find((item) => item.hash === hash && !item.revoked)
  if (!found) fail(401, "unauthorized", "A valid API key is required")
  return { actorId: found.id, workspaceId: found.workspaceId, role: found.role, accountIds: found.accountIds }
}

function role(principal, allowed) {
  if (!allowed.includes(principal.role)) fail(403, "forbidden", "This operation requires a different role")
}

function visible(principal, accountId, workspaceId) {
  return workspaceId === principal.workspaceId
    && (!principal.accountIds || principal.accountIds.includes(accountId))
}

function account(state, principal, id) {
  const found = state.accounts.find((item) => item.id === id && visible(principal, item.id, item.workspaceId))
  if (!found) fail(404, "not_found", "Account not found")
  return found
}

function invoice(state, principal, id) {
  const found = state.invoices.find((item) => item.id === id && visible(principal, item.accountId, item.workspaceId))
  if (!found) fail(404, "not_found", "Invoice not found")
  return found
}

function events(state, found, period) {
  const selected = state.usage.filter((item) => item.workspaceId === found.workspaceId && item.accountId === found.id)
  if (period === null || period === undefined) return selected
  const [start, end] = monthBounds(period)
  return selected.filter((item) => {
    const timestamp = Date.parse(item.occurredAt)
    return timestamp >= start && timestamp < end
  })
}

function safe(value) {
  if (!amount(value)) fail(400, "unsafe_arithmetic", "Quote exceeds safe integer precision")
  return value
}

function quote(state, found, period) {
  monthBounds(period)
  const totalUnits = events(state, found, period).reduce((sum, item) => safe(sum + item.units), 0)
  const { baseCents, includedUnits, unitCents } = found.plan
  const overageUnits = Math.max(0, totalUnits - includedUnits)
  const totalCents = safe(baseCents + safe(overageUnits * unitCents))
  return { accountId: found.id, period, totalUnits, baseCents, includedUnits, unitCents, overageUnits, totalCents }
}

async function body(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 1_048_576) fail(413, "body_too_large", "JSON body exceeds the local limit")
    chunks.push(chunk)
  }
  let parsed
  try {
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))
    parsed = JSON.parse(raw)
  } catch {
    fail(400, "invalid_json", "A valid JSON object is required")
  }
  if (!isObject(parsed)) fail(400, "invalid_body", "A JSON object is required")
  return parsed
}

function respond(response, status, value) {
  if (response.destroyed) return
  const serialized = JSON.stringify(value)
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(serialized) })
  response.end(serialized)
}

function replay(state, principal, operation, resourceId, requestId, input) {
  const found = state.idempotency.find((item) => item.actorId === principal.actorId
    && item.workspaceId === principal.workspaceId && item.operation === operation
    && item.resourceId === resourceId && item.requestId === requestId)
  if (!found) return undefined
  const fields = Object.keys(input)
  if (Object.keys(found.input).length !== fields.length || fields.some((field) => found.input[field] !== input[field])) {
    fail(409, "idempotency_conflict", "Request ID was already used with different input")
  }
  const collection = operation === "invoice" ? state.invoices : state.credits
  const result = collection.find((item) => item.id === found.resultId)
  if (!result) throw new Error("Missing idempotency result")
  return result
}

function remember(state, principal, operation, resourceId, requestId, input, resultId) {
  state.idempotency.push({ actorId: principal.actorId, workspaceId: principal.workspaceId,
    operation, resourceId, requestId, input, resultId })
}

function issueInvoice(state, principal, accountId, input) {
  const found = account(state, principal, accountId)
  role(principal, ["owner", "billing"])
  monthBounds(input.period)
  if (!text(input.requestId)) fail(400, "invalid_request_id", "A nonempty request ID of at most 200 characters is required")
  const normalized = { period: input.period }
  const cached = replay(state, principal, "invoice", found.id, input.requestId, normalized)
  if (cached) return [200, cached]
  if (state.invoices.some((item) => item.accountId === found.id && item.workspaceId === found.workspaceId && item.period === input.period)) {
    fail(409, "invoice_exists", "An invoice has already been issued for this period")
  }
  const quoted = quote(state, found, input.period)
  const created = { id: randomUUID(), workspaceId: principal.workspaceId, ...quoted, status: "issued",
    creditedCents: 0, balanceCents: quoted.totalCents,
    lines: [
      { kind: "base", quantity: 1, unitCents: quoted.baseCents, amountCents: quoted.baseCents },
      { kind: "overage", quantity: quoted.overageUnits, unitCents: quoted.unitCents,
        amountCents: quoted.overageUnits * quoted.unitCents },
    ] }
  state.invoices.push(created)
  remember(state, principal, "invoice", found.id, input.requestId, normalized, created.id)
  return [201, created]
}

function creditInvoice(state, principal, invoiceId, input) {
  const found = invoice(state, principal, invoiceId)
  role(principal, ["owner", "billing"])
  if (!text(input.requestId) || !amount(input.amountCents, true) || !text(input.reason)) {
    fail(400, "invalid_credit", "Request ID, positive integer amount and nonempty reason are required")
  }
  const normalized = { amountCents: input.amountCents, reason: input.reason.trim() }
  const cached = replay(state, principal, "credit", found.id, input.requestId, normalized)
  if (cached) return [200, cached]
  if (input.amountCents > found.totalCents - found.creditedCents) {
    fail(409, "credit_exceeds_total", "Credit would exceed the invoice total")
  }
  const created = { id: randomUUID(), workspaceId: principal.workspaceId, invoiceId: found.id, ...normalized }
  state.credits.push(created)
  found.creditedCents += input.amountCents
  found.balanceCents = found.totalCents - found.creditedCents
  remember(state, principal, "credit", found.id, input.requestId, normalized, created.id)
  return [201, created]
}

export function createHandler(store) {
  async function mutate(request, callback) {
    const input = await body(request)
    // The whole read/authorize/check/write sequence is synchronous in the durable
    // transaction. In particular, never trust the pre-body authentication here.
    return store.transaction((state) => callback(state, identity(request, state), input))
  }

  async function route(request) {
    let url
    try {
      decodeURIComponent(request.url)
      url = new URL(request.url, "http://127.0.0.1")
    } catch {
      fail(400, "invalid_uri", "A valid request URI is required")
    }
    const { pathname, searchParams } = url
    const method = request.method
    if (method === "GET" && pathname === "/health") return [200, { ok: true, version: 2 }]
    const state = store.snapshot()
    const principal = identity(request, state)
    if (pathname === "/api/accounts" && method === "GET") {
      return [200, state.accounts.filter((item) => visible(principal, item.id, item.workspaceId))]
    }
    if (pathname === "/api/accounts" && method === "POST") {
      return mutate(request, (draft, actor, input) => {
        role(actor, ["owner"])
        if (!text(input.name) || !planValid(input.plan)) {
          fail(400, "invalid_account", "Name and nonnegative integer plan values are required")
        }
        const created = { id: randomUUID(), workspaceId: actor.workspaceId, name: input.name.trim(),
          plan: { baseCents: input.plan.baseCents, includedUnits: input.plan.includedUnits, unitCents: input.plan.unitCents } }
        draft.accounts.push(created)
        return [201, created]
      })
    }
    const accountMatch = /^\/api\/accounts\/([^/]+)(?:\/(usage|quote|invoices))?$/.exec(pathname)
    if (accountMatch) {
      const id = decodeURIComponent(accountMatch[1])
      const action = accountMatch[2]
      if (method === "POST" && action === "usage") {
        return mutate(request, (draft, actor, input) => {
          const found = account(draft, actor, id)
          role(actor, ["owner", "billing"])
          if (!text(input.eventId) || !amount(input.units, true) || !timestampValid(input.occurredAt)) {
            fail(400, "invalid_usage", "Event ID, positive integer units and a valid timestamp are required")
          }
          const duplicate = draft.usage.find((item) => item.accountId === found.id
            && item.workspaceId === found.workspaceId && item.eventId === input.eventId)
          if (duplicate) {
            if (duplicate.units !== input.units || duplicate.occurredAt !== input.occurredAt) {
              fail(409, "usage_conflict", "Event ID was already used with different input")
            }
            return [200, duplicate]
          }
          const created = { id: randomUUID(), workspaceId: actor.workspaceId, accountId: found.id,
            eventId: input.eventId, units: input.units, occurredAt: input.occurredAt }
          draft.usage.push(created)
          return [201, created]
        })
      }
      if (method === "POST" && action === "invoices") {
        return mutate(request, (draft, actor, input) => issueInvoice(draft, actor, id, input))
      }
      const found = account(state, principal, id)
      if (!action && method === "GET") return [200, found]
      if (action === "usage" && method === "GET") return [200, events(state, found, searchParams.get("period"))]
      if (action === "quote" && method === "GET") return [200, quote(state, found, searchParams.get("period"))]
    }
    const invoiceMatch = /^\/api\/invoices\/([^/]+)(?:\/(credits))?$/.exec(pathname)
    if (invoiceMatch) {
      const id = decodeURIComponent(invoiceMatch[1])
      if (method === "POST" && invoiceMatch[2] === "credits") {
        return mutate(request, (draft, actor, input) => creditInvoice(draft, actor, id, input))
      }
      const found = invoice(state, principal, id)
      if (method === "GET" && !invoiceMatch[2]) return [200, found]
      if (method === "GET" && invoiceMatch[2] === "credits") {
        return [200, state.credits.filter((item) => item.invoiceId === found.id && item.workspaceId === found.workspaceId)]
      }
    }
    if (pathname === "/api/access-keys" && method === "POST") {
      return mutate(request, (draft, actor, input) => {
        role(actor, ["owner"])
        if (!["billing", "reader"].includes(input.role)) fail(400, "invalid_key", "Role must be billing or reader")
        let accountIds
        if (Object.hasOwn(input, "accountIds")) {
          if (!Array.isArray(input.accountIds) || input.accountIds.length === 0
            || !input.accountIds.every(text) || new Set(input.accountIds).size !== input.accountIds.length) {
            fail(400, "invalid_key", "Account scope must be a nonempty array of unique account IDs")
          }
          accountIds = input.accountIds.map((id) => account(draft, actor, id).id)
        }
        const id = randomUUID()
        const apiKey = "ld_" + randomBytes(32).toString("base64url")
        const scope = accountIds ? { accountIds } : {}
        draft.keys.push({ id, hash: createHash("sha256").update(apiKey, "utf8").digest("hex"),
          workspaceId: actor.workspaceId, role: input.role, ...scope, revoked: false })
        return [201, { id, apiKey, role: input.role, ...scope }]
      })
    }
    const revokeMatch = /^\/api\/access-keys\/([^/]+)\/revoke$/.exec(pathname)
    if (revokeMatch && method === "POST") {
      const id = decodeURIComponent(revokeMatch[1])
      return mutate(request, (draft, actor, input) => {
        role(actor, ["owner"])
        if (Object.keys(input).length) fail(400, "invalid_body", "Revocation requires an empty JSON object")
        const found = draft.keys.find((item) => item.id === id && item.workspaceId === actor.workspaceId)
        if (!found) fail(404, "not_found", "Access key not found")
        found.revoked = true
        return [200, { revoked: true }]
      })
    }
    fail(404, "not_found", "Route not found")
  }

  return (request, response) => {
    route(request).then(([status, value]) => respond(response, status, value)).catch((error) => {
      if (response.headersSent) return response.destroy()
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500
      respond(response, status, { error: { code: status < 500 && text(error.code) ? error.code : "internal_error",
        message: status < 500 ? error.message : "The local service could not complete the request" } })
    })
  }
}
