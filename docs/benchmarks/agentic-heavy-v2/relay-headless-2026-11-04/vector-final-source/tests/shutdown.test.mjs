import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { join, isAbsolute, relative } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = process.env.RELAY_TEST_RUNTIME || process.execPath;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function within(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned shutdown check timed out')), 10000); })]);
  } finally { clearTimeout(timer); }
}

test('shutdown gates new writes, drains concurrent HTTP bodies and retains ownership', { timeout: 30000 }, async () => {
  const parent = process.env.DATA_DIR;
  assert.ok(isAbsolute(parent || ''));
  const distance = relative(root, parent);
  assert.ok(distance.startsWith('..') || isAbsolute(distance));
  const dataDir = await mkdtemp(join(parent, 'shutdown-regression-'));
  const bootstrap = randomBytes(32).toString('base64url');
  const children = new Set();
  async function launch(fail = false) {
    const child = spawn(runtime, ['app.mjs', '--data', dataDir, '--port', '0'], {
      cwd: root, env: { ...process.env, RELAY_BOOTSTRAP_TOKEN: bootstrap }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const record = { child, stdout: '', stderr: '', exited: false };
    children.add(record);
    child.stdout.on('data', chunk => { record.stdout += chunk; });
    child.stderr.on('data', chunk => { record.stderr += chunk; });
    record.exit = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => { record.exited = true; children.delete(record); resolve(code); });
    });
    const started = Date.now();
    while (!record.stdout.includes('\n') && !record.exited) {
      assert.ok(Date.now() - started < 10000, 'Readiness timeout'); await delay(5);
    }
    if (fail) {
      assert.notEqual(await within(record.exit), 0); assert.equal(record.stdout, '');
      return record;
    }
    assert.ok(!record.exited);
    const ready = JSON.parse(record.stdout.split('\n')[0]);
    assert.equal(ready.ready, true);
    record.url = `http://127.0.0.1:${ready.port}`;
    return record;
  }
  const pendingRequests = [];
  try {
    const service = await launch();
    const response = await fetch(service.url + '/v1/workspaces', { method: 'POST', signal: AbortSignal.timeout(5000), headers: {
      authorization: `Bearer ${bootstrap}`, 'content-type': 'application/json',
    }, body: JSON.stringify({ id: 'shutdown-test', name: 'Synthetic shutdown' }) });
    assert.equal(response.status, 201);
    const owner = (await response.json()).ownerToken;
    const path = '/v1/workspaces/shutdown-test';
    const admitted = ['one', 'two'].map(id => {
      const body = JSON.stringify({ baseVersion: 0, csv: `op,external_id,name,email\nupsert,${id},Synthetic,${id}@example.test` });
      let req;
      const result = new Promise((resolve, reject) => {
        req = request(service.url + path + '/imports', { method: 'POST', agent: false, headers: {
          authorization: `Bearer ${owner}`, 'content-type': 'application/json',
          'idempotency-key': id, 'content-length': Buffer.byteLength(body),
        } }, res => {
          let text = ''; res.on('data', chunk => { text += chunk; });
          res.on('end', () => {
            try { resolve({ status: res.statusCode, value: JSON.parse(text) }); } catch (error) { reject(error); }
          });
          res.on('error', reject);
        });
        req.on('error', reject); req.write(body.slice(0, 10));
      });
      // An assertion failure still must not create an unhandled rejection while
      // cleanup closes this test's incomplete sockets.
      result.catch(() => {});
      pendingRequests.push(req);
      return { req, body, result };
    });
    await delay(80);
    service.child.stdin.end('shutdown\n');
    await delay(80);
    assert.equal(service.exited, false, 'Accepted incomplete writes retain process ownership');
    const refused = await fetch(service.url + path + '/imports', { method: 'POST', signal: AbortSignal.timeout(5000), headers: {
      authorization: `Bearer ${owner}`, 'content-type': 'application/json', 'idempotency-key': 'not-admitted',
    }, body: JSON.stringify({ baseVersion: 0, csv: 'not admitted' }) });
    assert.equal(refused.status, 503);
    assert.equal(typeof (await refused.json()).error.code, 'string');
    await launch(true);
    for (const admittedRequest of admitted) admittedRequest.req.end(admittedRequest.body.slice(10));
    const results = await within(Promise.all(admitted.map(value => value.result)));
    assert.deepEqual(results.map(value => value.status), [201, 201]);
    assert.equal(await within(service.exit), 0);
    const reopened = await launch();
    const imports = await fetch(reopened.url + path + '/imports', { signal: AbortSignal.timeout(5000), headers: { authorization: `Bearer ${owner}` } }).then(res => res.json());
    assert.equal(imports.imports.length, 2);
    const events = await fetch(reopened.url + path + '/events', { signal: AbortSignal.timeout(5000), headers: { authorization: `Bearer ${owner}` } }).then(res => res.json());
    assert.deepEqual(events.events.map(value => value.type), ['workspace.created', 'import.staged', 'import.staged']);
    reopened.child.stdin.end('shutdown\n');
    assert.equal(await within(reopened.exit), 0);
    assert.ok(!service.stdout.includes(owner) && !service.stderr.includes(owner));
  } finally {
    for (const req of pendingRequests) req.destroy();
    const remaining = [...children];
    for (const record of remaining) record.child.kill('SIGKILL');
    await Promise.allSettled(remaining.map(record => record.exit));
  }
});
