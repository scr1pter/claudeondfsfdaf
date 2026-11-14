import path from "path"
import os from "os"
import { randomBytes, randomUUID } from "crypto"
// The module object, not named imports, so the lock's file calls can be replaced in tests (spyOn) to inject errors.
import fs from "fs/promises"
import { Hash } from "./hash"
import { LockFs } from "./lock-fs"
import { Effect } from "effect"

export type FlockGlobal = {
  state: string
}

export namespace Flock {
  let global: FlockGlobal | undefined

  export function setGlobal(g: FlockGlobal) {
    global = g
  }

  const root = () => {
    if (!global) throw new Error("Flock global not set")
    return path.join(global.state, "locks")
  }

  // Defaults for callers that do not provide timing options.
  const defaultOpts = {
    staleMs: 60_000,
    timeoutMs: 5 * 60_000,
    baseDelayMs: 100,
    maxDelayMs: 2_000,
  }

  export interface WaitEvent {
    key: string
    attempt: number
    delay: number
    waited: number
  }

  export type Wait = (input: WaitEvent) => void | Promise<void>

  export interface Options {
    dir?: string
    signal?: AbortSignal
    staleMs?: number
    timeoutMs?: number
    baseDelayMs?: number
    maxDelayMs?: number
    onWait?: Wait
  }

  type Opts = {
    staleMs: number
    timeoutMs: number
    baseDelayMs: number
    maxDelayMs: number
  }

  type Owned = {
    acquired: true
    startHeartbeat: (intervalMs?: number) => void
    release: () => Promise<void>
  }

  export interface Lease {
    release: () => Promise<void>
    [Symbol.asyncDispose]: () => Promise<void>
  }

  function code(err: unknown) {
    if (typeof err !== "object" || err === null || !("code" in err)) return
    const value = err.code
    if (typeof value !== "string") return
    return value
  }

  function sleep(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error("Aborted"))
        return
      }

      let timer: NodeJS.Timeout | undefined

      const done = () => {
        signal?.removeEventListener("abort", abort)
        resolve()
      }

      const abort = () => {
        if (timer) {
          clearTimeout(timer)
        }
        signal?.removeEventListener("abort", abort)
        reject(signal?.reason ?? new Error("Aborted"))
      }

      signal?.addEventListener("abort", abort, { once: true })
      timer = setTimeout(done, ms)
    })
  }

  function jitter(ms: number) {
    const j = Math.floor(ms * 0.3)
    const d = Math.floor(Math.random() * (2 * j + 1)) - j
    return Math.max(0, ms + d)
  }

  function mono() {
    return performance.now()
  }

  function wall() {
    return performance.timeOrigin + mono()
  }

  // Runs one file operation, retrying an error that clears by itself (LockFs.isTransient) for a short window, with the
  // same delays as effect-flock.ts.
  async function retryTransient<T>(run: () => Promise<T>) {
    const start = mono()
    let delay = LockFs.TRANSIENT_BASE_DELAY_MS
    while (true) {
      try {
        return await run()
      } catch (err) {
        if (!LockFs.isTransient(err) || mono() - start >= LockFs.TRANSIENT_WINDOW_MS) throw err
        await sleep(delay)
        delay = LockFs.nextDelay(delay)
      }
    }
  }

  /**
   * Recursive delete. A path that is already gone counts as removed, and an error that clears by itself is retried for
   * a short window. Any other error, or one that does not clear, is thrown: a lock dir left behind makes every other
   * process wait until it turns stale.
   */
  async function removeDir(target: string) {
    try {
      await retryTransient(() => fs.rm(target, { recursive: true, force: true }))
    } catch (err) {
      if (!LockFs.isGone(err)) throw err
    }
  }

  /**
   * Atomic mkdir — returns true if created, false if it already exists. An error that clears by itself is retried for
   * a short window; any other error, or one that does not clear, is thrown.
   */
  async function exclusiveMkdir(dir: string) {
    try {
      await retryTransient(() => fs.mkdir(dir, { mode: 0o700 }))
      return true
    } catch (err) {
      if (LockFs.isExists(err)) return false
      throw err
    }
  }

  /** Write with exclusive create — throws an error naming the lock dir and the failure if it fails. */
  async function exclusiveWrite(file: string, content: string, lockDir: string, name: string) {
    try {
      await fs.writeFile(file, content, { flag: "wx" })
    } catch (cause) {
      const removal = await removeDir(lockDir).then(
        () => undefined,
        (error: unknown) => ({ error }),
      )
      throw new Error(LockFs.compromised(lockDir, LockFs.writeFailed(name, cause, removal)), { cause })
    }
  }

  async function stats(file: string) {
    try {
      return await fs.stat(file)
    } catch (err) {
      const errCode = code(err)
      if (errCode === "ENOENT" || errCode === "ENOTDIR") return
      throw err
    }
  }

  async function stale(lockDir: string, heartbeatPath: string, metaPath: string, staleMs: number) {
    // Stale detection allows automatic recovery after crashed owners.
    const now = wall()
    const heartbeat = await stats(heartbeatPath)
    if (heartbeat) {
      return now - heartbeat.mtimeMs > staleMs
    }

    const meta = await stats(metaPath)
    if (meta) {
      return now - meta.mtimeMs > staleMs
    }

    const dir = await stats(lockDir)
    if (!dir) {
      return false
    }

    return now - dir.mtimeMs > staleMs
  }

  async function tryAcquireLockDir(lockDir: string, opts: Opts): Promise<Owned | { acquired: false }> {
    const token = randomUUID?.() ?? randomBytes(16).toString("hex")
    const metaPath = path.join(lockDir, "meta.json")
    const heartbeatPath = path.join(lockDir, "heartbeat")

    if (!(await exclusiveMkdir(lockDir))) {
      if (!(await stale(lockDir, heartbeatPath, metaPath, opts.staleMs))) {
        return { acquired: false }
      }

      const breakerPath = lockDir + ".breaker"
      let claimed: boolean
      try {
        claimed = await exclusiveMkdir(breakerPath)
      } catch (claimErr) {
        if (LockFs.isGone(claimErr)) return { acquired: false }
        throw claimErr
      }

      if (!claimed) {
        const breaker = await stats(breakerPath)
        if (breaker && wall() - breaker.mtimeMs > opts.staleMs) {
          await removeDir(breakerPath)
        }
        return { acquired: false }
      }

      try {
        // Breaker ownership ensures only one contender performs stale cleanup.
        if (!(await stale(lockDir, heartbeatPath, metaPath, opts.staleMs))) {
          return { acquired: false }
        }

        await removeDir(lockDir)

        if (!(await exclusiveMkdir(lockDir))) {
          return { acquired: false }
        }
      } finally {
        await removeDir(breakerPath)
      }
    }

    const meta = {
      token,
      pid: process.pid,
      hostname: os.hostname(),
      createdAt: new Date().toISOString(),
    }

    await exclusiveWrite(heartbeatPath, "", lockDir, "heartbeat")
    await exclusiveWrite(metaPath, JSON.stringify(meta, null, 2), lockDir, "meta.json")

    let timer: NodeJS.Timeout | undefined

    const startHeartbeat = (intervalMs = Math.max(100, Math.floor(opts.staleMs / 3))) => {
      if (timer) return
      // Heartbeat prevents long critical sections from being evicted as stale.
      timer = setInterval(() => {
        const t = new Date()
        void fs.utimes(heartbeatPath, t, t).catch(() => undefined)
      }, intervalMs)
      timer.unref?.()
    }

    const release = async () => {
      if (timer) {
        clearInterval(timer)
        timer = undefined
      }

      const current = await fs
        .readFile(metaPath, "utf8")
        .then((raw) => {
          const parsed = JSON.parse(raw)
          if (!parsed || typeof parsed !== "object") return {}
          return {
            token: "token" in parsed && typeof parsed.token === "string" ? parsed.token : undefined,
          }
        })
        .catch((err) => {
          const errCode = code(err)
          if (errCode === "ENOENT" || errCode === "ENOTDIR") {
            throw new Error("Refusing to release: lock is compromised (metadata missing).")
          }
          if (err instanceof SyntaxError) {
            throw new Error("Refusing to release: lock is compromised (metadata invalid).")
          }
          throw err
        })
      // Token check prevents deleting a lock that was re-acquired by another process.
      if (current.token !== token) {
        throw new Error("Refusing to release: lock token mismatch (not the owner).")
      }

      await removeDir(lockDir).catch((cause: unknown) => {
        throw new Error(LockFs.notRemoved(lockDir, cause), { cause })
      })
    }

    return {
      acquired: true,
      startHeartbeat,
      release,
    }
  }

  async function acquireLockDir(
    lockDir: string,
    input: { key: string; onWait?: Wait; signal?: AbortSignal },
    opts: Opts,
  ) {
    const stop = mono() + opts.timeoutMs
    let attempt = 0
    let waited = 0
    let delay = opts.baseDelayMs

    while (true) {
      input.signal?.throwIfAborted()

      const res = await tryAcquireLockDir(lockDir, opts)
      if (res.acquired) {
        return res
      }

      if (mono() > stop) {
        throw new Error(`Timed out waiting for lock: ${input.key}`)
      }

      attempt += 1
      const ms = jitter(delay)
      await input.onWait?.({
        key: input.key,
        attempt,
        delay: ms,
        waited,
      })
      await sleep(ms, input.signal)
      waited += ms
      delay = Math.min(opts.maxDelayMs, Math.floor(delay * 1.7))
    }
  }

  export async function acquire(key: string, input: Options = {}): Promise<Lease> {
    input.signal?.throwIfAborted()
    const cfg: Opts = {
      staleMs: input.staleMs ?? defaultOpts.staleMs,
      timeoutMs: input.timeoutMs ?? defaultOpts.timeoutMs,
      baseDelayMs: input.baseDelayMs ?? defaultOpts.baseDelayMs,
      maxDelayMs: input.maxDelayMs ?? defaultOpts.maxDelayMs,
    }
    const dir = input.dir ?? root()

    await fs.mkdir(dir, { recursive: true })
    const lockfile = path.join(dir, Hash.fast(key) + ".lock")
    const lock = await acquireLockDir(
      lockfile,
      {
        key,
        onWait: input.onWait,
        signal: input.signal,
      },
      cfg,
    )
    lock.startHeartbeat()

    const release = () => lock.release()
    return {
      release,
      [Symbol.asyncDispose]() {
        return release()
      },
    }
  }

  export async function withLock<T>(key: string, fn: () => Promise<T>, input: Options = {}) {
    await using _ = await acquire(key, input)
    input.signal?.throwIfAborted()
    return await fn()
  }

  export const effect = Effect.fn("Flock.effect")(function* (key: string, input: Options = {}) {
    return yield* Effect.acquireRelease(
      Effect.promise((signal) => Flock.acquire(key, { ...input, signal })).pipe(
        Effect.withSpan("Flock.acquire", {
          attributes: { key },
        }),
      ),
      (lock) => Effect.promise(() => lock.release()).pipe(Effect.withSpan("Flock.release")),
    ).pipe(Effect.asVoid)
  })
}
