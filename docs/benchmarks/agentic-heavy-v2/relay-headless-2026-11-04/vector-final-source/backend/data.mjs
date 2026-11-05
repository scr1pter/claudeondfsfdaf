import { constants } from 'node:fs';
import filesystem, { mkdir, realpath, lstat, open, link, unlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const JOURNAL = 'transactions.jsonl';
const LOCK_DIRECTORY = '.relay-lock';
const TIP = 'tip.json';
// Seven rename attempts, at most 1,575 ms of deliberate backoff; no I/O other
// than a Windows EPERM/EBUSY/EACCES rename receives this retry policy.
const TIP_RENAME_DELAYS_MS = Object.freeze([25, 50, 100, 200, 400, 800]);
const TRANSIENT_WINDOWS_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES']);
const ZERO_HASH = '0'.repeat(64);
const HASH = /^[a-f0-9]{64}$/;
const NONCE = /^[a-f0-9]{48}$/;
const ROLES = new Set(['owner', 'editor', 'approver', 'worker', 'viewer']);
const STATES = new Set(['staged', 'approved', 'leased', 'committed', 'rejected', 'cancelled']);
const EVENT_TYPES = new Set(['workspace.created', 'capability.issued', 'capability.revoked',
  'import.staged', 'import.approved', 'import.rejected', 'import.cancelled',
  'import.claimed', 'import.committed']);
const PUBLIC_IMPORT = ['id', 'workspaceId', 'creator', 'baseVersion', 'state', 'rowCount',
  'digest', 'leaseEpoch', 'approvedBy'];
const SOURCE_DIRECTORY = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function failure(code, message) {
  const error = new Error(message);
  error.name = 'StorageError';
  error.code = code;
  return error;
}

function invalidValue() {
  return failure('STORAGE_INVALID_VALUE', 'A value is not safe JSON.');
}

/** Canonical JSON: sorted object keys, preserved arrays, no lossy JSON coercions. */
export function canonicalJson(value) {
  const ancestors = new Set();
  function encode(item) {
    if (item === null) return 'null';
    if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw invalidValue();
      return JSON.stringify(item);
    }
    if (typeof item !== 'object' || ancestors.has(item)) throw invalidValue();
    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) throw invalidValue();
    ancestors.add(item);
    try {
      const keys = Reflect.ownKeys(item);
      if (keys.some(key => typeof key !== 'string')) throw invalidValue();
      if (Array.isArray(item)) {
        if (keys.length !== item.length + 1) throw invalidValue();
        const parts = [];
        for (let index = 0; index < item.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
          if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalidValue();
          parts.push(encode(descriptor.value));
        }
        return `[${parts.join(',')}]`;
      }
      return `{${keys.sort().map(key => {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalidValue();
        return `${JSON.stringify(key)}:${encode(descriptor.value)}`;
      }).join(',')}}`;
    } finally {
      ancestors.delete(item);
    }
  }
  return encode(value);
}

export function hashToken(token) {
  if (typeof token !== 'string') throw invalidValue();
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function opaqueId() { return randomBytes(18).toString('hex'); }
export function secretToken() { return randomBytes(32).toString('base64url'); }

function clone(value) { return JSON.parse(canonicalJson(value)); }
function check(condition) { if (!condition) throw failure('STORAGE_INVALID_STATE', 'The storage schema is invalid.'); }
function object(value, keys) {
  check(value !== null && typeof value === 'object' && !Array.isArray(value));
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  check(actual.length === expected.length && actual.every((key, index) => key === expected[index]));
}
function text(value) { check(typeof value === 'string'); }
function integer(value, minimum = 0) { check(Number.isSafeInteger(value) && value >= minimum); }
function digest(value) { check(typeof value === 'string' && HASH.test(value)); }
function list(value) { check(Array.isArray(value)); }
function unique(values) { check(new Set(values).size === values.length); }
function publicImport(value) {
  object(value, PUBLIC_IMPORT);
  for (const key of ['id', 'workspaceId', 'creator']) text(value[key]);
  integer(value.baseVersion);
  integer(value.rowCount, 1);
  check(value.rowCount <= 500);
  integer(value.leaseEpoch);
  digest(value.digest);
  check(STATES.has(value.state));
  check(value.approvedBy === null || typeof value.approvedBy === 'string');
}
function replayResult(value, committed) {
  object(value, committed ? ['import', 'version', 'applied'] : ['import']);
  publicImport(value.import);
  if (committed) {
    integer(value.version, 1);
    integer(value.applied, 1);
    check(value.import.state === 'committed');
  }
}

/** Shape/secret-field validation; route policy and business transitions belong to the API. */
function validateState(state) {
  object(state, ['schemaVersion', 'ownerDerivationKey', 'workspaces']);
  check(state.schemaVersion === 1);
  check(typeof state.ownerDerivationKey === 'string' && /^[A-Za-z0-9_-]{43}$/.test(state.ownerDerivationKey));
  list(state.workspaces);
  unique(state.workspaces.map(workspace => workspace.id));
  for (const workspace of state.workspaces) {
    object(workspace, ['id', 'name', 'version', 'creation', 'capabilities', 'members', 'imports', 'stagingReplays', 'events']);
    check(typeof workspace.id === 'string' && /^[a-z][a-z0-9-]{2,23}$/.test(workspace.id));
    text(workspace.name);
    integer(workspace.version);
    object(workspace.creation, ['requestHash', 'ownerCapabilityId', 'nonce']);
    digest(workspace.creation.requestHash);
    text(workspace.creation.ownerCapabilityId);
    text(workspace.creation.nonce);
    list(workspace.capabilities);
    unique(workspace.capabilities.map(capability => capability.id));
    for (const capability of workspace.capabilities) {
      object(capability, ['id', 'subject', 'role', 'tokenHash', 'revoked']);
      text(capability.id);
      text(capability.subject);
      check(ROLES.has(capability.role));
      digest(capability.tokenHash);
      check(typeof capability.revoked === 'boolean');
    }
    check(workspace.capabilities.some(capability => capability.id === workspace.creation.ownerCapabilityId
      && capability.role === 'owner' && capability.subject === 'owner'));
    list(workspace.members);
    unique(workspace.members.map(member => member.externalId));
    for (const member of workspace.members) {
      object(member, ['externalId', 'name', 'email', 'revision']);
      for (const key of ['externalId', 'name', 'email']) text(member[key]);
      integer(member.revision, 1);
    }
    list(workspace.imports);
    unique(workspace.imports.map(record => record.id));
    for (const record of workspace.imports) {
      object(record, [...PUBLIC_IMPORT, 'rows', 'rejectionReason', 'lease', 'commitReplay']);
      const projection = Object.fromEntries(PUBLIC_IMPORT.map(key => [key, record[key]]));
      publicImport(projection);
      check(record.workspaceId === workspace.id);
      list(record.rows);
      check(record.rows.length === record.rowCount);
      unique(record.rows.map(row => row.externalId));
      for (const row of record.rows) {
        object(row, ['op', 'externalId', 'name', 'email']);
        check(row.op === 'upsert' || row.op === 'delete');
        for (const key of ['externalId', 'name', 'email']) text(row[key]);
      }
      check(record.rejectionReason === null || typeof record.rejectionReason === 'string');
      if (record.lease !== null) {
        object(record.lease, ['capabilityId', 'subject', 'epoch', 'tokenHash', 'expiresAt']);
        text(record.lease.capabilityId);
        text(record.lease.subject);
        integer(record.lease.epoch, 1);
        integer(record.lease.expiresAt, 1);
        digest(record.lease.tokenHash);
      }
      if (record.commitReplay !== null) {
        const replay = record.commitReplay;
        object(replay, ['capabilityId', 'subject', 'key', 'requestHash', 'result']);
        for (const key of ['capabilityId', 'subject', 'key']) text(replay[key]);
        digest(replay.requestHash);
        replayResult(replay.result, true);
        check(replay.result.import.id === record.id && replay.result.import.workspaceId === workspace.id);
      }
    }
    list(workspace.stagingReplays);
    unique(workspace.stagingReplays.map(replay => canonicalJson([replay.subject, replay.key])));
    for (const replay of workspace.stagingReplays) {
      object(replay, ['subject', 'key', 'requestHash', 'importId', 'result']);
      for (const key of ['subject', 'key', 'importId']) text(replay[key]);
      digest(replay.requestHash);
      replayResult(replay.result, false);
      check(replay.result.import.id === replay.importId && replay.result.import.workspaceId === workspace.id
        && replay.result.import.state === 'staged');
      check(workspace.imports.some(record => record.id === replay.importId));
    }
    list(workspace.events);
    workspace.events.forEach((event, index) => {
      object(event, ['cursor', 'type', 'subject', 'importId']);
      check(event.cursor === index + 1 && EVENT_TYPES.has(event.type));
      text(event.subject);
      check(event.importId === null || typeof event.importId === 'string');
    });
  }
}

function corrupt() { return failure('STORAGE_CORRUPT', 'Durable storage is invalid; no recovery or repair was attempted.'); }
function ioFailure() { return failure('STORAGE_IO', 'A storage operation failed; its durable outcome may be uncertain.'); }
function isMissing(error) { return error?.code === 'ENOENT'; }
function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function dataDirectory(dataDir) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || inside(SOURCE_DIRECTORY, path.resolve(dataDir))) {
    throw failure('STORAGE_INVALID_DIRECTORY', 'An absolute data directory outside authored source is required.');
  }
  const source = await realpath(SOURCE_DIRECTORY);
  // Resolve the existing ancestor before mkdir, so a source-pointing ancestor
  // junction/symlink cannot cause even an empty runtime directory in source.
  let ancestor = path.resolve(dataDir);
  const missing = [];
  let resolved;
  while (resolved === undefined) {
    try { resolved = await realpath(ancestor); }
    catch (error) {
      if (!isMissing(error)) throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
  if (inside(source, path.join(resolved, ...missing))) {
    throw failure('STORAGE_INVALID_DIRECTORY', 'The data directory must be outside authored source.');
  }
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const directory = await realpath(dataDir);
  if (inside(source, directory)) throw failure('STORAGE_INVALID_DIRECTORY', 'The data directory must be outside authored source.');
  return directory;
}

async function safeStat(filename) {
  try { return await lstat(filename); } catch (error) { if (isMissing(error)) return null; throw error; }
}

async function regularFile(filename, flags) {
  const before = await lstat(filename);
  if (!before.isFile() || before.isSymbolicLink()) throw corrupt();
  const handle = await open(filename, flags | (constants.O_NOFOLLOW || 0));
  try {
    const after = await handle.stat();
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino) throw corrupt();
    return handle;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

// Windows commonly cannot open/sync directory handles. File fsync remains mandatory.
async function syncDirectory(directory) {
  let handle;
  try {
    handle = await filesystem.open(directory, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    const unsupported = process.platform === 'win32'
      ? ['EISDIR', 'EPERM', 'EACCES', 'EINVAL', 'ENOTSUP', 'EBADF', 'ENOSYS']
      : ['EINVAL', 'ENOTSUP', 'ENOSYS'];
    if (!unsupported.includes(error.code)) throw error;
  } finally {
    if (handle) await handle.close();
  }
}

async function metadata(filename) {
  let handle;
  try {
    handle = await regularFile(filename, constants.O_RDONLY);
    const stat = await handle.stat();
    if (stat.size > 4096) throw corrupt();
    const bytes = await handle.readFile();
    const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!source.endsWith('\n')) throw corrupt();
    const value = JSON.parse(source.slice(0, -1));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw corrupt();
    if (`${canonicalJson(value)}\n` !== source) throw corrupt();
    return value;
  } catch (error) {
    if (isMissing(error)) return null;
    if (error.code === 'STORAGE_CORRUPT') throw error;
    if (error instanceof SyntaxError || error instanceof TypeError || error.code === 'STORAGE_INVALID_VALUE') throw corrupt();
    throw error;
  } finally {
    if (handle) await handle.close();
  }
}

// Link publication is exclusive and atomic on supported filesystems. Published files
// are immutable and never unlinked, eliminating check/unlink stale-lock races.
async function publish(directory, filename, value) {
  const candidate = path.join(directory, `.candidate-${randomBytes(24).toString('hex')}.json`);
  let handle;
  let ownCandidate = false;
  try {
    handle = await open(candidate, 'wx', 0o600);
    ownCandidate = true;
    await handle.writeFile(`${canonicalJson(value)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await link(candidate, filename);
      return true;
    } catch (error) {
      if (error.code === 'EEXIST') return false;
      if (['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV'].includes(error.code)) {
        throw failure('STORAGE_UNSUPPORTED', 'Atomic exclusive hard-link publication is unavailable.');
      }
      throw error;
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
    // Only this attempt's successfully created, unpredictable candidate is eligible.
    if (ownCandidate) await unlink(candidate).catch(() => {});
  }
}

function validateTip(tip) {
  try {
    object(tip, ['format', 'seq', 'hash']);
    check(tip.format === 1);
    integer(tip.seq, 1);
    digest(tip.hash);
  } catch { throw corrupt(); }
}

async function expectTip(filename, expected) {
  const current = await metadata(filename);
  if (current !== null) validateTip(current);
  if (expected === null ? current !== null
    : current === null || current.seq !== expected.seq || current.hash !== expected.hash) throw corrupt();
}

function sameFile(actual, expected) {
  return actual.dev === expected.dev && actual.ino === expected.ino;
}

async function tipDirectory(directory, identity) {
  const current = await lstat(directory);
  if (!current.isDirectory() || current.isSymbolicLink() || !sameFile(current, identity)) throw corrupt();
}

async function tipCandidate(filename, identity) {
  const current = await lstat(filename);
  if (!current.isFile() || current.isSymbolicLink() || !sameFile(current, identity)
    || current.size !== identity.size) throw corrupt();
}

// The exclusive process owner alone updates this reserved mutable metadata file.
// A synced candidate is renamed over the checked regular prior tip; never unlink
// the prior tip first. Initial creation is exclusive so no existing file is lost.
async function updateTip(directory, expected, next) {
  validateTip(next);
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw corrupt();
  const filename = path.join(directory, TIP);
  await expectTip(filename, expected);
  if (expected === null) {
    if (!(await publish(directory, filename, next))) throw corrupt();
    await syncDirectory(directory);
    return;
  }
  if (next.seq <= expected.seq) throw corrupt();
  const candidate = path.join(directory, `.tip-${randomBytes(24).toString('hex')}.json`);
  let handle;
  let ownCandidate = false;
  let candidateIdentity;
  try {
    handle = await open(candidate, 'wx', 0o600);
    ownCandidate = true;
    candidateIdentity = await handle.stat();
    await handle.writeFile(`${canonicalJson(next)}\n`, 'utf8');
    await handle.sync();
    candidateIdentity = await handle.stat();
    await handle.close();
    handle = null;
    for (let attempt = 0; ; attempt++) {
      // Repeat all guards after each delay. Retain the exact synced inode across
      // retries; neither replace the candidate nor unlink the previous tip.
      await tipDirectory(directory, stat);
      await expectTip(filename, expected);
      await tipCandidate(candidate, candidateIdentity);
      try {
        await filesystem.rename(candidate, filename);
        ownCandidate = false;
        break;
      } catch (error) {
        if (process.platform !== 'win32' || !TRANSIENT_WINDOWS_RENAME.has(error.code)
          || attempt >= TIP_RENAME_DELAYS_MS.length) throw error;
        // A reported failure after an actual rename is NOT treated as success:
        // the next expected-tip/candidate checks fail closed and poison the store.
        await new Promise(resolve => setTimeout(resolve, TIP_RENAME_DELAYS_MS[attempt]));
      }
    }
    await syncDirectory(directory);
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (ownCandidate && candidateIdentity) {
      // A failed guard may mean someone replaced a reserved path. Do not delete
      // their file, a junction target, or even a different candidate inode.
      try {
        await tipDirectory(directory, stat);
        const current = await lstat(candidate);
        if (current.isFile() && !current.isSymbolicLink() && sameFile(current, candidateIdentity)) await unlink(candidate);
      } catch { /* Preserve unknown paths; never mask the original failure. */ }
    }
  }
}

function validateLock(record, parent) {
  try {
    object(record, ['format', 'kind', 'nonce', 'pid', 'parent']);
    check(record.format === 1 && (record.kind === 'held' || record.kind === 'released'));
    check(typeof record.nonce === 'string' && NONCE.test(record.nonce));
    integer(record.pid, 1);
    check(record.parent === (parent ? parent.nonce : null));
    if (!parent) check(record.kind === 'held');
    if (record.kind === 'released') check(parent?.kind === 'held' && parent.pid === record.pid);
  } catch { throw corrupt(); }
}

function live(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    // Access denial, PID reuse, and any uncertain result refuse takeover.
    return true;
  }
}

async function acquireLock(dataDirectory) {
  const directory = path.join(dataDirectory, LOCK_DIRECTORY);
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw corrupt();
  const root = path.join(directory, 'root.json');
  let owned = null;
  let released = false;
  async function release() {
    if (released || !owned) return;
    const record = { format: 1, kind: 'released', nonce: randomBytes(24).toString('hex'),
      pid: process.pid, parent: owned.nonce };
    const target = path.join(directory, `next-${owned.nonce}.json`);
    if (!(await publish(directory, target, record))) throw corrupt();
    released = true;
    await syncDirectory(directory);
  }
  function owner(parent) {
    return { format: 1, kind: 'held', nonce: randomBytes(24).toString('hex'), pid: process.pid, parent };
  }
  try {
    let current = await metadata(root);
    if (current === null) {
      if (await safeStat(path.join(directory, 'initialized.json')) || await safeStat(path.join(directory, TIP))) {
        // Another initializer may have published the root since our first read.
        current = await metadata(root);
        if (current === null) throw corrupt();
      } else {
        const candidate = owner(null);
        if (await publish(directory, root, candidate)) {
          owned = candidate;
        } else {
          current = await metadata(root);
          if (current === null) throw corrupt();
        }
      }
    }
    if (!owned) {
      validateLock(current, null);
      const seen = new Set();
      while (!owned) {
        if (seen.has(current.nonce)) throw corrupt();
        seen.add(current.nonce);
        const target = path.join(directory, `next-${current.nonce}.json`);
        const next = await metadata(target);
        if (next !== null) {
          validateLock(next, current);
          current = next;
          continue;
        }
        if (current.kind === 'held' && live(current.pid)) {
          throw failure('STORAGE_LOCKED', 'The data directory already has a live or unverifiable owner.');
        }
        const candidate = owner(current.nonce);
        if (await publish(directory, target, candidate)) {
          owned = candidate;
        } else {
          // Another reclaimer won. Re-read without deleting or replacing anything.
          seen.delete(current.nonce);
        }
      }
    }
    await syncDirectory(directory);
    await syncDirectory(dataDirectory);
    return { directory, release };
  } catch (error) {
    if (owned) await release().catch(() => {});
    throw error;
  }
}

function recordFor(sequence, previousHash, state) {
  const payload = { format: 1, seq: sequence, prevHash: previousHash, state };
  return { ...payload, hash: hashToken(canonicalJson(payload)) };
}

async function append(handle, record) {
  const bytes = Buffer.from(`${canonicalJson(record)}\n`, 'utf8');
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, null);
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0) throw ioFailure();
    offset += bytesWritten;
  }
  await handle.sync();
}

async function recover(handle) {
  try {
    const bytes = await handle.readFile();
    if (bytes.length === 0 || bytes[bytes.length - 1] !== 10) throw corrupt();
    const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    let sequence = 0;
    let previousHash = ZERO_HASH;
    let state;
    let genesisHash;
    let ownerDerivationKey;
    const hashes = [];
    for (const line of source.slice(0, -1).split('\n')) {
      if (line.length === 0) throw corrupt();
      const record = JSON.parse(line);
      object(record, ['format', 'seq', 'prevHash', 'state', 'hash']);
      if (canonicalJson(record) !== line) throw corrupt();
      if (record.format !== 1 || !Number.isSafeInteger(record.seq) || record.seq !== sequence + 1
        || record.prevHash !== previousHash || !HASH.test(record.hash)) throw corrupt();
      const expected = recordFor(record.seq, record.prevHash, record.state);
      if (record.hash !== expected.hash) throw corrupt();
      validateState(record.state);
      if (sequence === 0) {
        // Genesis is always the original empty seed, never a business transaction.
        if (record.state.workspaces.length !== 0) throw corrupt();
        genesisHash = record.hash;
        ownerDerivationKey = record.state.ownerDerivationKey;
      } else if (record.state.ownerDerivationKey !== ownerDerivationKey) throw corrupt();
      sequence = record.seq;
      previousHash = record.hash;
      state = record.state;
      hashes.push(record.hash);
    }
    return { state, sequence, previousHash, genesisHash, hashes };
  } catch (error) {
    if (error.code === 'STORAGE_CORRUPT') throw error;
    if (error instanceof SyntaxError || error instanceof TypeError || ['STORAGE_INVALID_STATE', 'STORAGE_INVALID_VALUE'].includes(error.code)) throw corrupt();
    throw error;
  }
}

/** Open only a supplied absolute directory outside this module's authored source. */
export async function openStore(dataDir) {
  let lock;
  let handle;
  try {
    const directory = await dataDirectory(dataDir);
    lock = await acquireLock(directory);
    const markerPath = path.join(lock.directory, 'initialized.json');
    const tipPath = path.join(lock.directory, TIP);
    const marker = await metadata(markerPath);
    if (marker !== null) {
      try {
        object(marker, ['format', 'journal', 'genesisHash']);
        check(marker.format === 1 && marker.journal === JOURNAL);
        digest(marker.genesisHash);
      } catch { throw corrupt(); }
    }
    const journalPath = path.join(directory, JOURNAL);
    const existing = await safeStat(journalPath);
    let recovered;
    if (existing === null) {
      if (marker !== null || await safeStat(tipPath)) throw corrupt();
      handle = await open(journalPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_APPEND, 0o600);
      const state = { schemaVersion: 1, ownerDerivationKey: secretToken(), workspaces: [] };
      const genesis = recordFor(1, ZERO_HASH, state);
      await append(handle, genesis);
      await syncDirectory(directory);
      recovered = { state, sequence: 1, previousHash: genesis.hash, genesisHash: genesis.hash, hashes: [genesis.hash] };
    } else {
      handle = await regularFile(journalPath, constants.O_RDWR | constants.O_APPEND);
      recovered = await recover(handle);
    }
    if (marker !== null && marker.genesisHash !== recovered.genesisHash) throw corrupt();
    // Fully validate every journal record before trusting or creating any anchor.
    // A later valid journal tail is an unacknowledged crash window, not corruption.
    let tip = await metadata(tipPath);
    if (tip === null) {
      if (marker !== null) throw corrupt();
    } else {
      validateTip(tip);
      if (tip.seq > recovered.sequence || recovered.hashes[tip.seq - 1] !== tip.hash) throw corrupt();
    }
    const recoveredTip = { format: 1, seq: recovered.sequence, hash: recovered.previousHash };
    if (tip === null || tip.seq !== recoveredTip.seq) {
      await updateTip(lock.directory, tip, recoveredTip);
    }
    tip = recoveredTip;
    delete recovered.hashes;
    if (marker === null) {
      // Tip creation must precede the initialized marker: once initialized, a
      // missing tip is always corruption, never permission to reset an anchor.
      if (!(await publish(lock.directory, markerPath, { format: 1, journal: JOURNAL, genesisHash: recovered.genesisHash }))) throw corrupt();
      await syncDirectory(lock.directory);
    }
    let { state, sequence, previousHash } = recovered;
    let stateJson = canonicalJson(state);
    let accepting = true;
    let poisoned = false;
    let tail = Promise.resolve();
    let closing;
    const store = {
      snapshot() {
        if (!accepting) throw failure('STORAGE_CLOSED', 'Storage is closing or closed.');
        if (poisoned) throw failure('STORAGE_POISONED', 'Storage requires shutdown after a persistence failure.');
        return JSON.parse(stateJson);
      },
      transact(callback) {
        if (!accepting) return Promise.reject(failure('STORAGE_CLOSED', 'Storage is closing or closed.'));
        if (typeof callback !== 'function') return Promise.reject(invalidValue());
        const transaction = tail.then(async () => {
          if (poisoned) throw failure('STORAGE_POISONED', 'Storage requires shutdown after a persistence failure.');
          const draft = JSON.parse(stateJson);
          const result = clone(await callback(draft));
          const nextJson = canonicalJson(draft);
          if (nextJson === stateJson) return result;
          try { validateState(draft); }
          catch { throw failure('STORAGE_INVALID_STATE', 'The storage schema is invalid.'); }
          check(draft.ownerDerivationKey === state.ownerDerivationKey);
          if (!Number.isSafeInteger(sequence + 1)) throw failure('STORAGE_INVALID_STATE', 'The journal sequence is exhausted.');
          const record = recordFor(sequence + 1, previousHash, draft);
          try {
            await append(handle, record);
            const nextTip = { format: 1, seq: record.seq, hash: record.hash };
            await updateTip(lock.directory, tip, nextTip);
            tip = nextTip;
          }
          catch {
            poisoned = true;
            throw ioFailure();
          }
          // Retained callback references must never be able to mutate published state.
          state = JSON.parse(nextJson);
          stateJson = nextJson;
          sequence = record.seq;
          previousHash = record.hash;
          return result;
        });
        tail = transaction.catch(() => {});
        return transaction;
      },
      close() {
        if (closing) return closing;
        accepting = false;
        closing = (async () => {
          await tail;
          // A close error must not publish a release while the handle may remain open.
          try { await handle.close(); }
          catch { poisoned = true; throw ioFailure(); }
          try { await lock.release(); }
          catch (error) {
            if (error.code?.startsWith('STORAGE_')) throw error;
            throw ioFailure();
          }
        })();
        return closing;
      },
    };
    return store;
  } catch (error) {
    let closed = true;
    if (handle) {
      try { await handle.close(); } catch { closed = false; }
    }
    if (lock && closed) await lock.release().catch(() => {});
    if (error.code?.startsWith('STORAGE_')) throw error;
    throw ioFailure();
  }
}
