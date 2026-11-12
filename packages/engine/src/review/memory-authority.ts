export * as ReviewMemoryAuthority from "./memory-authority"

import { createHash } from "node:crypto"
import { realpathSync, statSync } from "node:fs"
import { inArray } from "drizzle-orm"
import { Cause, Effect, Layer, Option, Schema } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { BrainDatabase } from "@vectordevai/core/brain/database"
import type { Brain } from "@vectordevai/core/brain/brain"
import { BrainPaths } from "@vectordevai/core/brain/paths"
import { ReviewMemory } from "@vectordevai/core/brain/review-memory"
import { decodeLocalResult } from "@vectordevai/core/review/local-result"
import { Database } from "@vectordevai/core/database/database"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Project } from "@vectordevai/core/project"
import { ReviewRequestStore } from "@vectordevai/core/review/request-store"
import { SessionTable } from "@vectordevai/core/session/sql"
import { SessionID } from "@vectordevai/schema/session-id"
import { RequestPrincipal } from "@vectordevai/protocol/middleware/authorization"
import { RequestOwner } from "@vectordevai/server/request-owner"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { ReviewLifecycle } from "./lifecycle"
import { ReviewLocalRun } from "./local-run"

const refused = (reason: ReviewMemory.Failure): ReviewMemory.Result<never> => ({ ok: false, reason })
const identity = (directory: string) => {
  const canonical = realpathSync(directory)
  const stat = statSync(canonical, { bigint: true })
  if (!stat.isDirectory() || stat.ino === 0n) throw new Error("Unverifiable review memory directory")
  return { canonical, id: `${stat.dev}:${stat.ino}` }
}

/** Derives only the selected instance's repository identity, without reading memory files or personal recall. */
export const place = Effect.fn("ReviewMemoryAuthority.place")(function* () {
  const context = yield* InstanceState.context
  const directory = yield* Effect.try({ try: () => identity(context.directory), catch: () => "unavailable" as const })
  const root = yield* Effect.try({
    try: () => identity(context.worktree === "/" ? context.directory : context.worktree),
    catch: () => "unavailable" as const,
  })
  const repository =
    context.project.id === Project.ID.global ? BrainPaths.folderKey(directory.canonical) : context.project.id
  return { repository, directory, root }
})

export function make(input: {
  database: Database.Interface["db"]
  requests: ReviewRequestStore.Interface
  lifecycle: ReviewLifecycle.Interface
  settings: Pick<Config.Interface, "trust">
}): ReviewMemory.Authority {
  const selected = Effect.gen(function* () {
    const captured = yield* place()
    const trust = yield* input.settings.trust()
    return { ...captured, held: !trust.trusted && trust.settings }
  })
  const unchanged = (captured: Effect.Success<typeof selected>) =>
    Effect.gen(function* () {
      const current = yield* selected
      return (
        current.repository === captured.repository &&
        current.directory.canonical === captured.directory.canonical &&
        current.directory.id === captured.directory.id &&
        current.root.canonical === captured.root.canonical &&
        current.root.id === captured.root.id &&
        current.held === captured.held
      )
    }).pipe(Effect.orElseSucceed(() => false))
  return {
    owner: (request, use) =>
      Effect.gen(function* () {
        // RequestPrincipal has an internal owner default. That default, an
        // absent HTTP request, and a JSON owner flag are not authentication.
        const context = yield* Effect.context<never>()
        const http = yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest)
        if (!context.mapUnsafe.has(RequestPrincipal.key) || Option.isNone(http) || !(yield* RequestOwner.owner))
          return refused("denied")
        const principal = yield* RequestPrincipal
        if (principal.kind !== "owner") return refused("denied")
        const captured = yield* selected.pipe(Effect.orElseSucceed(() => undefined))
        if (!captured || request.repository !== captured.repository) return refused("authority-unavailable")
        // A read-owner seam only. No prepared human approval UI/consume port is
        // implemented here; writes must remain unavailable rather than auto-approve.
        if (request.operation !== "inspect") return refused("authority-unavailable")
        if (!(yield* unchanged(captured))) return refused("authority-unavailable")
        return yield* use(`http-owner:${createHash("sha256").update(principal.username).digest("hex")}`)
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.succeed(refused("authority-unavailable")),
        ),
      ),
    source: (request, use) =>
      Effect.gen(function* () {
        const captured = yield* selected.pipe(Effect.orElseSucceed(() => undefined))
        if (!captured || captured.held || request.repository !== captured.repository)
          return refused("source-unavailable")
        return yield* input.lifecycle
          .within(
            SessionID.make(request.parentID),
            SessionID.make(request.reviewID),
          )(
            Effect.gen(function* () {
              const snapshot = yield* input.requests.sourceSnapshot(
                SessionID.make(request.parentID),
                SessionID.make(request.reviewID),
              )
              if (!snapshot || snapshot.request.target.head !== request.head) return refused("source-unavailable")
              const rows = yield* input.database
                .select({
                  id: SessionTable.id,
                  parent: SessionTable.parent_id,
                  marker: SessionTable.internal,
                  repository: SessionTable.project_id,
                  directory: SessionTable.directory,
                  metadata: SessionTable.metadata,
                })
                .from(SessionTable)
                .where(inArray(SessionTable.id, [SessionID.make(request.parentID), SessionID.make(request.reviewID)]))
                .all()
              const parent = rows.find((row) => row.id === request.parentID)
              const review = rows.find((row) => row.id === request.reviewID)
              if (
                !parent ||
                !review ||
                parent.parent ||
                parent.marker ||
                review.parent !== parent.id ||
                review.marker !== ReviewLocalRun.MARKER ||
                parent.repository !== review.repository
              )
                return refused("source-unavailable")
              const repository =
                parent.repository === Project.ID.global ? BrainPaths.folderKey(parent.directory) : parent.repository
              const record = ReviewLocalRun.readRecord(review.metadata?.[ReviewLocalRun.FIELD])
              if (
                repository !== captured.repository ||
                !record ||
                record.parentID !== parent.id ||
                record.request.requestID !== snapshot.request.requestID ||
                record.request.maxCost !== snapshot.request.maxCost ||
                record.request.target.kind !== snapshot.request.target.kind ||
                record.request.target.head !== snapshot.request.target.head
              )
                return refused("source-unavailable")
              const directories = yield* Effect.try({
                try: () => [parent.directory, review.directory, record.directory].map(identity),
                catch: () => "unavailable" as const,
              })
              if (
                directories.some(
                  (directory) =>
                    directory.canonical !== captured.directory.canonical || directory.id !== captured.directory.id,
                )
              )
                return refused("source-unavailable")
              if (snapshot.phase === "running" && record.status !== "running") return refused("source-unavailable")
              if (snapshot.phase === "settled") {
                if (record.status === "running" || !record.artifact || !ReviewLocalRun.validArtifact(record.artifact))
                  return refused("source-unavailable")
                const value = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(record.artifact.json)
                if (Option.isNone(value) || !decodeLocalResult(value.value, record.request.target))
                  return refused("source-unavailable")
              }
              if (!(yield* unchanged(captured))) return refused("source-unavailable")
              return yield* use()
            }),
          )
          .pipe(Effect.orElseSucceed(() => refused("source-unavailable")))
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.succeed(refused("source-unavailable")),
        ),
      ),
  }
}

const layer = Layer.unwrap(
  Effect.gen(function* () {
    const database = yield* Database.Service
    const requests = yield* ReviewRequestStore.Service
    const lifecycle = yield* ReviewLifecycle.Service
    const settings = yield* Config.Service
    const brain = yield* BrainDatabase.Service
    return ReviewMemory.layerWith(make({ database: database.db, requests, lifecycle, settings })).pipe(
      Layer.provide(Layer.succeed(BrainDatabase.Service, brain)),
    )
  }),
)
export const node = LayerNode.make({
  service: ReviewMemory.Service,
  layer,
  deps: [Database.node, ReviewRequestStore.node, ReviewLifecycle.node, Config.node, BrainDatabase.node],
})

/** Adapter for an authenticated owner route; no arbitrary repository or file sources are accepted from JSON. */
export const inspect = Effect.fn("ReviewMemoryAuthority.inspect")(function* (options?: {
  offset?: number
  limit?: number
}) {
  const memory = yield* ReviewMemory.Service
  const current = yield* place().pipe(Effect.orElseSucceed(() => undefined))
  if (!current) return refused("authority-unavailable")
  const settings = yield* Config.Service
  const trust = yield* settings.trust()
  const selected: Brain.Place = {
    repository: current.repository,
    root: current.root.canonical,
    sources: [],
    held: !trust.trusted && trust.settings,
  }
  return yield* memory.inspect(selected, options)
})
