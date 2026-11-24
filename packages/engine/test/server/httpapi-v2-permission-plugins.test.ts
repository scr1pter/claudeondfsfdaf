import { expect, test } from "bun:test"
import { AgentV2 } from "@vectordevai/core/agent"
import { makeLocationNode } from "@vectordevai/core/effect/app-node"
import { PluginInternal } from "@vectordevai/core/plugin/internal"
import { createEmbeddedRoutes } from "@vectordevai/server/routes"
import { Context, Deferred, Effect, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { tmpdir } from "../fixture/fixture"

// Stands in for a Location's built-in plugins: like the real boot, it adds the build agent's rules in the background and
// only then answers `ready`. The test decides when the boot finishes, and learns when a request starts waiting for it.
const waiting = Deferred.makeUnsafe<void>()
const release = Deferred.makeUnsafe<void>()
const plugins = makeLocationNode({
  service: PluginInternal.Service,
  layer: Layer.effect(
    PluginInternal.Service,
    Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      const booted = yield* Deferred.make<void>()
      yield* Deferred.await(release).pipe(
        Effect.andThen(
          agents.transform((draft) =>
            draft.update(AgentV2.defaultID, (agent) => {
              agent.mode = "primary"
              agent.permissions.push(...AgentV2.readDefaults)
            }),
          ),
        ),
        Effect.ensuring(Deferred.succeed(booted, undefined)),
        Effect.forkScoped,
      )
      return PluginInternal.Service.of({
        ready: Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Deferred.await(booted))),
      })
    }),
  ),
  deps: [AgentV2.node],
})

test("a permission request made while the Location's plugins load is judged by the agent they add", async () => {
  await using dir = await tmpdir()
  const web = HttpRouter.toWebHandler(
    createEmbeddedRoutes([[PluginInternal.node, plugins]]).pipe(Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  )
  const call = (route: string, init: RequestInit = {}) =>
    web.handler(
      new Request(`http://localhost${route}`, {
        ...init,
        headers: { "content-type": "application/json", "x-vector-directory": dir.path },
      }),
      Context.empty() as Context.Context<unknown>,
    )
  try {
    const created = await call("/api/session", {
      method: "POST",
      body: JSON.stringify({ agent: "build", location: { directory: dir.path } }),
    })
    expect(created.status).toBe(200)
    const session = ((await created.json()) as { data: { id: string } }).data

    // The session's first permission request is what finds the plugins still loading. Judged before they finish, it
    // would read no agent and be denied at once.
    const asked = call(`/api/session/${session.id}/permission`, {
      method: "POST",
      body: JSON.stringify({ action: "read", resources: [".env"] }),
    })
    const first = await Promise.race([
      Effect.runPromise(Deferred.await(waiting)).then(() => "waiting for plugins"),
      asked.then(() => "answered"),
    ])
    expect(first).toBe("waiting for plugins")

    Deferred.doneUnsafe(release, Effect.void)
    const response = await asked
    expect(response.status).toBe(200)
    const result = ((await response.json()) as { data: { id: string; effect: string } }).data
    expect(result.effect).toBe("ask")
    const pending = await call(`/api/session/${session.id}/permission`)
    expect(((await pending.json()) as { data: Array<{ id: string }> }).data.map((item) => item.id)).toEqual([result.id])
  } finally {
    await web.dispose()
  }
})

test("v2 refuses a bare Connect approval and continues to accept ordinary permission answers", async () => {
  await using dir = await tmpdir()
  const readyPlugins = makeLocationNode({
    service: PluginInternal.Service,
    layer: Layer.effect(
      PluginInternal.Service,
      Effect.gen(function* () {
        const agents = yield* AgentV2.Service
        yield* agents.transform((draft) =>
          draft.update(AgentV2.defaultID, (agent) => {
            agent.mode = "primary"
            agent.permissions.push(...AgentV2.readDefaults)
          }),
        )
        return PluginInternal.Service.of({ ready: Effect.void })
      }),
    ),
    deps: [AgentV2.node],
  })
  const web = HttpRouter.toWebHandler(
    createEmbeddedRoutes([[PluginInternal.node, readyPlugins]]).pipe(Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  )
  const call = (route: string, payload?: object) =>
    web.handler(
      new Request(`http://localhost${route}`, {
        ...(payload && { method: "POST", body: JSON.stringify(payload) }),
        headers: { "content-type": "application/json", "x-vector-directory": dir.path },
      }),
      Context.empty() as Context.Context<unknown>,
    )
  try {
    const created = await call("/api/session", { agent: "build", location: { directory: dir.path } })
    expect(created.status).toBe(200)
    const session = ((await created.json()) as { data: { id: string } }).data
    const route = `/api/session/${session.id}/permission`
    for (const action of ["connect_write", "connect_cloud", "read"]) {
      const asked = await call(route, { action, resources: [".env"] })
      expect(asked.status).toBe(200)
      const request = ((await asked.json()) as { data: { id: string; effect: string } }).data
      expect(request.effect).toBe("ask")
      const pending = `${route}/${request.id}`
      const reply = `${pending}/reply`
      if (action === "read") {
        expect((await call(reply, { reply: "once" })).status).toBe(204)
      } else {
        const refused = await call(reply, { reply: "once" })
        expect(refused.status).toBe(409)
        expect(await refused.json()).toMatchObject({ resource: request.id })
        expect((await call(reply, { reply: "always", confirm: true })).status).toBe(409)
        expect((await call(pending)).status).toBe(200)
        expect((await call(reply, { reply: "once", confirm: true })).status).toBe(204)
      }
      expect((await call(pending)).status).toBe(404)
    }
  } finally {
    await web.dispose()
  }
})
