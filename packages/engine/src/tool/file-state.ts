export * as FileState from "./file-state"

import { createHash } from "node:crypto"
import { open } from "node:fs/promises"
import { Effect, Schema } from "effect"
import { TaskSize } from "@vectordevai/core/task-size"
import type { SessionV1 } from "@vectordevai/core/v1/session"
import { TaskClaims } from "@/task/claims"
import { FileLock } from "./file-lock"

/**
 * What each session last saw of each file it read or wrote, so edit, write and apply_patch change only a file the
 * session has read and that nobody changed since. Process-global; after a restart a session's knowledge is seeded from
 * the `fileState` / `fileStates` metadata of its tool parts and the `read.fileState` of its @-attachment parts.
 */

/** A file's content as compared: by sha256 up to the hash limit, else by size and mtime. */
export type Stamp = { size: number; mtime: number; sha256?: string }

/** What a session knows of one file, as tool part metadata keeps it. No stamp: the session deleted the file. */
export type Entry = { file: string; at: number; stamp?: Stamp }

/** The last Vector session that wrote or deleted a file in this process. */
export type Writer = { sessionID: string; title?: string; at: number; deleted: boolean }

export type Observed = { stamp: Stamp; bytes: Uint8Array }

const DEFAULTS = { hash: 16 * 1024 * 1024, files: 2_000, sessions: 200, writers: 20_000 }
let limits = { ...DEFAULTS }

/** Tests only: smaller limits. No argument restores the defaults. */
export function configure(next?: Partial<typeof DEFAULTS>) {
  limits = { ...DEFAULTS, ...next }
}

// Strictly increasing, so a record and a write in the same millisecond still have an order.
let last = 0
const tick = () => (last = Math.max(Date.now(), last + 1))

const sessions = new Map<string, Map<string, Entry>>()
const writers = new Map<string, Writer>()

function bump<K, V>(map: Map<K, V>, key: K, value: V, cap: number) {
  map.delete(key)
  map.set(key, value)
  while (map.size > cap) map.delete(map.keys().next().value as K)
}

function put(sessionID: string, entry: Entry) {
  const files = sessions.get(sessionID) ?? new Map<string, Entry>()
  bump(files, entry.file, entry, limits.files)
  bump(sessions, sessionID, files, limits.sessions)
}

const ENOENT = new Set(["ENOENT", "ENOTDIR"])
const absent = (error: unknown) => ENOENT.has((error as { code?: string } | undefined)?.code ?? "")
const failure = (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause)))

/** The file now with its bytes, or undefined when it is absent. */
export const observe = (file: string): Effect.Effect<Observed | undefined, Error> =>
  Effect.tryPromise({
    try: async () => {
      const handle = await open(file, "r").catch((error) => {
        if (absent(error)) return undefined
        throw error
      })
      if (!handle) return undefined
      try {
        const info = await handle.stat()
        const bytes = new Uint8Array(await handle.readFile())
        const stamp: Stamp = { size: bytes.length, mtime: info.mtimeMs }
        if (bytes.length <= limits.hash) stamp.sha256 = createHash("sha256").update(bytes).digest("hex")
        return { stamp, bytes }
      } finally {
        await handle.close()
      }
    },
    catch: failure,
  })

/** The file's stamp now, hashed in pieces so a large file is never held whole; undefined when it is absent. */
export const stamp = (file: string): Effect.Effect<Stamp | undefined, Error> =>
  Effect.tryPromise({
    try: async () => {
      const handle = await open(file, "r").catch((error) => {
        if (absent(error)) return undefined
        throw error
      })
      if (!handle) return undefined
      try {
        const info = await handle.stat()
        if (!info.isFile()) return undefined
        if (info.size > limits.hash) return { size: info.size, mtime: info.mtimeMs }
        const hash = createHash("sha256")
        const buffer = Buffer.allocUnsafe(64 * 1024)
        let size = 0
        for (;;) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
          if (bytesRead === 0) break
          hash.update(buffer.subarray(0, bytesRead))
          size += bytesRead
        }
        return { size, mtime: info.mtimeMs, sha256: hash.digest("hex") }
      } finally {
        await handle.close()
      }
    },
    catch: failure,
  })

/** Whether two stamps show the same content: sha256 when both have one, else size and mtime. */
export function same(a: Stamp | undefined, b: Stamp | undefined) {
  if (!a || !b) return !a && !b
  if (a.sha256 && b.sha256) return a.sha256 === b.sha256
  return a.size === b.size && a.mtime === b.mtime
}

/** Notes that the session read the file as `stamp` shows it, and returns the entry its part metadata keeps. */
export function record(sessionID: string, file: string, stamp: Stamp | undefined): Entry | undefined {
  if (!stamp) return undefined
  const entry: Entry = { file: FileLock.key(file), at: tick(), stamp }
  put(sessionID, entry)
  return entry
}

/** Notes that the session wrote the file (`stamp`) or deleted it (no stamp). */
export function wrote(sessionID: string, file: string, stamp: Stamp | undefined, title?: string): Entry {
  const entry: Entry = { file: FileLock.key(file), at: tick(), ...(stamp ? { stamp } : {}) }
  put(sessionID, entry)
  TaskClaims.touch(sessionID, file)
  bump(writers, entry.file, { sessionID, ...(title ? { title } : {}), at: entry.at, deleted: !stamp }, limits.writers)
  return entry
}

/** After a write or delete, inside the file's lock: records the file as it is now and returns the metadata entry. */
export const commit = Effect.fn("FileState.commit")(function* (i: { sessionID: string; file: string; title?: string }) {
  return wrote(i.sessionID, i.file, yield* stamp(i.file), i.title)
})

export function lastWriter(file: string) {
  return writers.get(FileLock.key(file))
}

/** Drops what the session knows: all of it, or only `files`. A revert calls it, since files went back. */
export function forget(sessionID: string, files?: readonly string[]) {
  if (!files) {
    sessions.delete(sessionID)
    return
  }
  const known = sessions.get(sessionID)
  for (const file of files) known?.delete(FileLock.key(file))
}

function parse(value: unknown): Entry | undefined {
  if (!value || typeof value !== "object") return undefined
  const item = value as Record<string, unknown>
  if (typeof item.file !== "string" || typeof item.at !== "number") return undefined
  if (item.stamp === undefined) return { file: item.file, at: item.at }
  const stamp = item.stamp as Record<string, unknown> | null
  if (!stamp || typeof stamp.size !== "number" || typeof stamp.mtime !== "number") return undefined
  if (stamp.sha256 !== undefined && typeof stamp.sha256 !== "string") return undefined
  return {
    file: item.file,
    at: item.at,
    stamp: { size: stamp.size, mtime: stamp.mtime, ...(stamp.sha256 ? { sha256: stamp.sha256 } : {}) },
  }
}

function carried(part: SessionV1.Part): unknown[] {
  if (part.type === "tool" && part.state.status === "completed") {
    const states = part.state.metadata?.fileStates
    return [part.state.metadata?.fileState, ...(Array.isArray(states) ? states : [])]
  }
  if (part.type === "text" && part.synthetic) return [part.metadata?.read?.fileState]
  return []
}

/** What the session knows of the file: from memory, else the latest entry its messages carry. */
export function known(sessionID: string, file: string, messages: readonly SessionV1.WithParts[]): Entry | undefined {
  const key = FileLock.key(file)
  const hit = sessions.get(sessionID)?.get(key)
  if (hit) {
    put(sessionID, hit)
    return hit
  }
  for (const message of messages.toReversed())
    for (const part of message.parts.toReversed())
      for (const value of carried(part)) {
        const entry = parse(value)
        if (entry?.file !== key) continue
        put(sessionID, entry)
        return entry
      }
  return undefined
}

export class StaleError extends Schema.TaggedErrorClass<StaleError>()("FileState.StaleError", {
  reason: Schema.Literals(["unread", "changed", "deleted", "exists"]),
  file: Schema.String,
  message: Schema.String,
}) {}

/** "update" changes or deletes a file that may exist; "create" makes a file that must not exist yet. */
export type Kind = "update" | "create"

/** Refuses a change to a file this session has not read, or that changed or was deleted since it last did. */
export const verify = Effect.fn("FileState.verify")(function* (i: {
  sessionID: string
  file: string
  now: Stamp | undefined
  kind: Kind
  messages: readonly SessionV1.WithParts[]
  tool: "edit" | "write" | "apply_patch"
  /** The calling context's `Tool.Context.inFamily`, passed on even when absent, so no tool leaves it out by accident. */
  inFamily: ((sessionID: string) => Effect.Effect<boolean>) | undefined
}) {
  // A writer's subagent title and session ID belong to its conversation, so they are named only to that conversation's
  // family; without the relation the writer stays unnamed.
  const who = Effect.fnUntraced(function* (writer: Writer) {
    if (!i.inFamily || !(yield* i.inFamily(writer.sessionID))) return "another conversation"
    return writer.title
      ? `the subagent "${TaskSize.neutralizeTags(writer.title)}" (${writer.sessionID})`
      : `another session (${writer.sessionID})`
  })
  const mine = known(i.sessionID, i.file, i.messages)
  const writer = lastWriter(i.file)
  const other = writer && writer.sessionID !== i.sessionID && (!mine || writer.at > mine.at) ? writer : undefined
  if (!i.now) {
    if (mine && other?.deleted)
      return yield* new StaleError({
        reason: "deleted",
        file: i.file,
        message: `${i.file} was deleted by ${yield* who(other)} after you read it. Nothing was written.`,
      })
    return
  }
  if (i.kind === "create")
    return yield* new StaleError({
      reason: "exists",
      file: i.file,
      message:
        i.tool === "apply_patch"
          ? `${i.file} exists; use *** Update File`
          : `${i.file} exists. Read it, then change it.`,
    })
  if (!mine)
    return yield* new StaleError({
      reason: "unread",
      file: i.file,
      message: `${i.file} has not been read in this conversation, so it was not changed. Read it first.`,
    })
  if (same(mine.stamp, i.now)) return
  const by =
    other && !other.deleted
      ? `written by ${yield* who(other)}`
      : "outside your edits (an editor, a formatter or a shell command)"
  return yield* new StaleError({
    reason: "changed",
    file: i.file,
    message: `${i.file} changed since you last read it, ${by}. Nothing was written; read it again first.`,
  })
})
