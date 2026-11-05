// Run with Node or Bun, on local synthetic DATA_DIR only. No production fault
// switch exists: instrumentation temporarily replaces in-memory builtin methods.
import assert from 'node:assert/strict';
import filesystem from 'node:fs/promises';
import { constants } from 'node:fs';
import { createServer, request } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, canonicalJson, hashToken, secretToken } from './data.mjs';
import { openService } from './service.mjs';

const DELAYS = [25, 50, 100, 200, 400, 800];
const windows = process.platform === 'win32';
const original = {
  rename: filesystem.rename, open: filesystem.open, timer: globalThis.setTimeout,
};
const servers = new Set();
const secrets = new Set();
const checks = [];
let phase = 'setup';
let root;
let handlePrototype;
let originalSync;
let actualObservation;
const journalPath = directory => path.join(directory, 'transactions.jsonl');
const lockPath = directory => path.join(directory, '.relay-lock');
const tipPath = directory => path.join(lockPath(directory), 'tip.json');
const readTip = async directory => JSON.parse(await filesystem.readFile(tipPath(directory), 'utf8'));
const identity = stat => `${stat.dev}:${stat.ino}`;
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => { timer = original.timer(() => reject(new Error('Verification deadline exceeded.')), 10000); }),
    ]);
  } finally { clearTimeout(timer); }
}

function tipRename(source, destination) {
  return path.basename(destination) === 'tip.json' && path.basename(source).startsWith('.tip-')
    && path.dirname(source) === path.dirname(destination)
    && path.basename(path.dirname(destination)) === '.relay-lock';
}

function resetInstrumentation() {
  filesystem.rename = original.rename;
  filesystem.open = original.open;
  globalThis.setTimeout = original.timer;
  if (handlePrototype) handlePrototype.sync = originalSync;
}

function workspace() {
  return {
    id: 'synthetic', name: 'Synthetic', version: 0,
    creation: { requestHash: hashToken('synthetic creation'), ownerCapabilityId: 'owner-id', nonce: secretToken() },
    capabilities: [{ id: 'owner-id', subject: 'owner', role: 'owner', tokenHash: hashToken('synthetic-owner'), revoked: false }],
    members: [], imports: [], stagingReplays: [],
    events: [{ cursor: 1, type: 'workspace.created', subject: 'bootstrap', importId: null }],
  };
}

function mutate(draft) {
  const current = draft.workspaces[0];
  current.version++;
  current.events.push({ cursor: current.events.length + 1, type: 'import.committed', subject: 'synthetic', importId: null });
  return { version: current.version };
}

function instrument(context, fault) {
  const synced = new Map();
  handlePrototype.sync = async function () {
    const stat = await this.stat();
    await originalSync.call(this);
    synced.set(identity(stat), (synced.get(identity(stat)) || 0) + 1);
  };
  globalThis.setTimeout = function (callback, milliseconds, ...args) {
    context.delays.push(milliseconds);
    return original.timer(callback, milliseconds, ...args);
  };
  filesystem.rename = async function (source, destination) {
    if (!tipRename(source, destination)) return original.rename(source, destination);
    const stat = await filesystem.lstat(source);
    assert(stat.isFile() && !stat.isSymbolicLink(), 'Rename source must be a regular candidate.');
    assert.equal(synced.get(identity(stat)), 1, 'Retried candidate must have been fsynced exactly once.');
    const contents = await filesystem.readFile(source);
    if (context.sources.length) {
      assert.equal(source, context.sources[0], 'Retries must retain one candidate path.');
      assert.equal(identity(stat), context.candidateIdentity, 'Retries must retain the synced inode.');
      assert(contents.equals(context.candidateBytes), 'Retries must retain the synced contents.');
    } else {
      context.candidateIdentity = identity(stat);
      context.candidateBytes = contents;
    }
    context.sources.push(source);
    assert.equal(context.store.snapshot().workspaces[0].version, 0, 'State must not publish during rename attempts.');
    return fault(source, destination, context.sources.length);
  };
}

async function fixture(name, run) {
  phase = name;
  const directory = await filesystem.mkdtemp(path.join(root, `${name}-`));
  const store = await openStore(directory);
  const context = { directory, store, sources: [], delays: [], cleanup: async () => {} };
  try {
    await store.transact(draft => { draft.workspaces.push(workspace()); return null; });
    context.prior = await readTip(directory);
    context.priorBytes = await filesystem.readFile(tipPath(directory));
    await run(context);
  } finally {
    resetInstrumentation();
    try { await context.cleanup(); } finally { await store.close(); }
  }
  checks.push(name);
  return context;
}

async function poisoned(context) {
  let queuedRan = false;
  const outcomes = await Promise.allSettled([
    context.store.transact(mutate),
    context.store.transact(() => { queuedRan = true; return null; }),
  ]);
  assert.equal(outcomes[0].status, 'rejected', 'Failed persistence must not return success.');
  assert.equal(outcomes[0].reason.code, 'STORAGE_IO');
  assert.equal(outcomes[0].reason.message, 'A storage operation failed; its durable outcome may be uncertain.');
  assert.equal(outcomes[1].status, 'rejected');
  assert.equal(outcomes[1].reason.code, 'STORAGE_POISONED');
  assert.equal(queuedRan, false);
  assert.throws(() => context.store.snapshot(), error => error.code === 'STORAGE_POISONED');
  await assert.rejects(context.store.transact(() => null), error => error.code === 'STORAGE_POISONED');
}

async function recoverUnacknowledged(context) {
  const bytes = await filesystem.readFile(journalPath(context.directory));
  const store = await openStore(context.directory);
  try {
    assert.equal(store.snapshot().workspaces[0].version, 1);
    assert.equal((await readTip(context.directory)).seq, context.prior.seq + 1);
    assert((await filesystem.readFile(journalPath(context.directory))).equals(bytes), 'Recovery must not rewrite the journal.');
  } finally { await store.close(); }
}

function fault(code) { return Object.assign(new Error('Synthetic filesystem failure.'), { code }); }

async function deterministicChecks() {
  for (const codes of [['EPERM', 'EBUSY', 'EACCES'], ['EPERM']]) {
    const context = await fixture(`transient-${codes.length}`, async current => {
      instrument(current, async (source, destination, attempt) => {
        assert((await filesystem.readFile(tipPath(current.directory))).equals(current.priorBytes));
        if (attempt <= codes.length) throw fault(codes[attempt - 1]);
        return original.rename(source, destination);
      });
      if (windows) {
        assert.equal((await current.store.transact(mutate)).version, 1);
        assert.equal(current.sources.length, codes.length + 1);
        assert.deepEqual(current.delays, DELAYS.slice(0, codes.length));
        assert.equal((await readTip(current.directory)).seq, current.prior.seq + 1);
      } else {
        await poisoned(current);
        assert.equal(current.sources.length, 1);
        assert.deepEqual(current.delays, []);
      }
    });
    await recoverUnacknowledged(context);
  }
  for (const code of ['EPERM', 'EBUSY', 'EACCES', 'EIO', 'ENOENT']) {
    const context = await fixture(`persistent-${code}`, async current => {
      instrument(current, async () => { throw fault(code); });
      const start = performance.now();
      await poisoned(current);
      const retryable = windows && code !== 'EIO' && code !== 'ENOENT';
      assert.equal(current.sources.length, retryable ? 7 : 1);
      assert.deepEqual(current.delays, retryable ? DELAYS : []);
      if (retryable) assert(performance.now() - start >= 1500, 'Exponential delays must actually be awaited.');
      assert((await filesystem.readFile(tipPath(current.directory))).equals(current.priorBytes));
    });
    await recoverUnacknowledged(context);
  }

  for (const guard of ['stale-tip', 'tip-junction', 'directory-junction', 'candidate-inode', 'candidate-junction']) {
    await fixture(guard, async current => {
      const directory = lockPath(current.directory);
      const sentinel = path.join(current.directory, 'unrelated');
      await filesystem.mkdir(sentinel);
      await filesystem.writeFile(path.join(sentinel, 'keep.txt'), 'preserve', { flag: 'wx' });
      let changed = false;
      const saved = path.join(current.directory, 'saved-lock-directory');
      let candidate;
      current.cleanup = async () => {
        if (!changed) return;
        if (guard === 'directory-junction') {
          assert((await filesystem.lstat(directory)).isSymbolicLink());
          await filesystem.unlink(directory);
          await original.rename(saved, directory);
        } else if (guard === 'tip-junction') {
          assert((await filesystem.lstat(tipPath(current.directory))).isSymbolicLink());
          await filesystem.unlink(tipPath(current.directory));
          await original.rename(path.join(current.directory, 'saved-tip.json'), tipPath(current.directory));
        } else if (guard === 'stale-tip') {
          await filesystem.writeFile(tipPath(current.directory), current.priorBytes);
        } else {
          const stat = await filesystem.lstat(candidate);
          if (guard === 'candidate-inode') {
            assert(stat.isFile());
            assert.equal(await filesystem.readFile(candidate, 'utf8'), 'unrelated replacement');
          } else assert(stat.isSymbolicLink());
        }
        assert.equal(await filesystem.readFile(path.join(sentinel, 'keep.txt'), 'utf8'), 'preserve');
      };
      instrument(current, async (source, destination) => {
        candidate = source;
        if (guard === 'stale-tip') {
          await filesystem.writeFile(destination, `${canonicalJson({ ...current.prior, hash: '0'.repeat(64) })}\n`);
        } else if (guard === 'tip-junction') {
          await original.rename(destination, path.join(current.directory, 'saved-tip.json'));
          await filesystem.symlink(sentinel, destination, windows ? 'junction' : 'dir');
        } else if (guard === 'directory-junction') {
          await original.rename(directory, saved);
          await filesystem.symlink(sentinel, directory, windows ? 'junction' : 'dir');
        } else {
          await original.rename(source, path.join(current.directory, 'saved-candidate.json'));
          if (guard === 'candidate-inode') await filesystem.writeFile(source, 'unrelated replacement', { flag: 'wx' });
          else await filesystem.symlink(sentinel, source, windows ? 'junction' : 'dir');
        }
        changed = true;
        throw fault('EPERM');
      });
      await poisoned(current);
      assert.equal(current.sources.length, 1, 'Changed paths must abort before a second rename.');
      assert.deepEqual(current.delays, windows ? [25] : []);
    });
  }

  const uncertain = await fixture('rename-succeeded-reported-error', async current => {
    instrument(current, async (source, destination) => {
      await original.rename(source, destination);
      throw fault('EPERM');
    });
    await poisoned(current);
    assert.equal(current.sources.length, 1, 'An uncertain rename must not be reclassified as success.');
    assert.equal((await readTip(current.directory)).seq, current.prior.seq + 1);
    assert.deepEqual(current.delays, windows ? [25] : []);
  });
  await recoverUnacknowledged(uncertain);

  for (const fatalSync of [false, true]) {
    const context = await fixture(fatalSync ? 'directory-sync-fatal' : 'publication-order', async current => {
      const entered = deferred();
      const release = deferred();
      let renamed = false;
      instrument(current, async (source, destination, attempt) => {
        if (windows && attempt === 1 && !fatalSync) throw fault('EBUSY');
        await original.rename(source, destination);
        renamed = true;
      });
      filesystem.open = async function (filename, flags, ...args) {
        if (filename !== lockPath(current.directory) || flags !== constants.O_RDONLY) return original.open(filename, flags, ...args);
        assert(renamed, 'Directory synchronization must follow rename.');
        return {
          async sync() {
            entered.resolve();
            if (fatalSync) throw fault('EIO');
            await release.promise;
          },
          async close() {},
        };
      };
      if (fatalSync) {
        await poisoned(current);
        assert.equal(current.sources.length, 1, 'Directory fsync errors must never retry rename.');
        assert.deepEqual(current.delays, []);
      } else {
        let resolved = false;
        const pending = current.store.transact(mutate).then(result => { resolved = true; return result; });
        try {
          await bounded(Promise.race([
            entered.promise,
            pending.then(() => { throw new Error('Publication completed without the expected synchronization gate.'); }),
          ]));
          assert.equal(resolved, false);
          assert.equal(current.store.snapshot().workspaces[0].version, 0);
          assert.equal((await readTip(current.directory)).seq, current.prior.seq + 1);
        } finally { release.resolve(); }
        assert.equal((await pending).version, 1);
        assert.equal(current.store.snapshot().workspaces[0].version, 1);
        assert.equal(current.sources.length, windows ? 2 : 1);
        assert.deepEqual(current.delays, windows ? [25] : []);
      }
    });
    await recoverUnacknowledged(context);
  }

  const regression = await fixture('journal-integrity-regression', async current => {
    await current.store.transact(mutate);
  });
  const full = await filesystem.readFile(journalPath(regression.directory));
  const records = full.toString('utf8').trimEnd().split('\n');
  for (const variant of ['suffix', 'partial', 'tamper', 'missing-tip']) {
    const directory = path.join(root, `corrupt-${variant}`);
    await filesystem.cp(regression.directory, directory, { recursive: true });
    if (variant === 'suffix') await filesystem.writeFile(journalPath(directory), `${records.slice(0, -1).join('\n')}\n`);
    if (variant === 'partial') await filesystem.appendFile(journalPath(directory), '{"partial":');
    if (variant === 'tamper') {
      const altered = [...records];
      const record = JSON.parse(altered.at(-1));
      record.state.workspaces[0].name = 'Altered';
      altered[altered.length - 1] = canonicalJson(record);
      await filesystem.writeFile(journalPath(directory), `${altered.join('\n')}\n`);
    }
    if (variant === 'missing-tip') await filesystem.unlink(tipPath(directory));
    const before = await filesystem.readFile(journalPath(directory));
    await assert.rejects(openStore(directory), error => error.code === 'STORAGE_CORRUPT');
    assert((await filesystem.readFile(journalPath(directory))).equals(before));
  }
  checks.push('suffix-partial-tamper-missing-tip-fail-closed');
}

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    function failed(error) { server.removeListener('listening', ready); reject(error); }
    function ready() { server.removeListener('error', failed); resolve(); }
    server.once('error', failed);
    server.once('listening', ready);
    server.listen(port, '127.0.0.1');
  });
}

async function closeServer(server) {
  if (server.listening) {
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeIdleConnections?.();
    });
  }
  servers.delete(server);
}

async function httpJson(port, method, route, token, body) {
  const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const headers = { authorization: `Bearer ${token}`, connection: 'close' };
    if (bytes) { headers['content-type'] = 'application/json'; headers['content-length'] = bytes.length; }
    const operation = request({ host: '127.0.0.1', port, method, path: route, headers, agent: false }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch { reject(new Error('The local response was not JSON.')); }
      });
    });
    operation.on('error', reject);
    operation.setTimeout(5000, () => operation.destroy(new Error('The local verification request timed out.')));
    operation.end(bytes || undefined);
  });
}

async function actualHttpChecks() {
  phase = 'real-first-workspace-posts';
  const bootstrap = secretToken();
  secrets.add(bootstrap);
  const observation = { creations: 0, tipRenameAttempts: 0, observedRenameErrors: {}, firstPort: null, portFallback: false };
  actualObservation = observation;
  // Passive observation only: no errors injected and all real timers/fsyncs used.
  filesystem.rename = async function (source, destination) {
    if (tipRename(source, destination)) observation.tipRenameAttempts++;
    try { return await original.rename(source, destination); }
    catch (error) {
      if (tipRename(source, destination)) observation.observedRenameErrors[error.code] = (observation.observedRenameErrors[error.code] || 0) + 1;
      throw error;
    }
  };
  try {
    for (let index = 0; index < 60; index++) {
      phase = `real-first-workspace-post-${index + 1}`;
      const directory = await filesystem.mkdtemp(path.join(root, 'real-http-'));
      let service = await openService({ dataDir: directory, bootstrapToken: bootstrap });
      const server = createServer((incoming, response) => {
        service.handle(incoming, response).catch(() => {
          if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { code: 'VERIFY_HANDLER_FAILED', message: 'The local handler failed.' } }));
        });
      });
      servers.add(server);
      try {
        let port = index === 0 ? Number(process.env.PORT || 0) : 0;
        assert(Number.isInteger(port) && port >= 0 && port <= 65535, 'PORT must be a valid local port.');
        try { await listen(server, port); }
        catch (error) {
          if (port === 0 || error.code !== 'EADDRINUSE') throw error;
          observation.portFallback = true;
          await listen(server, 0);
        }
        port = server.address().port;
        if (index === 0) observation.firstPort = port;
        const created = await httpJson(port, 'POST', '/v1/workspaces', bootstrap, { id: 'synthetic', name: 'Synthetic' });
        assert.equal(created.status, 201, 'Every fresh first creation must succeed; fixtures are never retried.');
        assert.equal(typeof created.body.ownerToken, 'string');
        assert.equal(created.body.workspace.id, 'synthetic');
        secrets.add(created.body.ownerToken);
        const replay = await httpJson(port, 'POST', '/v1/workspaces', bootstrap, { name: 'Synthetic', id: 'synthetic' });
        assert.equal(replay.status, 200);
        assert(replay.body.ownerToken === created.body.ownerToken, 'Creation replay must retain its original token.');
        const records = (await filesystem.readFile(journalPath(directory), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
        assert.equal(records.length, 2);
        const tip = await readTip(directory);
        assert.equal(tip.seq, 2);
        assert.equal(tip.hash, records[1].hash);
        await service.close();
        service = await openService({ dataDir: directory, bootstrapToken: bootstrap });
        const reopened = await httpJson(port, 'GET', '/v1/workspaces/synthetic', created.body.ownerToken);
        assert.equal(reopened.status, 200);
        assert.equal(reopened.body.workspace.version, 0);
        observation.creations++;
      } finally {
        try { await closeServer(server); } finally { await service.close(); }
      }
    }
  } finally { resetInstrumentation(); }
  assert.equal(observation.creations, 60);
  checks.push('60-real-fresh-http-creations-replays-and-restarts');
  return observation;
}

async function checkSecrets(directory) {
  for (const entry of await filesystem.readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await checkSecrets(filename);
    else if (entry.isFile()) {
      const bytes = await filesystem.readFile(filename);
      for (const secret of secrets) assert(!bytes.includes(Buffer.from(secret)), 'A bearer secret must not be persisted.');
    }
  }
}

try {
  assert(typeof process.env.DATA_DIR === 'string' && path.isAbsolute(process.env.DATA_DIR), 'An external absolute DATA_DIR is required.');
  const directory = await filesystem.realpath(process.env.DATA_DIR);
  const source = await filesystem.realpath(fileURLToPath(new URL('../', import.meta.url)));
  const relative = path.relative(source, directory);
  assert(relative && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)), 'DATA_DIR must be outside authored source.');
  root = await filesystem.mkdtemp(path.join(directory, 'tip-retry-verification-'));
  const probe = await filesystem.open(path.join(root, 'probe'), 'wx', 0o600);
  handlePrototype = Object.getPrototypeOf(probe);
  originalSync = handlePrototype.sync;
  await probe.close();
  await deterministicChecks();
  const actualHttp = await actualHttpChecks();
  phase = 'secret-scan';
  await checkSecrets(root);
  checks.push('no-bearer-secrets-in-runtime-files');
  assert.equal(servers.size, 0);
  process.stdout.write(`${JSON.stringify({ ok: true, runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.version}`, platform: process.platform, root, checks, actualHttp, liveServers: servers.size, liveChildren: 0 })}\n`);
} catch (error) {
  // Assertions may contain HTTP values: never print their raw details or stack.
  const code = typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'VERIFY_FAILED';
  process.stderr.write(`${JSON.stringify({ ok: false, phase, code, actualHttp: actualObservation, completedChecks: checks, message: 'Tip retry verification failed; secret-bearing details were suppressed.' })}\n`);
  process.exitCode = 1;
} finally {
  resetInstrumentation();
  for (const server of servers) await closeServer(server);
}
