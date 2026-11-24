export * as EverywherePreferences from "./everywhere-preferences"

import { constants } from "node:fs"
import { lstat, open } from "node:fs/promises"
import { ConfigEverywhereV1 } from "@vectordevai/core/v1/config/everywhere"
import { Context, Effect, Option, Schema } from "effect"

// A listener can bind this only from the trusted Desktop sidecar startup, never from request or project data.
export const StatePath = Context.Reference<string | undefined>("@vector/EverywherePreferencesStatePath", {
  defaultValue: () => undefined,
})

const Stored = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
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
    if (!stat.isFile() || stat.dev !== entry.dev || stat.ino !== entry.ino || stat.size > maxBytes) return unavailable
    const { buffer, bytesRead } = await file.read(Buffer.alloc(stat.size + 1), 0, stat.size + 1, 0)
    if (bytesRead !== stat.size) return unavailable
    const json: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead)))
    const stored = Schema.decodeUnknownOption(Stored)(json)
    if (Option.isNone(stored)) return unavailable
    return { kind: "ready", settings: stored.value.settings } as const
  } finally {
    await file.close()
  }
}

/** Only an unbound listener or absent file uses legacy user config. Failed reads keep unattended jobs off. */
export const effective = Effect.fnUntraced(function* (path: string | undefined, legacy: ConfigEverywhereV1.Info | undefined) {
  if (path === undefined) return legacy
  const stored = yield* Effect.promise(() => read(path).catch(() => unavailable))
  if (stored.kind === "missing") return legacy
  if (stored.kind === "ready") return stored.settings
})
