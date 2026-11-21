import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Flag } from "@vectordevai/core/flag/flag"
import { describe, expect } from "bun:test"
import { Config, ConfigProvider, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { Server } from "../../src/server/server"
import { InstancePaths } from "../../src/server/routes/instance/httpapi/groups/instance"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"

const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const original = {
      VECTOR_SERVER_PASSWORD: Flag.VECTOR_SERVER_PASSWORD,
    }
    Flag.VECTOR_SERVER_PASSWORD = "secret"
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        Flag.VECTOR_SERVER_PASSWORD = original.VECTOR_SERVER_PASSWORD
        await resetDatabase()
      }),
    )
  }),
)

const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  { disableListenLog: true, disableLogger: true },
)

const it = testEffect(
  Layer.mergeAll(
    testStateLayer,
    servedRoutes.pipe(
      Layer.provide(Socket.layerWebSocketConstructorGlobal),
      Layer.provideMerge(NodeHttpServer.layerTest),
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
)

describe("HttpApi CORS", () => {
  it.live("allows browser preflight requests without credentials", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.options(InstancePaths.path).pipe(
        HttpClientRequest.setHeaders({
          origin: "http://localhost:3000",
          "access-control-request-method": "GET",
          "access-control-request-headers": "authorization",
        }),
        HttpClient.execute,
      )

      expect(response.status).toBe(204)
      expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:3000")
      expect(response.headers["access-control-allow-headers"]).toBe("authorization")
    }),
  )

  it.live("does not trust upstream web origins by default", () =>
    Effect.gen(function* () {
      const handler = HttpRouter.toWebHandler(
        HttpApiApp.createRoutes().pipe(
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ VECTOR_SERVER_PASSWORD: "secret" }))),
        ),
        { disableLogger: true },
      ).handler
      const response = yield* Effect.promise(() =>
        handler(
          new Request(new URL("/global/config", "http://localhost"), {
            headers: { origin: "https://app.untrusted.example.net" },
          }),
          HttpApiApp.context,
        ),
      )

      // A page from an untrusted site is refused before authentication, so cached browser credentials cannot help it.
      expect(response.status).toBe(403)
      expect(response.headers.get("access-control-allow-origin")).toBeNull()
    }),
  )

  it.live("rejects every upstream subdomain from the default CORS allowlist", () =>
    Effect.gen(function* () {
      for (const origin of [
        "https://untrusted.example.net",
        "https://app.untrusted.example.net",
        "https://console.untrusted.example.net",
        "https://nested.app.untrusted.example.net",
      ]) {
        const response = yield* HttpClientRequest.options(InstancePaths.path).pipe(
          HttpClientRequest.setHeaders({ origin, "access-control-request-method": "GET" }),
          HttpClient.execute,
        )
        expect(response.headers["access-control-allow-origin"]).toBeUndefined()
      }
    }),
  )

  it.live("uses custom CORS origins passed to the server", () =>
    Effect.gen(function* () {
      const listener = yield* Effect.acquireRelease(
        Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0, cors: ["https://custom.example"] })),
        (listener) => Effect.promise(() => listener.stop(true)),
      )

      // Server.listen prefers port 4096, so a pooled keep-alive socket from an earlier test's server could swallow a request.
      const response = yield* Effect.promise(() =>
        fetch(new URL(InstancePaths.path, listener.url), {
          method: "OPTIONS",
          keepalive: false,
          headers: {
            origin: "https://custom.example",
            "access-control-request-method": "GET",
            "access-control-request-headers": "authorization",
          },
        }),
      )

      expect(response.status).toBe(204)
      expect(response.headers.get("access-control-allow-origin")).toBe("https://custom.example")
      expect(response.headers.get("access-control-allow-headers")).toBe("authorization")

      const rejected = yield* Effect.promise(() =>
        fetch(new URL(InstancePaths.path, listener.url), {
          method: "OPTIONS",
          keepalive: false,
          headers: {
            origin: "https://evil.example",
            "access-control-request-method": "GET",
            "access-control-request-headers": "authorization",
          },
        }),
      )

      expect(rejected.status).toBe(204)
      expect(rejected.headers.get("access-control-allow-origin")).not.toBe("https://evil.example")
    }),
  )
})
