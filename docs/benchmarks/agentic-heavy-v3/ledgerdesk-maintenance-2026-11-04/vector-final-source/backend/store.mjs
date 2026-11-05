import fs from "node:fs"
import { join, resolve } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { fail, validateLegacy, validatePayload } from "./validation.mjs"

export function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

export const checksum = payload => createHash("sha256").update(canonicalJSON(payload), "utf8").digest("hex")
const emptyPayload = () => ({ accounts: [], usage: [], invoices: [], credits: [], keys: [], idempotency: [] })
const storeError = (code, message) => fail(500, code, message)

function syncDirectory(directory) {
  let fd
  try {
    fd = fs.openSync(directory, "r")
    fs.fsyncSync(fd)
  } catch (error) {
    // Windows cannot open/fsync directories. Do not hide real disk I/O failures.
    if (!["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EISDIR", ...(process.platform === "win32" ? ["EPERM", "EACCES"] : [])].includes(error.code)) throw error
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

function writeExclusive(path, bytes) {
  let fd
  try {
    fd = fs.openSync(path, "wx", 0o600)
    fs.writeFileSync(fd, bytes)
    fs.fsyncSync(fd)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

function atomicPersist(directory, payload) {
  const temporary = join(directory, `.ledger-${process.pid}-${randomUUID()}.tmp`)
  try {
    writeExclusive(temporary, JSON.stringify({ version: 2, payload, checksum: checksum(payload) }) + "\n")
    fs.renameSync(temporary, join(directory, "ledger.json"))
    syncDirectory(directory)
  } finally {
    try { fs.unlinkSync(temporary) } catch (error) { if (error.code !== "ENOENT") throw error }
  }
}

function live(pid) {
  try { process.kill(pid, 0); return true } catch (error) {
    if (error.code === "ESRCH") return false
    // EPERM means the process exists but is not accessible.
    return true
  }
}

function readOwner(path) {
  const bytes = fs.readFileSync(path, "utf8")
  let owner
  try { owner = JSON.parse(bytes) } catch { storeError("store_locked", "Cannot safely recover the local store lock") }
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0 || typeof owner.token !== "string" || !/^[a-f0-9-]{36}$/.test(owner.token)) {
    storeError("store_locked", "Cannot safely recover the local store lock")
  }
  return { owner, bytes }
}

function claimRecovery(directory, token, candidate) {
  let identity = token
  // Each dead recovery claimant gets a separately fenced successor claim.
  // Never unlink a claim: this prevents a stale contender from deleting a new
  // live owner's lock after another contender has already replaced it.
  for (let depth = 0; depth < 128; depth++) {
    const path = join(directory, `.recover-${identity}`)
    try { fs.linkSync(candidate, path); return } catch (error) {
      if (error.code !== "EEXIST") throw error
    }
    const claimant = readOwner(path)
    if (live(claimant.owner.pid)) storeError("store_locked", "The local store lock is being recovered")
    identity = createHash("sha256").update(`${identity}:${claimant.owner.token}`).digest("hex")
  }
  storeError("store_locked", "Cannot safely recover the local store lock")
}

function acquireLock(directory) {
  const path = join(directory, "ledger.lock")
  const owner = { pid: process.pid, token: randomUUID() }
  // Prepare complete, fsynced ownership bytes before linking them atomically at
  // the lock path. A killed creator can never leave a half-written PID lock.
  const candidate = join(directory, `.lock-${owner.token}.tmp`)
  const bytes = JSON.stringify(owner)
  let owned = false
  const release = () => {
    try {
      if (fs.readFileSync(path, "utf8") === bytes) fs.unlinkSync(path)
    } catch (error) { if (error.code !== "ENOENT") throw error }
  }
  writeExclusive(candidate, bytes)
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        fs.linkSync(candidate, path)
        owned = true
        syncDirectory(directory)
        return release
      } catch (error) {
        if (error.code !== "EEXIST") throw error
      }
      let prior
      try { prior = readOwner(path) } catch (error) { if (error.code === "ENOENT") continue; throw error }
      if (live(prior.owner.pid)) storeError("store_locked", "The local store is already open")
      claimRecovery(directory, prior.owner.token, candidate)
      try {
        const current = readOwner(path)
        if (current.bytes === prior.bytes && !live(current.owner.pid)) fs.unlinkSync(path)
      } catch (error) { if (error.code !== "ENOENT") throw error }
    }
    storeError("store_locked", "Cannot acquire the local store lock")
  } catch (error) {
    if (owned) release()
    throw error
  } finally {
    fs.unlinkSync(candidate)
  }
}

function load(directory) {
  const ledgerPath = join(directory, "ledger.json")
  let bytes
  try { bytes = fs.readFileSync(ledgerPath) } catch (error) {
    if (error.code !== "ENOENT") throw error
    const payload = emptyPayload()
    atomicPersist(directory, payload)
    return payload
  }
  let document
  try { document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) } catch { storeError("invalid_storage", "Cannot parse the local ledger") }
  if (document?.version === 1) {
    validateLegacy(document)
    const payload = { ...emptyPayload(), accounts: document.accounts, usage: document.usage }
    validatePayload(payload)
    const backup = join(directory, "ledger.v1.backup.json")
    try { writeExclusive(backup, bytes) } catch (error) {
      if (error.code !== "EEXIST") throw error
      if (!fs.readFileSync(backup).equals(bytes)) storeError("backup_conflict", "Legacy backup differs from the local ledger")
    }
    syncDirectory(directory)
    atomicPersist(directory, payload)
    return payload
  }
  if (document?.version !== 2) storeError("unsupported_version", "Unsupported local ledger version")
  // Integrity is checked before payload record validation or use.
  if (typeof document.checksum !== "string" || !/^[a-f0-9]{64}$/.test(document.checksum) || checksum(document.payload) !== document.checksum) {
    storeError("checksum_mismatch", "Local ledger checksum verification failed")
  }
  if (Object.keys(document).sort().join(",") !== "checksum,payload,version") storeError("invalid_storage", "Invalid local ledger envelope")
  validatePayload(document.payload)
  return document.payload
}

export function openStore({ directory }) {
  if (typeof directory !== "string" || !directory) storeError("invalid_directory", "A local data directory is required")
  directory = resolve(directory)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const release = acquireLock(directory)
  let current
  try { current = structuredClone(load(directory)) } catch (error) { release(); throw error }
  let closed = false, inTransaction = false, poisoned = false
  const ready = () => {
    if (closed || poisoned) storeError("store_closed", "The local store is unavailable")
  }
  return {
    snapshot() { ready(); return structuredClone(current) },
    transaction(fn) {
      ready()
      if (inTransaction) storeError("nested_transaction", "Nested transactions are not supported")
      if (typeof fn !== "function") throw new TypeError("A synchronous transaction callback is required")
      inTransaction = true
      try {
        const draft = structuredClone(current)
        const result = fn(draft)
        if (result !== null && (typeof result === "object" || typeof result === "function") && typeof result.then === "function") {
          // Avoid unhandled rejections from accidentally async callbacks, but do
          // not execute arbitrary foreign thenables.
          if (result instanceof Promise) result.catch(() => {})
          storeError("async_transaction", "Transactions must be synchronous")
        }
        validatePayload(draft, current)
        const next = structuredClone(draft)
        try { atomicPersist(directory, next) } catch (error) { poisoned = true; throw error }
        current = next
        return result
      } finally { inTransaction = false }
    },
    close() {
      if (closed) return
      if (inTransaction) storeError("active_transaction", "Cannot close during a transaction")
      release()
      closed = true
    },
  }
}
