import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../', import.meta.url));
const root = resolve(process.env.DATA_DIR ?? '');
const rel = relative(source, root);
assert.ok(process.env.DATA_DIR && isAbsolute(process.env.DATA_DIR) && (rel === '..' || rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) || isAbsolute(rel)), 'DATA_DIR must be outside source');
await mkdir(root, { recursive: true });
const dir = await mkdtemp(join(root, 'relay-transport-'));
const runtime = process.env.RELAY_TEST_RUNTIME || process.execPath;
const opaqueBootstrap = process.env.RELAY_TRANSPORT_OPAQUE_BOOTSTRAP === '1';
const bootstrap = randomBytes(32).toString('hex') + (opaqueBootstrap ? ':synthetic!opaque@' : '');
const child = spawn(runtime, [join(source, 'app.mjs'), '--data', dir, '--port', '0'], { env: { ...process.env, RELAY_BOOTSTRAP_TOKEN: bootstrap } });
let stdout = '', stderr = '';
child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
const exited = once(child, 'exit');
let base;
let checks = 0;
const findings = [];
const secrets = [bootstrap];
const path = '/v1/workspaces/transport';
const csv = 'op,external_id,name,email\nupsert,person,\u03a9 Synthetic,person@example.test';

function check(value, label) { checks++; assert.ok(value, label); }
async function raw(label, { url = path, method = 'POST', token, auth, headers = {}, body = '{}', expected = 200, chunks, rawHeaders } = {}) {
  const response = await new Promise((resolveRequest, reject) => {
    const headerValues = rawHeaders ? ['Host', new URL(base).host, ...rawHeaders] : { ...(auth !== undefined ? { Authorization: auth } : token ? { Authorization: `Bearer ${token}` } : {}), ...headers };
    const req = request(base + url, { method, headers: headerValues, agent: false }, res => {
      let bytes = ''; res.on('data', chunk => { bytes += chunk; });
      res.on('end', () => resolveRequest({ status: res.statusCode, text: bytes, contentType: res.headers['content-type'] }));
      res.on('error', reject);
    });
    req.on('error', reject); req.setTimeout(6000, () => req.destroy(new Error('Transport deadline')));
    if (chunks) { for (const chunk of chunks) req.write(chunk); req.end(); }
    else req.end(method === 'GET' ? undefined : body);
  });
  checks++;
  if (response.status !== expected) findings.push({ label, actual: response.status, expected });
  let json;
  try { json = JSON.parse(response.text); } catch { findings.push({ label, failure: 'non-JSON response' }); return {}; }
  check(response.contentType?.startsWith('application/json'), label + ' JSON media type');
  if (response.status >= 400) {
    check(typeof json.error?.code === 'string' && typeof json.error?.message === 'string', label + ' error envelope');
    check(secrets.every(secret => !response.text.includes(secret)), label + ' secret-free error');
  }
  return json;
}

try {
  const info = await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('Readiness deadline')), 8000);
    child.stdout.on('data', () => {
      if (!stdout.includes('\n')) return;
      clearTimeout(timer); resolveReady(JSON.parse(stdout.split('\n')[0]));
    });
    exited.then(() => { clearTimeout(timer); reject(new Error('Startup exited')); });
  });
  check(info.ready === true && info.port > 0, 'readiness'); base = `http://127.0.0.1:${info.port}`;
  const created = await raw('workspace', { url: '/v1/workspaces', token: bootstrap, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'transport', name: 'Synthetic transport' }), expected: 201 });
  const owner = created.ownerToken; check(typeof owner === 'string', 'owner token returned'); secrets.push(owner);
  const other = await raw('second tenant', { url: '/v1/workspaces', token: bootstrap, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'second', name: 'Second synthetic' }), expected: 201 });
  secrets.push(other.ownerToken);
  const viewer = await raw('viewer', { url: path + '/tokens', token: owner, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subject: 'read', role: 'viewer' }) }); secrets.push(viewer.token);
  const revoked = await raw('revocable editor', { url: path + '/tokens', token: owner, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subject: 'revoked', role: 'editor' }) }); secrets.push(revoked.token);
  await raw('revoke', { url: path + '/tokens/' + revoked.id + '/revoke', token: owner, headers: { 'Content-Type': 'application/json' } });
  const before = await raw('audit before errors', { url: path + '/events?limit=100', method: 'GET', token: owner });
  for (const [label, auth] of [['missing', undefined], ['basic', 'Basic abc'], ['empty', 'Bearer'], ['unknown', 'Bearer invalid'], ['revoked', `Bearer ${revoked.token}`], ['capability id', `Bearer ${viewer.id}`], ['extra credential', `Bearer ${owner} extra`]]) {
    await raw('auth ' + label, { method: 'GET', auth, expected: 401 });
    await raw('auth before malformed body ' + label, { url: path + '/imports', auth, body: '{', headers: { 'Content-Type': 'application/json' }, expected: 401 });
    await raw('auth before duplicate query ' + label, { url: path + '/events?after=0&after=1', method: 'GET', auth, expected: 401 });
    await raw('auth before unknown query ' + label, { url: path + '?unknown=1', method: 'GET', auth, expected: 401 });
  }
  await raw('tenant', { method: 'GET', token: other.ownerToken, expected: 403 });
  await raw('tenant before body', { url: path + '/imports', token: other.ownerToken, body: '{', headers: { 'Content-Type': 'application/json' }, expected: 403 });
  await raw('viewer role', { url: path + '/imports', token: viewer.token, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseVersion: 0, csv }), expected: 403 });
  await raw('viewer role before malformed body', { url: path + '/imports', token: viewer.token, headers: { 'Content-Type': 'application/json' }, body: '{', expected: 403 });
  await raw('viewer role before media type', { url: path + '/imports', token: viewer.token, headers: { 'Content-Type': 'text/plain' }, body: '{}', expected: 403 });
  await raw('viewer role before invalid UTF8', { url: path + '/imports', token: viewer.token, headers: { 'Content-Type': 'application/json' }, body: Buffer.from([0xff]), expected: 403 });
  await raw('case-insensitive bearer scheme', { method: 'GET', auth: `bearer ${owner}` });
  await raw('mixed-case bearer scheme', { method: 'GET', auth: `bEaReR ${owner}` });
  await raw('bearer scheme space separator', { method: 'GET', auth: `Bearer   ${owner}` });
  for (const [label, type] of [['missing', undefined], ['plain', 'text/plain'], ['html', 'text/html'], ['lookalike', 'application/jsonp']]) {
    await raw('non-json ' + label, { url: path + '/imports', token: owner, headers: { ...(type ? { 'Content-Type': type } : {}), 'Idempotency-Key': 'mime_' + label }, body: JSON.stringify({ baseVersion: 0, csv }), expected: 415 });
  }
  for (const [label, bytes] of [
    ['empty', Buffer.alloc(0)], ['json', Buffer.from('{')], ['null', Buffer.from('null')], ['array', Buffer.from('[]')],
    ['bad utf8', Buffer.from([0x22,0xff,0x22])], ['utf8 truncated', Buffer.from([0x22,0xe2,0x82])],
    ['utf8 surrogate', Buffer.from([0x22,0xed,0xa0,0x80,0x22])], ['utf16', Buffer.from('{"csv":"x"}', 'utf16le')],
  ]) await raw(label, { url: path + '/imports', token: owner, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'invalid' }, body: bytes, expected: 400 });
  const after = await raw('audit after rejected errors', { url: path + '/events?limit=100', method: 'GET', token: owner });
  check(JSON.stringify(after) === JSON.stringify(before), 'Rejected requests append no events');
  const json = Buffer.from(JSON.stringify({ baseVersion: 0, csv }));
  const bounded = Buffer.concat([json, Buffer.alloc(262144 - json.length, 0x20)]);
  const exact = await raw('exact 262144 UTF8 bytes', { url: path + '/imports', token: owner, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Idempotency-Key': 'exact_limit', 'Content-Length': bounded.length }, body: bounded, expected: 201 });
  await raw('262145 UTF8 bytes', { url: path + '/imports', token: owner, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'over_limit' }, body: Buffer.concat([bounded, Buffer.from(' ')]), expected: 413 });
  await raw('chunked 262145 bytes', { url: path + '/imports', token: owner, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'chunked_limit' }, chunks: [bounded.subarray(0, 100000), bounded.subarray(100000), Buffer.from(' ')], expected: 413 });
  const split = json.indexOf(Buffer.from('\u03a9')) + 1;
  await raw('split multibyte UTF8', { url: path + '/imports', token: owner, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'split_utf8' }, chunks: [json.subarray(0, split), json.subarray(split)], expected: 201 });
  for (const [label, first, second] of [['valid first', owner, 'unknown'], ['valid last', 'unknown', owner], ['same credential', owner, owner]]) {
    await raw('duplicate auth ' + label, { method: 'GET', rawHeaders: ['Authorization', `Bearer ${first}`, 'authorization', `Bearer ${second}`], expected: 401 });
  }
  await raw('health after errors', { url: '/health', method: 'GET' });
  check(typeof exact.import?.id === 'string', 'boundary successful staging');
  child.stdin.write('shutdown\n');
  const [code] = await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('Shutdown deadline')), 8000).unref())]);
  check(code === 0, 'shutdown zero'); check(secrets.every(secret => !stdout.includes(secret) && !stderr.includes(secret)), 'No secret logs');
  console.log(JSON.stringify({ ok: findings.length === 0, checks, findings, runtime: runtime.includes('bun') ? 'bun' : 'node', opaqueBootstrap, directory: dir }));
  if (findings.length) process.exitCode = 1;
} finally { if (child.exitCode === null) { child.kill('SIGKILL'); await exited; } }
