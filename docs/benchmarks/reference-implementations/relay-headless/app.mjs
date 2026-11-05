import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync, appendFileSync, existsSync, rmSync, lstatSync } from 'node:fs';
import { resolve, isAbsolute, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';

const hash = value => createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
class Fault extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const fail = (condition, status = 400, code = 'INVALID_INPUT') => { if (!condition) throw new Fault(status, code); };
const integer = value => Number.isSafeInteger(value) && value >= 0;
const opaque = () => randomBytes(32).toString('hex');
const exact = (body, keys) => fail(body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).sort().join(',') === [...keys].sort().join(','));
const sorted = values => values.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
function publicImport(item) {
  return Object.fromEntries(['id', 'workspaceId', 'creator', 'baseVersion', 'state', 'rowCount', 'digest', 'leaseEpoch', 'approvedBy'].map(key => [key, item[key]]));
}
function csvRows(csv) {
  fail(typeof csv === 'string');
  fail(Buffer.byteLength(csv, 'utf8') <= 65536, 413, 'CSV_TOO_LARGE');
  let source = csv.startsWith('\ufeff') ? csv.slice(1) : csv;
  const rows = [];
  let row = [], cell = '', quoted = false, closed = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') { quoted = false; closed = true; }
      else cell += ch;
      continue;
    }
    if (ch === '"') { fail(!cell && !closed); quoted = true; continue; }
    if (ch === ',') { row.push(cell); cell = ''; closed = false; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r') { fail(source[i + 1] === '\n'); i++; }
      row.push(cell); rows.push(row); row = []; cell = ''; closed = false; continue;
    }
    fail(!closed);
    cell += ch;
  }
  fail(!quoted);
  if (cell || row.length || closed) { row.push(cell); rows.push(row); }
  fail(rows.length >= 2 && rows.length <= 501 && rows[0].join(',') === 'op,external_id,name,email');
  const ids = new Set();
  return rows.slice(1).map(values => {
    fail(values.length === 4);
    const [op, externalId, rawName, rawEmail] = values;
    fail((op === 'upsert' || op === 'delete') && /^[a-zA-Z0-9_-]{1,32}$/.test(externalId) && !ids.has(externalId));
    ids.add(externalId);
    const name = rawName.trim(), email = rawEmail.trim().toLowerCase();
    if (op === 'delete') fail(rawName === '' && rawEmail === '');
    else fail(name.length >= 1 && name.length <= 80 && !/[\x00-\x1f\x7f]/.test(name)
      && !/\s/.test(rawEmail) && email.length <= 120 && /^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/.test(email));
    return {op, externalId, name, email};
  });
}

let server, owner, lock, state, seq = 0, previous = '0'.repeat(64), queue = Promise.resolve();
let shuttingDown = false;
function durable(path, value, mode = 'wx') {
  const fd = openSync(path, mode);
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
}
function release() {
  if (!lock || !owner) return;
  try {
    if (JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')).nonce === owner.nonce) rmSync(lock, {recursive: true});
  } catch {}
}
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (server) await new Promise(done => server.close(done));
  await queue.catch(() => {});
  release();
  process.exit(0);
}
function authorize(next, token, workspaceId, roles) {
  const cap = next.capabilities[hash(token || '')];
  fail(cap && !cap.revoked, 401, 'UNAUTHORIZED');
  fail(cap.workspaceId === workspaceId, 403, 'WORKSPACE_FORBIDDEN');
  fail(Object.hasOwn(next.workspaces, workspaceId), 404, 'WORKSPACE_NOT_FOUND');
  if (roles) fail(roles.includes(cap.role), 403, 'ROLE_FORBIDDEN');
  return cap;
}
function event(workspace, type, subject, importId = null) {
  workspace.events.push({cursor: workspace.events.length + 1, type, subject, importId});
}
function capability(next, workspaceId, subject, role) {
  const token = opaque(), id = opaque();
  next.capabilities[hash(token)] = {id, workspaceId, subject, role, revoked: false};
  return {id, subject, role, token};
}
function transaction(action) {
  const running = queue.then(() => {
    const next = structuredClone(state);
    const result = action(next);
    if (result.changed === false) return result;
    const record = {seq: seq + 1, previous, state: next};
    const checksum = hash(canonical(record));
    const fd = openSync(journalPath, 'a');
    try { appendFileSync(fd, canonical({...record, hash: checksum}) + '\n'); fsyncSync(fd); }
    catch (error) { shuttingDown = true; setImmediate(() => { release(); process.exit(3); }); throw error; }
    finally { closeSync(fd); }
    state = next; seq++; previous = checksum;
    return result;
  });
  queue = running.then(() => {}, () => {});
  return running;
}
function json(response, status, body) {
  response.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
  response.end(JSON.stringify(body));
}
async function readBody(request) {
  fail(/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || ''), 415, 'JSON_REQUIRED');
  return await new Promise((resolveBody, rejectBody) => {
    const parts = [];
    let bytes = 0;
    request.on('data', chunk => { bytes += chunk.length; if (bytes <= 262144) parts.push(chunk); });
    request.on('error', () => rejectBody(new Fault(400, 'INVALID_BODY')));
    request.on('end', () => {
      if (bytes > 262144) return rejectBody(new Fault(413, 'BODY_TOO_LARGE'));
      try { resolveBody(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(parts)))); }
      catch { rejectBody(new Fault(400, 'INVALID_JSON')); }
    });
  });
}
function importFor(workspace, id) { fail(Object.hasOwn(workspace.imports, id), 404, 'IMPORT_NOT_FOUND'); return workspace.imports[id]; }
function keyFor(request) { const value = request.headers['idempotency-key']; fail(typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value), 400, 'INVALID_KEY'); return value; }
let journalPath;
async function handle(request, response) {
  try {
    fail(!shuttingDown, 503, 'SHUTTING_DOWN');
    const url = new URL(request.url, 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean);
    const token = /^Bearer ([^\s]+)$/.exec(request.headers.authorization || '')?.[1] || '';
    if (request.method === 'GET' && url.pathname === '/health') return json(response, 200, {ok: true});
    if (request.method === 'POST' && url.pathname === '/v1/workspaces') {
      fail(hash(token) === hash(process.env.RELAY_BOOTSTRAP_TOKEN || 'unconfigured'), 401, 'UNAUTHORIZED');
      const body = await readBody(request);
      exact(body, ['id', 'name']);
      fail(typeof body.id === 'string' && /^[a-z][a-z0-9-]{2,23}$/.test(body.id)
        && typeof body.name === 'string' && body.name.trim().length >= 1 && body.name.trim().length <= 80);
      const result = await transaction(next => {
        fail(!Object.hasOwn(next.workspaces, body.id), 409, 'WORKSPACE_EXISTS');
        const workspace = {id: body.id, name: body.name.trim(), version: 0, members: {}, imports: {}, events: []};
        next.workspaces[body.id] = workspace;
        const cap = capability(next, body.id, 'owner', 'owner');
        event(workspace, 'workspace.created', 'bootstrap');
        return {status: 201, body: {workspace: {id: workspace.id, name: workspace.name, version: 0}, ownerToken: cap.token}};
      });
      return json(response, result.status, result.body);
    }
    fail(parts[0] === 'v1' && parts[1] === 'workspaces' && parts[2], 404, 'NOT_FOUND');
    const workspaceId = parts[2], tail = parts.slice(3);
    if (request.method === 'GET') {
      authorize(state, token, workspaceId);
      const workspace = state.workspaces[workspaceId];
      if (tail.length === 0) return json(response, 200, {workspace: {id: workspace.id, name: workspace.name, version: workspace.version}});
      if (tail[0] === 'members' && tail.length === 1) return json(response, 200, {version: workspace.version, members: sorted(Object.keys(workspace.members)).map(id => workspace.members[id])});
      if (tail[0] === 'imports' && tail.length === 1) return json(response, 200, {imports: sorted(Object.keys(workspace.imports)).map(id => publicImport(workspace.imports[id]))});
      if (tail[0] === 'imports' && tail.length === 2) return json(response, 200, {import: publicImport(importFor(workspace, tail[1]))});
      if (tail[0] === 'events' && tail.length === 1) {
        const after = url.searchParams.get('after') ?? '0', limit = url.searchParams.get('limit') ?? '50';
        fail(/^\d+$/.test(after) && /^\d+$/.test(limit) && integer(Number(after)) && Number(limit) >= 1 && Number(limit) <= 100);
        const events = workspace.events.filter(item => item.cursor > Number(after)).slice(0, Number(limit));
        return json(response, 200, {events, nextCursor: events.at(-1)?.cursor ?? Number(after)});
      }
      throw new Fault(404, 'NOT_FOUND');
    }
    fail(request.method === 'POST', 405, 'METHOD_NOT_ALLOWED');
    const body = await readBody(request);
    const result = await transaction(next => {
      const cap = authorize(next, token, workspaceId), workspace = next.workspaces[workspaceId];
      const role = roles => fail(roles.includes(cap.role), 403, 'ROLE_FORBIDDEN');
      if (tail[0] === 'tokens') {
        role(['owner']);
        if (tail.length === 1) {
          exact(body, ['subject', 'role']);
          fail(typeof body.subject === 'string' && /^[a-zA-Z0-9_-]{1,32}$/.test(body.subject)
            && ['editor', 'approver', 'worker', 'viewer'].includes(body.role));
          const issued = capability(next, workspaceId, body.subject, body.role);
          event(workspace, 'capability.issued', cap.subject);
          return {status: 200, body: issued};
        }
        if (tail.length === 3 && tail[2] === 'revoke') {
          exact(body, []);
          const target = Object.values(next.capabilities).find(value => value.id === tail[1] && value.workspaceId === workspaceId);
          fail(target, 404, 'CAPABILITY_NOT_FOUND');
          if (target.revoked) return {status: 200, body: {revoked: true}, changed: false};
          target.revoked = true;
          event(workspace, 'capability.revoked', cap.subject);
          return {status: 200, body: {revoked: true}};
        }
      }
      if (tail[0] === 'imports' && tail.length === 1) {
        role(['owner', 'editor']); exact(body, ['baseVersion', 'csv']);
        const key = keyFor(request), namespace = canonical([workspaceId, cap.subject, key]), digest = hash(canonical(body));
        const old = next.stageKeys[namespace];
        if (old) { fail(old.digest === digest, 409, 'IDEMPOTENCY_CONFLICT'); return {status: 200, body: old.body, changed: false}; }
        fail(integer(body.baseVersion));
        fail(body.baseVersion === workspace.version, 409, 'STALE_VERSION');
        const rows = csvRows(body.csv), id = opaque();
        const item = {id, workspaceId, creator: cap.subject, baseVersion: body.baseVersion, state: 'staged',
          rowCount: rows.length, digest: hash(Buffer.from(body.csv, 'utf8')), leaseEpoch: 0, approvedBy: null, rows, lease: null};
        workspace.imports[id] = item;
        const output = {import: publicImport(item)};
        next.stageKeys[namespace] = {digest, body: output};
        event(workspace, 'import.staged', cap.subject, id);
        return {status: 201, body: output};
      }
      fail(tail[0] === 'imports' && tail.length === 3, 404, 'NOT_FOUND');
      const item = importFor(workspace, tail[1]), action = tail[2];
      if (action === 'approve') {
        role(['owner', 'approver']); exact(body, []);
        fail(cap.subject !== item.creator, 403, 'SEPARATION_OF_DUTY');
        if (item.state === 'approved' && item.approvedBy === cap.subject) return {status: 200, body: {import: publicImport(item)}, changed: false};
        fail(item.state === 'staged', 409, 'STATE_CONFLICT');
        item.state = 'approved'; item.approvedBy = cap.subject;
        event(workspace, 'import.approved', cap.subject, item.id);
        return {status: 200, body: {import: publicImport(item)}};
      }
      if (action === 'reject') {
        role(['owner', 'approver']); exact(body, ['reason']);
        fail(typeof body.reason === 'string' && body.reason.trim().length >= 1 && body.reason.trim().length <= 160);
        fail(item.state === 'staged', 409, 'STATE_CONFLICT'); item.state = 'rejected'; item.reason = body.reason.trim();
        event(workspace, 'import.rejected', cap.subject, item.id);
        return {status: 200, body: {import: publicImport(item)}};
      }
      if (action === 'cancel') {
        exact(body, []); fail(cap.role === 'owner' || (cap.role === 'editor' && cap.subject === item.creator), 403, 'ROLE_FORBIDDEN');
        fail(['staged', 'approved', 'leased'].includes(item.state), 409, 'STATE_CONFLICT');
        item.state = 'cancelled'; item.lease = null;
        event(workspace, 'import.cancelled', cap.subject, item.id);
        return {status: 200, body: {import: publicImport(item)}};
      }
      if (action === 'claim') {
        role(['worker']); exact(body, ['leaseMs']);
        fail(integer(body.leaseMs) && body.leaseMs >= 100 && body.leaseMs <= 5000);
        fail(item.state === 'approved' || (item.state === 'leased' && item.lease.expiresAt <= Date.now()), 409, 'LEASE_CONFLICT');
        const leaseToken = opaque(), expiresAt = Date.now() + body.leaseMs;
        item.leaseEpoch++; item.state = 'leased';
        item.lease = {hash: hash(leaseToken), expiresAt, subject: cap.subject, capabilityId: cap.id, epoch: item.leaseEpoch};
        event(workspace, 'import.claimed', cap.subject, item.id);
        return {status: 200, body: {import: publicImport(item), leaseToken, expiresAt}};
      }
      if (action === 'commit') {
        role(['worker']); exact(body, ['leaseToken']); fail(typeof body.leaseToken === 'string');
        const key = keyFor(request), namespace = canonical([workspaceId, cap.subject, key]), digest = hash(canonical(body));
        const old = next.commitKeys[namespace];
        if (old) {
          fail(old.digest === digest && old.capabilityId === cap.id && old.importId === item.id, 409, 'IDEMPOTENCY_CONFLICT');
          return {status: 200, body: old.body, changed: false};
        }
        const lease = item.lease;
        fail(item.state === 'leased' && lease && lease.hash === hash(body.leaseToken) && lease.capabilityId === cap.id
          && lease.subject === cap.subject && lease.epoch === item.leaseEpoch && lease.expiresAt > Date.now(), 409, 'LEASE_CONFLICT');
        fail(item.baseVersion === workspace.version, 409, 'STALE_VERSION');
        const members = structuredClone(workspace.members);
        for (const row of item.rows) {
          if (row.op === 'delete') { fail(Object.hasOwn(members, row.externalId), 409, 'MISSING_MEMBER'); delete members[row.externalId]; }
          else Object.defineProperty(members, row.externalId, {value: {externalId: row.externalId, name: row.name, email: row.email,
            revision: (Object.hasOwn(members, row.externalId) ? members[row.externalId].revision : 0) + 1}, enumerable: true, configurable: true, writable: true});
        }
        const emails = Object.values(members).map(member => member.email);
        fail(new Set(emails).size === emails.length, 409, 'DUPLICATE_EMAIL');
        workspace.members = members; workspace.version++; item.state = 'committed'; item.lease = null;
        const output = {import: publicImport(item), version: workspace.version, applied: item.rowCount};
        next.commitKeys[namespace] = {digest, capabilityId: cap.id, importId: item.id, body: output};
        event(workspace, 'import.committed', cap.subject, item.id);
        return {status: 200, body: output};
      }
      throw new Fault(404, 'NOT_FOUND');
    });
    json(response, result.status, result.body);
  } catch (error) {
    json(response, error instanceof Fault ? error.status : 500, {error: {code: error instanceof Fault ? error.code : 'INTERNAL_ERROR', message: error instanceof Fault ? error.code : 'Operation failed'}});
  }
}
try {
  const args = process.argv.slice(2), data = args[args.indexOf('--data') + 1], port = Number(args[args.indexOf('--port') + 1]);
  fail(args.includes('--data') && args.includes('--port') && isAbsolute(data) && integer(port) && port < 65536 && process.env.RELAY_BOOTSTRAP_TOKEN, 400, 'INVALID_STARTUP');
  mkdirSync(data, {recursive: true}); fail(!lstatSync(data).isSymbolicLink());
  lock = join(resolve(data), 'writer.lock'); owner = {pid: process.pid, nonce: opaque()};
  try { mkdirSync(lock); }
  catch {
    const old = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'));
    fail(integer(old.pid) && old.pid > 0 && typeof old.nonce === 'string', 409, 'LOCK_AMBIGUOUS');
    let alive = true;
    try { process.kill(old.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
    fail(!alive, 409, 'WRITER_ACTIVE');
    rmSync(lock, {recursive: true}); mkdirSync(lock);
  }
  durable(join(lock, 'owner.json'), canonical(owner));
  journalPath = join(resolve(data), 'journal.jsonl');
  const identity = join(resolve(data), 'identity.json');
  if (!existsSync(identity) && !existsSync(journalPath)) {
    durable(journalPath, ''); durable(identity, canonical({kind: 'relay-directory-v1'}));
  }
  fail(existsSync(identity) && existsSync(journalPath) && !lstatSync(journalPath).isSymbolicLink(), 500, 'HISTORY_MISSING');
  fail(JSON.parse(readFileSync(identity, 'utf8')).kind === 'relay-directory-v1', 500, 'HISTORY_INVALID');
  state = {workspaces: {}, capabilities: {}, stageKeys: {}, commitKeys: {}};
  const bytes = readFileSync(journalPath);
  fail(bytes.length === 0 || bytes.at(-1) === 10, 500, 'HISTORY_TRUNCATED');
  for (const line of bytes.toString('utf8').split('\n').filter(Boolean)) {
    const record = JSON.parse(line);
    fail(Object.keys(record).sort().join(',') === 'hash,previous,seq,state' && record.seq === seq + 1
      && record.previous === previous && record.hash === hash(canonical({seq: record.seq, previous: record.previous, state: record.state})), 500, 'HISTORY_INVALID');
    state = record.state; seq = record.seq; previous = record.hash;
  }
  server = createServer(handle);
  server.on('error', () => { release(); process.exit(2); });
  server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ready: true, port: server.address().port})));
  const input = createInterface({input: process.stdin});
  input.on('line', line => { if (line === 'shutdown') shutdown(); });
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown); process.on('SIGBREAK', shutdown);
} catch {
  release(); console.error(JSON.stringify({error: {code: 'STARTUP_REFUSED', message: 'Storage or ownership validation failed'}})); process.exit(2);
}
