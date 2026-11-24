export * as EverywherePreferences from "./everywhere-preferences"

import { constants } from "node:fs"
import { lstat, open, rename, rm } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { EverywherePreferenceWire } from "@vectordevai/core/everywhere/preferences"
import { ConfigEverywhereV1 } from "@vectordevai/core/v1/config/everywhere"
import { Context, Effect, Exit, Option, Schema, Semaphore } from "effect"
import { Config } from "./config"

// A listener can bind this only from the trusted Desktop sidecar startup, never from request or project data.
export const StatePath = Context.Reference<string | undefined>("@vector/EverywherePreferencesStatePath", {
  defaultValue: () => undefined,
})

const Stored = Schema.Struct({
  version: EverywherePreferenceWire.Version,
  revision: EverywherePreferenceWire.Revision.check(Schema.isGreaterThanOrEqualTo(1)),
  settings: ConfigEverywhereV1.Info,
}).annotate({ parseOptions: { onExcessProperty: "error" } })

// Allow the full 64-folder config, including JSON escapes in each of its 4,096-character paths.
const maxBytes = 2 * 1024 * 1024
const unavailable = { kind: "unavailable" } as const

async function read(path: string) {
  const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!entry) return { kind: "missing" } as const
  if (!entry.isFile() || entry.size > maxBytes) return unavailable

  // Check the opened identity too, for platforms without O_NOFOLLOW and replacements between the two calls.
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > maxBytes) return unavailable
    if (stat.dev !== entry.dev || stat.ino !== entry.ino) return { kind: "replaced" } as const
    const { buffer, bytesRead } = await file.read(Buffer.alloc(stat.size + 1), 0, stat.size + 1, 0)
    if (bytesRead !== stat.size) return unavailable
    const json: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead)))
    const stored = Schema.decodeUnknownOption(Stored)(json)
    if (Option.isNone(stored)) return unavailable
    return { kind: "ready", value: stored.value } as const
  } finally {
    await file.close()
  }
}

/** Only an unbound listener or absent file uses legacy user config. Failed reads keep unattended jobs off. */
export const effective = Effect.fnUntraced(function* (
  path: string | undefined,
  legacy: ConfigEverywhereV1.Info | undefined,
) {
  if (path === undefined) return legacy
  const stored = yield* readState(path)
  if (stored.kind === "missing") return legacy
  if (stored.kind === "ready") return stored.value.settings
})

async function readCurrent(path: string) {
  const first = await read(path)
  if (first.kind !== "replaced") return first
  // An atomic save replaces the inode. Read the new state before treating the file as unavailable.
  const retry = await read(path)
  return retry.kind === "replaced" ? unavailable : retry
}

const readState = (path: string) => Effect.promise(() => readCurrent(path).catch(() => unavailable))

/** Called only over the built-in sidecar's parent port. The HTTP app never exposes a write. */
export function access(path: string) {
  const writeLock = Semaphore.makeUnsafe(1)
  return (input: unknown): Effect.Effect<EverywherePreferenceWire.Result, never, Config.Service> => {
    const request = Schema.decodeUnknownOption(EverywherePreferenceWire.Request)(input)
    if (Option.isNone(request)) return Effect.succeed({ version: 1, kind: "invalid" })
    const command = request.value
    const perform = Effect.gen(function* (): Effect.fn.Return<EverywherePreferenceWire.Result, never, Config.Service> {
      const config = yield* Config.Service
      const legacy = yield* Effect.exit(config.readGlobal())
      if (Exit.isFailure(legacy)) return { version: 1, kind: "unavailable" }
      const stored = yield* readState(path)
      if (stored.kind === "unavailable") return { version: 1, kind: "unavailable" }
      const locked = Config.lockedKeys()
      const snapshot = {
        revision: stored.kind === "ready" ? stored.value.revision : 0,
        everywhere: stored.kind === "ready" ? stored.value.settings : (legacy.value.everywhere ?? {}),
        locked,
      }
      if (command.kind === "read") return { version: 1, kind: "ready", snapshot }
      if (locked.includes("everywhere")) return { version: 1, kind: "locked" }
      if (command.revision !== snapshot.revision || command.revision === Number.MAX_SAFE_INTEGER)
        return { version: 1, kind: "stale" }
      const revision = snapshot.revision + 1
      const outcome = yield* Effect.promise(() => save(path, { version: 1, revision, settings: command.settings }))
      if (outcome !== "ready") return { version: 1, kind: outcome }
      return { version: 1, kind: "ready", snapshot: { revision, everywhere: command.settings, locked } }
    })
    return command.kind === "read" ? perform : writeLock.withPermit(Effect.uninterruptible(perform))
  }
}

async function save(path: string, stored: typeof Stored.Type) {
  const contents = JSON.stringify(stored)
  if (Buffer.byteLength(contents) > maxBytes) return "invalid" as const
  const temporary = `${path}.${randomUUID()}.tmp`
  let created = false
  try {
    const file = await open(temporary, "wx", 0o600)
    created = true
    try {
      await file.writeFile(contents, "utf8")
      await file.sync()
    } finally {
      await file.close()
    }
    if (Config.lockedKeys().includes("everywhere")) return "locked" as const
    await rename(temporary, path)
    return "ready" as const
  } catch {
    return "unavailable" as const
  } finally {
    if (created) await rm(temporary, { force: true }).catch(() => undefined)
  }
}
