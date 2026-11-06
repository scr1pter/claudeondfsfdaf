import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, readdir, cp } from 'node:fs/promises';
import { join, isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createClient, RelayError } from '../sdk.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
// Keep Node's complete nested-test harness while exercising either runtime's
// actual server and CLI processes. Bun's current node:test subtests are partial.
const runtime = process.env.RELAY_TEST_RUNTIME || process.execPath;
const bootstrap = randomBytes(32).toString('hex');
const header = 'op,external_id,name,email\n';
const workspace = 'local-test';
const tracked = new Set();

async function directory(label) {
  const parent = process.env.DATA_DIR;
  assert.ok(parent && isAbsolute(parent), 'DATA_DIR must be an absolute external directory');
  const rel = relative(root, parent);
  assert.ok(rel.startsWith('..') || isAbsolute(rel), 'DATA_DIR must be outside source');
  return mkdtemp(join(parent, `${label}-`));
}

async function launch(dataDir, { expectFailure = false, port = 0 } = {}) {
  const child = spawn(runtime, ['app.mjs', '--data', dataDir, '--port', String(port)], {
    cwd: root, env: { ...process.env, RELAY_BOOTSTRAP_TOKEN: bootstrap }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  tracked.add(child);
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => { tracked.delete(child); resolveExit({ code, signal }); });
  });
  const first = await new Promise((resolveFirst, reject) => {
    const timer = setTimeout(() => reject(new Error('Service startup timeout')), 12000);
    const finish = value => { clearTimeout(timer); resolveFirst(value); };
    child.stdout.on('data', () => {
      if (stdout.includes('\n')) finish({ line: stdout.split('\n')[0] });
    });
    exit.then(result => finish({ result }), reject);
  });
  if (expectFailure) {
    assert.ok(!first.line, 'Refused startup must not announce readiness');
    assert.notEqual((await exit).code, 0);
    assert.ok(!stdout.includes(bootstrap) && !stderr.includes(bootstrap), 'Startup must not reveal secrets');
    return;
  }
  assert.ok(first.line, 'Service must announce readiness before exiting');
  const ready = JSON.parse(first.line);
  assert.equal(ready.ready, true); assert.ok(Number.isInteger(ready.port) && ready.port > 0);
  const url = `http://127.0.0.1:${ready.port}`;
  return {
    url, child,
    async stop() {
      child.stdin.end('shutdown\n');
      const timeout = setTimeout(() => child.kill(), 12000);
      const result = await exit;
      clearTimeout(timeout);
      assert.equal(result.code, 0, 'Graceful shutdown must exit zero');
      assert.ok(!stderr.includes(bootstrap), 'Shutdown must not reveal secrets');
    },
    async crash() {
      child.kill('SIGKILL');
      await exit;
    },
  };
}

async function request(url, token, path, method = 'GET', body, key, expected = 200) {
  const headers = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (key !== undefined) headers['idempotency-key'] = key;
  const response = await fetch(url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json();
  assert.equal(response.status, expected, `${method} ${path} expected ${expected}; received ${response.status} (${value?.error?.code || 'success'})`);
  if (expected >= 400) {
    assert.equal(typeof value.error.code, 'string'); assert.equal(typeof value.error.message, 'string');
  }
  return value;
}

async function cli(url, token, args, expected = 0) {
  const child = spawn(runtime, ['cli.mjs', ...args], {
    cwd: root, env: { ...process.env, RELAY_URL: url, RELAY_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit); });
  assert.equal(code, expected);
  assert.equal((expected === 0 ? stderr : stdout), '', 'CLI writes only its designated stream');
  if (expected !== 0) {
    assert.ok(!stderr.includes(token) && !stderr.includes(url), 'CLI errors must not echo credentials or URL');
  }
  const output = expected === 0 ? stdout : stderr;
  assert.equal(output.trim().split('\n').length, 1, 'CLI emits one JSON value');
  return JSON.parse(output);
}

test.after(() => { for (const child of tracked) child.kill(); });

test('connected API, CLI, SDK, isolation, atomicity and restart', { timeout: 90000 }, async t => {
  const dataDir = await directory('integration');
  let service = await launch(dataDir);
  t.after(async () => { if (service) await service.stop(); });
  let url = service.url;
  const base = `/v1/workspaces/${workspace}`;
  const api = (token, suffix = '', method = 'GET', body, key, expected) => request(url, token, base + suffix, method, body, key, expected);
  const created = await request(url, bootstrap, '/v1/workspaces', 'POST', { id: workspace, name: '  Synthetic directory  ' }, undefined, 201);
  const owner = created.ownerToken;
  assert.ok(typeof owner === 'string' && owner.length > 20);
  const repeated = await request(url, bootstrap, '/v1/workspaces', 'POST', { name: 'Synthetic directory', id: workspace });
  assert.ok(repeated.ownerToken === owner, 'Exact workspace replay returns its original capability');
  const tokens = {};
  for (const [subject, role] of [['edit','editor'], ['approve','approver'], ['work','worker'], ['read','viewer'], ['other','editor']]) {
    tokens[subject] = await api(owner, '/tokens', 'POST', { subject, role });
  }
  const editor = tokens.edit.token, approver = tokens.approve.token, worker = tokens.work.token, viewer = tokens.read.token;
  const client = createClient({ baseUrl: url, token: viewer });
  await t.test('tenant and role isolation, status and query boundaries', async () => {
    assert.deepEqual(await request(url, undefined, '/health'), { ok: true });
    await api(undefined, '', 'GET', undefined, undefined, 401);
    await api('invalid', '', 'GET', undefined, undefined, 401);
    await api(bootstrap, '', 'GET', undefined, undefined, 403);
    const other = await request(url, bootstrap, '/v1/workspaces', 'POST', { id: 'other-tenant', name: 'Other synthetic' }, undefined, 201);
    await api(other.ownerToken, '', 'GET', undefined, undefined, 403);
    await api(viewer, '/imports/absent', 'GET', undefined, undefined, 404);
    await api(viewer, '/tokens', 'POST', { subject: 'no', role: 'worker' }, undefined, 403);
    for (const query of ['?after=-1', '?after=1.2', '?limit=0', '?limit=101', '?after=1e2']) {
      await api(viewer, '/events' + query, 'GET', undefined, undefined, 400);
    }
    assert.equal((await client.workspace(workspace)).workspace.version, 0);
    assert.deepEqual(await client.members(workspace), { version: 0, members: [] });
    assert.equal((await cli(url, viewer, ['status', workspace])).workspace.version, 0);
    await cli(url, viewer, ['commit', workspace, 'absent', '--lease-token', 'synthetic-secret', '--key'], 1);
    assert.deepEqual(await request(url, undefined, '/health'), { ok: true });
  });
  await t.test('mutation byte, media type, JSON and UTF-8 boundaries remain isolated', async () => {
    for (const [contentType, body, status] of [
      ['text/plain', '{}', 415],
      ['application/json', '{malformed', 400],
      ['application/json', Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]), 400],
      ['application/json', ' '.repeat(262145), 413],
    ]) {
      const response = await fetch(url + base + '/imports', { method: 'POST', headers: {
        authorization: `Bearer ${editor}`, 'content-type': contentType, 'idempotency-key': 'malformed',
      }, body });
      assert.equal(response.status, status, 'Malformed mutation must return its JSON error status');
      const value = await response.json();
      assert.equal(typeof value.error.code, 'string');
      assert.deepEqual(await request(url, undefined, '/health'), { ok: true });
    }
    assert.equal((await api(viewer, '/members')).version, 0);
  });
  let firstImport, committed;
  const csv = '\uFEFFop,external_id,name,email\r\nupsert,a,"Ada, ""A""",ADA@EXAMPLE.TEST\r\nupsert,b,Bob,bob@example.test\r\n';
  await t.test('strict CSV staging, canonical replay, approval and claims', async () => {
    for (const invalid of [header + 'upsert,a,Ada,a@example.test\n\n', header + 'upsert,a,Ada,a@example.test\nupsert,a,Again,b@example.test', header + 'delete,a,Not empty,', header + 'upsert,a,"broken,a@example.test', header + 'upsert,a,Ada,unsafe@example']) {
      await api(editor, '/imports', 'POST', { baseVersion: 0, csv: invalid }, 'invalid', 400);
    }
    const staged = await api(editor, '/imports', 'POST', { baseVersion: 0, csv }, 'stage-first', 201);
    firstImport = staged.import.id;
    assert.equal(staged.import.state, 'staged'); assert.equal(staged.import.rowCount, 2);
    assert.equal(staged.import.approvedBy, null);
    const replay = await api(editor, '/imports', 'POST', { csv, baseVersion: 0 }, 'stage-first');
    assert.equal(replay.import.id, firstImport);
    await api(editor, '/imports', 'POST', { baseVersion: 0, csv: csv + '\n' }, 'stage-first', 409);
    await api(viewer, '/imports', 'POST', { baseVersion: 0, csv }, 'stage-first', 403);
    await api(owner, '/imports', 'POST', { baseVersion: 0, csv: header + 'upsert,z,Zed,z@example.test' }, 'owner-created', 201).then(async value => {
      await api(owner, `/imports/${value.import.id}/approve`, 'POST', {}, undefined, 403);
      await api(owner, `/imports/${value.import.id}/cancel`, 'POST', {});
    });
    await api(approver, `/imports/${firstImport}/approve`, 'POST', {});
    await api(approver, `/imports/${firstImport}/approve`, 'POST', {});
    await api(owner, `/imports/${firstImport}/approve`, 'POST', {}, undefined, 409);
    const claim = () => fetch(url + base + `/imports/${firstImport}/claim`, { method: 'POST', headers: { authorization: `Bearer ${worker}`, 'content-type': 'application/json' }, body: JSON.stringify({ leaseMs: 5000 }) });
    const claims = await Promise.all([claim(), claim()]);
    assert.deepEqual(claims.map(value => value.status).sort(), [200, 409]);
    const lease = await claims.find(value => value.status === 200).json();
    assert.equal(lease.import.leaseEpoch, 1);
    const workClient = createClient({ baseUrl: url, token: worker });
    committed = await workClient.commit(workspace, firstImport, lease.leaseToken, 'commit-first');
    assert.equal(committed.version, 1); assert.equal(committed.applied, 2);
    const again = await workClient.commit(workspace, firstImport, lease.leaseToken, 'commit-first');
    assert.deepEqual(again, committed);
    await api(worker, `/imports/${firstImport}/commit`, 'POST', { leaseToken: 'wrong' }, 'commit-first', 409);
    const members = await client.members(workspace);
    assert.equal(members.version, 1); assert.deepEqual(members.members.map(m => m.externalId), ['a','b']);
    assert.equal(members.members[0].email, 'ada@example.test'); assert.equal(members.members[0].name, 'Ada, "A"');
  });
  async function approved(csvValue, key, version = 1) {
    const value = await api(editor, '/imports', 'POST', { baseVersion: version, csv: csvValue }, key, 201);
    await api(approver, `/imports/${value.import.id}/approve`, 'POST', {});
    return value.import.id;
  }
  await t.test('atomic email swaps, stale versions, nonexistent deletes', async () => {
    const stale = await approved(header + 'upsert,c,Clara,clara@example.test', 'stale');
    const missing = await approved(header + 'delete,missing,,', 'missing');
    const missingLease = await api(worker, `/imports/${missing}/claim`, 'POST', { leaseMs: 5000 });
    await api(worker, `/imports/${missing}/commit`, 'POST', { leaseToken: missingLease.leaseToken }, 'missing-commit', 409);
    assert.equal((await api(viewer, '/members')).version, 1);
    const swap = await approved(header + 'upsert,a,Ada,bob@example.test\nupsert,b,Bob,ada@example.test', 'swap');
    const lease = await api(worker, `/imports/${swap}/claim`, 'POST', { leaseMs: 5000 });
    await api(worker, `/imports/${swap}/commit`, 'POST', { leaseToken: lease.leaseToken }, 'swap-commit');
    const staleLease = await api(worker, `/imports/${stale}/claim`, 'POST', { leaseMs: 5000 });
    await api(worker, `/imports/${stale}/commit`, 'POST', { leaseToken: staleLease.leaseToken }, 'stale-commit', 409);
    const members = await api(viewer, '/members');
    assert.equal(members.version, 2); assert.deepEqual(members.members.map(m => m.revision), [2, 2]);
  });
  await t.test('capability-bound lease fencing, expiry and cancellation', async () => {
    const id = await approved(header + 'upsert,c,Clara,clara@example.test', 'fence', 2);
    const lease = await api(worker, `/imports/${id}/claim`, 'POST', { leaseMs: 100 });
    await new Promise(resolveDelay => setTimeout(resolveDelay, 150));
    await api(worker, `/imports/${id}/commit`, 'POST', { leaseToken: lease.leaseToken }, 'expired', 409);
    const replacement = await api(owner, '/tokens', 'POST', { subject: 'work', role: 'worker' });
    const fresh = await api(replacement.token, `/imports/${id}/claim`, 'POST', { leaseMs: 5000 });
    assert.equal(fresh.import.leaseEpoch, 2);
    await api(worker, `/imports/${id}/commit`, 'POST', { leaseToken: fresh.leaseToken }, 'wrong-capability', 409);
    await api(owner, `/tokens/${replacement.id}/revoke`, 'POST', {});
    await api(owner, `/tokens/${replacement.id}/revoke`, 'POST', {});
    await api(replacement.token, `/imports/${id}/commit`, 'POST', { leaseToken: fresh.leaseToken }, 'revoked', 401);
    await api(tokens.other.token, `/imports/${id}/cancel`, 'POST', {}, undefined, 403);
    await api(editor, `/imports/${id}/cancel`, 'POST', {});
    await api(worker, `/imports/${id}/claim`, 'POST', { leaseMs: 100 }, undefined, 409);
  });
  let events;
  await t.test('audit cursors and event secrecy', async () => {
    events = (await api(viewer, '/events?after=0&limit=100')).events;
    assert.deepEqual(events.map(event => event.cursor), events.map((_, index) => index + 1));
    for (const event of events) assert.deepEqual(Object.keys(event).sort(), ['cursor','importId','subject','type']);
    const page = await api(viewer, `/events?after=${events.length}&limit=1`);
    assert.equal(page.nextCursor, events.length); assert.deepEqual(page.events, []);
    assert.equal(events.filter(event => event.type === 'workspace.created').length, 1);
    assert.equal(events.filter(event => event.type === 'import.committed').length, 2);
  });
  await t.test('exclusive writer, durable replay and graceful restart', async () => {
    await launch(dataDir, { expectFailure: true });
    await service.stop(); service = null;
    service = await launch(dataDir); url = service.url;
    assert.equal((await api(viewer, '/members')).version, 2);
    assert.deepEqual((await api(viewer, '/events?limit=100')).events, events);
    const replay = await api(editor, '/imports', 'POST', { csv, baseVersion: 0 }, 'stage-first');
    assert.equal(replay.import.id, firstImport);
    const createdAgain = await request(url, bootstrap, '/v1/workspaces', 'POST', { id: workspace, name: 'Synthetic directory' });
    assert.ok(createdAgain.ownerToken === owner, 'Workspace owner replay survives restart');
    assert.deepEqual((await cli(url, viewer, ['members', workspace])).members.map(m => m.revision), [2,2]);
    await assert.rejects(createClient({ baseUrl: url, token: 'invalid' }).members(workspace), error => error instanceof RelayError && error.status === 401 && typeof error.code === 'string');
  });
  await t.test('abrupt death recovery preserves data and lock ownership', async () => {
    await service.crash(); service = null;
    service = await launch(dataDir); url = service.url;
    assert.equal((await api(viewer, '/members')).version, 2);
    assert.deepEqual((await api(viewer, '/events?limit=100')).events, events);
  });
  await service.stop(); service = null;
  await t.test('disk excludes plaintext capabilities', async () => {
    async function inspect(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        assert.ok(!entry.isSymbolicLink(), 'Owned runtime metadata should not be a symlink');
        if (entry.isDirectory()) { await inspect(join(directory, entry.name)); continue; }
        const text = await readFile(join(directory, entry.name), 'utf8');
        for (const token of [bootstrap, owner, ...Object.values(tokens).map(value => value.token)]) {
          assert.ok(!text.includes(token), 'Durable files must not contain capability secrets');
        }
      }
    }
    await inspect(dataDir);
  });
  await t.test('partial, valid-JSON changed, reordered and sequence-gapped journals fail closed', async () => {
    const documentation = await readFile(join(root, 'STORAGE.md'), 'utf8');
    const journal = documentation.match(/^Journal: ([a-zA-Z0-9_-]+\.jsonl)$/m)?.[1];
    assert.ok(journal, 'STORAGE.md must name one safe journal basename');
    const original = await readFile(join(dataDir, journal), 'utf8');
    const lines = original.trimEnd().split('\n');
    assert.ok(lines.length > 3);
    assert.ok(original.includes('Synthetic directory'));
    const cases = [
      original + '{"partial":',
      original.replace('Synthetic directory', 'Tampered directory'),
      [lines[1], lines[0], ...lines.slice(2)].join('\n') + '\n',
      [lines[0], ...lines.slice(2)].join('\n') + '\n',
      original.slice(0, -1),
    ];
    for (const text of cases) {
      const corruptDir = await directory('corruption');
      await writeFile(join(corruptDir, journal), text);
      await launch(corruptDir, { expectFailure: true });
      assert.equal(await readFile(join(corruptDir, journal), 'utf8'), text, 'Failed recovery must not rewrite journal');
    }
    const truncatedDir = await directory('whole-record-truncation');
    for (const name of await readdir(dataDir)) {
      await cp(join(dataDir, name), join(truncatedDir, name), { recursive: true, errorOnExist: true, force: false });
    }
    const truncated = lines.slice(0, -1).join('\n') + '\n';
    await writeFile(join(truncatedDir, journal), truncated);
    await launch(truncatedDir, { expectFailure: true });
    assert.equal(await readFile(join(truncatedDir, journal), 'utf8'), truncated);
  });
});
