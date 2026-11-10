import { isDeepStrictEqual } from "node:util"

export function fail(status, code, message) {
  throw Object.assign(new Error(message), { status, code })
}

export const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value)
export const text = value => typeof value === "string" && value.length <= 200 && value.trim().length > 0
export const amount = (value, positive = false) => Number.isSafeInteger(value) && value >= (positive ? 1 : 0)
export const planValid = value => isObject(value) &&
  amount(value.baseCents) && amount(value.includedUnits) && amount(value.unitCents)
export const periodValid = value => typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value)

export function monthBounds(period) {
  if (!periodValid(period)) fail(400, "invalid_period", "Period must be YYYY-MM")
  const [year, month] = period.split("-").map(Number)
  const start = new Date(0)
  start.setUTCFullYear(year, month - 1, 1)
  start.setUTCHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setUTCMonth(end.getUTCMonth() + 1)
  return [start.getTime(), end.getTime()]
}

export function timestampValid(value) {
  if (typeof value !== "string") return false
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/.exec(value)
  if (!match) return false
  const [, y, m, d, h, min, sec, , oh = "0", om = "0"] = match
  const year = Number(y), month = Number(m), day = Number(d)
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] &&
    Number(h) <= 23 && Number(min) <= 59 && Number(sec) <= 59 &&
    Number(oh) <= 23 && Number(om) <= 59 && Number.isFinite(Date.parse(value))
}

const invalid = () => fail(400, "invalid_data", "Invalid ledger data")
const requireThat = condition => { if (!condition) invalid() }

// Reject non-JSON values, accessors, exotic objects, holes and cycles before
// reading records. Transaction callers cannot smuggle changing getters into a commit.
function jsonData(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return
  if (typeof value === "number") return requireThat(Number.isFinite(value))
  requireThat(typeof value === "object" && value !== null && !ancestors.has(value))
  const array = Array.isArray(value)
  requireThat(array || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  const keys = Reflect.ownKeys(value)
  requireThat(keys.every(key => typeof key === "string"))
  if (array) requireThat(keys.length === value.length + 1 && keys.includes("length"))
  ancestors.add(value)
  for (const key of keys) {
    if (array && key === "length") continue
    if (array) requireThat(/^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    requireThat(Object.hasOwn(descriptor, "value") && descriptor.enumerable)
    jsonData(descriptor.value, ancestors)
  }
  ancestors.delete(value)
}

function shape(value, required, optional = []) {
  requireThat(isObject(value))
  const fields = Object.keys(value)
  requireThat(required.every(key => Object.hasOwn(value, key)) && fields.every(key => required.includes(key) || optional.includes(key)))
}

function records(values, fields, optional = []) {
  requireThat(Array.isArray(values))
  const byId = new Map()
  for (const value of values) {
    shape(value, fields, optional)
    requireThat(text(value.id) && text(value.workspaceId) && !byId.has(value.id))
    byId.set(value.id, value)
  }
  return byId
}

function safeSum(left, right) {
  const result = left + right
  requireThat(amount(result))
  return result
}

function safeProduct(left, right) {
  const result = left * right
  requireThat(amount(result))
  return result
}

const accountFields = ["id", "workspaceId", "name", "plan"]
const usageFields = ["id", "workspaceId", "accountId", "eventId", "units", "occurredAt"]
const invoiceFields = ["id", "workspaceId", "accountId", "period", "status", "totalUnits", "baseCents", "includedUnits", "unitCents", "overageUnits", "totalCents", "creditedCents", "balanceCents", "lines"]
const creditFields = ["id", "workspaceId", "invoiceId", "amountCents", "reason"]
const bootstrap = new Map([
  ["owner-acme", { workspaceId: "acme", role: "owner" }],
  ["billing-acme", { workspaceId: "acme", role: "billing" }],
  ["reader-acme", { workspaceId: "acme", role: "reader" }],
  ["owner-beta", { workspaceId: "beta", role: "owner" }],
])

function validateAccountsUsage(payload) {
  const accounts = records(payload.accounts, accountFields)
  for (const account of accounts.values()) {
    requireThat(text(account.name) && planValid(account.plan))
    shape(account.plan, ["baseCents", "includedUnits", "unitCents"])
  }
  const usage = records(payload.usage, usageFields)
  const events = new Set(), totals = new Map()
  for (const event of usage.values()) {
    requireThat(!accounts.has(event.id))
    const account = accounts.get(event.accountId)
    requireThat(account && account.workspaceId === event.workspaceId && text(event.eventId) && amount(event.units, true) && timestampValid(event.occurredAt))
    const businessId = JSON.stringify([event.accountId, event.eventId])
    requireThat(!events.has(businessId))
    events.add(businessId)
    const date = new Date(event.occurredAt)
    const group = JSON.stringify([event.accountId, date.getUTCFullYear(), date.getUTCMonth()])
    const total = safeSum(totals.get(group) || 0, event.units)
    totals.set(group, total)
    safeSum(account.plan.baseCents, safeProduct(Math.max(0, total - account.plan.includedUnits), account.plan.unitCents))
  }
  return accounts
}

export function validateLegacy(legacy) {
  jsonData(legacy)
  shape(legacy, ["version", "accounts", "usage"])
  requireThat(legacy.version === 1)
  validateAccountsUsage(legacy)
  return legacy
}

function preserve(previous, current, omit = []) {
  const currentById = new Map(current.map(record => [record.id, record]))
  const comparable = record => Object.fromEntries(Object.entries(record).filter(([key]) => !omit.includes(key)))
  for (const record of previous) {
    const next = currentById.get(record.id)
    requireThat(next && isDeepStrictEqual(comparable(record), comparable(next)))
  }
}

export function validatePayload(payload, previous) {
  jsonData(payload)
  shape(payload, ["accounts", "usage", "invoices", "credits", "keys", "idempotency"])
  const accounts = validateAccountsUsage(payload)
  const invoices = records(payload.invoices, invoiceFields)
  const periods = new Set()
  for (const invoice of invoices.values()) {
    const account = accounts.get(invoice.accountId)
    requireThat(account && account.workspaceId === invoice.workspaceId && periodValid(invoice.period) && invoice.status === "issued")
    for (const field of ["totalUnits", "baseCents", "includedUnits", "unitCents", "overageUnits", "totalCents", "creditedCents", "balanceCents"]) requireThat(amount(invoice[field]))
    requireThat(invoice.overageUnits === Math.max(0, invoice.totalUnits - invoice.includedUnits))
    const overage = safeProduct(invoice.overageUnits, invoice.unitCents)
    requireThat(invoice.totalCents === safeSum(invoice.baseCents, overage))
    requireThat(invoice.creditedCents <= invoice.totalCents && invoice.balanceCents === invoice.totalCents - invoice.creditedCents)
    requireThat(Array.isArray(invoice.lines) && invoice.lines.length === 2)
    const kinds = new Set()
    for (const line of invoice.lines) {
      shape(line, ["kind", "quantity", "unitCents", "amountCents"])
      requireThat((line.kind === "base" || line.kind === "overage") && !kinds.has(line.kind))
      kinds.add(line.kind)
      requireThat(amount(line.quantity) && amount(line.unitCents) && amount(line.amountCents))
      if (line.kind === "base") requireThat(line.quantity === 1 && line.unitCents === invoice.baseCents && line.amountCents === invoice.baseCents)
      else requireThat(line.quantity === invoice.overageUnits && line.unitCents === invoice.unitCents && line.amountCents === overage)
    }
    const unique = JSON.stringify([invoice.accountId, invoice.period])
    requireThat(!periods.has(unique))
    periods.add(unique)
  }
  const credits = records(payload.credits, creditFields)
  const credited = new Map()
  for (const credit of credits.values()) {
    const invoice = invoices.get(credit.invoiceId)
    requireThat(invoice && invoice.workspaceId === credit.workspaceId && amount(credit.amountCents, true) && text(credit.reason) && credit.reason === credit.reason.trim())
    credited.set(invoice.id, safeSum(credited.get(invoice.id) || 0, credit.amountCents))
  }
  for (const invoice of invoices.values()) requireThat(invoice.creditedCents === (credited.get(invoice.id) || 0))

  const keys = records(payload.keys, ["id", "hash", "workspaceId", "role", "revoked"], ["accountIds"])
  const entityIds = new Set()
  for (const collection of [payload.accounts, payload.usage, payload.invoices, payload.credits, payload.keys]) {
    for (const record of collection) {
      requireThat(!entityIds.has(record.id))
      entityIds.add(record.id)
    }
  }
  const hashes = new Set()
  for (const key of keys.values()) {
    requireThat(!bootstrap.has(key.id) && typeof key.hash === "string" && /^[a-f0-9]{64}$/.test(key.hash) && !hashes.has(key.hash))
    hashes.add(key.hash)
    requireThat((key.role === "reader" || key.role === "billing") && typeof key.revoked === "boolean")
    if (Object.hasOwn(key, "accountIds")) {
      requireThat(Array.isArray(key.accountIds) && key.accountIds.length > 0 && new Set(key.accountIds).size === key.accountIds.length)
      for (const id of key.accountIds) requireThat(text(id) && accounts.get(id)?.workspaceId === key.workspaceId)
    }
  }

  requireThat(Array.isArray(payload.idempotency))
  const requests = new Set(), results = new Set()
  for (const entry of payload.idempotency) {
    shape(entry, ["actorId", "workspaceId", "operation", "resourceId", "requestId", "input", "resultId"])
    for (const field of ["actorId", "workspaceId", "resourceId", "requestId", "resultId"]) requireThat(text(entry[field]))
    requireThat(entry.operation === "invoice" || entry.operation === "credit")
    const actor = bootstrap.get(entry.actorId) || keys.get(entry.actorId)
    requireThat(actor && actor.workspaceId === entry.workspaceId && (actor.role === "owner" || actor.role === "billing"))
    let accountId
    if (entry.operation === "invoice") {
      shape(entry.input, ["period"])
      const result = invoices.get(entry.resultId)
      requireThat(periodValid(entry.input.period) && result && result.workspaceId === entry.workspaceId && result.accountId === entry.resourceId && result.period === entry.input.period)
      accountId = result.accountId
    } else {
      shape(entry.input, ["amountCents", "reason"])
      const result = credits.get(entry.resultId)
      requireThat(result && result.workspaceId === entry.workspaceId && result.invoiceId === entry.resourceId && result.amountCents === entry.input.amountCents && result.reason === entry.input.reason)
      accountId = invoices.get(result.invoiceId).accountId
    }
    if (actor.accountIds) requireThat(actor.accountIds.includes(accountId))
    const identity = JSON.stringify([entry.actorId, entry.workspaceId, entry.operation, entry.resourceId, entry.requestId])
    const resultIdentity = JSON.stringify([entry.operation, entry.resultId])
    requireThat(!requests.has(identity) && !results.has(resultIdentity))
    requests.add(identity)
    results.add(resultIdentity)
  }
  requireThat(results.size === invoices.size + credits.size)

  if (previous) {
    for (const collection of ["accounts", "usage", "credits"]) preserve(previous[collection], payload[collection])
    preserve(previous.invoices, payload.invoices, ["creditedCents", "balanceCents"])
    preserve(previous.keys, payload.keys, ["revoked"])
    const currentKeys = new Map(payload.keys.map(key => [key.id, key]))
    for (const key of previous.keys) requireThat(!key.revoked || currentKeys.get(key.id).revoked)
    // Idempotency records have compound identities rather than public IDs.
    for (const entry of previous.idempotency) requireThat(payload.idempotency.some(next => isDeepStrictEqual(entry, next)))
  }
  return payload
}
