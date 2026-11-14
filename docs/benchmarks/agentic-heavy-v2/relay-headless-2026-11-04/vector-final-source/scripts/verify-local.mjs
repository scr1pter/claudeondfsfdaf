import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { verifyTypedSdk } from '../tests/sdk-usage.mts';

// This is a finite local client, not a server. It prints no capabilities.
const port = Number(process.env.PORT);
assert.ok(Number.isSafeInteger(port) && port > 0 && port <= 65535);
const baseUrl = `http://127.0.0.1:${port}`;
const bootstrap = process.env.RELAY_BOOTSTRAP_TOKEN;
assert.ok(bootstrap && isAbsolute(process.env.DATA_DIR || ''));
const id = `verify-${randomBytes(5).toString('hex')}`;

async function api(token, path, method = 'GET', body, key, status = 200) {
  const headers = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (key) headers['idempotency-key'] = key;
  const response = await fetch(baseUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.equal(response.status, status, 'API status');
  return response.json();
}

async function cli(token, args, success = true) {
  const child = spawn(process.execPath, ['cli.mjs', ...args], {
    env: { ...process.env, RELAY_URL: baseUrl, RELAY_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, success ? 0 : 1, 'CLI exit status');
  assert.equal(success ? err : out, '', 'CLI output stream');
  assert.ok(!err.includes(token) && !err.includes(baseUrl), 'No CLI secret echo');
  const text = success ? out : err;
  assert.equal(text.trim().split('\n').length, 1);
  return JSON.parse(text);
}

const health = await fetch(baseUrl + '/health').then(response => response.json());
assert.deepEqual(health, { ok: true });
const created = await api(bootstrap, '/v1/workspaces', 'POST', { id, name: 'Personal synthetic verification' }, undefined, 201);
const owner = created.ownerToken;
const base = `/v1/workspaces/${id}`;
const tokens = {};
for (const role of ['editor', 'approver', 'worker', 'viewer']) {
  tokens[role] = (await api(owner, base + '/tokens', 'POST', { subject: `local_${role}`, role })).token;
}
const directory = await mkdtemp(join(process.env.DATA_DIR, 'personal-client-'));
const csvPath = join(directory, 'synthetic.csv');
await writeFile(csvPath, 'op,external_id,name,email\nupsert,cli_member,CLI Synthetic,cli@example.test\n');
assert.equal((await cli(tokens.viewer, ['status', id])).workspace.version, 0);
assert.equal((await cli(tokens.viewer, ['members', id])).members.length, 0);
const stageArgs = ['stage', id, '--file', csvPath, '--base-version', '0', '--key', 'cli-stage'];
const staged = await cli(tokens.editor, stageArgs);
assert.equal((await cli(tokens.editor, stageArgs)).import.id, staged.import.id);
await cli(tokens.approver, ['approve', id, staged.import.id]);
const claimed = await cli(tokens.worker, ['claim', id, staged.import.id, '--lease-ms', '5000']);
const commitArgs = ['commit', id, staged.import.id, '--lease-token', claimed.leaseToken, '--key', 'cli-commit'];
assert.equal((await cli(tokens.worker, commitArgs)).version, 1);
assert.equal((await cli(tokens.worker, commitArgs)).version, 1);
await cli(tokens.viewer, ['stage', id, '--file', csvPath, '--base-version', '1', '--key', 'denied'], false);
await cli(tokens.editor, ['commit', id, staged.import.id, '--lease-token', 'synthetic-secret-flag', '--key'], false);
await writeFile(csvPath, 'op,external_id,name,email\nupsert,cancelled,Not Applied,not-applied@example.test');
const cancelled = await cli(tokens.editor, ['stage', id, '--file', csvPath, '--base-version', '1', '--key', 'cli-cancel']);
assert.equal((await cli(tokens.editor, ['cancel', id, cancelled.import.id])).import.state, 'cancelled');
assert.ok((await cli(tokens.viewer, ['events', id, '--after', '0', '--limit', '100'])).events.length > 0);
const sdk = await verifyTypedSdk({ baseUrl, workspaceId: id, editorToken: tokens.editor, approverToken: tokens.approver, workerToken: tokens.worker });
assert.equal(sdk.version, 2);
assert.equal((await api(tokens.viewer, base + '/members')).members.length, 2);
assert.deepEqual(await fetch(baseUrl + '/health').then(response => response.json()), { ok: true });
process.stdout.write(JSON.stringify({ ok: true, api: true, cli: true, typedSdkConsumer: true, version: sdk.version }) + '\n');
// In-memory handoff to the owned-process verification harness; never serialized.
export const verification = { workspaceId: id, viewerToken: tokens.viewer, version: sdk.version };
