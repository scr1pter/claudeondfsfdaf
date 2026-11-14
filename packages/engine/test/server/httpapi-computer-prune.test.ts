import { NodeHttpServer } from "@effect/platform-node"
import { expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { ComputerPrune } from "@/computer/prune"
import { ComputerProtection } from "@/computer/protection"
import { ServerAuth } from "@/server/auth"
import { Session } from "@/session/session"
import { ComputerApi, ComputerPaths } from "@/server/routes/instance/httpapi/groups/computer"
import { computerHandlers } from "@/server/routes/instance/httpapi/handlers/computer"
import { authorizationLayer } from "@/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "@/server/routes/instance/httpapi/middleware/schema-error"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRouteContext,
  WorkspaceRoutingMiddleware,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { testEffect } from "../lib/effect"

class Fixture extends Context.Service<
  Fixture,
  {
    calls: ComputerPrune.Input[]
    failure?: "invalid" | "storage"
    protectedReads: number
    protectionFailure?: boolean
  }
>()("test/ComputerPruneHttp") {}

const fixture = Layer.sync(Fixture, () => ({ calls: [], protectedReads: 0 }))
const storage = Layer.effect(
  ComputerPrune.Service,
  Effect.gen(function* () {
    const state = yield* Fixture
    return ComputerPrune.Service.of({
      prune: (input) =>
        Effect.gen(function* () {
          state.calls.push(input)
          if (state.failure)
            return yield* new ComputerPrune.Error({ code: state.failure, message: "Private storage failure detail" })
          return { removed: 2 }
        }),
    })
  }),
)

// Exercise the real route, decoder and authorization with fake storage and no project/desktop process.
const routes = HttpApiBuilder.layer(HttpApi.make("vector-instance").add(ComputerApi.groups.computer)).pipe(
  Layer.provide(computerHandlers),
  Layer.provide(authorizationLayer),
  Layer.provide(schemaErrorLayer),
  Layer.provide(
    Layer.succeed(
      InstanceContextMiddleware,
      InstanceContextMiddleware.of((effect) => effect),
    ),
  ),
  Layer.provide(
    Layer.succeed(
      WorkspaceRoutingMiddleware,
      WorkspaceRoutingMiddleware.of((effect) =>
        effect.pipe(Effect.provideService(WorkspaceRouteContext, { directory: "/fixture" })),
      ),
    ),
  ),
  Layer.provide(storage),
  Layer.provide(
    Layer.effect(
      ComputerProtection.Service,
      Effect.gen(function* () {
        const state = yield* Fixture
        return ComputerProtection.Service.of({
          read: () =>
            Effect.gen(function* () {
              state.protectedReads++
              if (state.protectionFailure) return yield* new ComputerProtection.Error()
              return { paths: ["/private/custom-rules.txt"], directories: ["/private/vector-config"] }
            }),
        })
      }),
    ),
  ),
  Layer.provide(Layer.mock(Session.Service)({})),
  Layer.provide(
    ServerAuth.Config.configLayer({
      username: "vector",
      password: Option.some("fixture-owner"),
      guestUsername: "guest",
      guestPassword: Option.some("fixture-guest"),
    }),
  ),
)
const it = testEffect(
  HttpRouter.serve(routes, { disableListenLog: true, disableLogger: true }).pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provideMerge(fixture),
  ),
)

const post = (payload: unknown, identity: "owner" | "guest" | "missing" = "owner") =>
  HttpClientRequest.post(ComputerPaths.prune).pipe(
    HttpClientRequest.bodyJsonUnsafe(payload),
    identity === "missing"
      ? (request) => request
      : HttpClientRequest.setHeader(
          "authorization",
          ServerAuth.header({
            username: identity === "owner" ? "vector" : "guest",
            password: identity === "owner" ? "fixture-owner" : "fixture-guest",
          })!,
        ),
    HttpClient.execute,
  )

it.live("the owner can request scoped screenshot deletion through the declared route", () =>
  Effect.gen(function* () {
    const state = yield* Fixture
    const response = yield* post({ before: 100 })
    expect(response.status).toBe(200)
    expect(yield* response.json).toEqual({ removed: 2 })
    expect(state.calls).toEqual([{ before: 100 }])
  }),
)

it.live("guests and unauthenticated callers never reach screenshot deletion", () =>
  Effect.gen(function* () {
    const state = yield* Fixture
    expect((yield* post({ all: true }, "missing")).status).toBe(401)
    expect((yield* post({ all: true }, "guest")).status).toBe(403)
    expect(state.calls).toEqual([])
  }),
)

it.live("invalid screenshot deletion payloads do not reach storage", () =>
  Effect.gen(function* () {
    const state = yield* Fixture
    for (const payload of [{ before: -1 }, { before: "yesterday" }, { all: "yes" }]) {
      expect((yield* post(payload)).status).toBe(400)
    }
    expect(state.calls).toEqual([])
  }),
)

it.live("storage failure reports failure without exposing private database detail", () =>
  Effect.gen(function* () {
    const state = yield* Fixture
    state.failure = "storage"
    const response = yield* post({ all: true })
    expect(response.status).toBe(500)
    const body = yield* response.text
    expect(body).toContain("could not be fully deleted")
    expect(body).not.toContain("Private storage failure detail")
  }),
)

it.live("invalid selector combinations return a client error", () =>
  Effect.gen(function* () {
    const state = yield* Fixture
    state.failure = "invalid"
    expect((yield* post({})).status).toBe(400)
  }),
)

const protection = (identity: "owner" | "guest" | "missing" = "owner") =>
  HttpClientRequest.get(ComputerPaths.protection).pipe(
    identity === "missing"
      ? (request) => request
      : HttpClientRequest.setHeader(
          "authorization",
          ServerAuth.header({
            username: identity === "owner" ? "vector" : "guest",
            password: identity === "owner" ? "fixture-owner" : "fixture-guest",
          })!,
        ),
    HttpClient.execute,
  )

it.live("only the authenticated owner can read trusted protected paths", () =>
  Effect.gen(function* () {
    const state = yield* Fixture
    expect((yield* protection("guest")).status).toBe(403)
    expect((yield* protection("missing")).status).toBe(401)
    expect(state.protectedReads).toBe(0)
    const response = yield* protection()
    expect(response.status).toBe(200)
    expect(yield* response.json).toEqual({
      paths: ["/private/custom-rules.txt"],
      directories: ["/private/vector-config"],
    })
    expect(state.protectedReads).toBe(1)
  }),
)

it.live("a failed protected path read fails closed with fixed public copy", () =>
  Effect.gen(function* () {
    const state = yield* Fixture
    state.protectionFailure = true
    const response = yield* protection()
    expect(response.status).toBe(500)
    expect(JSON.stringify(yield* response.json)).toContain("Protected computer paths could not be checked.")
  }),
)
