import { and, desc, eq, lt, or, sql } from "drizzle-orm"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { BackgroundJobStore } from "@vectordevai/core/background-job-store"
import { Database } from "@vectordevai/core/database/database"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { FSUtil } from "@vectordevai/core/fs-util"
import { SessionTable } from "@vectordevai/core/session/sql"
import { ReviewRun } from "@vectordevai/schema/review-run"
import { ReviewRequestStore } from "@vectordevai/core/review/request-store"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { Permission } from "@/permission"
import { ReviewGit } from "./git"
import { Git } from "@/git"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { ReviewLocalRun } from "./local-run"
import { ReviewModel } from "./model"
import { Review } from "./run"
import { ReviewLifecycle } from "./lifecycle"

export class Error extends Schema.TaggedErrorClass<Error>()("ReviewOwner.Error", {
  code: Schema.Literals(["disabled", "placement", "invalid", "not_found", "corrupt"]),
  message: Schema.String,
}) {}

// Authentication belongs to the HTTP boundary. Every operation below still
// binds its parent to the actual existing engine instance; a query directory or
// a result's metadata is never authority to load/bootstrap another project.
const make = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const settings = yield* Config.Service
  const agents = yield* Agent.Service
  const database = yield* Database.Service
  const runs = yield* ReviewLocalRun.make({ runReview: Review.run, resolveModel: ReviewModel.resolveReviewModel })

  const placement = Effect.fn("ReviewOwner.placement")(function* (sessionID: SessionID, starting = false) {
    const parent = yield* sessions
      .get(sessionID)
      .pipe(Effect.mapError(() => new Error({ code: "not_found", message: "Review conversation not found." })))
    if (parent.parentID || parent.internal)
      return yield* new Error({ code: "invalid", message: "Local reviews belong to a main conversation." })
    if (starting && (parent.revert || parent.time.archived !== undefined))
      return yield* new Error({
        code: "invalid",
        message: "Open the conversation and finish its revert before reviewing.",
      })
    const context = yield* InstanceState.context
    if (
      context.project.id !== parent.projectID ||
      FSUtil.realpath(context.directory) !== FSUtil.realpath(parent.directory)
    )
      return yield* new Error({
        code: "placement",
        message: "Open this conversation in its own project before reviewing.",
      })
    return { parent, context }
  })

  const target = Effect.fn("ReviewOwner.target")(function* (sessionID: SessionID) {
    const { context } = yield* placement(sessionID, true)
    const observed = yield* ReviewGit.metadata(FSUtil.realpath(context.worktree)).pipe(
      Effect.mapError((error) => new Error({ code: "placement", message: error.message })),
    )
    const decoded = Schema.decodeUnknownOption(ReviewRun.Target)({ kind: "working-tree", head: observed.head })
    if (Option.isNone(decoded))
      return yield* new Error({ code: "placement", message: "Commit a base before reviewing local changes." })
    return decoded.value
  })
  const start = Effect.fn("ReviewOwner.start")(function* (sessionID: SessionID, input: unknown) {
    const global = yield* settings.getGlobal()
    if (global.experimental?.vectorscope !== true || global.agent?.vectorscope?.disable)
      return yield* new Error({
        code: "disabled",
        message: "VectorScope local reviews are disabled in the owner's settings.",
      })
    const source = yield* placement(sessionID, true)
    const agent = source.parent.agent ? yield* agents.get(source.parent.agent) : yield* agents.defaultInfo()
    if (!agent || agent.mode === "subagent")
      return yield* new Error({ code: "invalid", message: "The conversation's primary agent is unavailable." })
    return yield* runs.start(input, {
      sessionID,
      directory: source.context.directory,
      worktree: source.context.worktree,
      permission: Permission.merge(agent.permission, source.parent.permission ?? []),
    })
  })
  const get = Effect.fn("ReviewOwner.get")(function* (sessionID: SessionID, runID: SessionID) {
    yield* placement(sessionID)
    return yield* runs.get(sessionID, runID)
  })
  const stop = Effect.fn("ReviewOwner.stop")(function* (sessionID: SessionID, runID: SessionID) {
    yield* placement(sessionID)
    // Turning new reviews off never prevents the owner stopping existing work.
    return yield* runs.stop(sessionID, runID)
  })
  const list = Effect.fn("ReviewOwner.list")(function* (sessionID: SessionID, input: unknown) {
    yield* placement(sessionID)
    const decoded = Schema.decodeUnknownOption(ReviewRun.ListInput)(input)
    if (Option.isNone(decoded))
      return yield* new Error({ code: "invalid", message: "Invalid review discovery request." })
    const limit = decoded.value.limit ?? 20
    const family = and(eq(SessionTable.parent_id, sessionID), eq(SessionTable.internal, ReviewLocalRun.MARKER))
    const cursor = decoded.value.cursor
      ? yield* database.db
          .select({ id: SessionTable.id, createdAt: SessionTable.time_created })
          .from(SessionTable)
          .where(and(family, eq(SessionTable.id, decoded.value.cursor)))
          .get()
          .pipe(Effect.orDie)
      : undefined
    if (decoded.value.cursor && !cursor)
      return yield* new Error({ code: "not_found", message: "Review discovery cursor not found." })
    const rows = yield* database.db
      .select({
        id: SessionTable.id,
        // Strip the potentially large result inside SQLite. A summary response
        // neither hydrates nor sends the code/finding JSON of every earlier run.
        record: sql<string>`json_remove(json_extract(${SessionTable.metadata}, '$.vectorscopeLocalRun'), '$.artifact')`,
        hasResult: sql<number>`json_type(${SessionTable.metadata}, '$.vectorscopeLocalRun.artifact') = 'object'`,
      })
      .from(SessionTable)
      .where(
        and(
          family,
          cursor
            ? or(
                lt(SessionTable.time_created, cursor.createdAt),
                and(eq(SessionTable.time_created, cursor.createdAt), lt(SessionTable.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(SessionTable.time_created), desc(SessionTable.id))
      .limit(limit + 1)
      .all()
      .pipe(Effect.orDie)
    const shown = rows.slice(0, limit)
    const summaries = yield* Effect.forEach(
      shown,
      (row) =>
        Effect.gen(function* () {
          const parsed = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(row.record)
          const record = Option.isSome(parsed) ? ReviewLocalRun.readRecord(parsed.value) : undefined
          if (!record || record.parentID !== sessionID)
            return yield* new Error({ code: "corrupt", message: "A saved local review summary is invalid." })
          if (record.status === "running") {
            const current = yield* runs.get(sessionID, SessionID.make(row.id))
            const { artifact, ...summary } = current
            return { ...summary, hasResult: artifact !== undefined } satisfies ReviewRun.Summary
          }
          return {
            runID: SessionID.make(row.id),
            parentID: sessionID,
            request: record.request,
            status: record.status,
            canStop: false,
            startedAt: record.startedAt,
            ...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
            ...(record.error ? { error: record.error } : {}),
            hasResult: row.hasResult === 1,
          } satisfies ReviewRun.Summary
        }),
      { concurrency: 4 },
    )
    return {
      runs: summaries,
      ...(rows.length > limit ? { next: SessionID.make(shown[shown.length - 1]!.id) } : {}),
    } satisfies ReviewRun.List
  })
  return { target, start, get, stop, list }
})

export type Interface = Effect.Success<typeof make>
export class Service extends Context.Service<Service, Interface>()("@vector/ReviewOwner") {}
const layer = Layer.effect(Service, make)
export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    Session.node,
    Config.node,
    Agent.node,
    Git.node,
    Database.node,
    BackgroundJob.node,
    BackgroundJobStore.node,
    ReviewRequestStore.node,
    ReviewLifecycle.node,
  ],
})

export * as ReviewOwner from "./owner"
