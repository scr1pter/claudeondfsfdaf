import { NodeHttpServer, NodeHttpServerRequest, NodeServices } from "@effect/platform-node"
import { afterAll, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { eq, sql } from "drizzle-orm"
import { Context, Deferred, Effect, Exit, Layer, Option, Result, Schema, Scope } from "effect"
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { BackgroundJobStore } from "@vectordevai/core/background-job-store"
import { BrainDatabase } from "@vectordevai/core/brain/database"
import { ReviewMemory } from "@vectordevai/core/brain/review-memory"
import { ReviewStore } from "@vectordevai/core/brain/review-store"
import { ReviewWitness } from "@vectordevai/core/brain/review-witness"
import { BrainEntryTable, BrainReviewMemoryTable } from "@vectordevai/core/brain/sql"
import { Database } from "@vectordevai/core/database/database"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { GUEST_REQUEST_HEADER } from "@vectordevai/core/free-model-guests"
import { Project } from "@vectordevai/core/project"
import { ReviewRequestStore } from "@vectordevai/core/review/request-store"
import { reviewVerdict } from "@vectordevai/core/review/verdict"
import { SessionTable } from "@vectordevai/core/session/sql"
import { EffectFlock } from "@vectordevai/core/util/effect-flock"
import { ReviewMemoryControl } from "@vectordevai/schema/review-memory"
import { ReviewRun } from "@vectordevai/schema/review-run"
import { SessionID } from "@vectordevai/schema/session-id"
import { InstanceRef } from "@/effect/instance-ref"
import { AppNodeBuilderV1 } from "@/effect/app-node-builder-v1"
import type { InstanceContext } from "@/project/instance-context"
import { ReviewLifecycle } from "@/review/lifecycle"
import { ReviewLocalRun } from "@/review/local-run"
import { ReviewMemoryAuthority } from "@/review/memory-authority"
import { ReviewMemoryErasure } from "@/review/memory-erasure"
import { ReviewMemoryOwner } from "@/review/memory-owner"
import { ReviewMemoryScope } from "@/review/memory-scope"
import { ServerAuth } from "@/server/auth"
import { Session } from "@/session/session"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { ReviewMemoryApiError } from "@/server/routes/instance/httpapi/groups/review-memory"
import { reviewMemoryHandlers } from "@/server/routes/instance/httpapi/handlers/review-memory"
import { authorizationLayer } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import { SchemaErrorMiddleware, schemaErrorLayer } from "@/server/routes/instance/httpapi/middleware/schema-error"
import {
  WorkspaceRouteContext,
  WorkspaceRoutingMiddleware,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { tmpdir } from "../fixture/fixture"

const root = "/experimental/review-memory"
const repository = Project.ID.make("http_prepared_memory")
const parentID = SessionID.make("ses_http_memory_parent")
const reviewID = SessionID.make("ses_http_memory_review")
const source = { parentID, reviewID, head: "a".repeat(40) }
const owner = BackgroundJobStore.open()
afterAll(() => BackgroundJobStore.close(owner))
const basic = (username: string, password: string) =>
  `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
const ownerHeaders = { authorization: basic("vector", "owner-secret") }
const guestHeaders = { authorization: basic("guest", "guest-secret") }
const forwardedHeaders = { ...ownerHeaders, [GUEST_REQUEST_HEADER]: "1" }
const call = <A>(request: () => Promise<A>) =>
  Effect.tryPromise({ try: request, catch: (cause) => new Error("HTTP fixture request failed", { cause }) })
const confirmation = (preview: ReviewMemoryControl.Preview) => ({
  previewId: preview.previewId,
  approvedSha256: preview.sha256,
})
function json<S extends Schema.Top & { DecodingServices: never }>(response: Response, schema: S) {
  expect(response.status).toBe(200)
  return call(() => response.json()).pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)))
}
const value = <A>(result: ReviewMemory.Result<A>) => {
  if (!result.ok) throw new Error(result.reason)
  return result.value
}

// Real HTTP/auth/owner/Core/source/SQLite are under test. Only instance selection
// is a fixed fixture binder: arbitrary request directories cannot create an
// InstanceRef. Extract the actual registered group to keep unrelated services out of this focused authority test.
function listen(controls: ReviewMemoryOwner.Interface, instance: InstanceContext, drop?: Deferred.Deferred<void>) {
  const registered = InstanceHttpApi.groups["review-memory"]
  if (registered.identifier !== "review-memory") throw new Error("The owner control group is not registered")
  const api = HttpApi.make("vector-instance").add(registered).middleware(SchemaErrorMiddleware)
  const context = Layer.succeed(
    InstanceContextMiddleware,
    InstanceContextMiddleware.of((effect) => effect.pipe(Effect.provideService(InstanceRef, instance))),
  )
  const routing = Layer.succeed(
    WorkspaceRoutingMiddleware,
    WorkspaceRoutingMiddleware.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        if (
          request.headers["x-vector-directory"] !== instance.directory ||
          url.searchParams.has("directory") ||
          url.searchParams.has("workspace") ||
          request.headers["x-vector-workspace"]
        )
          return HttpServerResponse.jsonUnsafe(
            { _tag: "ForbiddenError", message: "This fixture has no other server-owned placement." },
            { status: 403 },
          )
        return yield* effect.pipe(Effect.provideService(WorkspaceRouteContext, { directory: instance.directory }))
      }),
    ),
  )
  let dropped = false
  const loss = HttpRouter.middleware()((effect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const response = yield* effect
      if (
        drop &&
        !dropped &&
        request.method === "POST" &&
        request.url === `${root}/confirm` &&
        response.status === 200
      ) {
        dropped = true
        // The real handler has committed. Destroy its actual Node response
        // socket before serialization; the client receives no success body.
        yield* Deferred.succeed(drop, undefined).pipe(
          Effect.andThen(Effect.sync(() => NodeHttpServerRequest.toServerResponse(request).destroy())),
          Effect.uninterruptible,
        )
      }
      return response
    }),
  )
  return Effect.gen(function* () {
    const lifetime = yield* Scope.make()
    yield* Effect.addFinalizer((exit) => Scope.close(lifetime, exit))
    const server = yield* Layer.build(
      Layer.fresh(
        HttpRouter.serve(
          HttpApiBuilder.layer(api).pipe(
            Layer.provide(Layer.fresh(reviewMemoryHandlers)),
            Layer.provide([context, routing, authorizationLayer, schemaErrorLayer]),
            Layer.provide(Layer.succeed(ReviewMemoryOwner.Service, controls)),
            Layer.provide(
              ServerAuth.Config.configLayer({
                password: Option.some("owner-secret"),
                username: "vector",
                guestPassword: Option.some("guest-secret"),
                guestUsername: "guest",
                guestWorkspaceIDs: ["wrk_visitor"],
                guestSessionIDs: [parentID],
              }),
            ),
            Layer.provide(loss.layer),
          ),
          { disableListenLog: true, disableLogger: true },
        ).pipe(
          // Satisfy the production routing middleware's declared Session context
          // with the genuine service; the fixed binder never invents a Session.
          Layer.provide(AppNodeBuilderV1.build(Session.node)),
          Layer.provideMerge(NodeHttpServer.layerTest),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ).pipe(Effect.provideService(Scope.Scope, lifetime))
    const url = HttpServer.formatAddress(Context.get(server, HttpServer.HttpServer).address)
    const request = (method: string, route = root, body?: unknown, headers: Record<string, string> = ownerHeaders) =>
      call(() =>
        fetch(new URL(route, url), {
          method,
          headers: { "x-vector-directory": instance.directory, "content-type": "application/json", ...headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(5_000),
        }),
      )
    return Object.assign(request, { close: () => Scope.close(lifetime, Exit.void) })
  })
}

type Setup = {
  start: (drop?: Deferred.Deferred<void>) => ReturnType<typeof listen>
  scope: string
  memory: ReviewMemory.Interface
  brain: BrainDatabase.Database
  db: Database.Interface["db"]
  lifecycle: ReviewLifecycle.Interface
  place: ReviewMemory.Place
  instance: InstanceContext
  restart: () => void
  admitSource: () => Effect.Effect<void, unknown>
}
async function run(body: (setup: Setup) => Effect.Effect<void, unknown, Scope.Scope>) {
  await using directory = await tmpdir({ git: true })
  const instance: InstanceContext = {
    directory: directory.path,
    worktree: directory.path,
    project: { id: repository, worktree: directory.path, time: { created: 1, updated: 1 }, sandboxes: [] },
  }
  const settings = {
    trust: () =>
      Effect.succeed({
        workspace: directory.path,
        fingerprint: "http-fixture",
        trusted: true,
        settings: false,
        ignored: false,
      }),
  }
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const brain = yield* BrainDatabase.Service
      const physical = yield* ReviewMemoryScope.git(directory.path)
      const requests = ReviewRequestStore.make(database.db)
      const eraser = ReviewMemoryErasure.make(requests, brain.db)
      yield* database.db.run(
        sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES (${repository}, ${directory.path}, '[]', 1, 1)`,
      )
      yield* database.db.run(
        sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (${parentID}, ${repository}, 'parent', ${directory.path}, 'Owner', 'test', 1, 1)`,
      )
      const request: ReviewRun.Start = {
        requestID: "http_memory_source",
        target: { kind: "working-tree", head: source.head },
      }
      const artifact = ReviewLocalRun.encodeArtifact({
        exitCode: 2,
        error: "Retained fixture result",
        verdict: reviewVerdict({ kind: "failure", stage: "review" }),
      })
      if (!artifact) throw new Error("Missing retained source artifact")
      yield* database.db
        .insert(SessionTable)
        .values({
          id: reviewID,
          project_id: repository,
          parent_id: parentID,
          internal: ReviewLocalRun.MARKER,
          slug: "review",
          directory: directory.path,
          title: "Review",
          version: "test",
          time_created: 1,
          time_updated: 1,
          metadata: {
            [ReviewLocalRun.FIELD]: {
              version: 1,
              parentID,
              request,
              directory: directory.path,
              status: "failed",
              startedAt: 1,
              completedAt: 2,
              artifact,
            },
          },
        })
        .run()
      let sourceAttempted = false
      const admitSource = () =>
        Effect.gen(function* () {
          if (sourceAttempted) throw new Error("The fixture source cannot be registered again")
          sourceAttempted = true
          const identity = { parentID, runID: reviewID, requestID: request.requestID, ownerNonce: randomUUID() }
          const reservation = yield* requests.reserve({ ...identity, request, owner, sourceBinding: physical.binding })
          const witnesses = reservation.row.sourceBinding?.witnesses
          const proof = witnesses
            ? ReviewWitness.proof({
                repository,
                scope: physical.binding.scope,
                parentID,
                reviewID,
                head: source.head,
                witnesses,
              })
            : undefined
          if (!reservation.claimed || !proof || !(yield* requests.attach(identity)))
            throw new Error("Missing fresh fixture source")
          if (!(yield* ReviewStore.registerSource(brain.db, proof))) throw new Error("Fixture source was not enabled")
          if (!(yield* requests.begin(identity))) throw new Error("Fixture source did not begin")
          yield* requests.finish(identity)
        })
      yield* Effect.gen(function* () {
        const lifecycle = yield* ReviewLifecycle.Service
        const authority = ReviewMemoryAuthority.make({ database: database.db, requests, lifecycle, settings })
        const memory = yield* ReviewMemory.Service.pipe(
          Effect.provide(
            ReviewMemory.layerWith(authority).pipe(Layer.provide(Layer.succeed(BrainDatabase.Service, brain))),
          ),
        )
        let controls = ReviewMemoryOwner.make({ memory, settings })
        yield* Effect.addFinalizer(() => Effect.sync(() => controls.dispose()))
        const place: ReviewMemory.Place = {
          repository,
          scope: physical.binding.scope,
          root: directory.path,
          sources: [],
          held: false,
        }
        yield* body({
          memory,
          brain: brain.db,
          db: database.db,
          lifecycle,
          place,
          instance,
          scope: physical.binding.scope,
          admitSource,
          start: (drop) => listen(controls, instance, drop),
          restart: () => {
            controls.dispose()
            controls = ReviewMemoryOwner.make({ memory, settings })
          },
        })
      }).pipe(
        Effect.provide(
          ReviewLifecycle.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(ReviewRequestStore.Service, requests),
                Layer.succeed(ReviewMemoryErasure.Service, eraser),
                LayerNode.compile(EffectFlock.node),
              ),
            ),
          ),
        ),
      )
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Database.layerFromPath(path.join(directory.path, "http-main.sqlite")),
          BrainDatabase.layerFor(path.join(directory.path, "http-brain.sqlite")),
        ),
      ),
      Effect.scoped,
    ),
  )
}

const prepare = (
  http: Effect.Success<ReturnType<typeof listen>>,
  scope: string,
  command: ReviewMemoryControl.Command,
) =>
  http("POST", `${root}/prepare`, { expectedScope: scope, command }).pipe(
    Effect.flatMap((response) => json(response, ReviewMemoryControl.Preview)),
  )
const inspect = (http: Effect.Success<ReturnType<typeof listen>>) =>
  http("GET").pipe(Effect.flatMap((response) => json(response, ReviewMemoryControl.Inspect)))
const apply = (http: Effect.Success<ReturnType<typeof listen>>, preview: ReviewMemoryControl.Preview) =>
  http("POST", `${root}/confirm`, confirmation(preview)).pipe(
    Effect.flatMap((response) => json(response, ReviewMemoryControl.ConfirmationResult)),
  )
const approvedOutcome = (setup: Setup, http: Effect.Success<ReturnType<typeof listen>>) =>
  Effect.gen(function* () {
    const initial = yield* inspect(http)
    const enable = yield* prepare(http, setup.scope, {
      action: "configure",
      expected: initial.state.generation,
      enabled: true,
    })
    yield* apply(http, enable)
    yield* setup.admitSource()
    const before = yield* inspect(http)
    const pending = value(
      yield* setup.memory
        .propose(setup.place, {
          expected: before.state.generation,
          source,
          kind: "outcome",
          text: "Keep the guarded HTTP lookup.",
          paths: ["src/a.ts"],
          citations: [{ path: "src/a.ts", line: 1, head: source.head, quote: "return []" }],
          reason: "The original HTTP reviewed rationale.",
          visibility: "repository",
        })
        .pipe(Effect.provideService(InstanceRef, setup.instance)),
    )
    const proposed = yield* inspect(http)
    const preview = yield* prepare(http, setup.scope, {
      action: "approve",
      expected: proposed.state.generation,
      id: pending.id,
    })
    const entry = Schema.decodeUnknownSync(ReviewMemoryControl.ApprovedEntry)(yield* apply(http, preview))
    return { entry, read: yield* inspect(http) }
  })
const reopenReason = "The owner found a missing HTTP input case and asks to reassess this outcome."

describe("registered review-memory owner HTTP group", () => {
  test("owner HTTP reopens only the sealed approved outcome and a separate human reason; guest/forwarded requests reveal nothing and cannot consume it", async () => {
    await run((setup) =>
      Effect.gen(function* () {
        const http = yield* setup.start()
        const active = yield* approvedOutcome(setup, http)
        const rows = yield* setup.brain.select().from(BrainReviewMemoryTable)
        const command: ReviewMemoryControl.Reopen = {
          action: "reopen",
          expected: active.read.state.generation,
          id: active.entry.id,
          reason: reopenReason,
        }
        const preview = yield* prepare(http, setup.scope, command)
        if (preview.operation !== "reopen") throw new Error("Missing full HTTP reopen preview")
        expect(preview.payload).toEqual({
          expected: command.expected,
          id: active.entry.id,
          reason: reopenReason,
          entry: active.entry,
        })
        expect((yield* inspect(http)).state).toEqual(active.read.state)
        expect(yield* setup.brain.select().from(BrainReviewMemoryTable)).toEqual(rows)
        for (const [headers, expected] of [
          [{}, 401],
          [guestHeaders, 403],
          [forwardedHeaders, 403],
        ] as const) {
          for (const [route, body] of [
            [`${root}/prepare`, { expectedScope: setup.scope, command }],
            [`${root}/confirm`, confirmation(preview)],
          ] as const) {
            const refused = yield* http("POST", route, body, headers)
            expect(refused.status).toBe(expected)
            const text = yield* call(() => refused.text())
            for (const privateText of [
              setup.scope,
              preview.sha256,
              active.entry.text,
              active.entry.reason,
              reopenReason,
            ])
              expect(text).not.toContain(privateText)
          }
        }
        expect(
          (yield* http("POST", `${root}/confirm`, { ...confirmation(preview), reason: "A replacement reason." }))
            .status,
        ).toBe(400)
        expect((yield* inspect(http)).state).toEqual(active.read.state)
        const proposed = Schema.decodeUnknownSync(ReviewMemoryControl.ProposedEntry)(yield* apply(http, preview))
        expect(proposed).toMatchObject({
          id: active.entry.id,
          status: "proposed",
          text: active.entry.text,
          source,
          citations: active.entry.citations,
          reason: reopenReason,
          createdAt: active.entry.createdAt,
        })
        expect(proposed).not.toHaveProperty("approvedBy")
        expect(proposed).not.toHaveProperty("approvedAt")
        const current = yield* inspect(http)
        expect(current.state.generation).toBe(active.read.state.generation + 1)
        expect(current.state.entries).toEqual([proposed])
        const retry = yield* http("POST", `${root}/confirm`, confirmation(preview))
        expect(retry.status).toBe(400)
        expect(Schema.decodeUnknownSync(ReviewMemoryApiError)(yield* call(() => retry.json())).code).toBe("used")
        const approve = yield* prepare(http, setup.scope, {
          action: "approve",
          expected: current.state.generation,
          id: proposed.id,
        })
        expect(yield* apply(http, approve)).toMatchObject({
          id: active.entry.id,
          status: "active",
          source,
          reason: reopenReason,
          citations: active.entry.citations,
        })
      }),
    )
  })

  test("a lost reopen HTTP success is reconciled as the same pending row, and the used receipt never repeats the withdrawal", async () => {
    await run((setup) =>
      Effect.gen(function* () {
        const first = yield* setup.start()
        const active = yield* approvedOutcome(setup, first)
        yield* first.close()
        const committed = yield* Deferred.make<void>()
        const http = yield* setup.start(committed)
        const preview = yield* prepare(http, setup.scope, {
          action: "reopen",
          expected: active.read.state.generation,
          id: active.entry.id,
          reason: reopenReason,
        })
        const lost = yield* http("POST", `${root}/confirm`, confirmation(preview)).pipe(Effect.result)
        expect(Result.isFailure(lost)).toBe(true)
        yield* Deferred.await(committed).pipe(Effect.timeout("2 seconds"))
        const current = yield* inspect(http)
        expect(current.state.generation).toBe(active.read.state.generation + 1)
        expect(current.state.entries).toHaveLength(1)
        expect(current.state.entries[0]).toMatchObject({
          id: active.entry.id,
          status: "proposed",
          reason: reopenReason,
          text: active.entry.text,
          citations: active.entry.citations,
          source,
        })
        expect(current.state.entries[0]).not.toHaveProperty("approvedBy")
        const retry = yield* http("POST", `${root}/confirm`, confirmation(preview))
        expect(retry.status).toBe(400)
        expect(Schema.decodeUnknownSync(ReviewMemoryApiError)(yield* call(() => retry.json())).code).toBe("used")
        expect((yield* inspect(http)).state).toEqual(current.state)
        expect(yield* setup.brain.select().from(BrainReviewMemoryTable)).toHaveLength(1)
      }),
    )
  })

  for (const mode of ["parent", "review", "legacy", "consent"] as const)
    test(`reopen HTTP cannot restore the original outcome after ${mode} changes before confirmation`, async () => {
      await run((setup) =>
        Effect.gen(function* () {
          const http = yield* setup.start()
          const active = yield* approvedOutcome(setup, http)
          const preview = yield* prepare(http, setup.scope, {
            action: "reopen",
            expected: active.read.state.generation,
            id: active.entry.id,
            reason: reopenReason,
          })
          if (mode === "parent" || mode === "review") {
            const id = mode === "parent" ? parentID : reviewID
            yield* setup.lifecycle.deleting(id, setup.db.delete(SessionTable).where(eq(SessionTable.id, id)).run())
          }
          if (mode === "legacy") {
            const saved = yield* ReviewRequestStore.make(setup.db).sourceSnapshot(parentID, reviewID)
            const pair = saved?.sourceBinding?.witnesses
            if (!pair) throw new Error("Missing original saved Main witnesses")
            // Relevant old sole-session marker removal, with no new review deletion hook.
            yield* setup.brain.delete(BrainEntryTable).where(eq(BrainEntryTable.id, pair.review)).run()
          }
          if (mode === "consent") {
            const disable = yield* prepare(http, setup.scope, {
              action: "configure",
              expected: active.read.state.generation,
              enabled: false,
            })
            yield* apply(http, disable)
            const disabled = yield* inspect(http)
            const enable = yield* prepare(http, setup.scope, {
              action: "configure",
              expected: disabled.state.generation,
              enabled: true,
            })
            yield* apply(http, enable)
          }
          const rejected = yield* http("POST", `${root}/confirm`, confirmation(preview))
          expect(rejected.status).toBe(400)
          expect(Schema.decodeUnknownSync(ReviewMemoryApiError)(yield* call(() => rejected.json())).code).toBe("stale")
          const current = yield* inspect(http)
          expect(current.state.entries).toEqual(mode === "consent" ? [active.entry] : [])
          const retry = yield* http("POST", `${root}/confirm`, confirmation(preview))
          expect(retry.status).toBe(400)
          expect(Schema.decodeUnknownSync(ReviewMemoryApiError)(yield* call(() => retry.json())).code).toBe("used")
          expect((yield* inspect(http)).state).toEqual(current.state)
          if (mode !== "consent") expect(yield* setup.brain.select().from(BrainReviewMemoryTable)).toEqual([])
        }),
      )
    })

  test("reopen HTTP rejects extra authority/source fields and stale handles without changing the approved row", async () => {
    await run((setup) =>
      Effect.gen(function* () {
        const http = yield* setup.start()
        const active = yield* approvedOutcome(setup, http)
        const command: ReviewMemoryControl.Reopen = {
          action: "reopen",
          expected: active.read.state.generation,
          id: active.entry.id,
          reason: reopenReason,
        }
        for (const field of ["source", "entry", "witnesses", "approved", "approvedBy", "fingerprint", "root"])
          expect(
            (yield* http("POST", `${root}/prepare`, {
              expectedScope: setup.scope,
              command: { ...command, [field]: "forged" },
            })).status,
          ).toBe(400)
        for (const reason of ["", " ", "x".repeat(ReviewMemoryControl.LIMIT.reason + 1)])
          expect(
            (yield* http("POST", `${root}/prepare`, { expectedScope: setup.scope, command: { ...command, reason } }))
              .status,
          ).toBe(400)
        const pending = yield* prepare(http, setup.scope, command)
        yield* http.close()
        setup.restart()
        const restarted = yield* setup.start()
        const rejected = yield* restarted("POST", `${root}/confirm`, confirmation(pending))
        expect(rejected.status).toBe(400)
        expect(Schema.decodeUnknownSync(ReviewMemoryApiError)(yield* call(() => rejected.json())).code).toBe(
          "unavailable",
        )
        expect((yield* inspect(restarted)).state).toEqual(active.read.state)
      }),
    )
  })

  test("bare owner GET omits absent selectors while explicit bounded pagination retains its strict contract", async () => {
    await run((setup) =>
      Effect.gen(function* () {
        const http = yield* setup.start()
        const bare = yield* inspect(http)
        const bounded = yield* http("GET", `${root}?offset=0&limit=1`).pipe(
          Effect.flatMap((response) => json(response, ReviewMemoryControl.Inspect)),
        )
        expect(bare).toMatchObject({
          repository,
          scope: setup.scope,
          state: { enabled: false, generation: 0, entries: [] },
        })
        expect(bounded).toEqual(bare)
        expect((yield* http("GET", `${root}?offset=undefined`)).status).toBe(400)
        expect((yield* http("GET", `${root}?limit=51`)).status).toBe(400)
        expect((yield* inspect(http)).state).toEqual(bare.state)
      }),
    )
  })
  test("real owner HTTP prepares without effects and confirms configure, preferences, proposal, forget, disable and erase", async () => {
    await run((setup) =>
      Effect.gen(function* () {
        const http = yield* setup.start()
        const initial = yield* inspect(http)
        expect(initial).toMatchObject({ repository, scope: setup.scope, state: { enabled: false, entries: [] } })
        const preview = yield* prepare(http, setup.scope, {
          action: "configure",
          expected: initial.state.generation,
          enabled: true,
        })
        expect((yield* inspect(http)).state).toEqual(initial.state)
        yield* http("POST", `${root}/confirm`, confirmation(preview)).pipe(
          Effect.flatMap((response) => json(response, ReviewMemoryControl.ConfirmationResult)),
        )
        let current = yield* inspect(http)
        expect(current.state.generation).toBe(initial.state.generation + 1)
        const preference = yield* prepare(http, setup.scope, {
          action: "record",
          expected: current.state.generation,
          kind: "preference",
          text: "PRIVATE_OWNER_PREFERENCE",
          paths: ["src/*"],
          citations: [],
          reason: "Owner choice",
          visibility: "private",
        })
        expect(preference.operation).toBe("record")
        yield* http("POST", `${root}/confirm`, confirmation(preference)).pipe(
          Effect.flatMap((response) => json(response, ReviewMemoryControl.ConfirmationResult)),
        )
        current = yield* inspect(http)
        expect(current.state.entries).toHaveLength(1)
        expect(current.state.entries[0]).toMatchObject({
          text: "PRIVATE_OWNER_PREFERENCE",
          origin: "owner",
          status: "active",
        })
        yield* setup.admitSource()
        const proposal = value(
          yield* setup.memory
            .propose(setup.place, {
              expected: current.state.generation,
              source,
              kind: "outcome",
              text: "Keep the guarded lookup.",
              paths: ["src/a.ts"],
              citations: [{ path: "src/a.ts", line: 1, head: source.head, quote: "return []" }],
              reason: "Review data",
              visibility: "repository",
            })
            .pipe(Effect.provideService(InstanceRef, setup.instance)),
        )
        current = yield* inspect(http)
        const approve = yield* prepare(http, setup.scope, {
          action: "approve",
          expected: current.state.generation,
          id: proposal.id,
        })
        if (approve.operation !== "approve") throw new Error("Missing exact approval payload")
        expect(approve.payload.entry).toEqual(Schema.decodeUnknownSync(ReviewMemoryControl.ProposedEntry)(proposal))
        yield* http("POST", `${root}/confirm`, confirmation(approve)).pipe(
          Effect.flatMap((response) => json(response, ReviewMemoryControl.ConfirmationResult)),
        )
        current = yield* inspect(http)
        const forget = yield* prepare(http, setup.scope, {
          action: "forget",
          expected: current.state.generation,
          id: proposal.id,
        })
        yield* http("POST", `${root}/confirm`, confirmation(forget)).pipe(
          Effect.flatMap((response) => json(response, ReviewMemoryControl.ConfirmationResult)),
        )
        current = yield* inspect(http)
        expect(current.state.entries).toHaveLength(1)
        const disable = yield* prepare(http, setup.scope, {
          action: "configure",
          expected: current.state.generation,
          enabled: false,
        })
        yield* http("POST", `${root}/confirm`, confirmation(disable)).pipe(
          Effect.flatMap((response) => json(response, ReviewMemoryControl.ConfirmationResult)),
        )
        current = yield* inspect(http)
        expect(current.state.enabled).toBe(false)
        const erase = yield* prepare(http, setup.scope, { action: "erase", expected: current.state.generation })
        yield* http("POST", `${root}/confirm`, confirmation(erase)).pipe(
          Effect.flatMap((response) => json(response, ReviewMemoryControl.ConfirmationResult)),
        )
        expect((yield* inspect(http)).state.entries).toEqual([])
      }),
    )
  })

  test("every method refuses missing credentials, session/workspace visitors and forwarded owner credentials without private results or effects", async () => {
    await run((setup) =>
      Effect.gen(function* () {
        const http = yield* setup.start()
        const empty = yield* inspect(http)
        const enabled = yield* prepare(http, setup.scope, {
          action: "configure",
          expected: empty.state.generation,
          enabled: true,
        })
        expect((yield* http("POST", `${root}/confirm`, confirmation(enabled))).status).toBe(200)
        const active = yield* inspect(http)
        const privateEntry = yield* prepare(http, setup.scope, {
          action: "record",
          expected: active.state.generation,
          kind: "preference",
          text: "PRIVATE_OWNER_PREFERENCE",
          paths: ["src/*"],
          citations: [],
          reason: "Owner private choice",
          visibility: "private",
        })
        expect((yield* http("POST", `${root}/confirm`, confirmation(privateEntry))).status).toBe(200)
        const initial = yield* inspect(http)
        expect(initial.state.entries[0]?.text).toBe("PRIVATE_OWNER_PREFERENCE")
        const pending = yield* prepare(http, setup.scope, {
          action: "configure",
          expected: initial.state.generation,
          enabled: false,
        })
        for (const [headers, expected] of [
          [{}, 401],
          [guestHeaders, 403],
          [forwardedHeaders, 403],
        ] as const) {
          for (const [method, route, body] of [
            ["GET", root, undefined],
            ["HEAD", root, undefined],
            [
              "POST",
              `${root}/prepare`,
              {
                expectedScope: setup.scope,
                command: { action: "configure", expected: initial.state.generation, enabled: false },
              },
            ],
            ["POST", `${root}/confirm`, confirmation(pending)],
            ["DELETE", `${root}/previews/${pending.previewId}`, undefined],
          ] as const) {
            const response = yield* http(method, route, body, headers)
            expect(response.status).toBe(expected)
            const bodyText = yield* call(() => response.text())
            expect(bodyText).not.toContain(setup.scope)
            expect(bodyText).not.toContain(pending.sha256)
            expect(bodyText).not.toContain("PRIVATE_OWNER_PREFERENCE")
          }
        }
        expect((yield* inspect(http)).state).toEqual(initial.state)
        const applied = yield* http("POST", `${root}/confirm`, confirmation(pending))
        expect(applied.status).toBe(200)
        expect((yield* inspect(http)).state.generation).toBe(initial.state.generation + 1)
      }),
    )
  })

  test("postcommit socket loss never repeats a write: used replay plus GET reconciles one exact epoch", async () => {
    await run((setup) =>
      Effect.gen(function* () {
        const committed = yield* Deferred.make<void>()
        const http = yield* setup.start(committed)
        const initial = yield* inspect(http)
        const pending = yield* prepare(http, setup.scope, {
          action: "configure",
          expected: initial.state.generation,
          enabled: true,
        })
        const lost = yield* http("POST", `${root}/confirm`, confirmation(pending)).pipe(Effect.result)
        expect(Result.isFailure(lost)).toBe(true)
        yield* Deferred.await(committed).pipe(Effect.timeout("2 seconds"))
        const current = yield* inspect(http)
        expect(current.state).toMatchObject({ enabled: true, generation: initial.state.generation + 1 })
        const retry = yield* http("POST", `${root}/confirm`, confirmation(pending))
        expect(retry.status).toBe(400)
        expect(Schema.decodeUnknownSync(ReviewMemoryApiError)(yield* call(() => retry.json())).code).toBe("used")
        expect((yield* inspect(http)).state).toEqual(current.state)
      }),
    )
  })

  test("a fresh owner-service boot rejects prior handles; owned discard mutates no stored epoch", async () => {
    await run((setup) =>
      Effect.gen(function* () {
        const http = yield* setup.start()
        const initial = yield* inspect(http)
        const pending = yield* prepare(http, setup.scope, {
          action: "configure",
          expected: initial.state.generation,
          enabled: true,
        })
        yield* http.close()
        setup.restart()
        const next = yield* setup.start()
        const stale = yield* next("POST", `${root}/confirm`, confirmation(pending))
        expect(stale.status).toBe(400)
        expect(Schema.decodeUnknownSync(ReviewMemoryApiError)(yield* call(() => stale.json())).code).toBe("unavailable")
        expect((yield* inspect(next)).state).toEqual(initial.state)
        const fresh = yield* prepare(next, setup.scope, {
          action: "configure",
          expected: initial.state.generation,
          enabled: true,
        })
        expect((yield* next("DELETE", `${root}/previews/${fresh.previewId}`)).status).toBe(200)
        const discarded = yield* next("POST", `${root}/confirm`, confirmation(fresh))
        expect(Schema.decodeUnknownSync(ReviewMemoryApiError)(yield* call(() => discarded.json())).code).toBe("used")
        expect((yield* inspect(next)).state).toEqual(initial.state)
      }),
    )
  })

  test("bounded strict wire commands never turn caller roots, repository IDs, owner flags or source JSON into authority", async () => {
    await run((setup) =>
      Effect.gen(function* () {
        const http = yield* setup.start()
        const initial = yield* inspect(http)
        const command = { action: "configure", expected: initial.state.generation, enabled: true }
        for (const body of [
          { expectedScope: setup.scope, command, root: setup.instance.directory },
          { expectedScope: setup.scope, command, repository },
          { expectedScope: setup.scope, command, owner: true },
          { expectedScope: setup.scope, command, source },
          { expectedScope: `vrs1_${"0".repeat(64)}`, command },
          { expectedScope: setup.scope, command: { ...command, expected: initial.state.generation + 1 } },
        ])
          expect((yield* http("POST", `${root}/prepare`, body)).status).toBe(400)
        for (const query of ["?limit=51", "?offset=201", "?limit=0", "?root=/", "?owner=true"])
          expect((yield* http("GET", `${root}${query}`)).status).toBe(400)
        const page = yield* http("GET", `${root}?offset=0&limit=1`).pipe(
          Effect.flatMap((response) => json(response, ReviewMemoryControl.Inspect)),
        )
        expect(page.state.entries).toHaveLength(0)
        expect((yield* inspect(http)).state).toEqual(initial.state)
      }),
    )
  })
})
