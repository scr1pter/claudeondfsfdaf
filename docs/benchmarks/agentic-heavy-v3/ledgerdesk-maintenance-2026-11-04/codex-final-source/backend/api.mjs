const MAX_BODY_BYTES = 1_048_576

function failure(status, code, message) {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

function fail(status, code, message) { throw failure(status, code, message) }

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 200
const amount = (value, positive = false) => Number.isSafeInteger(value) && value >= (positive ? 1 : 0)

function validPeriod(value) {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    fail(400, 'invalid_period', 'Period must be a valid YYYY-MM month')
  }
}

function validTimestamp(value) {
  if (typeof value !== 'string') return false
  const parts = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.exec(value)
  if (!parts || !Number.isFinite(Date.parse(value))) return false
  const [, year, month, day, hour, minute, second, zone] = parts
  const last = new Date(0)
  last.setUTCFullYear(Number(year), Number(month), 0)
  return Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= last.getUTCDate()
    && Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59
    && (zone.toUpperCase() === 'Z' || (Number(zone.slice(1, 3)) <= 23 && Number(zone.slice(4, 6)) <= 59))
}

function requireRole(principal, roles) {
  if (!roles.includes(principal.role)) fail(403, 'forbidden', 'This operation requires a different role')
}

function decodeId(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    fail(400, 'invalid_path', 'The resource path is invalid')
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const cleanup = () => {
      request.removeListener('data', onData)
      request.removeListener('end', onEnd)
      request.removeListener('error', onError)
      request.removeListener('aborted', onAborted)
    }
    const stop = error => {
      if (settled) return
      settled = true
      cleanup()
      // Drain the remainder without retaining it, so a size failure can still
      // return its JSON response over the current connection.
      request.once('error', () => {})
      request.resume()
      reject(error)
    }
    const onError = () => stop(failure(400, 'invalid_body', 'The JSON body could not be read'))
    const onAborted = onError
    const onData = chunk => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        stop(failure(413, 'body_too_large', 'JSON body exceeds the local limit'))
      } else chunks.push(chunk)
    }
    const onEnd = () => {
      if (settled) return
      settled = true
      cleanup()
      let parsed
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
        reject(failure(400, 'invalid_json', 'A valid JSON object is required'))
        return
      }
      if (!object(parsed)) {
        reject(failure(400, 'invalid_body', 'A JSON object is required'))
        return
      }
      resolve(parsed)
    }
    request.on('data', onData)
    request.once('end', onEnd)
    request.once('error', onError)
    request.once('aborted', onAborted)
  })
}

function respond(response, status, value) {
  const serialized = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(serialized),
    'cache-control': 'no-store',
  })
  response.end(serialized)
}

function validateAccount(input) {
  if (!text(input.name) || !object(input.plan)
    || !['baseCents', 'includedUnits', 'unitCents'].every(key => amount(input.plan[key]))) {
    fail(400, 'invalid_account', 'Name and nonnegative integer plan values are required')
  }
}

function validateUsage(input) {
  if (!text(input.eventId) || !amount(input.units, true) || !validTimestamp(input.occurredAt)) {
    fail(400, 'invalid_usage', 'Event ID, positive integer units and a valid timestamp are required')
  }
}

function validateInvoice(input) {
  validPeriod(input.period)
  if (!text(input.requestId)) fail(400, 'invalid_request_id', 'A nonempty request ID of at most 200 characters is required')
}

function validateCredit(input) {
  if (!text(input.requestId) || !amount(input.amountCents, true) || !text(input.reason) || input.reason !== input.reason.trim()) {
    fail(400, 'invalid_credit', 'Request ID, positive integer amount and a trimmed reason are required')
  }
}

function validateKey(input) {
  if (!['billing', 'reader'].includes(input.role)) fail(400, 'invalid_key', 'Key role must be billing or reader')
  if (Object.hasOwn(input, 'accountIds') && (!Array.isArray(input.accountIds) || input.accountIds.length === 0
    || !input.accountIds.every(text) || new Set(input.accountIds).size !== input.accountIds.length)) {
    fail(400, 'invalid_scope', 'Account scope must be a nonempty array of unique account IDs')
  }
}

export function createHandler(store) {
  async function route(request, response) {
    let url
    try { url = new URL(request.url, 'http://127.0.0.1') } catch {
      fail(400, 'invalid_path', 'The resource path is invalid')
    }
    const method = request.method
    const path = url.pathname
    if (method === 'GET' && path === '/health') return respond(response, 200, { ok: true, version: 2 })

    // Match the complete method and path before authentication: unknown routes
    // have the same 404 contract whether or not credentials were supplied.
    const accounts = path === '/api/accounts' && ['GET', 'POST'].includes(method)
    const accountMatch = /^\/api\/accounts\/([^/]+)(?:\/(usage|quote|invoices))?$/.exec(path)
    const accountRoute = accountMatch && ((!accountMatch[2] && method === 'GET')
      || (accountMatch[2] === 'usage' && ['GET', 'POST'].includes(method))
      || (accountMatch[2] === 'quote' && method === 'GET')
      || (accountMatch[2] === 'invoices' && method === 'POST'))
    const invoiceMatch = /^\/api\/invoices\/([^/]+)(?:\/(credits))?$/.exec(path)
    const invoiceRoute = invoiceMatch && ((!invoiceMatch[2] && method === 'GET')
      || (invoiceMatch[2] === 'credits' && ['GET', 'POST'].includes(method)))
    const newKey = path === '/api/access-keys' && method === 'POST'
    const revokeMatch = /^\/api\/access-keys\/([^/]+)\/revoke$/.exec(path)
    const revokeKey = revokeMatch && method === 'POST'
    if (!accounts && !accountRoute && !invoiceRoute && !newKey && !revokeKey) fail(404, 'not_found', 'Route not found')

    const header = request.headers.authorization
    const rawKey = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : ''
    const principal = await store.authenticate(rawKey)
    const authorizedBody = async () => {
      let input
      try { input = await readBody(request) } catch (error) {
        await store.authenticate(rawKey)
        throw error
      }
      await store.authenticate(rawKey)
      return input
    }
    const commit = async (operation, input) => {
      // The store authenticates the raw key again inside its serialized commit.
      // A principal captured before an incomplete request body is never trusted.
      const result = await store.mutate(rawKey, operation, input)
      return respond(response, result.status, result.value)
    }

    if (accounts) {
      if (method === 'GET') return respond(response, 200, await store.read(rawKey, 'listAccounts'))
      requireRole(principal, ['owner'])
      const input = await authorizedBody()
      validateAccount(input)
      return commit('createAccount', { name: input.name, plan: input.plan })
    }

    if (accountRoute) {
      const accountId = decodeId(accountMatch[1])
      const account = await store.read(rawKey, 'getAccount', { accountId })
      const operation = accountMatch[2]
      if (!operation) return respond(response, 200, account)
      if (method === 'GET') {
        const period = url.searchParams.get('period')
        if (operation === 'quote' || period !== null) validPeriod(period)
        return respond(response, 200, await store.read(rawKey, operation === 'quote' ? 'quote' : 'listUsage',
          { accountId, ...(period !== null ? { period } : {}) }))
      }
      requireRole(principal, ['owner', 'billing'])
      const input = await authorizedBody()
      if (operation === 'usage') {
        validateUsage(input)
        return commit('recordUsage', { accountId, eventId: input.eventId, units: input.units, occurredAt: input.occurredAt })
      }
      validateInvoice(input)
      return commit('issueInvoice', { accountId, period: input.period, requestId: input.requestId })
    }

    if (invoiceRoute) {
      const invoiceId = decodeId(invoiceMatch[1])
      const invoice = await store.read(rawKey, 'getInvoice', { invoiceId })
      if (!invoiceMatch[2]) return respond(response, 200, invoice)
      if (method === 'GET') return respond(response, 200, await store.read(rawKey, 'listCredits', { invoiceId }))
      requireRole(principal, ['owner', 'billing'])
      const input = await authorizedBody()
      validateCredit(input)
      return commit('creditInvoice', { invoiceId, requestId: input.requestId, amountCents: input.amountCents, reason: input.reason })
    }

    requireRole(principal, ['owner'])
    const input = await authorizedBody()
    if (newKey) {
      validateKey(input)
      return commit('createKey', { role: input.role, ...(Object.hasOwn(input, 'accountIds') ? { accountIds: input.accountIds } : {}) })
    }
    if (Object.keys(input).length !== 0) fail(400, 'invalid_body', 'Key revocation requires an empty JSON object')
    return commit('revokeKey', { keyId: decodeId(revokeMatch[1]) })
  }

  return (request, response) => {
    route(request, response).catch(error => {
      if (response.headersSent || response.destroyed) return response.destroy()
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500
      const code = status < 500 && typeof error.code === 'string' && error.code.length ? error.code : 'internal_error'
      const message = status < 500 && typeof error.message === 'string' && error.message.length
        ? error.message : 'The local service could not complete the request'
      respond(response, status, { error: { code, message } })
    })
  }
}
