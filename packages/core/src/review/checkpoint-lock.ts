export * as ReviewCheckpointLock from "./checkpoint-lock"

import { createHash } from "node:crypto"
import { constants } from "node:fs"
import fs, { type FileHandle } from "node:fs/promises"
import path from "node:path"
import { Effect, ManagedRuntime } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { layer } from "#sqlite"
import { Flock } from "../util/flock"

// This sidecar is permanent. Unlinking/replacing a lock database would split its kernel lock identity.
// Receipt JSON stays the authority; the database contains no review, model, credential or ledger data.
const queues = new Map<string, Promise<void>>()
// A failed native disposal must not let GC close an old external FD after a same-process successor starts.
const compromised = new Set<object>()
const refused = () => new Error("The local review checkpoint writer lock is unavailable.")
const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "EEXIST"

function wait<A>(value: Promise<A>, signal: AbortSignal): Promise<A> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    value.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}

async function gate(key: string, signal: AbortSignal) {
  const previous = queues.get(key) ?? Promise.resolve()
  let release!: () => void
  const owned = new Promise<void>((resolve) => (release = resolve))
  const tail = previous.then(() => owned)
  queues.set(key, tail)
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key)
  })
  try {
    await wait(previous, signal)
    signal.throwIfAborted()
    return release
  } catch (error) {
    release()
    throw error
  }
}

function busy(cause: unknown) {
  if (typeof cause !== "object" || cause === null) return false
  // Node's builtin driver uses errcode; the shared classifier also supports Bun's code/errno.
  // SQLITE_LOCKED is an own-connection/shared-cache error, not ordinary cross-process contention.
  if ("code" in cause && typeof cause.code === "string" && /^SQLITE_BUSY(?:_|$)/.test(cause.code)) return true
  for (const value of ["errno" in cause ? cause.errno : undefined, "errcode" in cause ? cause.errcode : undefined]) {
    if (typeof value === "number" && Number.isSafeInteger(value) && (value & 0xff) === 5) return true
  }
  return false
}

export interface Lease {
  /** Every read/merge/write must finish before release can close this connection. */
  readonly use: <A>(run: () => Promise<A>) => Promise<A>
  readonly release: () => Promise<void>
  /** The held directory alias, usable only while this lease is alive. */
  readonly directory: string
  readonly sync: () => Promise<void>
}

export async function acquire(
  key: string,
  input: { readonly dir: string; readonly signal?: AbortSignal; readonly onWait?: () => void },
): Promise<Lease> {
  if (process.platform !== "linux") throw refused()
  if (!key || path.basename(key) !== key || key === "." || key === ".." || Buffer.byteLength(key) > 255) throw refused()
  const controller = new AbortController()
  const abort = () => controller.abort(input.signal?.reason)
  input.signal?.addEventListener("abort", abort, { once: true })
  if (input.signal?.aborted) abort()
  const timeout = setTimeout(() => controller.abort(refused()), 5 * 60_000)
  const handles: FileHandle[] = []
  let unlock: (() => void) | undefined
  let dispose: (() => Promise<void>) | undefined
  let rollback: (() => Promise<void>) | undefined
  let legacy: Flock.Lease | undefined
  let released: Promise<void> | undefined
  let closing = false
  let pending = Promise.resolve()
  const release = () => {
    if (released) return released
    closing = true
    released = (async () => {
      await pending
      let failure: unknown
      try {
        try {
          await legacy?.release()
        } catch (error) {
          failure = error
        }
        try {
          await rollback?.()
        } catch (error) {
          failure ??= error
        }
        // Finalize driver statements and prove its connection closed BEFORE closing the pinned DB FD.
        // If this fails, retain both the handles and the process gate until process exit.
        await dispose?.()
        const closed = await Promise.allSettled(handles.toReversed().map((handle) => handle.close()))
        const failed = closed.find((result) => result.status === "rejected")
        if (failed?.status === "rejected") throw failed.reason
        unlock?.()
      } catch (error) {
        compromised.add({ handles, dispose, rollback })
        throw error
      } finally {
        clearTimeout(timeout)
        input.signal?.removeEventListener("abort", abort)
      }
      if (failure !== undefined) throw failure
    })()
    return released
  }
  try {
    controller.signal.throwIfAborted()
    await fs.mkdir(input.dir, { recursive: true, mode: 0o700 })
    const directory = await fs.realpath(input.dir)
    const original = await fs.stat(directory, { bigint: true })
    const owner = process.getuid?.()
    if (!original.isDirectory() || (owner !== undefined && original.uid !== BigInt(owner)) || original.mode & 0o022n)
      throw refused()
    // Batch's /proc/self/fd alias and ordinary publication's visible path MUST share this process gate.
    unlock = await gate(`${original.dev}:${original.ino}:${key}`, controller.signal)
    const parent = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    handles.push(parent)
    const pinned = await parent.stat({ bigint: true })
    if (pinned.dev !== original.dev || pinned.ino !== original.ino) throw refused()
    const held = `/proc/self/fd/${parent.fd}`
    const leaf = `.writer-${createHash("sha256").update(key).digest("hex")}.sqlite3`
    const file = path.join(held, leaf)
    const flags = constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK
    const handle = await fs.open(file, flags | constants.O_CREAT | constants.O_EXCL, 0o600).catch((error) => {
      if (!missing(error)) throw error
      return fs.open(file, flags)
    })
    handles.push(handle)
    const bound = await handle.stat({ bigint: true })
    if (
      !bound.isFile() ||
      bound.nlink !== 1n ||
      (owner !== undefined && bound.uid !== BigInt(owner)) ||
      bound.mode & 0o077n ||
      bound.size > 1_048_576n
    )
      throw refused()
    const verify = async () => {
      controller.signal.throwIfAborted()
      const currentParent = await fs.stat(directory, { bigint: true })
      const current = await fs.lstat(file, { bigint: true })
      if (
        currentParent.dev !== pinned.dev ||
        currentParent.ino !== pinned.ino ||
        !current.isFile() ||
        current.dev !== bound.dev ||
        current.ino !== bound.ino ||
        current.nlink !== 1n ||
        (owner !== undefined && current.uid !== BigInt(owner)) ||
        current.mode & 0o077n
      )
        throw refused()
    }
    const runtime = ManagedRuntime.make(layer({ filename: file, disableWAL: true }))
    dispose = () => runtime.dispose()
    const execute = (statement: string) => runtime.runPromise(Effect.flatMap(SqlClient, (sql) => sql.unsafe(statement)))
    // Both supported drivers otherwise default to a synchronous 5s busy wait, which cannot observe AbortSignal.
    await execute("PRAGMA busy_timeout = 0")
    while (true) {
      await verify()
      const acquired = await runtime.runPromise(
        Effect.flatMap(SqlClient, (sql) => sql.unsafe("BEGIN EXCLUSIVE")).pipe(
          Effect.match({
            onSuccess: () => true,
            onFailure: (error) => {
              if (busy(error.reason.cause)) return false
              throw error
            },
          }),
        ),
      )
      if (acquired) break
      input.onWait?.()
      await wait(new Promise<void>((resolve) => setTimeout(resolve, 50)), controller.signal)
    }
    rollback = async () => {
      await execute("ROLLBACK")
    }
    // disableWAL suppresses automatic setup; it must not silently accept an existing WAL database.
    const mode = await execute("PRAGMA journal_mode")
    if (mode.length !== 1 || !("journal_mode" in mode[0]) || mode[0].journal_mode !== "delete") throw refused()
    await verify()
    // Helps healthy legacy writers, but old binaries that steal a stale Flock do not honor this new kernel lock.
    legacy = await Flock.acquire(key, { dir: held, signal: controller.signal })
    clearTimeout(timeout)
    const use: Lease["use"] = (run) => {
      if (closing) return Promise.reject(refused())
      const result = pending.then(verify).then(run)
      pending = result.then(
        () => undefined,
        () => undefined,
      )
      return result
    }
    return {
      use,
      release,
      directory: held,
      sync: () => parent.sync(),
    }
  } catch (error) {
    await release()
    throw error
  }
}
