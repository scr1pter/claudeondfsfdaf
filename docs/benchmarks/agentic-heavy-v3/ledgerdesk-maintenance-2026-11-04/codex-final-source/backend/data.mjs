import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  mkdirSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync,
  renameSync, unlinkSync, readdirSync, existsSync,
} from 'node:fs'
import { join } from 'node:path'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 200
const amount = (value, positive = false) => Number.isSafeInteger(value) && value >= (positive ? 1 : 0)
const planValid = value => object(value) && ['baseCents', 'includedUnits', 'unitCents'].every(key => amount(value[key]))
const periodValid = value => typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value)
const hash = value => createHash('sha256').update(value, 'utf8').digest('hex')
const copy = value => structuredClone(value)

export function fail(status, code, message) {
  const error = new Error(message)
  error.status = status
  error.code = code
  throw error
}

export function timestampValid(value) {
  if (typeof value !== 'string') return false
  const parts = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.exec(value)
  if (!parts || !Number.isFinite(Date.parse(value))) return false
  const [, y, m, d, h, minute, second, zone] = parts
  const month = Number(m)
  const last = new Date(0)
  last.setUTCFullYear(Number(y), month, 0)
  return month >= 1 && month <= 12 && Number(d) >= 1 && Number(d) <= last.getUTCDate()
    && Number(h) <= 23 && Number(minute) <= 59 && Number(second) <= 59
    && (zone.toUpperCase() === 'Z' || (Number(zone.slice(1, 3)) <= 23 && Number(zone.slice(4, 6)) <= 59))
}

// Construct JSON directly: JSON.stringify(object) reorders numeric-looking keys.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function check(condition, message = 'Invalid ledger data') {
  if (!condition) throw new Error(message)
}

function exactKeys(value, keys) {
  return object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function validateBase(accounts, usage) {
  check(Array.isArray(accounts) && Array.isArray(usage))
  const ids = new Set()
  const accountsById = new Map()
  for (const account of accounts) {
    check(exactKeys(account, ['id', 'workspaceId', 'name', 'plan']) && text(account.id) && text(account.workspaceId)
      && text(account.name) && exactKeys(account.plan, ['baseCents', 'includedUnits', 'unitCents']) && planValid(account.plan))
    check(!ids.has(account.id), 'Duplicate ledger identifier')
    ids.add(account.id)
    accountsById.set(account.id, account)
  }
  const events = new Set()
  for (const event of usage) {
    check(exactKeys(event, ['id', 'workspaceId', 'accountId', 'eventId', 'units', 'occurredAt'])
      && text(event.id) && text(event.eventId) && amount(event.units, true) && timestampValid(event.occurredAt))
    const account = accountsById.get(event.accountId)
    check(account && account.workspaceId === event.workspaceId, 'Invalid usage relationship')
    check(!ids.has(event.id), 'Duplicate ledger identifier')
    ids.add(event.id)
    const eventKey = JSON.stringify([event.accountId, event.eventId])
    check(!events.has(eventKey), 'Duplicate usage event identifier')
    events.add(eventKey)
  }
  return { ids, accountsById }
}

function validatePayload(payload) {
  check(exactKeys(payload, ['accounts', 'usage', 'invoices', 'credits', 'keys', 'idempotency']))
  const { ids, accountsById } = validateBase(payload.accounts, payload.usage)
  check(['invoices', 'credits', 'keys', 'idempotency'].every(key => Array.isArray(payload[key])))
  const invoicesById = new Map()
  const periods = new Set()
  for (const invoice of payload.invoices) {
    check(exactKeys(invoice, ['id', 'workspaceId', 'accountId', 'period', 'status', 'totalUnits', 'baseCents', 'includedUnits', 'unitCents', 'overageUnits', 'totalCents', 'creditedCents', 'balanceCents', 'lines']))
    const account = accountsById.get(invoice.accountId)
    check(text(invoice.id) && account && account.workspaceId === invoice.workspaceId && periodValid(invoice.period) && invoice.status === 'issued')
    check(['totalUnits', 'baseCents', 'includedUnits', 'unitCents', 'overageUnits', 'totalCents', 'creditedCents', 'balanceCents'].every(key => amount(invoice[key])))
    check(invoice.overageUnits === Math.max(0, invoice.totalUnits - invoice.includedUnits)
      && Number.isSafeInteger(invoice.overageUnits * invoice.unitCents)
      && invoice.totalCents === invoice.baseCents + invoice.overageUnits * invoice.unitCents
      && invoice.balanceCents === invoice.totalCents - invoice.creditedCents)
    check(Array.isArray(invoice.lines) && invoice.lines.length === 2)
    const [base, overage] = invoice.lines
    check(exactKeys(base, ['kind', 'quantity', 'unitCents', 'amountCents']) && base.kind === 'base'
      && base.quantity === 1 && base.unitCents === invoice.baseCents && base.amountCents === invoice.baseCents)
    check(exactKeys(overage, ['kind', 'quantity', 'unitCents', 'amountCents']) && overage.kind === 'overage'
      && overage.quantity === invoice.overageUnits && overage.unitCents === invoice.unitCents
      && overage.amountCents === invoice.overageUnits * invoice.unitCents)
    check(!ids.has(invoice.id), 'Duplicate ledger identifier')
    ids.add(invoice.id)
    const key = JSON.stringify([invoice.accountId, invoice.period])
    check(!periods.has(key), 'Duplicate invoice period')
    periods.add(key)
    invoicesById.set(invoice.id, invoice)
  }
  const creditsById = new Map()
  const creditTotals = new Map()
  for (const credit of payload.credits) {
    check(exactKeys(credit, ['id', 'workspaceId', 'invoiceId', 'amountCents', 'reason']) && text(credit.id)
      && amount(credit.amountCents, true) && text(credit.reason) && credit.reason === credit.reason.trim())
    const invoice = invoicesById.get(credit.invoiceId)
    check(invoice && invoice.workspaceId === credit.workspaceId && !ids.has(credit.id), 'Invalid credit relationship')
    ids.add(credit.id)
    creditsById.set(credit.id, credit)
    const total = (creditTotals.get(credit.invoiceId) || 0) + credit.amountCents
    check(amount(total) && total <= invoice.totalCents)
    creditTotals.set(credit.invoiceId, total)
  }
  for (const invoice of payload.invoices) check(invoice.creditedCents === (creditTotals.get(invoice.id) || 0))
  const keysById = new Map()
  const hashes = new Set()
  for (const key of payload.keys) {
    check(object(key) && Object.keys(key).every(name => ['id', 'hash', 'workspaceId', 'role', 'accountIds', 'revoked'].includes(name))
      && text(key.id) && text(key.workspaceId) && /^[a-f0-9]{64}$/.test(key.hash)
      && ['billing', 'reader'].includes(key.role) && typeof key.revoked === 'boolean')
    check(!ids.has(key.id) && !hashes.has(key.hash), 'Duplicate access key')
    ids.add(key.id)
    hashes.add(key.hash)
    if (Object.hasOwn(key, 'accountIds')) {
      check(Array.isArray(key.accountIds) && key.accountIds.length > 0 && new Set(key.accountIds).size === key.accountIds.length)
      for (const accountId of key.accountIds) check(accountsById.get(accountId)?.workspaceId === key.workspaceId)
    }
    keysById.set(key.id, key)
  }
  const requests = new Set()
  for (const record of payload.idempotency) {
    check(exactKeys(record, ['actorId', 'workspaceId', 'operation', 'resourceId', 'requestId', 'business', 'resultId', 'result'])
      && text(record.actorId) && text(record.workspaceId) && text(record.requestId)
      && ['issueInvoice', 'creditInvoice'].includes(record.operation) && object(record.business))
    const actor = bootstrapPrincipalById(record.actorId) || keysById.get(record.actorId)
    check(actor && actor.workspaceId === record.workspaceId && ['owner', 'billing'].includes(actor.role))
    const target = record.operation === 'issueInvoice' ? accountsById.get(record.resourceId) : invoicesById.get(record.resourceId)
    check(target && target.workspaceId === record.workspaceId)
    const accountId = record.operation === 'issueInvoice' ? target.id : target.accountId
    check(!actor.accountIds || actor.accountIds.includes(accountId))
    const result = record.operation === 'issueInvoice' ? invoicesById.get(record.resultId) : creditsById.get(record.resultId)
    check(result && result.workspaceId === record.workspaceId)
    if (record.operation === 'issueInvoice') {
      check(exactKeys(record.business, ['period']) && result.accountId === record.resourceId && result.period === record.business.period)
      check(canonical(record.result) === canonical({ ...result, creditedCents: 0, balanceCents: result.totalCents }))
    } else {
      check(exactKeys(record.business, ['amountCents', 'reason']) && result.invoiceId === record.resourceId
        && result.amountCents === record.business.amountCents && result.reason === record.business.reason)
      check(canonical(record.result) === canonical(result))
    }
    const identity = JSON.stringify([record.actorId, record.workspaceId, record.operation, record.resourceId, record.requestId])
    check(!requests.has(identity), 'Duplicate idempotency record')
    requests.add(identity)
  }
  check(payload.invoices.every(invoice => payload.idempotency.some(record => record.operation === 'issueInvoice' && record.resultId === invoice.id)))
  check(payload.credits.every(credit => payload.idempotency.some(record => record.operation === 'creditInvoice' && record.resultId === credit.id)))
}

const bootstrap = new Map([
  ['owner-acme', { id: 'bootstrap:owner-acme', workspaceId: 'acme', role: 'owner' }],
  ['billing-acme', { id: 'bootstrap:billing-acme', workspaceId: 'acme', role: 'billing' }],
  ['reader-acme', { id: 'bootstrap:reader-acme', workspaceId: 'acme', role: 'reader' }],
  ['owner-beta', { id: 'bootstrap:owner-beta', workspaceId: 'beta', role: 'owner' }],
])
const bootstrapPrincipalById = id => [...bootstrap.values()].find(value => value.id === id)

function takeLock(directory) {
  // Unique per-process claims avoid unlinking a newly acquired owner's lock during stale recovery.
  // Overlapping startups may conservatively both fail; they can never both acquire ownership.
  const lockDirectory = join(directory, 'ledger.lock')
  mkdirSync(lockDirectory, { recursive: true })
  const claim = `owner-${process.pid}-${randomUUID()}.lock`
  const ownPath = join(lockDirectory, claim)
  const fd = openSync(ownPath, 'wx', 0o600)
  try { writeFileSync(fd, claim); fsyncSync(fd) } finally { closeSync(fd) }
  let released = false
  const release = () => {
    if (released) return
    released = true
    try { if (readFileSync(ownPath, 'utf8') === claim) unlinkSync(ownPath) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  try {
    for (const entry of readdirSync(lockDirectory)) {
      if (entry === claim) continue
      const match = /^owner-([1-9]\d*)-[a-f0-9-]{36}\.lock$/.exec(entry)
      check(match, 'Unrecognized ownership lock; preserve it for inspection')
      let live = true
      try { process.kill(Number(match[1]), 0) } catch (error) { if (error.code === 'ESRCH') live = false }
      check(!live, 'The data directory is already owned by a live process')
      try { unlinkSync(join(lockDirectory, entry)) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  } catch (error) { release(); throw error }
  return release
}

function syncDirectory(directory) {
  // Windows disallows opening directories; file fsync + atomic replace remains the durable commit.
  if (process.platform === 'win32') return
  const fd = openSync(directory, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

function persist(directory, payload) {
  const filename = join(directory, 'ledger.json')
  const temporary = join(directory, `ledger.${process.pid}.${randomUUID()}.tmp`)
  const envelope = { version: 2, payload, checksum: hash(canonical(payload)) }
  const fd = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(fd, `${JSON.stringify(envelope)}\n`, 'utf8')
    fsyncSync(fd)
  } catch (error) {
    try { unlinkSync(temporary) } catch {}
    throw error
  } finally { closeSync(fd) }
  try { renameSync(temporary, filename) }
  catch (error) { try { unlinkSync(temporary) } catch {}; throw error }
  // Replacement is the commit boundary. The temporary file was already fsynced;
  // directory sync is an additional filesystem-dependent durability measure.
  // It must not turn a completed replacement into an apparent failed transaction
  // and leave the live payload behind its authoritative on-disk state.
  try { syncDirectory(directory) } catch {}
}

function freshPayload() { return { accounts: [], usage: [], invoices: [], credits: [], keys: [], idempotency: [] } }

function load(directory) {
  const filename = join(directory, 'ledger.json')
  if (!existsSync(filename)) {
    const payload = freshPayload()
    persist(directory, payload)
    return payload
  }
  const bytes = readFileSync(filename)
  const ledger = JSON.parse(bytes.toString('utf8'))
  check(object(ledger), 'Invalid ledger envelope')
  if (ledger.version === 1) {
    check(exactKeys(ledger, ['version', 'accounts', 'usage']), 'Invalid legacy ledger envelope')
    validateBase(ledger.accounts, ledger.usage)
    const payload = { ...freshPayload(), accounts: ledger.accounts, usage: ledger.usage }
    validatePayload(payload)
    const backup = join(directory, 'ledger.v1.backup.json')
    let fd
    try {
      fd = openSync(backup, 'wx', 0o600)
      writeFileSync(fd, bytes)
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      syncDirectory(directory)
    } catch (error) {
      if (fd !== undefined) closeSync(fd)
      if (error.code !== 'EEXIST') throw error
      check(readFileSync(backup).equals(bytes), 'Existing v1 backup differs; preserve both files for inspection')
    }
    persist(directory, payload)
    return payload
  }
  check(ledger.version === 2, 'Unsupported ledger schema version')
  check(exactKeys(ledger, ['version', 'payload', 'checksum']) && object(ledger.payload)
    && typeof ledger.checksum === 'string' && /^[a-f0-9]{64}$/.test(ledger.checksum), 'Invalid ledger envelope')
  check(hash(canonical(ledger.payload)) === ledger.checksum, 'Ledger checksum mismatch')
  validatePayload(ledger.payload)
  return ledger.payload
}

function requireRole(principal, roles) {
  if (!roles.includes(principal.role)) fail(403, 'forbidden', 'This operation requires a different role')
}

function accountFor(payload, principal, id) {
  const found = payload.accounts.find(value => value.id === id && value.workspaceId === principal.workspaceId
    && (!principal.accountIds || principal.accountIds.includes(value.id)))
  if (!found) fail(404, 'not_found', 'Account not found')
  return found
}

function invoiceFor(payload, principal, id) {
  const found = payload.invoices.find(value => value.id === id && value.workspaceId === principal.workspaceId)
  if (!found || (principal.accountIds && !principal.accountIds.includes(found.accountId))) fail(404, 'not_found', 'Invoice not found')
  return found
}

function periodBounds(period) {
  if (!periodValid(period)) fail(400, 'invalid_period', 'Period must be a valid YYYY-MM month')
  const start = new Date(`${period}-01T00:00:00.000Z`)
  const end = new Date(start)
  end.setUTCMonth(end.getUTCMonth() + 1)
  return [start.valueOf(), end.valueOf()]
}

function eventsFor(payload, account, period) {
  const events = payload.usage.filter(value => value.accountId === account.id && value.workspaceId === account.workspaceId)
  if (period === undefined || period === null) return events
  const [start, end] = periodBounds(period)
  return events.filter(value => Date.parse(value.occurredAt) >= start && Date.parse(value.occurredAt) < end)
}

function quoteFor(payload, account, period) {
  periodBounds(period)
  let totalUnits = 0
  for (const event of eventsFor(payload, account, period)) {
    totalUnits += event.units
    if (!Number.isSafeInteger(totalUnits)) fail(400, 'unsafe_arithmetic', 'Quote exceeds safe integer precision')
  }
  const overageUnits = Math.max(0, totalUnits - account.plan.includedUnits)
  const overageCents = overageUnits * account.plan.unitCents
  const totalCents = account.plan.baseCents + overageCents
  if (!Number.isSafeInteger(overageCents) || !Number.isSafeInteger(totalCents)) fail(400, 'unsafe_arithmetic', 'Quote exceeds safe integer precision')
  return { accountId: account.id, period, totalUnits, ...account.plan, overageUnits, totalCents }
}

function replay(payload, principal, operation, resourceId, requestId, business) {
  const old = payload.idempotency.find(value => value.actorId === principal.id && value.workspaceId === principal.workspaceId
    && value.operation === operation && value.resourceId === resourceId && value.requestId === requestId)
  if (!old) return undefined
  if (canonical(old.business) !== canonical(business)) fail(409, 'idempotency_conflict', 'Request ID was already used with different business fields')
  return old.result
}

function remember(payload, principal, operation, resourceId, requestId, business, result) {
  payload.idempotency.push({ actorId: principal.id, workspaceId: principal.workspaceId, operation, resourceId, requestId, business, resultId: result.id, result: copy(result) })
}

function executeMutation(payload, principal, operation, input) {
  if (operation === 'createAccount') {
    requireRole(principal, ['owner'])
    if (!text(input.name) || !planValid(input.plan)) fail(400, 'invalid_account', 'Name and nonnegative integer plan values are required')
    const value = { id: randomUUID(), workspaceId: principal.workspaceId, name: input.name.trim(),
      plan: { baseCents: input.plan.baseCents, includedUnits: input.plan.includedUnits, unitCents: input.plan.unitCents } }
    payload.accounts.push(value)
    return { status: 201, value }
  }
  if (operation === 'recordUsage') {
    const account = accountFor(payload, principal, input.accountId)
    requireRole(principal, ['owner', 'billing'])
    if (!text(input.eventId) || !amount(input.units, true) || !timestampValid(input.occurredAt)) fail(400, 'invalid_usage', 'Event ID, positive integer units and a valid timestamp are required')
    const existing = payload.usage.find(value => value.accountId === account.id && value.eventId === input.eventId)
    if (existing) {
      if (existing.units !== input.units || existing.occurredAt !== input.occurredAt) fail(409, 'usage_conflict', 'Event ID was already used with different business fields')
      return { status: 200, value: existing }
    }
    const value = { id: randomUUID(), workspaceId: principal.workspaceId, accountId: account.id,
      eventId: input.eventId, units: input.units, occurredAt: input.occurredAt }
    payload.usage.push(value)
    return { status: 201, value }
  }
  if (operation === 'issueInvoice') {
    const account = accountFor(payload, principal, input.accountId)
    requireRole(principal, ['owner', 'billing'])
    if (!periodValid(input.period) || !text(input.requestId)) fail(400, 'invalid_invoice', 'A valid period and request ID are required')
    const business = { period: input.period }
    const old = replay(payload, principal, operation, account.id, input.requestId, business)
    if (old) return { status: 200, value: old }
    if (payload.invoices.some(value => value.accountId === account.id && value.period === input.period)) fail(409, 'invoice_exists', 'An invoice is already issued for this account and period')
    const quote = quoteFor(payload, account, input.period)
    const value = { id: randomUUID(), workspaceId: principal.workspaceId, ...quote, status: 'issued', creditedCents: 0, balanceCents: quote.totalCents,
      lines: [{ kind: 'base', quantity: 1, unitCents: quote.baseCents, amountCents: quote.baseCents },
        { kind: 'overage', quantity: quote.overageUnits, unitCents: quote.unitCents, amountCents: quote.overageUnits * quote.unitCents }] }
    payload.invoices.push(value)
    remember(payload, principal, operation, account.id, input.requestId, business, value)
    return { status: 201, value }
  }
  if (operation === 'creditInvoice') {
    const invoice = invoiceFor(payload, principal, input.invoiceId)
    requireRole(principal, ['owner', 'billing'])
    if (!text(input.requestId) || !amount(input.amountCents, true) || !text(input.reason) || input.reason !== input.reason.trim()) fail(400, 'invalid_credit', 'Request ID, positive integer amount and a trimmed reason are required')
    const business = { amountCents: input.amountCents, reason: input.reason }
    const old = replay(payload, principal, operation, invoice.id, input.requestId, business)
    if (old) return { status: 200, value: old }
    if (input.amountCents > invoice.balanceCents) fail(409, 'credit_exceeds_total', 'Credit would exceed the invoice total')
    const value = { id: randomUUID(), workspaceId: principal.workspaceId, invoiceId: invoice.id, amountCents: input.amountCents, reason: input.reason }
    payload.credits.push(value)
    invoice.creditedCents += value.amountCents
    invoice.balanceCents -= value.amountCents
    remember(payload, principal, operation, invoice.id, input.requestId, business, value)
    return { status: 201, value }
  }
  if (operation === 'createKey') {
    requireRole(principal, ['owner'])
    if (!['billing', 'reader'].includes(input.role)) fail(400, 'invalid_key', 'Role must be billing or reader')
    if (Object.hasOwn(input, 'accountIds')) {
      if (!Array.isArray(input.accountIds) || !input.accountIds.length || new Set(input.accountIds).size !== input.accountIds.length
        || !input.accountIds.every(text)) fail(400, 'invalid_scope', 'Account scope must contain unique account IDs')
      for (const accountId of input.accountIds) accountFor(payload, principal, accountId)
    }
    const apiKey = `ld_${randomBytes(32).toString('base64url')}`
    const key = { id: randomUUID(), hash: hash(apiKey), workspaceId: principal.workspaceId, role: input.role,
      ...(Object.hasOwn(input, 'accountIds') ? { accountIds: [...input.accountIds] } : {}), revoked: false }
    payload.keys.push(key)
    return { status: 201, value: { id: key.id, apiKey, role: key.role, ...(key.accountIds ? { accountIds: [...key.accountIds] } : {}) } }
  }
  if (operation === 'revokeKey') {
    requireRole(principal, ['owner'])
    const key = payload.keys.find(value => value.id === input.keyId && value.workspaceId === principal.workspaceId)
    if (!key) fail(404, 'not_found', 'Access key not found')
    key.revoked = true
    return { status: 200, value: { revoked: true } }
  }
  fail(404, 'not_found', 'Operation not found')
}

export async function openStore(directory) {
  mkdirSync(directory, { recursive: true })
  const release = takeLock(directory)
  let payload
  try { payload = load(directory) } catch (error) { release(); throw error }
  let closed = false
  let queue = Promise.resolve()
  const authenticate = rawKey => {
    if (closed) fail(503, 'store_closed', 'The local service is closing')
    if (bootstrap.has(rawKey)) return copy(bootstrap.get(rawKey))
    const key = typeof rawKey === 'string' && rawKey.length ? payload.keys.find(value => value.hash === hash(rawKey) && !value.revoked) : undefined
    if (!key) fail(401, 'unauthorized', 'A valid API key is required')
    return { id: key.id, workspaceId: key.workspaceId, role: key.role, ...(key.accountIds ? { accountIds: [...key.accountIds] } : {}) }
  }
  return {
    authenticate,
    read(rawKey, operation, input = {}) {
      const principal = authenticate(rawKey)
      let result
      if (operation === 'listAccounts') result = payload.accounts.filter(value => value.workspaceId === principal.workspaceId && (!principal.accountIds || principal.accountIds.includes(value.id)))
      else if (operation === 'getAccount') result = accountFor(payload, principal, input.accountId)
      else if (operation === 'listUsage') result = eventsFor(payload, accountFor(payload, principal, input.accountId), input.period)
      else if (operation === 'quote') result = quoteFor(payload, accountFor(payload, principal, input.accountId), input.period)
      else if (operation === 'getInvoice') result = invoiceFor(payload, principal, input.invoiceId)
      else if (operation === 'listCredits') {
        const invoice = invoiceFor(payload, principal, input.invoiceId)
        result = payload.credits.filter(value => value.invoiceId === invoice.id && value.workspaceId === principal.workspaceId)
      } else fail(404, 'not_found', 'Operation not found')
      return copy(result)
    },
    mutate(rawKey, operation, input = {}) {
      const task = queue.then(() => {
        const principal = authenticate(rawKey)
        if (!object(input)) fail(400, 'invalid_body', 'A JSON object is required')
        const draft = copy(payload)
        const result = executeMutation(draft, principal, operation, input)
        validatePayload(draft)
        if (canonical(draft) !== canonical(payload)) {
          persist(directory, draft)
          payload = draft
        }
        return copy(result)
      })
      queue = task.catch(() => {})
      return task
    },
    close() {
      if (!closed) { closed = true; release() }
    },
  }
}
