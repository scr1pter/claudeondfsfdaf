import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

async function rejected(args, bootstrap = 'synthetic-startup-secret') {
  const child = spawn(process.execPath, ['app.mjs', ...args], {
    cwd: root, env: { ...process.env, RELAY_BOOTSTRAP_TOKEN: bootstrap }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill(), 10000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  clearTimeout(timer);
  assert.equal(code, 1);
  assert.equal(stdout, '', 'Rejected startup must not announce readiness');
  assert.equal(stderr.trim().split('\n').length, 1);
  const error = JSON.parse(stderr).error;
  assert.equal(typeof error.code, 'string'); assert.equal(typeof error.message, 'string');
  assert.ok(!stderr.includes('synthetic-startup-secret') && !stderr.includes('synthetic-secret-flag'));
}

test('startup arguments and missing bootstrap fail safely without creating source data', async () => {
  for (const args of [[], ['--data', 'relative'], ['--unknown', 'synthetic-secret-flag'],
    ['--data', process.env.DATA_DIR, '--port', '-1'],
    ['--data', process.env.DATA_DIR, '--port', '65536'],
    ['--data', process.env.DATA_DIR, '--port', '1e2'],
    ['--data', process.env.DATA_DIR, '--port', '0', '--port', '0'],
    ['--data', root, '--port', '0'],
    ['--data', root + 'never-create-runtime-data', '--port', '0'],
  ]) await rejected(args);
  await rejected(['--data', process.env.DATA_DIR, '--port', '0'], '');
});
