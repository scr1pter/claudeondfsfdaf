// Independent synthetic black-box QA. Node's harness runs either runtime's real
// service/CLI/typed SDK consumer, including all nested tests (no Bun runner gap).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { mkdtemp, readFile, writeFile, readdir, cp, unlink, mkdir, symlink, lstat } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { createClient, RelayError } from '../sdk.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = process.env.RELAY_TEST_RUNTIME || process.execPath;
const dataRoot = process.env.DATA_DIR;
assert.ok(isAbsolute(dataRoot || ''), 'External absolute DATA_DIR required');
const distance = relative(root, dataRoot);
assert.ok(distance === '..' || distance.startsWith('..\\') || distance.startsWith('../') || isAbsolute(distance));
const bootstrap = randomBytes(32).toString('base64url');
const secrets = new Set([bootstrap]);
const children = new Set();
const header = 'op,external_id,name,email\n';
const csv = header + 'upsert,a,Alpha,ALPHA@example.test\nupsert,b,Beta,beta@example.test';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const remember = value => { secrets.add(value); return value; };
const digest = value => createHash('sha256').update(value).digest('hex');
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
    : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
function secretFree(text) {
  for (const secret of secrets) assert.ok(!text.includes(secret), 'Output/file must exclude actual capability and lease secrets');
}

async function directory(label) {
  assert.ok((await lstat(dataRoot)).isDirectory());
  return mkdtemp(join(dataRoot, `qa-${label}-`));
}

function childProcess(args, env = {}) {
  const child = spawn(runtime, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const record = { child, out: '', err: '', done: false };
  children.add(record);
  child.stdout.on('data', chunk => { record.out += chunk; });
  child.stderr.on('data', chunk => { record.err += chunk; });
  record.exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { record.done = true; children.delete(record); resolve({ code, signal }); });
  });
  return record;
}

async function bounded(promise, label, ms = 15000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]); }
  finally { clearTimeout(timer); }
}

// Test-only instrumentation: the unchanged app still runs in a real selected-
// runtime child. Passive rename telemetry never injects faults; the optional
// gate pauses a synced journal's tip publication to exercise disconnect timing.
const instrumentedEntry = `
  import filesystem from 'node:fs/promises';
  import { writeSync } from 'node:fs';
  import { basename, dirname } from 'node:path';
  const originalRename = filesystem.rename;
  const observation = { attempts: 0, errors: {} };
  let armed = false, gated = false, input = '', release;
  const gate = new Promise(resolve => { release = resolve; });
  if (process.env.QA_GATE === '1') {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      input += chunk;
      let end;
      while ((end = input.indexOf('\\n')) !== -1) {
        const line = input.slice(0, end); input = input.slice(end + 1);
        if (line === 'qa-arm') { armed = true; process.stdout.write('{"qaArmed":true}\\n'); }
        if (line === 'qa-release') release();
      }
    });
  }
  filesystem.rename = async (source, destination) => {
    const tip = basename(destination) === 'tip.json' && basename(source).startsWith('.tip-')
      && dirname(source) === dirname(destination);
    if (!tip) return originalRename(source, destination);
    observation.attempts++;
    if (armed && !gated) {
      gated = true; process.stdout.write('{"qaGateEntered":true}\\n'); await gate;
    }
    try {
      const result = await originalRename(source, destination);
      if (gated) process.stdout.write('{"qaGatePublished":true}\\n');
      return result;
    }
    catch (error) {
      const code = /^[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'UNKNOWN';
      observation.errors[code] = (observation.errors[code] || 0) + 1; throw error;
    }
  };
  process.on('exit', () => writeSync(2, JSON.stringify({ qaIo: observation }) + '\\n'));
  process.argv = [process.execPath, 'app.mjs', '--data', process.env.QA_DATA_DIR, '--port', process.env.QA_PORT];
  await import('./app.mjs');
`;

async function launch(dir, { port = 0, fail = false, verifyGate = false, observeIO = false } = {}) {
  const instrumented = verifyGate || observeIO;
  const record = childProcess(instrumented ? ['--input-type=module', '-e', instrumentedEntry]
    : ['app.mjs', '--data', dir, '--port', String(port)], {
    RELAY_BOOTSTRAP_TOKEN: bootstrap, QA_DATA_DIR: dir, QA_PORT: String(port), QA_GATE: verifyGate ? '1' : '0',
  });
  await bounded((async () => {
    while (!record.out.includes('\n') && !record.done) await delay(5);
  })(), 'Startup timeout');
  if (fail) {
    const result = await bounded(record.exit, 'Refused service must exit');
    assert.notEqual(result.code, 0);
    assert.equal(record.out, '', 'Rejected startup cannot announce readiness');
    const value = JSON.parse(record.err);
    assert.equal(typeof value.error.code, 'string');
    secretFree(record.err);
    return;
  }
  assert.ok(record.out.includes('\n'), 'Readiness must precede exit');
  const ready = JSON.parse(record.out.split('\n')[0]);
  assert.deepEqual(Object.keys(ready).sort(), ['port', 'ready']);
  assert.equal(ready.ready, true);
  assert.ok(Number.isInteger(ready.port) && ready.port > 0);
  if (port) assert.equal(ready.port, port);
  return {
    record, dir, url: `http://127.0.0.1:${ready.port}`,
    async stop(crash = false) {
      if (record.done) return;
      if (crash) record.child.kill('SIGKILL'); else record.child.stdin.end('shutdown\n');
      let result;
      try { result = await bounded(record.exit, 'Owned service did not stop'); }
      catch (error) {
        // A shutdown failure is still a test failure, but never leaks an owned
        // verification process into later groups or the caller's environment.
        record.child.kill('SIGKILL'); await record.exit; throw error;
      }
      if (!crash) assert.equal(result.code, 0, 'Graceful shutdown exit');
      secretFree(record.out); secretFree(record.err);
    },
  };
}

test.after(async () => {
  const pending = [...children];
  for (const record of pending) if (!record.done) record.child.kill('SIGKILL');
  await Promise.allSettled(pending.map(record => record.exit));
  assert.equal(children.size, 0, 'All owned child processes stopped');
});

async function raw(service, path, { token, method = 'GET', body, key, headers, bytes } = {}) {
  const requestHeaders = headers || {
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    ...(body === undefined && bytes === undefined ? {} : { 'content-type': 'application/json' }),
    ...(key === undefined ? {} : { 'idempotency-key': key }),
  };
  return bounded(new Promise((resolve, reject) => {
    // Raw header arrays bypass node:http's automatic Host header generation.
    const completeHeaders = Array.isArray(requestHeaders)
      ? ['Host', new URL(service.url).host, ...requestHeaders] : requestHeaders;
    const req = httpRequest(service.url + path, { method, headers: completeHeaders }, res => {
      let text = '';
      res.setEncoding('utf8').on('data', chunk => { text += chunk; });
      res.on('end', () => {
        try {
          assert.ok(text.length > 0, `${method} ${path}: HTTP ${res.statusCode} returned empty body`);
          const value = JSON.parse(text);
          if (res.statusCode >= 400) {
            assert.equal(typeof value.error.code, 'string');
            assert.equal(typeof value.error.message, 'string');
            secretFree(text);
          }
          resolve({ status: res.statusCode, value });
        } catch (error) { reject(error); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(bytes === undefined ? body === undefined ? undefined : JSON.stringify(body) : bytes);
  }), 'HTTP request timeout');
}

async function request(service, token, path, method = 'GET', body, key, expected = 200) {
  const result = await raw(service, path, { token, method, body, key });
  assert.equal(result.status, expected, `${method} ${path}: expected ${expected}, got ${result.status}`);
  return result.value;
}

async function fixture(t, label, options = {}) {
  const dir = await directory(label);
  let service = await launch(dir, options);
  t.after(() => service?.stop());
  const base = '/v1/workspaces/qa-main';
  const api = (token, suffix = '', method = 'GET', body, key, status) => request(service, token, base + suffix, method, body, key, status);
  const owner = remember((await request(service, bootstrap, '/v1/workspaces', 'POST', { id: 'qa-main', name: 'Synthetic QA' }, undefined, 201)).ownerToken);
  const tokens = { owner: { token: owner, subject: 'owner', role: 'owner' } };
  for (const [labelName, subject, role] of [
    ['editor','edit','editor'], ['twinEditor','edit','editor'], ['otherEditor','other','editor'],
    ['approver','approve','approver'], ['twinApprover','edit','approver'],
    ['worker','work','worker'], ['twinWorker','work','worker'], ['otherWorker','otherwork','worker'], ['viewer','view','viewer'],
  ]) {
    tokens[labelName] = await api(owner, '/tokens', 'POST', { subject, role });
    remember(tokens[labelName].token);
  }
  const f = {
    dir, base, tokens, owner, api, get service() { return service; },
    stage: async (data = csv, key = randomBytes(8).toString('hex'), version = 0, token = tokens.editor.token) =>
      (await api(token, '/imports', 'POST', { baseVersion: version, csv: data }, key, 201)).import,
    async approved(data = csv, version = 0) {
      const item = await f.stage(data, undefined, version);
      await api(tokens.approver.token, `/imports/${item.id}/approve`, 'POST', {});
      return item;
    },
    claim: async (item, token = tokens.worker.token, leaseMs = 5000) => {
      const value = await api(token, `/imports/${item.id}/claim`, 'POST', { leaseMs });
      remember(value.leaseToken); return value;
    },
    async commit(item, lease, key = randomBytes(8).toString('hex'), token = tokens.worker.token, status = 200) {
      return api(token, `/imports/${item.id}/commit`, 'POST', { leaseToken: lease.leaseToken }, key, status);
    },
    async events() {
      const all = []; let after = 0;
      while (true) {
        const page = await api(tokens.viewer.token, `/events?after=${after}&limit=7`);
        if (!page.events.length) { assert.equal(page.nextCursor, after); break; }
        assert.equal(page.nextCursor, page.events.at(-1).cursor);
        all.push(...page.events); after = page.nextCursor;
      }
      assert.deepEqual(all.map(value => value.cursor), all.map((_, index) => index + 1));
      for (const value of all) assert.deepEqual(Object.keys(value).sort(), ['cursor','importId','subject','type']);
      secretFree(JSON.stringify(all)); return all;
    },
    async restart(crash = false) {
      await service.stop(crash); service = undefined;
      service = await launch(dir);
    },
    async stop() { await service.stop(); service = undefined; },
  };
  return f;
}

test('QA role/tenant matrix, duplicate auth and malformed request isolation', { timeout: 45000 }, async t => {
  const f = await fixture(t, 'auth');
  const { api, tokens: ts, owner } = f;
  const item = await f.stage();
  const suffix = `/imports/${item.id}`;
  for (const role of ['owner','editor','approver','worker','viewer']) {
    await request(f.service,ts[role].token,'/v1/workspaces','POST',{ id:'not-permitted',name:'No' },undefined,403);
    for (const path of ['', '/members', '/imports', suffix, '/events']) await api(ts[role].token, path);
    if (role !== 'owner') {
      await api(ts[role].token, '/tokens', 'POST', { subject: 'new', role: 'viewer' }, undefined, 403);
      await api(ts[role].token, `/tokens/${ts.viewer.id}/revoke`, 'POST', {}, undefined, 403);
    }
    if (!['owner','editor'].includes(role)) await api(ts[role].token, '/imports', 'POST', { baseVersion: 0, csv }, 'matrix', 403);
    if (!['owner','approver'].includes(role)) {
      await api(ts[role].token, suffix + '/approve', 'POST', {}, undefined, 403);
      await api(ts[role].token, suffix + '/reject', 'POST', { reason: 'No' }, undefined, 403);
    }
    if (role !== 'worker') {
      await api(ts[role].token, suffix + '/claim', 'POST', { leaseMs: 100 }, undefined, 403);
      await api(ts[role].token, suffix + '/commit', 'POST', { leaseToken: 'synthetic-wrong' }, 'matrix', 403);
    }
  }
  await api(ts.twinApprover.token, suffix + '/approve', 'POST', {}, undefined, 403);
  await api(owner, '/imports/absent', 'GET', undefined, undefined, 404);
  const otherOwner = remember((await request(f.service, bootstrap, '/v1/workspaces', 'POST', { id: 'qa-other', name: 'Other' }, undefined, 201)).ownerToken);
  for (const path of ['', '/imports/absent', suffix + '/claim', suffix + '/commit', '/tokens', '/events']) {
    const mutation = path.endsWith('/claim') || path.endsWith('/commit') || path === '/tokens';
    await api(otherOwner, path, mutation ? 'POST' : 'GET', mutation ? {} : undefined, 'tenant', 403);
    await api(bootstrap, path, mutation ? 'POST' : 'GET', mutation ? {} : undefined, 'tenant', 403);
  }
  const before = await f.events();
  for (const body of [
    { id:'aa',name:'Short id' }, { id:'a'.repeat(25),name:'Long id' }, { id:'Bad',name:'Uppercase id' },
    { id:'qa-bad',name:' ' }, { id:'qa-bad',name:'N'.repeat(81) },
  ]) await request(f.service,bootstrap,'/v1/workspaces','POST',body,undefined,400);
  for (const body of [
    { subject:'',role:'viewer' }, { subject:'x'.repeat(33),role:'viewer' },
    { subject:'space name',role:'worker' }, { subject:'valid',role:'owner' }, { subject:'valid',role:'Editor' },
  ]) await api(owner,'/tokens','POST',body,undefined,400);
  for (const authorization of [undefined, '', 'Basic synthetic', 'Bearer', 'Bearer wrong', `Bearer ${owner} extra`]) {
    const result = await raw(f.service, f.base, { headers: authorization === undefined ? {} : { authorization } });
    assert.equal(result.status, 401);
  }
  for (const headers of [
    ['Authorization', `Bearer ${owner}`, 'Authorization', `Bearer ${owner}`],
    ['Authorization', 'Bearer unknown', 'Authorization', `Bearer ${owner}`],
  ]) assert.equal((await raw(f.service, f.base, { headers })).status, 401);
  for (const path of ['/%', '/v1/workspaces/%C0%AF', '/v1/workspaces/qa-main%2Fmembers', '/v1/workspaces/%00']) {
    assert.equal((await raw(f.service, path, { token: owner })).status, 400);
  }
  for (const query of ['after=', 'after=-0', 'after=+1', 'after=1.0', 'after=Infinity', 'after=9007199254740992', 'after=1&after=2', 'limit=0', 'limit=101', 'limit=1&limit=2']) {
    await api(owner, '/events?' + query, 'GET', undefined, undefined, 400);
  }
  assert.deepEqual(await f.events(), before);
  assert.deepEqual(await request(f.service, undefined, '/health'), { ok: true });
});

test('QA exact UTF-8/body/CSV/row boundaries and atomic malformed input', { timeout: 45000 }, async t => {
  const f = await fixture(t, 'bounds');
  const editor = f.tokens.editor.token;
  const before = await f.events();
  const body = JSON.stringify({ baseVersion: 0, csv });
  for (const [bytes, expected] of [
    [Buffer.from(body + ' '.repeat(262144 - Buffer.byteLength(body))), 201],
    [Buffer.from(body + ' '.repeat(262145 - Buffer.byteLength(body))), 413],
    [Buffer.concat([Buffer.from('{"csv":"'), Buffer.from([0xc0,0xaf]), Buffer.from('"}')]), 400],
    [Buffer.from('{'), 400], [Buffer.from('null'), 400], [Buffer.from('[]'), 400],
  ]) {
    const result = await raw(f.service, f.base + '/imports', { token: editor, method: 'POST', bytes, key: randomBytes(8).toString('hex') });
    assert.equal(result.status, expected);
  }
  assert.equal((await f.events()).length, before.length + 1);
  for (const headers of [
    { authorization: `Bearer ${editor}` },
    { authorization: `Bearer ${editor}`, 'content-type': 'text/json' },
    ['Authorization', `Bearer ${editor}`, 'Content-Type', 'application/json', 'Content-Type', 'application/json'],
  ]) assert.equal((await raw(f.service, f.base + '/imports', { method: 'POST', headers, bytes: Buffer.from('{}') })).status, 415);
  const rows = Array.from({ length: 500 }, (_, i) => ({ id: `r${i}`, name: 'é', email: `u${i}${'x'.repeat(35)}@example.test` }));
  const serialize = () => header + rows.map(row => `upsert,${row.id},${row.name},${row.email}`).join('\n');
  let remaining = 65536 - Buffer.byteLength(serialize());
  assert.ok(remaining > 0);
  for (const row of rows) {
    const add = Math.min(79, remaining); row.name += 'N'.repeat(add); remaining -= add;
  }
  assert.equal(remaining, 0);
  const exact = serialize();
  assert.equal(Buffer.byteLength(exact), 65536);
  const accepted = await f.stage(exact);
  assert.equal(accepted.rowCount, 500); assert.equal(accepted.digest, digest(Buffer.from(exact)));
  await f.api(editor, '/imports', 'POST', { baseVersion: 0, csv: exact + '\n' }, 'csv-too-large', 413);
  await f.stage(header + 'delete,one,,');
  await f.stage('\uFEFFop,external_id,name,email\r\nupsert,q,"Quoted, ""Q""",Q@example.test\r\n');
  const longestEmail = 'x'.repeat(120 - '@example.test'.length) + '@example.test';
  await f.stage(header + `upsert,${'a'.repeat(32)},${'😀'.repeat(80)},${longestEmail}`);
  const invalidCsv = [
    header, header + '\n', header + Array.from({ length: 501 }, (_, i) => `delete,z${i},,`).join('\n'),
    header + 'upsert,a,A,a@example.test\n\nupsert,b,B,b@example.test',
    header + 'upsert,a,A,a@example.test\n\n', header + 'upsert,a,A,a@example.test\r',
    header + 'upsert,a,A,a@example.test,extra', header + 'upsert,a,A',
    header + 'upsert,a,A,a@example.test\nupsert,a,B,b@example.test',
    header + 'upsert,a,A"bad,a@example.test', header + 'upsert,a,"closed"x,a@example.test',
    header + 'upsert,a,"not closed,a@example.test', header + 'delete,a, ,',
    header + 'delete,a,,x', header + 'unknown,a,,',
    ...['\u0000','\u0009','\u000a','\u007f','\u0085'].map(c => header + `upsert,a,"bad${c}name",a@example.test`),
    header + 'upsert,a,' + 'N'.repeat(81) + ',a@example.test',
    header + `upsert,a,Valid,x${longestEmail}`,
    ...['a@@example.test','@example.test','a@example','a@.test','a@example.','a@exam ple.test','a@exam\u0000ple.test'].map(email => header + `upsert,a,A,${email}`),
    header + `upsert,${'a'.repeat(33)},A,a@example.test`,
  ];
  const stable = await f.events();
  for (const value of invalidCsv) await f.api(editor, '/imports', 'POST', { baseVersion: 0, csv: value }, 'bad-csv', 400);
  for (const baseVersion of [-1, 0.5, '0', null, 9007199254740992]) {
    await f.api(editor, '/imports', 'POST', { baseVersion, csv }, 'bad-base', 400);
  }
  for (const key of [undefined, '', 'bad key', 'x'.repeat(81)]) await f.api(editor, '/imports', 'POST', { baseVersion: 0, csv }, key, 400);
  assert.equal((await raw(f.service, f.base + '/imports', { method: 'POST', bytes: Buffer.from(body), headers: [
    'Authorization', `Bearer ${editor}`, 'Content-Type', 'application/json', 'Idempotency-Key', 'one', 'Idempotency-Key', 'one',
  ] })).status, 400);
  assert.deepEqual(await f.events(), stable);
  assert.deepEqual(await f.api(editor, '/members'), { version: 0, members: [] });
  // Exercise the maximum accepted batch, not just its staging projection.
  await f.api(f.tokens.approver.token, `/imports/${accepted.id}/approve`, 'POST', {});
  const applied = await f.commit(accepted, await f.claim(accepted));
  assert.equal(applied.applied, 500); assert.equal(applied.version, 1);
  assert.equal((await f.api(editor, '/members')).members.length, 500);
});

test('QA subject-scoped canonical replays, revocation and terminal state invariants', { timeout: 45000 }, async t => {
  const f = await fixture(t, 'replays');
  const { api, tokens: ts } = f;
  const item = await f.stage(csv, 'shared');
  const path = `/imports/${item.id}`;
  const before = await f.events();
  const repeat = await api(ts.twinEditor.token, '/imports', 'POST', { csv, baseVersion: 0 }, 'shared');
  assert.equal(repeat.import.id, item.id);
  assert.deepEqual(await f.events(), before);
  const independent = await f.stage(csv, 'shared', 0, ts.otherEditor.token);
  assert.notEqual(independent.id, item.id);
  await api(ts.editor.token, '/imports', 'POST', { baseVersion: 0, csv, extra: true }, 'shared', 409);
  await api(ts.approver.token, path + '/approve', 'POST', { extra: true }, undefined, 400);
  await api(ts.approver.token, path + '/approve', 'POST', {});
  const approvedEvents = await f.events();
  await api(ts.approver.token, path + '/approve', 'POST', {});
  await api(f.owner, path + '/approve', 'POST', {}, undefined, 409);
  assert.deepEqual(await f.events(), approvedEvents);
  for (const who of ['viewer','approver','worker','otherEditor']) await api(ts[who].token, path + '/cancel', 'POST', {}, undefined, 403);
  await api(ts.twinEditor.token, path + '/cancel', 'POST', {});
  // A repeat approval after cancellation is allowed only as an idempotent
  // observation: it must never change a terminal state or append an event.
  const terminalEvents = await f.events();
  const repeatTerminal = await api(ts.approver.token, path + '/approve', 'POST', {});
  assert.equal(repeatTerminal.import.state, 'cancelled');
  for (const operation of ['claim','reject','cancel']) {
    const token = operation === 'claim' ? ts.worker.token : f.owner;
    await api(token, path + '/' + operation, 'POST', operation === 'claim' ? { leaseMs: 100 } : operation === 'reject' ? { reason: 'no' } : {}, undefined, 409);
  }
  assert.deepEqual(await f.events(), terminalEvents);
  const rejected = await f.stage();
  for (const reason of ['', ' ', 'x'.repeat(161), 1]) await api(ts.approver.token, `/imports/${rejected.id}/reject`, 'POST', { reason }, undefined, 400);
  await api(ts.approver.token, `/imports/${rejected.id}/reject`, 'POST', { reason: '  Not suitable  ' });
  await api(ts.approver.token, `/imports/${rejected.id}/approve`, 'POST', {}, undefined, 409);
  await api(ts.worker.token, `/imports/${rejected.id}/claim`, 'POST', { leaseMs: 100 }, undefined, 409);
  await api(f.owner, `/tokens/${ts.editor.id}/revoke`, 'POST', {});
  const revokedEvents = await f.events();
  await api(f.owner, `/tokens/${ts.editor.id}/revoke`, 'POST', {});
  await api(ts.editor.token, '/imports', 'POST', { csv, baseVersion: 0 }, 'shared', 401);
  await api(ts.viewer.token, '/imports', 'POST', { csv, baseVersion: 0 }, 'shared', 403);
  assert.deepEqual(await f.events(), revokedEvents);
  await f.restart();
  await api(ts.editor.token, '', 'GET', undefined, undefined, 401);
  assert.equal((await api(ts.twinEditor.token, '/imports', 'POST', { csv, baseVersion: 0 }, 'shared')).import.id, item.id);
  assert.deepEqual(await f.events(), revokedEvents);
});

test('QA concurrent claims/commits, precise capability fencing, expiry/revocation and restart', { timeout: 45000 }, async t => {
  const f = await fixture(t, 'fences');
  const ts = f.tokens;
  const item = await f.approved();
  const path = `/imports/${item.id}`;
  for (const leaseMs of [99,5001,100.5,'100',null]) await f.api(ts.worker.token, path + '/claim', 'POST', { leaseMs }, undefined, 400);
  const contenders = await Promise.all(Array.from({ length: 8 }, (_, i) => raw(f.service, f.base + path + '/claim', {
    token: i % 2 ? ts.worker.token : ts.twinWorker.token, method: 'POST', body: { leaseMs: 100 },
  })));
  assert.equal(contenders.filter(value => value.status === 200).length, 1);
  assert.equal(contenders.filter(value => value.status === 409).length, 7);
  const old = contenders.find(value => value.status === 200).value;
  remember(old.leaseToken); assert.equal(old.import.leaseEpoch, 1);
  await delay(140);
  await f.commit(item, old, 'expired', ts.worker.token, 409);
  const fresh = await f.claim(item, ts.worker.token);
  assert.equal(fresh.import.leaseEpoch, 2);
  await f.commit(item, old, 'old-token', ts.worker.token, 409);
  await f.commit(item, fresh, 'wrong-cap', ts.twinWorker.token, 409);
  await f.commit(item, fresh, 'wrong-subject', ts.otherWorker.token, 409);
  await f.api(ts.worker.token, path + '/claim', 'POST', { leaseMs: 5000 }, undefined, 409);
  const beforeRestart = await f.events();
  await f.restart(true);
  assert.equal((await f.api(ts.viewer.token, path)).import.leaseEpoch, 2);
  assert.deepEqual(await f.events(), beforeRestart);
  const concurrent = await Promise.all(Array.from({ length: 6 }, () => raw(f.service, f.base + path + '/commit', {
    token: ts.worker.token, method: 'POST', body: { leaseToken: fresh.leaseToken }, key: 'concurrent',
  })));
  assert.ok(concurrent.every(value => value.status === 200));
  for (const value of concurrent) assert.deepEqual(value.value, concurrent[0].value);
  const committed = concurrent[0].value;
  assert.equal(committed.version, 1);
  const after = await f.events();
  assert.equal(after.length, beforeRestart.length + 1);
  await f.commit(item, fresh, 'different-key', ts.worker.token, 409);
  await f.commit(item, fresh, 'concurrent', ts.twinWorker.token, 409);
  await f.api(ts.worker.token, path + '/commit', 'POST', { leaseToken: 'wrong' }, 'concurrent', 409);
  await f.api(ts.worker.token, path + '/claim', 'POST', { leaseMs:100 }, undefined, 409);
  await f.api(f.owner, path + '/cancel', 'POST', {}, undefined, 409);
  await f.api(f.owner, path + '/reject', 'POST', { reason:'terminal' }, undefined, 409);
  assert.equal((await f.api(ts.approver.token, path + '/approve', 'POST', {})).import.state,'committed');
  assert.deepEqual(await f.events(),after);
  await f.restart();
  // Replay validity does not depend on the now-expired lease.
  await delay(Math.max(0, fresh.expiresAt - Date.now() + 20));
  assert.deepEqual(await f.commit(item, fresh, 'concurrent'), committed);
  await f.api(f.owner, `/tokens/${ts.worker.id}/revoke`, 'POST', {});
  await f.commit(item, fresh, 'concurrent', ts.worker.token, 401);
  const second = await f.approved(header + 'upsert,c,Gamma,gamma@example.test', 1);
  const lease = await f.claim(second, ts.twinWorker.token);
  const replacement = await f.api(f.owner,'/tokens','POST',{ subject:'work',role:'worker' });
  remember(replacement.token);
  await f.api(f.owner, `/tokens/${ts.twinWorker.id}/revoke`, 'POST', {});
  await f.commit(second, lease, 'revoked', ts.twinWorker.token, 401);
  await f.commit(second, lease, 'same-subject-revoked', replacement.token, 409);
  await f.api(ts.editor.token, `/imports/${second.id}/cancel`, 'POST', {});
  await f.api(ts.otherWorker.token, `/imports/${second.id}/claim`, 'POST', { leaseMs: 100 }, undefined, 409);
  assert.equal((await f.api(ts.viewer.token, '/members')).version, 1);
  assert.equal((await f.events()).filter(value => value.type === 'import.committed').length, 1);
});

test('QA email uniqueness, swaps, deletes/revisions and concurrent stale-base atomicity', { timeout: 45000 }, async t => {
  const f = await fixture(t, 'atomic');
  const first = await f.approved();
  await f.commit(first, await f.claim(first));
  const before = await f.api(f.owner, '/members');
  for (const invalid of [
    header + 'upsert,a,Changed,gamma@example.test\nupsert,c,Collision,BETA@example.test',
    header + 'upsert,a,Changed,gamma@example.test\ndelete,missing,,',
    header + 'upsert,c,One,same@example.test\nupsert,d,Two,SAME@example.test',
  ]) {
    const item = await f.approved(invalid, 1);
    const lease = await f.claim(item);
    const events = await f.events();
    await f.commit(item, lease, undefined, undefined, 409);
    assert.deepEqual(await f.api(f.owner, '/members'), before);
    assert.deepEqual(await f.events(), events);
    assert.equal((await f.api(f.owner, `/imports/${item.id}`)).import.state, 'leased');
  }
  const swap = await f.approved(header + 'upsert,a,Alpha,beta@example.test\nupsert,b,Beta,alpha@example.test', 1);
  await f.commit(swap, await f.claim(swap));
  assert.deepEqual((await f.api(f.owner, '/members')).members.map(value => value.revision), [2,2]);
  const remove = await f.approved(header + 'delete,a,,\nupsert,c,Gamma,beta@example.test', 2);
  await f.commit(remove, await f.claim(remove));
  assert.deepEqual((await f.api(f.owner, '/members')).members.map(value => [value.externalId,value.revision]), [['b',2],['c',1]]);
  const stale = await Promise.all([f.approved(header + 'upsert,a,Alpha,newalpha@example.test', 3), f.approved(header + 'upsert,z,Zeta,zeta@example.test', 3)]);
  const leases = await Promise.all(stale.map(item => f.claim(item)));
  const events = await f.events();
  const outcomes = await Promise.all(stale.map((item, index) => raw(f.service, f.base + `/imports/${item.id}/commit`, {
    token: f.tokens.worker.token, method: 'POST', body: { leaseToken: leases[index].leaseToken }, key: `stale-${index}`,
  })));
  assert.deepEqual(outcomes.map(value => value.status).sort(), [200,409]);
  assert.equal((await f.api(f.owner, '/members')).version, 4);
  assert.equal((await f.events()).length, events.length + 1);
  const stable = await f.api(f.owner, '/members');
  await f.restart(true);
  assert.deepEqual(await f.api(f.owner, '/members'), stable);
  const imports = (await f.api(f.owner, '/imports')).imports;
  assert.deepEqual(imports.map(value => value.id), imports.map(value => value.id).sort());
  for (const value of imports) assert.deepEqual(Object.keys(value).sort(), ['approvedBy','baseVersion','creator','digest','id','leaseEpoch','rowCount','state','workspaceId']);
});

async function cli(service, token, args, expected = 0) {
  const record = childProcess(['cli.mjs', ...args], { RELAY_URL: service.url, RELAY_TOKEN: token });
  const result = await bounded(record.exit, 'CLI timeout');
  assert.equal(result.code, expected, 'CLI exit status');
  assert.equal(expected ? record.out : record.err, '');
  const text = expected ? record.err : record.out;
  assert.equal(text.trim().split('\n').length, 1);
  if (expected) { secretFree(text); assert.ok(!text.includes(service.url)); }
  return JSON.parse(text);
}

test('QA real CLI and typed .mts SDK consumer share durable service state', { timeout: 45000 }, async t => {
  // Only this finite QA group uses PORT. Other groups use ephemeral listeners.
  let port = Number(process.env.PORT || 0);
  if (port) {
    const occupied = await new Promise(resolve => {
      const socket = connect({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    if (occupied) { t.diagnostic('PORT already occupied; leaving its listener untouched and selecting an ephemeral port'); port = 0; }
  }
  const f = await fixture(t, 'clients', { port });
  const ts = f.tokens;
  const path = join(f.dir, 'qa-synthetic.csv');
  await writeFile(path, '\uFEFFop,external_id,name,email\r\nupsert,cli,CLI Synthetic,CLI@example.test\r\n');
  assert.equal((await cli(f.service, ts.viewer.token, ['status','qa-main'])).workspace.version, 0);
  assert.deepEqual((await cli(f.service, ts.viewer.token, ['members','qa-main'])).members, []);
  const args = ['stage','qa-main','--file',path,'--base-version','0','--key','cli-stage'];
  const staged = await cli(f.service, ts.editor.token, args);
  assert.equal((await cli(f.service, ts.editor.token, args)).import.id, staged.import.id);
  await cli(f.service, ts.approver.token, ['approve','qa-main',staged.import.id]);
  const lease = await cli(f.service, ts.worker.token, ['claim','qa-main',staged.import.id,'--lease-ms','5000']);
  remember(lease.leaseToken);
  const commitArgs = ['commit','qa-main',staged.import.id,'--lease-token',lease.leaseToken,'--key','cli-commit'];
  assert.equal((await cli(f.service, ts.worker.token, commitArgs)).version, 1);
  assert.equal((await cli(f.service, ts.worker.token, commitArgs)).version, 1);
  await cli(f.service, ts.viewer.token, args, 1);
  await cli(f.service, ts.worker.token, ['commit','qa-main',staged.import.id,'--lease-token',lease.leaseToken,'--key'], 1);
  assert.ok((await cli(f.service, ts.viewer.token, ['events','qa-main','--after','0','--limit','100'])).events.length > 0);
  const cancelled = await f.stage(header + 'delete,cli,,', 'cli-cancel', 1);
  assert.equal((await cli(f.service, ts.editor.token, ['cancel','qa-main',cancelled.id])).import.state, 'cancelled');
  const consumer = childProcess(['--input-type=module', '-e', `
    import { verifyTypedSdk } from './tests/sdk-usage.mts';
    const value = await verifyTypedSdk({ baseUrl: process.env.RELAY_URL, workspaceId: 'qa-main',
      editorToken: process.env.QA_EDITOR, approverToken: process.env.QA_APPROVER, workerToken: process.env.QA_WORKER });
    console.log(JSON.stringify(value));
  `], { RELAY_URL: f.service.url, QA_EDITOR: ts.editor.token, QA_APPROVER: ts.approver.token, QA_WORKER: ts.worker.token });
  assert.equal((await bounded(consumer.exit, 'Typed SDK consumer timeout')).code, 0);
  assert.equal(consumer.err, '');
  assert.deepEqual(JSON.parse(consumer.out), { ok: true, version: 2 });
  secretFree(consumer.out);
  await assert.rejects(createClient({ baseUrl: f.service.url, token: 'synthetic-invalid' }).workspace('qa-main'),
    error => error instanceof RelayError && error.status === 401 && typeof error.code === 'string');
  const members = await f.api(ts.viewer.token, '/members');
  await f.restart();
  assert.deepEqual(await cli(f.service, ts.viewer.token, ['members','qa-main']), members);
  assert.deepEqual(await request(f.service, undefined, '/health'), { ok: true });
});

test('QA lock reclamation races, unrelated files and no plaintext secrets on disk', { timeout: 45000 }, async t => {
  const f = await fixture(t, 'locks');
  const item = await f.approved();
  const lease = await f.claim(item);
  await f.commit(item, lease, 'durable');
  const stable = await f.api(f.owner, '/members');
  await writeFile(join(f.dir, 'unrelated.txt'), 'synthetic unrelated sentinel');
  await writeFile(join(f.dir, '.relay-lock', '.candidate-unrelated.json'), 'synthetic untouched candidate');
  await Promise.all(Array.from({ length: 5 }, () => launch(f.dir, { fail: true })));
  assert.deepEqual(await f.api(f.owner, '/members'), stable);
  await f.service.stop(true);
  const candidates = Array.from({ length: 6 }, () => childProcess(['app.mjs','--data',f.dir,'--port','0'], { RELAY_BOOTSTRAP_TOKEN: bootstrap }));
  await bounded((async () => {
    while (candidates.some(record => !record.done && !record.out.includes('\n'))) await delay(5);
  })(), 'Reclamation race timeout');
  const winners = candidates.filter(record => record.out.includes('\n'));
  assert.equal(winners.length, 1, 'Exactly one reclaimer can become ready');
  const ready = JSON.parse(winners[0].out.split('\n')[0]);
  assert.equal(ready.ready, true);
  const service = { url: `http://127.0.0.1:${ready.port}` };
  assert.deepEqual(await request(service, f.owner, f.base + '/members'), stable);
  winners[0].child.stdin.end('shutdown\n');
  for (const record of candidates) {
    const result = await bounded(record.exit, 'Race child shutdown');
    assert.equal(result.code === 0, record === winners[0]); secretFree(record.out); secretFree(record.err);
  }
  assert.equal(await readFile(join(f.dir,'unrelated.txt'),'utf8'), 'synthetic unrelated sentinel');
  assert.equal(await readFile(join(f.dir,'.relay-lock','.candidate-unrelated.json'),'utf8'), 'synthetic untouched candidate');
  async function scan(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) await scan(join(dir,entry.name));
      else if (entry.name !== 'qa-synthetic.csv') secretFree(await readFile(join(dir,entry.name),'utf8'));
    }
  }
  await scan(f.dir);
});

test('QA anchored corruption matrix, missing tip and valid post-fsync crash tail', { timeout: 60000 }, async t => {
  const f = await fixture(t, 'corrupt-source');
  await f.stage();
  const state = await f.api(f.owner, '/members');
  const events = await f.events();
  await f.stop();
  const original = await readFile(join(f.dir,'transactions.jsonl'));
  const lines = original.toString('utf8').trimEnd().split('\n');
  const cases = [
    ['partial', bytes => Buffer.concat([bytes,Buffer.from('{"partial":')])],
    ['checksum', bytes => Buffer.from(bytes.toString().replace('Synthetic QA','Synthetic XX'))],
    ['reorder', () => Buffer.from([lines[1],lines[0],...lines.slice(2)].join('\n') + '\n')],
    ['gap', () => Buffer.from([lines[0],...lines.slice(2)].join('\n') + '\n')],
    ['suffix', () => Buffer.from(lines.slice(0,-1).join('\n') + '\n')],
    ['lf', bytes => bytes.subarray(0,bytes.length - 1)],
    ['empty', () => Buffer.alloc(0)],
    ['utf8', bytes => Buffer.concat([bytes,Buffer.from([0xc3,0x28,10])])],
  ];
  for (const [label, mutate] of cases) {
    const dir = await directory('corrupt-' + label);
    await cp(f.dir,dir,{ recursive:true });
    const bytes = mutate(original);
    await writeFile(join(dir,'transactions.jsonl'),bytes);
    await launch(dir,{ fail:true });
    assert.ok((await readFile(join(dir,'transactions.jsonl'))).equals(bytes), 'Fail closed without journal repair');
  }
  for (const reserved of ['transactions.jsonl',join('.relay-lock','tip.json'),join('.relay-lock','initialized.json')]) {
    const dir = await directory('missing'); await cp(f.dir,dir,{ recursive:true });
    await unlink(join(dir,reserved));
    // Missing initialization marker alone is a permitted genesis-marker crash
    // recovery; missing initialized journal/tip must always fail closed.
    if (reserved.endsWith('initialized.json')) {
      const service = await launch(dir); await service.stop();
    } else await launch(dir,{ fail:true });
  }
  const tailDir = await directory('tail'); await cp(f.dir,tailDir,{ recursive:true });
  const prior = JSON.parse(lines.at(-2));
  await writeFile(join(tailDir,'.relay-lock','tip.json'),canonical({ format:1,seq:prior.seq,hash:prior.hash }) + '\n');
  const recovered = await launch(tailDir); t.after(() => recovered.stop());
  assert.deepEqual(await request(recovered,f.owner,f.base + '/members'),state);
  assert.deepEqual((await request(recovered,f.owner,f.base + '/events?limit=100')).events,events);
  await recovered.stop();
  const tip = JSON.parse(await readFile(join(tailDir,'.relay-lock','tip.json'),'utf8'));
  const last = JSON.parse(lines.at(-1)); assert.equal(tip.seq,last.seq); assert.equal(tip.hash,last.hash);
  assert.ok((await readFile(join(tailDir,'transactions.jsonl'))).equals(original));
});

test('QA reserved symlink/unexpected file safety', { timeout: 45000 }, async t => {
  const outside = await directory('symlink-target');
  const sentinel = join(outside,'sentinel.txt'); await writeFile(sentinel,'synthetic target untouched');
  for (const reserved of ['transactions.jsonl','.relay-lock']) {
    const dir = await directory('unsafe-type');
    if (reserved === 'transactions.jsonl') await mkdir(join(dir,reserved));
    else await writeFile(join(dir,reserved),'synthetic reserved conflict');
    await launch(dir,{ fail:true });
  }
  const source = await fixture(t,'symlink-source'); await source.stop();
  for (const reserved of ['transactions.jsonl',join('.relay-lock','tip.json'),join('.relay-lock','root.json'),'.relay-lock']) {
    const dir = await directory('symlink');
    if (reserved === '.relay-lock') {
      await symlink(outside,join(dir,reserved),'junction');
    } else {
      await cp(source.dir,dir,{ recursive:true });
      await unlink(join(dir,reserved));
      try { await symlink(sentinel,join(dir,reserved),'file'); }
      catch (error) {
        if (error.code !== 'EPERM') throw error;
        t.diagnostic('Windows denies file symlink creation; file-symlink branches not exercised');
        continue;
      }
    }
    await launch(dir,{ fail:true });
    assert.equal(await readFile(sentinel,'utf8'),'synthetic target untouched');
    assert.ok((await lstat(join(dir,reserved))).isSymbolicLink());
  }
});

test('QA aborted-body regression', { timeout: 45000 }, async t => {
  const f = await fixture(t,'abort');
  // Aborting a syntactically incomplete mutation must not crash or append.
  const before = await f.events();
  await new Promise(resolve => {
    const req = httpRequest(f.service.url + f.base + '/imports', { method:'POST', headers: {
      authorization:`Bearer ${f.tokens.editor.token}`, 'content-type':'application/json','idempotency-key':'aborted',
    } });
    req.on('error',() => resolve()); req.write('{"csv":"');
    setTimeout(() => { req.destroy(); resolve(); },30);
  });
  await delay(30);
  assert.deepEqual(await f.events(),before);
  assert.deepEqual(await request(f.service,undefined,'/health'),{ ok:true });
});

test('QA real HTTP graceful drain', { timeout: 45000 }, async t => {
  const f = await fixture(t,'drain');
  const before = await f.events();
  const requestBody = JSON.stringify({ baseVersion:0,csv });
  let req;
  const response = new Promise((resolve,reject) => {
    req = httpRequest(f.service.url + f.base + '/imports',{ method:'POST',agent:false,headers:{
      authorization:`Bearer ${f.tokens.editor.token}`,'content-type':'application/json','idempotency-key':'drained',
      'content-length':Buffer.byteLength(requestBody),
    } },res => {
      let text=''; res.on('data',chunk => { text += chunk; });
      res.on('end',() => { try { resolve({ status:res.statusCode,value:JSON.parse(text) }); } catch(error) { reject(error); } });
      res.on('error',reject);
    });
    req.on('error',reject); req.write(requestBody.slice(0,10));
  });
  await delay(60);
  const stopping = f.service.stop().then(() => ({}),error => ({ error }));
  await delay(60);
  assert.equal(f.service.record.done,false,'Shutdown must wait for accepted incomplete mutation');
  req.end(requestBody.slice(10));
  const outcome = await bounded(response,'Drain response timeout').then(value => ({ value }),error => ({ error }));
  t.diagnostic(outcome.error ? `Accepted mutation response failed: ${outcome.error.code || outcome.error.message}`
    : `Accepted mutation returned HTTP ${outcome.value.status} after shutdown`);
  const stopped = await stopping;
  assert.ok(!stopped.error,'Graceful shutdown must exit after draining the accepted mutation (15-second bound)');
  assert.ok(!outcome.error,'Accepted mutation response must complete');
  assert.equal(outcome.value.status,201);
  await f.restart();
  assert.equal((await f.events()).length,before.length + 1);
  assert.equal((await f.api(f.owner,'/imports')).imports.length,1);
});

test('QA shutdown awaits a journal-started transaction with connected or disconnected response', { timeout: 60000 }, async t => {
  for (const disconnect of [false, true]) {
    const f = await fixture(t, disconnect ? 'tx-disconnect' : 'tx-connected', { verifyGate:true });
    const record = f.service.record;
    const before = await f.events();
    const priorTip = JSON.parse(await readFile(join(f.dir,'.relay-lock','tip.json'),'utf8'));
    const waitMarker = marker => bounded((async () => {
      while (!record.out.includes(marker)) {
        assert.equal(record.done,false,'Instrumented app must remain alive until its marker');
        await delay(5);
      }
    })(),'Transaction gate marker timeout');
    let req;
    try {
      record.child.stdin.write('qa-arm\n');
      await waitMarker('"qaArmed":true');
      const body = JSON.stringify({ baseVersion:0,csv });
      const outcome = new Promise((resolve,reject) => {
        req = httpRequest(f.service.url + f.base + '/imports',{ method:'POST',agent:false,headers:{
          authorization:`Bearer ${f.owner}`,'content-type':'application/json',
          'idempotency-key':'journal-started','content-length':Buffer.byteLength(body),
        } },res => {
          let text=''; res.on('data',chunk => { text += chunk; });
          res.on('end',() => { try { resolve({ status:res.statusCode,value:JSON.parse(text) }); } catch(error) { reject(error); } });
          res.on('error',reject);
        });
        req.on('error',reject); req.end(body);
      }).then(value => ({ value }),error => ({ error }));
      await waitMarker('"qaGateEntered":true');
      const inFlight = (await readFile(join(f.dir,'transactions.jsonl'),'utf8')).trimEnd().split('\n').map(JSON.parse);
      assert.equal(inFlight.at(-1).seq,priorTip.seq + 1,'Transaction must already be journaled before disconnect');
      assert.equal(inFlight.at(-1).state.workspaces[0].imports.length,1);
      assert.equal(JSON.parse(await readFile(join(f.dir,'.relay-lock','tip.json'),'utf8')).seq,priorTip.seq);
      // The wrapper pauses only a tip rename, never the request handler itself.
      // Therefore transport completion cannot stand in for transaction completion.
      if (disconnect) {
        req.destroy();
        assert.ok((await bounded(outcome,'Disconnected client must settle')).error);
      }
      record.child.stdin.write('shutdown\n');
      await delay(80);
      assert.equal(record.done,false);
      await f.api(f.owner,'/imports','POST',{ baseVersion:0,csv },'not-admitted',503);
      await launch(f.dir,{ fail:true });
      assert.equal(record.done,false,'Owner must not exit/release while the synced transaction awaits tip publication');
      assert.equal(JSON.parse(await readFile(join(f.dir,'.relay-lock','tip.json'),'utf8')).seq,priorTip.seq);
      record.child.stdin.end('qa-release\n');
      await waitMarker('"qaGatePublished":true');
      const response = await bounded(outcome,'Accepted response completion timeout');
      if (!disconnect) {
        assert.ok(!response.error,'Connected accepted response must be delivered');
        assert.equal(response.value.status,201);
      }
      let exit;
      try { exit = await bounded(record.exit,'In-flight disconnect shutdown timeout'); }
      catch (error) {
        const tip = JSON.parse(await readFile(join(f.dir,'.relay-lock','tip.json'),'utf8'));
        const records = (await readFile(join(f.dir,'transactions.jsonl'),'utf8')).trimEnd().split('\n').map(JSON.parse);
        t.diagnostic(`Hung after publication: disconnected=${disconnect}, anchoredDelta=${tip.seq - priorTip.seq}, journalDelta=${records.at(-1).seq - priorTip.seq}, imports=${records.at(-1).state.workspaces[0].imports.length}`);
        record.child.kill('SIGKILL'); await record.exit;
        await f.restart();
        assert.equal((await f.api(f.owner,'/imports')).imports.length,1);
        assert.equal((await f.events()).length,before.length + 1);
        await f.stop();
        t.diagnostic('Forced-cleanup restart retained the completed mutation; shutdown still failed');
        throw error;
      }
      assert.equal(exit.code,0);
      secretFree(record.out); secretFree(record.err);
      const finalRecords = (await readFile(join(f.dir,'transactions.jsonl'),'utf8')).trimEnd().split('\n').map(JSON.parse);
      const tip = JSON.parse(await readFile(join(f.dir,'.relay-lock','tip.json'),'utf8'));
      assert.equal(tip.seq,priorTip.seq + 1);
      assert.equal(tip.hash,finalRecords.at(-1).hash);
      await f.restart();
      const imports = (await f.api(f.owner,'/imports')).imports;
      assert.equal(imports.length,1); assert.equal(imports[0].state,'staged');
      assert.equal((await f.events()).length,before.length + 1);
      const replay = await f.api(f.owner,'/imports','POST',{ csv,baseVersion:0 },'journal-started');
      assert.equal(replay.import.id,imports[0].id);
      assert.equal((await f.events()).length,before.length + 1);
      await f.stop();
      t.diagnostic(`Journal-started ${disconnect ? 'disconnected' : 'connected'} response: durable publication, lock retention, exit 0 and replay verified`);
    } finally {
      req?.destroy();
      if (!record.done && !record.child.stdin.writableEnded) record.child.stdin.write('qa-release\n');
    }
  }
});

test('QA 60 fresh app processes create once, replay and restart without request retries', { timeout: 90000 }, async t => {
  const observation = { freshStores:0, renameAttempts:0, realRenameErrors:{}, restarted:0 };
  for (let index=0;index<60;index++) {
    const dir = await directory('fresh-app');
    let service;
    try {
      service = await launch(dir,{ observeIO:true });
      const created = await request(service,bootstrap,'/v1/workspaces','POST',{ id:'qa-fresh',name:'Synthetic fresh process' },undefined,201);
      const owner = remember(created.ownerToken);
      const replay = await request(service,bootstrap,'/v1/workspaces','POST',{ name:'Synthetic fresh process',id:'qa-fresh' });
      assert.ok(replay.ownerToken === owner,'Exact creation replay retains its owner capability');
      assert.equal((await request(service,owner,'/v1/workspaces/qa-fresh/events')).events.length,1);
      await service.stop();
      const telemetry = service.record.err.trim().split('\n').map(JSON.parse);
      assert.equal(telemetry.length,1,'Only test-owned redacted I/O telemetry belongs on stderr');
      const io = telemetry[0].qaIo;
      assert.ok(Number.isInteger(io.attempts) && io.attempts >= 1);
      observation.renameAttempts += io.attempts;
      for (const [code,count] of Object.entries(io.errors)) {
        assert.ok(['EPERM','EBUSY','EACCES'].includes(code),'Only documented transient rename failures may recover');
        observation.realRenameErrors[code] = (observation.realRenameErrors[code] || 0) + count;
      }
      const records = (await readFile(join(dir,'transactions.jsonl'),'utf8')).trimEnd().split('\n').map(JSON.parse);
      const tip = JSON.parse(await readFile(join(dir,'.relay-lock','tip.json'),'utf8'));
      assert.equal(records.length,2,'One creation and its replay append only one transaction after genesis');
      assert.equal(tip.seq,2); assert.equal(tip.hash,records[1].hash);
      observation.freshStores++;
      service = await launch(dir);
      assert.equal((await request(service,owner,'/v1/workspaces/qa-fresh')).workspace.version,0);
      const events = (await request(service,owner,'/v1/workspaces/qa-fresh/events')).events;
      assert.deepEqual(events,[{ cursor:1,type:'workspace.created',subject:'bootstrap',importId:null }]);
      await service.stop(); observation.restarted++;
    } finally { await service?.stop(); }
  }
  assert.equal(observation.freshStores,60); assert.equal(observation.restarted,60);
  assert.equal(observation.renameAttempts,60 + Object.values(observation.realRenameErrors).reduce((sum,count) => sum + count,0));
  t.diagnostic(JSON.stringify(observation));
});
