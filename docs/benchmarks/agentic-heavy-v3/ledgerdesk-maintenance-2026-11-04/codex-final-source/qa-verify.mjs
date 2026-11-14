import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient, ApiError } from './sdk.mjs'

const root = dirname(fileURLToPath(import.meta.url))
assert.ok(process.env.DATA_DIR, 'DATA_DIR required')
const dataRoot = resolve(process.env.DATA_DIR)
const relation = relative(root, dataRoot)
assert.ok(relation && (relation === '..' || relation.startsWith('..' + sep) || isAbsolute(relation)), 'DATA_DIR outside source required')
const directory = join(dataRoot, 'qa-' + randomUUID())
await mkdir(directory, { recursive: true })
const node = process.env.NODE_EXE || process.execPath
const port = Number(process.env.PORT || 4125)
const baseUrl = `http://127.0.0.1:${port}`
const children = new Set()
const results = []
const pause = ms => new Promise(done => setTimeout(done, ms))
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
    : JSON.stringify(value)

function launch(data, selectedPort = port) {
  const child = spawn(node, [join(root, 'app.mjs')], {
    cwd: root, env: { ...process.env, DATA_DIR: data, PORT: String(selectedPort) },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  child.logs = ''
  child.stdout.on('data', chunk => { child.logs += chunk })
  child.stderr.on('data', chunk => { child.logs += chunk })
  children.add(child)
  return child
}
async function stop(child, signal = 'SIGKILL') {
  if (!child) return
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit')
    child.kill(signal)
    await exited
  }
  children.delete(child)
}
async function start(data, selectedPort = port) {
  const child = launch(data, selectedPort)
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Startup failed: ' + child.logs)
    try {
      const response = await fetch(`http://127.0.0.1:${selectedPort}/health`, { signal: AbortSignal.timeout(100) })
      if (response.ok) return child
    } catch {}
    await pause(20)
  }
  throw new Error('Startup timeout')
}
async function expectExit(child) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) {
      assert.notEqual(child.exitCode, 0, child.logs)
      children.delete(child)
      return
    }
    await pause(20)
  }
  await stop(child)
  assert.fail('Expected startup failure; server stayed alive')
}
async function req(method, path, body, key = 'owner-acme') {
  const response = await fetch(baseUrl + path, {
    method, headers: { ...(key ? { authorization: 'Bearer ' + key } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000),
  })
  const value = await response.json()
  if (!response.ok) {
    assert.ok(value.error?.code)
    assert.ok(value.error?.message)
    assert.ok(!JSON.stringify(value).includes(key || 'no-key-sentinel'))
  }
  return { status: response.status, value }
}
async function status(method, path, body, key, expected) {
  const response = await req(method, path, body, key)
  assert.equal(response.status, expected, JSON.stringify(response))
  return response.value
}
const sdk = (apiKey = 'owner-acme') => createClient({ baseUrl, apiKey })
async function tool(args, env = {}) {
  const child = spawn(node, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const [code] = await once(child, 'exit')
  return { code, stdout, stderr }
}
async function group(name, action) {
  try {
    await action()
    results.push({ name, ok: true })
    process.stdout.write('QA PASS ' + name + '\n')
  } catch (error) {
    results.push({ name, ok: false, error: error.stack })
    process.stdout.write('QA FAIL ' + name + ': ' + error.message + '\n')
  } finally {
    for (const child of [...children]) await stop(child)
  }
}
async function ledger(data) {
  const envelope = JSON.parse(await readFile(join(data, 'ledger.json'), 'utf8'))
  assert.equal(envelope.version, 2)
  assert.equal(envelope.checksum, createHash('sha256').update(canonical(envelope.payload), 'utf8').digest('hex'))
  return envelope
}
async function slowRevoke(key, path, input) {
  const body = JSON.stringify(input)
  const request = httpRequest(baseUrl + path, { method: 'POST', headers: {
    authorization: 'Bearer ' + key.apiKey, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
  } })
  const response = new Promise((done, reject) => {
    request.on('error', reject)
    request.on('response', incoming => {
      let text = ''
      incoming.on('data', chunk => { text += chunk })
      incoming.on('end', () => done({ status: incoming.statusCode, value: JSON.parse(text) }))
    })
  })
  request.write(body.slice(0, 10))
  await pause(100)
  await sdk().revokeKey(key.id)
  request.end(body.slice(10))
  assert.equal((await response).status, 401)
}

await group('Complete lead regression harness and strict declaration consumer', async () => {
  const regression = await tool([join(root, 'verify.mjs')])
  await writeFile(join(directory, 'lead-regression.txt'), regression.stdout + regression.stderr)
  assert.equal(regression.code, 0, regression.stderr)
  const types = await tool([join(root, 'verify-types.mjs')])
  await writeFile(join(directory, 'strict-types.txt'), types.stdout + types.stderr)
  assert.equal(types.code, 0, types.stderr)
})

await group('Distinct invoice races and actor/account/workspace/operation request ID isolation', async () => {
  const data = join(directory, 'boundaries')
  await start(data)
  const plan = { baseCents: 100, includedUnits: 0, unitCents: 2 }
  const a = await sdk().createAccount({ name: 'Synthetic QA A', plan })
  const b = await sdk().createAccount({ name: 'Synthetic QA B', plan })
  const beta = await sdk('owner-beta').createAccount({ name: 'Synthetic QA Beta', plan })
  const id = 'same-request'
  const invoice = await sdk().issueInvoice(a.id, { period: '2026-01', requestId: id })
  const other = await sdk().issueInvoice(b.id, { period: '2026-01', requestId: id })
  const foreign = await sdk('owner-beta').issueInvoice(beta.id, { period: '2026-01', requestId: id })
  assert.notEqual(invoice.id, other.id)
  assert.notEqual(invoice.id, foreign.id)
  await status('POST', `/api/accounts/${a.id}/invoices`, { period: '2026-02', requestId: id }, 'owner-acme', 409)
  const anotherActor = await sdk('billing-acme').issueInvoice(a.id, { period: '2026-02', requestId: id })
  assert.equal(anotherActor.period, '2026-02')
  const credit = await sdk().creditInvoice(invoice.id, { requestId: id, amountCents: 10, reason: 'Synthetic QA' })
  const actorCredit = await sdk('billing-acme').creditInvoice(invoice.id, { requestId: id, amountCents: 10, reason: 'Synthetic QA' })
  assert.notEqual(credit.id, actorCredit.id)
  assert.equal((await sdk().getInvoice(invoice.id)).creditedCents, 20)
  const race = await Promise.all(Array.from({ length: 12 }, (_, i) => req('POST', `/api/accounts/${a.id}/invoices`, { period: '2026-03', requestId: 'distinct-' + i }, 'billing-acme')))
  assert.equal(race.filter(item => item.status === 201).length, 1)
  assert.equal(race.filter(item => item.status === 409).length, 11)
  const event = { eventId: 'same-event', units: 5, occurredAt: '2026-01-31T23:59:59.999Z' }
  const eventA = await sdk().recordUsage(a.id, event)
  const eventB = await sdk().recordUsage(b.id, event)
  assert.notEqual(eventA.id, eventB.id)
  await status('POST', `/api/accounts/${a.id}/usage`, { ...event, occurredAt: '2026-01-31T23:59:59.999+00:00' }, 'billing-acme', 409)
  await status('GET', `/api/accounts/${beta.id}`, undefined, 'reader-acme', 404)
  await status('POST', `/api/invoices/${foreign.id}/credits`, { requestId: id, amountCents: 1, reason: 'Synthetic' }, 'reader-acme', 404)
  await status('GET', '/missing', undefined, '', 404)
  await status('DELETE', `/api/accounts/${a.id}`, undefined, '', 404)
  const stored = await ledger(data)
  assert.equal(stored.payload.invoices.length, 5)
  assert.equal(stored.payload.credits.length, 2)
})

await group('Validation boundaries reject without business or idempotency writes', async () => {
  const data = join(directory, 'validation')
  await start(data)
  const a = await sdk().createAccount({ name: 'x'.repeat(200), plan: { baseCents: 0, includedUnits: 0, unitCents: 0 } })
  const original = await readFile(join(data, 'ledger.json'), 'utf8')
  for (const body of [null, [], 'invalid', {}, { name: 'x'.repeat(201), plan: { baseCents: 0, includedUnits: 0, unitCents: 0 } },
    { name: 'bad', plan: { baseCents: 0, includedUnits: 0, unitCents: Number.MAX_SAFE_INTEGER + 1 } }]) {
    await status('POST', '/api/accounts', body, 'owner-acme', 400)
  }
  for (const body of [{ period: '2026-01', requestId: 'r'.repeat(201) }, { period: '2026-1', requestId: 'r' }, { period: '2026-01', requestId: ' ' }]) {
    await status('POST', `/api/accounts/${a.id}/invoices`, body, 'billing-acme', 400)
  }
  for (const occurredAt of ['2026-04-31T00:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T00:00:00+00:60', '2025-02-29T00:00:00Z']) {
    await status('POST', `/api/accounts/${a.id}/usage`, { eventId: 'bad-date', units: 1, occurredAt }, 'billing-acme', 400)
  }
  assert.equal(await readFile(join(data, 'ledger.json'), 'utf8'), original)
  await sdk().recordUsage(a.id, { eventId: 'e'.repeat(200), units: Number.MAX_SAFE_INTEGER, occurredAt: '2024-02-29t12:00:00z' })
  await sdk().recordUsage(a.id, { eventId: 'overflow', units: 1, occurredAt: '2024-02-29T12:00:00Z' })
  await status('GET', `/api/accounts/${a.id}/quote?period=2024-02`, undefined, 'reader-acme', 400)
  await status('POST', `/api/accounts/${a.id}/invoices`, { period: '2024-02', requestId: 'overflow' }, 'billing-acme', 400)
  assert.equal((await ledger(data)).payload.invoices.length, 0)
})

await group('Streaming invoice/credit mutations and idempotent replays reauthorize revoked actors', async () => {
  const data = join(directory, 'streaming')
  await start(data)
  const a = await sdk().createAccount({ name: 'Synthetic streaming', plan: { baseCents: 50, includedUnits: 0, unitCents: 0 } })
  const invoice = await sdk().issueInvoice(a.id, { period: '2026-01', requestId: 'owner-invoice' })
  for (const kind of ['new-invoice', 'invoice-replay', 'new-credit', 'credit-replay']) {
    const key = await sdk().createKey({ role: 'billing', accountIds: [a.id] })
    let path, input
    if (kind.includes('invoice')) {
      path = `/api/accounts/${a.id}/invoices`
      input = { period: kind === 'invoice-replay' ? '2026-02' : '2026-03', requestId: kind }
      if (kind === 'invoice-replay') await sdk(key.apiKey).issueInvoice(a.id, input)
    } else {
      path = `/api/invoices/${invoice.id}/credits`
      input = { requestId: kind, amountCents: 2, reason: 'Synthetic streaming' }
      if (kind === 'credit-replay') await sdk(key.apiKey).creditInvoice(invoice.id, input)
    }
    const before = (await ledger(data)).payload
    await slowRevoke(key, path, input)
    const after = (await ledger(data)).payload
    assert.deepEqual(after.invoices, before.invoices)
    assert.deepEqual(after.credits, before.credits)
    assert.deepEqual(after.idempotency, before.idempotency)
    await status('POST', path, input, key.apiKey, 401)
  }
})

await group('CLI is connected and secret-safe; dynamic scope and all operations survive forced restart', async () => {
  const data = join(directory, 'restart')
  let server = await start(data)
  const a = await sdk().createAccount({ name: 'Synthetic restart', plan: { baseCents: 40, includedUnits: 0, unitCents: 3 } })
  const key = await sdk().createKey({ role: 'billing', accountIds: [a.id] })
  const reader = await sdk().createKey({ role: 'reader' })
  await sdk(key.apiKey).recordUsage(a.id, { eventId: 'persist', units: 2, occurredAt: '2026-01-01T00:00:00Z' })
  const invoice = await sdk(key.apiKey).issueInvoice(a.id, { period: '2026-01', requestId: 'persist' })
  const credit = await sdk(key.apiKey).creditInvoice(invoice.id, { requestId: 'persist', amountCents: 4, reason: 'Synthetic persistence' })
  await sdk().revokeKey(key.id)
  await stop(server)
  server = await start(data)
  assert.equal((await sdk(reader.apiKey).getInvoice(invoice.id)).balanceCents, 42)
  assert.deepEqual(await sdk(reader.apiKey).listCredits(invoice.id), [credit])
  await assert.rejects(sdk(key.apiKey).listAccounts(), error => error instanceof ApiError && error.status === 401)
  assert.ok(!(await readFile(join(data, 'ledger.json'), 'utf8')).includes(reader.apiKey))
  for (const args of [['accounts', 'list'], ['quote', a.id, '2026-01'], ['invoice', 'show', invoice.id]]) {
    const result = await tool([join(root, 'cli.mjs'), ...args], { LEDGER_URL: baseUrl, LEDGER_KEY: reader.apiKey })
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.stderr, '')
    JSON.parse(result.stdout)
    assert.equal(result.stdout.trim().split('\n').length, 1)
  }
  for (const args of [['invoice', 'issue', a.id, '2026-02', 'blocked'], ['unknown'], ['credit', 'add', invoice.id, 'bad', 'NaN', 'invalid']]) {
    const result = await tool([join(root, 'cli.mjs'), ...args], { LEDGER_URL: baseUrl, LEDGER_KEY: reader.apiKey })
    assert.notEqual(result.code, 0)
    assert.equal(result.stdout, '')
    assert.ok(JSON.parse(result.stderr).error.code)
    assert.ok(!result.stderr.includes(reader.apiKey))
  }
  await stop(server)
  const network = await tool([join(root, 'cli.mjs'), 'accounts', 'list'], { LEDGER_URL: baseUrl, LEDGER_KEY: 'synthetic-secret-no-server' })
  assert.notEqual(network.code, 0)
  assert.equal(network.stdout, '')
  assert.ok(JSON.parse(network.stderr).error.code)
  assert.ok(!network.stderr.includes('synthetic-secret-no-server'))
})

await group('V1 migration preserves bytes/values and backup; invalid legacy and correctly-checksummed invalid V2 refuse', async () => {
  const account = { id: 'legacy', workspaceId: 'acme', name: '  Synthetic \u96ea \ud83d\ude80  ', plan: { baseCents: 0, includedUnits: 0, unitCents: 3 } }
  const usage = { id: 'event', workspaceId: 'acme', accountId: 'legacy', eventId: '  synthetic-event  ', units: 1, occurredAt: '2024-02-29T23:59:59+02:00' }
  const data = join(directory, 'migration')
  await mkdir(data, { recursive: true })
  const original = Buffer.from(' \r\n' + JSON.stringify({ version: 1, accounts: [account], usage: [usage] }, null, '\t') + '\r\n', 'utf8')
  await writeFile(join(data, 'ledger.json'), original)
  let server = await start(data)
  assert.deepEqual(await sdk().listAccounts(), [account])
  assert.deepEqual(await sdk().listUsage(account.id), [usage])
  assert.deepEqual(await readFile(join(data, 'ledger.v1.backup.json')), original)
  await ledger(data)
  await stop(server)
  server = await start(data)
  await sdk().recordUsage(account.id, { eventId: 'new', units: 2, occurredAt: '2026-01-01T00:00:00Z' })
  assert.deepEqual(await readFile(join(data, 'ledger.v1.backup.json')), original)
  await stop(server)
  const badPayload = { accounts: [account], usage: [{ ...usage, accountId: 'missing' }], invoices: [], credits: [], keys: [], idempotency: [] }
  const cases = [
    { version: 1, accounts: [account], usage: [usage, { ...usage, id: 'event-2' }] },
    { version: 1, accounts: [account], usage: [{ ...usage, id: account.id }] },
    { version: 1, accounts: [account], usage: [{ ...usage, units: 0 }] },
    { version: 1, accounts: [account], usage: [{ ...usage, occurredAt: '2024-02-30T00:00:00Z' }] },
    { version: 2, payload: badPayload, checksum: createHash('sha256').update(canonical(badPayload), 'utf8').digest('hex') },
  ]
  for (let index = 0; index < cases.length; index++) {
    const rejected = join(directory, 'invalid-' + index)
    await mkdir(rejected, { recursive: true })
    const bytes = Buffer.from(JSON.stringify(cases[index]))
    await writeFile(join(rejected, 'ledger.json'), bytes)
    await expectExit(launch(rejected))
    assert.deepEqual(await readFile(join(rejected, 'ledger.json')), bytes)
    assert.ok(!(await readdir(rejected)).includes('ledger.v1.backup.json'))
  }
})

await group('Process lock rejects a different-port owner, preserves live claims, recovers crash and simultaneous contenders', async () => {
  const data = join(directory, 'ownership')
  const server = await start(data)
  const before = await readdir(join(data, 'ledger.lock'))
  await expectExit(launch(data, port + 1))
  assert.deepEqual(await readdir(join(data, 'ledger.lock')), before)
  assert.equal((await req('GET', '/health')).status, 200)
  await stop(server)
  const recovered = await start(data)
  await stop(recovered)
  const racing = join(directory, 'simultaneous')
  const contenders = [launch(racing), launch(racing, port + 1)]
  await pause(600)
  const live = contenders.filter(child => child.exitCode === null && child.signalCode === null)
  assert.ok(live.length <= 1, 'Two live owners acquired one directory')
  for (const child of contenders) await stop(child)
  const retry = await start(racing)
  assert.equal((await req('GET', '/health')).status, 200)
  await stop(retry)
})

const report = {
  ok: results.every(result => result.ok), role: 'qa_specialist', directory, results,
  limitations: ['Local Windows process-crash checks do not simulate power loss or filesystem hardware failure.', 'Browser inspection is optional for this API/CLI/typed SDK workload and was not used.'],
}
await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
process.stdout.write(JSON.stringify(report) + '\n')
process.exitCode = report.ok ? 0 : 1
