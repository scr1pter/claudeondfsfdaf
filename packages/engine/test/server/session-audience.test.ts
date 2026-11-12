import { afterEach, expect } from "bun:test"
import { gzipSync } from "node:zlib"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect"
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { Flag } from "@vectordevai/core/flag/flag"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Database } from "@vectordevai/core/database/database"
import { SessionAudience } from "@vectordevai/core/session/audience"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { SessionAudienceHttp } from "@vectordevai/server/session-audience"
import { Session } from "@/session/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { eventResponse } from "@/server/routes/instance/httpapi/handlers/event"
import { globalEventResponse } from "@/server/routes/instance/httpapi/handlers/global"
import { GlobalBus } from "@/bus/global"
import { RequestOwner } from "@vectordevai/server/request-owner"
import { allowsSessionLocation } from "@/server/routes/instance/httpapi/handlers/session-access"
import { TestInstance, disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const services = AppNodeBuilder.build(
  LayerNode.group([Session.node, SessionAudience.node, EventV2Bridge.node, CrossSpawnSpawner.node, Database.node]),
)
const it = testEffect(Layer.mergeAll(services, httpApiLayer))
const relay = { "x-vector-guest-request": "1", "content-type": "application/json" }
const options = { trusted: true, git: true, config: { formatter: false, lsp: false } } as const

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

it.instance(
  "raw private families stay hidden from forwarded owners and explicit guest controllers",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const sessions = yield* Session.Service
      const audience = yield* SessionAudience.Service
      const root = yield* sessions.create({ title: "private root" })
      const child = yield* sessions.create({ parentID: root.id })
      const visible = yield* sessions.create({ title: "public root" })
      const work = yield* tmpdirScoped()
      yield* audience.fenceIsolation({ sessionID: child.id, actor: "owner", directory: work })
      const controller = {
        kind: "guest" as const,
        username: "guest",
        sessionIDs: new Set([root.id]),
        workspaceIDs: new Set<string>(),
        workspaceDirectories: new Map<string, string>(),
      }
      expect(yield* allowsSessionLocation(controller, root)).toBe(false)
      for (const route of [
        `/session/${root.id}`,
        `/session/${root.id}/message`,
        `/session/${root.id}/diff`,
        `/api/session/${root.id}`,
        `/api/session/${root.id}/history`,
      ])
        expect((yield* requestInDirectory(route, directory, { headers: relay })).status).toBe(403)
      expect((yield* requestInDirectory(`/session/${root.id}`, directory)).status).toBe(200)
      const listed = yield* requestInDirectory("/session", directory, { headers: relay })
      expect(listed.status).toBe(200)
      const rows = (yield* listed.json) as { id: string }[]
      expect(rows.map((item) => item.id)).toContain(visible.id)
      expect(rows.map((item) => item.id)).not.toContain(root.id)
      for (const route of ["/event", "/api/agent"])
        expect((yield* requestInDirectory(route, work, { headers: relay })).status).toBe(403)
    }),
  options,
)

it.instance(
  "a forwarded guest input is durably recorded before an owner can launch isolation",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const audience = yield* SessionAudience.Service
      const events = yield* EventV2Bridge.Service
      const admitted: boolean[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.gen(function* () {
          const data = event.data
          if (
            event.type !== SessionV1.Event.Created.type ||
            !data ||
            typeof data !== "object" ||
            !("sessionID" in data) ||
            typeof data.sessionID !== "string"
          )
            return
          admitted.push(yield* audience.hasGuestInput(data.sessionID))
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const response = yield* requestInDirectory("/session", directory, { method: "POST", headers: relay, body: "{}" })
      expect(response.status).toBe(200)
      const created = (yield* response.json) as { id: string }
      expect(yield* audience.hasGuestInput(created.id)).toBe(true)
      const fenced = yield* audience.fenceIsolation({ sessionID: created.id, actor: "owner" }).pipe(Effect.exit)
      expect(Exit.isFailure(fenced)).toBe(true)
      if (Exit.isFailure(fenced)) expect(Cause.squash(fenced.cause)).toMatchObject({ reason: "guest_input" })
      const v2 = yield* requestInDirectory("/api/session", directory, {
        method: "POST",
        headers: relay,
        body: JSON.stringify({ location: { directory }, title: "guest V2 session" }),
      })
      expect(v2.status).toBe(200)
      expect(admitted).toEqual([true, true])
      const forged = yield* requestInDirectory("/session", directory, {
        method: "POST",
        headers: relay,
        body: JSON.stringify({ metadata: { subagent: { isolation: { mode: "worktree" } } } }),
      })
      expect(forged.status).toBe(403)
      expect(admitted).toEqual([true, true])
      expect(
        (yield* requestInDirectory("/sync/history", directory, { method: "POST", headers: relay, body: "{}" })).status,
      ).toBe(403)
    }),
  options,
)

it.instance(
  "replication leaves out an ordinary conversation whose events show a private folder, and the rest still arrives",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const sessions = yield* Session.Service
      const audience = yield* SessionAudience.Service
      const events = yield* EventV2Bridge.Service
      const replication = { [RequestOwner.REPLICATION_HEADER]: "1", "content-type": "application/json" }
      const root = yield* sessions.create({})
      const child = yield* sessions.create({ parentID: root.id })
      const work = yield* tmpdirScoped()
      yield* audience.fenceIsolation({ sessionID: child.id, actor: "owner", directory: work })
      // An unrelated conversation in the same repository lists the worktrees, so its own history now shows the private
      // folder. It is not private or guest-input itself.
      const listing = yield* sessions.create({})
      const publicSession = yield* sessions.create({})
      yield* events.publish(SessionV1.Event.Updated, {
        sessionID: listing.id,
        info: { ...listing, title: `git worktree list: ${work}` },
      })
      yield* events.publish(SessionV1.Event.Updated, {
        sessionID: publicSession.id,
        info: { ...publicSession, title: "replication-public-after-listing" },
      })
      expect(yield* audience.isPrivate(listing.id)).toBe(false)
      expect(yield* audience.hasGuestInput(listing.id)).toBe(false)

      const replicated = yield* requestInDirectory("/sync/history", directory, {
        method: "POST",
        headers: replication,
        body: "{}",
      })
      expect(replicated.status).toBe(200)
      const text = yield* replicated.text
      // The body is JSON, which escapes a Windows path's backslashes.
      const encoded = JSON.stringify(work).slice(1, -1)
      expect(text).not.toContain(encoded)
      const aggregates = new Set((JSON.parse(text) as { aggregate_id: string }[]).map((event) => event.aggregate_id))
      expect(aggregates.has(publicSession.id)).toBe(true)
      for (const id of [listing.id, root.id, child.id]) expect(aggregates.has(id)).toBe(false)
      // A warp of the conversation left out is refused; one of the public conversation still replicates.
      for (const [id, status] of [
        [listing.id, 403],
        [publicSession.id, 200],
      ] as const)
        expect(
          (yield* requestInDirectory("/sync/history", directory, {
            method: "POST",
            headers: { ...replication, [RequestOwner.TRANSFER_HEADER]: id },
            body: "{}",
          })).status,
        ).toBe(status)
      // The owner's ordinary read is unchanged.
      const ordinary = yield* requestInDirectory("/sync/history", directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
      expect(ordinary.status).toBe(200)
      expect(yield* ordinary.text).toContain(encoded)
    }),
  options,
)

it.instance(
  "replication omits private and guest-input history per conversation, keeps public history, and a warp of a restricted one is refused",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const sessions = yield* Session.Service
      const audience = yield* SessionAudience.Service
      const events = yield* EventV2Bridge.Service
      const root = yield* sessions.create({})
      const publicSession = yield* sessions.create({})
      const replication = { [RequestOwner.REPLICATION_HEADER]: "1", "content-type": "application/json" }
      expect(
        (yield* requestInDirectory("/sync/history", directory, { method: "POST", headers: replication, body: "{}" }))
          .status,
      ).toBe(200)
      const initialListeners = GlobalBus.listenerCount("event")
      const streams = yield* Effect.forEach([replication, {}], (headers) =>
        Effect.gen(function* () {
          const request = HttpServerRequest.fromWeb(new Request("http://localhost/global/event", { headers }))
          const response = yield* globalEventResponse({ kind: "owner", username: "owner" }).pipe(
            Effect.provideService(HttpServerRequest.HttpServerRequest, request),
          )
          if (response.body._tag !== "Stream") return yield* Effect.die("Expected a streaming body")
          return yield* response.body.stream.pipe(
            Stream.takeUntil((chunk) => new TextDecoder().decode(chunk).includes("replication-public-sentinel")),
            Stream.runCollect,
            Effect.timeout("5 seconds"),
            Effect.forkScoped,
          )
        }),
      )
      yield* pollWithTimeout(
        Effect.sync(() => (GlobalBus.listenerCount("event") >= initialListeners + 2 ? true : undefined)),
        "global streams did not subscribe",
      )
      const child = yield* sessions.create({ parentID: root.id })
      const guestSession = yield* sessions.create({})
      yield* audience.markGuest(guestSession.id)
      yield* audience.fenceIsolation({ sessionID: child.id, actor: "owner" })
      yield* events.publish(SessionV1.Event.Updated, {
        sessionID: root.id,
        info: { ...root, title: "replication-private-brief" },
      })
      yield* events.publish(SessionV1.Event.Updated, {
        sessionID: guestSession.id,
        info: { ...guestSession, title: "replication-guest-brief" },
      })
      yield* events.publish(SessionV1.Event.Updated, {
        sessionID: publicSession.id,
        info: { ...publicSession, title: "replication-public-sentinel" },
      })
      const bodies = yield* Effect.forEach(streams, (fiber) =>
        Fiber.join(fiber).pipe(Effect.map((chunks) => chunks.map((chunk) => new TextDecoder().decode(chunk)).join(""))),
      )
      expect(bodies[0]).toContain("replication-public-sentinel")
      expect(bodies[0]).not.toContain("replication-private-brief")
      expect(bodies[0]).not.toContain("replication-guest-brief")
      expect(bodies[1]).toContain("replication-private-brief")
      expect(bodies[1]).toContain("replication-guest-brief")
      // One restricted conversation never blocks replication of the rest: its events are left out, the others arrive.
      const replicated = yield* requestInDirectory("/sync/history", directory, {
        method: "POST",
        headers: replication,
        body: "{}",
      })
      expect(replicated.status).toBe(200)
      const aggregates = new Set(
        ((yield* replicated.json) as { aggregate_id: string }[]).map((event) => event.aggregate_id),
      )
      expect(aggregates.has(publicSession.id)).toBe(true)
      for (const id of [root.id, child.id, guestSession.id]) expect(aggregates.has(id)).toBe(false)
      // A cursor the requester already holds for a restricted conversation gets nothing new, and no refusal.
      const known = yield* requestInDirectory("/sync/history", directory, {
        method: "POST",
        headers: replication,
        body: JSON.stringify({ [guestSession.id]: 0, [root.id]: 0 }),
      })
      expect(known.status).toBe(200)
      // A warp names the conversation it moves: a restricted one is refused, a public one replicates.
      for (const [id, status] of [
        [guestSession.id, 403],
        [child.id, 403],
        [publicSession.id, 200],
      ] as const)
        expect(
          (yield* requestInDirectory("/sync/history", directory, {
            method: "POST",
            headers: { ...replication, [RequestOwner.TRANSFER_HEADER]: id },
            body: "{}",
          })).status,
        ).toBe(status)
      const ordinary = yield* requestInDirectory("/sync/history", directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
      expect(ordinary.status).toBe(200)
      const all = new Set(((yield* ordinary.json) as { aggregate_id: string }[]).map((event) => event.aggregate_id))
      for (const id of [root.id, guestSession.id, publicSession.id]) expect(all.has(id)).toBe(true)
    }),
  options,
)

it.instance(
  "the owner's replication relay still carries unscoped events such as terminals and toasts, but a guest's does not",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const replication = { [RequestOwner.REPLICATION_HEADER]: "1" }
      const initialListeners = GlobalBus.listenerCount("event")
      const streams = yield* Effect.forEach(
        [
          { principal: { kind: "owner", username: "owner" } as const, headers: replication },
          {
            principal: {
              kind: "guest",
              username: "guest",
              workspaceIDs: new Set<string>(),
              workspaceDirectories: new Map([["wrk_relay", directory]]),
              sessionIDs: new Set<string>(),
            } as const,
            headers: replication,
          },
        ],
        (item) =>
          Effect.gen(function* () {
            const request = HttpServerRequest.fromWeb(
              new Request("http://localhost/global/event", { headers: item.headers }),
            )
            const response = yield* globalEventResponse(item.principal).pipe(
              Effect.provideService(HttpServerRequest.HttpServerRequest, request),
            )
            if (response.body._tag !== "Stream") return yield* Effect.die("Expected a streaming body")
            return yield* response.body.stream.pipe(
              Stream.takeUntil((chunk) => new TextDecoder().decode(chunk).includes("relay-sentinel")),
              Stream.runCollect,
              Effect.timeout("2 seconds"),
              Effect.option,
              Effect.forkScoped,
            )
          }),
      )
      yield* pollWithTimeout(
        Effect.sync(() => (GlobalBus.listenerCount("event") >= initialListeners + 2 ? true : undefined)),
        "global streams did not subscribe",
      )
      // The guest sees this directory, so only the emission gate keeps these unscoped events from it.
      GlobalBus.emit("event", {
        directory,
        payload: { id: "evt_relay_pty", type: "pty.created", properties: { info: { id: "pty_relay" } } },
      })
      GlobalBus.emit("event", {
        directory,
        payload: {
          id: "evt_relay_toast",
          type: "tui.toast.show",
          properties: { message: "relay-sentinel", variant: "info" },
        },
      })
      const bodies = yield* Effect.forEach(streams, (fiber) =>
        Fiber.join(fiber).pipe(
          Effect.map((chunks) =>
            chunks._tag === "Some" ? chunks.value.map((chunk) => new TextDecoder().decode(chunk)).join("") : "",
          ),
        ),
      )
      expect(bodies[0]).toContain("pty_relay")
      expect(bodies[0]).toContain("relay-sentinel")
      expect(bodies[1]).not.toContain("pty_relay")
      expect(bodies[1]).not.toContain("relay-sentinel")
    }),
  options,
)

it.instance(
  "raw ancestor filesystem selections stay private without hiding ordinary routed sessions",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const sessions = yield* Session.Service
      const audience = yield* SessionAudience.Service
      const privateSession = yield* sessions.create({})
      const publicSession = yield* sessions.create({})
      for (const root of [
        path.join(directory, "private-task", "work"),
        path.join(directory, ".git", "worktrees", "private-task"),
      ]) {
        yield* Effect.promise(() => mkdir(root, { recursive: true }))
        yield* audience.fenceIsolation({ sessionID: privateSession.id, actor: "owner", directory: root })
      }
      for (const selected of ["private-task", ".git/worktrees"])
        expect(
          (yield* requestInDirectory(`/file?path=${encodeURIComponent(selected)}`, directory, { headers: relay }))
            .status,
        ).toBe(403)
      expect((yield* requestInDirectory("/find?pattern=private", directory, { headers: relay })).status).toBe(403)
      expect((yield* requestInDirectory("/file?path=private-task", directory)).status).toBe(200)
      const target = "private-task/work/owner.txt"
      expect(
        (yield* requestInDirectory("/file/write", directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: target, content: "owner data" }),
        })).status,
      ).toBe(200)
      expect(
        (yield* requestInDirectory("/file/write", directory, {
          method: "POST",
          headers: relay,
          body: JSON.stringify({ path: target, content: "guest overwrite" }),
        })).status,
      ).toBe(403)
      expect(yield* Effect.promise(() => readFile(path.join(directory, target), "utf8"))).toBe("owner data")
      const object = ".git/objects/http-private-object"
      yield* Effect.promise(() => writeFile(path.join(directory, object), "private stored Git bytes"))
      yield* Effect.promise(() => writeFile(path.join(directory, "public.ts"), "public source bytes"))
      for (const route of [`/file/content?path=${encodeURIComponent(object)}`, `/api/fs/read/${object}`]) {
        expect((yield* requestInDirectory(route, directory, { headers: relay })).status).toBe(403)
        expect((yield* requestInDirectory(route, directory)).status).toBe(200)
      }
      expect((yield* requestInDirectory("/api/fs/list?path=private-task", directory, { headers: relay })).status).toBe(
        403,
      )
      expect((yield* requestInDirectory("/api/fs/read/public.ts", directory, { headers: relay })).status).toBe(200)
      expect((yield* requestInDirectory(`/session/${publicSession.id}`, directory, { headers: relay })).status).toBe(
        200,
      )
    }),
  options,
)

it.instance(
  "the final transport hook blocks private paths added by an outer response or error encoder",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const audience = yield* SessionAudience.Service
      const root = yield* sessions.create({})
      const work = yield* tmpdirScoped()
      yield* audience.fenceIsolation({ sessionID: root.id, actor: "owner", directory: work })
      for (const owner of [false, true]) {
        const request = HttpServerRequest.fromWeb(new Request("http://localhost/probe"))
        const sent = yield* Deferred.make<HttpServerResponse.HttpServerResponse>()
        // HttpApiBuilder's outer error encoder runs after endpoint middleware. Construct bytes at that same
        // boundary, then use the real HTTP transport to exercise the registered final-response hook.
        yield* HttpEffect.toHandled(
          SessionAudienceHttp.protectResponse(Effect.void, owner, audience).pipe(
            Effect.andThen(
              Effect.succeed(
                HttpServerResponse.jsonUnsafe({ message: "generic conflict", resource: work }, { status: 409 }),
              ),
            ),
          ),
          (_request, value) => Deferred.succeed(sent, value),
        ).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request))
        const response = yield* Deferred.await(sent)
        expect(response.status).toBe(owner ? 409 : 403)
        if (!owner && response.body._tag === "Uint8Array")
          expect(new TextDecoder().decode(response.body.body)).not.toContain(work)
      }
    }),
  options,
)

it.instance(
  "ordinary session output cannot disclose another family's known private working directory",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const sessions = yield* Session.Service
      const audience = yield* SessionAudience.Service
      const isolated = yield* sessions.create({})
      const work = yield* tmpdirScoped()
      yield* audience.fenceIsolation({ sessionID: isolated.id, actor: "owner", directory: work })
      const publicSession = yield* sessions.create({
        metadata: { toolOutput: `git worktree list\n${work} abc123 [vector/subagent/task]` },
      })
      expect(yield* audience.isPrivate(publicSession.id)).toBe(false)
      expect((yield* requestInDirectory(`/session/${publicSession.id}`, directory, { headers: relay })).status).toBe(
        403,
      )
      expect((yield* requestInDirectory(`/session/${publicSession.id}`, directory)).status).toBe(200)
    }),
  options,
)

it.instance(
  "an open event stream rechecks queued events after isolation fences the family",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const audience = yield* SessionAudience.Service
      const events = yield* EventV2Bridge.Service
      const root = yield* sessions.create({})
      const visible = yield* sessions.create({})
      const request = HttpServerRequest.fromWeb(new Request("http://localhost/event", { headers: relay }))
      const response = yield* eventResponse(events, request, {
        username: "relay",
        clientID: `client_${root.id}`,
        at: Date.now(),
      }).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request))
      yield* events.publish(SessionV1.Event.Updated, {
        sessionID: root.id,
        info: { ...root, title: "private queued brief" },
      })
      yield* audience.fenceIsolation({ sessionID: root.id, actor: "owner" })
      yield* events.publish(SessionV1.Event.Updated, {
        sessionID: visible.id,
        info: { ...visible, title: "public-sentinel" },
      })
      if (response.body._tag !== "Stream") return yield* Effect.die("Expected a streaming body")
      const chunks = yield* response.body.stream.pipe(
        Stream.takeUntil((chunk) => new TextDecoder().decode(chunk).includes("public-sentinel")),
        Stream.runCollect,
        Effect.timeout("5 seconds"),
      )
      const text = chunks.map((chunk) => new TextDecoder().decode(chunk)).join("")
      expect(text).toContain("server.connected")
      expect(text).toContain("public-sentinel")
      expect(text).not.toContain("private queued brief")
      expect(
        yield* SessionAudienceHttp.envelope({ type: "sync", syncEvent: { aggregateID: root.id, data: {} } }, false),
      ).toBe(false)
      expect(
        yield* SessionAudienceHttp.envelope({ type: "unknown", properties: { output: "unscoped raw text" } }, false),
      ).toBe(false)
      for (const properties of [
        { parentID: visible.id, output: "unscoped raw text" },
        { info: { sessionID: visible.id }, output: "unscoped raw text" },
      ])
        expect(yield* SessionAudienceHttp.envelope({ type: "unknown", properties }, false)).toBe(false)
      expect(
        yield* SessionAudienceHttp.envelope(
          {
            payload: {
              type: "sync",
              syncEvent: {
                type: "session.created.1",
                aggregateID: visible.id,
                data: { sessionID: visible.id, info: { id: root.id } },
              },
            },
          },
          false,
        ),
      ).toBe(false)
      // A drive-qualified spelling on Windows, as a fence stores it and a watcher reports it.
      const placeholder = path.resolve("/private/placeholder")
      for (const metadata of [
        { related: { sessionID: root.id, output: "private nested content" } },
        { related: { directory: placeholder } },
      ]) {
        if ("directory" in metadata.related)
          yield* audience.fenceIsolation({ sessionID: root.id, actor: "owner", directory: metadata.related.directory })
        expect(
          yield* SessionAudienceHttp.envelope(
            {
              type: "session.updated",
              properties: { sessionID: visible.id, info: { id: visible.id, metadata } },
            },
            false,
          ),
        ).toBe(false)
      }
      // Workspace-level events still reach a guest's app live; a private path or private session in one does not.
      const workspace = [
        { id: "evt_watch", type: "file.watcher.updated", data: { file: "/public/src/a.ts", event: "change" } },
        {
          payload: { id: "evt_branch", type: "vcs.branch.updated", properties: { branch: "main" } },
          directory: "/public",
        },
        { id: "evt_lsp", type: "lsp.updated", data: {}, location: { directory: "/public" } },
      ]
      for (const event of workspace) expect(yield* SessionAudienceHttp.envelope(event, false)).toBe(true)
      for (const event of [
        {
          id: "evt_private",
          type: "file.watcher.updated",
          data: { file: path.join(placeholder, "a.ts"), event: "add" },
        },
        { id: "evt_nested", type: "project.updated", data: { id: "project", note: { sessionID: root.id } } },
        { id: "evt_toast", type: "tui.toast.show", data: { title: "t", message: "unscoped raw text" } },
      ])
        expect(yield* SessionAudienceHttp.envelope(event, false)).toBe(false)
    }),
  options,
)

it.instance(
  "a guest JSON read paused after entry is refused if the family becomes private before transport",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const audience = yield* SessionAudience.Service
      const root = yield* sessions.create({})
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const read = Effect.gen(function* () {
        expect(yield* audience.isPrivate(root.id)).toBe(false)
        yield* Deferred.succeed(entered, undefined)
        yield* Deferred.await(release)
        return HttpServerResponse.jsonUnsafe({
          taskID: root.id,
          part: { sessionID: root.id },
          info: { id: root.id },
          text: "private body",
        })
      })
      const reading = yield* SessionAudienceHttp.protectResponse(read, false, audience).pipe(
        Effect.exit,
        Effect.forkScoped,
      )
      yield* Deferred.await(entered)
      yield* audience.fenceIsolation({ sessionID: root.id, actor: "owner" })
      yield* Deferred.succeed(release, undefined)
      const exit = yield* Fiber.join(reading)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "ForbiddenError" })
      // SessionID's public schema also accepts historical IDs without an underscore.
      yield* audience.fenceIsolation({ sessionID: "sesHistoricalPrivate", actor: "owner" })
      expect(
        yield* SessionAudienceHttp.response(
          HttpServerResponse.jsonUnsafe({ id: "sesHistoricalPrivate" }),
          false,
          audience,
        ),
      ).toBe(false)
      expect(
        (yield* SessionAudienceHttp.protectResponse(
          Effect.succeed(HttpServerResponse.jsonUnsafe({ sessionID: root.id })),
          true,
          audience,
        )).status,
      ).toBe(200)
    }),
  options,
)

it.instance(
  "only the exact counts projection on its own route may expose private task identities, even compressed",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const audience = yield* SessionAudience.Service
      const parent = yield* sessions.create({})
      const child = yield* sessions.create({ parentID: parent.id })
      yield* audience.fenceIsolation({ sessionID: child.id, actor: "owner" })
      const dto = {
        task: {
          id: child.id,
          sessionID: child.id,
          parentSessionID: parent.id,
          source: "subagent",
          title: "Isolated task",
          status: "completed",
          startedAt: 0,
          elapsedMs: 0,
          ownedPaths: [],
          dependsOn: [],
          resultAvailable: false,
          attempt: 0,
          controls: { inspect: false, message: false, stop: false },
          isolation: { mode: "worktree", state: "changed", files: 2, additions: 3, deletions: 1 },
        },
        files: [],
        truncated: false,
        mergeable: "unknown",
      }
      // Off the counts route the same bytes name a private family, so they are refused.
      expect(yield* SessionAudienceHttp.response(HttpServerResponse.jsonUnsafe(dto), false, audience)).toBe(false)
      const counts = SessionAudienceHttp.projected(HttpServerResponse.jsonUnsafe(dto))
      expect(yield* SessionAudienceHttp.response(counts, false, audience, false, true)).toBe(true)
      // Transport compression replaces the response object; the final bytes are still recognized and inspected.
      const gzip = (value: unknown) =>
        HttpServerResponse.setHeader(
          HttpServerResponse.uint8Array(gzipSync(JSON.stringify(value)), { contentType: "application/json" }),
          "content-encoding",
          "gzip",
        )
      expect(yield* SessionAudienceHttp.response(gzip(dto), false, audience, false, true)).toBe(true)
      const raw = { ...dto, task: { ...dto.task, title: "Raw stored title" } }
      expect(yield* SessionAudienceHttp.response(gzip(raw), false, audience, false, true)).toBe(false)
      expect(
        yield* SessionAudienceHttp.response(
          HttpServerResponse.setHeader(gzip(dto), "content-encoding", "br"),
          false,
          audience,
          false,
          true,
        ),
      ).toBe(false)
      for (const task of [
        { ...dto.task, title: "/private/untrusted stored title" },
        { ...dto.task, report: "untrusted report" },
        { ...dto.task, isolation: { ...dto.task.isolation, directory: "/private/worktree" } },
      ])
        expect(() => SessionAudienceHttp.projected(HttpServerResponse.jsonUnsafe({ ...dto, task }))).toThrow(
          "safe shape",
        )
    }),
  options,
)

// Engines before WP28 steal a warped session with the forwarded-guest marker to say a guest worked in it there. The steal
// is then a guest's: a private family is refused and left where it is, and a public session moves with its guest input
// recorded, so the replica already replayed here keeps its guest provenance. Other sync routes stay owner-only.
it.instance(
  "a forwarded steal is a guest's: a private family stays unmoved, a public session moves with its guest input",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const sessions = yield* Session.Service
      const audience = yield* SessionAudience.Service
      const root = yield* sessions.create({ title: "private root" })
      const child = yield* sessions.create({ parentID: root.id })
      yield* audience.fenceIsolation({ sessionID: child.id, actor: "owner" })
      const warped = yield* sessions.create({ title: "warped in" })
      expect(yield* audience.hasGuestInput(warped.id)).toBe(false)
      // This engine is the warp's target workspace.
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const previous = Flag.VECTOR_WORKSPACE_ID
          Flag.VECTOR_WORKSPACE_ID = "wrk_steal_target"
          return previous
        }),
        (previous) =>
          Effect.sync(() => {
            Flag.VECTOR_WORKSPACE_ID = previous
          }),
      )
      const steal = (sessionID: string) =>
        requestInDirectory("/sync/steal", directory, {
          method: "POST",
          headers: relay,
          body: JSON.stringify({ sessionID }),
        })
      expect((yield* steal(root.id)).status).toBe(403)
      expect((yield* sessions.get(root.id)).workspaceID).toBe(root.workspaceID)
      expect(yield* audience.hasGuestInput(root.id)).toBe(false)
      expect((yield* steal(warped.id)).status).toBe(200)
      expect(String((yield* sessions.get(warped.id)).workspaceID)).toBe("wrk_steal_target")
      expect(yield* audience.hasGuestInput(warped.id)).toBe(true)
      expect(yield* audience.canIsolate(warped.id, "owner")).toBe(false)
      for (const route of ["/sync/replay", "/sync/start"])
        expect(
          (yield* requestInDirectory(route, directory, { method: "POST", headers: relay, body: "{}" })).status,
        ).toBe(403)
    }),
  options,
)
