export * as FileLock from "./file-lock"

import path from "node:path"
import { lstatSync, readdirSync, statSync } from "node:fs"
import { Duration, Effect, Schema } from "effect"
import { KeyedMutex } from "@vectordevai/core/effect/keyed-mutex"
import { FSUtil } from "@vectordevai/core/fs-util"

/**
 * One lock per file for every writer in this process: edit, write, apply_patch and merges. Keys are where a path
 * really lands, with case folded on a volume that ignores it, so two spellings of one file share a lock.
 */

/** Whether the volume holding `dir`, an existing directory, ignores case. */
export type Probe = (dir: string) => boolean

const flip = (name: string) =>
  [...name].map((char) => (char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase())).join("")

const stat = (file: string) => {
  try {
    return statSync(file, { throwIfNoEntry: false })
  } catch {
    return undefined
  }
}
const lstat = (file: string) => {
  try {
    return lstatSync(file, { throwIfNoEntry: false })
  } catch {
    return undefined
  }
}
const list = (dir: string) => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** Whether a case-flipped spelling of the entry `name` in `parent` is the same entry; undefined with nothing to test. */
const flipsTo = (parent: string, name: string, volume: number | undefined) => {
  const flipped = flip(name)
  if (flipped === name) return undefined
  const self = lstat(path.join(parent, name))
  if (!self || self.dev !== volume) return undefined
  const other = lstat(path.join(parent, flipped))
  return !!other && other.dev === self.dev && other.ino === self.ino
}

/**
 * Stats the case-flipped spelling of the nearest name on the volume that has letters: the same file means the volume
 * ignores case. A folder at the volume's root has no such name (its own belongs to the volume above), so the entries
 * inside that root are tried. With nothing to flip, a Mac volume is taken to be default APFS, which ignores case.
 */
const statProbe: Probe = (dir) => {
  const volume = stat(dir)?.dev
  let current = dir
  for (;;) {
    const parent = path.dirname(current)
    const above = stat(parent)
    if (parent === current || above?.dev !== volume)
      return (
        list(current).reduce<boolean | undefined>(
          (found, name) => found ?? flipsTo(current, name, volume),
          undefined,
        ) ?? true
      )
    const found = flipsTo(parent, path.basename(current), volume)
    if (found !== undefined) return found
    current = parent
  }
}

let probe: Probe = statProbe
// What each volume (by device) was found to do: each is probed once.
const folds = new Map<number, boolean>()

/** Tests only: replaces the case probe and clears what it learned. No argument restores the real probe. */
export function useProbe(next?: Probe) {
  probe = next ?? statProbe
  folds.clear()
}

function ignoresCase(real: string) {
  let current = real
  for (;;) {
    const info = stat(current)
    if (info?.isDirectory()) {
      const known = folds.get(info.dev)
      if (known !== undefined) return known
      let result = true
      try {
        result = probe(current)
      } catch {}
      folds.set(info.dev, result)
      return result
    }
    const parent = path.dirname(current)
    if (parent === current) return true
    current = parent
  }
}

/** The lock key of a file: its real path, case-folded on Windows and on a Mac volume that ignores case. */
export function key(file: string, platform: NodeJS.Platform = process.platform) {
  let real: string
  try {
    real = FSUtil.realpath(file)
  } catch {
    real = path.resolve(file)
  }
  if (platform === "win32") return real.toLowerCase()
  if (platform === "darwin" && ignoresCase(real)) return real.normalize("NFC").toLowerCase()
  return real
}

const files = KeyedMutex.makeUnsafe<string>()
const trees = KeyedMutex.makeUnsafe<string>()

/** Runs `effect` holding every file's lock, taken in sorted key order so two callers never deadlock. */
export const withFiles =
  (paths: readonly string[]) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.suspend(() =>
      [...new Set(paths.map((file) => key(file)))]
        .sort()
        .reduceRight((inner, item) => files.withLock(item)(inner), effect),
    )

/** Runs `effect` holding one folder's lock: merges into it, and worktree changes under one git common dir. */
export const forTree =
  (root: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.suspend(() => trees.withLock(key(root))(effect))

export class InUseError extends Schema.TaggedErrorClass<InUseError>()("FileLock.InUseError", {
  file: Schema.String,
  message: Schema.String,
}) {}

/** Waits before each retry of a write Windows refused because another program holds the file. */
export const RETRY = [50, 100, 200, 400, 800] as const
const HELD = new Set(["EBUSY", "EPERM", "EACCES"])

function held(error: unknown) {
  const reason = (error as { reason?: { _tag?: string; cause?: { code?: unknown } } } | undefined)?.reason
  const code = reason?.cause?.code
  return (typeof code === "string" && HELD.has(code)) || reason?._tag === "Busy" || reason?._tag === "PermissionDenied"
}

type Writer = Pick<FSUtil.Interface, "writeWithDirs" | "stat">

/**
 * Writes the file. On Windows a file another program holds is retried a few times, unless it has the read-only
 * attribute, which no wait clears.
 */
export function write(
  fs: Writer,
  file: string,
  bytes: string | Uint8Array,
  platform: NodeJS.Platform = process.platform,
): Effect.Effect<void, FSUtil.Error | InUseError> {
  const once = fs.writeWithDirs(file, bytes)
  if (platform !== "win32") return once
  const readOnly = fs.stat(file).pipe(
    Effect.map((info) => (info.mode & 0o200) === 0),
    Effect.orElseSucceed(() => false),
  )
  const attempt = (n: number): Effect.Effect<void, FSUtil.Error | InUseError> =>
    once.pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (!held(error)) return yield* Effect.fail(error)
          if (n === 0 && (yield* readOnly)) return yield* Effect.fail(error)
          if (n >= RETRY.length)
            return yield* new InUseError({
              file,
              message: `${file} is in use by another program on Windows (an editor, antivirus or a running build); nothing was changed`,
            })
          yield* Effect.sleep(Duration.millis(RETRY[n]))
          return yield* attempt(n + 1)
        }),
      ),
    )
  return attempt(0)
}
