import { afterAll, describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Schema } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { ServerAuth } from "../auth"
import { RequestPrincipal } from "@vectordevai/protocol/middleware/authorization"
import { Authorization, authorizationLayer } from "./authorization"

const Api = HttpApi.make("guest-gate").add(
  HttpApiGroup.make("test")
    .add(
      HttpApiEndpoint.get("connect", "/api/pty/:ptyID/connect", {
        params: { ptyID: Schema.String },
        success: Schema.String,
      }),
      HttpApiEndpoint.post("pty", "/api/pty", { success: Schema.String }),
      HttpApiEndpoint.post("reply", "/api/session/:sessionID/permission/:requestID/reply", {
        params: { sessionID: Schema.String, requestID: Schema.String },
        success: Schema.String,
      }),
      HttpApiEndpoint.get("messages", "/api/session/:sessionID/message", {
        params: { sessionID: Schema.String },
        success: Schema.String,
      }),
      HttpApiEndpoint.post("steal", "/sync/steal", { success: Schema.String }),
      HttpApiEndpoint.post("replay", "/sync/replay", { success: Schema.String }),
    )
    .middleware(Authorization),
)

const handlers = HttpApiBuilder.group(Api, "test", (handlers) =>
  handlers
    .handle("connect", () =>
      RequestPrincipal.pipe(
        Effect.map((principal) => (principal.kind === "pty-ticket" ? principal.ptyID : principal.kind)),
      ),
    )
    .handle("pty", () => Effect.succeed("ran"))
    .handle("reply", () => Effect.succeed("ran"))
    .handle("messages", () => Effect.succeed("ran"))
    .handle("steal", () => Effect.succeed("ran"))
    .handle("replay", () => Effect.succeed("ran")),
)

const web = HttpRouter.toWebHandler(
  HttpApiBuilder.layer(Api).pipe(
    Layer.provide(handlers),
    Layer.provide(authorizationLayer),
    Layer.provide(
      ServerAuth.Config.configLayer({
        password: Option.some("owner-secret"),
        username: "vector",
        guestPassword: Option.some("guest-secret"),
        guestUsername: "guest",
      }),
    ),
    Layer.provide(HttpServer.layerServices),
  ),
  { disableLogger: true },
)
afterAll(() => web.dispose())

const send = (method: string, path: string, username: string, password: string) =>
  web
    .handler(
      new Request(`http://localhost${path}`, {
        method,
        headers: { authorization: ServerAuth.header({ username, password }) ?? "" },
      }),
    )
    .then((response) => response.status)

describe("guest owner-only gate", () => {
  test("owner credentials relaying a guest cannot reach owner-only handlers", async () => {
    const headers = {
      authorization: ServerAuth.header({ username: "vector", password: "owner-secret" }) ?? "",
      "x-vector-guest-request": "1",
    }
    expect((await web.handler(new Request("http://localhost/api/pty", { method: "POST", headers }))).status).toBe(403)
    expect(
      (
        await web.handler(
          new Request("http://localhost/api/pty", {
            method: "POST",
            headers: { ...headers, "x-vector-guest-request": "1, 1" },
          }),
        )
      ).status,
    ).toBe(403)
    expect(
      (await web.handler(new Request("http://localhost/api/session/ses_public/message", { headers }))).status,
    ).toBe(200)
  })
  // Engines before WP28 steal a warped session with the marker to say a guest worked in it; the steal handler takes
  // that request as a guest's (it refuses a private session and records guest input), so it is let through. A guest's
  // own credentials, and the marker on every other owner-only route, stay refused.
  test("only a warp's steal carrying the forwarded-guest marker reaches its handler", async () => {
    const forwarded = {
      authorization: ServerAuth.header({ username: "vector", password: "owner-secret" }) ?? "",
      "x-vector-guest-request": "1",
    }
    const status = (path: string, headers: Record<string, string>) =>
      web
        .handler(new Request(`http://localhost${path}`, { method: "POST", headers }))
        .then((response) => response.status)
    expect(await status("/sync/steal", forwarded)).toBe(200)
    expect(await status("/SYNC//steal;x", forwarded)).toBe(200)
    expect(await status("/sync/replay", forwarded)).toBe(403)
    expect(await send("POST", "/sync/steal", "guest", "guest-secret")).toBe(403)
    expect(await send("POST", "/sync/steal", "vector", "owner-secret")).toBe(200)
  })
  // The router ignores case, repeated and trailing slashes and anything after ';', and a URL parser reads a
  // leading '//' as a host, so each of these runs the owner-only handler unless the gate judges the matched route.
  const spellings = (route: string) => [
    route,
    `/${route}`,
    `//${route}`,
    route.toUpperCase(),
    `${route}/`,
    `${route};x`,
    route.replace(/\/(?=[^/]*$)/, "//"),
  ]

  test("recognises ticket access only for the matched GET connect route and its params", async () => {
    for (const path of ["/api/pty/pty_probe/connect", "/API/PTY/pty_probe/CONNECT/", "/api//pty/pty_probe/connect;x"]) {
      const response = await web.handler(new Request(`http://localhost${path}?ticket=placeholder`))
      expect(response.status).toBe(200)
      expect(await response.json()).toBe("pty_probe")
    }
    expect(
      (await web.handler(new Request("http://localhost/api/session/ses_1/message?ticket=placeholder"))).status,
    ).toBe(401)
    expect(
      (await web.handler(new Request("http://localhost/api/pty?ticket=placeholder", { method: "POST" }))).status,
    ).toBe(401)
  })

  test("refuses a guest every spelling of an owner-only route", async () => {
    const attempts = [...spellings("/api/pty"), ...spellings("/api/session/ses_1/permission/per_1/reply")]
    const statuses = await Promise.all(attempts.map((route) => send("POST", route, "guest", "guest-secret")))
    expect(statuses.map((status, index) => ({ route: attempts[index], status }))).toEqual(
      attempts.map((route) => ({ route, status: 403 })),
    )
  })

  test("still serves the owner and a guest's own routes under the router's spellings", async () => {
    expect(await send("POST", "/API/PTY", "vector", "owner-secret")).toBe(200)
    expect(await send("POST", "/api//pty;x", "vector", "owner-secret")).toBe(200)
    expect(await send("GET", "/API/Session/ses_1/Message/", "guest", "guest-secret")).toBe(200)
  })
})
