import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, RelayError } from '../sdk.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const cliPath = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const token = 'synthetic-client-capability';
const leaseToken = 'synthetic-lease-secret';
const csv = '\ufeffop,external_id,name,email\r\nupsert,m1,"Synthetic, Person",person@example.test\r\n';
const importRecord = {
  id: 'imp-001', workspaceId: 'sample', creator: 'editor', baseVersion: 0,
  state: 'staged', rowCount: 1, digest: 'a'.repeat(64), leaseEpoch: 0, approvedBy: null,
};
const requests = [];
let server;
let baseUrl;
let directory;
let csvPath;

function responseFor(path) {
  if (path.endsWith('/members')) return { version: 1, members: [{ externalId: 'm1', name: 'Synthetic', email: 'person@example.test', revision: 1 }] };
  if (path.includes('/events')) return { events: [{ cursor: 1, type: 'workspace.created', subject: 'owner', importId: null }], nextCursor: 1 };
  if (path.endsWith('/claim')) return { import: { ...importRecord, state: 'leased', leaseEpoch: 1, approvedBy: 'approver' }, leaseToken, expiresAt: Date.now() + 5000 };
  if (path.endsWith('/commit')) return { import: { ...importRecord, state: 'committed', leaseEpoch: 1, approvedBy: 'approver' }, version: 1, applied: 1 };
  if (path.endsWith('/approve')) return { import: { ...importRecord, state: 'approved', approvedBy: 'approver' } };
  if (path.endsWith('/cancel')) return { import: { ...importRecord, state: 'cancelled' } };
  if (path.endsWith('/imports')) return { import: importRecord };
  return { workspace: { id: 'sample', name: 'Synthetic workspace', version: 0 } };
}

before(async () => {
  const dataDir = process.env.DATA_DIR;
  assert.ok(dataDir && isAbsolute(dataDir), 'DATA_DIR must be an absolute external directory');
  const distance = relative(sourceRoot, resolve(dataDir));
  assert.ok(distance.startsWith('..') || isAbsolute(distance), 'DATA_DIR must be outside source');
  await mkdir(dataDir, { recursive: true });
  directory = await mkdtemp(join(dataDir, 'relay-client-test-'));
  csvPath = join(directory, 'synthetic.csv');
  await writeFile(csvPath, csv);
  server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: request.method, path: request.url, headers: request.headers,
        body: text ? JSON.parse(text) : undefined });
      response.setHeader('Content-Type', 'application/json');
      if (request.url.includes('/transport')) { request.socket.destroy(); return; }
      if (request.url.includes('/malformed/')) { response.end('{}'); return; }
      if (request.url.includes('/leakraw')) {
        response.statusCode = 500;
        response.end(`${token} ${baseUrl} ${leaseToken}`);
        return;
      }
      if (request.url.includes('/badjson')) { response.end('{broken'); return; }
      if (request.url.includes('/badshape')) { response.end('{"workspace":{"version":"wrong"}}'); return; }
      if (request.url.includes('/empty')) { response.statusCode = 204; response.end(); return; }
      if (request.url.includes('/baderror')) { response.statusCode = 502; response.end('{"error":null}'); return; }
      if (request.url.includes('/upstream')) {
        response.statusCode = 409;
        response.end(JSON.stringify({ error: { code: 'VERSION_CONFLICT', message: 'Synthetic version conflict.' } }));
        return;
      }
      if (request.url.includes('/leak')) {
        response.statusCode = 403;
        response.end(JSON.stringify({ error: { code: `${token} ${baseUrl} ${leaseToken}`, message: `${token} ${baseUrl} ${leaseToken}` } }));
        return;
      }
      if (request.url.includes('/redirect')) {
        response.statusCode = 302;
        response.setHeader('Location', `${baseUrl}/v1/workspaces/sample`);
        response.end('{}');
        return;
      }
      if (request.method === 'POST' && request.url.endsWith('/imports')) response.statusCode = 201;
      response.end(JSON.stringify(responseFor(request.url)));
    } catch {
      response.statusCode = 500;
      response.end('{"error":{"code":"MOCK_ERROR","message":"Synthetic mock failure."}}');
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) {
    await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

function cli(args, env = {}, cwd = sourceRoot) {
  return new Promise((resolveChild, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: { ...process.env, RELAY_URL: baseUrl, RELAY_TOKEN: token, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolveChild({ code, signal, stdout, stderr }));
  });
}

function assertFailure(result, secrets = [token, baseUrl, leaseToken]) {
  assert.equal(result.code, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim().split('\n').length, 1);
  const parsed = JSON.parse(result.stderr);
  assert.equal(typeof parsed.error.code, 'string');
  assert.equal(typeof parsed.error.message, 'string');
  for (const secret of secrets) if (secret) assert.ok(!result.stderr.includes(secret), 'error must not echo secrets');
  return parsed.error;
}

test('SDK implements every method and exact HTTP request contract', async () => {
  const start = requests.length;
  const client = createClient({ baseUrl: `${baseUrl}/`, token });
  assert.deepEqual(await client.workspace('sample'), responseFor('/sample'));
  assert.deepEqual(await client.members('sample'), responseFor('/members'));
  assert.deepEqual(await client.stage('sample', { baseVersion: 0, csv }, 'stage-key'), { import: importRecord });
  assert.equal((await client.approve('sample', 'imp-001')).import.state, 'approved');
  assert.equal((await client.claim('sample', 'imp-001', 5000)).leaseToken, leaseToken);
  assert.equal((await client.commit('sample', 'imp-001', leaseToken, 'commit-key')).version, 1);
  assert.equal((await client.cancel('sample', 'imp-001')).import.state, 'cancelled');
  assert.equal((await client.events('sample', { after: 0, limit: 100 })).nextCursor, 1);
  assert.deepEqual(requests.slice(start).map(({ method, path, body }) => ({ method, path, body })), [
    { method: 'GET', path: '/v1/workspaces/sample', body: undefined },
    { method: 'GET', path: '/v1/workspaces/sample/members', body: undefined },
    { method: 'POST', path: '/v1/workspaces/sample/imports', body: { baseVersion: 0, csv } },
    { method: 'POST', path: '/v1/workspaces/sample/imports/imp-001/approve', body: {} },
    { method: 'POST', path: '/v1/workspaces/sample/imports/imp-001/claim', body: { leaseMs: 5000 } },
    { method: 'POST', path: '/v1/workspaces/sample/imports/imp-001/commit', body: { leaseToken } },
    { method: 'POST', path: '/v1/workspaces/sample/imports/imp-001/cancel', body: {} },
    { method: 'GET', path: '/v1/workspaces/sample/events?after=0&limit=100', body: undefined },
  ]);
  for (const request of requests.slice(start)) {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    if (request.method === 'POST') assert.equal(request.headers['content-type'], 'application/json');
  }
  assert.equal(requests[start + 2].headers['idempotency-key'], 'stage-key');
  assert.equal(requests[start + 5].headers['idempotency-key'], 'commit-key');
});

test('SDK encodes literal path identifiers and leaves default pagination to API', async () => {
  const client = createClient({ baseUrl, token });
  await client.approve('literal/#?%', 'item/?#%');
  assert.equal(requests.at(-1).path, '/v1/workspaces/literal%2F%23%3F%25/imports/item%2F%3F%23%25/approve');
  await client.events('sample');
  assert.equal(requests.at(-1).path, '/v1/workspaces/sample/events');
  await assert.rejects(client.workspace('..'), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(client.workspace('\ud800'), { code: 'INVALID_ARGUMENT' });
});

test('SDK preserves structured API errors and rejects malformed or failed transport safely', async () => {
  const client = createClient({ baseUrl, token });
  await assert.rejects(client.workspace('upstream'), error => error instanceof RelayError &&
    error.status === 409 && error.code === 'VERSION_CONFLICT' && error.message === 'Synthetic version conflict.');
  for (const [path, status] of [['badjson', 200], ['badshape', 200], ['empty', 204], ['baderror', 502]]) {
    await assert.rejects(client.workspace(path), error => error instanceof RelayError &&
      error.status === status && error.code === 'INVALID_RESPONSE');
  }
  for (const path of ['transport', 'redirect']) {
    await assert.rejects(client.workspace(path), error => error instanceof RelayError &&
      error.status === 0 && error.code === 'TRANSPORT_ERROR' && !error.message.includes(baseUrl));
  }
});

test('SDK rejects malformed success envelopes for every method', async () => {
  const client = createClient({ baseUrl: `${baseUrl}/malformed`, token });
  const calls = [
    () => client.workspace('sample'),
    () => client.members('sample'),
    () => client.stage('sample', { baseVersion: 0, csv }, 'key'),
    () => client.approve('sample', 'imp-001'),
    () => client.claim('sample', 'imp-001', 100),
    () => client.commit('sample', 'imp-001', leaseToken, 'key'),
    () => client.cancel('sample', 'imp-001'),
    () => client.events('sample'),
  ];
  for (const call of calls) await assert.rejects(call(), { status: 200, code: 'INVALID_RESPONSE' });
});

test('SDK validates configuration, numbers, CSV byte limits and idempotency keys without requests', async () => {
  for (const config of [undefined, {}, { baseUrl, token: '' }, { baseUrl, token: 'bad\r\nsecret' },
    { baseUrl: 'not-a-url', token }, { baseUrl: 'file:///secret', token },
    { baseUrl: 'http://name:password@127.0.0.1', token }, { baseUrl: `${baseUrl}?secret=1`, token }]) {
    assert.throws(() => createClient(config), { name: 'RelayError', status: 0, code: 'INVALID_CONFIG' });
  }
  const client = createClient({ baseUrl, token });
  const beforeRequests = requests.length;
  const invalidCalls = [
    () => client.stage('sample', { baseVersion: -1, csv }, 'key'),
    () => client.stage('sample', { baseVersion: '0', csv }, 'key'),
    () => client.stage('sample', { baseVersion: 0, csv: 'é'.repeat(32769) }, 'key'),
    () => client.stage('sample', { baseVersion: 0, csv: '\u0000'.repeat(50000) }, 'key'),
    () => client.stage('sample', { baseVersion: 0, csv }, 'bad key'),
    () => client.claim('sample', 'imp-001', 99),
    () => client.claim('sample', 'imp-001', 5001),
    () => client.claim('sample', 'imp-001', 100.5),
    () => client.commit('sample', 'imp-001', '', 'key'),
    () => client.commit('sample', 'imp-001', leaseToken, 'x'.repeat(81)),
    () => client.events('sample', { after: Number.MAX_SAFE_INTEGER + 1 }),
    () => client.events('sample', { after: -1 }),
    () => client.events('sample', { limit: 0 }),
    () => client.events('sample', { limit: 101 }),
    () => client.events('sample', null),
  ];
  for (const call of invalidCalls) await assert.rejects(call(), { status: 0, code: 'INVALID_ARGUMENT' });
  assert.equal(requests.length, beforeRequests);
});

test('CLI help works without credentials; all eight commands emit exactly one success JSON', async () => {
  const help = await cli(['--help'], { RELAY_URL: '', RELAY_TOKEN: '' });
  assert.equal(help.code, 0);
  assert.equal(help.stderr, '');
  for (const command of ['status', 'members', 'stage', 'approve', 'claim', 'commit', 'cancel', 'events']) {
    assert.ok(help.stdout.includes(command));
  }
  const cases = [
    ['status', 'sample'], ['members', 'sample'],
    ['stage', 'sample', '--file', csvPath, '--base-version', '0', '--key', 'stage-key'],
    ['approve', 'sample', 'imp-001'], ['claim', 'sample', 'imp-001', '--lease-ms', '100'],
    ['commit', 'sample', 'imp-001', '--lease-token', leaseToken, '--key', 'commit-key'],
    ['cancel', 'sample', 'imp-001'], ['events', 'sample', '--after', '0', '--limit', '100'],
    ['events', 'sample'],
  ];
  for (const args of cases) {
    const result = await cli(args);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout.trim().split('\n').length, 1);
    assert.equal(typeof JSON.parse(result.stdout), 'object');
    if (args[0] === 'stage') assert.equal(requests.at(-1).body.csv, csv, 'preserve exact BOM/CRLF CSV');
    if (args[0] === 'claim') assert.equal(JSON.parse(result.stdout).leaseToken, leaseToken);
  }
});

test('CLI preserves hyphen-prefixed opaque lease tokens and relative file paths', async () => {
  for (const value of ['-synthetic-lease', '--synthetic-lease', '-', '--']) {
    for (const flags of [
      ['--lease-token', value, '--key', 'commit-key'],
      ['--key', 'commit-key', '--lease-token', value],
    ]) {
      const result = await cli(['commit', 'sample', 'imp-001', ...flags]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(JSON.parse(result.stdout).import.state, 'committed');
      assert.deepEqual(requests.at(-1).body, { leaseToken: value });
    }
    const failure = await cli(['commit', 'sample', 'imp-001', '--lease-token', value, '--key', 'bad key']);
    // A single hyphen may occur in ordinary prose; check the distinct synthetic secrets.
    assertFailure(failure, [token, baseUrl, leaseToken, ...(value.length > 2 ? [value] : [])]);
  }
  for (const name of ['-synthetic.csv', '--synthetic.csv']) {
    await writeFile(join(directory, name), csv);
    const result = await cli(['stage', 'sample', '--file', name, '--base-version', '0', '--key', 'key'], {}, directory);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(JSON.parse(result.stdout).import.state, 'staged');
    assert.equal(requests.at(-1).body.csv, csv);
  }
});

test('CLI rejects malformed flags and bounded integer strings without echoing secrets', async () => {
  const cases = [
    [], ['unknown-secret-command'], ['--help', '--token', leaseToken],
    ['status', 'sample', '--token', leaseToken], ['status', 'sample', '--lease-token=' + leaseToken],
    ['status', 'sample', leaseToken], ['status', '--unknown', leaseToken],
    ['claim', 'sample', 'imp-001', '--lease-ms'],
    ['claim', 'sample', 'imp-001', '--lease-ms', '100', '--lease-ms', '200'],
    ['commit', 'sample', 'imp-001', '--lease-token', leaseToken],
    ['commit', 'sample', 'imp-001', '--lease-token', '--key', 'commit-key'],
    ['commit', 'sample', 'imp-001', '--key', 'commit-key', '--lease-token'],
    ['commit', 'sample', 'imp-001', '--lease-token', '', '--key', 'commit-key'],
    ['commit', 'sample', 'imp-001', '--lease-token', '-synthetic-lease', '--lease-token', '--synthetic-lease', '--key', 'commit-key'],
    ['commit', 'sample', 'imp-001', '--lease-token', '--synthetic-lease', '--key', 'commit-key', '--unknown', '-synthetic-lease'],
    ['commit', 'sample', 'imp-001', '--lease-token', leaseToken, '--key', 'bad key'],
    ['stage', 'sample', '--file', csvPath, '--base-version', '-1', '--key', 'key'],
    ['stage', 'sample', '--file', csvPath, '--base-version', '1.0', '--key', 'key'],
    ['stage', 'sample', '--file', csvPath, '--base-version', '0', '--key', 'bad key'],
  ];
  for (const value of ['-1', '1.5', '1e2', '0x64', '+100', '0100', '100 ', '99', '5001', '9007199254740992']) {
    cases.push(['claim', 'sample', 'imp-001', '--lease-ms', value]);
  }
  for (const [flag, value] of [['--after', '-1'], ['--after', '1e2'], ['--limit', '0'], ['--limit', '101']]) {
    cases.push(['events', 'sample', flag, value]);
  }
  const beforeRequests = requests.length;
  for (const args of cases) assertFailure(await cli(args), [token, baseUrl, leaseToken, '-synthetic-lease', '--synthetic-lease', 'unknown-secret-command', 'bad key']);
  assert.equal(requests.length, beforeRequests);
});

test('CLI handles invalid environment, upstream errors, malformed responses and transport without leaks', async () => {
  for (const env of [
    { RELAY_URL: '', RELAY_TOKEN: '' },
    { RELAY_URL: `not-url-${leaseToken}` },
    { RELAY_URL: `http://name:${leaseToken}@127.0.0.1` },
    { RELAY_TOKEN: `bad\n${leaseToken}` },
    { RELAY_URL: `${baseUrl}/?secret=${leaseToken}` },
  ]) assertFailure(await cli(['status', 'sample'], env));
  for (const path of ['upstream', 'leak', 'leakraw', 'badjson', 'badshape', 'baderror', 'empty', 'transport', 'redirect']) {
    assertFailure(await cli(['status', path]));
  }
  // Failure must not poison the next request to the same service.
  assert.equal((await cli(['status', 'sample'])).code, 0);
});

test('CLI UTF-8 and file-byte boundaries are checked before requesting the API', async () => {
  const invalidPath = join(directory, 'invalid-secret-utf8.csv');
  const largePath = join(directory, 'large-secret.csv');
  const boundaryPath = join(directory, 'boundary.csv');
  await writeFile(invalidPath, Buffer.from([0xc3, 0x28]));
  await writeFile(largePath, 'é'.repeat(32769));
  await writeFile(boundaryPath, 'é'.repeat(32768));
  const beforeRequests = requests.length;
  for (const [path, code] of [[invalidPath, 'INVALID_UTF8'], [largePath, 'FILE_TOO_LARGE'],
    [join(directory, leaseToken), 'FILE_ERROR'], [directory, 'FILE_ERROR']]) {
    const result = await cli(['stage', 'sample', '--file', path, '--base-version', '0', '--key', 'key']);
    assert.equal(assertFailure(result, [token, baseUrl, leaseToken, path]).code, code);
  }
  assert.equal(requests.length, beforeRequests);
  const result = await cli(['stage', 'sample', '--file', boundaryPath, '--base-version', '0', '--key', 'key']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(Buffer.byteLength(requests.at(-1).body.csv), 65536);
});
