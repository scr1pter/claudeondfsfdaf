import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { isAbsolute, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
assert.ok(isAbsolute(process.env.DATA_DIR || ''), 'DATA_DIR must be absolute');
const distance = relative(root, process.env.DATA_DIR);
assert.ok(distance.startsWith('..') || isAbsolute(distance), 'DATA_DIR must be external');
const dataDir = await mkdtemp(join(process.env.DATA_DIR, 'personal-service-'));
process.env.RELAY_BOOTSTRAP_TOKEN = randomBytes(32).toString('base64url');
const port = process.env.PORT;
assert.ok(/^[1-9][0-9]*$/.test(port || '') && Number(port) <= 65535, 'PORT must select the verification listener');
let active;

async function start() {
  const child = spawn(process.execPath, ['app.mjs', '--data', dataDir, '--port', port], {
    cwd: root, env: process.env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  active = { child, exit };
  const ready = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Service readiness timeout')), 12000);
    child.stdout.on('data', () => {
      if (!stdout.includes('\n')) return;
      clearTimeout(timeout);
      try { resolve(JSON.parse(stdout.split('\n')[0])); } catch { reject(new Error('Invalid first readiness line')); }
    });
    exit.then(() => { clearTimeout(timeout); reject(new Error('Service exited before readiness')); }, reject);
  });
  assert.equal(ready.ready, true); assert.equal(ready.port, Number(port));
  assert.ok(!stderr.includes(process.env.RELAY_BOOTSTRAP_TOKEN));
  process.stdout.write(JSON.stringify(ready) + '\n');
}

async function stop() {
  if (!active) return;
  const current = active;
  current.child.stdin.end('shutdown\n');
  const timeout = setTimeout(() => current.child.kill(), 12000);
  const code = await current.exit;
  clearTimeout(timeout);
  active = undefined;
  assert.equal(code, 0, 'Owned verification service must drain and exit zero');
}

try {
  await start();
  const { verification } = await import('./verify-local.mjs');
  await stop();
  await start();
  const response = await fetch(`http://127.0.0.1:${port}/v1/workspaces/${verification.workspaceId}/members`, {
    headers: { authorization: `Bearer ${verification.viewerToken}` },
  });
  assert.equal(response.status, 200);
  const members = await response.json();
  assert.equal(members.version, verification.version);
  assert.equal(members.members.length, 2);
  await stop();
  process.stdout.write(JSON.stringify({ ok: true, restart: true, stopped: true, runtime: process.versions.bun ? 'bun' : 'node' }) + '\n');
} finally {
  if (active) {
    // Only this harness's child can be stopped; never discover or stop another listener.
    active.child.kill();
    await active.exit.catch(() => {});
  }
}
