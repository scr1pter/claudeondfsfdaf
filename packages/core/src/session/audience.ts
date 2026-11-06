import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { SessionSchema } from "./schema"

export type Actor = "owner" | "guest"
export class Denied extends Schema.TaggedErrorClass<Denied>()("SessionAudience.Denied", {
  reason: Schema.Literals(["owner_required", "guest_input", "owner_only"]),
  message: Schema.String,
}) {}

export interface Interface {
  readonly register: (input: {
    sessionID: string
    parentID?: string
    forkOf?: string
    actor?: Actor
  }) => Effect.Effect<void, Denied>
  readonly markGuest: (sessionID: string) => Effect.Effect<void, Denied>
  readonly canIsolate: (sessionID: string, actor: Actor) => Effect.Effect<boolean>
  readonly fenceIsolation: (input: {
    sessionID: string
    actor: Actor
    directory?: string
  }) => Effect.Effect<void, Denied>
  readonly knows: (sessionID: string) => Effect.Effect<boolean>
  /**
   * Whether `member` is in `sessionID`'s own lineage: itself, its ancestors and descendants (siblings through them, IDs
   * left after deletion included), across no fork edge in either direction. A source never shows its fork's later
   * messages, and a fork shows its source only up to the fork point, which the lineage does not record, so neither is in
   * the other's lineage. An unknown member is not. This is lineage only: it decides whether a refusal may name another
   * conversation's subagent, and never grants anything.
   */
  readonly inFamily: (sessionID: string, member: string) => Effect.Effect<boolean>
  readonly isPrivate: (sessionID: string) => Effect.Effect<boolean>
  readonly hasGuestInput: (sessionID: string) => Effect.Effect<boolean>
  /** Whether any private root is recorded; without one no directory or text can be private (cheap and cached). */
  readonly hasPrivateDirectories: Effect.Effect<boolean>
  readonly isPrivateDirectory: (directory: string) => Effect.Effect<boolean>
  readonly overlapsPrivateDirectory: (directory: string) => Effect.Effect<boolean>
  readonly containsPrivateText: (text: string) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@vector/SessionAudience") {}

const denied = (reason: Denied["reason"]) =>
  new Denied({
    reason,
    message:
      reason === "owner_required"
        ? "Only the owner can start isolated work."
        : reason === "guest_input"
          ? "Isolated work cannot start in a conversation that has received guest input."
          : "This conversation is private to its owner.",
  })

// Every step is an indexed lookup in one direction. Tool output checks run this per call and per output chunk, so it
// must not rebuild every edge in the database for each family member (SQLite 3.34+ allows several recursive selects).
// The owner-only fence (`fence`) covers every edge in both directions. Guest input (`guest`) reaches a conversation only
// through what it shows: a child's report reaches its parent, a parent's brief its children, and a fork its source's
// history, but a source never shows its fork's later messages, so that walk follows a fork edge only from the fork.
// Naming (`lineage`, inFamily) follows no fork edge: a fork's source goes on after the fork point, which no edge records.
const family = (sessionID: string, walk: "fence" | "guest" | "lineage" = "fence") => sql`WITH RECURSIVE family(id) AS (
  SELECT ${sessionID}
  UNION SELECT session_lineage.parent_id FROM family JOIN session_lineage ON session_lineage.session_id = family.id${walk === "lineage" ? sql` AND NOT session_lineage.fork` : sql``}
  UNION SELECT session_lineage.session_id FROM family JOIN session_lineage ON session_lineage.parent_id = family.id${walk === "fence" ? sql`` : sql` AND NOT session_lineage.fork`}
  UNION SELECT session.parent_id FROM family JOIN session ON session.id = family.id WHERE session.parent_id IS NOT NULL
  UNION SELECT session.id FROM family JOIN session ON session.parent_id = family.id
)`

/**
 * A task's linked Git metadata lives in the ordinary repository's `.git/worktrees`. Listing or searching a directory
 * above that `.git` does not reveal it (file listings show only the name, and searches skip `.git`), so it does not make
 * the whole ordinary checkout private. Selecting `.git` itself, or anything inside it, still overlaps.
 */
function insideGitMetadata(target: string, root: string) {
  return path.relative(target, root).split(/[\\/]/).slice(0, -1).includes(".git")
}

/** The path and each folder above it, up to the file system root. */
function ancestors(target: string): string[] {
  const parent = path.dirname(target)
  return parent === target ? [target] : [target, ...ancestors(parent)]
}

type Node = { next: Map<number, Node>; end: boolean }

/**
 * Whether a text contains any of the spellings, in one pass whose cost hardly grows with their number: the spellings
 * form a character trie, and a walk starts only where one of their first characters occurs.
 */
function matcher(spellings: readonly string[]) {
  const root: Node = { next: new Map(), end: false }
  for (const spelling of spellings.filter((value) => value.length > 0)) {
    let node = root
    for (let index = 0; index < spelling.length; index++) {
      const next: Node = node.next.get(spelling.charCodeAt(index)) ?? { next: new Map(), end: false }
      node.next.set(spelling.charCodeAt(index), next)
      node = next
    }
    node.end = true
  }
  const firsts = [...root.next.keys()]
  return (text: string) =>
    firsts.some((first) => {
      const character = String.fromCharCode(first)
      for (let start = text.indexOf(character); start !== -1; start = text.indexOf(character, start + 1)) {
        let node = root.next.get(first)
        for (let index = start + 1; node && !node.end; index++) node = node.next.get(text.charCodeAt(index))
        if (node?.end) return true
      }
      return false
    })
}

/**
 * A path as private roots are compared: case-folded wherever the file system usually ignores case, always on Windows,
 * and on macOS, where callers such as the engine's file-lock keys already fold case on case-insensitive volumes. Folding
 * on a case-sensitive Mac volume only refuses more, never less.
 */
export function foldPath(value: string, platform: NodeJS.Platform = process.platform) {
  if (platform === "win32") return value.toLowerCase()
  if (platform === "darwin") return value.normalize("NFC").toLowerCase()
  return value
}

/** Explicit database binding for low-level event/creation boundaries without an Event service dependency. */
export function make(database: Database.Interface, platform: NodeJS.Platform = process.platform): Interface {
  const db = database.db
  const fold = (value: string) => foldPath(value, platform)
  const directoryKey = (directory: string) => fold(FSUtil.realpath(directory))
  // Guest-facing checks run per event, response and output chunk. Fences only add private roots, so the roots and the
  // matcher built from them are reread only when the table changes, which another engine on the same data folder may
  // also do: each check reads the row count and the last row (cheap), never every row.
  const loaded: { key?: string; roots: string[]; set: Set<string>; contains: (text: string) => boolean } = {
    roots: [],
    set: new Set(),
    contains: () => false,
  }
  const roots = Effect.gen(function* () {
    const stamp = yield* db
      .get<{ count: number; last: number | null; tail: string | null }>(
        sql`SELECT count(*) AS count, max(rowid) AS last,
      (SELECT directory FROM session_private_directory ORDER BY rowid DESC LIMIT 1) AS tail
    FROM session_private_directory`,
      )
      .pipe(Effect.orDie)
    const key = `${stamp?.count}:${stamp?.last}:${stamp?.tail}`
    if (loaded.key === key) return loaded
    const rows = yield* db
      .all<{ directory: string }>(sql`SELECT directory FROM session_private_directory`)
      .pipe(Effect.orDie)
    const folded = rows.map((row) => fold(row.directory))
    return Object.assign(loaded, {
      key,
      roots: folded,
      set: new Set(rows.map((row) => fold(path.resolve(row.directory)))),
      contains: matcher(
        folded.flatMap((root) =>
          [root, root.replaceAll("\\", "/")].flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]),
        ),
      ),
    })
  })
  const legacyFile =
    Database.path() === ":memory:"
      ? undefined
      : path.join(path.dirname(Database.path()), "free-model-guest-sessions.txt")
  // Tool output checks ask hasGuestInput often, so the legacy list is reread only when the file changes. A list that
  // exists but cannot be read (a scanner or backup holding it, say) is undefined: privacy decisions then fail closed,
  // and nothing else stops.
  const cached: { key?: string; ids: string[]; set: Set<string> } = { ids: [], set: new Set() }
  const legacy = Effect.tryPromise(async () => {
    if (!legacyFile) return cached
    const info = await stat(legacyFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    const key = info ? `${info.mtimeMs}:${info.size}:${info.ino}` : "missing"
    if (cached.key === key) return cached
    const text = info
      ? await readFile(legacyFile, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return ""
          throw error
        })
      : ""
    const ids = [
      ...new Set(
        text
          .split("\n")
          .map((line) => line.trim())
          .flatMap((line) => {
            const decoded = Schema.decodeUnknownOption(SessionSchema.ID)(line)
            return decoded._tag === "Some" ? [decoded.value] : []
          }),
      ),
    ]
    cached.key = key
    cached.ids = ids
    cached.set = new Set(ids)
    return cached
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("the legacy guest list could not be read", { cause }).pipe(Effect.as(undefined)),
    ),
  )
  const flags = (sessionID: string, guest = false) =>
    db
      .get<{ owner_only: number; guest_input: number }>(
        sql`${family(sessionID, guest ? "guest" : "fence")}
    SELECT coalesce(max(a.owner_only), 0) AS owner_only, coalesce(max(a.guest_input), 0) AS guest_input
    FROM family LEFT JOIN session_audience a ON a.session_id = family.id`,
      )
      .pipe(Effect.orDie)
  const members = (sessionID: string, guest: boolean) =>
    db
      .all<{ id: string }>(sql`${family(sessionID, guest ? "guest" : "fence")} SELECT id FROM family`)
      .pipe(Effect.orDie)
  const ensure = (sessionID: string) =>
    db
      .run(sql`INSERT OR IGNORE INTO session_audience(session_id) VALUES (${sessionID})`)
      .pipe(Effect.orDie, Effect.asVoid)
  const capture = (sessionID: string) =>
    db
      .run(
        sql`${family(sessionID)}
    INSERT OR IGNORE INTO session_lineage(session_id, parent_id)
    SELECT id, parent_id FROM session WHERE parent_id IS NOT NULL AND id IN (SELECT id FROM family)`,
      )
      .pipe(Effect.orDie, Effect.asVoid)
  const isPrivate = (sessionID: string) => flags(sessionID).pipe(Effect.map((value) => value?.owner_only === 1))
  // An older engine on the same data folder knows nothing of fences, and may list a conversation whose family was
  // fenced before. The fence is already the restrictive state, so such a mark is not imported: inside a fenced family
  // it would refuse every later creation and fence there, the owner's own included. It stays in the list, which
  // hasGuestInput (so canIsolate) and FreeModelGuests still read. Each such conflict is logged once per instance.
  const conflicts = new Set<string>()
  // Both marks only ever turn on, so an ID once found already marked guest, or found in a fenced family, needs no
  // further reads. Only such reads count, never this call's own writes, which its transaction may still roll back.
  // Once every listed ID is settled, a list unchanged since then costs nothing: register, fence and guest admits run
  // this inside BEGIN IMMEDIATE, and FreeModelGuests only ever appends to the list.
  const settled = new Set<string>()
  const done: { key?: string } = {}
  // Whether the list could be read; one that could not is imported by a later call.
  const importLegacy = Effect.gen(function* () {
    const list = yield* legacy
    if (!list) return false
    if (list.key !== undefined && done.key === list.key) return true
    const key = list.key
    const pending = list.ids.filter((id) => !settled.has(id))
    for (const id of pending) {
      const current = yield* db
        .get<{ guest_input: number }>(sql`SELECT guest_input FROM session_audience WHERE session_id = ${id}`)
        .pipe(Effect.orDie)
      if (current?.guest_input) {
        settled.add(id)
        continue
      }
      if (yield* isPrivate(id)) {
        if (!conflicts.has(id))
          yield* Effect.logWarning("a legacy guest mark names a conversation already private to its owner", {
            sessionID: id,
          })
        conflicts.add(id)
        settled.add(id)
        continue
      }
      yield* db
        .run(
          sql`INSERT INTO session_audience(session_id, guest_input) VALUES (${id}, 1)
      ON CONFLICT(session_id) DO UPDATE SET guest_input = 1`,
        )
        .pipe(Effect.orDie)
    }
    if (pending.length === 0) done.key = key
    return true
  })
  // BEGIN IMMEDIATE serializes decisions across connections/processes before their first read.
  const serialized = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    db
      .transaction(() => effect, { behavior: "immediate" })
      .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)))
  // `guest` walks what the conversation shows (hasGuestInput); without it, the whole fenced family (canIsolate, which
  // must agree with fenceIsolation).
  const guestIn = (sessionID: string, guest: boolean) =>
    Effect.gen(function* () {
      const current = yield* flags(sessionID, guest)
      if (current?.guest_input === 1) return true
      const listed = yield* legacy
      // An unreadable list fails closed, except for a fenced family: its fence read the list, and guest input is refused
      // ever after, so treating its owner as a guest would only refuse the owner's own isolated work.
      if (listed === undefined) return !(yield* isPrivate(sessionID))
      // Tool output checks ask this on every call; without a legacy list there is no second family walk to make.
      if (listed.set.size === 0) return false
      return (yield* members(sessionID, guest)).some((member) => listed.set.has(member.id))
    })
  const hasGuestInput = (sessionID: string) => guestIn(sessionID, true)
  const register: Interface["register"] = (input) =>
    serialized(
      Effect.gen(function* () {
        yield* ensure(input.sessionID)
        const edges = [
          ...(input.parentID ? [{ parentID: input.parentID, fork: 0 }] : []),
          ...(input.forkOf && input.forkOf !== input.parentID ? [{ parentID: input.forkOf, fork: 1 }] : []),
        ]
        for (const edge of edges) {
          yield* ensure(edge.parentID)
          // A parent edge wins over a fork edge between the same two sessions: reports flow both ways along it.
          yield* db
            .run(
              sql`INSERT INTO session_lineage(session_id, parent_id, fork) VALUES (${input.sessionID}, ${edge.parentID}, ${edge.fork})
      ON CONFLICT(session_id, parent_id) DO UPDATE SET fork = min(fork, excluded.fork)`,
            )
            .pipe(Effect.orDie)
        }
        yield* capture(input.sessionID)
        yield* importLegacy
        const current = yield* flags(input.sessionID)
        if (current?.owner_only && (current.guest_input || input.actor === "guest")) return yield* denied("owner_only")
        if (input.actor === "guest")
          yield* db
            .run(sql`UPDATE session_audience SET guest_input = 1 WHERE session_id = ${input.sessionID}`)
            .pipe(Effect.orDie)
      }),
    )
  const markGuest: Interface["markGuest"] = (sessionID) =>
    serialized(
      Effect.gen(function* () {
        yield* ensure(sessionID)
        yield* capture(sessionID)
        if (yield* isPrivate(sessionID)) return yield* denied("owner_only")
        yield* db
          .run(sql`UPDATE session_audience SET guest_input = 1 WHERE session_id = ${sessionID}`)
          .pipe(Effect.orDie)
      }),
    )
  // The fence covers forks in both directions, so guest input in any fork of the family refuses it, as fenceIsolation
  // does.
  const canIsolate: Interface["canIsolate"] = (sessionID, actor) =>
    actor === "owner" ? guestIn(sessionID, false).pipe(Effect.map((guest) => !guest)) : Effect.succeed(false)
  const fenceIsolation: Interface["fenceIsolation"] = (input) => {
    if (input.actor !== "owner") return Effect.fail(denied("owner_required"))
    const directories =
      input.directory === undefined
        ? []
        : [...new Set([directoryKey(input.directory), fold(path.resolve(input.directory))])]
    return serialized(
      Effect.gen(function* () {
        yield* ensure(input.sessionID)
        yield* capture(input.sessionID)
        const imported = yield* importLegacy
        const current = yield* flags(input.sessionID)
        if (current?.guest_input) return denied("guest_input")
        // Without the legacy guest list, only a family already fenced may add roots: it refuses guest input from then on.
        if (!imported && !current?.owner_only)
          return new Denied({
            reason: "guest_input",
            message: "The guest list could not be read, so isolated work cannot start yet.",
          })
        yield* db
          .run(sql`UPDATE session_audience SET owner_only = 1 WHERE session_id = ${input.sessionID}`)
          .pipe(Effect.orDie)
        for (const directory of directories)
          yield* db
            .run(
              sql`INSERT OR IGNORE INTO session_private_directory(directory, session_id) VALUES (${directory}, ${input.sessionID})`,
            )
            .pipe(Effect.orDie)
        return undefined
      }),
    ).pipe(Effect.flatMap((refused) => (refused ? Effect.fail(refused) : Effect.void)))
  }
  return Service.of({
    register,
    markGuest,
    canIsolate,
    fenceIsolation,
    isPrivate,
    hasGuestInput,
    knows: (sessionID) =>
      db
        .get<{ known: number }>(
          sql`SELECT EXISTS (
      SELECT 1 FROM session WHERE id = ${sessionID}
      UNION SELECT 1 FROM session_audience WHERE session_id = ${sessionID}
      UNION SELECT 1 FROM session_lineage WHERE session_id = ${sessionID} OR parent_id = ${sessionID}
    ) AS known`,
        )
        .pipe(
          Effect.orDie,
          Effect.map((value) => value?.known === 1),
        ),
    inFamily: (sessionID, member) =>
      db
        .get<{ found: number }>(
          sql`${family(sessionID, "lineage")}
    SELECT EXISTS (SELECT 1 FROM family WHERE id = ${member}) AS found`,
        )
        .pipe(
          Effect.orDie,
          Effect.map((value) => value?.found === 1),
        ),
    hasPrivateDirectories: Effect.map(roots, (current) => current.roots.length > 0),
    // A root holds the target when it is the target or one of its folders, so a lookup per folder replaces a
    // comparison per root.
    isPrivateDirectory: (directory) =>
      Effect.gen(function* () {
        const set = (yield* roots).set
        return ancestors(directoryKey(directory)).some((item) => set.has(item))
      }),
    overlapsPrivateDirectory: (directory) =>
      Effect.gen(function* () {
        const target = directoryKey(directory)
        return (yield* roots).roots.some(
          (root) =>
            FSUtil.contains(root, target) || (FSUtil.contains(target, root) && !insideGitMetadata(target, root)),
        )
      }),
    containsPrivateText: (text) =>
      Effect.gen(function* () {
        const current = yield* roots
        return current.roots.length > 0 && current.contains(fold(text))
      }),
  })
}

export const layer = Layer.effect(
  Service,
  Effect.map(Database.Service, (database) => make(database)),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
export * as SessionAudience from "./audience"
