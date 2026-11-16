import { describe, expect } from "bun:test"
import { spawn } from "child_process"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { Cause, Clock, Effect, Exit, Fiber, Layer, Scope } from "effect"
import * as PlatformError from "effect/PlatformError"
import { TestClock } from "effect/testing"
import { testEffect } from "../lib/effect"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { EffectFlock } from "@vectordevai/core/util/effect-flock"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Global } from "@vectordevai/core/global"
import { Hash } from "@vectordevai/core/util/hash"

function lock(dir: string, key: string) {
  return path.join(dir, Hash.fast(key) + ".lock")
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function exists(file: string) {
  return fs
    .stat(file)
    .then(() => true)
    .catch(() => false)
}

async function readJson<T>(p: string): Promise<T> {
  return JSON.parse(await fs.readFile(p, "utf8"))
}

// ---------------------------------------------------------------------------
// Worker subprocess helpers
// ---------------------------------------------------------------------------

type Msg = {
  key: string
  dir: string
  holdMs?: number
  ready?: string
  active?: string
  done?: string
}

const root = path.join(import.meta.dir, "../..")
const worker = path.join(import.meta.dir, "../fixture/effect-flock-worker.ts")

function run(msg: Msg) {
  return new Promise<{ code: number; signal: NodeJS.Signals | null; stdout: Buffer; stderr: Buffer }>((resolve) => {
    const proc = spawn(process.execPath, [worker, JSON.stringify(msg)], { cwd: root })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    proc.stdout?.on("data", (data) => stdout.push(Buffer.from(data)))
    proc.stderr?.on("data", (data) => stderr.push(Buffer.from(data)))
    proc.on("close", (code, signal) => {
      resolve({ code: code ?? 1, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) })
    })
  })
}

function spawnWorker(msg: Msg) {
  return spawn(process.execPath, [worker, JSON.stringify(msg)], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  })
}

async function stopWorker(proc: ReturnType<typeof spawnWorker>) {
  if (proc.exitCode !== null || proc.signalCode !== null) return

  const closed = new Promise<void>((resolve) => proc.once("close", () => resolve()))

  if (process.platform !== "win32" || !proc.pid) {
    proc.kill()
    await closed
    return
  }

  await new Promise<void>((resolve) => {
    const killProc = spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"])
    killProc.on("close", () => {
      proc.kill()
      resolve()
    })
  })
  await closed
}

async function waitForFile(file: string, timeout = 3_000) {
  const stop = Date.now() + timeout
  while (Date.now() < stop) {
    if (await exists(file)) return
    await sleep(20)
  }
  throw new Error(`Timed out waiting for file: ${file}`)
}

// ---------------------------------------------------------------------------
// Test layer
// ---------------------------------------------------------------------------

const testGlobal = Global.layerWith({
  home: os.homedir(),
  data: os.tmpdir(),
  cache: os.tmpdir(),
  config: os.tmpdir(),
  state: os.tmpdir(),
  bin: os.tmpdir(),
  log: os.tmpdir(),
})

const testLayer = AppNodeBuilder.build(EffectFlock.node, [[Global.node, testGlobal]])

// ---------------------------------------------------------------------------
// File system faults
// ---------------------------------------------------------------------------

type FaultMethod = "makeDirectory" | "remove" | "writeFileString"

type Fault = {
  readonly method: FaultMethod
  readonly path: string
  readonly code: string
  /** How many calls fail. */
  readonly times: number
  /** How many calls failed. */
  hits: number
}

function fault(method: FaultMethod, file: string, code: string, times = Infinity): Fault {
  return { method, path: file, code, times, hits: 0 }
}

// The reason Effect's Node file system gives each code (handleErrnoException in @effect/platform-node-shared). EPERM,
// ENOTEMPTY and every other code become Unknown.
const reasons: Record<string, PlatformError.SystemErrorTag> = {
  ENOENT: "NotFound",
  EACCES: "PermissionDenied",
  EEXIST: "AlreadyExists",
  EBUSY: "Busy",
}

function injected(fault: Fault) {
  return PlatformError.systemError({
    _tag: reasons[fault.code] ?? "Unknown",
    module: "FileSystem",
    method: fault.method,
    pathOrDescriptor: fault.path,
    cause: Object.assign(new Error(`${fault.code}: injected, ${fault.method} '${fault.path}'`), { code: fault.code }),
  })
}

/** EffectFlock over the real file system, except that each fault fails its method on its path. */
function faultyLayer(...faults: Fault[]) {
  const filesystem = Layer.effect(
    FSUtil.Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const take = (method: FaultMethod, file: string) => {
        const found = faults.find((item) => item.method === method && item.path === file && item.hits < item.times)
        if (!found) return undefined
        found.hits++
        return injected(found)
      }
      return FSUtil.Service.of({
        ...fs,
        // Suspended, so that each run of the effect, a retry included, is one call.
        makeDirectory: (file, options) =>
          Effect.suspend(() => {
            const err = take("makeDirectory", file)
            return err ? Effect.fail(err) : fs.makeDirectory(file, options)
          }),
        remove: (file, options) =>
          Effect.suspend(() => {
            const err = take("remove", file)
            return err ? Effect.fail(err) : fs.remove(file, options)
          }),
        writeFileString: (file, data, options) =>
          Effect.suspend(() => {
            const err = take("writeFileString", file)
            return err ? Effect.fail(err) : fs.writeFileString(file, data, options)
          }),
      })
    }),
  ).pipe(Layer.provide(AppNodeBuilder.build(FSUtil.node)))
  return Layer.fresh(
    AppNodeBuilder.build(EffectFlock.node, [
      [Global.node, testGlobal],
      [FSUtil.node, filesystem],
    ]),
  )
}

/** Runs one withLock in a fresh temp dir over the faulty file system, and reports how it ended and how long it took. */
function withFaults(
  key: string,
  faults: (paths: { dir: string; lockDir: string }) => Fault[],
  setup?: (paths: { dir: string; lockDir: string }) => Promise<void>,
) {
  return Effect.gen(function* () {
    const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-fault-")))
    const dir = path.join(tmp, "locks")
    const lockDir = lock(dir, key)
    const list = faults({ dir, lockDir })
    if (setup) yield* Effect.promise(() => setup({ dir, lockDir }))
    let hit = false
    const start = Date.now()
    const exit = yield* Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      yield* flock.withLock(
        Effect.sync(() => {
          hit = true
        }),
        key,
        dir,
      )
    }).pipe(Effect.provide(faultyLayer(...list)), Effect.exit)
    const elapsed = Date.now() - start
    const lockDirLeft = yield* Effect.promise(() => exists(lockDir))
    const breakerLeft = yield* Effect.promise(() => exists(lockDir + ".breaker"))
    yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    return {
      exit,
      hit,
      elapsed,
      lockDir,
      lockDirLeft,
      breakerLeft,
      faults: list,
      text: Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "",
    }
  })
}

async function makeStale(lockDir: string) {
  await fs.mkdir(lockDir, { recursive: true })
  const old = new Date(Date.now() - 120_000)
  await fs.utimes(lockDir, old, old)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("util.effect-flock", () => {
  const it = testEffect(testLayer)

  it.live(
    "acquire and release via scoped Effect",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")
      const lockDir = lock(dir, "eflock:acquire")

      yield* Effect.scoped(flock.acquire("eflock:acquire", dir))

      expect(yield* Effect.promise(() => exists(lockDir))).toBe(false)
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  it.live(
    "withLock data-first",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")

      let hit = false
      yield* flock.withLock(
        Effect.sync(() => {
          hit = true
        }),
        "eflock:df",
        dir,
      )
      expect(hit).toBe(true)
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  it.live(
    "withLock pipeable",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")

      let hit = false
      yield* Effect.sync(() => {
        hit = true
      }).pipe(flock.withLock("eflock:pipe", dir))
      expect(hit).toBe(true)
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  it.effect(
    "a fiber of the same process takes a released lock at once instead of polling for it",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")
      const key = "eflock:local"
      const order: string[] = []

      const first = yield* Scope.make()
      yield* flock.acquire(key, dir).pipe(Scope.provide(first))
      const second = yield* flock
        .withLock(
          Effect.sync(() => order.push("second")),
          key,
          dir,
        )
        .pipe(Effect.forkChild)
      // Real time, so the second fiber reaches the held lock before it is released.
      yield* Effect.promise(() => sleep(50))
      order.push("released")
      yield* Scope.close(first, Exit.void)

      // The test clock never moves, so a fiber retrying on the backoff schedule would never try the lock again.
      const joined = yield* Fiber.join(second).pipe(
        Effect.as(true),
        Effect.raceFirst(Effect.promise(() => sleep(2_000)).pipe(Effect.as(false))),
      )
      expect(joined).toBe(true)
      expect(order).toEqual(["released", "second"])
      expect(yield* Effect.promise(() => exists(lock(dir, key)))).toBe(false)
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  it.effect(
    "a fiber interrupted while it waits in the same process leaves the lock to the next one",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")
      const key = "eflock:local-interrupt"

      const first = yield* Scope.make()
      yield* flock.acquire(key, dir).pipe(Scope.provide(first))
      const waiting = yield* flock.withLock(Effect.void, key, dir).pipe(Effect.forkChild)
      yield* Effect.promise(() => sleep(50))
      yield* Fiber.interrupt(waiting)
      yield* Scope.close(first, Exit.void)

      const joined = yield* flock
        .withLock(Effect.void, key, dir)
        .pipe(Effect.as(true), Effect.raceFirst(Effect.promise(() => sleep(2_000)).pipe(Effect.as(false))))
      expect(joined).toBe(true)
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  it.effect(
    "a fiber queued behind another fiber of the same process times out on one five-minute deadline",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")
      const key = "eflock:local-deadline"
      const held = lock(dir, key)
      // Another process holds the lock file, with a fresh heartbeat for the whole test.
      yield* Effect.promise(async () => {
        await fs.mkdir(held, { recursive: true })
        await fs.writeFile(path.join(held, "heartbeat"), "")
        await fs.writeFile(path.join(held, "meta.json"), "{}")
      })
      const finished: Array<{ name: string; at: number; exit: Exit.Exit<void, EffectFlock.LockError> }> = []
      const wait = (name: string) =>
        flock.withLock(Effect.void, key, dir).pipe(
          Effect.exit,
          Effect.flatMap((exit) =>
            Clock.currentTimeMillis.pipe(Effect.map((at) => void finished.push({ name, at, exit }))),
          ),
          Effect.forkChild,
        )
      // The test clock moves in steps, with real time between them for the lock attempts' file system calls.
      const advance = (minutes: number, until: () => boolean) =>
        Effect.gen(function* () {
          for (let second = 0; second < minutes * 60 && !until(); second++) {
            yield* TestClock.adjust("1 second")
            yield* Effect.promise(() => sleep(2))
          }
        })

      // The first fiber holds this process's place in line while it waits for the other process.
      yield* wait("first")
      yield* Effect.promise(() => sleep(50))
      yield* advance(1, () => false)
      const queued = yield* Clock.currentTimeMillis
      yield* wait("second")
      yield* Effect.promise(() => sleep(50))
      yield* advance(12, () => finished.length === 2)

      expect(finished.map((entry) => entry.name)).toEqual(["first", "second"])
      for (const entry of finished) {
        expect(Exit.isFailure(entry.exit) ? Cause.pretty(entry.exit.cause) : "").toContain("LockTimeoutError")
      }
      // Before, the second fiber waited five minutes in line and then five more on the lock file.
      const waited = finished[1].at - queued
      expect(waited).toBeGreaterThanOrEqual(5 * 60_000 - 1_000)
      expect(waited).toBeLessThanOrEqual(5 * 60_000 + 10_000)
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
    30_000,
  )

  it.live(
    "writes owner metadata",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")
      const key = "eflock:meta"
      const file = path.join(lock(dir, key), "meta.json")

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* flock.acquire(key, dir)
          const json = yield* Effect.promise(() =>
            readJson<{ token?: unknown; pid?: unknown; hostname?: unknown; createdAt?: unknown }>(file),
          )
          expect(typeof json.token).toBe("string")
          expect(typeof json.pid).toBe("number")
          expect(typeof json.hostname).toBe("string")
          expect(typeof json.createdAt).toBe("string")
        }),
      )
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  it.live(
    "breaks stale lock dirs",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")
      const key = "eflock:stale"
      const lockDir = lock(dir, key)

      yield* Effect.promise(async () => {
        await fs.mkdir(lockDir, { recursive: true })
        const old = new Date(Date.now() - 120_000)
        await fs.utimes(lockDir, old, old)
      })

      let hit = false
      yield* flock.withLock(
        Effect.sync(() => {
          hit = true
        }),
        key,
        dir,
      )
      expect(hit).toBe(true)
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  it.live(
    "recovers from stale breaker",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")
      const key = "eflock:stale-breaker"
      const lockDir = lock(dir, key)
      const breaker = lockDir + ".breaker"

      yield* Effect.promise(async () => {
        await fs.mkdir(lockDir, { recursive: true })
        await fs.mkdir(breaker)
        const old = new Date(Date.now() - 120_000)
        await fs.utimes(lockDir, old, old)
        await fs.utimes(breaker, old, old)
      })

      let hit = false
      yield* flock.withLock(
        Effect.sync(() => {
          hit = true
        }),
        key,
        dir,
      )
      expect(hit).toBe(true)
      expect(yield* Effect.promise(() => exists(breaker))).toBe(false)
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  it.live(
    "detects compromise when lock dir removed",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")
      const key = "eflock:compromised"
      const lockDir = lock(dir, key)

      const result = yield* flock
        .withLock(
          Effect.promise(() => fs.rm(lockDir, { recursive: true, force: true })),
          key,
          dir,
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(result)).toBe(true)
      expect(Exit.isFailure(result) ? Cause.pretty(result.cause) : "").toContain("missing")
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  it.live(
    "detects token mismatch",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")
      const key = "eflock:token"
      const lockDir = lock(dir, key)
      const meta = path.join(lockDir, "meta.json")

      const result = yield* flock
        .withLock(
          Effect.promise(async () => {
            const json = await readJson<{ token?: string }>(meta)
            json.token = "tampered"
            await fs.writeFile(meta, JSON.stringify(json, null, 2))
          }),
          key,
          dir,
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(result)).toBe(true)
      expect(Exit.isFailure(result) ? Cause.pretty(result.cause) : "").toContain("token mismatch")
      expect(yield* Effect.promise(() => exists(lockDir))).toBe(true)
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  it.live(
    "fails on unwritable lock roots",
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")

      yield* Effect.promise(async () => {
        await fs.mkdir(dir, { recursive: true })
        await fs.chmod(dir, 0o500)
      })

      const result = yield* flock.withLock(Effect.void, "eflock:perm", dir).pipe(Effect.exit)
      // oxlint-disable-next-line no-base-to-string -- Exit has a useful toString for test assertions
      expect(String(result)).toContain("PermissionDenied")
      yield* Effect.promise(() => fs.chmod(dir, 0o700).then(() => fs.rm(tmp, { recursive: true, force: true })))
    }),
  )

  // The errors Windows gives a path whose delete is still pending (EPERM), a file another process holds open (EBUSY)
  // and a directory that is still being emptied (ENOTEMPTY) are injected, so these run on every platform. flock.test.ts
  // has the same cases for Flock.
  describe("file system errors", () => {
    for (const code of ["EPERM", "EBUSY"]) {
      it.live(
        `retries a transient ${code} from mkdir of the lock dir`,
        Effect.gen(function* () {
          const result = yield* withFaults(`eflock:mkdir-${code}`, ({ lockDir }) => [
            fault("makeDirectory", lockDir, code, 1),
          ])
          expect(result.text).toBe("")
          expect(result.hit).toBe(true)
          expect(result.faults[0].hits).toBe(1)
          expect(result.lockDirLeft).toBe(false)
        }),
      )
    }

    it.live(
      "reports an EPERM from mkdir of the lock dir that does not clear, well before the lock timeout",
      Effect.gen(function* () {
        const result = yield* withFaults("eflock:mkdir-stuck", ({ lockDir }) => [
          fault("makeDirectory", lockDir, "EPERM"),
        ])
        expect(Exit.isFailure(result.exit)).toBe(true)
        expect(result.hit).toBe(false)
        expect(result.text).toContain("EPERM")
        expect(result.text).toContain(result.lockDir)
        expect(result.faults[0].hits).toBeGreaterThan(2)
        expect(result.elapsed).toBeLessThan(10_000)
      }),
      30_000,
    )

    it.live(
      "reports an EACCES from mkdir of the lock dir at once",
      Effect.gen(function* () {
        const result = yield* withFaults("eflock:mkdir-denied", ({ lockDir }) => [
          fault("makeDirectory", lockDir, "EACCES"),
        ])
        expect(result.text).toContain("PermissionDenied")
        expect(result.hit).toBe(false)
        expect(result.faults[0].hits).toBe(1)
      }),
    )

    for (const code of ["EBUSY", "EPERM", "ENOTEMPTY"]) {
      it.live(
        `retries a transient ${code} when release deletes the lock dir`,
        Effect.gen(function* () {
          const result = yield* withFaults(`eflock:release-${code}`, ({ lockDir }) => [
            fault("remove", lockDir, code, 1),
          ])
          expect(result.text).toBe("")
          expect(result.hit).toBe(true)
          expect(result.faults[0].hits).toBe(1)
          expect(result.lockDirLeft).toBe(false)
        }),
      )
    }

    it.live(
      "reports a release that cannot delete the lock dir instead of leaving it behind silently",
      Effect.gen(function* () {
        const result = yield* withFaults("eflock:release-stuck", ({ lockDir }) => [fault("remove", lockDir, "EPERM")])
        expect(result.hit).toBe(true)
        expect(result.text).toContain(`Lock dir ${result.lockDir} could not be removed on release`)
        expect(result.text).toContain("EPERM")
        expect(result.faults[0].hits).toBeGreaterThan(2)
        expect(result.lockDirLeft).toBe(true)
        expect(result.elapsed).toBeLessThan(10_000)
      }),
      30_000,
    )

    it.live(
      "treats a lock dir that is already gone on release as removed",
      Effect.gen(function* () {
        const result = yield* withFaults("eflock:release-gone", ({ lockDir }) => [
          fault("remove", lockDir, "ENOENT", 1),
        ])
        expect(result.text).toBe("")
        expect(result.hit).toBe(true)
        expect(result.faults[0].hits).toBe(1)
      }),
    )

    it.live(
      "retries a transient error deleting a stale lock dir",
      Effect.gen(function* () {
        const result = yield* withFaults(
          "eflock:stale-busy",
          ({ lockDir }) => [fault("remove", lockDir, "EBUSY", 1)],
          ({ lockDir }) => makeStale(lockDir),
        )
        expect(result.text).toBe("")
        expect(result.hit).toBe(true)
        expect(result.faults[0].hits).toBe(1)
        expect(result.breakerLeft).toBe(false)
      }),
    )

    it.live(
      "reports a stale lock dir it cannot delete instead of waiting for the lock timeout",
      Effect.gen(function* () {
        const result = yield* withFaults(
          "eflock:stale-denied",
          ({ lockDir }) => [fault("remove", lockDir, "EACCES")],
          ({ lockDir }) => makeStale(lockDir),
        )
        expect(result.hit).toBe(false)
        expect(result.text).toContain("PermissionDenied")
        expect(result.text).toContain(result.lockDir)
        expect(result.breakerLeft).toBe(false)
        expect(result.elapsed).toBeLessThan(10_000)
      }),
      30_000,
    )

    it.live(
      "reports a stale breaker it cannot delete instead of waiting for the lock timeout",
      Effect.gen(function* () {
        const result = yield* withFaults(
          "eflock:breaker-denied",
          ({ lockDir }) => [fault("remove", lockDir + ".breaker", "EACCES")],
          async ({ lockDir }) => {
            await makeStale(lockDir)
            await makeStale(lockDir + ".breaker")
          },
        )
        expect(result.hit).toBe(false)
        expect(result.text).toContain("PermissionDenied")
        expect(result.text).toContain(result.lockDir + ".breaker")
        expect(result.elapsed).toBeLessThan(10_000)
      }),
      30_000,
    )

    it.live(
      "names the lock dir and the file in a compromised lock error",
      Effect.gen(function* () {
        const result = yield* withFaults("eflock:compromised-message", ({ lockDir }) => [
          fault("writeFileString", path.join(lockDir, "heartbeat"), "EEXIST", 1),
        ])
        expect(result.hit).toBe(false)
        const error = Exit.isFailure(result.exit) ? Cause.squash(result.exit.cause) : undefined
        expect(error).toBeInstanceOf(EffectFlock.LockCompromisedError)
        if (!(error instanceof EffectFlock.LockCompromisedError)) return
        expect(error.path).toBe(result.lockDir)
        expect(error.message).toBe(`Lock compromised at ${result.lockDir}: heartbeat already existed`)
        expect(result.text).toContain(error.message)
        expect(result.lockDirLeft).toBe(false)
      }),
    )

    it.live(
      "names the write error when meta.json cannot be created",
      Effect.gen(function* () {
        const result = yield* withFaults("eflock:compromised-write", ({ lockDir }) => [
          fault("writeFileString", path.join(lockDir, "meta.json"), "ENOSPC", 1),
        ])
        const error = Exit.isFailure(result.exit) ? Cause.squash(result.exit.cause) : undefined
        expect(error).toBeInstanceOf(EffectFlock.LockCompromisedError)
        if (!(error instanceof EffectFlock.LockCompromisedError)) return
        expect(error.message).toContain(`Lock compromised at ${result.lockDir}: meta.json could not be created`)
        expect(error.message).toContain("ENOSPC")
        expect(result.lockDirLeft).toBe(false)
      }),
    )

    it.live(
      "says so when the lock dir cannot be deleted after a compromise",
      Effect.gen(function* () {
        const result = yield* withFaults("eflock:compromised-left", ({ lockDir }) => [
          fault("writeFileString", path.join(lockDir, "heartbeat"), "EEXIST", 1),
          fault("remove", lockDir, "EACCES"),
        ])
        const error = Exit.isFailure(result.exit) ? Cause.squash(result.exit.cause) : undefined
        expect(error).toBeInstanceOf(EffectFlock.LockCompromisedError)
        if (!(error instanceof EffectFlock.LockCompromisedError)) return
        expect(error.message).toContain("heartbeat already existed; removing the lock dir failed")
        expect(error.message).toContain("EACCES")
        expect(result.faults[1].hits).toBe(1)
        expect(result.lockDirLeft).toBe(true)
      }),
    )

    // Real files, no injection: on Windows the delete can stay pending, or the directory stay non-empty, while another
    // handle on the heartbeat is open. Elsewhere the delete succeeds at once.
    it.live(
      "release deletes the lock dir while another handle on the heartbeat closes",
      Effect.gen(function* () {
        const flock = yield* EffectFlock.Service
        const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
        const dir = path.join(tmp, "locks")
        const key = "eflock:open-heartbeat"
        const lockDir = lock(dir, key)
        let closed: Promise<void> | undefined

        yield* flock.withLock(
          Effect.promise(async () => {
            const handle = await fs.open(path.join(lockDir, "heartbeat"), "r")
            closed = sleep(150).then(() => handle.close())
          }),
          key,
          dir,
        )
        yield* Effect.promise(() => closed ?? Promise.resolve())
        expect(yield* Effect.promise(() => exists(lockDir))).toBe(false)
        yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
      }),
    )
  })

  it.live(
    "enforces mutual exclusion under process contention",
    () =>
      Effect.promise(async () => {
        const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "eflock-stress-"))
        const dir = path.join(tmp, "locks")
        const done = path.join(tmp, "done.log")
        const active = path.join(tmp, "active")
        const n = 16

        try {
          const out = await Promise.all(
            Array.from({ length: n }, () => run({ key: "eflock:stress", dir, done, active, holdMs: 30 })),
          )
          // Read before the first expect, so that its message can say whether a failed worker finished its body. A
          // read error, a missing done.log included, is named there and thrown after the first two expects.
          const lines = await fs.readFile(done, "utf8").then(
            (text) =>
              text
                .split("\n")
                .map((x) => x.trim())
                .filter(Boolean),
            (err: NodeJS.ErrnoException) => err,
          )

          expect(
            out.map((x) => x.code),
            // Each failed worker's own report. run() reports a signal exit as code 1, so the signal is named too.
            [
              Array.isArray(lines)
                ? `${lines.length} of ${n} workers wrote done.log`
                : `done.log could not be read: ${lines.message}`,
              ...out.flatMap((x, i) =>
                x.code === 0
                  ? []
                  : [
                      `worker ${i} exited with code ${x.code}, signal ${x.signal}`,
                      `stdout: ${x.stdout.toString()}`,
                      `stderr: ${x.stderr.toString()}`,
                    ],
              ),
            ].join("\n"),
          ).toEqual(Array.from({ length: n }, () => 0))
          expect(out.map((x) => x.stderr.toString()).filter(Boolean)).toEqual([])
          if (!Array.isArray(lines)) throw lines
          expect(lines.length).toBe(n)
        } finally {
          await fs.rm(tmp, { recursive: true, force: true })
        }
      }),
    60_000,
  )

  it.live(
    "recovers after a crashed lock owner",
    () =>
      Effect.promise(async () => {
        const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "eflock-crash-"))
        const dir = path.join(tmp, "locks")
        const ready = path.join(tmp, "ready")

        const proc = spawnWorker({ key: "eflock:crash", dir, ready, holdMs: 120_000 })

        try {
          await waitForFile(ready, 5_000)
          await stopWorker(proc)

          // Backdate lock files so they're past STALE_MS (60s)
          const lockDir = lock(dir, "eflock:crash")
          const old = new Date(Date.now() - 120_000)
          await fs.utimes(lockDir, old, old).catch(() => {})
          await fs.utimes(path.join(lockDir, "heartbeat"), old, old).catch(() => {})
          await fs.utimes(path.join(lockDir, "meta.json"), old, old).catch(() => {})

          const done = path.join(tmp, "done.log")
          const result = await run({ key: "eflock:crash", dir, done, holdMs: 10 })
          expect(
            result.code,
            `worker exited with code ${result.code}, signal ${result.signal}\nstderr: ${result.stderr.toString()}`,
          ).toBe(0)
          expect(result.stderr.toString()).toBe("")
        } finally {
          await stopWorker(proc).catch(() => {})
          await fs.rm(tmp, { recursive: true, force: true })
        }
      }),
    30_000,
  )
})
