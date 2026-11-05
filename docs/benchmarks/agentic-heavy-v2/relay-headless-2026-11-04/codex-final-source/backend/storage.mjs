import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import net from 'node:net';

const JOURNAL = 'relay-transactions.jsonl';
const LOCK = '.relay-owner';
const ZERO_HASH = '0'.repeat(64);

function fault(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

export function createSecret() {
  return randomBytes(32).toString('base64url');
}

export function hashSecret(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

export function createCapability({ workspaceId, subject, role, token = createSecret() }) {
  return {
    record: {
      id: randomBytes(18).toString('base64url'),
      workspaceId,
      subject,
      role,
      tokenHash: hashSecret(token),
      revoked: false,
    },
    token,
  };
}

export function authenticate(state, token, workspaceId) {
  if (typeof token !== 'string' || !token) {
    throw fault(401, 'unauthorized', 'A valid capability is required.');
  }
  const digest = Buffer.from(hashSecret(token), 'hex');
  const capability = state.capabilities.find((entry) => {
    if (typeof entry.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(entry.tokenHash)) return false;
    return timingSafeEqual(Buffer.from(entry.tokenHash, 'hex'), digest);
  });
  if (!capability || capability.revoked) {
    throw fault(401, 'unauthorized', 'A valid capability is required.');
  }
  if (workspaceId !== undefined && capability.workspaceId !== workspaceId) {
    throw fault(403, 'forbidden', 'The capability does not permit this workspace.');
  }
  return capability;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    return true;
  }
}

async function closeServer(server) {
  if (!server) return;
  await new Promise((resolve) => server.close(() => resolve()));
}

function sameEntry(actual, expected) {
  return actual.dev === expected.dev && actual.ino === expected.ino;
}

async function inspectOwnerDirectory(directory, expected) {
  let directoryInfo;
  try {
    directoryInfo = await fs.lstat(directory);
  } catch (error) {
    if (error.code === 'ENOENT' && !expected) return null;
    throw error;
  }
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()
    || (expected && !sameEntry(directoryInfo, expected.directoryInfo))) {
    throw new Error('The data directory ownership path is unsafe.');
  }
  const entries = await fs.readdir(directory);
  if (entries.length !== 1 || entries[0] !== 'owner.json') {
    throw new Error('The data directory ownership record has unexpected files.');
  }
  const metadataPath = path.join(directory, 'owner.json');
  const metadataInfo = await fs.lstat(metadataPath);
  if (!metadataInfo.isFile() || metadataInfo.isSymbolicLink() || metadataInfo.nlink !== 1
    || (expected && !sameEntry(metadataInfo, expected.metadataInfo))) {
    throw new Error('The data directory ownership metadata is unsafe.');
  }
  const file = await fs.open(metadataPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let owner;
  try {
    const openedInfo = await file.stat();
    if (!openedInfo.isFile() || openedInfo.nlink !== 1 || !sameEntry(openedInfo, metadataInfo)) {
      throw new Error('The data directory ownership metadata changed.');
    }
    owner = JSON.parse(await file.readFile('utf8'));
  } finally {
    await file.close();
  }
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.nonce !== 'string'
    || (expected && (owner.pid !== expected.owner.pid || owner.nonce !== expected.owner.nonce))) {
    throw new Error('The data directory ownership record is invalid.');
  }
  const directoryAfter = await fs.lstat(directory);
  const metadataAfter = await fs.lstat(metadataPath);
  if (!directoryAfter.isDirectory() || directoryAfter.isSymbolicLink()
    || !sameEntry(directoryAfter, directoryInfo)
    || !metadataAfter.isFile() || metadataAfter.isSymbolicLink() || metadataAfter.nlink !== 1
    || !sameEntry(metadataAfter, metadataInfo)) {
    throw new Error('The data directory ownership record changed.');
  }
  return { owner, directoryInfo, metadataInfo };
}

async function removeOwnerDirectory(directory, expected) {
  await inspectOwnerDirectory(directory, expected);
  await fs.unlink(path.join(directory, 'owner.json'));
  const remainingDirectory = await fs.lstat(directory);
  if (!remainingDirectory.isDirectory() || remainingDirectory.isSymbolicLink()
    || !sameEntry(remainingDirectory, expected.directoryInfo)
    || (await fs.readdir(directory)).length !== 0) {
    throw new Error('The data directory ownership path changed during release.');
  }
  await fs.rmdir(directory);
}

// Kernel ownership is released even when a process dies between filesystem calls.
// The directory remains an inspectable ownership record, never a timeout lease.
async function acquireLock(dataDir) {
  const identity = createHash('sha256').update(dataDir).digest('hex');
  const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\relay-directory-${identity}`
    : process.platform === 'linux' ? `\0relay-directory-${identity}` : null;
  let guard;
  if (endpoint !== null) {
    guard = net.createServer((socket) => socket.destroy());
    await new Promise((resolve, reject) => {
      const onError = () => reject(new Error('The data directory already has a live writer.'));
      guard.once('error', onError);
      guard.listen(endpoint, () => {
        guard.removeListener('error', onError);
        guard.on('error', () => {});
        resolve();
      });
    });
  }
  const lockPath = path.join(dataDir, LOCK);
  const owner = { pid: process.pid, nonce: randomBytes(24).toString('hex') };
  const preparedPath = path.join(dataDir, `.relay-owner-${owner.pid}-${owner.nonce}`);
  let prepared = false;
  let preparedInfo;
  let ownership;
  let owned = false;
  try {
    const current = await inspectOwnerDirectory(lockPath);
    if (current) {
      if (alive(current.owner.pid)) throw new Error('The data directory already has a live writer.');
      // On supported platforms the kernel guard excludes all other recoverers.
      // On other platforms keep stale ownership intact rather than risk a race.
      if (!guard) throw new Error('Safe stale-owner recovery is unavailable on this platform.');
      await removeOwnerDirectory(lockPath, current);
    }
    await fs.mkdir(preparedPath, { mode: 0o700 });
    prepared = true;
    preparedInfo = await fs.lstat(preparedPath);
    const metadata = await fs.open(path.join(preparedPath, 'owner.json'), 'wx', 0o600);
    try {
      await metadata.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
      await metadata.sync();
    } finally {
      await metadata.close();
    }
    const preparedOwner = await inspectOwnerDirectory(preparedPath);
    if (!sameEntry(preparedOwner.directoryInfo, preparedInfo)
      || preparedOwner.owner.pid !== owner.pid || preparedOwner.owner.nonce !== owner.nonce) {
      throw new Error('The prepared ownership record changed.');
    }
    await fs.rename(preparedPath, lockPath);
    prepared = false;
    owned = true;
    ownership = await inspectOwnerDirectory(lockPath, preparedOwner);
  } catch (error) {
    if (prepared) {
      // Clean up only a complete record that still has our original identity.
      // Incomplete, aliased, or unexpectedly populated paths remain untouched.
      try {
        const candidate = await inspectOwnerDirectory(preparedPath);
        if (candidate && preparedInfo && sameEntry(candidate.directoryInfo, preparedInfo)
          && candidate.owner.pid === owner.pid && candidate.owner.nonce === owner.nonce) {
          await removeOwnerDirectory(preparedPath, candidate);
        }
      } catch {}
    }
    await closeServer(guard);
    throw error;
  }
  return async () => {
    try {
      if (owned) {
        await removeOwnerDirectory(lockPath, ownership);
        owned = false;
      }
    } finally {
      await closeServer(guard);
    }
  };
}

function checksum(sequence, previousHash, state) {
  return createHash('sha256').update(JSON.stringify({ sequence, previousHash, state }), 'utf8').digest('hex');
}

function validateState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)
    || !Array.isArray(state.workspaces) || !Array.isArray(state.capabilities)
    || !Array.isArray(state.workspaceKeys)) {
    throw new Error('The transaction journal contains an invalid state.');
  }
}

function recover(bytes) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('The transaction journal is not valid UTF-8.');
  }
  let state = { workspaces: [], capabilities: [], workspaceKeys: [] };
  let sequence = 0;
  let previousHash = ZERO_HASH;
  if (!text) return { state, sequence, previousHash };
  if (!text.endsWith('\n')) throw new Error('The transaction journal has an incomplete trailing record.');
  const lines = text.slice(0, -1).split('\n');
  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw new Error('The transaction journal contains malformed JSON.');
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || Object.keys(record).sort().join(',') !== 'hash,previousHash,sequence,state'
      || !Number.isSafeInteger(record.sequence) || record.sequence !== sequence + 1
      || record.previousHash !== previousHash || typeof record.hash !== 'string'
      || !/^[a-f0-9]{64}$/.test(record.hash)
      || record.hash !== checksum(record.sequence, record.previousHash, record.state)) {
      throw new Error('The transaction journal integrity check failed.');
    }
    validateState(record.state);
    state = record.state;
    sequence = record.sequence;
    previousHash = record.hash;
  }
  return { state, sequence, previousHash };
}

export async function openStore({ dataDir }) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) {
    throw new Error('An absolute data directory is required.');
  }
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const absoluteDir = await fs.realpath(dataDir);
  const release = await acquireLock(absoluteDir);
  let journal;
  try {
    const journalPath = path.join(absoluteDir, JOURNAL);
    try {
      const info = await fs.lstat(journalPath);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('The transaction journal must be a regular file.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    journal = await fs.open(journalPath, 'a+', 0o600);
    let { state, sequence, previousHash } = recover(await journal.readFile());
    let queue = Promise.resolve();
    let closing = false;
    let failed = false;
    let closePromise;
    return {
      read(reader) {
        if (closing || failed) throw fault(503, 'unavailable', 'The service is unavailable.');
        return reader(structuredClone(state));
      },
      transact(mutator) {
        if (closing || failed) return Promise.reject(fault(503, 'unavailable', 'The service is unavailable.'));
        const pending = queue.then(async () => {
          if (failed) throw fault(503, 'unavailable', 'The service is unavailable.');
          const draft = structuredClone(state);
          const outcome = mutator(draft);
          if (!outcome || typeof outcome !== 'object' || typeof outcome.changed !== 'boolean'
            || typeof outcome.then === 'function') {
            throw new Error('Invalid transaction outcome.');
          }
          if (!outcome.changed) return outcome.result;
          validateState(draft);
          if (sequence >= Number.MAX_SAFE_INTEGER) throw fault(503, 'unavailable', 'Transaction capacity exhausted.');
          const nextSequence = sequence + 1;
          const hash = checksum(nextSequence, previousHash, draft);
          const record = { sequence: nextSequence, previousHash, state: draft, hash };
          try {
            const buffer = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
            let offset = 0;
            while (offset < buffer.length) {
              const { bytesWritten } = await journal.write(buffer, offset, buffer.length - offset, null);
              if (!bytesWritten) throw new Error('The journal write did not advance.');
              offset += bytesWritten;
            }
            await journal.sync();
          } catch {
            failed = true;
            throw fault(503, 'storage_unavailable', 'The durable transaction could not be completed.');
          }
          state = draft;
          sequence = nextSequence;
          previousHash = hash;
          return outcome.result;
        });
        queue = pending.catch(() => {});
        return pending;
      },
      close() {
        if (closePromise) return closePromise;
        closing = true;
        closePromise = (async () => {
          await queue;
          try {
            await journal.close();
          } finally {
            await release();
          }
        })();
        return closePromise;
      },
    };
  } catch (error) {
    if (journal) await journal.close().catch(() => {});
    await release();
    throw error;
  }
}
