import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Deferred, Effect, Exit, Fiber } from "effect"
import * as PlatformError from "effect/PlatformError"
import { FileLock } from "../../src/tool/file-lock"

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

// Keys are where a path really lands, so the expected root must be too: on Windows only the native realpath expands
// 8.3 short names such as RUNNER~1 in the temp folder.
const tmp = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "vector-file-lock-")))

afterEach(() => FileLock.useProbe())

describe("FileLock.withFiles", () => {
  test("one key runs at a time and different keys run in parallel", () =>
    run(
      Effect.gen(function* () {
        const dir = tmp()
        const a = path.join(dir, "a.txt")
        const b = path.join(dir, "b.txt")
        const held = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const order: string[] = []

        const first = yield* FileLock.withFiles([a])(
          Effect.gen(function* () {
            order.push("first a")
            yield* Deferred.succeed(held, undefined)
            yield* Deferred.await(release)
            order.push("first done")
          }),
        ).pipe(Effect.forkChild)
        yield* Deferred.await(held)

        // Another key does not wait for the held one.
        yield* FileLock.withFiles([b])(Effect.sync(() => order.push("b")))
        // The same key waits until the holder is done.
        const second = yield* FileLock.withFiles([a])(Effect.sync(() => order.push("second a"))).pipe(Effect.forkChild)
        yield* Effect.sleep("20 millis")
        expect(order).toEqual(["first a", "b"])

        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(first)
        yield* Fiber.join(second)
        expect(order).toEqual(["first a", "b", "first done", "second a"])
      }),
    ))

  test("opposite-order multi-file calls never deadlock", () =>
    run(
      Effect.gen(function* () {
        const dir = tmp()
        const a = path.join(dir, "a.txt")
        const b = path.join(dir, "b.txt")
        let done = 0
        const body = Effect.gen(function* () {
          yield* Effect.sleep("5 millis")
          done++
        })
        yield* Effect.all(
          Array.from({ length: 20 }, (_, i) => FileLock.withFiles(i % 2 ? [a, b] : [b, a, b])(body)),
          { concurrency: "unbounded" },
        ).pipe(Effect.timeout("5 seconds"))
        expect(done).toBe(20)
      }),
    ))
})

describe("FileLock.key", () => {
  test("win32 folds case", () => {
    const dir = tmp()
    expect(FileLock.key(path.join(dir, "Src", "Main.TS"), "win32")).toBe(
      FileLock.key(path.join(dir, "src", "main.ts"), "win32"),
    )
    expect(FileLock.key(path.join(dir, "a.txt"), "linux")).toBe(path.join(dir, "a.txt"))
  })

  // The real probe stats the volume, so it runs on every host: a key computed as on a Mac follows whether the temp
  // volume ignores case (default APFS and NTFS do, Linux file systems do not).
  const ignoresCase = (dir: string) => {
    const file = path.join(dir, "Case.txt")
    fs.writeFileSync(file, "x")
    const other = fs.statSync(path.join(dir, "cASE.TXT"), { throwIfNoEntry: false })
    return !!other && other.ino === fs.statSync(file).ino
  }

  test("darwin folds case after probing a case-insensitive volume", () => {
    FileLock.useProbe()
    const dir = tmp()
    const ignores = ignoresCase(dir)
    expect(
      FileLock.key(path.join(dir, "cASE.TXT"), "darwin") === FileLock.key(path.join(dir, "Case.txt"), "darwin"),
    ).toBe(ignores)
  })

  test("the probe reads a volume's root by the names inside it, as a repository at a mount point is", () => {
    FileLock.useProbe()
    const dir = tmp()
    const ignores = ignoresCase(dir)
    // The highest folder above the temp folder on its volume: its own name belongs to the volume above.
    const top = (current: string): string =>
      path.dirname(current) !== current && fs.statSync(path.dirname(current)).dev === fs.statSync(dir).dev
        ? top(path.dirname(current))
        : current
    // A file that does not exist, directly in that root, so the first folder probed is the root itself.
    const file = path.join(top(dir), `Vector-Probe-${path.basename(dir)}.txt`)
    expect(FileLock.key(file, "darwin") === file.normalize("NFC").toLowerCase()).toBe(ignores)
  })

  test("the probe is injectable and runs once per volume", () => {
    const dir = tmp()
    fs.mkdirSync(path.join(dir, "Sub"))
    const probed: string[] = []
    FileLock.useProbe((found) => {
      probed.push(found)
      return true
    })
    const upper = FileLock.key(path.join(dir, "Sub", "Main.TS"), "darwin")
    expect(upper).toBe(path.join(dir, "Sub", "Main.TS").normalize("NFC").toLowerCase())
    expect(FileLock.key(path.join(dir, "sub", "main.ts"), "darwin")).toBe(upper)
    expect(FileLock.key(path.join(dir, "Other.ts"), "darwin")).toBe(path.join(dir, "other.ts").toLowerCase())
    expect(probed).toHaveLength(1)

    FileLock.useProbe(() => false)
    expect(FileLock.key(path.join(dir, "Sub", "Main.TS"), "darwin")).toBe(path.join(dir, "Sub", "Main.TS"))
  })
})

describe("FileLock.write", () => {
  const held = (file: string, code: "EBUSY" | "EPERM") =>
    PlatformError.systemError({
      _tag: code === "EBUSY" ? "Busy" : "Unknown",
      module: "FileSystem",
      method: "writeFile",
      pathOrDescriptor: file,
      cause: Object.assign(new Error(code), { code }),
    })

  const fake = (o: { failures: number; code?: "EBUSY" | "EPERM"; mode?: number }) => {
    const calls = { write: 0, stat: 0 }
    const io = {
      writeWithDirs: (file: string, content: string | Uint8Array) =>
        Effect.suspend(() => {
          calls.write++
          if (calls.write <= o.failures) return Effect.fail(held(file, o.code ?? "EBUSY"))
          return Effect.sync(() => fs.writeFileSync(file, content))
        }),
      stat: () =>
        Effect.sync(() => {
          calls.stat++
          return { mode: o.mode ?? 0o100644 } as never
        }),
    }
    return { io, calls }
  }

  test("simulated EBUSY twice then success", () =>
    run(
      Effect.gen(function* () {
        const file = path.join(tmp(), "busy.txt")
        fs.writeFileSync(file, "before")
        const { io, calls } = fake({ failures: 2 })
        const start = Date.now()
        yield* FileLock.write(io, file, "after", "win32")
        expect(calls.write).toBe(3)
        expect(Date.now() - start).toBeGreaterThanOrEqual(140)
        expect(fs.readFileSync(file, "utf8")).toBe("after")
      }),
    ))

  test("a read-only file is not retried", () =>
    run(
      Effect.gen(function* () {
        const file = path.join(tmp(), "readonly.txt")
        fs.writeFileSync(file, "before")
        const { io, calls } = fake({ failures: 10, code: "EPERM", mode: 0o100444 })
        const exit = yield* FileLock.write(io, file, "after", "win32").pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(calls.write).toBe(1)
        expect(String(Exit.isFailure(exit) && exit.cause)).not.toContain("in use by another program")
        expect(fs.readFileSync(file, "utf8")).toBe("before")
      }),
    ))

  test(
    "after the retries the write fails and the file is unchanged",
    () =>
      run(
        Effect.gen(function* () {
          const file = path.join(tmp(), "held.txt")
          fs.writeFileSync(file, "before")
          const { io, calls } = fake({ failures: 100 })
          const error = yield* FileLock.write(io, file, "after", "win32").pipe(Effect.flip)
          expect(calls.write).toBe(FileLock.RETRY.length + 1)
          expect(error.message).toBe(
            `${file} is in use by another program on Windows (an editor, antivirus or a running build); nothing was changed`,
          )
          expect(fs.readFileSync(file, "utf8")).toBe("before")
        }),
      ),
    10_000,
  )

  test("other platforms write once and never retry", () =>
    run(
      Effect.gen(function* () {
        const file = path.join(tmp(), "linux.txt")
        const { io, calls } = fake({ failures: 1 })
        const exit = yield* FileLock.write(io, file, "after", "linux").pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(calls.write).toBe(1)
      }),
    ))
})
