// Finite synthetic backend verification. All fixtures stay under DATA_DIR.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, writeFile, cp, unlink } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { openService } from './service.mjs';
import { canonicalJson } from './data.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
assert.ok(isAbsolute(process.env.DATA_DIR || ''), 'An external DATA_DIR is required.');
const parent = process.env.DATA_DIR;
const directory = await mkdtemp(join(parent, 'backend-verify-'));
const secrets = new Set();
const children = new Set();
let checks = 0;
const secret = () => { const value = randomBytes(32).toString('base64url'); secrets.add(value); return value; };
const remember = value => { secrets.add(value); return value; };
const check = (condition, message) => { assert.ok(condition, message); checks += 1; };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function launch(dataDir, bootstrap, port = 0, shouldFail = false) {
  const child = spawn(process.execPath, ['app.mjs', '--data', dataDir, '--port', String(port)], {
    cwd: root, env: { ...process.env, RELAY_BOOTSTRAP_TOKEN: bootstrap }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  let stdout = '', stderr = '';
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => { children.delete(child); resolve(code); });
  });
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const wait = async predicate => {
    for (let attempt = 0; attempt < 1200; attempt += 1) {
      if (predicate()) return;
      if (!children.has(child)) return;
      await delay(10);
    }
    throw new Error('Owned verification child timed out.');
  };
  await wait(() => stdout.includes('\n'));
  if (shouldFail) {
    await wait(() => !children.has(child));
    check(await exit !== 0 && stdout === '', 'Invalid startup must fail before readiness.');
    for (const value of secrets) check(!stdout.includes(value) && !stderr.includes(value), 'Startup errors must exclude secrets.');
    return;
  }
  check(stdout.includes('\n'), 'Service must announce readiness.');
  const ready = JSON.parse(stdout.split('\n')[0]);
  check(ready.ready === true && Number.isInteger(ready.port), 'First stdout line must be JSON readiness.');
  return {
    url: `http://127.0.0.1:${ready.port}`,
    async stop(crash = false) {
      if (crash) child.kill('SIGKILL');
      else child.stdin.end('shutdown\n');
      await wait(() => !children.has(child));
      const code = await exit;
      if (!crash) check(code === 0, 'Graceful shutdown must exit zero.');
      for (const value of secrets) check(!stdout.includes(value) && !stderr.includes(value), 'Process logs must exclude secrets.');
    },
  };
}

let current;
async function api(token, path, method = 'GET', body, key, status = 200) {
  const headers = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (key !== undefined) headers['idempotency-key'] = key;
  const response = await fetch(current.url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  check(response.status === status, `Unexpected HTTP status for ${method} ${path}: ${response.status}.`);
  const value = await response.json();
  if (status >= 400) {
    check(typeof value.error?.code === 'string' && typeof value.error?.message === 'string', 'Safe error envelope is required.');
    for (const tokenValue of secrets) check(!JSON.stringify(value).includes(tokenValue), 'Error bodies must exclude secrets.');
  }
  return value;
}

async function scan(directoryName) {
  for (const entry of await readdir(directoryName, { withFileTypes: true })) {
    const filename = join(directoryName, entry.name);
    if (entry.isDirectory()) await scan(filename);
    else {
      const text = await readFile(filename, 'utf8');
      for (const value of secrets) check(!text.includes(value), 'Every runtime file must exclude plaintext capabilities and leases.');
    }
  }
}

try {
  const bootstrap = secret();
  current = await launch(directory, bootstrap, Number(process.env.PORT || 0));
  const health = await api(undefined, '/health');
  assert.deepEqual(health, { ok: true });
  const creation = { id: 'backend-check', name: 'Synthetic backend' };
  const owner = remember((await api(bootstrap, '/v1/workspaces', 'POST', creation, undefined, 201)).ownerToken);
  const base = '/v1/workspaces/backend-check';
  const roles = {};
  for (const role of ['editor', 'approver', 'worker', 'viewer']) {
    roles[role] = await api(owner, base + '/tokens', 'POST', { subject: role, role });
    remember(roles[role].token);
  }
  const editor = roles.editor.token, approver = roles.approver.token, worker = roles.worker.token, viewer = roles.viewer.token;
  await api(bootstrap, base, 'GET', undefined, undefined, 403);
  await api(secret(), base, 'GET', undefined, undefined, 401);
  await api(viewer, base + '/imports/absent', 'GET', undefined, undefined, 404);
  const otherOwner = remember((await api(bootstrap, '/v1/workspaces', 'POST', { id: 'other-check', name: 'Other' }, undefined, 201)).ownerToken);
  await api(otherOwner, base + '/imports/absent', 'GET', undefined, undefined, 403);
  const csv = 'op,external_id,name,email\nupsert,a,"Ada, ""A""",ADA@EXAMPLE.TEST\nupsert,b,Bob,bob@example.test\n';
  const body = { baseVersion: 0, csv };
  const staged = await api(editor, base + '/imports', 'POST', body, 'first', 201);
  const path = base + '/imports/' + staged.import.id;
  const sameSubject = await api(owner, base + '/tokens', 'POST', { subject: 'editor', role: 'approver' });
  remember(sameSubject.token);
  await api(sameSubject.token, path + '/approve', 'POST', {}, undefined, 403);
  await api(approver, path + '/approve', 'POST', {});
  await api(approver, path + '/approve', 'POST', {});
  const claims = await Promise.all([1, 2].map(async () => {
    const response = await fetch(current.url + path + '/claim', { method: 'POST', headers: {
      authorization: `Bearer ${worker}`, 'content-type': 'application/json',
    }, body: JSON.stringify({ leaseMs: 5000 }) });
    return { status: response.status, body: await response.json() };
  }));
  assert.deepEqual(claims.map(value => value.status).sort(), [200, 409]);
  const lease = claims.find(value => value.status === 200).body;
  remember(lease.leaseToken);
  const committed = await api(worker, path + '/commit', 'POST', { leaseToken: lease.leaseToken }, 'commit');
  check(committed.version === 1 && committed.applied === 2, 'Commit applies one atomic directory version.');
  assert.deepEqual(await api(worker, path + '/commit', 'POST', { leaseToken: lease.leaseToken }, 'commit'), committed);
  const sameWorker = await api(owner, base + '/tokens', 'POST', { subject: 'worker', role: 'worker' });
  remember(sameWorker.token);
  await api(sameWorker.token, path + '/commit', 'POST', { leaseToken: lease.leaseToken }, 'commit', 409);
  assert.deepEqual(await api(editor, base + '/imports', 'POST', { csv, baseVersion: 0 }, 'first'), staged);
  await api(editor, base + '/imports', 'POST', { baseVersion: 0, csv: csv + '\n' }, 'first', 409);
  await api(owner, base + '/tokens/' + roles.editor.id + '/revoke', 'POST', {});
  await api(editor, base + '/imports', 'POST', body, 'first', 401);
  await api(owner, base + '/tokens/' + roles.editor.id + '/revoke', 'POST', {});
  const members = await api(viewer, base + '/members');
  check(members.version === 1 && members.members[0].email === 'ada@example.test', 'Normalized members persist.');
  const events = (await api(viewer, base + '/events?limit=100')).events;
  assert.deepEqual(events.map(value => value.cursor), events.map((_, index) => index + 1));
  check(events.filter(value => value.type === 'import.claimed').length === 1, 'Concurrent claims produce exactly one event.');
  check(events.filter(value => value.type === 'import.committed').length === 1, 'Commit replay produces no event.');
  await launch(directory, bootstrap, 0, true);
  await current.stop(); current = undefined;
  const rotatedBootstrap = secret();
  current = await launch(directory, rotatedBootstrap, Number(process.env.PORT || 0));
  const recreated = await api(rotatedBootstrap, '/v1/workspaces', 'POST', { id: creation.id, name: ` ${creation.name} ` });
  check(recreated.ownerToken === owner, 'Owner replay survives bootstrap rotation.');
  assert.deepEqual(await api(viewer, base + '/members'), members);
  assert.deepEqual(await api(worker, path + '/commit', 'POST', { leaseToken: lease.leaseToken }, 'commit'), committed);
  await current.stop(true); current = undefined;
  current = await launch(directory, rotatedBootstrap, Number(process.env.PORT || 0));
  assert.deepEqual((await api(viewer, base + '/events?limit=100')).events, events);
  await current.stop(); current = undefined;
  await scan(directory);

  const journal = await readFile(join(directory, 'transactions.jsonl'));
  const text = journal.toString('utf8');
  const lines = text.trimEnd().split('\n');
  const corruptions = [
    Buffer.concat([journal, Buffer.from('{"partial":')]),
    Buffer.from(text.replace('Synthetic backend', 'Changed backend')),
    Buffer.from([lines[1], lines[0], ...lines.slice(2)].join('\n') + '\n'),
    Buffer.from([lines[0], ...lines.slice(2)].join('\n') + '\n'),
    journal.subarray(0, journal.length - 1),
    Buffer.concat([journal, Buffer.from([0xc3, 0x28, 10])]),
  ];
  for (const bytes of corruptions) {
    const corruptDir = await mkdtemp(join(parent, 'backend-corrupt-'));
    await writeFile(join(corruptDir, 'transactions.jsonl'), bytes);
    await launch(corruptDir, rotatedBootstrap, 0, true);
    check((await readFile(join(corruptDir, 'transactions.jsonl'))).equals(bytes), 'Corruption recovery must not rewrite the journal.');
    await scan(corruptDir);
  }

  // Keep metadata when testing suffix loss: its durable tip must reject rollback.
  const suffixDir = await mkdtemp(join(parent, 'backend-suffix-'));
  await cp(directory, suffixDir, { recursive: true });
  const truncated = Buffer.from(lines.slice(0, -1).join('\n') + '\n');
  await writeFile(join(suffixDir, 'transactions.jsonl'), truncated);
  await launch(suffixDir, rotatedBootstrap, 0, true);
  check((await readFile(join(suffixDir, 'transactions.jsonl'))).equals(truncated), 'Acknowledged suffix truncation must fail without repair.');
  await scan(suffixDir);

  const missingTipDir = await mkdtemp(join(parent, 'backend-missing-tip-'));
  await cp(directory, missingTipDir, { recursive: true });
  await unlink(join(missingTipDir, '.relay-lock', 'tip.json'));
  await launch(missingTipDir, rotatedBootstrap, 0, true);
  await scan(missingTipDir);

  // A valid post-fsync/pre-response tail is recovered, never silently discarded.
  const tailDir = await mkdtemp(join(parent, 'backend-tail-'));
  await cp(directory, tailDir, { recursive: true });
  const prior = JSON.parse(lines.at(-2));
  await writeFile(join(tailDir, '.relay-lock', 'tip.json'), canonicalJson({ format: 1, seq: prior.seq, hash: prior.hash }) + '\n');
  current = await launch(tailDir, rotatedBootstrap, 0);
  assert.deepEqual(await api(viewer, base + '/members'), members);
  await current.stop(); current = undefined;
  const restoredTip = JSON.parse(await readFile(join(tailDir, '.relay-lock', 'tip.json'), 'utf8'));
  const last = JSON.parse(lines.at(-1));
  check(restoredTip.seq === last.seq && restoredTip.hash === last.hash, 'Recovery anchors a valid later durable tail.');
  check((await readFile(join(tailDir, 'transactions.jsonl'))).equals(journal), 'Tail recovery must not rewrite the journal.');
  await scan(tailDir);

  // Verify integration close waits for an accepted, incomplete mutation body.
  const drainDir = await mkdtemp(join(parent, 'backend-drain-'));
  const service = await openService({ dataDir: drainDir, bootstrapToken: bootstrap });
  const request = new PassThrough();
  request.method = 'POST'; request.url = '/v1/workspaces';
  request.headers = { authorization: `Bearer ${bootstrap}`, 'content-type': 'application/json' };
  request.rawHeaders = ['Authorization', request.headers.authorization, 'Content-Type', 'application/json'];
  let responseBody, responseStatus;
  const response = { writeHead(status) { responseStatus = status; }, end(value) { responseBody = JSON.parse(value); } };
  const handling = service.handle(request, response);
  let closed = false;
  const closing = service.close().then(() => { closed = true; });
  await delay(20);
  check(!closed, 'Service close must await accepted bodies/writes.');
  request.end(JSON.stringify({ id: 'drain-check', name: 'Drain check' }));
  await handling; await closing; await service.close();
  check(responseStatus === 201, 'Accepted mutation must commit during drain.');
  remember(responseBody.ownerToken);
  const reopened = await openService({ dataDir: drainDir, bootstrapToken: bootstrap });
  await reopened.close();
  await scan(drainDir);
  process.stdout.write(JSON.stringify({ ok: true, runtime: globalThis.Bun ? 'bun' : 'node', checks, port: Number(process.env.PORT || 0), liveChildren: children.size }) + '\n');
} finally {
  if (current) await current.stop();
  // Only children created by this finite harness are eligible for termination.
  for (const child of children) child.kill();
  if (children.size) await delay(100);
}
