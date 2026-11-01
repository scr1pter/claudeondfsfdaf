import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import path from "node:path"
import { Context, DateTime, Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
import { eq } from "drizzle-orm"
import { PublicSession } from "@vectordevai/schema/public-session"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { makeGlobalNode } from "../src/effect/app-node"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { EventTable } from "../src/event/sql"
import { FreeModels } from "../src/free-models"
import { PublicSessionShare } from "../src/public-session-share"
import { SessionArchive } from "../src/share/archive"
import { PublicSessionShareTable } from "../src/share/public.sql"
import { makeShareTransport, shareID } from "../src/share/transport"
import { SessionV1 } from "../src/v1/session"
import { SessionEvent } from "../src/session/event"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"
import { SessionMessage } from "../src/session/message"
import { SessionSchema } from "../src/session/schema"
import { SessionAudience } from "../src/session/audience"
import { SessionTable, SessionInputTable, SessionMessageTable, MessageTable, PartTable } from "../src/session/sql"
import { BrainSchema } from "../src/brain/schema"
import { AbsolutePath } from "../src/schema"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"
import { adjust } from "effect/testing/TestClock"

const token = `vct_${Buffer.from(JSON.stringify({ sub: "synthetic-owner" })).toString("base64url")}.synthetic`
const source: PublicSession.Archive = {
  version: 1,
  engine: "v2",
  title: "Imported history",
  messages: [
    { id: "source-user", role: "user", createdAt: 1, parts: [{ type: "text", text: "Visible question" }] },
    {
      id: "source-assistant",
      role: "assistant",
      createdAt: 2,
      parts: [
        {
          type: "tool",
          name: "bash",
          callID: "source-call",
          status: "interrupted",
          input: "touch NEVER_EXECUTE",
          output: "Visible output",
        },
      ],
    },
  ],
}

function remoteFixture() {
  const snapshots = new Map<string, PublicSession.Snapshot>()
  const tombstones = new Set<string>()
  const requests: { method: string; id: string; body?: unknown }[] = []
  const state = {
    loseCreate: false,
    rejectDelete: false,
    rejectUpdate: false,
    holdUpdate: undefined as Promise<void> | undefined,
    updateStarted: undefined as (() => void) | undefined,
  }
  const request = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = init?.method ?? "GET"
      const value = init?.body ? JSON.parse(String(init.body)) : undefined
      const id = url.pathname.split("/").at(-1) === "shares" ? value.id : url.pathname.split("/").at(-1)!
      requests.push({ method, id, body: value })
      if (method === "DELETE") {
        if (state.rejectDelete) return new Response("unavailable", { status: 503 })
        snapshots.delete(id)
        tombstones.add(id)
        return new Response(null, { status: 204 })
      }
      if (tombstones.has(id)) return new Response("removed", { status: method === "GET" ? 404 : 409 })
      if (method === "GET")
        return snapshots.has(id) ? Response.json(snapshots.get(id)) : new Response("missing", { status: 404 })
      if (method === "POST") {
        const archive = Schema.decodeUnknownSync(PublicSession.Create)(value)
        const existing = snapshots.get(id)
        const saved = existing ?? {
          id,
          url: `https://vectordev.ai/s/${id}`,
          expiresAt: archive.expiresAt,
          updatedAt: Date.now(),
          revision: 0,
          updates: archive.consent.updates,
          archive: archive.archive,
        }
        snapshots.set(id, saved)
        if (state.loseCreate) {
          state.loseCreate = false
          throw new Error("synthetic lost response")
        }
        const { archive: _, ...info } = saved
        return Response.json(info)
      }
      if (state.rejectUpdate) return new Response("unavailable", { status: 503 })
      const update = Schema.decodeUnknownSync(PublicSession.Update)(value)
      const current = snapshots.get(id)
      if (!current || update.revision !== current.revision) return new Response("conflict", { status: 409 })
      const saved = { ...current, revision: current.revision + 1, updatedAt: Date.now(), archive: update.archive }
      snapshots.set(id, saved)
      state.updateStarted?.()
      await state.holdUpdate
      const { archive: _, ...info } = saved
      return Response.json(info)
    },
    { preconnect: fetch.preconnect },
  )
  return { snapshots, tombstones, requests, state, fetch: request }
}
class Remote extends Context.Service<Remote, ReturnType<typeof remoteFixture>>()("test/PublicShareRemote") {}
const remoteLayer = Layer.sync(Remote, remoteFixture)
const remoteNode = makeGlobalNode({ service: Remote, layer: remoteLayer, deps: [] })
const sharing = Layer.unwrap(Effect.map(Remote, (remote) => PublicSessionShare.layerWith({ fetch: remote.fetch })))
const sharingNode = makeGlobalNode({
  service: PublicSessionShare.Service,
  layer: sharing,
  deps: [Database.node, SessionArchive.node, EventV2.node, FreeModels.credentialsNode, remoteNode],
})
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      PublicSessionShare.node,
      SessionArchive.node,
      Database.node,
      EventV2.node,
      FreeModels.credentialsNode,
      remoteNode,
    ]),
    [
      [PublicSessionShare.node, sharingNode],
      [FreeModels.credentialsNode, Layer.succeed(FreeModels.CredentialsService, { get: () => Effect.succeed(token) })],
    ],
  ),
)
const restarted = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([SessionArchive.node, Database.node, EventV2.node, FreeModels.credentialsNode, remoteNode]),
    [[FreeModels.credentialsNode, Layer.succeed(FreeModels.CredentialsService, { get: () => Effect.succeed(token) })]],
  ),
)

const setup = Effect.gen(function* () {
  const archives = yield* SessionArchive.Service
  return yield* archives.import({ archive: source, location: { directory: AbsolutePath.make("/tmp") } })
})
const ownerSetup = (engine: "v1" | "v2" = "v2") =>
  Effect.gen(function* () {
    const archives = yield* SessionArchive.Service
    const id = SessionSchema.ID.create()
    const info = {
      id,
      projectID: "global",
      title: "Owner history",
      time: { created: 1, updated: 2 },
    }
    const messages = ["Owner question", "Owner follow-up"].map((text, index) => ({
      id: SessionMessage.ID.create(),
      text,
      time: { created: index + 1 },
    }))
    return yield* archives.import({
      archive:
        engine === "v2"
          ? {
              format: "vector-session",
              version: 1,
              engine,
              info: {
                ...info,
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                location: { directory: "/tmp" },
              },
              messages: messages.map((message) => ({ ...message, type: "user" })),
            }
          : {
              info: { ...info, slug: "owner-fixture", directory: "/tmp", version: "fixture" },
              messages: messages.map((message) => ({
                info: {
                  id: message.id,
                  sessionID: id,
                  role: "user",
                  time: message.time,
                  agent: "build",
                  model: { providerID: "vector", modelID: "fixture" },
                },
                parts: [
                  {
                    id: SessionV1.PartID.ascending(),
                    messageID: message.id,
                    sessionID: id,
                    type: "text",
                    text: message.text,
                  },
                ],
              })),
            },
      location: { directory: AbsolutePath.make("/tmp") },
    })
  })
const consent = { version: 1, public: true, updates: true } as const
const publish = (sessionID: SessionSchema.ID, updates = true) => ({
  sessionID,
  consent: { ...consent, updates },
  expiresAt: Date.now() + 60_000,
})
const edit = (sessionID: SessionSchema.ID, text = "New visible question") =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    yield* events.publish(SessionEvent.MessageImported, {
      sessionID,
      timestamp: DateTime.makeUnsafe(3),
      message: SessionMessage.User.make({
        id: SessionMessage.ID.create(),
        type: "user",
        text,
        time: { created: DateTime.makeUnsafe(3) },
      }),
    })
  })

it.effect("private conversations keep owner-local archives but cannot be published", () =>
  Effect.gen(function* () {
    const session = yield* ownerSetup()
    const shares = yield* PublicSessionShare.Service
    const remote = yield* Remote
    const database = yield* Database.Service
    const audience = SessionAudience.make(database)
    yield* audience.fenceIsolation({ sessionID: session.sessionID, actor: "owner" })
    expect((yield* shares.preview(session)).messages).toHaveLength(2)
    expect((yield* shares.export(session)).privacy).toBe("owner-only")
    expect((yield* shares.publish(publish(session.sessionID)).pipe(Effect.flip)).code).toBe("INVALID")
    expect(remote.requests).toEqual([])
  }),
)

for (const engine of ["v1", "v2"] as const) {
  it.effect(`${engine} local exports preserve private history through known and unknown-source imports`, () =>
    Effect.gen(function* () {
      const archives = yield* SessionArchive.Service
      const shares = yield* PublicSessionShare.Service
      const remote = yield* Remote
      const database = yield* Database.Service
      const audience = SessionAudience.make(database)
      const original = yield* ownerSetup(engine)
      yield* audience.fenceIsolation({ sessionID: original.sessionID, actor: "owner" })
      const exported = yield* archives.export(original)
      expect(exported.privacy).toBe("owner-only")
      const events = yield* EventV2.Service
      const observed: boolean[] = []
      const off = yield* events.listen((event) => {
        if (event.type !== SessionV1.Event.Created.type) return Effect.void
        const data = event.data as typeof SessionV1.Event.Created.data.Type
        return audience.isPrivate(data.sessionID).pipe(
          Effect.tap((value) => Effect.sync(() => observed.push(value))),
          Effect.asVoid,
        )
      })
      yield* Effect.addFinalizer(() => off)
      const encoded =
        "engine" in exported
          ? Schema.encodeSync(SessionArchive.Native)(exported)
          : Schema.encodeSync(SessionArchive.Legacy)(exported)
      const known = yield* archives.import({
        archive: { ...encoded, privacy: undefined },
        location: { directory: AbsolutePath.make("/tmp") },
      })
      expect(yield* audience.isPrivate(known.sessionID)).toBe(true)
      const foreignID = SessionSchema.ID.create()
      expect(yield* audience.knows(foreignID)).toBe(false)
      const portable = structuredClone(encoded)
      // The decoded archive type is readonly; edit the cloned wire object through a plain record view.
      const info: Record<string, unknown> = portable.info
      info.id = foreignID
      delete info.parentID
      delete info.metadata
      const imported = yield* archives.import({ archive: portable, location: { directory: AbsolutePath.make("/tmp") } })
      expect(yield* audience.isPrivate(imported.sessionID)).toBe(true)
      expect(observed).toEqual([true, true])
      expect((yield* shares.preview(imported)).messages).toHaveLength(2)
      expect((yield* shares.export(imported)).privacy).toBe("owner-only")
      expect((yield* shares.publish(publish(imported.sessionID)).pipe(Effect.flip)).code).toBe("INVALID")
      expect(remote.requests).toEqual([])
    }),
  )

  it.effect(
    `${engine} local exports preserve guest provenance before known and unknown-source import notifications`,
    () =>
      Effect.gen(function* () {
        const archives = yield* SessionArchive.Service
        const database = yield* Database.Service
        const audience = SessionAudience.make(database)
        const original = yield* ownerSetup(engine)
        yield* audience.markGuest(original.sessionID)
        const exported = yield* archives.export(original)
        expect(exported.guestInput).toBe(true)
        const encoded =
          "engine" in exported
            ? Schema.encodeSync(SessionArchive.Native)(exported)
            : Schema.encodeSync(SessionArchive.Legacy)(exported)
        const events = yield* EventV2.Service
        const observed: boolean[] = []
        const off = yield* events.listen((event) => {
          if (event.type !== SessionV1.Event.Created.type) return Effect.void
          const data = event.data as typeof SessionV1.Event.Created.data.Type
          return audience.hasGuestInput(data.sessionID).pipe(
            Effect.tap((value) => Effect.sync(() => observed.push(value))),
            Effect.asVoid,
          )
        })
        yield* Effect.addFinalizer(() => off)
        const known = { ...encoded }
        delete known.guestInput
        const adopted = yield* archives.import({ archive: known, location: { directory: AbsolutePath.make("/tmp") } })
        const portable = structuredClone(encoded)
        const info: Record<string, unknown> = portable.info
        info.id = SessionSchema.ID.create()
        delete info.parentID
        delete info.metadata
        expect(yield* audience.knows(portable.info.id)).toBe(false)
        const imported = yield* archives.import({
          archive: portable,
          location: { directory: AbsolutePath.make("/tmp") },
        })
        expect(observed).toEqual([true, true])
        for (const session of [adopted, imported]) {
          expect(yield* audience.hasGuestInput(session.sessionID)).toBe(true)
          expect(yield* audience.canIsolate(session.sessionID, "owner")).toBe(false)
          expect((yield* archives.export(session)).guestInput).toBe(true)
        }
      }),
  )
}

// A terminal export beside the desktop app's engine: the export only reads, so it never waits on, or holds back, that
// engine's writes (a write lock would make each side wait for SQLite's busy timeout and then fail). It runs outside the
// file's shared layer so that its archive service reads this database file.
test("a local export reads beside another engine's open write transaction", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(Effect.promise(tmpdir), (value) =>
      Effect.promise(() => value[Symbol.asyncDispose]()),
    )
    const file = path.join(directory.path, "vector.db")
    yield* Effect.gen(function* () {
      const session = yield* ownerSetup("v1")
      const archives = yield* SessionArchive.Service
      // A second connection, as another engine on the same data folder has.
      const sqlite = yield* Effect.promise(() => import("bun:sqlite"))
      const other = yield* Effect.acquireRelease(
        Effect.sync(() => new sqlite.Database(file)),
        (connection) => Effect.sync(() => connection.close()),
      )
      other.exec("BEGIN IMMEDIATE")
      const exported = yield* archives.export(session).pipe(Effect.timeout("3 seconds"))
      other.exec("ROLLBACK")
      expect(exported.messages).toHaveLength(2)
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(LayerNode.group([SessionArchive.node, Database.node, EventV2.node]), [
          [Database.node, makeGlobalNode({ service: Database.Service, layer: Database.layerFromPath(file), deps: [] })],
        ]),
      ),
    )
  }).pipe(Effect.scoped, Effect.runPromise))

// A live share keeps updating while the desktop app's engine writes beside it. Its capture reads the history and its
// privacy flag in one snapshot and builds, encodes and scans the archive after that, so it takes no write lock: it never
// waits on another engine's write transaction (which, once SQLite's busy timeout ran out, failed the update), and never
// holds that engine's writes back for a whole archive build.
test("a live share captures its update beside another engine's open write transaction", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(Effect.promise(tmpdir), (value) =>
      Effect.promise(() => value[Symbol.asyncDispose]()),
    )
    const file = path.join(directory.path, "vector.db")
    yield* Effect.gen(function* () {
      const session = yield* ownerSetup()
      const shares = yield* PublicSessionShare.Service
      const remote = yield* Remote
      yield* shares.publish(publish(session.sessionID))
      yield* edit(session.sessionID, "LIVE_UPDATE_BESIDE_ANOTHER_WRITER")
      const started = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()))
      remote.state.updateStarted = started.resolve
      remote.state.holdUpdate = release.promise
      // A second connection, as another engine on the same data folder has.
      const sqlite = yield* Effect.promise(() => import("bun:sqlite"))
      const other = yield* Effect.acquireRelease(
        Effect.sync(() => new sqlite.Database(file)),
        (connection) => Effect.sync(() => connection.close()),
      )
      other.exec("BEGIN IMMEDIATE")
      const sending = yield* shares.flush(session.sessionID).pipe(Effect.forkChild)
      // The update is on the network while the other engine still holds its write transaction.
      yield* Effect.promise(() => started.promise).pipe(Effect.timeout("3 seconds"))
      other.exec("ROLLBACK")
      release.resolve()
      yield* Fiber.join(sending)
      expect(JSON.stringify(remote.requests)).toContain("LIVE_UPDATE_BESIDE_ANOTHER_WRITER")
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(
          LayerNode.group([
            PublicSessionShare.node,
            SessionArchive.node,
            Database.node,
            EventV2.node,
            FreeModels.credentialsNode,
            remoteNode,
          ]),
          [
            [PublicSessionShare.node, sharingNode],
            [
              FreeModels.credentialsNode,
              Layer.succeed(FreeModels.CredentialsService, { get: () => Effect.succeed(token) }),
            ],
            [
              Database.node,
              makeGlobalNode({ service: Database.Service, layer: Database.layerFromPath(file), deps: [] }),
            ],
          ],
        ),
      ),
    )
  }).pipe(Effect.scoped, Effect.runPromise))

it.effect("public transcripts without local provenance are permanently guest-bearing on import", () =>
  Effect.gen(function* () {
    const session = yield* setup
    const database = yield* Database.Service
    const audience = SessionAudience.make(database)
    expect(yield* audience.hasGuestInput(session.sessionID)).toBe(true)
    expect(yield* audience.canIsolate(session.sessionID, "owner")).toBe(false)
  }),
)

restarted.effect("private ancestors are never uploaded by auto update, restart retry or finalizer", () =>
  Effect.gen(function* () {
    const session = yield* ownerSetup()
    const remote = yield* Remote
    const database = yield* Database.Service
    const audience = SessionAudience.make(database)
    const requests = yield* Effect.gen(function* () {
      const shares = Context.get(
        yield* Layer.build(PublicSessionShare.layerWith({ fetch: remote.fetch })),
        PublicSessionShare.Service,
      )
      yield* shares.publish({ ...publish(session.sessionID), remember: true })
      const count = remote.requests.length
      yield* audience.register({ sessionID: "ses_private_shared_child", parentID: session.sessionID })
      yield* audience.fenceIsolation({ sessionID: "ses_private_shared_child", actor: "owner" })
      yield* edit(session.sessionID, "PRIVATE_ANCESTOR_AFTER_ISOLATION")
      yield* adjust("2 seconds")
      expect((yield* shares.flush(session.sessionID).pipe(Effect.flip)).code).toBe("INVALID")
      expect(remote.requests).toHaveLength(count)
      return count
    }).pipe(Effect.scoped)
    expect(remote.requests).toHaveLength(requests)
    yield* Effect.gen(function* () {
      const shares = Context.get(
        yield* Layer.build(PublicSessionShare.layerWith({ fetch: remote.fetch })),
        PublicSessionShare.Service,
      )
      yield* adjust("2 seconds")
      expect((yield* shares.auto(session).pipe(Effect.flip))?.code).toBe("INVALID")
    }).pipe(Effect.scoped)
    expect(remote.requests).toHaveLength(requests)
    expect(JSON.stringify(remote.requests)).not.toContain("PRIVATE_ANCESTOR_AFTER_ISOLATION")
  }),
)

it.live("an in-flight public send releases SQLite and can only send its captured pre-fence body", () =>
  Effect.gen(function* () {
    const session = yield* ownerSetup()
    const shares = yield* PublicSessionShare.Service
    const remote = yield* Remote
    const database = yield* Database.Service
    const audience = SessionAudience.make(database)
    yield* shares.publish(publish(session.sessionID))
    yield* edit(session.sessionID, "PUBLIC_BEFORE_FENCE")
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()))
    remote.state.updateStarted = started.resolve
    remote.state.holdUpdate = release.promise
    const sending = yield* shares.flush(session.sessionID).pipe(Effect.forkChild)
    yield* Effect.promise(() => started.promise)
    // Holding a slow network response must not hold the SQLite writer lock or block isolation/Stop.
    yield* audience.fenceIsolation({ sessionID: session.sessionID, actor: "owner" }).pipe(Effect.timeout("2 seconds"))
    yield* edit(session.sessionID, "PRIVATE_AFTER_FENCE")
    release.resolve()
    yield* Fiber.join(sending)
    expect(JSON.stringify(remote.requests)).toContain("PUBLIC_BEFORE_FENCE")
    expect(JSON.stringify(remote.requests)).not.toContain("PRIVATE_AFTER_FENCE")
    expect((yield* shares.flush(session.sessionID).pipe(Effect.flip)).code).toBe("INVALID")
  }),
)

it.effect("public body capture refuses another family's private directory in ordinary tool output", () =>
  Effect.gen(function* () {
    const session = yield* setup
    const shares = yield* PublicSessionShare.Service
    const remote = yield* Remote
    const database = yield* Database.Service
    const audience = SessionAudience.make(database)
    const directory = path.join(path.parse(process.cwd()).root, "private-vector-task", "ses_other")
    yield* audience.fenceIsolation({ sessionID: "ses_other", actor: "owner", directory })
    yield* edit(session.sessionID, `git worktree list output: ${directory}`)
    expect(yield* audience.isPrivate(session.sessionID)).toBe(false)
    expect((yield* shares.publish(publish(session.sessionID)).pipe(Effect.flip)).code).toBe("INVALID")
    expect(remote.requests).toEqual([])
  }),
)

it.effect("native import is passive, remapped, complete, and notifications see the complete commit", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const observed: number[] = []
    yield* events.listen((event) =>
      event.type === SessionEvent.MessageImported.type
        ? db
            .select()
            .from(SessionMessageTable)
            .all()
            .pipe(
              Effect.orDie,
              Effect.map((rows) => {
                observed.push(rows.length)
              }),
            )
        : Effect.void,
    )
    const result = yield* setup
    const archives = yield* SessionArchive.Service
    const exported = yield* archives.export(result)
    expect("engine" in exported && exported.engine).toBe("v2")
    expect(exported.messages).toHaveLength(2)
    expect(JSON.stringify(exported)).not.toContain("source-user")
    expect(JSON.stringify(exported)).toContain("NEVER_EXECUTE")
    expect(yield* db.select().from(SessionInputTable).all().pipe(Effect.orDie)).toHaveLength(0)
    expect(observed).toEqual([2, 2])
    const storedEvents = yield* db.select().from(EventTable).all().pipe(Effect.orDie)
    expect(storedEvents.some((event) => event.type.includes("prompt.admitted"))).toBe(false)
    const converted = yield* archives.import({
      archive: source,
      targetEngine: "v1",
      location: { directory: AbsolutePath.make("/tmp") },
    })
    expect(converted.engine).toBe("v1")
    expect(
      yield* db
        .select()
        .from(MessageTable)
        .where(eq(MessageTable.session_id, converted.sessionID))
        .all()
        .pipe(Effect.orDie),
    ).toHaveLength(2)
    // The transcript's "user" is whoever published it, so its text is marked as outside content: memory never takes
    // it as the words of the user who continues the session.
    const parts = (yield* db
      .select()
      .from(PartTable)
      .where(eq(PartTable.session_id, converted.sessionID))
      .all()
      .pipe(Effect.orDie)).map((row) =>
      Schema.decodeUnknownSync(SessionV1.Part)({
        ...row.data,
        id: row.id,
        sessionID: row.session_id,
        messageID: row.message_id,
      }),
    )
    expect(parts.length).toBeGreaterThan(0)
    expect(parts.every((part) => part.type === "text" && part.metadata?.[BrainSchema.OUTSIDE] === "import")).toBe(true)
  }),
)

it.effect("invalid imports and failed projection roll back without notifications", () =>
  Effect.gen(function* () {
    const archives = yield* SessionArchive.Service
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    expect(
      Exit.isFailure(
        yield* archives
          .import({
            archive: { ...source, messages: [source.messages[0], source.messages[0]] },
            location: { directory: AbsolutePath.make("/tmp") },
          })
          .pipe(Effect.exit),
      ),
    ).toBe(true)
    const calls: string[] = []
    yield* events.listen((event) =>
      Effect.sync(() => {
        calls.push(event.type)
      }),
    )
    yield* events.project(SessionEvent.MessageImported, (event) =>
      event.data.message.type === "assistant" ? Effect.die("synthetic projection failure") : Effect.void,
    )
    expect(Exit.isFailure(yield* setup.pipe(Effect.exit))).toBe(true)
    expect(yield* db.select().from(SessionTable).all().pipe(Effect.orDie)).toHaveLength(0)
    expect(yield* db.select().from(SessionMessageTable).all().pipe(Effect.orDie)).toHaveLength(0)
    expect(yield* db.select().from(EventTable).all().pipe(Effect.orDie)).toHaveLength(0)
    expect(calls).toEqual([])
  }),
)

it.effect("local V1 archives retain completed attachments while public previews omit hidden prompt parts", () =>
  Effect.gen(function* () {
    const archives = yield* SessionArchive.Service
    const session = yield* archives.import({
      archive: source,
      targetEngine: "v1",
      location: { directory: AbsolutePath.make("/tmp") },
    })
    const original = yield* archives.export(session)
    if ("engine" in original) return yield* Effect.die("Expected a legacy archive")
    const user = original.messages[0]!
    const assistant = original.messages[1]!
    const base = { sessionID: session.sessionID, messageID: assistant.info.id, id: SessionV1.PartID.ascending() }
    const completed: SessionV1.Part = {
      ...base,
      type: "tool",
      tool: "read",
      callID: "original-call",
      state: {
        status: "completed",
        input: { path: "local.txt" },
        output: "Preserved output",
        title: "read",
        metadata: {},
        time: { start: 1, end: 2 },
        attachments: [
          {
            ...base,
            id: SessionV1.PartID.ascending(),
            type: "file",
            mime: "text/plain",
            filename: "local.txt",
            url: "data:text/plain,content",
          },
        ],
      },
    }
    const local = {
      ...original,
      messages: [
        {
          ...user,
          parts: [
            ...user.parts,
            {
              ...base,
              id: SessionV1.PartID.ascending(),
              messageID: user.info.id,
              type: "text" as const,
              synthetic: true,
              text: "HIDDEN_SYSTEM_CONTEXT",
            },
            {
              ...base,
              id: SessionV1.PartID.ascending(),
              messageID: user.info.id,
              type: "text" as const,
              ignored: true,
              text: "IGNORED_PROMPT",
            },
          ],
        },
        { ...assistant, parts: [...assistant.parts, completed] },
      ],
    }
    const preview = SessionArchive.publicArchive(local)
    expect(JSON.stringify(preview)).not.toContain("HIDDEN_SYSTEM_CONTEXT")
    expect(JSON.stringify(preview)).not.toContain("IGNORED_PROMPT")
    expect(JSON.stringify(preview)).toContain("Visible question")
    const imported = yield* archives.import({ archive: local, location: { directory: AbsolutePath.make("/tmp") } })
    const roundtrip = yield* archives.export(imported)
    if ("engine" in roundtrip) return yield* Effect.die("Expected a legacy roundtrip")
    const tool = roundtrip.messages[1]!.parts.find((part) => part.type === "tool")
    expect(tool?.type === "tool" && tool.state.status).toBe("completed")
    if (tool?.type !== "tool" || tool.state.status !== "completed") return yield* Effect.die("Missing completed tool")
    expect(tool.state.output).toBe("Preserved output")
    expect(tool.state.attachments?.[0]?.sessionID).toBe(imported.sessionID)
    expect(tool.state.attachments?.[0]?.messageID).toBe(roundtrip.messages[1]!.info.id)
    expect(tool.state.attachments?.[0]?.url).toBe("data:text/plain,content")
    expect(tool.callID).not.toBe("original-call")
    // A local archive may come from anyone too: its text is the archive's, not words typed in this session.
    const texts = roundtrip.messages.flatMap((message) => message.parts.filter((part) => part.type === "text"))
    expect(texts.length).toBeGreaterThan(0)
    expect(texts.every((part) => part.type === "text" && part.metadata?.[BrainSchema.OUTSIDE] === "import")).toBe(true)
  }),
)

it.effect("full native archives preserve completed structured tools and settle pending operations", () =>
  Effect.gen(function* () {
    const archives = yield* SessionArchive.Service
    const session = yield* setup
    const original = yield* archives.export(session)
    if (!("engine" in original)) return yield* Effect.die("Expected a native archive")
    const local = {
      ...original,
      messages: original.messages.map((message) =>
        message.type !== "assistant"
          ? message
          : {
              ...message,
              content: [
                ...message.content,
                SessionMessage.AssistantTool.make({
                  type: "tool",
                  id: "completed-call",
                  name: "read",
                  time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
                  state: {
                    status: "completed",
                    input: { path: "file.txt" },
                    structured: { preserved: true },
                    content: [{ type: "text", text: "Complete output" }],
                  },
                }),
                SessionMessage.AssistantTool.make({
                  type: "tool",
                  id: "pending-call",
                  name: "bash",
                  time: { created: DateTime.makeUnsafe(2) },
                  state: { status: "pending", input: "touch NEVER_EXECUTE" },
                }),
              ],
            },
      ),
    }
    const imported = yield* archives.import({
      archive: Schema.encodeSync(SessionArchive.Native)(local),
      location: { directory: AbsolutePath.make("/tmp") },
    })
    const exported = yield* archives.export(imported)
    if (!("engine" in exported)) return yield* Effect.die("Expected a native roundtrip")
    const tools = exported.messages.flatMap((message) =>
      message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : [],
    )
    expect(tools.map((tool) => tool.state.status)).toEqual(["completed", "error"])
    expect(tools[0]?.state).toMatchObject({
      structured: { preserved: true },
      content: [{ type: "text", text: "Complete output" }],
    })
    expect(tools[1]?.id).not.toBe("pending-call")
    const { db } = yield* Database.Service
    expect(yield* db.select().from(SessionInputTable).all().pipe(Effect.orDie)).toHaveLength(0)
  }),
)

it.effect("a native import counts its assistant usage in the session totals", () =>
  Effect.gen(function* () {
    const archives = yield* SessionArchive.Service
    const original = yield* archives.export(yield* setup)
    if (!("engine" in original)) return yield* Effect.die("Expected a native archive")
    const priced = {
      ...original,
      messages: original.messages.map((message) =>
        message.type !== "assistant"
          ? message
          : {
              ...message,
              cost: 1.2,
              tokens: { input: 1_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
            },
      ),
    }
    const assistants = priced.messages.filter((message) => message.type === "assistant").length
    const imported = yield* archives.import({
      archive: Schema.encodeSync(SessionArchive.Native)(priced),
      location: { directory: AbsolutePath.make("/tmp") },
    })
    const { db } = yield* Database.Service
    const row = yield* db
      .select()
      .from(SessionTable)
      .where(eq(SessionTable.id, imported.sessionID))
      .get()
      .pipe(Effect.orDie)
    expect(assistants).toBeGreaterThan(0)
    expect(row?.cost).toBeCloseTo(1.2 * assistants)
    expect(row?.tokens_input).toBe(1_000 * assistants)
  }),
)

it.effect("lost create acknowledgement retains the original snapshot then reconciles consented updates", () =>
  Effect.gen(function* () {
    const session = yield* setup
    const remote = yield* Remote
    const shares = yield* PublicSessionShare.Service
    remote.state.loseCreate = true
    expect(Exit.isFailure(yield* shares.publish(publish(session.sessionID)).pipe(Effect.exit))).toBe(true)
    yield* edit(session.sessionID)
    const info = yield* shares.flush(session.sessionID)
    expect(remote.snapshots.get(info.id)?.archive.messages).toHaveLength(3)
    expect(remote.requests.map((request) => request.method)).toEqual(["POST", "POST", "PUT"])
    expect(info.revision).toBe(1)
    yield* shares.flush(session.sessionID)
    expect(remote.requests).toHaveLength(3)
  }),
)

it.effect("snapshot-only lost acknowledgement never publishes later messages", () =>
  Effect.gen(function* () {
    const session = yield* setup
    const remote = yield* Remote
    const shares = yield* PublicSessionShare.Service
    remote.state.loseCreate = true
    const preview = yield* shares.preview(session)
    yield* shares
      .publish({
        ...publish(session.sessionID, false),
        previewHash: createHash("sha256").update(JSON.stringify(preview)).digest("hex"),
      })
      .pipe(Effect.ignore)
    yield* edit(session.sessionID)
    const info = yield* shares.flush(session.sessionID)
    expect(remote.snapshots.get(info.id)?.archive.messages).toHaveLength(2)
    expect(remote.requests.map((request) => request.method)).toEqual(["POST", "POST"])
  }),
)

it.effect("preview changes reject publication before storage or network writes", () =>
  Effect.gen(function* () {
    const session = yield* setup
    const shares = yield* PublicSessionShare.Service
    const remote = yield* Remote
    const preview = yield* shares.preview(session)
    yield* edit(session.sessionID)
    const error = yield* shares
      .publish({
        ...publish(session.sessionID, false),
        previewHash: createHash("sha256").update(JSON.stringify(preview)).digest("hex"),
      })
      .pipe(Effect.flip)
    expect(error.code).toBe("CONFLICT")
    expect(remote.requests).toHaveLength(0)
    const { db } = yield* Database.Service
    expect(yield* db.select().from(PublicSessionShareTable).all().pipe(Effect.orDie)).toHaveLength(0)
  }),
)

it.effect("failed unshare preserves secrets and legacy URL; success retains the legacy URL", () =>
  Effect.gen(function* () {
    const session = yield* setup
    const { db } = yield* Database.Service
    const remote = yield* Remote
    const shares = yield* PublicSessionShare.Service
    yield* db
      .update(SessionTable)
      .set({ share_url: "https://historical.invalid/session" })
      .where(eq(SessionTable.id, session.sessionID))
      .run()
      .pipe(Effect.orDie)
    const first = yield* shares.publish(publish(session.sessionID))
    remote.state.rejectDelete = true
    yield* shares.unshare(session.sessionID).pipe(Effect.ignore)
    const retained = yield* db.select().from(PublicSessionShareTable).get().pipe(Effect.orDie)
    expect(retained?.state).toBe("deleting")
    expect(retained?.secret).toHaveLength(64)
    remote.state.rejectDelete = false
    yield* shares.unshare(session.sessionID)
    expect(remote.tombstones.has(first.id)).toBe(true)
    const row = yield* db
      .select()
      .from(SessionTable)
      .where(eq(SessionTable.id, session.sessionID))
      .get()
      .pipe(Effect.orDie)
    expect(row?.share_url).toBe("https://historical.invalid/session")
    expect(row?.share_info).toBeNull()
    expect(yield* db.select().from(PublicSessionShareTable).all().pipe(Effect.orDie)).toHaveLength(0)
  }),
)

it.effect("a delayed writer from another service instance cannot overwrite a republished share", () =>
  Effect.gen(function* () {
    const session = yield* setup
    const remote = yield* Remote
    const first = yield* PublicSessionShare.Service
    const second = Context.get(
      yield* Layer.build(PublicSessionShare.layerWith({ fetch: remote.fetch })),
      PublicSessionShare.Service,
    )
    const old = yield* first.publish(publish(session.sessionID))
    yield* edit(session.sessionID)
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    remote.state.updateStarted = started.resolve
    remote.state.holdUpdate = release.promise
    const pending = yield* first.flush(session.sessionID).pipe(Effect.exit, Effect.forkChild)
    yield* Effect.promise(() => started.promise)
    yield* second.unshare(session.sessionID)
    const fresh = yield* second.publish(publish(session.sessionID))
    release.resolve()
    const outcome = yield* Fiber.join(pending)
    expect(Exit.isFailure(outcome)).toBe(true)
    expect(fresh.id).not.toBe(old.id)
    const { db } = yield* Database.Service
    expect((yield* db.select().from(PublicSessionShareTable).get().pipe(Effect.orDie))?.id).toBe(fresh.id)
    expect(
      (yield* db.select().from(SessionTable).where(eq(SessionTable.id, session.sessionID)).get().pipe(Effect.orDie))
        ?.share_info?.id,
    ).toBe(fresh.id)
  }),
)

restarted.effect("failed updates survive service restart and deleted shares never resume", () =>
  Effect.gen(function* () {
    const session = yield* setup
    const remote = yield* Remote
    const { db } = yield* Database.Service
    const info = yield* Effect.gen(function* () {
      const service = Context.get(
        yield* Layer.build(PublicSessionShare.layerWith({ fetch: remote.fetch })),
        PublicSessionShare.Service,
      )
      const created = yield* service.publish(publish(session.sessionID))
      remote.state.rejectUpdate = true
      yield* edit(session.sessionID)
      expect((yield* service.flush(session.sessionID).pipe(Effect.flip)).code).toBe("UNAVAILABLE")
      return created
    }).pipe(Effect.scoped)
    expect((yield* db.select().from(PublicSessionShareTable).get().pipe(Effect.orDie))?.dirty).toBe(true)
    expect(remote.snapshots.get(info.id)?.archive.messages).toHaveLength(2)
    remote.state.rejectUpdate = false
    yield* Effect.gen(function* () {
      const service = Context.get(
        yield* Layer.build(PublicSessionShare.layerWith({ fetch: remote.fetch })),
        PublicSessionShare.Service,
      )
      yield* adjust("1 second")
      expect(remote.snapshots.get(info.id)?.archive.messages).toHaveLength(3)
      expect((yield* db.select().from(PublicSessionShareTable).get().pipe(Effect.orDie))?.dirty).toBe(false)
      yield* service.unshare(session.sessionID)
    }).pipe(Effect.scoped)
    const count = remote.requests.length
    yield* Effect.gen(function* () {
      yield* Layer.build(PublicSessionShare.layerWith({ fetch: remote.fetch }))
      yield* adjust("10 seconds")
    }).pipe(Effect.scoped)
    expect(remote.requests).toHaveLength(count)
    expect(remote.snapshots.has(info.id)).toBe(false)
  }),
)

it.effect("automatic publication requires account consent for future updates", () =>
  Effect.gen(function* () {
    const session = yield* setup
    const service = yield* PublicSessionShare.Service
    const remote = yield* Remote
    expect(yield* service.auto(session)).toBeUndefined()
    expect(remote.requests).toHaveLength(0)
    const preview = yield* service.preview(session)
    yield* service.publish({
      ...publish(session.sessionID, false),
      previewHash: createHash("sha256").update(JSON.stringify(preview)).digest("hex"),
      remember: true,
    })
    const next = yield* setup
    expect(yield* service.auto(next)).toBeUndefined()
    expect(remote.requests).toHaveLength(1)
    yield* service.unshare(session.sessionID)
    yield* service.publish({ ...publish(session.sessionID), remember: true })
    expect((yield* service.auto(next))?.url).toMatch(/^https:\/\/vectordev.ai\/s\//)
  }),
)

test("public URL validation is exact and public transport rejects identity and extra data", async () => {
  for (const url of [
    "https://vectordev.ai.evil/s/" + "a".repeat(32),
    "https://vectordev.ai:443/s/" + "a".repeat(32),
    "https://vectordev.ai/s/" + "a".repeat(32) + "?secret=x",
    "http://vectordev.ai/s/" + "a".repeat(32),
  ])
    expect(() => shareID(url)).toThrow()
  const fixture = remoteFixture()
  const id = "a".repeat(32)
  fixture.snapshots.set(id, {
    id,
    url: `https://vectordev.ai/s/${id}`,
    expiresAt: Date.now() + 60000,
    updatedAt: 1,
    revision: 0,
    updates: false,
    archive: source,
  })
  const client = makeShareTransport({ token: async () => undefined, fetch: fixture.fetch })
  expect((await client.read(`https://vectordev.ai/s/${id}`)).archive).toEqual(source)
  fixture.snapshots.set(id, { ...fixture.snapshots.get(id)!, id: "b".repeat(32) })
  await expect(client.read(`https://vectordev.ai/s/${id}`)).rejects.toThrow("different share identity")
  fixture.snapshots.set(id, { ...fixture.snapshots.get(id)!, id, expiresAt: Date.now() - 1 })
  await expect(client.read(`https://vectordev.ai/s/${id}`)).rejects.toThrow("expired")
  fixture.snapshots.set(id, { ...fixture.snapshots.get(id)!, expiresAt: Date.now() + 60_000 })
  const extra = makeShareTransport({
    token: async () => undefined,
    fetch: Object.assign(async () => Response.json({ ...fixture.snapshots.get(id)!, secret: "forbidden" }), {
      preconnect: fetch.preconnect,
    }),
  })
  await expect(extra.read(`https://vectordev.ai/s/${id}`)).rejects.toThrow()
})

test("failed and DELETE requests cancel response bodies and reject redirects", async () => {
  const canceled: string[] = []
  const client = makeShareTransport({
    token: async () => token,
    fetch: Object.assign(
      async (_: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.redirect).toBe("error")
        const body = new ReadableStream({ cancel: () => void canceled.push(init?.method ?? "unknown") })
        return new Response(body, { status: init?.method === "DELETE" ? 200 : 503 })
      },
      { preconnect: fetch.preconnect },
    ),
  })
  await expect(client.read(`https://vectordev.ai/s/${"a".repeat(32)}`)).rejects.toThrow()
  await client.remove("a".repeat(32), "b".repeat(64))
  expect(canceled).toEqual(["GET", "DELETE"])
})

for (const engine of ["v1", "v2"] as const) {
  it.effect(`${engine} local archives preserve ancillary attempt identity and spend, public transcripts omit it`, () =>
    Effect.gen(function* () {
      const archives = yield* SessionArchive.Service
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      const original = yield* archives.import({
        archive: source,
        targetEngine: engine,
        location: { directory: AbsolutePath.make("/tmp") },
      })
      const usageID = EventV2.ID.create()
      yield* events.publish(
        SessionEvent.AncillaryUsage,
        {
          sessionID: original.sessionID,
          timestamp: DateTime.makeUnsafe(3),
          usageID,
          purpose: "title",
          model: { id: ModelV2.ID.make("title-model"), providerID: ProviderV2.ID.make("title-provider") },
          cost: 0.125,
          incomplete: true,
          tokens: { input: 25, output: 0, reasoning: 0, cache: { read: 5, write: 0 } },
        },
        { id: usageID },
      )
      const exported = yield* archives.export(original)
      expect(exported.ancillaryUsage).toHaveLength(1)
      expect(exported.ancillaryUsage?.[0]?.usageID).toBe(usageID)
      expect(JSON.stringify(SessionArchive.publicArchive(exported))).not.toContain("ancillaryUsage")
      const encoded =
        "engine" in exported
          ? Schema.encodeSync(SessionArchive.Native)(exported)
          : Schema.encodeSync(SessionArchive.Legacy)(exported)
      const imported = yield* archives.import({ archive: encoded, location: { directory: AbsolutePath.make("/tmp") } })
      const roundtrip = yield* archives.export(imported)
      expect(roundtrip.ancillaryUsage?.[0]).toMatchObject({
        usageID,
        sessionID: imported.sessionID,
        cost: 0.125,
        incomplete: true,
      })
      const row = yield* database.db.select().from(SessionTable).where(eq(SessionTable.id, imported.sessionID)).get()
      expect(row?.cost).toBe(0.125)
      expect(row?.unpriced_steps).toBe(1)
      expect(row?.tokens_input).toBe(25)
      const duplicate = yield* archives
        .import({
          archive: { ...encoded, ancillaryUsage: [encoded.ancillaryUsage![0], encoded.ancillaryUsage![0]] },
          location: { directory: AbsolutePath.make("/tmp") },
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(duplicate)).toBe(true)
    }),
  )

  it.effect(`${engine} local archives keep Codium records and counts, and public transcripts carry neither`, () =>
    Effect.gen(function* () {
      const archives = yield* SessionArchive.Service
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      const original = yield* archives.import({
        archive: source,
        targetEngine: engine,
        location: { directory: AbsolutePath.make("/tmp") },
      })
      const codium = { id: ModelV2.ID.make("deepseek"), providerID: ProviderV2.ID.make("vector-plan") }
      const tokens = { input: 25, output: 3, reasoning: 0, cache: { read: 5, write: 0 } }
      const usageID = EventV2.ID.create()
      yield* events.publish(
        SessionEvent.AncillaryUsage,
        {
          sessionID: original.sessionID,
          timestamp: DateTime.makeUnsafe(3),
          usageID,
          purpose: "title",
          model: codium,
          cost: 0,
          unpriced: true,
          billing: "codium",
          tokens,
        },
        { id: usageID },
      )
      const exported = yield* archives.export(original)
      expect(exported.info).toMatchObject({ unpricedSteps: 1, codiumSteps: 1 })
      // The archive's steps ran on Codium too: the assistant message, and for V1 its step-finish part, carry the flag.
      const stamped =
        "engine" in exported
          ? Schema.encodeSync(SessionArchive.Native)({
              ...exported,
              messages: exported.messages.map((message) =>
                message.type === "assistant"
                  ? { ...message, model: codium, cost: 0, unpriced: true, billing: "codium" as const, tokens }
                  : message,
              ),
            })
          : Schema.encodeSync(SessionArchive.Legacy)({
              ...exported,
              messages: exported.messages.map((message) =>
                message.info.role === "assistant"
                  ? {
                      info: {
                        ...message.info,
                        providerID: codium.providerID,
                        cost: 0,
                        unpriced: true,
                        billing: "codium" as const,
                        tokens,
                      },
                      parts: [
                        ...message.parts,
                        {
                          id: SessionV1.PartID.ascending(),
                          sessionID: message.info.sessionID,
                          messageID: message.info.id,
                          type: "step-finish" as const,
                          reason: "stop",
                          cost: 0,
                          unpriced: true,
                          billing: "codium" as const,
                          tokens,
                        },
                      ],
                    }
                  : message,
              ),
            })
      const imported = yield* archives.import({ archive: stamped, location: { directory: AbsolutePath.make("/tmp") } })
      const row = yield* database.db.select().from(SessionTable).where(eq(SessionTable.id, imported.sessionID)).get()
      // One Codium step from the transcript and one from the title, and no tokens or dollars from either.
      expect(row).toMatchObject({
        cost: 0,
        unpriced_steps: 2,
        codium_steps: 2,
        tokens_input: 0,
        tokens_output: 0,
        tokens_cache_read: 0,
      })
      const roundtrip = yield* archives.export(imported)
      expect(roundtrip.info).toMatchObject({ unpricedSteps: 2, codiumSteps: 2 })
      expect(roundtrip.ancillaryUsage?.[0]).toMatchObject({ usageID, billing: "codium", tokens })
      // The local archive keeps each step's flag beside its own tokens (label plan D-2).
      expect(
        "engine" in roundtrip
          ? roundtrip.messages.flatMap((message) =>
              message.type === "assistant" ? [{ billing: message.billing, tokens: message.tokens }] : [],
            )
          : roundtrip.messages.flatMap((message) =>
              message.parts.flatMap((part) =>
                part.type === "step-finish" ? [{ billing: part.billing, tokens: part.tokens }] : [],
              ),
            ),
      ).toMatchObject([{ billing: "codium", tokens }])
      const shared = JSON.stringify(SessionArchive.publicArchive(roundtrip))
      for (const key of ["billing", "codiumSteps", "subagentCodiumSteps", "unpriced", "cost", "tokens"])
        expect(shared).not.toContain(`"${key}"`)
    }),
  )

  it.effect(`${engine} local archives keep the usage an older build wrote beside the model learner's`, () =>
    Effect.gen(function* () {
      const archives = yield* SessionArchive.Service
      const events = yield* EventV2.Service
      const original = yield* archives.import({
        archive: source,
        targetEngine: engine,
        location: { directory: AbsolutePath.make("/tmp") },
      })
      const usage = {
        sessionID: original.sessionID,
        timestamp: DateTime.makeUnsafe(3),
        model: { id: ModelV2.ID.make("small-model"), providerID: ProviderV2.ID.make("small-provider") },
        tokens: { input: 4, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      }
      // A title's usage as builds before the model learner wrote it, version 1, and the learner's, version 2.
      const older = { ...usage, usageID: EventV2.ID.create(), purpose: "title" as const, cost: 0.25 }
      yield* events.publish(SessionEvent.AncillaryUsageV1, older, { id: older.usageID })
      const learner = { ...usage, usageID: EventV2.ID.create(), purpose: "memory" as const, cost: 0.5 }
      yield* events.publish(SessionEvent.AncillaryUsage, learner, { id: learner.usageID })
      const exported = yield* archives.export(original)
      expect(exported.ancillaryUsage?.map((item) => [item.purpose, item.cost])).toEqual([
        ["title", 0.25],
        ["memory", 0.5],
      ])
      // An older build decodes version 1 alone, so it skips the learner's usage rather than failing on it.
      const encoded = Schema.encodeSync(SessionEvent.AncillaryUsage.data)(
        SessionEvent.AncillaryUsage.data.make(learner),
      )
      expect(Option.isNone(Schema.decodeUnknownOption(SessionEvent.AncillaryUsageV1.data)(encoded))).toBe(true)
    }),
  )
}
