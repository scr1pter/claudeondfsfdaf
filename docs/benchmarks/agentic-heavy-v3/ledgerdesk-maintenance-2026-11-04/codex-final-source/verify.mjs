import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ApiError, createClient } from './sdk.mjs'

// Synthetic behavior tests only. All generated files are beneath DATA_DIR.
const root = dirname(fileURLToPath(import.meta.url))
const dataRoot = process.env.DATA_DIR && resolve(process.env.DATA_DIR)
if (!dataRoot || dataRoot === root || dataRoot.startsWith(root + sep)) {
  throw new Error('Verification requires DATA_DIR outside the source directory')
}
const runDir = join(dataRoot, 'verification-' + randomUUID())
await mkdir(runDir, { recursive: true })
const port = Number(process.env.PORT || 4125)
const baseUrl = `http://127.0.0.1:${port}`
const node = process.env.NODE_EXE || process.execPath
const checks = []
let server
let serverOutput = ''
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function launch(directory, selectedPort = port) {
  const child = spawn(node, [join(root, 'app.mjs')], {
    cwd: root, env: { ...process.env, DATA_DIR: directory, PORT: String(selectedPort) },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  child.output = () => output
  return child
}

async function start(directory) {
  serverOutput = ''
  server = launch(directory)
  for (let attempt = 0; attempt < 150; attempt++) {
    if (server.exitCode !== null) throw new Error('Server failed to start: ' + server.output())
    try {
      const response = await fetch(baseUrl + '/health', { signal: AbortSignal.timeout(300) })
      if (response.ok) return
    } catch {}
    await sleep(30)
  }
  throw new Error('Server startup timed out: ' + server.output())
}

async function stop(signal = 'SIGTERM') {
  if (!server) return
  const child = server
  server = undefined
  if (child.exitCode === null && child.signalCode === null) {
    const ended = once(child, 'exit')
    child.kill(signal)
    await Promise.race([ended, sleep(4000).then(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    })])
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
  }
  serverOutput = child.output()
}

async function api(method, path, input, key = 'owner-acme', expected = 200) {
  const response = await fetch(baseUrl + path, {
    method, headers: { ...(key ? { authorization: 'Bearer ' + key } : {}),
      ...(input === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    signal: AbortSignal.timeout(5000),
  })
  const result = await response.json()
  assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(result)}`)
  if (expected >= 400) {
    assert.equal(typeof result.error?.code, 'string')
    assert.ok(result.error.code.length)
    assert.equal(typeof result.error?.message, 'string')
    assert.ok(result.error.message.length)
  }
  return result
}

function sdk(key = 'owner-acme') { return createClient({ baseUrl, apiKey: key }) }

async function command(args, key = 'owner-acme') {
  const child = spawn(node, [join(root, 'cli.mjs'), ...args], {
    cwd: root, env: { ...process.env, LEDGER_URL: baseUrl, LEDGER_KEY: key },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const [code] = await once(child, 'exit')
  return { code, stdout, stderr }
}

async function check(name, action) {
  await action()
  checks.push(name)
  process.stdout.write('PASS ' + name + '\n')
}

const canonical = (value) => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}

async function stored(directory) {
  const document = JSON.parse(await readFile(join(directory, 'ledger.json'), 'utf8'))
  assert.equal(document.version, 2)
  assert.match(document.checksum, /^[a-f0-9]{64}$/)
  assert.equal(document.checksum, createHash('sha256').update(canonical(document.payload)).digest('hex'))
  return document
}

async function refuses(directory, original) {
  const child = launch(directory)
  const exit = await Promise.race([once(child, 'exit'), sleep(4000).then(() => undefined)])
  if (!exit) { child.kill('SIGKILL'); await once(child, 'exit'); assert.fail('Invalid store was served') }
  assert.notEqual(exit[0], 0, child.output())
  assert.equal(await readFile(join(directory, 'ledger.json'), 'utf8'), original)
}

const primary = join(runDir, 'primary')
let account, invoice, scopedKey, credit, persistentReaderKey, scopedInvoice, scopedCredit
try {
  await start(primary)
  await check('Fresh v2, health, authentication, role and route behavior', async () => {
    assert.deepEqual(await api('GET', '/health'), { ok: true, version: 2 })
    await api('GET', '/api/accounts', undefined, '', 401)
    await api('GET', '/api/accounts', undefined, 'unknown-synthetic', 401)
    await api('POST', '/api/accounts', { name: 'forbidden', plan: { baseCents: 0, includedUnits: 0, unitCents: 0 } }, 'billing-acme', 403)
    await api('GET', '/api/not-a-route', undefined, 'owner-acme', 404)
    await stored(primary)
  })
  await check('SDK accounts, usage, UTC month filtering and exact replay', async () => {
    account = await sdk().createAccount({ name: 'Synthetic 雪 account', plan: { baseCents: 100, includedUnits: 10, unitCents: 3 } })
    assert.equal(account.workspaceId, 'acme')
    assert.equal(account.name, 'Synthetic 雪 account')
    assert.ok((await sdk().listAccounts()).some((item) => item.id === account.id))
    await api('GET', '/api/accounts/' + account.id, undefined, 'owner-beta', 404)
    assert.deepEqual(await sdk('owner-beta').listAccounts(), [])
    const path = `/api/accounts/${account.id}/usage`
    const input = { eventId: 'parallel-usage', units: 15, occurredAt: '2026-01-31T23:30:00-01:00' }
    const events = await Promise.all(Array.from({ length: 8 }, () => fetch(baseUrl + path, {
      method: 'POST', headers: { authorization: 'Bearer billing-acme', 'content-type': 'application/json' }, body: JSON.stringify(input),
    }).then(async (response) => ({ status: response.status, event: await response.json() }))))
    assert.equal(events.filter((item) => item.status === 201).length, 1)
    assert.equal(events.filter((item) => item.status === 200).length, 7)
    assert.equal(new Set(events.map((item) => item.event.id)).size, 1)
    await api('POST', path, { ...input, units: 16 }, 'billing-acme', 409)
    assert.equal((await sdk().listUsage(account.id, '2026-01')).length, 0)
    assert.equal((await sdk().listUsage(account.id, '2026-02')).length, 1)
    assert.equal((await sdk().listUsage(account.id)).length, 1)
    assert.equal((await sdk().quote(account.id, '2026-02')).totalCents, 115)
    assert.equal((await sdk().recordUsage(account.id, input)).id, events[0].event.id)
  })
  await check('Malformed inputs, impossible dates and unsafe arithmetic reject without writes', async () => {
    const path = `/api/accounts/${account.id}/usage`
    for (const input of [null, [], 'string', { eventId: '', units: 1, occurredAt: '2026-01-01T00:00:00Z' },
      { eventId: 'bad', units: 1.5, occurredAt: '2026-01-01T00:00:00Z' },
      { eventId: 'bad', units: 1, occurredAt: '2026-02-30T00:00:00Z' },
      { eventId: 'bad', units: 1, occurredAt: '2026-01-01T00:00:00' },
      { eventId: 'bad', units: 1, occurredAt: '2026-01-01T00:00:00+24:00' }]) {
      await api('POST', path, input, 'billing-acme', 400)
    }
    for (const period of ['2026-13', '2026-00', '26-01', '']) {
      await api('GET', `/api/accounts/${account.id}/quote?period=${period}`, undefined, 'reader-acme', 400)
    }
    assert.equal((await sdk().listUsage(account.id)).length, 1)
    const large = await sdk().createAccount({ name: 'Synthetic overflow', plan: { baseCents: Number.MAX_SAFE_INTEGER, includedUnits: 0, unitCents: 1 } })
    await sdk().recordUsage(large.id, { eventId: 'large', units: 1, occurredAt: '2026-02-01T00:00:00Z' })
    await api('GET', `/api/accounts/${large.id}/quote?period=2026-02`, undefined, 'owner-acme', 400)
    await api('POST', `/api/accounts/${large.id}/invoices`, { period: '2026-02', requestId: 'unsafe' }, 'billing-acme', 400)
  })
  await check('Invoice concurrency, immutable snapshots and idempotency boundaries', async () => {
    const path = `/api/accounts/${account.id}/invoices`
    const input = { period: '2026-02', requestId: 'invoice-once' }
    const results = await Promise.all(Array.from({ length: 6 }, () => fetch(baseUrl + path, {
      method: 'POST', headers: { authorization: 'Bearer billing-acme', 'content-type': 'application/json' }, body: JSON.stringify(input),
    }).then(async (response) => ({ status: response.status, result: await response.json() }))))
    assert.equal(results.filter((item) => item.status === 201).length, 1)
    assert.equal(results.filter((item) => item.status === 200).length, 5)
    assert.equal(new Set(results.map((item) => item.result.id)).size, 1)
    invoice = results[0].result
    assert.equal(invoice.status, 'issued')
    assert.equal(invoice.totalCents, 115)
    assert.deepEqual(invoice.lines, [
      { kind: 'base', quantity: 1, unitCents: 100, amountCents: 100 },
      { kind: 'overage', quantity: 5, unitCents: 3, amountCents: 15 },
    ])
    await api('POST', path, { ...input, period: '2026-03' }, 'billing-acme', 409)
    await api('POST', path, { ...input, requestId: 'other' }, 'billing-acme', 409)
    await api('POST', path, input, 'owner-acme', 409)
    await sdk().recordUsage(account.id, { eventId: 'late', units: 10, occurredAt: '2026-02-20T00:00:00Z' })
    assert.equal((await sdk().quote(account.id, '2026-02')).totalCents, 145)
    assert.deepEqual(await sdk('reader-acme').getInvoice(invoice.id), invoice)
    await api('GET', `/api/invoices/${invoice.id}`, undefined, 'owner-beta', 404)
    await api('POST', path, { period: '2026-04', requestId: 'reader' }, 'reader-acme', 403)
  })
  await check('Credits serialize, prevent over-credit, replay and preserve failed request IDs', async () => {
    const path = `/api/invoices/${invoice.id}/credits`
    const input = { requestId: 'credit-once', amountCents: 40, reason: 'Synthetic adjustment' }
    credit = await api('POST', path, input, 'billing-acme', 201)
    assert.deepEqual(await api('POST', path, input, 'billing-acme', 200), credit)
    await api('POST', path, { ...input, amountCents: 41 }, 'billing-acme', 409)
    await api('POST', path, { requestId: 'retry-failed', amountCents: 100, reason: 'Too much' }, 'billing-acme', 409)
    await api('POST', path, { requestId: 'retry-failed', amountCents: 5, reason: 'Valid retry' }, 'billing-acme', 201)
    const outcomes = await Promise.all(['a', 'b'].map((requestId) => fetch(baseUrl + path, {
      method: 'POST', headers: { authorization: 'Bearer billing-acme', 'content-type': 'application/json' },
      body: JSON.stringify({ requestId, amountCents: 40, reason: 'Concurrent credit' }),
    }).then((response) => response.status)))
    assert.deepEqual(outcomes.sort(), [201, 409])
    const current = await sdk().getInvoice(invoice.id)
    assert.equal(current.creditedCents, 85)
    assert.equal(current.balanceCents, 30)
    assert.equal((await sdk().listCredits(invoice.id)).length, 3)
    await api('POST', path, { requestId: 'bad', amountCents: 0, reason: 'invalid' }, 'billing-acme', 400)
    await api('POST', path, { requestId: 'bad', amountCents: 1, reason: '   ' }, 'billing-acme', 400)
    await api('POST', path, { requestId: 'bad', amountCents: 1, reason: 'forbidden' }, 'reader-acme', 403)
  })
  await check('Scoped dynamic keys, workspace isolation and persisted hash only', async () => {
    scopedKey = await sdk().createKey({ role: 'billing', accountIds: [account.id] })
    persistentReaderKey = await sdk().createKey({ role: 'reader' })
    assert.ok(scopedKey.apiKey.length >= 32)
    assert.deepEqual(scopedKey.accountIds, [account.id])
    assert.equal((await sdk(scopedKey.apiKey).listAccounts()).length, 1)
    const others = (await sdk().listAccounts()).filter((item) => item.id !== account.id)
    await api('GET', '/api/accounts/' + others[0].id, undefined, scopedKey.apiKey, 404)
    await api('POST', '/api/access-keys', { role: 'reader' }, scopedKey.apiKey, 403)
    await api('POST', '/api/access-keys', { role: 'owner' }, 'owner-acme', 400)
    await api('POST', '/api/access-keys', { role: 'reader', accountIds: [] }, 'owner-acme', 400)
    await api('POST', '/api/access-keys', { role: 'reader', accountIds: [account.id, account.id] }, 'owner-acme', 400)
    await api('POST', `/api/access-keys/${scopedKey.id}/revoke`, {}, 'owner-beta', 404)
    scopedInvoice = await sdk(scopedKey.apiKey).issueInvoice(account.id, { period: '2026-05', requestId: 'scoped-issue' })
    scopedCredit = await sdk(scopedKey.apiKey).creditInvoice(scopedInvoice.id, {
      requestId: 'scoped-credit', amountCents: 1, reason: 'Synthetic scoped credit',
    })
    assert.equal(scopedCredit.invoiceId, scopedInvoice.id)
    assert.equal((await sdk(scopedKey.apiKey).listCredits(scopedInvoice.id)).length, 1)
    const otherInvoice = await sdk().issueInvoice(others[0].id, { period: '2026-06', requestId: 'other-account' })
    await api('GET', `/api/invoices/${otherInvoice.id}`, undefined, scopedKey.apiKey, 404)
    await api('GET', `/api/invoices/${otherInvoice.id}/credits`, undefined, scopedKey.apiKey, 404)
    const raw = await readFile(join(primary, 'ledger.json'), 'utf8')
    assert.ok(!raw.includes(scopedKey.apiKey))
    assert.ok(!raw.includes(persistentReaderKey.apiKey))
    await stored(primary)
  })
  await check('Revocation while a mutation body streams is reauthorized at commit', async () => {
    const input = JSON.stringify({ eventId: 'must-never-commit', units: 2, occurredAt: '2026-02-10T00:00:00Z' })
    const req = httpRequest(baseUrl + `/api/accounts/${account.id}/usage`, {
      method: 'POST', headers: { authorization: 'Bearer ' + scopedKey.apiKey, 'content-type': 'application/json', 'content-length': Buffer.byteLength(input) },
    })
    const received = new Promise((resolve, reject) => {
      req.on('error', reject)
      req.on('response', (response) => {
        let body = ''
        response.on('data', (chunk) => { body += chunk })
        response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }))
      })
    })
    req.write(input.slice(0, 20))
    await sleep(80)
    assert.deepEqual(await sdk().revokeKey(scopedKey.id), { revoked: true })
    req.end(input.slice(20))
    assert.equal((await received).status, 401)
    assert.deepEqual(await sdk().revokeKey(scopedKey.id), { revoked: true })
    await api('GET', '/api/accounts', undefined, scopedKey.apiKey, 401)
    await api('POST', `/api/accounts/${account.id}/invoices`, { period: '2026-05', requestId: 'scoped-issue' }, scopedKey.apiKey, 401)
    await api('POST', `/api/invoices/${scopedInvoice.id}/credits`, {
      requestId: 'scoped-credit', amountCents: 1, reason: 'Synthetic scoped credit',
    }, scopedKey.apiKey, 401)
    assert.ok(!(await sdk().listUsage(account.id)).some((item) => item.eventId === 'must-never-commit'))
  })
  await check('CLI legacy and invoice/credit commands, JSON channels and failures', async () => {
    for (const args of [['accounts', 'list'], ['quote', account.id, '2026-02'],
      ['usage', 'add', account.id, 'cli-event', '3', '2026-03-01T00:00:00Z'],
      ['invoice', 'issue', account.id, '2026-03', 'cli-invoice']]) {
      const result = await command(args)
      assert.equal(result.code, 0, result.stderr)
      assert.equal(result.stderr, '')
      JSON.parse(result.stdout)
    }
    const issued = await sdk().issueInvoice(account.id, { period: '2026-03', requestId: 'cli-invoice' })
    const shown = await command(['invoice', 'show', issued.id])
    assert.equal(shown.code, 0, shown.stderr)
    assert.equal(JSON.parse(shown.stdout).id, issued.id)
    const credited = await command(['credit', 'add', issued.id, 'cli-credit', '10', 'Synthetic CLI credit'])
    assert.equal(credited.code, 0, credited.stderr)
    assert.equal(JSON.parse(credited.stdout).amountCents, 10)
    const created = await command(['accounts', 'create', 'Synthetic CLI account', '1', '0', '2'])
    assert.equal(created.code, 0, created.stderr)
    const cliAccount = JSON.parse(created.stdout)
    for (const args of [['accounts', 'show', cliAccount.id], ['usage', 'list', account.id, '2026-03'], ['credit', 'list', issued.id]]) {
      const result = await command(args)
      assert.equal(result.code, 0, result.stderr)
      assert.equal(result.stderr, '')
      JSON.parse(result.stdout)
    }
    const keyed = await command(['key', 'create', 'reader', cliAccount.id])
    assert.equal(keyed.code, 0, keyed.stderr)
    const cliKey = JSON.parse(keyed.stdout)
    assert.deepEqual((await sdk(cliKey.apiKey).listAccounts()).map((item) => item.id), [cliAccount.id])
    const revoked = await command(['key', 'revoke', cliKey.id])
    assert.equal(revoked.code, 0, revoked.stderr)
    assert.deepEqual(JSON.parse(revoked.stdout), { revoked: true })
    for (const args of [['unknown'], ['invoice', 'issue'], ['credit', 'add', issued.id, 'bad', '1.5', 'invalid'], ['quote', account.id, 'bad']]) {
      const result = await command(args)
      assert.notEqual(result.code, 0)
      assert.equal(result.stdout, '')
      assert.ok(JSON.parse(result.stderr).error.code)
      assert.ok(!result.stderr.includes('owner-acme'))
    }
    const denied = await command(['accounts', 'list'], 'synthetic-secret-invalid')
    assert.notEqual(denied.code, 0)
    assert.equal(denied.stdout, '')
    assert.ok(!denied.stderr.includes('synthetic-secret-invalid'))
    assert.equal((await command(['--help'])).code, 0)
    await assert.rejects(sdk('invalid').listAccounts(), (error) => error instanceof ApiError && error.status === 401 && typeof error.code === 'string')
  })
  await check('Exclusive process lock and forced-stop recovery preserve committed operations', async () => {
    // A different port ensures a bind conflict cannot hide missing data ownership.
    const second = launch(primary, port === 65535 ? 65534 : port + 1)
    const exit = await Promise.race([once(second, 'exit'), sleep(4000).then(() => undefined)])
    if (!exit) { second.kill('SIGKILL'); await once(second, 'exit'); assert.fail('Second owner did not fail') }
    assert.notEqual(exit[0], 0)
    assert.equal((await sdk().getInvoice(invoice.id)).balanceCents, 30)
    await stop('SIGKILL')
    await start(primary)
    assert.equal((await sdk().getInvoice(invoice.id)).balanceCents, 30)
    assert.deepEqual((await sdk().listCredits(invoice.id)).find((item) => item.id === credit.id), credit)
    assert.deepEqual(await api('POST', `/api/accounts/${account.id}/invoices`, { period: '2026-02', requestId: 'invoice-once' }, 'billing-acme', 200), invoice)
    assert.deepEqual(await api('POST', `/api/invoices/${invoice.id}/credits`, { requestId: 'credit-once', amountCents: 40, reason: 'Synthetic adjustment' }, 'billing-acme', 200), credit)
    await api('GET', '/api/accounts', undefined, scopedKey.apiKey, 401)
    assert.ok((await sdk(persistentReaderKey.apiKey).listAccounts()).some((item) => item.id === account.id))
    assert.equal((await sdk(persistentReaderKey.apiKey).getInvoice(scopedInvoice.id)).balanceCents, 99)
    const event = (await sdk().listUsage(account.id)).find((item) => item.eventId === 'parallel-usage')
    assert.equal((await api('POST', `/api/accounts/${account.id}/usage`, { eventId: event.eventId, units: event.units, occurredAt: event.occurredAt }, 'billing-acme', 200)).id, event.id)
    await stored(primary)
    await stop()
  })
  await check('Exact-byte v1 migration, Unicode checksum and immutable backup on restart', async () => {
    const directory = join(runDir, 'migration')
    await mkdir(directory, { recursive: true })
    const legacy = { version: 1, accounts: [{ id: 'legacy-a', workspaceId: 'acme', name: 'Synthetic café 雪', plan: { baseCents: 50, includedUnits: 0, unitCents: 2 } }],
      usage: [{ id: 'legacy-u', workspaceId: 'acme', accountId: 'legacy-a', eventId: 'legacy-e', units: 5, occurredAt: '2026-01-10T00:00:00Z' }] }
    const bytes = '  ' + JSON.stringify(legacy, null, 3) + '\r\n'
    await writeFile(join(directory, 'ledger.json'), bytes)
    await start(directory)
    assert.deepEqual(await sdk().listAccounts(), legacy.accounts)
    assert.deepEqual(await sdk().listUsage('legacy-a'), legacy.usage)
    assert.equal((await sdk().quote('legacy-a', '2026-01')).totalCents, 60)
    assert.equal(await readFile(join(directory, 'ledger.v1.backup.json'), 'utf8'), bytes)
    await stored(directory)
    await stop()
    await start(directory)
    assert.equal(await readFile(join(directory, 'ledger.v1.backup.json'), 'utf8'), bytes)
    assert.equal((await sdk().issueInvoice('legacy-a', { period: '2026-01', requestId: 'migrated' })).totalCents, 60)
    await stop()
  })
  await check('Malformed and corrupt stores fail closed without replacing evidence', async () => {
    const legacyAccount = { id: 'a', workspaceId: 'acme', name: 'Synthetic', plan: { baseCents: 0, includedUnits: 0, unitCents: 0 } }
    const originals = [
      '{broken JSON', JSON.stringify({ version: 99 }),
      JSON.stringify({ version: 1, accounts: [legacyAccount, legacyAccount], usage: [] }),
      JSON.stringify({ version: 1, accounts: [legacyAccount], usage: [{ id: 'u', workspaceId: 'beta', accountId: 'a', eventId: 'e', units: 1, occurredAt: '2026-01-01T00:00:00Z' }] }),
      JSON.stringify({ version: 1, accounts: [{ ...legacyAccount, plan: { baseCents: -1, includedUnits: 0, unitCents: 0 } }], usage: [] }),
    ]
    const corrupt = JSON.parse(await readFile(join(primary, 'ledger.json'), 'utf8'))
    corrupt.checksum = '0'.repeat(64)
    originals.push(JSON.stringify(corrupt))
    for (let i = 0; i < originals.length; i++) {
      const directory = join(runDir, 'rejected-' + i)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'ledger.json'), originals[i])
      await refuses(directory, originals[i])
    }
  })
  const report = { ok: true, checks, runDir, interfaces: ['API', 'CLI', 'SDK runtime'], browser: 'Not required: API/CLI/typed SDK workload' }
  await writeFile(join(runDir, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  process.stdout.write(JSON.stringify(report) + '\n')
} catch (error) {
  const report = { ok: false, checks, error: error.stack, serverOutput: server?.output() || serverOutput, runDir }
  await writeFile(join(runDir, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  throw error
} finally {
  await stop()
}
