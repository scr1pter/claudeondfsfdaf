export * as FreeModelGuests from "./free-model-guests"

import { appendFile, mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { SessionID } from "@vectordevai/schema/session-id"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { SessionTable } from "./session/sql"
import { SessionAudience } from "./session/audience"

/**
 * The session trees an invited guest has acted in. Only the workspace owner can accept the "May train on your prompts"
 * notice, and whatever a guest adds to a session is sent again with every later request in it, the owner's included.
 * So a free-model request for any session of such a tree never uses that acceptance: FreeModels.resolveRoute reads
 * `marked` for every free-model request, and a model that may train, or one Vector has not reviewed, is refused there
 * before anything is sent. A mark covers the whole tree, from its root: a subagent's result flows into its parent, and
 * a parent's history into the subagents it starts.
 */
export interface Interface {
  readonly mark: (sessionID: SessionID) => Effect.Effect<void>
  readonly marked: (sessionID: SessionID | undefined) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@vector/FreeModelGuests") {}

/**
 * Sent with a guest's request that an engine forwards to a remote workspace, which it authenticates with the owner's
 * credentials there. The remote engine marks the session as it would for the guest. Anyone may send it, since it can
 * only take models away from a session.
 */
export const GUEST_REQUEST_HEADER = "x-vector-guest-request"

// Deeper than any subagent chain the engine starts; a longer one is treated as ending there.
const MAX_DEPTH = 64

/**
 * Marks are kept in memory and, beside an on-disk database, in `file`, so a restart does not forget a guest. The file
 * holds one root session ID per line, and a mark is appended, never rewritten: two engines on one database, such as
 * the terminal's beside the desktop app's, may mark sessions at the same moment, and rewriting the whole file would
 * keep only the last writer's.
 */
export const layerFor = (file: string | undefined) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const database = yield* Database.Service
      const db = database.db
      const audience = SessionAudience.make(database)
      const memory = new Set<SessionID>()
      // Read on every check, never cached: another engine on the same database may have marked a session since. A
      // missing or unreadable file, or a line that is not a session ID, marks nothing.
      const saved = Effect.promise(async () => {
        const text = file ? await readFile(file, "utf8").catch(() => "") : ""
        return new Set(text.split("\n").flatMap((line) => Option.toArray(Schema.decodeUnknownOption(SessionID)(line))))
      })
      // The session and its ancestors, nearest first. A session not saved yet is its own root.
      const lineage = Effect.fnUntraced(function* (sessionID: SessionID) {
        const chain = [sessionID]
        while (chain.length < MAX_DEPTH) {
          const row = yield* db
            .select({ parentID: SessionTable.parent_id })
            .from(SessionTable)
            .where(eq(SessionTable.id, chain[chain.length - 1]))
            .get()
            .pipe(Effect.orDie)
          if (!row?.parentID || chain.includes(row.parentID)) return chain
          chain.push(row.parentID)
        }
        return chain
      })
      return Service.of({
        mark: Effect.fn("FreeModelGuests.mark")(function* (sessionID) {
          yield* audience.markGuest(sessionID).pipe(Effect.orDie)
          const chain = yield* lineage(sessionID)
          const root = chain[chain.length - 1]
          memory.add(root)
          if (!file || (yield* saved).has(root)) return
          // A file that cannot be written leaves the mark in memory, which still holds until a restart.
          yield* Effect.promise(() =>
            mkdir(path.dirname(file), { recursive: true })
              .then(() => appendFile(file, `${root}\n`, { mode: 0o600 }))
              .catch(() => undefined),
          )
        }),
        marked: Effect.fn("FreeModelGuests.marked")(function* (sessionID) {
          if (!sessionID) return false
          if (yield* audience.hasGuestInput(sessionID)) return true
          const chain = yield* lineage(sessionID)
          if (chain.some((id) => memory.has(id))) return true
          const current = yield* saved
          return chain.some((id) => current.has(id))
        }),
      })
    }),
  )

// Beside the database that holds the sessions the marks name, so engines that share sessions share the marks too.
function marksFile() {
  const database = Database.path()
  return database === ":memory:" ? undefined : path.join(path.dirname(database), "free-model-guest-sessions.txt")
}

export const node = makeGlobalNode({
  service: Service,
  layer: Layer.suspend(() => layerFor(marksFile())),
  deps: [Database.node],
})
