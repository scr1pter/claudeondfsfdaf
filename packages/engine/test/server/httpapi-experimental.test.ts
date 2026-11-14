import { afterEach, describe, expect } from "bun:test"
import Http from "node:http"
import { NodeHttpServer } from "@effect/platform-node"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Context, Deferred, Effect, Fiber, Layer } from "effect"
import { HttpClient, HttpClientResponse, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { eq } from "drizzle-orm"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { ExperimentalPaths } from "../../src/server/routes/instance/httpapi/groups/experimental"
import { Session } from "@/session/session"
import { SessionTable } from "@vectordevai/core/session/sql"
import { Database } from "@vectordevai/core/database/database"
import { AccountV2 } from "@vectordevai/core/account"
import { AccountTable } from "@vectordevai/core/account/sql"
import { Computer } from "@vectordevai/schema/computer"
import { Worktree } from "../../src/worktree"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(Layer.mergeAll(LayerNode.compile(LayerNode.group([Session.node, Database.node])), httpApiLayer))
const testWorktreeMutations = process.platform === "win32" ? it.instance.skip : it.instance

function request(path: string, directory: string, init: RequestInit = {}) {
  return requestInDirectory(path, directory, init)
}

function createSession(input?: Session.CreateInput) {
  return Session.use.create(input)
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  return response.json.pipe(Effect.map((value) => value as T))
}

function withComputerBridge<A, E, R>(
  bridge: { url: string; token: string } | undefined,
  effect: Effect.Effect<A, E, R>,
) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = {
        url: process.env.VECTOR_COMPUTER_BRIDGE_URL,
        token: process.env.VECTOR_COMPUTER_BRIDGE_TOKEN,
      }
      if (bridge) {
        process.env.VECTOR_COMPUTER_BRIDGE_URL = bridge.url
        process.env.VECTOR_COMPUTER_BRIDGE_TOKEN = bridge.token
      } else {
        delete process.env.VECTOR_COMPUTER_BRIDGE_URL
        delete process.env.VECTOR_COMPUTER_BRIDGE_TOKEN
      }
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous.url === undefined) delete process.env.VECTOR_COMPUTER_BRIDGE_URL
        else process.env.VECTOR_COMPUTER_BRIDGE_URL = previous.url
        if (previous.token === undefined) delete process.env.VECTOR_COMPUTER_BRIDGE_TOKEN
        else process.env.VECTOR_COMPUTER_BRIDGE_TOKEN = previous.token
      }),
  )
}

function waitReady(input: { directory?: string; name?: string }) {
  return Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()
    const on = (event: GlobalEvent) => {
      if (event.payload.type !== Worktree.Event.Ready.type) return
      if (input.directory && event.directory !== input.directory) return
      if (input.name && event.payload.properties.name !== input.name) return
      Deferred.doneUnsafe(ready, Effect.void)
    }

    GlobalBus.on("event", on)
    yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", on)))

    return yield* Deferred.await(ready).pipe(
      Effect.timeoutOrElse({
        duration: "10 seconds",
        orElse: () => Effect.fail(new Error("timed out waiting for worktree.ready")),
      }),
    )
  })
}

function insertAccount() {
  return Effect.acquireRelease(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(AccountTable)
        .values({
          id: AccountV2.ID.make("account-test"),
          email: "test@example.com",
          url: "https://console.example.com",
          access_token: AccountV2.AccessToken.make("access"),
          refresh_token: AccountV2.RefreshToken.make("refresh"),
          time_created: Date.now(),
          time_updated: Date.now(),
        })
        .run()
        .pipe(Effect.orDie)
      return "account-test"
    }),
    (id) =>
      Database.Service.use(({ db }) =>
        db
          .delete(AccountTable)
          .where(eq(AccountTable.id, AccountV2.ID.make(id)))
          .run()
          .pipe(Effect.orDie),
      ),
  )
}

function setSessionUpdated(session: Session.Info, updated: number) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .update(SessionTable)
      .set({ time_updated: updated })
      .where(eq(SessionTable.id, session.id))
      .run()
      .pipe(Effect.orDie)
  })
}

function withCreatedWorktree(
  directory: string,
  use: (info: Worktree.Info) => Effect.Effect<void, unknown, HttpClient.HttpClient>,
) {
  const name = "api-test"
  const headers = { "content-type": "application/json" }
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const ready = yield* waitReady({ name }).pipe(Effect.forkScoped)
      const created = yield* request(ExperimentalPaths.worktree, directory, {
        method: "POST",
        headers,
        body: JSON.stringify({ name }),
      })

      expect(created.status).toBe(200)
      const info = yield* json<Worktree.Info>(created)
      expect(info).toMatchObject({ name, branch: "vector/api-test" })
      yield* Fiber.join(ready)
      return info
    }),
    use,
    (info) =>
      Effect.gen(function* () {
        const removed = yield* request(ExperimentalPaths.worktree, directory, {
          method: "DELETE",
          headers,
          body: JSON.stringify({ directory: info.directory }),
        })
        if (removed.status !== 200) return yield* Effect.fail(new Error(`failed to remove worktree: ${removed.status}`))
        const ok = yield* json<boolean>(removed)
        if (!ok) return yield* Effect.fail(new Error(`failed to remove worktree ${info.directory}`))
      }),
  )
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("experimental HttpApi", () => {
  it.instance("capabilities explain that computer use needs a desktop bridge", () =>
    withComputerBridge(
      undefined,
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const response = yield* request(ExperimentalPaths.capabilities, tmp.directory)
        expect(response.status).toBe(200)
        expect(yield* json(response)).toMatchObject({
          backgroundSubagents: expect.any(Boolean),
          computer: { available: false, reason: "no_desktop_bridge" },
        })
      }),
    ),
  )

  for (const reason of [undefined, "permissions"] as const) {
    it.instance(`capabilities report computer availability with bridge reason ${reason ?? "ready"}`, () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const context = yield* Layer.build(NodeHttpServer.layer(Http.createServer, { host: "127.0.0.1", port: 0 }))
        const server = Context.get(context, HttpServer.HttpServer)
        yield* server.serve(
          HttpServerRequest.HttpServerRequest.use((input) => {
            if (input.method !== "GET" || input.url !== Computer.BRIDGE.capabilitiesPath)
              return Effect.succeed(HttpServerResponse.empty({ status: 404 }))
            if (input.headers.authorization !== "Bearer computer-capabilities-fixture")
              return Effect.succeed(HttpServerResponse.empty({ status: 401 }))
            if (input.headers[Computer.BRIDGE.protocolHeader.toLowerCase()] !== String(Computer.PROTOCOL))
              return Effect.succeed(HttpServerResponse.empty({ status: 426 }))
            return HttpServerResponse.json({
              protocol: Computer.PROTOCOL,
              available: reason === undefined,
              ...(reason ? { reason } : {}),
              backend: "fake",
              actions: ["list_apps", "read_ui"],
              features: { background: false, uiTree: true, zoom: false, clipboard: false, locked: false },
            } satisfies Computer.Capabilities)
          }),
        )
        yield* withComputerBridge(
          { url: HttpServer.formatAddress(server.address), token: "computer-capabilities-fixture" },
          Effect.gen(function* () {
            const response = yield* request(ExperimentalPaths.capabilities, tmp.directory)
            expect(response.status).toBe(200)
            expect(yield* json(response)).toMatchObject({
              computer: { available: true, protocol: Computer.PROTOCOL },
            })
          }),
        )
      }),
    )
  }

  it.instance(
    "serves read-only experimental endpoints through the default server app",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const directory = tmp.directory
        const [consoleState, consoleOrgs, toolList, toolIDs, worktrees, resources] = yield* Effect.all(
          [
            request(ExperimentalPaths.console, directory),
            request(ExperimentalPaths.consoleOrgs, directory),
            request(`${ExperimentalPaths.tool}?provider=vector&model=gpt-5`, directory),
            request(ExperimentalPaths.toolIDs, directory),
            request(ExperimentalPaths.worktree, directory),
            request(ExperimentalPaths.resource, directory),
          ],
          { concurrency: "unbounded" },
        )

        expect(consoleState.status).toBe(200)
        expect(yield* json(consoleState)).toEqual({
          consoleManagedProviders: [],
          switchableOrgCount: 0,
        })

        expect(consoleOrgs.status).toBe(200)
        expect(yield* json(consoleOrgs)).toEqual({ enabled: false, orgs: [] })

        expect(toolList.status).toBe(200)
        expect(yield* json<unknown[]>(toolList)).toContainEqual(
          expect.objectContaining({
            id: "bash",
            description: expect.any(String),
            parameters: expect.any(Object),
          }),
        )

        expect(toolIDs.status).toBe(200)
        expect(yield* json(toolIDs)).toContain("bash")

        expect(worktrees.status).toBe(200)
        expect(yield* json(worktrees)).toEqual([])

        expect(resources.status).toBe(200)
        expect(yield* json(resources)).toEqual({})
      }),
    {
      trusted: true,
      config: {
        formatter: false,
        lsp: false,
        mcp: {
          demo: {
            type: "local",
            command: ["echo", "demo"],
            enabled: false,
          },
        },
      },
    },
  )

  it.instance("returns declared worktree errors", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const response = yield* request(ExperimentalPaths.worktree, tmp.directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })

      expect(response.status).toBe(400)
      expect(yield* json(response)).toEqual({
        name: "WorktreeNotGitError",
        data: { message: "Worktrees are only supported for Git repositories" },
      })
    }),
  )

  it.instance(
    "does not treat obsolete saved accounts as verified Vector Teams membership",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const accountID = yield* insertAccount()
        const switched = yield* request(ExperimentalPaths.consoleSwitch, tmp.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accountID, orgID: "org-test" }),
        })

        expect(switched.status).toBe(400)
        const state = yield* request(ExperimentalPaths.console, tmp.directory)
        expect(state.status).toBe(200)
        expect(yield* json(state)).toEqual({ consoleManagedProviders: [], switchableOrgCount: 0 })
        const orgs = yield* request(ExperimentalPaths.consoleOrgs, tmp.directory)
        expect(orgs.status).toBe(200)
        expect(yield* json(orgs)).toEqual({ enabled: false, orgs: [] })
      }),
    { trusted: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves global session list through the default server app",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const first = yield* createSession({ title: "page-one" })
        const second = yield* createSession({ title: "page-two" })
        yield* setSessionUpdated(first, 1)
        yield* setSessionUpdated(second, 2)

        const page = yield* request(
          `${ExperimentalPaths.session}?${new URLSearchParams({ directory: tmp.directory, limit: "1" })}`,
          tmp.directory,
        )
        expect(page.status).toBe(200)
        expect(page.headers["x-next-cursor"]).toBeTruthy()

        const body = yield* json<Session.GlobalInfo[]>(page)
        expect(body.map((session) => session.id)).toEqual([second.id])
        expect(body[0].project?.id).toBe(second.projectID)

        const next = yield* request(
          `${ExperimentalPaths.session}?${new URLSearchParams({
            directory: tmp.directory,
            limit: "10",
            cursor: body[0].time.updated.toString(),
          })}`,
          tmp.directory,
        )
        expect(next.status).toBe(200)
        expect((yield* json<Session.GlobalInfo[]>(next)).map((session) => session.id)).toContain(first.id)
      }),
    { trusted: true, git: true, config: { formatter: false, lsp: false } },
  )

  testWorktreeMutations(
    "serves worktree mutations through the default server app",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        yield* withCreatedWorktree(tmp.directory, (info) =>
          Effect.gen(function* () {
            const listed = yield* request(ExperimentalPaths.worktree, tmp.directory)
            expect(listed.status).toBe(200)
            expect(yield* json(listed)).toContain(info.directory)

            const reset = yield* request(ExperimentalPaths.worktreeReset, tmp.directory, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ directory: info.directory }),
            })

            expect(reset.status).toBe(200)
            expect(yield* json(reset)).toBe(true)
          }),
        )

        const afterRemove = yield* request(ExperimentalPaths.worktree, tmp.directory)
        expect(afterRemove.status).toBe(200)
        expect(yield* json(afterRemove)).toEqual([])
      }),
    { trusted: true, git: true, config: { formatter: false, lsp: false } },
  )
})
