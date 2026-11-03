import { NodeHttpServer } from "@effect/platform-node"
import { SessionAudience } from "@vectordevai/core/session/audience"
import fs from "fs/promises"
import { connect } from "node:net"
import path from "path"
import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Queue, Redacted, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer, HttpServerRequest } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { ServerAuth } from "../../src/server/auth"
import { Authorization, authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { allowsSession, allowsWorkspace, RequestPrincipal } from "@vectordevai/protocol/middleware/authorization"
import { EventPaths } from "../../src/server/routes/instance/httpapi/groups/event"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance, tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"
import { testProviderConfig } from "../lib/test-provider"
import { Server } from "../../src/server/server"
import { Flag } from "@vectordevai/core/flag/flag"
import { Global } from "@vectordevai/core/global"
import { SessionV2 } from "@vectordevai/core/session"
import { ProjectV2 } from "@vectordevai/core/project"
import type { SessionV1 } from "@vectordevai/core/v1/session"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { Project } from "@/project/project"
import { Provider } from "@/provider/provider"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { TaskManager } from "@/task/manager"
import type { Task } from "@vectordevai/schema/task"
import { DesktopTasks } from "@/task/desktop"
import { ToolRegistry } from "@/tool/registry"
import { Worktree } from "@/worktree"
import { FREE_MODEL_TRAINING_OWNER_ONLY } from "@vectordevai/core/free-model-choice"
import { ExperimentalApi } from "../../src/server/routes/instance/httpapi/groups/experimental"
import { experimentalHandlers } from "../../src/server/routes/instance/httpapi/handlers/experimental"
import { InstanceContextMiddleware } from "../../src/server/routes/instance/httpapi/middleware/instance-context"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import {
  WorkspaceRouteContext,
  WorkspaceRoutingMiddleware,
} from "../../src/server/routes/instance/httpapi/middleware/workspace-routing"

const credential = (username: string, password: string) => ({ username, password: Redacted.make(password) })

describe("ServerAuth guest credentials", () => {
  const config = {
    password: Option.some("owner-secret"),
    username: "alice",
    guestPassword: Option.some("guest-secret"),
    guestUsername: "guest",
  }

  test("identity reports which pair matched", () => {
    expect(ServerAuth.identity(credential("alice", "owner-secret"), config)).toBe("owner")
    expect(ServerAuth.identity(credential("guest", "guest-secret"), config)).toBe("guest")
    expect(ServerAuth.identity(credential("guest", "owner-secret"), config)).toBeUndefined()
    expect(ServerAuth.identity(credential("alice", "guest-secret"), config)).toBeUndefined()
    expect(ServerAuth.identity(credential("mallory", "guest-secret"), config)).toBeUndefined()
    expect(ServerAuth.authorized(credential("guest", "guest-secret"), config)).toBe(true)
  })

  test("owner-only configs never admit a guest", () => {
    const ownerOnly = { password: Option.some("owner-secret"), username: "alice" }
    expect(ServerAuth.authorized(credential("alice", "owner-secret"), ownerOnly)).toBe(true)
    expect(ServerAuth.authorized(credential("guest", "guest-secret"), ownerOnly)).toBe(false)
    expect(ServerAuth.authorized(credential("guest", ""), ownerOnly)).toBe(false)
    expect(ServerAuth.authorized(credential("guest", ""), { ...ownerOnly, guestPassword: Option.some("") })).toBe(false)
  })

  test("guest username defaults to guest and is configurable", () => {
    expect(ServerAuth.identity(credential("guest", "guest-secret"), { ...config, guestUsername: undefined })).toBe(
      "guest",
    )
    expect(
      ServerAuth.identity(credential("guest", "guest-secret"), { ...config, guestUsername: "pair" }),
    ).toBeUndefined()
    expect(ServerAuth.identity(credential("pair", "guest-secret"), { ...config, guestUsername: "pair" })).toBe("guest")
  })

  test("a guest password alone still enforces authentication, admitting guests only", () => {
    const guestOnly = { ...config, password: Option.none() }
    // Configuring any password must switch authentication on. Treating a
    // guest-only server as unauthenticated would serve the workspace to anyone.
    expect(ServerAuth.required(guestOnly)).toBe(true)
    expect(ServerAuth.identity(credential("guest", "guest-secret"), guestOnly)).toBe("guest")
    expect(ServerAuth.identity(credential("vector", "owner-secret"), guestOnly)).toBeUndefined()
    expect(ServerAuth.identity(credential("vector", ""), { ...guestOnly, password: Option.some("") })).toBeUndefined()
    expect(ServerAuth.required(config)).toBe(true)
    expect(ServerAuth.required({ ...config, password: Option.none(), guestPassword: Option.none() })).toBe(false)
    expect(ServerAuth.required({ ...config, password: Option.none(), guestPassword: Option.some("") })).toBe(false)
  })

  test("guest principals carry only configured workspace and session claims", () => {
    const principal = ServerAuth.principal("guest", {
      ...config,
      guestWorkspaceIDs: ["wrk_allowed"],
      guestWorkspaceDirectories: { wrk_allowed: process.cwd() },
      guestSessionIDs: ["ses_allowed"],
    })
    expect(allowsWorkspace(principal, "wrk_allowed")).toBe(true)
    expect(allowsWorkspace(principal, "wrk_other")).toBe(false)
    expect(principal.kind === "guest" && principal.workspaceDirectories.get("wrk_allowed")).toBe(process.cwd())
    expect(allowsSession(principal, "ses_allowed")).toBe(true)
    expect(allowsSession(principal, "ses_other")).toBe(false)
    expect(allowsWorkspace(ServerAuth.principal("owner", config), "wrk_other")).toBe(true)
  })
})

const Api = HttpApi.make("test-guest-authorization").add(
  HttpApiGroup.make("test")
    .add(
      HttpApiEndpoint.get("probe", "/probe", { success: Schema.String }),
      HttpApiEndpoint.get("principal", "/principal", { success: Schema.String }),
      HttpApiEndpoint.get("owner", "/api/pty", { success: Schema.String }),
    )
    .middleware(Authorization),
)

const handlers = HttpApiBuilder.group(Api, "test", (handlers) =>
  handlers
    .handle("probe", () => Effect.succeed("ok"))
    .handle("principal", () => RequestPrincipal.pipe(Effect.map((principal) => principal.username)))
    .handle("owner", () => Effect.succeed("owner")),
)

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(Api).pipe(Layer.provide(handlers), Layer.provide(authorizationLayer)),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(NodeHttpServer.layerTest))

const guestLayer = ServerAuth.Config.configLayer({
  password: Option.some("owner-secret"),
  username: "vector",
  guestPassword: Option.some("guest-secret"),
  guestUsername: "guest",
})
const ownerOnlyLayer = ServerAuth.Config.configLayer({ password: Option.some("owner-secret"), username: "vector" })

const itGuest = testEffect(apiLayer.pipe(Layer.provide(guestLayer)))
const itOwnerOnly = testEffect(apiLayer.pipe(Layer.provide(ownerOnlyLayer)))

const basic = (username: string, password: string) => ServerAuth.header({ username, password }) ?? ""
const token = (username: string, password: string) => Buffer.from(`${username}:${password}`).toString("base64")

async function* vectorEvents(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const boundary = buffer.match(/(?:\r\n|\r|\n){2}/)
      if (!boundary || boundary.index === undefined) {
        const value = await reader.read()
        if (value.done) return
        buffer += decoder.decode(value.value, { stream: true })
        continue
      }
      const record = buffer.slice(0, boundary.index)
      buffer = buffer.slice(boundary.index + boundary[0].length)
      const data = record
        .split(/\r\n|\r|\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
      if (data.length) yield JSON.parse(data.join("\n")) as Record<string, unknown>
    }
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
}
const getProbe = (headers?: Record<string, string>) =>
  HttpClientRequest.get("/probe").pipe(
    headers ? HttpClientRequest.setHeaders(headers) : (request) => request,
    HttpClient.execute,
  )

describe("HttpApi authorization middleware with a guest pair", () => {
  itGuest.live("accepts either credential pair and nothing else", () =>
    Effect.gen(function* () {
      const [owner, guest, missing, swapped, wrong] = yield* Effect.all(
        [
          getProbe({ authorization: basic("vector", "owner-secret") }),
          getProbe({ authorization: basic("guest", "guest-secret") }),
          getProbe(),
          getProbe({ authorization: basic("vector", "guest-secret") }),
          getProbe({ authorization: basic("guest", "owner-secret") }),
        ],
        { concurrency: "unbounded" },
      )

      expect(owner.status).toBe(200)
      expect(guest.status).toBe(200)
      expect(missing.status).toBe(401)
      expect(swapped.status).toBe(401)
      expect(wrong.status).toBe(401)
      expect(wrong.headers["www-authenticate"] ?? "").toContain("Basic")
    }),
  )

  itGuest.live("enforces the owner and guest endpoint matrix", () =>
    Effect.gen(function* () {
      const [owner, guest] = yield* Effect.all([
        HttpClientRequest.get("/api/pty").pipe(
          HttpClientRequest.setHeader("authorization", basic("vector", "owner-secret")),
          HttpClient.execute,
        ),
        HttpClientRequest.get("/api/pty").pipe(
          HttpClientRequest.setHeader("authorization", basic("guest", "guest-secret")),
          HttpClient.execute,
        ),
      ])
      expect(owner.status).toBe(200)
      expect(guest.status).toBe(403)
    }),
  )

  itGuest.live("rejects encoded owner-only routes before decoded routing", () =>
    Effect.gen(function* () {
      const [encoded, doubleEncoded] = yield* Effect.all(
        ["/api/%70ty", "/api/%2570ty"].map((route) =>
          HttpClientRequest.get(route).pipe(
            HttpClientRequest.setHeader("authorization", basic("guest", "guest-secret")),
            HttpClient.execute,
          ),
        ),
      )

      expect(encoded.status).toBe(403)
      expect(doubleEncoded.status).not.toBe(200)
    }),
  )

  // The router ignores case, repeated and trailing slashes, and anything after ';', and a leading '//' reads
  // as a host to the URL parser, so the gate has to judge the route the router matched, not a re-parsed path.
  itGuest.live("rejects owner-only routes under every spelling the router accepts", () =>
    Effect.gen(function* () {
      const spellings = ["//api/pty", "/API/PTY", "/Api/Pty", "/api/pty/", "/api/pty;x", "/api//pty", "///api/pty"]
      const responses = yield* Effect.all(
        spellings.map((route) =>
          HttpClientRequest.get(route).pipe(
            HttpClientRequest.setHeader("authorization", basic("guest", "guest-secret")),
            HttpClient.execute,
            Effect.map((response) => ({ route, status: response.status })),
          ),
        ),
      )
      expect(responses).toEqual(spellings.map((route) => ({ route, status: 403 })))
      const owner = yield* HttpClientRequest.get("/API/PTY").pipe(
        HttpClientRequest.setHeader("authorization", basic("vector", "owner-secret")),
        HttpClient.execute,
      )
      expect(owner.status).toBe(200)
    }),
  )

  itGuest.live("provides the authenticated request principal to handlers", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get("/principal").pipe(
        HttpClientRequest.setHeader("authorization", basic("guest", "guest-secret")),
        HttpClient.execute,
      )
      expect(response.status).toBe(200)
      expect(yield* response.json).toBe("guest")
    }),
  )

  itGuest.live("rejects the guest pair as a reusable query credential", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get(`/probe?auth_token=${encodeURIComponent(token("guest", "guest-secret"))}`)

      expect(response.status).toBe(401)
    }),
  )

  itOwnerOnly.live("rejects guest credentials when no guest password is configured", () =>
    Effect.gen(function* () {
      const [owner, guest] = yield* Effect.all(
        [
          getProbe({ authorization: basic("vector", "owner-secret") }),
          getProbe({ authorization: basic("guest", "guest-secret") }),
        ],
        { concurrency: "unbounded" },
      )

      expect(owner.status).toBe(200)
      expect(guest.status).toBe(401)
    }),
  )
})

test("guest session lists and replay routes stay within canonical claims", async () => {
  await using tmp = await tmpdir({ trusted: true, config: { formatter: false, lsp: false } })
  await using other = await tmpdir({ trusted: true, config: { formatter: false, lsp: false } })
  const previousWorkspaceID = Flag.VECTOR_WORKSPACE_ID
  const keys = [
    "VECTOR_SERVER_USERNAME",
    "VECTOR_SERVER_PASSWORD",
    "VECTOR_SERVER_GUEST_USERNAME",
    "VECTOR_SERVER_GUEST_PASSWORD",
    "VECTOR_SERVER_GUEST_WORKSPACES",
    "VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES",
    "VECTOR_SERVER_GUEST_SESSIONS",
    "VECTOR_DISABLE_DEFAULT_PLUGINS",
  ] as const
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  const claimedID = SessionV2.ID.create()
  Object.assign(process.env, {
    VECTOR_SERVER_USERNAME: "vector",
    VECTOR_SERVER_PASSWORD: "owner-secret",
    VECTOR_SERVER_GUEST_USERNAME: "guest",
    VECTOR_SERVER_GUEST_PASSWORD: "guest-secret",
    VECTOR_SERVER_GUEST_WORKSPACES: "wrk_allowed",
    VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES: JSON.stringify({ wrk_allowed: tmp.path }),
    VECTOR_SERVER_GUEST_SESSIONS: claimedID,
    VECTOR_DISABLE_DEFAULT_PLUGINS: "1",
  })
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  const owner = { authorization: basic("vector", "owner-secret"), "content-type": "application/json" }
  const guest = { authorization: basic("guest", "guest-secret") }
  const create = async (workspaceID: string, directory = tmp.path, id?: SessionV2.ID) => {
    const response = await fetch(new URL("/api/session", listener.url), {
      method: "POST",
      headers: owner,
      body: JSON.stringify({ id, location: { directory, workspaceID } }),
    })
    expect(response.status).toBe(200)
    return ((await response.json()) as { data: { id: string } }).data.id
  }
  let events: AsyncGenerator<Record<string, unknown>> | undefined
  try {
    const eventResponse = await fetch(new URL("/api/event", listener.url), { headers: guest })
    expect(eventResponse.status).toBe(200)
    events = vectorEvents(eventResponse.body!)
    expect((await events.next()).value).toMatchObject({ type: "server.connected" })

    const denied = await create("wrk_denied")
    const allowed = await create("wrk_allowed")
    const escaped = await create("wrk_allowed", other.path)
    const claimed = await create("wrk_allowed", other.path, claimedID)
    expect(claimed).toBe(claimedID)
    expect((await events.next()).value).toMatchObject({ location: { workspaceID: "wrk_allowed" } })
    const list = await fetch(new URL("/api/session", listener.url), { headers: guest })
    expect(list.status).toBe(200)
    const ids = ((await list.json()) as { data: Array<{ id: string }> }).data.map((item) => item.id)
    expect(ids).toContain(allowed)
    expect(ids).toContain(claimed)
    expect(ids).not.toContain(denied)
    expect(ids).not.toContain(escaped)

    expect((await fetch(new URL(`/api/session/${allowed}`, listener.url), { headers: guest })).status).toBe(200)
    expect((await fetch(new URL(`/api/session/${denied}`, listener.url), { headers: guest })).status).toBe(403)
    expect((await fetch(new URL(`/api/session/${escaped}`, listener.url), { headers: guest })).status).toBe(403)
    expect((await fetch(new URL(`/api/session/${allowed}/history`, listener.url), { headers: guest })).status).toBe(200)
    expect((await fetch(new URL(`/api/session/${denied}/history`, listener.url), { headers: guest })).status).toBe(403)

    expect((await fetch(new URL(`/api/session/${denied}/event`, listener.url), { headers: guest })).status).toBe(403)

    // Creating a session under an existing ID adopts it, which must not hand a guest a session it cannot read, and a
    // guest's sessions stay in the owner's lists, so a guest cannot mark one as a hidden helper.
    const guestCreate = (body: unknown) =>
      fetch(new URL("/api/session", listener.url), {
        method: "POST",
        headers: { ...guest, "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    const location = { directory: tmp.path, workspaceID: "wrk_allowed" }
    const adopted = await guestCreate({ id: denied, location })
    expect(adopted.status).toBe(403)
    expect(await adopted.text()).not.toContain("wrk_denied")
    expect((await guestCreate({ id: escaped, location })).status).toBe(403)
    expect((await guestCreate({ id: allowed, location })).status).toBe(200)
    // A guest's helper (Codespace edit and autocomplete, Browser Agent) belongs to a session the guest may open, whose
    // spend the owner sees. Without one, or under a session outside the guest's claims, it is refused.
    expect((await guestCreate({ location, internal: "vectorscope" })).status).toBe(403)
    expect((await guestCreate({ location, internal: "codespace.edit", parentID: denied })).status).toBe(403)
    expect((await guestCreate({ location, internal: "codespace.edit", parentID: escaped })).status).toBe(403)
    expect((await guestCreate({ location, parentID: escaped })).status).toBe(403)
    const helper = await guestCreate({ location, internal: "codespace.edit", parentID: allowed })
    expect(helper.status).toBe(200)
    const helperInfo = ((await helper.json()) as { data: { id: string; parentID?: string } }).data
    expect(helperInfo.parentID).toBe(allowed)
    expect((await guestCreate({ location, internal: "codespace.autocomplete", parentID: claimed })).status).toBe(200)
    const helperList = await fetch(new URL("/api/session", listener.url), { headers: guest })
    expect(((await helperList.json()) as { data: Array<{ id: string }> }).data.map((item) => item.id)).not.toContain(
      helperInfo.id,
    )

    await events.return(undefined)
    events = undefined
    Flag.VECTOR_WORKSPACE_ID = "wrk_allowed"

    const legacyCreate = (body: unknown) =>
      fetch(new URL("/session", listener.url), {
        method: "POST",
        headers: { ...guest, "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    expect((await legacyCreate({ internal: "vectorscope" })).status).toBe(403)
    expect((await legacyCreate({ internal: "codespace.edit", parentID: escaped })).status).toBe(403)
    expect((await legacyCreate({ parentID: denied })).status).toBe(403)
    const legacyHelper = await legacyCreate({ internal: "codespace.edit", parentID: allowed })
    expect(legacyHelper.status).toBe(200)
    expect(((await legacyHelper.json()) as { parentID?: string }).parentID).toBe(allowed)

    const legacyList = await fetch(new URL("/session", listener.url), { headers: guest })
    expect(legacyList.status).toBe(200)
    const legacyIDs = ((await legacyList.json()) as Array<{ id: string }>).map((item) => item.id)
    expect(legacyIDs).toContain(allowed)
    expect(legacyIDs).toContain(claimed)
    expect(legacyIDs).not.toContain(escaped)

    const selectedList = await fetch(new URL(`/session?directory=${encodeURIComponent(other.path)}`, listener.url), {
      headers: guest,
    })
    expect(selectedList.status).toBe(200)
    const selectedIDs = ((await selectedList.json()) as Array<{ id: string }>).map((item) => item.id)
    expect(selectedIDs).toContain(allowed)
    expect(selectedIDs).not.toContain(escaped)

    const status = await fetch(new URL("/session/status", listener.url), { headers: guest })
    expect(status.status).toBe(200)
    expect(await status.json()).not.toHaveProperty(escaped)

    const allowedRead = await fetch(
      new URL(`/session/${allowed}?directory=${encodeURIComponent(other.path)}`, listener.url),
      { headers: guest },
    )
    expect(allowedRead.status).toBe(200)
    expect(((await allowedRead.json()) as { directory: string }).directory).toBe(tmp.path)
    expect(
      (
        await fetch(new URL(`/session/${escaped}?directory=${encodeURIComponent(other.path)}`, listener.url), {
          headers: guest,
        })
      ).status,
    ).toBe(403)
    const claimedRead = await fetch(
      new URL(`/session/${claimed}?directory=${encodeURIComponent(tmp.path)}`, listener.url),
      { headers: guest },
    )
    expect(claimedRead.status).toBe(200)
    expect(((await claimedRead.json()) as { directory: string }).directory).toBe(other.path)

    // The router also matches these spellings; scope must follow the session it matched, not a re-parsed path.
    const origin = new URL(listener.url)
    const statusOf = (method: string, target: string) =>
      new Promise<number>((resolve, reject) => {
        const socket = connect(Number(origin.port), origin.hostname)
        let head = ""
        socket.on("data", (chunk) => {
          head += chunk.toString()
          if (!head.includes("\r\n")) return
          socket.destroy()
          resolve(Number(head.split(" ")[1]))
        })
        socket.on("error", reject)
        socket.write(
          [
            `${method} ${target} HTTP/1.1`,
            `Host: ${origin.host}`,
            `Authorization: ${guest.authorization}`,
            "Content-Type: application/json",
            "Content-Length: 2",
            "Connection: close",
            "",
            "{}",
          ].join("\r\n"),
        )
      })
    const scoped = `directory=${encodeURIComponent(tmp.path)}`
    const spellings = [
      ["GET", `/SESSION/${escaped}`],
      ["PATCH", `/SESSION/${escaped}`],
      ["GET", `//session/${escaped}`],
      ["PATCH", `/session//${escaped}`],
      ["GET", `/Session/${escaped}/message`],
      ["GET", `/session/${escaped};/../${allowed}`],
      ["PATCH", `/session/${escaped};/../${allowed}`],
    ]
    const spelled = await Promise.all(
      spellings.map(async ([method, target]) => [method, target, await statusOf(method, `${target}?${scoped}`)]),
    )
    expect(spelled).toEqual(spellings.map(([method, target]) => [method, target, 403]))
    expect(await statusOf("GET", `/SESSION/${allowed}?${scoped}`)).toBe(200)

    const deniedMutation = await fetch(new URL(`/session/${escaped}`, listener.url), {
      method: "PATCH",
      headers: { ...guest, "content-type": "application/json" },
      body: JSON.stringify({ title: "guest-must-not-write" }),
    })
    expect(deniedMutation.status).toBe(403)
    const allowedMutation = await fetch(new URL(`/session/${allowed}`, listener.url), {
      method: "PATCH",
      headers: { ...guest, "content-type": "application/json" },
      body: JSON.stringify({ title: "guest-can-write" }),
    })
    expect(allowedMutation.status).toBe(200)
    const ownerRead = await fetch(new URL(`/session/${escaped}`, listener.url), { headers: owner })
    expect(ownerRead.status).toBe(200)
    expect(((await ownerRead.json()) as { title: string }).title).not.toBe("guest-must-not-write")

    const claimedMutation = await fetch(new URL(`/session/${claimed}`, listener.url), {
      method: "PATCH",
      headers: { ...guest, "content-type": "application/json" },
      body: JSON.stringify({ title: "explicit-session-claim" }),
    })
    expect(claimedMutation.status).toBe(200)
    expect((await claimedMutation.json()) as { directory: string; title: string }).toMatchObject({
      directory: other.path,
      title: "explicit-session-claim",
    })
  } finally {
    Flag.VECTOR_WORKSPACE_ID = previousWorkspaceID
    await events?.return(undefined)
    await listener.stop(true)
    for (const key of keys) {
      const value = previous[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}, 30_000)

test("guests cannot hide sessions from the owner or charge work to sessions they cannot open", async () => {
  await using tmp = await tmpdir({ trusted: true, config: { formatter: false, lsp: false, share: "disabled" } })
  const previousWorkspaceID = Flag.VECTOR_WORKSPACE_ID
  const keys = [
    "VECTOR_SERVER_USERNAME",
    "VECTOR_SERVER_PASSWORD",
    "VECTOR_SERVER_GUEST_USERNAME",
    "VECTOR_SERVER_GUEST_PASSWORD",
    "VECTOR_SERVER_GUEST_WORKSPACES",
    "VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES",
    "VECTOR_DISABLE_DEFAULT_PLUGINS",
  ] as const
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  Object.assign(process.env, {
    VECTOR_SERVER_USERNAME: "vector",
    VECTOR_SERVER_PASSWORD: "owner-secret",
    VECTOR_SERVER_GUEST_USERNAME: "guest",
    VECTOR_SERVER_GUEST_PASSWORD: "guest-secret",
    VECTOR_SERVER_GUEST_WORKSPACES: "wrk_allowed",
    VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES: JSON.stringify({ wrk_allowed: tmp.path }),
    VECTOR_DISABLE_DEFAULT_PLUGINS: "1",
  })
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  const owner = { authorization: basic("vector", "owner-secret"), "content-type": "application/json" }
  const guest = { authorization: basic("guest", "guest-secret"), "content-type": "application/json" }
  // Server.listen prefers port 4096, so a pooled keep-alive socket from an earlier test's server could swallow a request.
  const post = (route: string, headers: Record<string, string>, body: Record<string, unknown>) =>
    fetch(new URL(`${route}?directory=${encodeURIComponent(tmp.path)}`, listener.url), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      keepalive: false,
    })
  const created = async (response: Response) => {
    expect(response.status).toBe(200)
    const body = (await response.json()) as { id?: string; data?: { id: string } }
    return body.data?.id ?? body.id!
  }
  try {
    const allowedParent = await created(
      await post("/api/session", owner, { location: { directory: tmp.path, workspaceID: "wrk_allowed" } }),
    )
    const ownerParent = await created(
      await post("/api/session", owner, { location: { directory: tmp.path, workspaceID: "wrk_denied" } }),
    )
    Flag.VECTOR_WORKSPACE_ID = "wrk_allowed"
    const location = { directory: tmp.path, workspaceID: "wrk_allowed" }

    // A helper session is out of every list, so a guest may not start one under any name.
    for (const internal of ["codespace.autocomplete", "vectorscope.review", "anything"]) {
      expect((await post("/session", guest, { internal })).status).toBe(403)
      expect((await post("/api/session", guest, { location, internal })).status).toBe(403)
    }
    // Its spend would count towards the parent, so the parent must be a session the guest can open.
    expect((await post("/session", guest, { parentID: ownerParent })).status).toBe(403)
    expect((await post("/api/session", guest, { location, parentID: ownerParent })).status).toBe(403)
    expect((await post("/api/session", guest, { location, parentID: SessionV2.ID.create() })).status).toBe(403)
    const guestChild = await created(await post("/session", guest, { parentID: allowedParent }))
    const guestV2Child = await created(await post("/api/session", guest, { location, parentID: allowedParent }))

    // The owner's own helpers still start, but only under the names of Vector's helpers.
    const invalid = await post("/session", owner, { internal: "true" })
    expect(invalid.status).toBe(400)
    expect(await invalid.text()).toContain("internal must name one of Vector's helpers")
    expect((await post("/api/session", owner, { internal: "true" })).status).toBe(400)
    expect((await post("/api/session", owner, { internal: "Vectorscope review" })).status).toBe(400)
    const helper = await created(
      await post("/session", owner, { internal: "codespace.autocomplete", parentID: ownerParent }),
    )
    const v2Helper = await created(await post("/api/session", owner, { internal: "vectorscope.verify" }))

    const listed = await fetch(new URL(`/session?directory=${encodeURIComponent(tmp.path)}`, listener.url), {
      headers: owner,
      keepalive: false,
    })
    const ids = ((await listed.json()) as Array<{ id: string }>).map((item) => item.id)
    expect(ids).toEqual(expect.arrayContaining([allowedParent, ownerParent, guestChild, guestV2Child]))
    expect(ids).not.toContain(helper)
    expect(ids).not.toContain(v2Helper)
  } finally {
    Flag.VECTOR_WORKSPACE_ID = previousWorkspaceID
    await listener.stop(true)
    for (const key of keys) {
      const value = previous[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}, 30_000)

test("guests cannot run host commands or answer permission requests", async () => {
  await using outside = await tmpdir()
  const secret = path.join(outside.path, "host-secret.bin")
  await fs.writeFile(secret, "HOST-ONLY-SECRET-VALUE")
  // A skill's @file reference is not the owner's own attachment, so running it from the owner's session parks
  // that session on an external_directory request.
  await using tmp = await tmpdir({
    trusted: true,
    config: {
      formatter: false,
      lsp: false,
      // A model that resolves without a network call; the command never gets as far as asking it anything.
      provider: {
        lmstudio: {
          name: "Test",
          npm: "@ai-sdk/openai-compatible",
          models: {
            "test-model": {
              id: "test-model",
              name: "Test Model",
              tool_call: true,
              limit: { context: 1000, output: 100 },
            },
          },
          options: { apiKey: "test-key", baseURL: "http://localhost:1/v1" },
        },
      },
    },
    init: (dir) =>
      Bun.write(
        path.join(dir, ".vector", "skills", "probe", "SKILL.md"),
        `---\nname: probe\ndescription: Reads a file outside the project\n---\nRead @${secret}\n`,
      ),
  })
  const previousWorkspaceID = Flag.VECTOR_WORKSPACE_ID
  const keys = [
    "VECTOR_SERVER_USERNAME",
    "VECTOR_SERVER_PASSWORD",
    "VECTOR_SERVER_GUEST_USERNAME",
    "VECTOR_SERVER_GUEST_PASSWORD",
    "VECTOR_SERVER_GUEST_WORKSPACES",
    "VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES",
    "VECTOR_DISABLE_DEFAULT_PLUGINS",
  ] as const
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  Object.assign(process.env, {
    VECTOR_SERVER_USERNAME: "vector",
    VECTOR_SERVER_PASSWORD: "owner-secret",
    VECTOR_SERVER_GUEST_USERNAME: "guest",
    VECTOR_SERVER_GUEST_PASSWORD: "guest-secret",
    VECTOR_SERVER_GUEST_WORKSPACES: "wrk_allowed",
    VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES: JSON.stringify({ wrk_allowed: tmp.path }),
    VECTOR_DISABLE_DEFAULT_PLUGINS: "1",
  })
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  const owner = { authorization: basic("vector", "owner-secret"), "content-type": "application/json" }
  const guest = { authorization: basic("guest", "guest-secret"), "content-type": "application/json" }
  // Server.listen prefers port 4096, so this listener reuses the earlier test's port. A pooled keep-alive
  // socket left from that server would swallow the first request.
  const call = (url: URL, init: RequestInit = {}) => fetch(url, { ...init, keepalive: false })
  const at = (route: string) => new URL(`${route}?directory=${encodeURIComponent(tmp.path)}`, listener.url)
  const model = { providerID: "probe", modelID: "probe" }
  // A binary file part outside the workspace parks its session on an external_directory request.
  const askOutside = (sessionID: string, headers: Record<string, string>) =>
    call(at(`/session/${sessionID}/prompt_async`), {
      method: "POST",
      headers,
      body: JSON.stringify({
        noReply: true,
        model,
        parts: [{ type: "file", mime: "application/octet-stream", filename: "x.bin", url: `file://${secret}` }],
      }),
    })
  const pending = async (headers: Record<string, string>) =>
    (await (await call(at("/permission"), { headers })).json()) as Array<{ id: string; sessionID: string }>
  try {
    // The owner's own session in the same directory, outside the guest's workspace claim.
    const ownerSession = (await (
      await call(at("/session"), { method: "POST", headers: owner, body: "{}" })
    ).json()) as {
      id: string
    }
    Flag.VECTOR_WORKSPACE_ID = "wrk_allowed"
    const created = await call(at("/session"), { method: "POST", headers: guest, body: "{}" })
    expect(created.status).toBe(200)
    const guestSession = (await created.json()) as { id: string }

    const shell = await call(at(`/session/${guestSession.id}/shell`), {
      method: "POST",
      headers: guest,
      body: JSON.stringify({ agent: "build", model, command: `cat ${secret}; id -un` }),
    })
    expect(shell.status).toBe(403)
    expect(await shell.text()).not.toContain("HOST-ONLY-SECRET-VALUE")
    const command = await call(at(`/session/${guestSession.id}/command`), {
      method: "POST",
      headers: guest,
      body: JSON.stringify({ command: "init", arguments: "" }),
    })
    expect(command.status).toBe(403)

    // The owner's own attachment is theirs to share from anywhere: it asks nothing.
    expect((await askOutside(ownerSession.id, owner)).status).toBe(204)
    const ownerCommand = call(at(`/session/${ownerSession.id}/command`), {
      method: "POST",
      headers: owner,
      body: JSON.stringify({ command: "probe", arguments: "", model: "lmstudio/test-model" }),
    }).catch(() => undefined)
    expect((await askOutside(guestSession.id, guest)).status).toBe(204)
    const deadline = Date.now() + 15_000
    while ((await pending(owner)).length < 2 && Date.now() < deadline) await Bun.sleep(50)
    const all = await pending(owner)
    expect(all.map((item) => item.sessionID).sort()).toEqual([ownerSession.id, guestSession.id].sort())

    // A guest sees what its own session waits on, never the owner's requests.
    expect((await pending(guest)).map((item) => item.sessionID)).toEqual([guestSession.id])
    expect((await call(new URL("/api/permission/request", listener.url), { headers: guest })).status).toBe(403)

    // Approving crosses the workspace boundary, so it stays with the owner even for the guest's session.
    for (const item of all) {
      const reply = await call(at(`/permission/${item.id}/reply`), {
        method: "POST",
        headers: guest,
        body: JSON.stringify({ reply: "always" }),
      })
      expect(reply.status).toBe(403)
      const legacy = await call(at(`/session/${item.sessionID}/permissions/${item.id}`), {
        method: "POST",
        headers: guest,
        body: JSON.stringify({ response: "always" }),
      })
      expect(legacy.status).toBe(403)
    }
    expect((await pending(owner)).length).toBe(2)
    for (const item of all) {
      const reply = await call(at(`/permission/${item.id}/reply`), {
        method: "POST",
        headers: owner,
        body: JSON.stringify({ reply: "reject" }),
      })
      expect(reply.status).toBe(200)
    }

    const messages = await (await call(at(`/session/${guestSession.id}/message`), { headers: guest })).text()
    expect(messages).not.toContain(Buffer.from("HOST-ONLY-SECRET-VALUE").toString("base64"))
    void ownerCommand
  } finally {
    Flag.VECTOR_WORKSPACE_ID = previousWorkspaceID
    await listener.stop(true)
    for (const key of keys) {
      const value = previous[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}, 30_000)

test("guests cannot allow tools in their own sessions", async () => {
  await using outside = await tmpdir()
  const secret = path.join(outside.path, "host-secret.bin")
  await fs.writeFile(secret, "HOST-ONLY-SECRET-VALUE")
  await using tmp = await tmpdir({ trusted: true, config: { formatter: false, lsp: false } })
  const previousWorkspaceID = Flag.VECTOR_WORKSPACE_ID
  const keys = [
    "VECTOR_SERVER_USERNAME",
    "VECTOR_SERVER_PASSWORD",
    "VECTOR_SERVER_GUEST_USERNAME",
    "VECTOR_SERVER_GUEST_PASSWORD",
    "VECTOR_SERVER_GUEST_WORKSPACES",
    "VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES",
    "VECTOR_DISABLE_DEFAULT_PLUGINS",
  ] as const
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  Object.assign(process.env, {
    VECTOR_SERVER_USERNAME: "vector",
    VECTOR_SERVER_PASSWORD: "owner-secret",
    VECTOR_SERVER_GUEST_USERNAME: "guest",
    VECTOR_SERVER_GUEST_PASSWORD: "guest-secret",
    VECTOR_SERVER_GUEST_WORKSPACES: "wrk_allowed",
    VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES: JSON.stringify({ wrk_allowed: tmp.path }),
    VECTOR_DISABLE_DEFAULT_PLUGINS: "1",
  })
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  const owner = { authorization: basic("vector", "owner-secret"), "content-type": "application/json" }
  const guest = { authorization: basic("guest", "guest-secret"), "content-type": "application/json" }
  const call = (url: URL, init: RequestInit = {}) => fetch(url, { ...init, keepalive: false })
  const at = (route: string) => new URL(`${route}?directory=${encodeURIComponent(tmp.path)}`, listener.url)
  const send = (route: string, method: string, headers: Record<string, string>, body: unknown) =>
    call(at(route), { method, headers, body: JSON.stringify(body) })
  const model = { providerID: "probe", modelID: "probe" }
  // An allow would skip the external_directory approval that this attachment otherwise waits on.
  const allow = [{ permission: "*", pattern: "*", action: "allow" }]
  const ask = [{ permission: "external_directory", pattern: "*", action: "ask" }]
  const deny = [{ permission: "bash", pattern: "*", action: "deny" }]
  const file = { type: "file", mime: "application/octet-stream", filename: "x.bin", url: `file://${secret}` }
  try {
    Flag.VECTOR_WORKSPACE_ID = "wrk_allowed"
    for (const permission of [allow, ask])
      expect((await send("/session", "POST", guest, { permission })).status).toBe(403)
    const created = await send("/session", "POST", guest, { permission: deny })
    expect(created.status).toBe(200)
    const session = (await created.json()) as { id: string }

    for (const permission of [allow, ask])
      expect((await send(`/session/${session.id}`, "PATCH", guest, { permission })).status).toBe(403)
    for (const route of ["prompt_async", "message"])
      expect(
        (
          await send(`/session/${session.id}/${route}`, "POST", guest, {
            noReply: true,
            model,
            tools: { "*": true },
            parts: [{ type: "text", text: "hi" }],
          })
        ).status,
      ).toBe(403)
    // The init command can be the owner's own template, so it is as powerful as a slash command.
    expect(
      (await send(`/session/${session.id}/init`, "POST", guest, { ...model, messageID: "msg_probe" })).status,
    ).toBe(403)

    // Taking tools away is still the guest's call, and the outside file still waits for the owner.
    expect(
      (
        await send(`/session/${session.id}/prompt_async`, "POST", guest, {
          noReply: true,
          model,
          tools: { bash: false },
          parts: [file],
        })
      ).status,
    ).toBe(204)
    const deadline = Date.now() + 15_000
    const pending = async () =>
      ((await (await call(at("/permission"), { headers: owner })).json()) as Array<{ sessionID: string }>).filter(
        (item) => item.sessionID === session.id,
      )
    while ((await pending()).length === 0 && Date.now() < deadline) await Bun.sleep(50)
    expect(await pending()).toHaveLength(1)
    const messages = await (await call(at(`/session/${session.id}/message`), { headers: guest })).text()
    expect(messages).not.toContain(Buffer.from("HOST-ONLY-SECRET-VALUE").toString("base64"))

    // The owner still sets any rules.
    expect((await send(`/session/${session.id}`, "PATCH", owner, { permission: allow })).status).toBe(200)
    expect((await send("/session", "POST", owner, { permission: allow })).status).toBe(200)
  } finally {
    Flag.VECTOR_WORKSPACE_ID = previousWorkspaceID
    await listener.stop(true)
    for (const key of keys) {
      const value = previous[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}, 30_000)

test("a guest's prompt budget can only tighten the owner's run limits", async () => {
  // The provider never answers, so each run begins under its budget and then ends on a connection error.
  await using tmp = await tmpdir({ trusted: true, config: testProviderConfig("http://127.0.0.1:9/v1") })
  const previousWorkspaceID = Flag.VECTOR_WORKSPACE_ID
  const keys = [
    "VECTOR_SERVER_USERNAME",
    "VECTOR_SERVER_PASSWORD",
    "VECTOR_SERVER_GUEST_USERNAME",
    "VECTOR_SERVER_GUEST_PASSWORD",
    "VECTOR_SERVER_GUEST_WORKSPACES",
    "VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES",
    "VECTOR_DISABLE_DEFAULT_PLUGINS",
    "VECTOR_CONFIG_CONTENT",
  ] as const
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  Object.assign(process.env, {
    // The owner's run limits, from their own config: a repository's budget.run is ignored.
    VECTOR_CONFIG_CONTENT: JSON.stringify({ budget: { run: { usd: 2, steps: 50 } } }),
    VECTOR_SERVER_USERNAME: "vector",
    VECTOR_SERVER_PASSWORD: "owner-secret",
    VECTOR_SERVER_GUEST_USERNAME: "guest",
    VECTOR_SERVER_GUEST_PASSWORD: "guest-secret",
    VECTOR_SERVER_GUEST_WORKSPACES: "wrk_allowed",
    VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES: JSON.stringify({ wrk_allowed: tmp.path }),
    VECTOR_DISABLE_DEFAULT_PLUGINS: "1",
  })
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  const owner = { authorization: basic("vector", "owner-secret"), "content-type": "application/json" }
  const guest = { authorization: basic("guest", "guest-secret"), "content-type": "application/json" }
  const call = (url: URL, init: RequestInit = {}) => fetch(url, { ...init, keepalive: false })
  const at = (route: string) => new URL(`${route}?directory=${encodeURIComponent(tmp.path)}`, listener.url)
  const send = (route: string, headers: Record<string, string>, body: unknown) =>
    call(at(route), { method: "POST", headers, body: JSON.stringify(body) })
  const prompt = (sessionID: string, headers: Record<string, string>, budget?: object) =>
    send(`/session/${sessionID}/prompt_async`, headers, {
      model: { providerID: "lmstudio", modelID: "test-model" },
      parts: [{ type: "text", text: "hello" }],
      ...(budget ? { budget } : {}),
    })
  // The run's budget, read by the owner once the run has begun.
  const budgetOf = async (sessionID: string) => {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const spend = (await (await call(at(`/api/session/${sessionID}/spend`), { headers: owner })).json()) as {
        data?: { budget: object }
      }
      if (spend.data) return spend.data.budget
      await Bun.sleep(50)
    }
    return undefined
  }
  const session = async (headers: Record<string, string>) =>
    ((await (await send("/session", headers, {})).json()) as { id: string }).id
  try {
    Flag.VECTOR_WORKSPACE_ID = "wrk_allowed"
    // A looser budget leaves the configured limits in place; a stricter limit still applies.
    const raised = await session(guest)
    expect((await prompt(raised, guest, { usd: 1_000, steps: 1_000, warnAt: 1 })).status).toBe(204)
    expect(await budgetOf(raised)).toEqual({ usd: 2, steps: 50, warnAt: 0.8 })
    const lowered = await session(guest)
    expect((await prompt(lowered, guest, { usd: 1, steps: 1_000 })).status).toBe(204)
    expect(await budgetOf(lowered)).toEqual({ usd: 1, steps: 50 })

    // An empty budget armed through the v2 route lifts nothing either.
    const emptied = await session(guest)
    const admitted = await send(`/api/session/${emptied}/prompt`, guest, {
      prompt: { text: "hello" },
      budget: {},
      resume: false,
    })
    expect(admitted.status).toBe(200)
    expect((await prompt(emptied, guest)).status).toBe(204)
    expect(await budgetOf(emptied)).toEqual({ usd: 2, steps: 50 })

    // The owner's own budget still replaces the configured one.
    const own = await session(owner)
    expect((await prompt(own, owner, { usd: 1_000 })).status).toBe(204)
    expect(await budgetOf(own)).toEqual({ usd: 1_000 })
  } finally {
    Flag.VECTOR_WORKSPACE_ID = previousWorkspaceID
    await listener.stop(true)
    for (const key of keys) {
      const value = previous[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}, 60_000)

test("a guest's prompt cannot choose where the owner's research searches", async () => {
  await using tmp = await tmpdir({ trusted: true, config: testProviderConfig("http://127.0.0.1:9/v1") })
  const previousWorkspaceID = Flag.VECTOR_WORKSPACE_ID
  const keys = [
    "VECTOR_SERVER_USERNAME",
    "VECTOR_SERVER_PASSWORD",
    "VECTOR_SERVER_GUEST_USERNAME",
    "VECTOR_SERVER_GUEST_PASSWORD",
    "VECTOR_SERVER_GUEST_WORKSPACES",
    "VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES",
    "VECTOR_DISABLE_DEFAULT_PLUGINS",
  ] as const
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  Object.assign(process.env, {
    VECTOR_SERVER_USERNAME: "vector",
    VECTOR_SERVER_PASSWORD: "owner-secret",
    VECTOR_SERVER_GUEST_USERNAME: "guest",
    VECTOR_SERVER_GUEST_PASSWORD: "guest-secret",
    VECTOR_SERVER_GUEST_WORKSPACES: "wrk_allowed",
    VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES: JSON.stringify({ wrk_allowed: tmp.path }),
    VECTOR_DISABLE_DEFAULT_PLUGINS: "1",
  })
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  const owner = { authorization: basic("vector", "owner-secret"), "content-type": "application/json" }
  const guest = { authorization: basic("guest", "guest-secret"), "content-type": "application/json" }
  const call = (url: URL, init: RequestInit = {}) => fetch(url, { ...init, keepalive: false })
  const at = (route: string) => new URL(`${route}?directory=${encodeURIComponent(tmp.path)}`, listener.url)
  // What `vector run --research --search none` sends: its choices in a text part's metadata.
  const prompt = (sessionID: string, headers: Record<string, string>) =>
    call(at(`/session/${sessionID}/prompt_async`), {
      method: "POST",
      headers,
      body: JSON.stringify({
        noReply: true,
        model: { providerID: "lmstudio", modelID: "test-model" },
        parts: [
          { type: "text", text: "Research heat pumps" },
          {
            type: "text",
            text: "Research settings",
            synthetic: true,
            metadata: { "vector.research": { search: "none" } },
          },
        ],
      }),
    })
  // The prompt's saved parts, read by the owner once it is saved.
  const saved = async (sessionID: string) => {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const messages = (await (await call(at(`/session/${sessionID}/message`), { headers: owner })).json()) as {
        parts: { text?: string; metadata?: Record<string, unknown> }[]
      }[]
      const parts = messages.flatMap((message) => message.parts)
      const settings = parts.find((part) => part.text === "Research settings")
      if (settings) return settings
      await Bun.sleep(50)
    }
    return undefined
  }
  const session = async () =>
    (
      (await (await call(at("/session"), { method: "POST", headers: owner, body: JSON.stringify({}) })).json()) as {
        id: string
      }
    ).id
  try {
    Flag.VECTOR_WORKSPACE_ID = "wrk_allowed"
    const guested = await session()
    expect((await prompt(guested, guest)).status).toBe(204)
    expect((await saved(guested))?.metadata?.["vector.research"]).toBeUndefined()
    // The owner's own choice stands.
    const owned = await session()
    expect((await prompt(owned, owner)).status).toBe(204)
    expect((await saved(owned))?.metadata?.["vector.research"]).toEqual({ search: "none" })
  } finally {
    Flag.VECTOR_WORKSPACE_ID = previousWorkspaceID
    await listener.stop(true)
    for (const key of keys) {
      const value = previous[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}, 30_000)

test("guests cannot reach owner-only routes by spelling the path another way", async () => {
  await using tmp = await tmpdir({ trusted: true, config: { formatter: false, lsp: false } })
  const previousWorkspaceID = Flag.VECTOR_WORKSPACE_ID
  const keys = [
    "VECTOR_SERVER_USERNAME",
    "VECTOR_SERVER_PASSWORD",
    "VECTOR_SERVER_GUEST_USERNAME",
    "VECTOR_SERVER_GUEST_PASSWORD",
    "VECTOR_SERVER_GUEST_WORKSPACES",
    "VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES",
    "VECTOR_DISABLE_DEFAULT_PLUGINS",
  ] as const
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  Object.assign(process.env, {
    VECTOR_SERVER_USERNAME: "vector",
    VECTOR_SERVER_PASSWORD: "owner-secret",
    VECTOR_SERVER_GUEST_USERNAME: "guest",
    VECTOR_SERVER_GUEST_PASSWORD: "guest-secret",
    VECTOR_SERVER_GUEST_WORKSPACES: "wrk_allowed",
    VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES: JSON.stringify({ wrk_allowed: tmp.path }),
    VECTOR_DISABLE_DEFAULT_PLUGINS: "1",
  })
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  const origin = new URL(listener.url)
  const guest = { authorization: basic("guest", "guest-secret"), "content-type": "application/json" }
  const directory = `directory=${encodeURIComponent(tmp.path)}`
  // A URL object would read a leading '//' as a host, so each path is sent exactly as written.
  const send = (method: string, route: string, body?: unknown) =>
    fetch(`${origin.origin}${route}?${directory}`, {
      method,
      headers: guest,
      body: body === undefined ? undefined : JSON.stringify(body),
      keepalive: false,
    })
  // fetch resolves '..' before sending, so these go over a raw socket the way a client could send them.
  const sendRaw = (method: string, target: string, body: unknown) =>
    new Promise<number>((resolve, reject) => {
      const payload = JSON.stringify(body)
      const socket = connect(Number(origin.port), origin.hostname)
      let head = ""
      // Only the status line matters, so stop reading once it has arrived.
      socket.on("data", (chunk) => {
        head += chunk.toString()
        if (!head.includes("\r\n")) return
        socket.destroy()
        resolve(Number(head.split(" ")[1]))
      })
      socket.on("error", reject)
      // write, not end: a half-closed socket makes the server drop the connection before it answers.
      socket.write(
        [
          `${method} ${target}?${directory} HTTP/1.1`,
          `Host: ${origin.host}`,
          `Authorization: ${guest.authorization}`,
          "Content-Type: application/json",
          `Content-Length: ${Buffer.byteLength(payload)}`,
          "Connection: close",
          "",
          payload,
        ].join("\r\n"),
      )
    })
  try {
    Flag.VECTOR_WORKSPACE_ID = "wrk_allowed"
    const created = await send("POST", "/session", {})
    expect(created.status).toBe(200)
    const sessionID = ((await created.json()) as { id: string }).id
    const model = { providerID: "probe", modelID: "probe" }
    const routes = [
      { method: "POST", route: "/pty", body: { command: "/bin/echo", args: ["SPELLING-PROBE"] } },
      { method: "POST", route: "/api/pty", body: { command: "/bin/echo", args: ["SPELLING-PROBE"] } },
      { method: "POST", route: `/session/${sessionID}/shell`, body: { agent: "build", model, command: "echo PROBE" } },
      { method: "POST", route: `/session/${sessionID}/command`, body: { command: "init", arguments: "" } },
      { method: "POST", route: "/permission/per_probe/reply", body: { reply: "reject" } },
      { method: "PATCH", route: "/config", body: {} },
      { method: "PATCH", route: "/global/config", body: {} },
      { method: "PUT", route: "/auth/probe-provider", body: { type: "api", key: "placeholder-key" } },
      { method: "POST", route: "/experimental/worktree", body: { startCommand: "echo SPELLING-PROBE" } },
      { method: "DELETE", route: "/experimental/worktree", body: { directory: tmp.path } },
      { method: "POST", route: "/experimental/worktree/reset", body: { directory: tmp.path } },
    ]
    const spellings = (route: string) => [
      route,
      `/${route}`,
      route
        .split("/")
        .map((segment) => (/^[a-z]+$/.test(segment) ? segment.toUpperCase() : segment))
        .join("/"),
      `${route}/`,
      `${route};x`,
      route.replace(/\/(?=[^/]*$)/, "//"),
    ]
    const attempts = routes.flatMap((item) => spellings(item.route).map((route) => ({ ...item, route })))
    const results = await Promise.all(
      attempts.map(async (item) => ({
        method: item.method,
        route: item.route,
        status: (await send(item.method, item.route, item.body)).status,
      })),
    )
    expect(results).toEqual(attempts.map((item) => ({ method: item.method, route: item.route, status: 403 })))
    expect(await sendRaw("PUT", "/auth/..", { type: "api", key: "placeholder-key" })).toBe(403)
    expect(await sendRaw("PUT", "/pty/..", { title: "probe" })).toBe(403)
    // The guest's own routes still answer under the router's spellings.
    expect((await send("GET", `/Session/${sessionID}/Message/`)).status).toBe(200)
  } finally {
    Flag.VECTOR_WORKSPACE_ID = previousWorkspaceID
    await listener.stop(true)
    for (const key of keys) {
      const value = previous[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}, 30_000)

test("guests cannot plant or run the repository's git hooks", async () => {
  await using tmp = await tmpdir({ trusted: true, git: true, config: { formatter: false, lsp: false } })
  const previousWorkspaceID = Flag.VECTOR_WORKSPACE_ID
  const keys = [
    "VECTOR_SERVER_USERNAME",
    "VECTOR_SERVER_PASSWORD",
    "VECTOR_SERVER_GUEST_USERNAME",
    "VECTOR_SERVER_GUEST_PASSWORD",
    "VECTOR_SERVER_GUEST_WORKSPACES",
    "VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES",
    "VECTOR_DISABLE_DEFAULT_PLUGINS",
  ] as const
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  Object.assign(process.env, {
    VECTOR_SERVER_USERNAME: "vector",
    VECTOR_SERVER_PASSWORD: "owner-secret",
    VECTOR_SERVER_GUEST_USERNAME: "guest",
    VECTOR_SERVER_GUEST_PASSWORD: "guest-secret",
    VECTOR_SERVER_GUEST_WORKSPACES: "wrk_allowed",
    VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES: JSON.stringify({ wrk_allowed: tmp.path }),
    VECTOR_DISABLE_DEFAULT_PLUGINS: "1",
  })
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  const owner = { authorization: basic("vector", "owner-secret"), "content-type": "application/json" }
  const guest = { authorization: basic("guest", "guest-secret"), "content-type": "application/json" }
  const directory = `directory=${encodeURIComponent(tmp.path)}`
  const send = (headers: Record<string, string>, method: string, route: string, body: unknown) =>
    fetch(`${new URL(listener.url).origin}${route}?${directory}`, {
      method,
      headers,
      body: JSON.stringify(body),
      keepalive: false,
    })
  const marker = path.join(tmp.path, "hook-ran")
  const hook = `#!/bin/sh\ntouch "${marker}"\n`
  try {
    Flag.VECTOR_WORKSPACE_ID = "wrk_allowed"
    // A hook runs as the owner the next time anyone commits, so writing one is running a command.
    await fs.symlink(path.join(tmp.path, ".git", "hooks"), path.join(tmp.path, "hooks-link"))
    const plants = [
      ".git/hooks/pre-commit",
      ".GIT/hooks/pre-commit",
      "./.git/hooks/post-checkout",
      "src/../.git/config",
      "hooks-link/pre-commit",
      "nested/.git",
      // Windows and NTFS open these as .git, and HFS+ ignores the invisible character; on a missing target realpath
      // keeps the spelling, so each must be refused by name. A nested .git would plant a repository of the guest's.
      ".git./hooks/pre-commit",
      ".git /hooks/pre-commit",
      ".git. ./config",
      ".git::$INDEX_ALLOCATION/hooks/pre-commit",
      "GIT~1/hooks/pre-commit",
      "git~2/config",
      "nested/.git./config",
      ".g‌it/config",
    ]
    const planted = await Promise.all(
      plants.map(async (file) => ({
        file,
        status: (await send(guest, "POST", "/file/write", { path: file, content: hook })).status,
      })),
    )
    expect(planted).toEqual(plants.map((file) => ({ file, status: 400 })))
    expect(await fs.readdir(path.join(tmp.path, ".git", "hooks"))).not.toContain("pre-commit")
    expect(await Bun.file(path.join(tmp.path, ".git", "config")).text()).not.toContain("touch")
    expect((await send(guest, "POST", "/file/write", { path: "notes.txt", content: "guest notes" })).status).toBe(200)

    // A hook the repository already has, such as one a hook manager installed, runs on commit and branch switch.
    await fs.writeFile(path.join(tmp.path, ".git", "hooks", "pre-commit"), hook, { mode: 0o755 })
    await fs.writeFile(path.join(tmp.path, ".git", "hooks", "post-checkout"), hook, { mode: 0o755 })
    const spellings = (route: string) => [route, route.toUpperCase(), `${route}/`, `${route};x`, `/${route}`]
    const attempts = [
      ...spellings("/vcs/commit").map((route) => ({ route, body: { message: "guest commit" } })),
      ...spellings("/vcs/switch").map((route) => ({ route, body: { branch: "guest-branch", create: true } })),
    ]
    const results = await Promise.all(
      attempts.map(async (item) => ({
        route: item.route,
        status: (await send(guest, "POST", item.route, item.body)).status,
      })),
    )
    expect(results).toEqual(attempts.map((item) => ({ route: item.route, status: 403 })))
    expect(await Bun.file(marker).exists()).toBe(false)

    // The owner still writes, commits and switches as before, hooks included.
    expect((await send(owner, "POST", "/file/write", { path: "owner.txt", content: "owner" })).status).toBe(200)
    const committed = await send(owner, "POST", "/vcs/commit", { message: "owner commit" })
    expect(committed.status).toBe(200)
    expect(((await committed.json()) as { committed: boolean }).committed).toBe(true)
    expect(await Bun.file(marker).exists()).toBe(true)
  } finally {
    Flag.VECTOR_WORKSPACE_ID = previousWorkspaceID
    await listener.stop(true)
    for (const key of keys) {
      const value = previous[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}, 30_000)

test("guests load the app's bootstrap routes, narrowed to their workspace", async () => {
  await using tmp = await tmpdir({ trusted: true, git: true, config: { formatter: false, lsp: false } })
  await using other = await tmpdir({ trusted: true, git: true, config: { formatter: false, lsp: false } })
  const previousWorkspaceID = Flag.VECTOR_WORKSPACE_ID
  const keys = [
    "VECTOR_SERVER_USERNAME",
    "VECTOR_SERVER_PASSWORD",
    "VECTOR_SERVER_GUEST_USERNAME",
    "VECTOR_SERVER_GUEST_PASSWORD",
    "VECTOR_SERVER_GUEST_WORKSPACES",
    "VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES",
    "VECTOR_DISABLE_DEFAULT_PLUGINS",
  ] as const
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  Object.assign(process.env, {
    VECTOR_SERVER_USERNAME: "vector",
    VECTOR_SERVER_PASSWORD: "owner-secret",
    VECTOR_SERVER_GUEST_USERNAME: "guest",
    VECTOR_SERVER_GUEST_PASSWORD: "guest-secret",
    VECTOR_SERVER_GUEST_WORKSPACES: "wrk_allowed",
    VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES: JSON.stringify({ wrk_allowed: tmp.path }),
    VECTOR_DISABLE_DEFAULT_PLUGINS: "1",
  })
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  const owner = { authorization: basic("vector", "owner-secret"), "content-type": "application/json" }
  const guest = { authorization: basic("guest", "guest-secret"), "content-type": "application/json" }
  // Server.listen prefers port 4096, so a pooled keep-alive socket from an earlier test would swallow a request.
  const call = (route: string, init: RequestInit = {}) =>
    fetch(new URL(route, listener.url), { ...init, keepalive: false })
  const abort = new AbortController()
  try {
    Flag.VECTOR_WORKSPACE_ID = "wrk_allowed"
    // The owner's other project, which a guest must not learn about.
    const elsewhere = await call(`/session?directory=${encodeURIComponent(other.path)}`, {
      method: "POST",
      headers: owner,
      body: "{}",
    })
    expect(elsewhere.status).toBe(200)

    const stream = await call("/global/event", { headers: guest, signal: abort.signal })
    expect(stream.status).toBe(200)
    const events = vectorEvents(stream.body!)
    expect((await events.next()).value).toMatchObject({ payload: { type: "server.connected" } })

    expect((await call("/global/health", { headers: guest })).status).toBe(200)
    const config = await call("/global/config", { headers: guest })
    expect(config.status).toBe(200)
    expect((await call("/global/config", { method: "PATCH", headers: guest, body: "{}" })).status).toBe(403)
    expect((await call("/global/dispose", { method: "POST", headers: guest })).status).toBe(403)

    const current = await call("/project/current", { headers: guest })
    expect(current.status).toBe(200)
    const project = (await current.json()) as { id: string; worktree: string }
    expect(project.worktree).toBe(tmp.path)
    const list = await call("/project", { headers: guest })
    expect(list.status).toBe(200)
    expect(((await list.json()) as Array<{ worktree: string }>).map((item) => item.worktree)).toEqual([tmp.path])
    const ownerList = (await (await call("/project", { headers: owner })).json()) as Array<{ worktree: string }>
    expect(ownerList.map((item) => item.worktree)).toContain(other.path)
    expect((await call(`/project/${project.id}/directories`, { headers: guest })).status).toBe(403)
    // The experimental list spans every project for the owner, and only the guest's workspace for a guest.
    const sessions = async (headers: Record<string, string>) =>
      ((await (await call("/experimental/session", { headers })).json()) as Array<{ directory: string }>).map(
        (item) => item.directory,
      )
    expect(await sessions(owner)).toContain(other.path)
    expect(await sessions(guest)).not.toContain(other.path)
    // Usage is read for the guest's workspace only; the owner's spans every project.
    expect((await call("/experimental/session/usage", { headers: guest })).status).toBe(200)
    expect((await call("/experimental/session/usage", { headers: owner })).status).toBe(200)

    // The live stream carries the guest's workspace and nothing from the owner's other project.
    await call(`/session?directory=${encodeURIComponent(other.path)}`, { method: "POST", headers: owner, body: "{}" })
    const mine = (await (await call("/session", { method: "POST", headers: guest, body: "{}" })).json()) as {
      id: string
    }
    const ownerTasks = (await (
      await call(`/session?directory=${encodeURIComponent(tmp.path)}`, { method: "POST", headers: owner, body: "{}" })
    ).json()) as {
      id: string
    }
    const taskRoute = `/experimental/session/${ownerTasks.id}/tasks`
    // Seeing a shared workspace does not grant permission to steer or stop its owner's workers.
    expect((await call(taskRoute, { headers: guest })).status).toBe(200)
    // The board's limits line carries the owner's configured limits, which a guest never sees (I19).
    const limitsOf = async (headers: Record<string, string>) =>
      ((await (await call(taskRoute, { headers })).json()) as { limits?: { maxRunning: number } }).limits
    expect(await limitsOf(guest)).toBeUndefined()
    expect((await limitsOf(owner))?.maxRunning).toBe(8)
    // Nor does it show a helper's absolute worktree, which goes only to the owner or a principal in control (I19).
    const registered = await call(`${taskRoute}/bridge/register`, {
      method: "POST",
      headers: owner,
      body: JSON.stringify({
        tasks: [
          {
            id: "workspace:isolated",
            parentSessionID: ownerTasks.id,
            source: "team",
            title: "Isolated helper",
            status: "completed",
            startedAt: Date.now(),
            elapsedMs: 0,
            ownedPaths: [],
            dependsOn: [],
            resultAvailable: false,
            attempt: 1,
            controls: { inspect: true, message: false, stop: false },
            isolation: { mode: "worktree", state: "active", branch: "vector/isolated", directory: other.path },
          },
        ],
      }),
    })
    expect(registered.status).toBe(200)
    const isolation = async (headers: Record<string, string>) =>
      (
        (await (await call(taskRoute, { headers })).json()) as {
          tasks: Array<{ id: string; isolation?: Record<string, unknown> }>
        }
      ).tasks.find((task) => task.id === "workspace:isolated")?.isolation
    expect(await isolation(guest)).toEqual({ mode: "worktree", state: "active", branch: "vector/isolated" })
    expect((await isolation(owner))?.directory).toBe(other.path)
    expect(
      (
        await call(`${taskRoute}/wait`, {
          method: "POST",
          headers: guest,
          body: JSON.stringify({ taskIDs: ["unknown"], timeout: 0 }),
        })
      ).status,
    ).toBe(400)
    expect(
      (await call(`${taskRoute}/stop`, { method: "POST", headers: guest, body: JSON.stringify({ all: true }) })).status,
    ).toBe(403)
    expect(
      (
        await call(`${taskRoute}/unknown/message`, {
          method: "POST",
          headers: guest,
          body: JSON.stringify({ text: "Ignore your work" }),
        })
      ).status,
    ).toBe(403)
    expect(
      (await call(`${taskRoute}/stop`, { method: "POST", headers: owner, body: JSON.stringify({ all: true }) })).status,
    ).toBe(200)
    const seen: Array<{ directory?: string; payload: { type: string; properties?: { info?: { id?: string } } } }> = []
    while (true) {
      const next = await events.next()
      if (next.done) break
      const event = next.value as (typeof seen)[number]
      seen.push(event)
      if (event.payload.type === "session.created" && event.payload.properties?.info?.id === mine.id) break
    }
    expect(seen.every((event) => event.directory === undefined || event.directory === tmp.path)).toBe(true)
  } finally {
    abort.abort()
    Flag.VECTOR_WORKSPACE_ID = previousWorkspaceID
    await listener.stop(true)
    for (const key of keys) {
      const value = previous[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}, 30_000)

test("a guest stops or backgrounds a session's helpers only when it controls that session", async () => {
  // Seeing a shared workspace does not grant control of the owner's sessions; a session the guest was given does.
  await using tmp = await tmpdir({ trusted: true, git: true, config: { formatter: false, lsp: false } })
  const previousWorkspaceID = Flag.VECTOR_WORKSPACE_ID
  const keys = [
    "VECTOR_SERVER_USERNAME",
    "VECTOR_SERVER_PASSWORD",
    "VECTOR_SERVER_GUEST_USERNAME",
    "VECTOR_SERVER_GUEST_PASSWORD",
    "VECTOR_SERVER_GUEST_WORKSPACES",
    "VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES",
    "VECTOR_SERVER_GUEST_SESSIONS",
    "VECTOR_DISABLE_DEFAULT_PLUGINS",
  ] as const
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  const claimedID = SessionV2.ID.create()
  Object.assign(process.env, {
    VECTOR_SERVER_USERNAME: "vector",
    VECTOR_SERVER_PASSWORD: "owner-secret",
    VECTOR_SERVER_GUEST_USERNAME: "guest",
    VECTOR_SERVER_GUEST_PASSWORD: "guest-secret",
    VECTOR_SERVER_GUEST_WORKSPACES: "wrk_allowed",
    VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES: JSON.stringify({ wrk_allowed: tmp.path }),
    VECTOR_SERVER_GUEST_SESSIONS: claimedID,
    VECTOR_DISABLE_DEFAULT_PLUGINS: "1",
  })
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  const owner = { authorization: basic("vector", "owner-secret"), "content-type": "application/json" }
  const guest = { authorization: basic("guest", "guest-secret"), "content-type": "application/json" }
  const call = (route: string, init: RequestInit = {}) =>
    fetch(new URL(route, listener.url), { ...init, keepalive: false })
  try {
    Flag.VECTOR_WORKSPACE_ID = "wrk_allowed"
    const ownerSession = (await (
      await call(`/session?directory=${encodeURIComponent(tmp.path)}`, { method: "POST", headers: owner, body: "{}" })
    ).json()) as { id: string }
    const claimed = await call("/api/session", {
      method: "POST",
      headers: owner,
      body: JSON.stringify({ id: claimedID, location: { directory: tmp.path, workspaceID: "wrk_allowed" } }),
    })
    expect(claimed.status).toBe(200)
    const stop = (id: string, headers: Record<string, string>) =>
      call(`/experimental/session/${id}/stop`, { method: "POST", headers, body: JSON.stringify({ helpers: true }) })
    const background = (id: string, headers: Record<string, string>) =>
      call(`/experimental/session/${id}/background`, { method: "POST", headers })

    expect((await stop(ownerSession.id, guest)).status).toBe(403)
    expect((await background(ownerSession.id, guest)).status).toBe(403)
    const mine = await stop(claimedID, guest)
    expect(mine.status).toBe(200)
    expect(await mine.json()).toEqual({ aborted: false, tasks: [], shells: 0, excluded: 0, skipped: 0 })
    expect((await background(claimedID, guest)).status).toBe(200)
    expect((await stop(ownerSession.id, owner)).status).toBe(200)
  } finally {
    Flag.VECTOR_WORKSPACE_ID = previousWorkspaceID
    await listener.stop(true)
    for (const key of keys) {
      const value = previous[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}, 30_000)

// Routes 4–6 (WP28): a guest with view scope may ask for an isolated task's counts, never merge or discard, even in
// a session it controls; a guest outside the session's scope cannot ask at all.
test("a guest may review isolated task counts in its own session, and only the owner merges or discards", async () => {
  await using tmp = await tmpdir({ trusted: true, git: true, config: { formatter: false, lsp: false } })
  await using elsewhere = await tmpdir({ trusted: true, git: true, config: { formatter: false, lsp: false } })
  const previousWorkspaceID = Flag.VECTOR_WORKSPACE_ID
  const keys = [
    "VECTOR_SERVER_USERNAME",
    "VECTOR_SERVER_PASSWORD",
    "VECTOR_SERVER_GUEST_USERNAME",
    "VECTOR_SERVER_GUEST_PASSWORD",
    "VECTOR_SERVER_GUEST_WORKSPACES",
    "VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES",
    "VECTOR_SERVER_GUEST_SESSIONS",
    "VECTOR_DISABLE_DEFAULT_PLUGINS",
  ] as const
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  const claimedID = SessionV2.ID.create()
  Object.assign(process.env, {
    VECTOR_SERVER_USERNAME: "vector",
    VECTOR_SERVER_PASSWORD: "owner-secret",
    VECTOR_SERVER_GUEST_USERNAME: "guest",
    VECTOR_SERVER_GUEST_PASSWORD: "guest-secret",
    VECTOR_SERVER_GUEST_WORKSPACES: "wrk_allowed",
    VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES: JSON.stringify({ wrk_allowed: tmp.path }),
    VECTOR_SERVER_GUEST_SESSIONS: claimedID,
    VECTOR_DISABLE_DEFAULT_PLUGINS: "1",
  })
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  const owner = { authorization: basic("vector", "owner-secret"), "content-type": "application/json" }
  const guest = { authorization: basic("guest", "guest-secret"), "content-type": "application/json" }
  const call = (route: string, init: RequestInit = {}) =>
    fetch(new URL(route, listener.url), { ...init, keepalive: false })
  try {
    Flag.VECTOR_WORKSPACE_ID = "wrk_allowed"
    // The owner's session in another project, outside the guest's workspace.
    const ownerSession = (await (
      await call(`/session?directory=${encodeURIComponent(elsewhere.path)}`, {
        method: "POST",
        headers: owner,
        body: "{}",
      })
    ).json()) as { id: string }
    const claimed = await call("/api/session", {
      method: "POST",
      headers: owner,
      body: JSON.stringify({ id: claimedID, location: { directory: tmp.path, workspaceID: "wrk_allowed" } }),
    })
    expect(claimed.status).toBe(200)
    const task = (id: string, action: string) => `/experimental/session/${id}/tasks/ses_missing/${action}`

    // View scope reaches the task lookup (no such isolated task here); outside it the guest is refused.
    const counts = await call(`${task(claimedID, "changes")}?diff=true`, { headers: guest })
    expect(counts.status).toBe(400)
    expect(await counts.json()).toMatchObject({ code: "not_found" })
    expect((await call(task(ownerSession.id, "changes"), { headers: guest })).status).toBe(403)
    for (const action of ["merge", "discard"]) {
      // Control of the session does not make the guest the owner.
      expect((await call(task(claimedID, action), { method: "POST", headers: guest, body: "{}" })).status).toBe(403)
      expect((await call(task(ownerSession.id, action), { method: "POST", headers: guest, body: "{}" })).status).toBe(
        403,
      )
      expect((await call(task(ownerSession.id, action), { method: "POST", headers: owner, body: "{}" })).status).toBe(
        400,
      )
    }
  } finally {
    Flag.VECTOR_WORKSPACE_ID = previousWorkspaceID
    await listener.stop(true)
    for (const key of keys) {
      const value = previous[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}, 30_000)

test("a guest reads its repository's trust but is told only the owner can approve it", async () => {
  // Approving trust is owner-only, so the app must not ask an invited guest a question whose answer is refused.
  await using tmp = await tmpdir({
    trusted: false,
    git: true,
    config: { model: "test/project-model", formatter: false, lsp: false },
  })
  const previousWorkspaceID = Flag.VECTOR_WORKSPACE_ID
  const keys = [
    "VECTOR_SERVER_USERNAME",
    "VECTOR_SERVER_PASSWORD",
    "VECTOR_SERVER_GUEST_USERNAME",
    "VECTOR_SERVER_GUEST_PASSWORD",
    "VECTOR_SERVER_GUEST_WORKSPACES",
    "VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES",
    "VECTOR_DISABLE_DEFAULT_PLUGINS",
  ] as const
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  Object.assign(process.env, {
    VECTOR_SERVER_USERNAME: "vector",
    VECTOR_SERVER_PASSWORD: "owner-secret",
    VECTOR_SERVER_GUEST_USERNAME: "guest",
    VECTOR_SERVER_GUEST_PASSWORD: "guest-secret",
    VECTOR_SERVER_GUEST_WORKSPACES: "wrk_allowed",
    VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES: JSON.stringify({ wrk_allowed: tmp.path }),
    VECTOR_DISABLE_DEFAULT_PLUGINS: "1",
  })
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  const owner = { authorization: basic("vector", "owner-secret"), "content-type": "application/json" }
  const guest = { authorization: basic("guest", "guest-secret"), "content-type": "application/json" }
  const call = (route: string, init: RequestInit = {}) =>
    fetch(new URL(route, listener.url), { ...init, keepalive: false })
  try {
    Flag.VECTOR_WORKSPACE_ID = "wrk_allowed"
    const guestStatus = await call("/config/trust", { headers: guest })
    expect(guestStatus.status).toBe(200)
    expect(await guestStatus.json()).toMatchObject({ trusted: false, ignored: true, settings: true, approvable: false })
    expect((await call("/config/trust", { method: "POST", headers: guest })).status).toBe(403)

    const ownerStatus = await call(`/config/trust?directory=${encodeURIComponent(tmp.path)}`, { headers: owner })
    expect(ownerStatus.status).toBe(200)
    expect(await ownerStatus.json()).toMatchObject({ trusted: false, ignored: true, settings: true, approvable: true })
  } finally {
    Flag.VECTOR_WORKSPACE_ID = previousWorkspaceID
    await listener.stop(true)
    for (const key of keys) {
      const value = previous[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}, 30_000)

test("a guest's global config leaves out the owner's Vector Local block", async () => {
  await using tmp = await tmpdir({ trusted: true, git: true, config: { formatter: false, lsp: false } })
  const previousWorkspaceID = Flag.VECTOR_WORKSPACE_ID
  const keys = [
    "VECTOR_SERVER_USERNAME",
    "VECTOR_SERVER_PASSWORD",
    "VECTOR_SERVER_GUEST_USERNAME",
    "VECTOR_SERVER_GUEST_PASSWORD",
    "VECTOR_SERVER_GUEST_WORKSPACES",
    "VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES",
    "VECTOR_DISABLE_DEFAULT_PLUGINS",
  ] as const
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  Object.assign(process.env, {
    VECTOR_SERVER_USERNAME: "vector",
    VECTOR_SERVER_PASSWORD: "owner-secret",
    VECTOR_SERVER_GUEST_USERNAME: "guest",
    VECTOR_SERVER_GUEST_PASSWORD: "guest-secret",
    VECTOR_SERVER_GUEST_WORKSPACES: "wrk_allowed",
    VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES: JSON.stringify({ wrk_allowed: tmp.path }),
    VECTOR_DISABLE_DEFAULT_PLUGINS: "1",
  })
  const files = ["vector.jsonc", "vector.json", "config.json"].map((name) => path.join(Global.Path.config, name))
  const originals = await Promise.all(
    files.map(async (file) => ((await Bun.file(file).exists()) ? Bun.file(file).text() : undefined)),
  )
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  const owner = { authorization: basic("vector", "owner-secret"), "content-type": "application/json" }
  const guest = { authorization: basic("guest", "guest-secret"), "content-type": "application/json" }
  const call = (route: string, init: RequestInit = {}) =>
    fetch(new URL(route, listener.url), { ...init, keepalive: false })
  const local = { endpoints: ["http://10.0.0.5:8000"], pins: { "http://10.0.0.5:8000": { kind: "vllm" } } }
  try {
    Flag.VECTOR_WORKSPACE_ID = "wrk_allowed"
    const saved = await call("/global/config", { method: "PATCH", headers: owner, body: JSON.stringify({ local }) })
    expect(saved.status).toBe(200)
    const read = async (headers: Record<string, string>) => {
      const response = await call("/global/config", { headers })
      expect(response.status).toBe(200)
      return (await response.json()) as { local?: unknown; $schema?: string }
    }
    // The owner's Add server starts from this list; a guest, which cannot change it, never sees it.
    expect((await read(owner)).local).toEqual(local)
    const forGuest = await read(guest)
    expect(forGuest.local).toBeUndefined()
    expect(JSON.stringify(forGuest)).not.toContain("10.0.0.5")
  } finally {
    Flag.VECTOR_WORKSPACE_ID = previousWorkspaceID
    const restore = () =>
      Promise.all(
        files.map((file, index) => {
          const original = originals[index]
          return original === undefined ? fs.rm(file, { force: true }) : Bun.write(file, original)
        }),
      )
    await restore()
    // A real change through the route loads the restored files, then they are restored once more.
    await call("/global/config", { method: "PATCH", headers: owner, body: JSON.stringify({ username: "restored" }) })
    await restore()
    await listener.stop(true)
    for (const key of keys) {
      const value = previous[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}, 30_000)

// A guest's resume (D.3, I11): it runs under the guest limits, and never reaches a free model that may train through
// the owner's acceptance. TaskManager.resume itself is tested in tool/task-manage.test.ts.
describe("a guest's task resume and background command rows", () => {
  const rootID = SessionID.make("ses_guest_resume_root")
  const trains = SessionID.make("ses_guest_resume_trains")
  const keeps = SessionID.make("ses_guest_resume_keeps")
  // Another conversation's helper on the training model: the guest controls neither it nor its parent.
  const foreign = SessionID.make("ses_guest_resume_foreign")
  const models: Record<string, string> = {
    [trains]: "acme/trains:free",
    [keeps]: "acme/keeps:free",
    [foreign]: "acme/trains:free",
  }
  const parentOf = (id: SessionID) => (id === foreign ? SessionID.make("ses_guest_resume_other") : rootID)
  const resumed: Array<{ guest: boolean; origin: string; refuses: boolean }> = []
  // A background command of the root session, as the manager returns it: with its absolute output path (5.H).
  const command: Task.Shell = {
    id: "shl_0123456789abGuestCommand01",
    title: "bun test",
    command: "bun test",
    status: "running",
    startedAt: 1,
    outputPath: "/owner/data/tool-output/shell-shl_0123456789abGuestCommand01.log",
    outputBytes: 0,
  }
  const listedShells: boolean[] = []
  // A request with an `x-test-guest` header runs as a guest in control of the sessions it lists.
  const authorization = Authorization.of((effect) =>
    Effect.gen(function* () {
      const claims = (yield* HttpServerRequest.HttpServerRequest).headers["x-test-guest"]
      if (claims === undefined) return yield* effect
      return yield* effect.pipe(
        Effect.provideService(RequestPrincipal, {
          kind: "guest",
          username: "guest",
          workspaceIDs: new Set<string>(),
          workspaceDirectories: new Map<string, string>(),
          sessionIDs: new Set(claims.split(",").filter(Boolean)),
        }),
      )
    }),
  )
  const session = (id: SessionID): Session.Info => ({
    id,
    slug: "test",
    projectID: ProjectV2.ID.make("project_test"),
    directory: process.cwd(),
    title: "test",
    version: "test",
    time: { created: 1, updated: 1 },
    ...(models[id]
      ? {
          parentID: parentOf(id),
          metadata: {
            subagent: {
              kind: "subagent",
              custom: false,
              agent: "general",
              title: "Survey",
              parentSessionID: parentOf(id),
              parentMessageID: "msg_guest_resume_launch",
              model: { providerID: "openrouter", modelID: models[id] },
              background: true,
              status: "cancelled",
              startedAt: 1,
              attempt: 1,
            },
          },
        }
      : {}),
  })
  const it = testEffect(
    HttpRouter.serve(
      HttpApiBuilder.layer(HttpApi.make("vector-instance").addHttpApi(ExperimentalApi)).pipe(
        Layer.provide(experimentalHandlers),
        Layer.provide([
          schemaErrorLayer,
          Layer.succeed(Authorization, authorization),
          Layer.succeed(
            InstanceContextMiddleware,
            InstanceContextMiddleware.of((effect) => effect),
          ),
          Layer.succeed(
            WorkspaceRoutingMiddleware,
            WorkspaceRoutingMiddleware.of((effect) =>
              effect.pipe(Effect.provideService(WorkspaceRouteContext, { directory: process.cwd() })),
            ),
          ),
          RuntimeFlags.layer({ backgroundSubagents: true }),
          // These unrelated experimental endpoints are never called by this test.
          Layer.mock(Agent.Service)({}),
          Layer.mock(MCP.Service)({}),
          Layer.mock(Project.Service)({}),
          Layer.mock(ToolRegistry.Service)({}),
          Layer.mock(Worktree.Service)({}),
          Layer.mock(DesktopTasks.Service)({}),
          Layer.mock(Session.Service)({ get: (id) => Effect.succeed(session(id)) }),
          // The free model whose provider may train on prompts, and one that keeps them private.
          Layer.mock(Provider.Service)({
            getModel: (_, modelID) =>
              Effect.succeed({
                freeModel: {
                  source: "openrouter",
                  dataPolicy: modelID === models[trains] ? "may-train" : "no-training",
                },
              } as unknown as Provider.Model),
          }),
          // Records whether the prompts a resume sends would refuse such a model.
          Layer.mock(SessionPrompt.Service)({
            prompt: (input, options) =>
              Effect.succeed({
                info: { id: "msg_guest_resume_reply", sessionID: input.sessionID, role: "user" },
                parts: [],
                refuses: options?.refuseTrainingFreeModels === true,
              } as unknown as SessionV1.WithParts),
          }),
          Layer.mock(TaskManager.Service)({
            list: (input) =>
              Effect.sync(() => {
                listedShells.push(input.shells === true)
                return { tasks: [], truncated: false, ...(input.shells ? { shells: [command] } : {}) }
              }),
            stop: () => Effect.succeed({ tasks: [], shells: [command] }),
            wait: () => Effect.succeed({ tasks: [], timedOut: false, shells: [command] }),
            resume: (input, ops) =>
              input.taskIDs.includes(foreign)
                ? Effect.fail(
                    new TaskManager.Error({
                      code: "forbidden",
                      message: "The task does not belong to this session's descendants.",
                    }),
                  )
                : ops.prompt({ sessionID: input.sessionID, parts: [] }).pipe(
                    Effect.map((reply) => {
                      const refuses = (reply as unknown as { refuses: boolean }).refuses
                      resumed.push({ guest: input.guest, origin: input.origin, refuses })
                      return { tasks: [] }
                    }),
                  ),
          }),
        ]),
      ),
      { disableListenLog: true, disableLogger: true },
    ).pipe(
      Layer.provideMerge(NodeHttpServer.layerTest),
      // Handlers read the audience per request. No conversation here is owner-only; the mocked sessions count as known.
      Layer.provide(
        Layer.mock(SessionAudience.Service)({
          knows: () => Effect.succeed(true),
          isPrivate: () => Effect.succeed(false),
        }),
      ),
    ),
  )
  const resume = (taskIDs: string[], headers: Record<string, string>) =>
    HttpClientRequest.post(`/experimental/session/${rootID}/tasks/resume`).pipe(
      HttpClientRequest.setHeaders(headers),
      HttpClientRequest.bodyJsonUnsafe({ taskIDs }),
      HttpClient.execute,
    )

  it.live("a guest resume refuses training models and runs under the guest limits", () =>
    Effect.gen(function* () {
      resumed.length = 0
      const guest = { "x-test-guest": rootID }
      // A helper on a free model that may train is refused at once, before anything resumes.
      const refused = yield* resume([keeps, trains], guest)
      expect(refused.status).toBe(400)
      expect(yield* refused.json).toEqual({ code: "forbidden", message: FREE_MODEL_TRAINING_OWNER_ONLY })
      expect(resumed).toEqual([])
      // One on a private free model resumes, as a guest whose prompts refuse such a model.
      expect((yield* resume([keeps], guest)).status).toBe(200)
      expect(resumed).toEqual([{ guest: true, origin: "user", refuses: true }])
      // Another session's helper gets resume's own refusal: its model is never looked up for the guest (I19).
      const elsewhere = yield* resume([foreign], guest)
      expect(elsewhere.status).toBe(400)
      expect(yield* elsewhere.json).toEqual({
        code: "forbidden",
        message: "The task does not belong to this session's descendants.",
      })
      // A guest without control of the session is refused before the manager is reached.
      expect((yield* resume([keeps], { "x-test-guest": "" })).status).toBe(403)
      // The owner accepted the training notice, so the owner may resume it.
      expect((yield* resume([trains], {})).status).toBe(200)
      expect(resumed[1]).toEqual({ guest: false, origin: "user", refuses: false })
      expect(resumed).toHaveLength(2)
    }),
  )

  // I19: a background command's output path, an absolute path in the owner's data folder, goes only to the owner. The
  // list, stop and wait routes all return command rows.
  it.live("a guest's command rows leave out their output path, and the owner's keep it", () =>
    Effect.gen(function* () {
      listedShells.length = 0
      const guest = { "x-test-guest": rootID }
      const rows = (response: { json: Effect.Effect<unknown, unknown> }) =>
        Effect.map(response.json, (body) => (body as { shells?: Array<Record<string, unknown>> }).shells)
      const routes = [
        () => HttpClientRequest.get(`/experimental/session/${rootID}/tasks?shells=true`),
        () =>
          HttpClientRequest.post(`/experimental/session/${rootID}/tasks/stop`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ taskIDs: [command.id] }),
          ),
        () =>
          HttpClientRequest.post(`/experimental/session/${rootID}/tasks/wait`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ taskIDs: [command.id], timeout: 0 }),
          ),
      ]
      for (const route of routes) {
        const asGuest = yield* route().pipe(HttpClientRequest.setHeaders(guest), HttpClient.execute)
        expect(asGuest.status).toBe(200)
        const seen = yield* rows(asGuest)
        expect(seen).toEqual([
          { id: command.id, title: "bun test", command: "bun test", status: "running", startedAt: 1, outputBytes: 0 },
        ])
        const asOwner = yield* route().pipe(HttpClientRequest.setHeaders({}), HttpClient.execute)
        expect(asOwner.status).toBe(200)
        expect((yield* rows(asOwner))?.[0]?.outputPath).toBe(command.outputPath)
      }
      // The list route asked the manager for the session's commands both times.
      expect(listedShells).toEqual([true, true])
    }),
  )
})

// Presence on the directory event stream. This test server has no password,
// so every connection has the default owner principal regardless of headers.
const EventData = Schema.Struct({
  id: Schema.optional(Schema.String),
  type: Schema.String,
  properties: Schema.Record(Schema.String, Schema.Any),
})
type EventData = typeof EventData.Type

// SSE frames can share a chunk, so buffer and split on the blank line between events.
function frames(buffer: { pending: string }, chunk: string) {
  buffer.pending += chunk
  const parts = buffer.pending.split("\n\n")
  buffer.pending = parts.pop() ?? ""
  return parts.flatMap((frame) => {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
    return data ? [Schema.decodeUnknownSync(EventData)(JSON.parse(data))] : []
  })
}

const openEventStream = (directory: string, headers: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const response = yield* requestInDirectory(EventPaths.event, directory, { headers })
    const events = yield* Queue.unbounded<EventData>()
    const buffer = { pending: "" }
    const decoder = new TextDecoder()
    yield* response.stream.pipe(
      Stream.runForEach((chunk) => Queue.offerAll(events, frames(buffer, decoder.decode(chunk, { stream: true })))),
      Effect.forkScoped,
    )
    return { response, events }
  })

// A stream we can actually hang up on: the Effect test client keeps the socket
// open when its reader is interrupted, whereas aborting a fetch closes it, which
// is what the server needs to observe a departure.
const openAbortableEventStream = (directory: string, headers: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const address = (yield* HttpServer.HttpServer).address
    if (address._tag !== "TcpAddress") return yield* Effect.die(new Error("expected a tcp test server"))
    const controller = new AbortController()
    yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()))
    const response = yield* Effect.promise(() =>
      fetch(`http://localhost:${address.port}${EventPaths.event}`, {
        headers: { ...headers, "x-vector-directory": directory },
        signal: controller.signal,
      }),
    )
    expect(response.status).toBe(200)
    const events = yield* Queue.unbounded<EventData>()
    const buffer = { pending: "" }
    const decoder = new TextDecoder()
    yield* Effect.promise(async () => {
      const reader = response.body?.getReader()
      if (!reader) return
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) return
          for (const event of frames(buffer, decoder.decode(value, { stream: true }))) Queue.offerUnsafe(events, event)
        }
      } catch {
        // aborted on purpose
      }
    }).pipe(Effect.forkScoped)
    return { events, close: () => controller.abort() }
  })

const next = (events: Queue.Dequeue<EventData>, type: string) =>
  Effect.gen(function* () {
    while (true) {
      const event = yield* Queue.take(events).pipe(
        Effect.timeoutOrElse({
          duration: "5 seconds",
          orElse: () => Effect.fail(new Error(`timed out waiting for ${type}`)),
        }),
      )
      if (event.type === type) return event
    }
  })

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const it = testEffect(httpApiLayer)

describe("event stream presence", () => {
  it.instance(
    "announces peers and replays the roster to newcomers",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance

        const owner = yield* openEventStream(directory, { authorization: basic("vector", "anything") })
        expect(yield* next(owner.events, "server.connected")).toMatchObject({ type: "server.connected" })

        const guest = yield* openAbortableEventStream(directory, { authorization: basic("guest", "guest-secret") })

        // The existing connection learns about the newcomer, which is not told about itself.
        const joined = yield* next(owner.events, "client.joined")
        expect(joined.properties.username).toBe("vector")
        expect(typeof joined.properties.clientID).toBe("string")
        expect(typeof joined.properties.at).toBe("number")

        // The new stream opens with the roster of peers already connected.
        expect(yield* next(guest.events, "server.connected")).toMatchObject({ type: "server.connected" })
        const peer = yield* next(guest.events, "client.joined")
        expect(peer.properties.username).toBe("vector")
        expect(peer.properties.clientID).not.toBe(joined.properties.clientID)

        // Hanging up tells the existing peer that the newcomer left.
        guest.close()
        const left = yield* next(owner.events, "client.left")
        expect(left.properties.clientID).toBe(joined.properties.clientID)
        expect(left.properties.username).toBe("vector")
      }),
    { trusted: true, git: true, config: { formatter: false, lsp: false } },
    20_000,
  )
})
