import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, readdir, copyFile } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createClient, RelayError } from '../sdk.mjs';
import { exerciseSDK } from './sdk-types.mts';

const source = fileURLToPath(new URL('../', import.meta.url));
const root = resolve(process.env.DATA_DIR ?? '');
const rel = relative(source, root);
if (!process.env.DATA_DIR || !isAbsolute(process.env.DATA_DIR) || (!rel.startsWith('..') && !isAbsolute(rel))) {
  throw new Error('DATA_DIR must be absolute and outside authored source');
}
await mkdir(root, { recursive: true });
const runDir = await mkdtemp(join(root, 'relay-verify-'));
const dataDir = join(runDir, 'main');
const runtime = process.env.RELAY_TEST_RUNTIME || process.execPath;
const bootstrap = randomBytes(32).toString('hex');
const env = { ...process.env, RELAY_BOOTSTRAP_TOKEN: bootstrap };
const processes = new Set();
let groups = 0;
let assertions = 0;
let service;
let baseUrl;
const header = 'op,external_id,name,email';
const csv = (...rows) => [header, ...rows].join('\n');
function equal(actual, expected) { assertions++; assert.deepEqual(actual, expected); }
function ok(value, message) { assertions++; assert.ok(value, message); }
function group(name) { groups++; console.log(JSON.stringify({ check: name, ok: true })); }

async function start(dir = dataDir, expectReady = true) {
  const child = spawn(runtime, [join(source, 'app.mjs'), '--data', dir, '--port', '0'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  processes.add(child);
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = once(child, 'exit').then(([code, signal]) => { processes.delete(child); return { code, signal }; });
  const ready = new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('Startup deadline exceeded')), 15000);
    const examine = () => {
      if (!stdout.includes('\n')) return;
      try {
        const info = JSON.parse(stdout.split('\n')[0]);
        if (info.ready === true && Number.isInteger(info.port) && info.port > 0) {
          clearTimeout(timer); resolveReady(info);
        } else { clearTimeout(timer); reject(new Error('Invalid readiness line')); }
      } catch { clearTimeout(timer); reject(new Error('Invalid startup output')); }
    };
    child.stdout.on('data', examine);
    exited.then(result => { clearTimeout(timer); reject(new Error(`Startup exited (${result.code})`)); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  if (!expectReady) {
    ready.catch(() => {});
    const result = await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('Expected startup refusal')), 15000).unref())]);
    ok(result.code !== 0, 'Refused startup must exit nonzero');
    ok(!stdout.includes('"ready":true'), 'Failed startup must not announce readiness');
    ok(!stderr.includes(bootstrap), 'Startup error must not leak bootstrap');
    return;
  }
  const info = await ready;
  return { child, exited, port: info.port, stop: async () => {
    child.stdin.write('shutdown\n');
    const result = await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('Shutdown deadline exceeded')), 15000).unref())]);
    equal(result.code, 0);
    ok(!stderr.includes(bootstrap), 'No bootstrap in stderr');
  } };
}

async function api(path, token, body, expected = 200, key, method = body === undefined ? 'GET' : 'POST', extra = {}) {
  const response = await fetch(baseUrl + path, { method, headers: {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...(key ? { 'Idempotency-Key': key } : {}), ...extra,
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  equal(response.status, expected);
  if (expected >= 400) { ok(typeof result.error?.code === 'string'); ok(typeof result.error?.message === 'string'); }
  return result;
}
const wp = id => `/v1/workspaces/${id}`;
let sequence = 0;
async function stage(token, body, expected = 201, key = `stage_${++sequence}`, id = 'alpha') {
  return api(`${wp(id)}/imports`, token, body, expected, key);
}
async function issue(owner, subject, role, id = 'alpha') {
  return api(`${wp(id)}/tokens`, owner, { subject, role });
}
async function approve(token, id, expected = 200) { return api(`${wp('alpha')}/imports/${id}/approve`, token, {}, expected); }
async function claim(token, id, leaseMs = 5000, expected = 200) { return api(`${wp('alpha')}/imports/${id}/claim`, token, { leaseMs }, expected); }
async function commit(token, id, leaseToken, key = `commit_${++sequence}`, expected = 200) {
  return api(`${wp('alpha')}/imports/${id}/commit`, token, { leaseToken }, expected, key);
}
async function prepared(editor, approver, baseVersion, text) {
  const result = await stage(editor, { baseVersion, csv: text });
  await approve(approver, result.import.id);
  return result.import.id;
}
async function cli(args, token, expected = 0) {
  const child = spawn(runtime, [join(source, 'cli.mjs'), ...args], { env: { ...env, RELAY_URL: baseUrl, RELAY_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
  const [code] = await once(child, 'exit');
  if (expected === 0) { equal(code, 0); equal(stderr, ''); equal(stdout.trim().split('\n').length, 1); return JSON.parse(stdout); }
  ok(code !== 0); equal(stdout, ''); equal(stderr.trim().split('\n').length, 1);
  ok(!stderr.includes(token) && !stderr.includes(baseUrl), 'CLI errors must sanitize environment values');
  const result = JSON.parse(stderr); ok(typeof result.error?.code === 'string'); return result;
}

try {
  service = await start(); baseUrl = `http://127.0.0.1:${service.port}`;
  equal(await api('/health'), { ok: true });
  const made = await api('/v1/workspaces', bootstrap, { id: 'alpha', name: ' Alpha Synthetic ' }, 201, 'create_alpha');
  const owner = made.ownerToken;
  equal(made.workspace, { id: 'alpha', name: 'Alpha Synthetic', version: 0 });
  const createReplay = await api('/v1/workspaces', bootstrap, { name: ' Alpha Synthetic ', id: 'alpha' }, 200, 'create_alpha');
  ok(createReplay.ownerToken === owner);
  await api('/v1/workspaces', bootstrap, { id: 'alpha', name: 'Changed' }, 409, 'create_alpha');
  const other = await api('/v1/workspaces', bootstrap, { id: 'bravo', name: 'Bravo' }, 201);
  const editor = await issue(owner, 'editor_a', 'editor');
  const editor2 = await issue(owner, 'editor_b', 'editor');
  const approver = await issue(owner, 'approver_a', 'approver');
  const approver2 = await issue(owner, 'approver_b', 'approver');
  const worker = await issue(owner, 'worker_a', 'worker');
  const sameSubjectWorker = await issue(owner, 'worker_a', 'worker');
  const viewer = await issue(owner, 'reader', 'viewer');
  await api(wp('alpha'), undefined, undefined, 401);
  await api(wp('alpha'), 'unknown', undefined, 401);
  const bootstrapDenied = await fetch(baseUrl + wp('alpha'), { headers: { Authorization: `Bearer ${bootstrap}` } });
  ok([401,403].includes(bootstrapDenied.status), 'Bootstrap must not access workspace data');
  await bootstrapDenied.json();
  await api(wp('alpha'), other.ownerToken, undefined, 403);
  await api(`${wp('alpha')}/imports/absent`, viewer.token, undefined, 404);
  await api(`${wp('alpha')}/tokens`, editor.token, { subject: 'bad', role: 'worker' }, 403);
  await stage(viewer.token, { baseVersion: 0, csv: csv('upsert,a,A,a@example.test') }, 403);
  equal(await api(`${wp('alpha')}/members`, viewer.token), { version: 0, members: [] });
  await start(dataDir, false);
  equal(await api('/health'), { ok: true });
  group('startup, workspace replay, role and tenant isolation, exclusive writer');

  for (const text of [
    csv('upsert,a,A,a@example.test', '' , 'upsert,b,B,b@example.test'),
    csv('upsert,a,A,a@example.test', 'delete,a,,'),
    csv('upsert,a,"A,a@example.test'),
    csv('upsert,a,A,a@example.test,extra'),
    csv('delete,a,A,'), csv('noop,a,,'), csv('upsert,a,A,a@localhost'),
    csv('upsert,a,A,bad@@example.test'), csv('upsert,a,A,a @example.test'),
    csv('upsert,a,"Bad\u0001",a@example.test'), csv('upsert,constructor,A,a@example.test', 'upsert,constructor,A,a@example.test'),
    header, header + '\n\n', csv(...Array.from({ length: 501 }, (_, i) => `upsert,n${i},Name,n${i}@example.test`)),
  ]) await stage(editor.token, { baseVersion: 0, csv: text }, 400);
  for (const q of ['after=-1', 'after=1.2', 'limit=0', 'limit=101', 'after=1e2', 'after=9007199254740992', 'after=1&after=2']) {
    await api(`${wp('alpha')}/events?${q}`, viewer.token, undefined, 400);
  }
  await stage(editor.token, { baseVersion: -1, csv: csv('upsert,a,A,a@example.test') }, 400);
  await stage(editor.token, { baseVersion: 2, csv: csv('upsert,a,A,a@example.test') }, 409);
  await stage(editor.token, { baseVersion: 0, csv: csv('upsert,a,A,a@example.test') }, 400, 'bad key');
  await api(`${wp('alpha')}/imports`, editor.token, { baseVersion: 0, csv: csv('upsert,a,A,a@example.test') }, 415, 'wrong_mime', 'POST', { 'Content-Type': 'text/plain' });
  await stage(editor.token, { baseVersion: 0, csv: 'x'.repeat(65537) }, 400);
  await stage(editor.token, { baseVersion: 0, csv: 'x'.repeat(262144) }, 413);
  const invalid = await new Promise((resolveRaw, reject) => {
    const req = httpRequest(baseUrl + `${wp('alpha')}/imports`, { method: 'POST', headers: {
      Authorization: `Bearer ${editor.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'bad_utf8',
    } }, res => { res.resume(); res.on('end', () => resolveRaw(res.statusCode)); });
    req.on('error', reject); req.end(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]));
  }); equal(invalid, 400);
  group('CSV grammar, bounds, JSON media type, UTF-8, queries and request size');

  const exactCsv = '\uFEFFop,external_id,name,email\r\nupsert,constructor,"Ada, ""Synthetic""",ADA@EXAMPLE.TEST\r\nupsert,zeta,Zeta,zeta@example.test\r\n';
  const staged = await stage(editor.token, { baseVersion: 0, csv: exactCsv }, 201, 'stable');
  equal(staged.import.digest, createHash('sha256').update(exactCsv).digest('hex'));
  equal(staged.import.creator, 'editor_a'); equal(staged.import.approvedBy, null);
  equal(staged.import.rowCount, 2); equal(staged.import.leaseEpoch, 0);
  equal(Object.keys(staged.import).sort(), ['id','workspaceId','creator','baseVersion','state','rowCount','digest','leaseEpoch','approvedBy'].sort());
  const replay = await stage(editor.token, { csv: exactCsv, baseVersion: 0 }, 200, 'stable');
  equal(replay.import, staged.import);
  await stage(editor.token, { baseVersion: 0, csv: csv('delete,zeta,,') }, 409, 'stable');
  const independent = await stage(editor2.token, { baseVersion: 0, csv: exactCsv }, 201, 'stable');
  ok(independent.import.id !== staged.import.id);
  await api(`${wp('alpha')}/imports/${independent.import.id}/cancel`, editor.token, {}, 403);
  await api(`${wp('alpha')}/imports/${independent.import.id}/cancel`, editor2.token, {});
  await claim(worker.token, independent.import.id, 5000, 409);
  const ownerStaged = await stage(owner, { baseVersion: 0, csv: csv('delete,zeta,,') });
  await approve(owner, ownerStaged.import.id, 403);
  await api(`${wp('alpha')}/imports/${ownerStaged.import.id}/reject`, approver.token, { reason: ' Synthetic rejection ' });
  await approve(approver.token, ownerStaged.import.id, 409);
  await approve(approver.token, staged.import.id);
  await approve(approver.token, staged.import.id);
  await approve(approver2.token, staged.import.id, 409);
  const race = await Promise.all([1,2].map(async () => {
    const response = await fetch(`${baseUrl}${wp('alpha')}/imports/${staged.import.id}/claim`, {
      method: 'POST', headers: { Authorization: `Bearer ${worker.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ leaseMs: 5000 }),
    });
    return { status: response.status, body: await response.json() };
  }));
  equal(race.map(r => r.status).sort(), [200,409]);
  const lease = race.find(r => r.status === 200).body; equal(lease.import.leaseEpoch, 1);
  await commit(sameSubjectWorker.token, staged.import.id, lease.leaseToken, 'wrong_worker', 409);
  const committed = await commit(worker.token, staged.import.id, lease.leaseToken, 'durable_commit');
  equal(committed.version, 1); equal(committed.applied, 2); equal(committed.import.state, 'committed');
  equal(await commit(worker.token, staged.import.id, lease.leaseToken, 'durable_commit'), committed);
  await commit(worker.token, staged.import.id, 'wrong', 'durable_commit', 409);
  await commit(sameSubjectWorker.token, staged.import.id, lease.leaseToken, 'durable_commit', 409);
  const members1 = await api(`${wp('alpha')}/members`, viewer.token);
  equal(members1, { version: 1, members: [
    { externalId: 'constructor', name: 'Ada, "Synthetic"', email: 'ada@example.test', revision: 1 },
    { externalId: 'zeta', name: 'Zeta', email: 'zeta@example.test', revision: 1 },
  ] });
  group('canonical staging replay, approval separation, terminal states, claim race and commit replay');

  const swapId = await prepared(editor.token, approver.token, 1, csv('upsert,constructor,Ada,zeta@example.test', 'upsert,zeta,Zeta,ada@example.test'));
  const staleId = await prepared(editor.token, approver.token, 1, csv('upsert,other,Other,other@example.test'));
  const swapLease = await claim(worker.token, swapId);
  await commit(worker.token, swapId, swapLease.leaseToken);
  const staleLease = await claim(worker.token, staleId);
  await commit(worker.token, staleId, staleLease.leaseToken, 'stale_commit', 409);
  const beforeFailure = await api(`${wp('alpha')}/members`, viewer.token);
  equal(beforeFailure.version, 2); equal(beforeFailure.members.map(m => m.revision), [2, 2]);
  const duplicateId = await prepared(editor.token, approver.token, 2, csv('upsert,newid,Duplicate,zeta@example.test'));
  const duplicateLease = await claim(worker.token, duplicateId);
  await commit(worker.token, duplicateId, duplicateLease.leaseToken, 'duplicate_email', 409);
  equal(await api(`${wp('alpha')}/members`, viewer.token), beforeFailure);
  const missingId = await prepared(editor.token, approver.token, 2, csv('upsert,temp,Temp,temp@example.test', 'delete,absent,,'));
  const missingLease = await claim(worker.token, missingId);
  await commit(worker.token, missingId, missingLease.leaseToken, 'missing_delete', 409);
  equal(await api(`${wp('alpha')}/members`, viewer.token), beforeFailure);
  const finalId = await prepared(editor.token, approver.token, 2, csv('delete,zeta,,', 'upsert,constructor,Final,final@example.test'));
  const finalLease = await claim(worker.token, finalId);
  const result3 = await commit(worker.token, finalId, finalLease.leaseToken, 'final_commit'); equal(result3.version, 3);
  group('atomic email swap, duplicate final emails, missing delete and stale base version');

  const fencedId = await prepared(editor.token, approver.token, 3, csv('upsert,fenced,Fenced,fenced@example.test'));
  await claim(worker.token, fencedId, 99, 400); await claim(worker.token, fencedId, 5001, 400);
  const expired = await claim(worker.token, fencedId, 100);
  await new Promise(resolveDelay => setTimeout(resolveDelay, 160));
  await commit(worker.token, fencedId, expired.leaseToken, 'expired', 409);
  const fresh = await claim(worker.token, fencedId); equal(fresh.import.leaseEpoch, 2);
  await commit(worker.token, fencedId, expired.leaseToken, 'old_epoch', 409);
  await api(`${wp('alpha')}/tokens/${worker.id}/revoke`, owner, {});
  await api(`${wp('alpha')}/tokens/${worker.id}/revoke`, owner, {});
  await commit(worker.token, fencedId, fresh.leaseToken, 'revoked', 401);
  await commit(sameSubjectWorker.token, fencedId, fresh.leaseToken, 'other_capability', 409);
  await api(`${wp('alpha')}/imports/${fencedId}/cancel`, editor.token, {});
  await commit(sameSubjectWorker.token, fencedId, fresh.leaseToken, 'cancelled', 409);
  await stage(viewer.token, { baseVersion: 0, csv: exactCsv }, 403, 'stable');
  const beforeRevoke = await api(`${wp('alpha')}/events?limit=100`, owner);
  await api(`${wp('alpha')}/tokens/${editor.id}/revoke`, owner, {});
  await stage(editor.token, { baseVersion: 0, csv: exactCsv }, 401, 'stable');
  const eventsNow = await api(`${wp('alpha')}/events?limit=100`, owner);
  equal(eventsNow.events.length, beforeRevoke.events.length + 1);
  equal(eventsNow.events.map(e => e.cursor), eventsNow.events.map((_, i) => i + 1));
  equal(eventsNow.events.filter(e => e.type === 'import.committed').length, 3);
  equal(eventsNow.events.filter(e => e.type === 'capability.revoked').length, 2);
  ok(eventsNow.events.every(e => Object.keys(e).sort().join(',') === 'cursor,importId,subject,type'));
  const page = await api(`${wp('alpha')}/events?after=2&limit=3`, viewer.token);
  equal(page.events.map(e => e.cursor), [3,4,5]); equal(page.nextCursor, 5);
  equal(await api(`${wp('alpha')}/events?after=9999`, owner), { events: [], nextCursor: 9999 });
  group('expiry, epoch fencing, capability revocation, cancellation and contiguous audit pagination');

  const sdk = createClient({ baseUrl, token: viewer.token });
  equal(await sdk.workspace('alpha'), await api(wp('alpha'), viewer.token));
  equal(await sdk.members('alpha'), await api(`${wp('alpha')}/members`, viewer.token));
  equal(await sdk.events('alpha', { after: 2, limit: 3 }), page);
  try { await sdk.workspace('bravo'); assert.fail('SDK must reject tenant mismatch'); }
  catch (error) { ok(error instanceof RelayError); equal(error.status, 403); ok(typeof error.code === 'string'); }
  equal((await cli(['status', 'alpha'], viewer.token)).workspace.version, 3);
  equal((await cli(['members', 'alpha'], viewer.token)).version, 3);
  equal((await cli(['events', 'alpha', '--after', '2', '--limit', '3'], viewer.token)).nextCursor, 5);
  await cli(['events', 'alpha', '--limit', '-1'], viewer.token, 1);
  await cli(['commit', 'alpha', 'none', '--lease-token', 'SYNTHETIC_SECRET_FLAG', '--key', 'bad key'], viewer.token, 1);
  equal(await api('/health'), { ok: true });
  const cliFile = join(runDir, 'synthetic.csv'); await writeFile(cliFile, csv('upsert,clirow,CLI,cli@example.test'));
  const cliStage = await cli(['stage', 'alpha', '--file', cliFile, '--base-version', '3', '--key', 'cli_stage'], editor2.token);
  await cli(['approve', 'alpha', cliStage.import.id], approver.token);
  const cliClaim = await cli(['claim', 'alpha', cliStage.import.id, '--lease-ms', '5000'], sameSubjectWorker.token);
  const cliCommit = await cli(['commit', 'alpha', cliStage.import.id, '--lease-token', cliClaim.leaseToken, '--key', 'cli_commit'], sameSubjectWorker.token);
  equal(cliCommit.version, 4);
  const cancelledByCli = await sdkClientStage();
  await cli(['cancel', 'alpha', cancelledByCli.import.id], editor2.token);
  async function sdkClientStage() { return createClient({ baseUrl, token: editor2.token }).stage('alpha', { baseVersion: 4, csv: csv('delete,clirow,,') }, 'sdk_cancel'); }
  const sdkApprover = await issue(other.ownerToken, 'sdk_approver', 'approver', 'bravo');
  const sdkWorker = await issue(other.ownerToken, 'sdk_worker', 'worker', 'bravo');
  const typed = await exerciseSDK({ baseUrl, owner: other.ownerToken, approver: sdkApprover.token, worker: sdkWorker.token, workspace: 'bravo' });
  equal(typed.version, 1); equal(typed.member.email, 'sdk@example.test'); equal(typed.record.state, 'committed');
  group('connected CLI commands, SDK methods and typed RelayError');

  const races = await api('/v1/workspaces', bootstrap, { id: 'races', name: 'Concurrency synthetic' }, 201);
  const raceApprover = await issue(races.ownerToken, 'race_approver', 'approver', 'races');
  const raceWorker = await issue(races.ownerToken, 'race_worker', 'worker', 'races');
  const raceOwner = createClient({ baseUrl, token: races.ownerToken });
  const raceApproval = createClient({ baseUrl, token: raceApprover.token });
  const raceWorkerClient = createClient({ baseUrl, token: raceWorker.token });
  const sameStages = await Promise.all([1,2].map(() => raceOwner.stage('races', { baseVersion: 0, csv: csv('upsert,one,One,one@example.test') }, 'same_key')));
  equal(sameStages[0].import.id, sameStages[1].import.id);
  const differentStage = await raceOwner.stage('races', { baseVersion: 0, csv: csv('upsert,two,Two,two@example.test') }, 'different_key');
  const competing = [sameStages[0], differentStage];
  await Promise.all(competing.map(s => raceApproval.approve('races', s.import.id)));
  const claims = await Promise.all(competing.map(s => raceWorkerClient.claim('races', s.import.id, 5000)));
  const commits = await Promise.allSettled(claims.map((c, i) => raceWorkerClient.commit('races', c.import.id, c.leaseToken, `race_commit_${i}`)));
  equal(commits.filter(c => c.status === 'fulfilled').length, 1);
  const rejected = commits.find(c => c.status === 'rejected');
  ok(rejected.reason instanceof RelayError); equal(rejected.reason.status, 409);
  const raceMembers = await raceOwner.members('races'); equal(raceMembers.version, 1); equal(raceMembers.members.length, 1);
  const raceEvents = await raceOwner.events('races');
  equal(raceEvents.events.filter(e => e.type === 'import.staged').length, 2);
  equal(raceEvents.events.filter(e => e.type === 'import.committed').length, 1);
  group('simultaneous staging replay and competing commits serialize atomically');

  const snapshot = await api(`${wp('alpha')}/members`, viewer.token);
  const eventSnapshot = await api(`${wp('alpha')}/events?limit=100`, viewer.token);
  await service.stop();
  service = await start(); baseUrl = `http://127.0.0.1:${service.port}`;
  equal(await api(`${wp('alpha')}/members`, viewer.token), snapshot);
  equal(await api(`${wp('alpha')}/events?limit=100`, viewer.token), eventSnapshot);
  await api(wp('alpha'), editor.token, undefined, 401);
  equal(await cli(['commit', 'alpha', cliStage.import.id, '--lease-token', cliClaim.leaseToken, '--key', 'cli_commit'], sameSubjectWorker.token), cliCommit);
  const stageAgain = await stage(editor2.token, { csv: csv('upsert,clirow,CLI,cli@example.test'), baseVersion: 3 }, 200, 'cli_stage');
  equal(stageAgain.import.id, cliStage.import.id);
  service.child.kill('SIGKILL'); await service.exited;
  service = await start(); baseUrl = `http://127.0.0.1:${service.port}`;
  equal(await api(`${wp('alpha')}/members`, viewer.token), snapshot);
  equal(await api(`${wp('alpha')}/events?limit=100`, viewer.token), eventSnapshot);
  group('graceful restart, abrupt death, lock recovery and durable replay outcomes');

  const drainBody = Buffer.from(JSON.stringify({ baseVersion: 4, csv: csv('upsert,drained,Drained,drained@example.test') }));
  const drained = new Promise((resolveDrain, reject) => {
    const req = httpRequest(baseUrl + `${wp('alpha')}/imports`, { method: 'POST', headers: {
      Authorization: `Bearer ${editor2.token}`, 'Content-Type': 'application/json',
      'Idempotency-Key': 'drained_stage', 'Content-Length': drainBody.length,
    } }, res => {
      let text = ''; res.on('data', c => { text += c; });
      res.on('end', () => { try { equal(res.statusCode, 201); resolveDrain(JSON.parse(text)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(drainBody.subarray(0, 20));
    setTimeout(() => { service.child.stdin.write('shutdown\n'); setTimeout(() => req.end(drainBody.subarray(20)), 40); }, 100);
  });
  const drainedResult = await drained;
  equal((await service.exited).code, 0);
  service = await start(); baseUrl = `http://127.0.0.1:${service.port}`;
  equal((await api(`${wp('alpha')}/imports/${drainedResult.import.id}`, viewer.token)).import.state, 'staged');
  equal(await api(`${wp('alpha')}/members`, viewer.token), snapshot);
  group('stdin shutdown drains an accepted streamed write before releasing ownership');
  await service.stop(); service = undefined;

  const storageDoc = await readFile(join(source, 'STORAGE.md'), 'utf8');
  const journalName = /^Journal: ([a-zA-Z0-9_.-]+\.jsonl)\r?$/m.exec(storageDoc)?.[1];
  ok(journalName && !journalName.includes('..'), 'Safe journal filename documented');
  const rawJournal = await readFile(join(dataDir, journalName), 'utf8');
  for (const secret of [bootstrap, owner, editor.token, approver.token, worker.token, viewer.token, lease.leaseToken, cliClaim.leaseToken]) {
    ok(!rawJournal.includes(secret), 'Journal must not store plaintext capabilities or lease tokens');
  }
  const allFiles = await readdir(dataDir);
  for (const name of allFiles) {
    const content = await readFile(join(dataDir, name), 'utf8');
    ok(!content.includes(owner) && !content.includes(bootstrap) && !content.includes(lease.leaseToken), 'Runtime files must not contain secrets');
  }
  async function corrupt(name, change) {
    const dir = join(runDir, name); await mkdir(dir);
    for (const file of allFiles) await copyFile(join(dataDir, file), join(dir, file));
    await writeFile(join(dir, journalName), change(rawJournal));
    await start(dir, false);
  }
  await corrupt('partial', text => text + '{"partial":');
  await corrupt('changed', text => {
    const lines = text.trimEnd().split('\n'); const record = JSON.parse(lines[0]);
    record.syntheticTamper = true; lines[0] = JSON.stringify(record); return lines.join('\n') + '\n';
  });
  await corrupt('reordered', text => { const lines = text.trimEnd().split('\n'); [lines[0],lines[1]] = [lines[1],lines[0]]; return lines.join('\n') + '\n'; });
  await corrupt('gapped', text => { const lines = text.trimEnd().split('\n'); lines.splice(1,1); return lines.join('\n') + '\n'; });
  group('journal secret hygiene and fail-closed partial, changed, reordered and gapped recovery');
  console.log(JSON.stringify({ ok: true, groups, assertions, runtime: runtime.includes('bun') ? 'bun' : 'node', dataDirectory: runDir }));
} finally {
  for (const child of processes) { child.kill('SIGKILL'); }
}
