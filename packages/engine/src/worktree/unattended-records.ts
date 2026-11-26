export * as UnattendedRecords from "./unattended-records"

import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, link, open, rm } from "node:fs/promises"
import path from "node:path"
import { Effect, Option, Schema } from "effect"
import { EverywhereSessionWire } from "@vectordevai/core/everywhere/session-binding"
import { Global } from "@vectordevai/core/global"
import { FSUtil } from "@vectordevai/core/fs-util"
import { JOB_ID_PATTERN } from "@vectordevai/schema/everywhere"

export const folder = "everywhere-worktree-reservations"
const maxBytes = 64 * 1024

export const Reservation = Schema.Struct({
  version: Schema.Literal(1),
  jid: EverywhereSessionWire.Placement.fields.jid,
  branch: EverywhereSessionWire.Placement.fields.branch,
  base: EverywhereSessionWire.Placement.fields.base,
  project: Schema.String,
}).annotate({ parseOptions: { onExcessProperty: "error" } })

export const Placed = Schema.Struct({
  ...Reservation.fields,
  directory: EverywhereSessionWire.Placement.fields.directory,
  common: Schema.String,
  gitDirectory: Schema.String,
  directoryIdentity: Schema.String,
  gitIdentity: Schema.String,
}).annotate({ parseOptions: { onExcessProperty: "error" } })

export const Bound = Schema.Struct({
  ...Placed.fields,
  claim: EverywhereSessionWire.Request.fields.claim,
  sessionID: EverywhereSessionWire.SessionID,
}).annotate({ parseOptions: { onExcessProperty: "error" } })

const same = (a: { dev: number; ino: number }, b: { dev: number; ino: number }) => a.dev === b.dev && a.ino === b.ino
const refused = () => new Error("The unattended worktree record is unavailable.")

export const identity = (directory: string) =>
  Effect.tryPromise({
    try: async () => {
      const item = await lstat(directory, { bigint: true })
      if (!item.isDirectory() || item.ino === 0n) throw refused()
      return `${item.dev}:${item.ino}`
    },
    catch: refused,
  })

export const intact = (placed: typeof Placed.Type) =>
  Effect.gen(function* () {
    return (
      (yield* identity(placed.directory)) === placed.directoryIdentity &&
      (yield* identity(placed.gitDirectory)) === placed.gitIdentity
    )
  }).pipe(Effect.orElseSucceed(() => false))

async function root() {
  const state = FSUtil.realpath(Global.Path.state)
  const directory = path.join(state, folder)
  const parent = await lstat(state)
  const entry = await lstat(directory)
  const owner = process.getuid?.()
  if (!parent.isDirectory() || !entry.isDirectory()) throw refused()
  if (owner !== undefined && (parent.uid !== owner || parent.mode & 0o022 || entry.uid !== owner || entry.mode & 0o077))
    throw refused()
  return directory
}

async function syncDirectory(directory: string) {
  if (process.platform === "win32") return
  const handle = await open(directory, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

type RecordName = "reservation" | "placed" | "session-intent" | "session"
function name(jid: string, record: RecordName) {
  if (!JOB_ID_PATTERN.test(jid)) throw refused()
  return record === "reservation" ? `${jid}.json` : `${jid}.${record}.json`
}

export const read = <S extends typeof Reservation | typeof Placed | typeof Bound>(
  jid: string,
  record: "placed" | "session" | "reservation",
  schema: S,
) =>
  Effect.tryPromise({
    try: async (): Promise<S["Type"] | undefined> => {
      const file = path.join(await root(), name(jid, record))
      const entry = await lstat(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
      if (!entry) return undefined
      const owner = process.getuid?.()
      if (
        !entry.isFile() ||
        entry.nlink !== 1 ||
        entry.size > maxBytes ||
        (owner !== undefined && (entry.uid !== owner || entry.mode & 0o077))
      )
        throw refused()
      const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
      try {
        const actual = await handle.stat()
        if (!actual.isFile() || !same(entry, actual) || entry.size !== actual.size) throw refused()
        const { buffer, bytesRead } = await handle.read(Buffer.alloc(actual.size + 1), 0, actual.size + 1, 0)
        if (bytesRead !== actual.size) throw refused()
        const decoded = Schema.decodeUnknownOption(schema)(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead))),
        )
        if (Option.isNone(decoded)) throw refused()
        // A retry may see the link from an attempt interrupted before its directory sync completed.
        if (record === "session") await syncDirectory(path.dirname(file))
        return decoded.value
      } finally {
        await handle.close()
      }
    },
    catch: refused,
  })

export const write = (
  jid: string,
  record: RecordName,
  value: typeof Placed.Type | typeof Bound.Type | { claim: string },
) =>
  Effect.tryPromise({
    try: async () => {
      const directory = await root()
      const file = path.join(directory, name(jid, record))
      const temporary = path.join(directory, `${randomUUID()}.tmp`)
      const text = JSON.stringify(value)
      if (Buffer.byteLength(text) > maxBytes) throw refused()
      const handle = await open(temporary, "wx", 0o600)
      try {
        try {
          await handle.writeFile(text, "utf8")
          await handle.sync()
        } finally {
          await handle.close()
        }
        // Atomically publish without replacing an existing receipt or a competing creation intent.
        await link(temporary, file)
      } finally {
        await rm(temporary, { force: true })
      }
      await syncDirectory(directory)
    },
    catch: refused,
  })
