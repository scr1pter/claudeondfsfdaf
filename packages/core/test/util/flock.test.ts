import { describe, expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
import { spawn } from "child_process"
import path from "path"
import os from "os"
import { Flock } from "@vectordevai/core/util/flock"
import { Hash } from "@vectordevai/core/util/hash"

type Msg = {
  key: string
  dir: string
  staleMs?: number
  timeoutMs?: number
  baseDelayMs?: number
  maxDelayMs?: number
  holdMs?: number
  ready?: string
  active?: string
  done?: string
}

const root = path.join(import.meta.dir, "../..")
const worker = path.join(import.meta.dir, "../fixture/flock-worker.ts")

async function tmpdir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flock-test-"))
  return {
    path: dir,
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
}

function lock(dir: string, key: string) {
  return path.join(dir, Hash.fast(key) + ".lock")
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function exists(file: string) {
  return fs
    .stat(file)
    .then(() => true)
    .catch(() => false)
}

async function wait(file: string, timeout = 3_000) {
  const stop = Date.now() + timeout
  while (Date.now() < stop) {
    if (await exists(file)) return
    await sleep(20)
  }

  throw new Error(`Timed out waiting for file: ${file}`)
}

function run(msg: Msg) {
  return new Promise<{ code: number; stdout: Buffer; stderr: Buffer }>((resolve) => {
    const proc = spawn(process.execPath, [worker, JSON.stringify(msg)], {
      cwd: root,
    })

    const stdout: Buffer[] = []
    const stderr: Buffer[] = []

    proc.stdout?.on("data", (data) => stdout.push(Buffer.from(data)))
    proc.stderr?.on("data", (data) => stderr.push(Buffer.from(data)))

    proc.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      })
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

async function readJson<T>(p: string): Promise<T> {
  return JSON.parse(await fs.readFile(p, "utf8"))
}

// ---------------------------------------------------------------------------
// File system faults
// ---------------------------------------------------------------------------

type FaultMethod = "mkdir" | "rm" | "writeFile"

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

/** Until disposed, each fault fails its fs/promises method on its path, as Node reports a system error. */
function inject(...faults: Fault[]) {
  const spies = (["mkdir", "rm", "writeFile"] as const).map((method) => {
    const original = fs[method]
    const replacement = (file: unknown, ...rest: unknown[]) => {
      const found = faults.find(
        (item) => item.method === method && item.path === String(file) && item.hits < item.times,
      )
      if (!found) return Reflect.apply(original, fs, [file, ...rest])
      found.hits++
      const err = Object.assign(new Error(`${found.code}: injected, ${method} '${found.path}'`), {
        code: found.code,
        syscall: method,
        path: found.path,
      })
      return Promise.reject(err)
    }
    // One replacement stands in for three overloaded fs functions.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    return spyOn(fs, method).mockImplementation(replacement as never)
  })
  return {
    [Symbol.dispose]() {
      for (const spy of spies) spy.mockRestore()
    },
  }
}

/** Runs one withLock in a fresh temp dir with the faults injected, and reports how it ended and how long it took. */
async function withFaults(
  key: string,
  faults: (paths: { dir: string; lockDir: string }) => Fault[],
  setup?: (paths: { dir: string; lockDir: string }) => Promise<void>,
) {
  await using tmp = await tmpdir()
  const dir = path.join(tmp.path, "locks")
  const lockDir = lock(dir, key)
  const list = faults({ dir, lockDir })
  if (setup) await setup({ dir, lockDir })
  let hit = false
  const start = Date.now()
  let error: unknown
  {
    using _ = inject(...list)
    error = await Flock.withLock(
      key,
      async () => {
        hit = true
      },
      { dir, staleMs: 1_000, timeoutMs: 20_000 },
    ).then(
      () => undefined,
      (err: unknown) => err,
    )
  }
  return {
    error: error instanceof Error ? error : undefined,
    hit,
    elapsed: Date.now() - start,
    lockDir,
    lockDirLeft: await exists(lockDir),
    breakerLeft: await exists(lockDir + ".breaker"),
    faults: list,
  }
}

function errnoCode(err: unknown) {
  return typeof err === "object" && err !== null && "code" in err ? err.code : undefined
}

async function makeStale(lockDir: string) {
  await fs.mkdir(lockDir, { recursive: true })
  const old = new Date(Date.now() - 120_000)
  await fs.utimes(lockDir, old, old)
}

describe("util.flock", () => {
  test("enforces mutual exclusion under process contention", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const done = path.join(tmp.path, "done.log")
    const active = path.join(tmp.path, "active")
    const key = "flock:stress"
    const n = 16

    const out = await Promise.all(
      Array.from({ length: n }, () =>
        run({
          key,
          dir,
          done,
          active,
          holdMs: 30,
          staleMs: 1_000,
          timeoutMs: 15_000,
        }),
      ),
    )

    expect(out.map((x) => x.code)).toEqual(Array.from({ length: n }, () => 0))
    expect(out.map((x) => x.stderr.toString()).filter(Boolean)).toEqual([])

    const lines = (await fs.readFile(done, "utf8"))
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean)
    expect(lines.length).toBe(n)
  }, 20_000)

  test("times out while waiting when lock is still healthy", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:timeout"
    const ready = path.join(tmp.path, "ready")
    const proc = spawnWorker({
      key,
      dir,
      ready,
      holdMs: 20_000,
      staleMs: 10_000,
      timeoutMs: 30_000,
    })

    try {
      await wait(ready, 5_000)
      const seen: string[] = []
      const err = await Flock.withLock(key, async () => {}, {
        dir,
        staleMs: 10_000,
        timeoutMs: 1_000,
        onWait: (tick) => {
          seen.push(tick.key)
        },
      }).catch((err) => err)

      expect(err).toBeInstanceOf(Error)
      if (!(err instanceof Error)) throw err
      expect(err.message).toContain("Timed out waiting for lock")
      expect(seen.length).toBeGreaterThan(0)
      expect(seen.every((x) => x === key)).toBe(true)
    } finally {
      await stopWorker(proc).catch(() => undefined)
    }
  }, 15_000)

  test("recovers after a crashed lock owner", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:crash"
    const ready = path.join(tmp.path, "ready")
    const proc = spawnWorker({
      key,
      dir,
      ready,
      holdMs: 20_000,
      staleMs: 500,
      timeoutMs: 30_000,
    })

    await wait(ready, 5_000)
    await stopWorker(proc)

    let hit = false
    await Flock.withLock(
      key,
      async () => {
        hit = true
      },
      {
        dir,
        staleMs: 500,
        timeoutMs: 8_000,
      },
    )

    expect(hit).toBe(true)
  }, 20_000)

  test("breaks stale lock dirs when heartbeat is missing", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:missing-heartbeat"
    const lockDir = lock(dir, key)

    await fs.mkdir(lockDir, { recursive: true })
    const old = new Date(Date.now() - 2_000)
    await fs.utimes(lockDir, old, old)

    let hit = false
    await Flock.withLock(
      key,
      async () => {
        hit = true
      },
      {
        dir,
        staleMs: 200,
        timeoutMs: 3_000,
      },
    )

    expect(hit).toBe(true)
  })

  test("recovers when a stale breaker claim was left behind", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:stale-breaker"
    const lockDir = lock(dir, key)
    const breaker = lockDir + ".breaker"

    await fs.mkdir(lockDir, { recursive: true })
    await fs.mkdir(breaker)

    const old = new Date(Date.now() - 2_000)
    await fs.utimes(lockDir, old, old)
    await fs.utimes(breaker, old, old)

    let hit = false
    await Flock.withLock(
      key,
      async () => {
        hit = true
      },
      {
        dir,
        staleMs: 200,
        timeoutMs: 3_000,
      },
    )

    expect(hit).toBe(true)
    expect(await exists(breaker)).toBe(false)
  })

  test("fails clearly if lock dir is removed while held", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:compromised"
    const lockDir = lock(dir, key)

    const err = await Flock.withLock(
      key,
      async () => {
        await fs.rm(lockDir, {
          recursive: true,
          force: true,
        })
      },
      {
        dir,
        staleMs: 1_000,
        timeoutMs: 3_000,
      },
    ).catch((err) => err)

    expect(err).toBeInstanceOf(Error)
    if (!(err instanceof Error)) throw err
    expect(err.message).toContain("compromised")

    let hit = false
    await Flock.withLock(
      key,
      async () => {
        hit = true
      },
      {
        dir,
        staleMs: 200,
        timeoutMs: 3_000,
      },
    )
    expect(hit).toBe(true)
  })

  test("writes owner metadata while lock is held", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:meta"
    const file = path.join(lock(dir, key), "meta.json")

    await Flock.withLock(
      key,
      async () => {
        const json = await readJson<{
          token?: unknown
          pid?: unknown
          hostname?: unknown
          createdAt?: unknown
        }>(file)

        expect(typeof json.token).toBe("string")
        expect(typeof json.pid).toBe("number")
        expect(typeof json.hostname).toBe("string")
        expect(typeof json.createdAt).toBe("string")
      },
      {
        dir,
        staleMs: 1_000,
        timeoutMs: 3_000,
      },
    )
  })

  test("supports acquire with await using", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:acquire"
    const lockDir = lock(dir, key)

    {
      await using _ = await Flock.acquire(key, {
        dir,
        staleMs: 1_000,
        timeoutMs: 3_000,
      })
      expect(await exists(lockDir)).toBe(true)
    }

    expect(await exists(lockDir)).toBe(false)
  })

  test("refuses token mismatch release and recovers from stale", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:token"
    const lockDir = lock(dir, key)
    const meta = path.join(lockDir, "meta.json")

    const err = await Flock.withLock(
      key,
      async () => {
        const json = await readJson<{ token?: string }>(meta)
        json.token = "tampered"
        await fs.writeFile(meta, JSON.stringify(json, null, 2))
      },
      {
        dir,
        staleMs: 500,
        timeoutMs: 3_000,
      },
    ).catch((err) => err)

    expect(err).toBeInstanceOf(Error)
    if (!(err instanceof Error)) throw err
    expect(err.message).toContain("token mismatch")
    expect(await exists(lockDir)).toBe(true)

    let hit = false
    await Flock.withLock(
      key,
      async () => {
        hit = true
      },
      {
        dir,
        staleMs: 500,
        timeoutMs: 6_000,
      },
    )
    expect(hit).toBe(true)
  })

  // The errors Windows gives a path whose delete is still pending (EPERM), a file another process holds open (EBUSY)
  // and a directory that is still being emptied (ENOTEMPTY) are injected, so these run on every platform.
  // effect-flock.test.ts has the same cases for EffectFlock.
  describe("file system errors", () => {
    for (const code of ["EPERM", "EBUSY"]) {
      test(`retries a transient ${code} from mkdir of the lock dir`, async () => {
        const result = await withFaults(`flock:mkdir-${code}`, ({ lockDir }) => [fault("mkdir", lockDir, code, 1)])
        expect(result.error).toBeUndefined()
        expect(result.hit).toBe(true)
        expect(result.faults[0].hits).toBe(1)
        expect(result.lockDirLeft).toBe(false)
      })
    }

    test("reports an EPERM from mkdir of the lock dir that does not clear, well before the lock timeout", async () => {
      const result = await withFaults("flock:mkdir-stuck", ({ lockDir }) => [fault("mkdir", lockDir, "EPERM")])
      expect(errnoCode(result.error)).toBe("EPERM")
      expect(result.error?.message).toContain(result.lockDir)
      expect(result.hit).toBe(false)
      expect(result.faults[0].hits).toBeGreaterThan(2)
      expect(result.elapsed).toBeLessThan(10_000)
    }, 30_000)

    test("reports an EACCES from mkdir of the lock dir at once", async () => {
      const result = await withFaults("flock:mkdir-denied", ({ lockDir }) => [fault("mkdir", lockDir, "EACCES")])
      expect(errnoCode(result.error)).toBe("EACCES")
      expect(result.hit).toBe(false)
      expect(result.faults[0].hits).toBe(1)
    })

    for (const code of ["EBUSY", "EPERM", "ENOTEMPTY"]) {
      test(`retries a transient ${code} when release deletes the lock dir`, async () => {
        const result = await withFaults(`flock:release-${code}`, ({ lockDir }) => [fault("rm", lockDir, code, 1)])
        expect(result.error).toBeUndefined()
        expect(result.hit).toBe(true)
        expect(result.faults[0].hits).toBe(1)
        expect(result.lockDirLeft).toBe(false)
      })
    }

    test("reports a release that cannot delete the lock dir", async () => {
      const result = await withFaults("flock:release-stuck", ({ lockDir }) => [fault("rm", lockDir, "EPERM")])
      expect(result.hit).toBe(true)
      expect(result.error?.message).toContain(`Lock dir ${result.lockDir} could not be removed on release`)
      expect(result.error?.message).toContain("EPERM")
      expect(errnoCode(result.error?.cause)).toBe("EPERM")
      expect(result.faults[0].hits).toBeGreaterThan(2)
      expect(result.lockDirLeft).toBe(true)
      expect(result.elapsed).toBeLessThan(10_000)
    }, 30_000)

    test("treats a lock dir that is already gone on release as removed", async () => {
      const result = await withFaults("flock:release-gone", ({ lockDir }) => [fault("rm", lockDir, "ENOENT", 1)])
      expect(result.error).toBeUndefined()
      expect(result.hit).toBe(true)
      expect(result.faults[0].hits).toBe(1)
    })

    test("retries a transient error deleting a stale lock dir", async () => {
      const result = await withFaults(
        "flock:stale-busy",
        ({ lockDir }) => [fault("rm", lockDir, "EBUSY", 1)],
        ({ lockDir }) => makeStale(lockDir),
      )
      expect(result.error).toBeUndefined()
      expect(result.hit).toBe(true)
      expect(result.faults[0].hits).toBe(1)
      expect(result.breakerLeft).toBe(false)
    })

    test("reports a stale lock dir it cannot delete instead of waiting for the lock timeout", async () => {
      const result = await withFaults(
        "flock:stale-denied",
        ({ lockDir }) => [fault("rm", lockDir, "EACCES")],
        ({ lockDir }) => makeStale(lockDir),
      )
      expect(result.hit).toBe(false)
      expect(errnoCode(result.error)).toBe("EACCES")
      expect(result.breakerLeft).toBe(false)
      expect(result.elapsed).toBeLessThan(10_000)
    }, 30_000)

    test("reports a stale breaker it cannot delete instead of waiting for the lock timeout", async () => {
      const result = await withFaults(
        "flock:breaker-denied",
        ({ lockDir }) => [fault("rm", lockDir + ".breaker", "EACCES")],
        async ({ lockDir }) => {
          await makeStale(lockDir)
          await makeStale(lockDir + ".breaker")
        },
      )
      expect(result.hit).toBe(false)
      expect(errnoCode(result.error)).toBe("EACCES")
      expect(result.error?.message).toContain(result.lockDir + ".breaker")
      expect(result.elapsed).toBeLessThan(10_000)
    }, 30_000)

    test("names the lock dir and the file in a compromised lock error", async () => {
      const result = await withFaults("flock:compromised-message", ({ lockDir }) => [
        fault("writeFile", path.join(lockDir, "heartbeat"), "EEXIST", 1),
      ])
      expect(result.hit).toBe(false)
      expect(result.error?.message).toBe(`Lock compromised at ${result.lockDir}: heartbeat already existed`)
      expect(errnoCode(result.error?.cause)).toBe("EEXIST")
      expect(result.lockDirLeft).toBe(false)
    })

    test("names the write error when meta.json cannot be created", async () => {
      const result = await withFaults("flock:compromised-write", ({ lockDir }) => [
        fault("writeFile", path.join(lockDir, "meta.json"), "ENOSPC", 1),
      ])
      expect(result.error?.message).toContain(`Lock compromised at ${result.lockDir}: meta.json could not be created`)
      expect(result.error?.message).toContain("ENOSPC")
      expect(result.lockDirLeft).toBe(false)
    })

    test("says so when the lock dir cannot be deleted after a compromise", async () => {
      const result = await withFaults("flock:compromised-left", ({ lockDir }) => [
        fault("writeFile", path.join(lockDir, "heartbeat"), "EEXIST", 1),
        fault("rm", lockDir, "EACCES"),
      ])
      expect(result.error?.message).toContain("heartbeat already existed; removing the lock dir failed")
      expect(result.error?.message).toContain("EACCES")
      expect(result.faults[1].hits).toBe(1)
      expect(result.lockDirLeft).toBe(true)
    })

    // Real files, no injection: on Windows the delete can stay pending, or the directory stay non-empty, while another
    // handle on the heartbeat is open. Elsewhere the delete succeeds at once.
    test("release deletes the lock dir while another handle on the heartbeat closes", async () => {
      await using tmp = await tmpdir()
      const dir = path.join(tmp.path, "locks")
      const key = "flock:open-heartbeat"
      const lockDir = lock(dir, key)
      let closed: Promise<void> | undefined

      await Flock.withLock(
        key,
        async () => {
          const handle = await fs.open(path.join(lockDir, "heartbeat"), "r")
          closed = sleep(150).then(() => handle.close())
        },
        { dir, staleMs: 1_000, timeoutMs: 3_000 },
      )
      await closed
      expect(await exists(lockDir)).toBe(false)
    })
  })

  test("fails clearly on unwritable lock roots", async () => {
    if (process.platform === "win32") return

    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:perm"

    await fs.mkdir(dir, { recursive: true })
    await fs.chmod(dir, 0o500)

    try {
      const err = await Flock.withLock(key, async () => {}, {
        dir,
        staleMs: 100,
        timeoutMs: 500,
      }).catch((err) => err)

      expect(err).toBeInstanceOf(Error)
      if (!(err instanceof Error)) throw err
      const text = err.message
      expect(text.includes("EACCES") || text.includes("EPERM")).toBe(true)
    } finally {
      await fs.chmod(dir, 0o700)
    }
  })
})
