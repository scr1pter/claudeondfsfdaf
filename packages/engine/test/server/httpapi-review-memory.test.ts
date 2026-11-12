import { NodeHttpServer, NodeHttpServerRequest, NodeServices } from "@effect/platform-node"
import { afterAll, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { sql } from "drizzle-orm"
import { Context, Deferred, Effect, Exit, Layer, Option, Result, Schema, Scope } from "effect"
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { BackgroundJobStore } from "@vectordevai/core/background-job-store"
import { BrainDatabase } from "@vectordevai/core/brain/database"
import { ReviewMemory } from "@vectordevai/core/brain/review-memory"
import { ReviewStore } from "@vectordevai/core/brain/review-store"
import { ReviewWitness } from "@vectordevai/core/brain/review-witness"
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
import { ReviewMemoryApiError, ReviewMemoryControlApi } from "@/server/routes/instance/httpapi/groups/review-memory"
import { reviewMemoryHandlers } from "@/server/routes/instance/httpapi/handlers/review-memory"
import { authorizationLayer } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import { schemaErrorLayer } from "@/server/routes/instance/httpapi/middleware/schema-error"
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
// InstanceRef. Full production routing/registry assembly remains unregistered.
function listen(controls: ReviewMemoryOwner.Interface, instance: InstanceContext, drop?: Deferred.Deferred<void>) {
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
          HttpApiBuilder.layer(ReviewMemoryControlApi).pipe(
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

describe("unregistered review-memory HTTP candidate", () => {
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
