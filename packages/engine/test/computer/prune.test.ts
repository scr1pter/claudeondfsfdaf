import { expect } from "bun:test"
import { rm } from "node:fs/promises"
import path from "node:path"
import { NodeFileSystem } from "@effect/platform-node"
import { eq, sql } from "drizzle-orm"
import { Context, Effect, FileSystem, Layer, Result, Schema } from "effect"
import { Database } from "@vectordevai/core/database/database"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { EventV2 } from "@vectordevai/core/event"
import { EventTable } from "@vectordevai/core/event/sql"
import { ProjectV2 } from "@vectordevai/core/project"
import { ProjectTable } from "@vectordevai/core/project/sql"
import { AbsolutePath } from "@vectordevai/core/schema"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { MessageTable, PartTable, SessionMessageTable, SessionTable } from "@vectordevai/core/session/sql"
import { PublicSessionShareTable } from "@vectordevai/core/share/public.sql"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { SessionV1 } from "@vectordevai/schema/session-v1"
import { ComputerPrune } from "@/computer/prune"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { testEffect } from "../lib/effect"

class Fixture extends Context.Service<Fixture, { file: string; database: Database.Interface }>()(
  "test/ComputerPrune",
) {}
const fixture = Layer.effect(
  Fixture,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* Effect.acquireRelease(
      fs.makeTempDirectory({ prefix: "vector-computer-prune-" }),
      (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
    )
    const file = path.join(directory, "screenshots.db")
    // Own the database inside the directory's scope so Windows releases its file handles before removal.
    const context = yield* Layer.build(Database.layerFromPath(file))
    return { file, database: Context.get(context, Database.Service) }
  }),
).pipe(Layer.provide(NodeFileSystem.layer), Layer.orDie)
const database = Layer.effect(
  Database.Service,
  Effect.map(Fixture, (value) => value.database),
).pipe(Layer.provide(fixture))
const it = testEffect(
  LayerNode.compile(
    LayerNode.group([ComputerPrune.node, Database.node, EventV2.node, SessionProjector.node, Session.node]),
    [
      [Database.node, database],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
    ],
  ).pipe(Layer.provideMerge(fixture), Layer.provideMerge(NodeFileSystem.layer)),
)

const projectID = ProjectV2.ID.make("prune-project")
const screen = Buffer.from("PRIVATE_SCREENSHOT_PRUNE_SENTINEL_").toString("base64").repeat(1000)
const uri = `data:image/png;base64,${screen}`
const marker = screen.slice(0, 96)

const seed = Effect.fn("test.prune.seed")(function* (id: string) {
  const database = yield* Database.Service
  const sessionID = SessionID.make(id)
  const messageID = MessageID.make(`msg_${id}_assistant`)
  yield* database.db
    .insert(ProjectTable)
    .values({ id: projectID, worktree: AbsolutePath.make("/prune"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
  yield* database.db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: projectID,
      slug: id,
      directory: "/prune",
      title: "Private session",
      version: "1",
    })
    .run()
  const message: SessionV1.Assistant = {
    id: messageID,
    sessionID,
    role: "assistant",
    parentID: MessageID.make(`msg_${id}_user`),
    agent: "build",
    mode: "build",
    providerID: ProviderV2.ID.make("test"),
    modelID: ModelV2.ID.make("test"),
    path: { cwd: "/prune", root: "/prune" },
    time: { created: 1 },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  const { id: messageKey, sessionID: sessionKey, ...data } = message
  yield* database.db
    .insert(MessageTable)
    .values({
      id: messageKey,
      session_id: sessionKey,
      data,
    })
    .run()
  return { sessionID, messageID }
})

function part(
  context: { sessionID: SessionID; messageID: MessageID },
  id: string,
  end = 10,
  tool = "computer",
): SessionV1.ToolPart & { state: Extract<SessionV1.ToolPart["state"], { status: "completed" }> } {
  return {
    ...context,
    id: PartID.make(id),
    type: "tool",
    tool,
    callID: `call_${id}`,
    state: {
      status: "completed",
      input: { action: "screenshot" },
      title: "Observed app",
      output: "A window is visible.",
      metadata: { action: "screenshot", display: 1 },
      time: { start: end - 1, end },
      attachments: [{ ...context, id: PartID.make(`${id}_image`), type: "file", mime: "image/png", url: uri }],
    },
  }
}

const store = Effect.fn("test.prune.store")(function* (value: SessionV1.ToolPart) {
  const events = yield* EventV2.Service
  return yield* events.publish(SessionV1.Event.PartUpdated, { sessionID: value.sessionID, part: value, time: 1 })
})

const read = Effect.fn("test.prune.read")(function* (id: PartID) {
  const database = yield* Database.Service
  return (yield* database.db.select().from(PartTable).where(eq(PartTable.id, id)).get())?.data
})

const disk = Effect.fn("test.prune.disk")(function* () {
  const fs = yield* FileSystem.FileSystem
  const fixture = yield* Fixture
  const buffers = yield* Effect.forEach([fixture.file, `${fixture.file}-wal`], (file) =>
    fs.readFile(file).pipe(Effect.catch(() => Effect.succeed(new Uint8Array()))),
  )
  return Buffer.concat(buffers)
})

it.live("delete-all removes attachments and vacuums", () =>
  Effect.gen(function* () {
    const context = yield* seed("ses_prune_all")
    const database = yield* Database.Service
    const prune = yield* ComputerPrune.Service
    const events = yield* EventV2.Service
    const first = part(context, "prt_prune_all")
    yield* store(first)
    // A second historical version must disappear too, rather than simply appending a sanitized latest version.
    yield* store({ ...first, state: { ...first.state, metadata: { action: "screenshot", changed: true } } })
    yield* database.db
      .insert(PublicSessionShareTable)
      .values({
        session_id: context.sessionID,
        id: "a".repeat(32),
        secret: "b".repeat(64),
        owner: "test-owner",
        engine: "v1",
        expires_at: 100_000,
        updated_at: 1,
        revision: 1,
        content_hash: "c".repeat(64),
        updates: false,
        state: "creating",
        initial_archive: {
          version: 1,
          engine: "v1",
          title: "Pending manual share",
          messages: [
            {
              id: context.messageID,
              role: "assistant",
              createdAt: 1,
              parts: [
                {
                  type: "tool",
                  name: "computer",
                  callID: first.callID,
                  status: "completed",
                  input: "{}",
                  output: "Window",
                  screenshots: [{ name: "Screen", mediaType: "image/png", url: uri }],
                },
              ],
            },
          ],
        },
      })
      .run()
    yield* database.db.run("PRAGMA wal_checkpoint(PASSIVE)")
    expect((yield* disk()).includes(Buffer.from(marker))).toBe(true)
    const notified: unknown[] = []
    const unsubscribe = yield* events.listen((event) =>
      Effect.sync(() => {
        if (event.type === SessionV1.Event.PartUpdated.type) notified.push(event.data)
      }),
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    expect(yield* prune.prune({ all: true })).toEqual({ removed: 1 })
    const saved = yield* read(first.id)
    expect(saved).toMatchObject({
      state: { output: "A window is visible.", metadata: { screenshotRemoved: true, changed: true } },
    })
    expect(JSON.stringify(saved)).not.toContain(marker)
    expect(JSON.stringify(yield* database.db.select().from(EventTable).all())).not.toContain(marker)
    expect(JSON.stringify(yield* database.db.select().from(PublicSessionShareTable).all())).not.toContain(marker)
    expect(notified).toHaveLength(0)
    expect(JSON.stringify(notified)).not.toContain(marker)
    expect((yield* disk()).includes(Buffer.from(marker))).toBe(false)
    expect(yield* database.db.get<{ freelist_count: number }>(sql`PRAGMA freelist_count`)).toEqual({
      freelist_count: 0,
    })
    expect(yield* prune.prune({ all: true })).toEqual({ removed: 0 })
  }),
)

it.live("before and sessionID scope pruning and keep other tool attachments intact", () =>
  Effect.gen(function* () {
    const first = yield* seed("ses_prune_first")
    const second = yield* seed("ses_prune_second")
    const old = part(first, "prt_prune_old", 10)
    const boundary = part(first, "prt_prune_boundary", 20)
    const otherSession = part(second, "prt_prune_other_session", 10)
    const otherTool = part(first, "prt_prune_other_tool", 10, "read")
    for (const value of [old, boundary, otherSession, otherTool]) yield* store(value)
    const prune = yield* ComputerPrune.Service
    expect(yield* prune.prune({ before: 20, sessionID: first.sessionID })).toEqual({ removed: 1 })
    expect(JSON.stringify(yield* read(old.id))).not.toContain(marker)
    for (const value of [boundary, otherSession, otherTool])
      expect(JSON.stringify(yield* read(value.id))).toContain(marker)
    expect(yield* prune.prune({ before: 20 })).toEqual({ removed: 1 })
    expect(JSON.stringify(yield* read(otherSession.id))).not.toContain(marker)
    expect(yield* prune.prune({ sessionID: first.sessionID })).toEqual({ removed: 1 })
    expect(JSON.stringify(yield* read(boundary.id))).not.toContain(marker)
    expect(JSON.stringify(yield* read(otherTool.id))).toContain(marker)
  }),
)

it.live("historical-only screenshots are erased and late completion or replay cannot restore them", () =>
  Effect.gen(function* () {
    const context = yield* seed("ses_prune_historical")
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    const sessions = yield* Session.Service
    const prune = yield* ComputerPrune.Service
    const stale = part(context, "prt_prune_deleted")
    const original = yield* store(stale)
    if (!original.durable) throw new Error("Expected a durable screenshot event")
    yield* events.publish(SessionV1.Event.PartRemoved, {
      sessionID: context.sessionID,
      messageID: context.messageID,
      partID: stale.id,
    })
    expect(yield* read(stale.id)).toBeUndefined()
    expect(yield* prune.prune({ all: true })).toEqual({ removed: 0 })
    expect((yield* disk()).includes(Buffer.from(marker))).toBe(false)
    // Exact replay still succeeds even though retention intentionally rewrote its screenshot payload.
    yield* events.replay({
      id: original.id,
      aggregateID: context.sessionID,
      seq: original.durable.seq,
      type: EventV2.versionedType(original.type, original.durable.version),
      data: Schema.encodeUnknownSync(SessionV1.Event.PartUpdated.data)(original.data) as Record<string, unknown>,
    })
    const returned = yield* sessions.updatePart(stale)
    expect(returned.state.status).toBe("completed")
    expect(JSON.stringify(returned)).not.toContain(marker)
    expect(JSON.stringify(yield* read(stale.id))).not.toContain(marker)
    expect(JSON.stringify(yield* database.db.select().from(EventTable).all())).not.toContain(marker)
    expect((yield* disk()).includes(Buffer.from(marker))).toBe(false)
  }),
)

it.live("native imported computer media and duplicate provider result envelopes are pruned", () =>
  Effect.gen(function* () {
    const context = yield* seed("ses_prune_native")
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    const prune = yield* ComputerPrune.Service
    const id = "native_computer_call"
    const message = {
      id: "msg_native_prune",
      type: "assistant",
      agent: "build",
      model: { providerID: "test", id: "test", variant: "default" },
      time: { created: 1, completed: 10 },
      content: [
        {
          type: "tool",
          id,
          name: "computer",
          time: { created: 2, completed: 10 },
          state: {
            status: "completed",
            input: {},
            structured: { title: "Native screen" },
            content: [
              { type: "text", text: "A window" },
              { type: "file", uri, mime: "image/png" },
            ],
            attachments: [{ uri, mime: "image/png" }],
            result: { type: "content", value: [{ type: "file", uri, mime: "image/png" }] },
          },
        },
      ],
    }
    const { SessionEvent } = yield* Effect.promise(() => import("@vectordevai/schema/session-event"))
    yield* events.publish(
      SessionEvent.MessageImported,
      Schema.decodeUnknownSync(SessionEvent.MessageImported.data)({
        sessionID: context.sessionID,
        timestamp: 10,
        message,
      }),
    )
    expect(yield* prune.prune({ all: true })).toEqual({ removed: 1 })
    const rows = yield* database.db
      .select()
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.session_id, context.sessionID))
      .all()
    expect(JSON.stringify(rows)).toContain("screenshotRemoved")
    expect(JSON.stringify(rows)).toContain("A window")
    expect(JSON.stringify(rows)).not.toContain(marker)
    expect(JSON.stringify(yield* database.db.select().from(EventTable).all())).not.toContain(marker)
    expect((yield* disk()).includes(Buffer.from(marker))).toBe(false)
    yield* events.publish(
      SessionEvent.Tool.Success,
      Schema.decodeUnknownSync(SessionEvent.Tool.Success.data)({
        sessionID: context.sessionID,
        timestamp: 11,
        assistantMessageID: message.id,
        callID: id,
        structured: message.content[0].state.structured,
        content: message.content[0].state.content,
        result: message.content[0].state.result,
        provider: { executed: true },
      }),
    )
    expect(JSON.stringify(yield* database.db.select().from(EventTable).all())).not.toContain(marker)
  }),
)

it.live("an empty or contradictory prune selection is rejected before deleting anything", () =>
  Effect.gen(function* () {
    const context = yield* seed("ses_prune_invalid")
    const value = part(context, "prt_prune_invalid")
    yield* store(value)
    const prune = yield* ComputerPrune.Service
    for (const input of [
      {},
      { all: false },
      { all: true, before: 20 },
      { all: true, sessionID: context.sessionID },
      { before: -1 },
      { before: Infinity },
    ]) {
      const result = yield* prune.prune(input).pipe(Effect.result)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure.code).toBe("invalid")
    }
    expect(JSON.stringify(yield* read(value.id))).toContain(marker)
  }),
)
