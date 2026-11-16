import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Redacted, Schema } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { ServerAuth } from "./auth"
import { Authorization, authorizationLayer } from "./middleware/authorization"

describe("server authentication", () => {
  test("review-memory reads, preparation, confirmation and discard are owner-only", () => {
    for (const [method, route] of [
      ["GET", "/experimental/review-memory"],
      ["HEAD", "/experimental/review-memory"],
      ["POST", "/experimental/review-memory/prepare"],
      ["POST", "/experimental/review-memory/confirm"],
      ["DELETE", "/experimental/review-memory/previews/:previewId"],
      ["DELETE", "/experimental/review-memory/previews/01234567-89ab-4cde-8fab-0123456789ab"],
    ])
      expect(ServerAuth.isOwnerOnlyRoute(method!, route!)).toBe(true)
  })

  test("review-memory classification does not claim neighboring routes or parse raw query paths", () => {
    // The classifier receives the router's declared pattern, not a URL or a substring borrowed from its query.
    for (const route of [
      "/experimental/review-memory-public",
      "/experimental/review-memory2",
      "/experimental/review-memories",
      "/experimental/review",
      "/public/experimental/review-memory",
      "/experimental/review-memory?next=/private",
      "/experimental/review-memory-public?next=/experimental/review-memory/confirm",
    ])
      for (const method of ["GET", "HEAD", "POST", "DELETE"])
        expect(ServerAuth.isOwnerOnlyRoute(method, route)).toBe(false)
  })

  test("the actual matched-route gate refuses guest and forwarded-owner requests before review-memory handlers", async () => {
    let reached = 0
    const api = HttpApi.make("review-memory-owner-gate").add(
      HttpApiGroup.make("test")
        .add(
          HttpApiEndpoint.get("inspect", "/experimental/review-memory", { success: Schema.String }),
          HttpApiEndpoint.post("prepare", "/experimental/review-memory/prepare", { success: Schema.String }),
          HttpApiEndpoint.post("confirm", "/experimental/review-memory/confirm", { success: Schema.String }),
          HttpApiEndpoint.delete("discard", "/experimental/review-memory/previews/:previewId", {
            params: { previewId: Schema.String },
            success: Schema.String,
          }),
          HttpApiEndpoint.get("neighbor", "/experimental/review-memory-public", { success: Schema.String }),
        )
        .middleware(Authorization),
    )
    const privateHandler = () =>
      Effect.sync(() => {
        reached++
        return "private control"
      })
    const handlers = HttpApiBuilder.group(api, "test", (handlers) =>
      handlers
        .handle("inspect", privateHandler)
        .handle("prepare", privateHandler)
        .handle("confirm", privateHandler)
        .handle("discard", privateHandler)
        .handle("neighbor", () => Effect.succeed("public neighbor")),
    )
    const web = HttpRouter.toWebHandler(
      HttpApiBuilder.layer(api).pipe(
        Layer.provide(handlers),
        Layer.provide(authorizationLayer),
        Layer.provide(
          ServerAuth.Config.configLayer({
            password: Option.some("owner-fixture"),
            username: "owner",
            guestPassword: Option.some("guest-fixture"),
            guestUsername: "guest",
          }),
        ),
        Layer.provide(HttpServer.layerServices),
      ),
      { disableLogger: true },
    )
    const send = (method: string, route: string, guest: boolean, forwarded = false) =>
      web.handler(
        new Request(`http://localhost${route}`, {
          method,
          headers: {
            authorization:
              ServerAuth.header({
                username: guest ? "guest" : "owner",
                password: guest ? "guest-fixture" : "owner-fixture",
              }) ?? "",
            ...(forwarded ? { "x-vector-guest-request": "1" } : {}),
          },
        }),
      )
    try {
      const routes = [
        ["GET", "/experimental/review-memory"],
        ["HEAD", "/experimental/review-memory"],
        ["GET", "/EXPERIMENTAL//review-memory;x?next=/public"],
        ["POST", "/experimental/review-memory/prepare?next=/public"],
        ["POST", "/experimental/review-memory/confirm"],
        ["DELETE", "/experimental/review-memory/previews/preview_1"],
      ] as const
      for (const [method, route] of routes) {
        expect((await send(method, route, true)).status).toBe(403)
        expect((await send(method, route, false, true)).status).toBe(403)
      }
      expect(reached).toBe(0)
      for (const [method, route] of routes) expect((await send(method, route, false)).status).toBe(200)
      expect(reached).toBe(routes.length)
      const neighbor = await send(
        "GET",
        "/experimental/review-memory-public?next=/experimental/review-memory/confirm",
        true,
      )
      expect(neighbor.status).toBe(200)
      expect(await neighbor.json()).toBe("public neighbor")
      expect(reached).toBe(routes.length)
    } finally {
      await web.dispose()
    }
  })

  test("local review starts, discovery, results and stop are owner-only", () => {
    for (const [method, route] of [
      ["POST", "/experimental/session/:sessionID/review"],
      ["GET", "/experimental/session/:sessionID/review"],
      ["GET", "/experimental/session/:sessionID/review/target"],
      ["GET", "/experimental/session/:sessionID/review/:runID"],
      ["POST", "/experimental/session/:sessionID/review/:runID/stop"],
    ])
      expect(ServerAuth.isOwnerOnlyRoute(method!, route!)).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("GET", "/experimental/session/ses_review/review/ses_run")).toBe(true)
  })
  test("an empty owner password cannot bypass guest authentication", () => {
    const config = {
      password: Option.some(""),
      username: "vector",
      guestPassword: Option.some("guest-secret"),
    }

    expect(ServerAuth.required(config)).toBe(true)
    expect(ServerAuth.identity({ username: "vector", password: Redacted.make("") }, config)).toBeUndefined()
    expect(ServerAuth.identity({ username: "guest", password: Redacted.make("guest-secret") }, config)).toBe("guest")
  })

  test("nonempty owner credentials remain valid", () => {
    const config = { password: Option.some("owner-secret"), username: "vector" }
    expect(ServerAuth.identity({ username: "vector", password: Redacted.make("owner-secret") }, config)).toBe("owner")
    expect(ServerAuth.identity({ username: "vector", password: Redacted.make("") }, config)).toBeUndefined()
  })

  test("Teams routes require the server owner", () => {
    expect(ServerAuth.isOwnerOnlyRoute("GET", "/experimental/console")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("GET", "/experimental/console/orgs")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/experimental/console/switch")).toBe(true)
  })

  test("memory is the owner's own, so a guest can neither read nor change it", () => {
    for (const [method, route] of [
      ["GET", "/memory"],
      ["GET", "/memory/:memoryID"],
      ["GET", "/memory/settings"],
      ["POST", "/memory"],
      ["PATCH", "/memory/:memoryID"],
      ["DELETE", "/memory/:memoryID"],
      ["POST", "/memory/erase"],
    ])
      expect(ServerAuth.isOwnerOnlyRoute(method!, route!)).toBe(true)
  })

  test("documents and what Vector read from them are the owner's own too", () => {
    for (const [method, route] of [
      ["GET", "/memory/documents"],
      ["POST", "/memory/documents"],
      ["POST", "/memory/documents/path"],
      ["POST", "/memory/documents/text"],
      ["POST", "/memory/documents/probe"],
      ["GET", "/memory/documents/:documentID"],
      ["PATCH", "/memory/documents/:documentID"],
      ["DELETE", "/memory/documents/:documentID"],
      ["GET", "/memory/documents/:documentID/pages/:page"],
      ["GET", "/memory/documents/:documentID/file"],
      ["GET", "/memory/documents/:documentID/distill"],
      ["POST", "/memory/documents/:documentID/distill"],
      ["GET", "/memory/records"],
      ["GET", "/memory/records/:recordID"],
      ["PATCH", "/memory/records/:recordID"],
      ["GET", "/memory/knowledge"],
      ["PATCH", "/memory/settings"],
    ])
      expect(ServerAuth.isOwnerOnlyRoute(method!, route!)).toBe(true)
  })

  test("Vector Local is the owner's own: its settings, its checks and the network log", () => {
    for (const [method, route] of [
      ["GET", "/local"],
      ["PATCH", "/local"],
      ["GET", "/local/egress"],
      ["GET", "/local/egress/summary"],
      ["GET", "/local/egress/export"],
      ["DELETE", "/local/egress"],
      ["POST", "/local/egress/report"],
      ["POST", "/local/detect"],
      ["POST", "/local/probe"],
      ["POST", "/local/servers"],
      ["POST", "/local/check"],
      ["POST", "/local/grant"],
      ["POST", "/local/startup/release"],
      ["GET", "/local/recommend"],
      ["HEAD", "/local"],
    ])
      expect(ServerAuth.isOwnerOnlyRoute(method!, route!)).toBe(true)
    // Only the local group: a route that merely starts with the same letters is judged on its own.
    expect(ServerAuth.isOwnerOnlyRoute("GET", "/locale")).toBe(false)
  })

  test("what documents are linked to, and what needs the owner's look, are the owner's own", () => {
    for (const [method, route] of [
      ["GET", "/memory/links"],
      ["GET", "/memory/review"],
      ["PATCH", "/memory/review/:itemID"],
    ])
      expect(ServerAuth.isOwnerOnlyRoute(method!, route!)).toBe(true)
  })

  test("a guest can neither open, list, read, resize nor type into any terminal, a coding agent's included", () => {
    // A coding agent the owner starts from Host locally runs in one of these terminals, signed in to the owner's own
    // account, so no terminal route of either API answers a guest.
    for (const base of ["/pty", "/api/pty"])
      for (const [method, route] of [
        ["GET", base],
        ["POST", base],
        ["GET", `${base}/shells`],
        ["GET", `${base}/:ptyID`],
        ["PUT", `${base}/:ptyID`],
        ["DELETE", `${base}/:ptyID`],
        ["GET", `${base}/:ptyID/connect-token`],
        ["POST", `${base}/:ptyID/connect-token`],
        ["GET", `${base}/:ptyID/connect`],
      ])
        expect(ServerAuth.isOwnerOnlyRoute(method!, route!)).toBe(true)
  })

  test("merging or discarding an isolated subagent's changes is the owner's; reviewing their counts is not", () => {
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/experimental/session/:sessionID/tasks/:taskID/merge")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/experimental/session/:sessionID/tasks/:taskID/discard")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("GET", "/experimental/session/:sessionID/tasks/:taskID/changes")).toBe(false)
    // Neighbouring task routes keep their own rules.
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/experimental/session/:sessionID/tasks/:taskID/message")).toBe(false)
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/experimental/session/:sessionID/tasks/stop")).toBe(false)
  })

  test("every connected-tool route requires the owner for every method", () => {
    for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
      for (const route of [
        "/experimental/connect",
        "/experimental/connect/runs",
        "/experimental/connect/runs/cr_123",
        "/experimental/connect/runs/cr_123/cancel",
        "/experimental/connect/findings",
        "/experimental/connect/review",
        "/experimental/session/ses_123/connect",
      ])
        expect(ServerAuth.isOwnerOnlyRoute(method, route)).toBe(true)
    }
    expect(ServerAuth.isOwnerOnlyRoute("GET", "/experimental/connected")).toBe(false)
  })

  test("host commands and permission answers require the server owner", () => {
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/pty")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("GET", "/pty/:ptyID/connect-token")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/api/pty")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/session/:sessionID/shell")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/session/:sessionID/command")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/session/:sessionID/init")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/permission/:requestID/reply")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/session/:sessionID/permissions/:permissionID")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/api/session/:sessionID/permission/:requestID/reply")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("GET", "/api/permission/request")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("GET", "/api/question/request")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("PUT", "/auth/:providerID")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("PATCH", "/config")).toBe(true)
    // Trusting a project lets its config run code, so it is the owner's call too.
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/config/trust")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("GET", "/config/trust")).toBe(false)
    // The held prompt files are the owner's paths, and approving them loads what an agent may have written.
    expect(ServerAuth.isOwnerOnlyRoute("GET", "/config/prompt-trust")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/config/prompt-trust/approve")).toBe(true)
    // Accepting that free models may train on prompts is the owner's choice; a guest may only read it.
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/provider/free-models/consent")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("GET", "/provider/free-models/consent")).toBe(false)
    // The app bootstraps from these, so a guest reads them, narrowed to its workspace by their handlers.
    for (const route of ["/global/health", "/global/event", "/global/config", "/project", "/project/current"])
      expect(ServerAuth.isOwnerOnlyRoute("GET", route)).toBe(false)
    expect(ServerAuth.isOwnerOnlyRoute("PATCH", "/global/config")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/global/dispose")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("GET", "/project/:projectID/directories")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("PATCH", "/project/:projectID")).toBe(true)
    // A new worktree runs startup commands; removing or resetting one discards work outside the guest's workspace.
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/experimental/worktree")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("DELETE", "/experimental/worktree")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/experimental/worktree/reset")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("GET", "/experimental/worktree")).toBe(false)
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/vcs/commit")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/vcs/switch")).toBe(true)
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/vcs/apply")).toBe(false)
    expect(ServerAuth.isOwnerOnlyRoute("GET", "/vcs/status")).toBe(false)
    // A guest still prompts, reads its own pending requests and answers its own questions.
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/session/:sessionID/message")).toBe(false)
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/session/:sessionID/prompt_async")).toBe(false)
    expect(ServerAuth.isOwnerOnlyRoute("GET", "/permission")).toBe(false)
    expect(ServerAuth.isOwnerOnlyRoute("GET", "/api/session/:sessionID/permission")).toBe(false)
    expect(ServerAuth.isOwnerOnlyRoute("POST", "/question/:requestID/reply")).toBe(false)
  })

  test("reusable passwords require loopback or encrypted transport", () => {
    expect(() => ServerAuth.assertSecurePasswordTransport("127.0.0.1", "secret")).not.toThrow()
    expect(() => ServerAuth.assertSecurePasswordTransport("http://localhost:4096", "secret")).not.toThrow()
    expect(() => ServerAuth.assertSecurePasswordTransport("https://vector.example", "secret")).not.toThrow()
    for (const host of ["10.0.0.2", "192.168.1.4", "172.20.0.5", "100.64.0.1", "vector.local", "vector", "[fd00::1]"]) {
      expect(() => ServerAuth.assertSecurePasswordTransport(`http://${host}:4096`, "secret")).not.toThrow()
    }
    expect(() => ServerAuth.assertSecurePasswordTransport("http://vector.example", "secret")).toThrow("cleartext")
    expect(() => ServerAuth.assertSecurePasswordTransport("0.0.0.0", "secret")).toThrow("cleartext")
    expect(() => ServerAuth.assertSecurePasswordTransport("http://vector.example", undefined)).not.toThrow()
  })

  test("a password listener binds off loopback only on a network marked trusted, like vector serve", () => {
    for (const host of ["127.0.0.1", "localhost", "::1"])
      expect(() => ServerAuth.assertSecurePasswordListen(host, "secret", false)).not.toThrow()
    for (const host of ["0.0.0.0", "::", "192.168.1.4", "10.0.0.2", "vector.local", "vector", "vector.example"]) {
      expect(() => ServerAuth.assertSecurePasswordListen(host, "secret", false)).toThrow("--trusted-network")
      expect(() => ServerAuth.assertSecurePasswordListen(host, "secret", true)).not.toThrow()
    }
    expect(() => ServerAuth.assertSecurePasswordListen("0.0.0.0", undefined, false)).not.toThrow()
  })
})
