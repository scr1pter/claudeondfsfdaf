import { expect } from "bun:test"
import { Effect } from "effect"
import { HttpServer } from "effect/unstable/http"
import { createVectorClient } from "@vectordevai/sdk/v2"
import { testEffect } from "../lib/effect"
import { httpApiLayer } from "./httpapi-layer"

const it = testEffect(httpApiLayer)

it.live("auth presence is secret-free and create-only writes return a conflict", () =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer
    const client = createVectorClient({ baseUrl: HttpServer.formatAddress(server.address) })
    const providerID = "http-create-only-fixture"
    yield* Effect.promise(() => client.auth.remove({ providerID }, { throwOnError: true }))
    const absent = yield* Effect.promise(() => client.auth.exists({ providerID }, { throwOnError: true }))
    expect(absent.data).toBe(false)
    const saved = yield* Effect.promise(() =>
      client.auth.set({ providerID, ifAbsent: "true", auth: { type: "api", key: "first-fixture" } }),
    )
    expect(saved.response.status).toBe(200)
    const exists = yield* Effect.promise(() => client.auth.exists({ providerID }, { throwOnError: true }))
    expect(exists.data).toBe(true)
    expect(JSON.stringify(exists.data)).not.toContain("first-fixture")
    const conflict = yield* Effect.promise(() =>
      client.auth.set({ providerID, ifAbsent: "true", auth: { type: "api", key: "second-fixture" } }),
    )
    expect(conflict.response.status).toBe(409)
    expect(conflict.error).toMatchObject({ message: expect.stringContaining("already exists") })
    const replaced = yield* Effect.promise(() =>
      client.auth.set({ providerID, auth: { type: "api", key: "intentional-replacement" } }),
    )
    expect(replaced.response.status).toBe(200)
    yield* Effect.promise(() => client.auth.remove({ providerID }, { throwOnError: true }))
  }),
)

it.live("writing the Vector account credential through the real route graph answers at once", () =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer
    const client = createVectorClient({ baseUrl: HttpServer.formatAddress(server.address) })
    // Engine tests set VECTOR_DISABLE_MODELS_FETCH, which keeps the forced Codium read off vectordev.ai like every
    // catalog read, so this checks only that the handler's services are bound and it answers. That the write forces the
    // read, with which credential and for how long, is httpapi-auth-codium.test.ts.
    const saved = yield* Effect.promise(() =>
      client.auth.set({ providerID: "vector", auth: { type: "api", key: "vct_synthetic-account.token" } }),
    )
    expect(saved.response.status).toBe(200)
    expect(saved.data).toBe(true)
    yield* Effect.promise(() => client.auth.remove({ providerID: "vector" }, { throwOnError: true }))
  }),
)
