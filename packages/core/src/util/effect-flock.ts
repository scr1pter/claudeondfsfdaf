import path from "path"
import os from "os"
import { randomUUID } from "crypto"
import { Clock, Context, Effect, Function, Layer, Option, Schedule, Schema, Semaphore } from "effect"
import type { FileSystem, Scope } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { makeGlobalNode } from "../effect/app-node"
import { Hash } from "./hash"
import { LockFs } from "./lock-fs"

export namespace EffectFlock {
  // ---------------------------------------------------------------------------
  // Errors
  // ---------------------------------------------------------------------------

  export class LockTimeoutError extends Schema.TaggedErrorClass<LockTimeoutError>()("LockTimeoutError", {
    key: Schema.String,
  }) {}

  export class LockCompromisedError extends Schema.TaggedErrorClass<LockCompromisedError>()("LockCompromisedError", {
    /** The lock dir. */
    path: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }) {
    override get message() {
      return LockFs.compromised(this.path, this.detail)
    }
  }

  class ReleaseError extends Schema.TaggedErrorClass<ReleaseError>()("ReleaseError", {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }) {
    override get message() {
      return this.detail
    }
  }

  /** Internal: signals "lock is held, retry later". Never leaks to callers. */
  class NotAcquired extends Schema.TaggedErrorClass<NotAcquired>()("NotAcquired", {}) {}

  export type LockError = LockTimeoutError | LockCompromisedError

  // ---------------------------------------------------------------------------
  // Timing (baked in — no caller ever overrides these)
  // ---------------------------------------------------------------------------

  const STALE_MS = 60_000
  const TIMEOUT_MS = 5 * 60_000
  const BASE_DELAY_MS = 100
  const MAX_DELAY_MS = 2_000
  const HEARTBEAT_MS = Math.max(100, Math.floor(STALE_MS / 3))

  const retrySchedule = Schedule.exponential(BASE_DELAY_MS, 1.7).pipe(
    Schedule.either(Schedule.spaced(MAX_DELAY_MS)),
    Schedule.jittered,
  )

  // For one file operation that failed with an error that clears by itself (LockFs.isTransient), the same delays and
  // window as flock.ts.
  const transientSchedule = Schedule.exponential(LockFs.TRANSIENT_BASE_DELAY_MS, 2).pipe(
    Schedule.either(Schedule.spaced(LockFs.TRANSIENT_MAX_DELAY_MS)),
    Schedule.while((meta) => meta.elapsed < LockFs.TRANSIENT_WINDOW_MS),
  )

  const retryTransient = <A, R>(effect: Effect.Effect<A, PlatformError, R>) =>
    effect.pipe(Effect.retry({ while: LockFs.isTransient, schedule: transientSchedule }))

  // ---------------------------------------------------------------------------
  // Lock metadata schema
  // ---------------------------------------------------------------------------

  const LockMetaJson = Schema.fromJsonString(
    Schema.Struct({
      token: Schema.String,
      pid: Schema.Number,
      hostname: Schema.String,
      createdAt: Schema.String,
    }),
  )

  const decodeMeta = Schema.decodeUnknownSync(LockMetaJson)
  const encodeMeta = Schema.encodeSync(LockMetaJson)

  // ---------------------------------------------------------------------------
  // Service
  // ---------------------------------------------------------------------------

  export interface Interface {
    readonly acquire: (key: string, dir?: string) => Effect.Effect<void, LockError, Scope.Scope>
    readonly withLock: {
      (key: string, dir?: string): <A, E, R>(body: Effect.Effect<A, E, R>) => Effect.Effect<A, E | LockError, R>
      <A, E, R>(body: Effect.Effect<A, E, R>, key: string, dir?: string): Effect.Effect<A, E | LockError, R>
    }
  }

  export class Service extends Context.Service<Service, Interface>()("EffectFlock") {}

  // ---------------------------------------------------------------------------
  // Layer
  // ---------------------------------------------------------------------------

  function wall() {
    return performance.timeOrigin + performance.now()
  }

  const mtimeMs = (info: FileSystem.File.Info) => Option.getOrElse(info.mtime, () => new Date(0)).getTime()

  // Fibers of this process queue here for a lock file before they try it, so a fiber waiting on another fiber of the
  // same process takes the lock as soon as it is released, instead of finding it held and polling with the backoff
  // above (100 ms at least). The lock file still excludes other processes. Process-wide, so every service instance
  // shares it; an entry is removed when no holder or waiter remains.
  // Fairness across processes is the trade-off: the next fiber here takes the lock right after the last one removes
  // it, while another process polls on the backoff, so a process with a steady queue for one lock can keep it from
  // another process until that process times out. Every current lock is held briefly.
  const local = new Map<string, { readonly semaphore: Semaphore.Semaphore; users: number }>()

  const holdLocal = Effect.fnUntraced(function* (lockfile: string, key: string, deadline: number) {
    const entry = local.get(lockfile) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 }
    local.set(lockfile, entry)
    entry.users++
    const leave = Effect.sync(() => {
      entry.users--
      if (entry.users === 0) local.delete(lockfile)
    })
    // The wait stays interruptible and counts against the caller's deadline; once taken, the permit is released with
    // the caller's scope.
    const remaining = Math.max(0, deadline - (yield* Clock.currentTimeMillis))
    yield* Effect.uninterruptibleMask((restore) =>
      restore(
        entry.semaphore
          .take(1)
          .pipe(
            Effect.timeoutOrElse({ duration: remaining, orElse: () => Effect.fail(new LockTimeoutError({ key })) }),
          ),
      ).pipe(
        Effect.onError(() => leave),
        Effect.andThen(Effect.addFinalizer(() => entry.semaphore.release(1).pipe(Effect.andThen(leave)))),
      ),
    )
  })

  const isPathGone = (e: PlatformError) => e.reason._tag === "NotFound" || e.reason._tag === "Unknown"

  const layer: Layer.Layer<Service, never, Global.Service | FSUtil.Service> = Layer.effect(
    Service,
    Effect.gen(function* () {
      const global = yield* Global.Service
      const fs = yield* FSUtil.Service
      const lockRoot = path.join(global.state, "locks")
      const hostname = os.hostname()
      const ensuredDirs = new Set<string>()

      // -- helpers (close over fs) --

      const safeStat = (file: string) =>
        fs.stat(file).pipe(
          Effect.catchIf(isPathGone, () => Effect.void),
          Effect.orDie,
        )

      /**
       * Recursive delete. A path that is already gone counts as removed, and an error that clears by itself is retried
       * for a short window. Any other error, or one that does not clear, fails: a lock dir left behind makes every
       * other process wait until it turns stale.
       */
      const removeDir = (target: string) =>
        retryTransient(fs.remove(target, { recursive: true, force: true })).pipe(
          Effect.catchIf(LockFs.isGone, () => Effect.void),
        )

      /**
       * Atomic mkdir — returns true if created, false if already exists. An error that clears by itself is retried for
       * a short window; any other error, or one that does not clear, fails.
       */
      const exclusiveMkdir = (dir: string) =>
        retryTransient(fs.makeDirectory(dir, { mode: 0o700 })).pipe(
          Effect.as(true),
          Effect.catchIf(LockFs.isExists, () => Effect.succeed(false)),
        )

      /** Atomic mkdir of the lock dir — dies on errors other than "already exists" (above). */
      const atomicMkdir = (dir: string) => exclusiveMkdir(dir).pipe(Effect.orDie)

      /** Write with exclusive create — compromised error, naming the lock dir and the failure, if it fails. */
      const exclusiveWrite = (filePath: string, content: string, lockDir: string, name: string) =>
        fs.writeFileString(filePath, content, { flag: "wx" }).pipe(
          Effect.catch((cause) =>
            Effect.gen(function* () {
              const removal = yield* removeDir(lockDir).pipe(
                Effect.as(undefined),
                Effect.catch((error) => Effect.succeed({ error })),
              )
              return yield* new LockCompromisedError({
                path: lockDir,
                detail: LockFs.writeFailed(name, cause, removal),
                cause,
              })
            }),
          ),
        )

      const cleanStaleBreaker = Effect.fnUntraced(function* (breakerPath: string) {
        const bs = yield* safeStat(breakerPath)
        if (bs && wall() - mtimeMs(bs) > STALE_MS) yield* removeDir(breakerPath).pipe(Effect.orDie)
        return false
      })

      const ensureDir = Effect.fnUntraced(function* (dir: string) {
        if (ensuredDirs.has(dir)) return
        yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.orDie)
        ensuredDirs.add(dir)
      })

      const isStale = Effect.fnUntraced(function* (lockDir: string, heartbeatPath: string, metaPath: string) {
        const now = wall()

        const hb = yield* safeStat(heartbeatPath)
        if (hb) return now - mtimeMs(hb) > STALE_MS

        const meta = yield* safeStat(metaPath)
        if (meta) return now - mtimeMs(meta) > STALE_MS

        const dir = yield* safeStat(lockDir)
        if (!dir) return false

        return now - mtimeMs(dir) > STALE_MS
      })

      // -- single lock attempt --

      type Handle = { token: string; metaPath: string; heartbeatPath: string; lockDir: string }

      const tryAcquireLockDir = (lockDir: string, key: string) =>
        Effect.gen(function* () {
          const token = randomUUID()
          const metaPath = path.join(lockDir, "meta.json")
          const heartbeatPath = path.join(lockDir, "heartbeat")

          // Atomic mkdir — the POSIX lock primitive
          const created = yield* atomicMkdir(lockDir)

          if (!created) {
            if (!(yield* isStale(lockDir, heartbeatPath, metaPath))) return yield* new NotAcquired()

            // Stale — race for breaker ownership
            const breakerPath = lockDir + ".breaker"

            const claimed = yield* exclusiveMkdir(breakerPath).pipe(
              Effect.flatMap((created) => (created ? Effect.succeed(true) : cleanStaleBreaker(breakerPath))),
              Effect.catchIf(LockFs.isGone, () => Effect.succeed(false)),
              Effect.orDie,
            )

            if (!claimed) return yield* new NotAcquired()

            // We own the breaker — double-check staleness, nuke, recreate
            const recreated = yield* Effect.gen(function* () {
              if (!(yield* isStale(lockDir, heartbeatPath, metaPath))) return false
              yield* removeDir(lockDir).pipe(Effect.orDie)
              return yield* atomicMkdir(lockDir)
            }).pipe(Effect.ensuring(removeDir(breakerPath).pipe(Effect.orDie)))

            if (!recreated) return yield* new NotAcquired()
          }

          // We own the lock dir — write heartbeat + meta with exclusive create
          yield* exclusiveWrite(heartbeatPath, "", lockDir, "heartbeat")

          const metaJson = encodeMeta({ token, pid: process.pid, hostname, createdAt: new Date().toISOString() })
          yield* exclusiveWrite(metaPath, metaJson, lockDir, "meta.json")

          return { token, metaPath, heartbeatPath, lockDir } satisfies Handle
        }).pipe(
          Effect.withSpan("EffectFlock.tryAcquire", {
            attributes: { key },
          }),
        )

      // -- retry wrapper (preserves Handle type) --

      const acquireHandle = (lockfile: string, key: string, deadline: number): Effect.Effect<Handle, LockError> =>
        tryAcquireLockDir(lockfile, key).pipe(
          Effect.retry({
            while: (err) => err._tag === "NotAcquired",
            schedule: retrySchedule.pipe(Schedule.while((meta) => meta.now < deadline)),
          }),
          Effect.catchTag("NotAcquired", () => Effect.fail(new LockTimeoutError({ key }))),
        )

      // -- release --

      const release = (handle: Handle) =>
        Effect.gen(function* () {
          const raw = yield* fs.readFileString(handle.metaPath).pipe(
            Effect.catch((err) => {
              if (isPathGone(err)) return Effect.die(new ReleaseError({ detail: "metadata missing" }))
              return Effect.die(err)
            }),
          )

          const parsed = yield* Effect.try({
            try: () => decodeMeta(raw),
            catch: (cause) => new ReleaseError({ detail: "metadata invalid", cause }),
          }).pipe(Effect.orDie)

          if (parsed.token !== handle.token) return yield* Effect.die(new ReleaseError({ detail: "token mismatch" }))

          yield* removeDir(handle.lockDir).pipe(
            Effect.catch((cause) =>
              Effect.die(new ReleaseError({ detail: LockFs.notRemoved(handle.lockDir, cause), cause })),
            ),
          )
        })

      // -- build service --

      const acquire = Effect.fn("EffectFlock.acquire")(function* (key: string, dir?: string) {
        const lockDir = dir ?? lockRoot
        yield* ensureDir(lockDir)

        const lockfile = path.join(lockDir, Hash.fast(key) + ".lock")
        // One deadline covers the wait behind this process's other fibers and the wait on the lock file, so a fiber
        // still fails after TIMEOUT_MS in all when another process keeps the lock.
        const deadline = (yield* Clock.currentTimeMillis) + TIMEOUT_MS

        // Released after the lock file, so the next fiber in line finds the lock free.
        yield* holdLocal(lockfile, key, deadline)

        // acquireRelease: acquire is uninterruptible, release is guaranteed
        const handle = yield* Effect.acquireRelease(acquireHandle(lockfile, key, deadline), (handle) => release(handle))

        // Heartbeat fiber — scoped, so it's interrupted before release runs
        yield* fs
          .utimes(handle.heartbeatPath, new Date(), new Date())
          .pipe(Effect.ignore, Effect.repeat(Schedule.spaced(HEARTBEAT_MS)), Effect.forkScoped)
      })

      const withLock: Interface["withLock"] = Function.dual(
        (args) => Effect.isEffect(args[0]),
        <A, E, R>(body: Effect.Effect<A, E, R>, key: string, dir?: string): Effect.Effect<A, E | LockError, R> =>
          Effect.scoped(
            Effect.gen(function* () {
              yield* acquire(key, dir)
              return yield* body
            }),
          ),
      )

      return Service.of({ acquire, withLock })
    }),
  )

  export const node = makeGlobalNode({ service: Service, layer: layer, deps: [Global.node, FSUtil.node] })
}
