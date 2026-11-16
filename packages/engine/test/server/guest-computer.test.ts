import { afterEach, expect } from "bun:test"
import { ConfigProvider, Context, Effect, Layer, Stream } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Flag } from "@vectordevai/core/flag/flag"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ComputerPrivacy } from "@vectordevai/server/computer-privacy"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { SessionV1 } from "@vectordevai/schema/session-v1"
import { Session } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { ServerAuth } from "@/server/auth"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"

const screenshot = "data:image/png;base64,cHJpdmF0ZS1kZXNrdG9wLXNjcmVlbg=="
const ordinaryImage = "data:image/png;base64,b3JkaW5hcnktcmVhZC1pbWFnZQ=="
const originalWorkspaces = Flag.VECTOR_EXPERIMENTAL_WORKSPACES
const originalWorkspaceID = Flag.VECTOR_WORKSPACE_ID
class TestServerMemoMap extends Context.Service<TestServerMemoMap, Layer.MemoMap>()("@test/GuestComputerMemoMap") {}

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(Session.node, [
      [
        InstanceStore.bootstrapNode,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ]),
    Layer.effect(
      TestServerMemoMap,
      Effect.contextWith((context: Context.Context<never>) =>
        Effect.succeed(Layer.CurrentMemoMap.getOrCreate(context)),
      ),
    ),
  ),
)

afterEach(async () => {
  Flag.VECTOR_EXPERIMENTAL_WORKSPACES = originalWorkspaces
  Flag.VECTOR_WORKSPACE_ID = originalWorkspaceID
  await disposeAllInstances()
  await resetDatabase()
})

const fixture = Effect.fn("test.guestComputer.fixture")(function* () {
  Flag.VECTOR_WORKSPACE_ID = "wrk_fixture"
  const memoMap = yield* TestServerMemoMap
  const directory = (yield* TestInstance).directory
  const session = yield* Session.Service
  const chat = yield* session.create({ title: "Computer screenshot privacy" })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    sessionID: chat.id,
    role: "user",
    agent: "build",
    model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
    time: { created: 1 },
  })
  const message = yield* session.updateMessage({
    id: MessageID.ascending(),
    sessionID: chat.id,
    role: "assistant",
    parentID: user.id,
    agent: "build",
    mode: "build",
    modelID: ModelV2.ID.make("test"),
    providerID: ProviderV2.ID.make("test"),
    path: { cwd: directory, root: directory },
    time: { created: 2 },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  const part = (tool: string, url: string): SessionV1.ToolPart => ({
    id: PartID.ascending(),
    sessionID: chat.id,
    messageID: message.id,
    type: "tool",
    tool,
    callID: `call_${tool}`,
    state: {
      status: "completed",
      input: {},
      output: "Approved app observed",
      title: "Observed",
      metadata: {},
      time: { start: 2, end: 3 },
      attachments: [
        {
          id: PartID.ascending(),
          sessionID: chat.id,
          messageID: message.id,
          type: "file",
          mime: "image/png",
          url,
        },
      ],
    },
  })
  const computer = yield* session.updatePart(part("computer", screenshot))
  yield* session.updatePart(part("read", ordinaryImage))
  const web = yield* Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        HttpApiApp.routes.pipe(
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                VECTOR_SERVER_PASSWORD: "owner-fixture",
                VECTOR_SERVER_USERNAME: "vector",
                VECTOR_SERVER_GUEST_PASSWORD: "guest-fixture",
                VECTOR_SERVER_GUEST_USERNAME: "guest",
                VECTOR_SERVER_GUEST_SESSIONS: chat.id,
                VECTOR_SERVER_GUEST_WORKSPACES: "wrk_fixture",
                VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES: JSON.stringify({ wrk_fixture: directory }),
              }),
            ),
          ),
        ),
        { disableLogger: true, memoMap },
      ),
    ),
    (web) => Effect.promise(() => web.dispose()),
  )
  const request = (path: string, viewer: "owner" | "guest", init?: RequestInit) =>
    Effect.promise(() => {
      const headers = new Headers(init?.headers)
      headers.set("x-vector-directory", directory)
      headers.set("content-type", "application/json")
      headers.set(
        "authorization",
        ServerAuth.header(
          viewer === "owner"
            ? { username: "vector", password: "owner-fixture" }
            : { username: "guest", password: "guest-fixture" },
        )!,
      )
      return web.handler(
        new Request(new URL(path, "http://localhost"), {
          ...init,
          headers,
        }),
        HttpApiApp.context,
      )
    })
  return { directory, session, chat, message, computer, request }
})

it.instance(
  "guests receive computer parts without attachments on full, paged and single-message reads",
  () =>
    Effect.gen(function* () {
      const state = yield* fixture()
      for (const path of [
        `/session/${state.chat.id}/message`,
        `/session/${state.chat.id}/message?limit=1`,
        `/session/${state.chat.id}/message/${state.message.id}`,
      ]) {
        const guest = yield* state.request(path, "guest")
        expect(guest.status).toBe(200)
        const guestText = yield* Effect.promise(() => guest.text())
        expect(guestText).not.toContain(screenshot)
        expect(guestText).toContain(ordinaryImage)
        const owner = yield* state.request(path, "owner")
        expect(owner.status).toBe(200)
        expect(yield* Effect.promise(() => owner.text())).toContain(screenshot)
      }
      expect(JSON.stringify(yield* state.session.messages({ sessionID: state.chat.id }))).toContain(screenshot)
    }),
  { trusted: true, git: true, config: { formatter: false, lsp: false } },
)

function streamReader(response: Response) {
  if (!response.body) throw new Error("Expected an event stream")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const records: string[] = []
  let buffered = ""
  let done = false
  let failure: unknown
  let wake: (() => void) | undefined
  // Keep pulling like an SSE client: global event subscriptions begin after the opening record.
  const pump = (async () => {
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) return
        buffered += decoder.decode(chunk.value, { stream: true }).replaceAll("\r\n", "\n")
        while (true) {
          const boundary = buffered.indexOf("\n\n")
          if (boundary < 0) break
          records.push(buffered.slice(0, boundary))
          buffered = buffered.slice(boundary + 2)
        }
        wake?.()
      }
    } catch (error) {
      failure = error
    } finally {
      done = true
      wake?.()
    }
  })()
  return {
    cancel: async () => {
      await reader.cancel()
      await pump
    },
    read: async (match: (record: string) => boolean) => {
      while (true) {
        while (records.length > 0) {
          const record = records.shift()!
          if (match(record)) return record
        }
        if (done) throw failure ?? new Error("Event stream ended before the expected event")
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
    },
  }
}

it.instance(
  "guest event streams and owner workspace-sync streams omit screenshots while local owner events retain them",
  () =>
    Effect.gen(function* () {
      const state = yield* fixture()
      const published: GlobalEvent[] = []
      const observe = (event: GlobalEvent) => {
        if (JSON.stringify(event.payload).includes(state.computer.id)) published.push(event)
      }
      yield* Effect.acquireRelease(
        Effect.sync(() => GlobalBus.on("event", observe)),
        () => Effect.sync(() => GlobalBus.off("event", observe)),
      )
      const wait = <A, E, R>(effect: Effect.Effect<A, E, R>, label: string) =>
        effect.pipe(
          Effect.timeoutOrElse({
            duration: "5 seconds",
            orElse: () =>
              Effect.fail(
                new Error(
                  `${label}; expected directory=${state.directory} workspace=wrk_fixture; published=${JSON.stringify(published.map((event) => ({ directory: event.directory, workspace: event.workspace, type: event.payload.type })))}`,
                ),
              ),
          }),
        )
      const streams = yield* Effect.forEach(
        [
          { path: "/event", viewer: "guest" as const, screen: false },
          { path: "/event", viewer: "owner" as const, screen: true },
          { path: "/global/event", viewer: "guest" as const, screen: false },
          { path: "/global/event", viewer: "owner" as const, screen: true },
          { path: "/global/event", viewer: "owner" as const, screen: false, sync: true },
        ],
        (input) =>
          Effect.gen(function* () {
            const response = yield* state.request(input.path, input.viewer, {
              headers: input.sync ? { [ComputerPrivacy.WORKSPACE_SYNC_HEADER]: "1" } : {},
            })
            expect(response.status).toBe(200)
            const reader = yield* Effect.acquireRelease(
              Effect.sync(() => streamReader(response)),
              (reader) => Effect.promise(() => reader.cancel()),
            )
            yield* wait(
              Effect.promise(() => reader.read((record) => record.includes("server.connected"))),
              `${input.path} ${input.viewer} sync=${!!input.sync}: server.connected`,
            )
            return { ...input, reader }
          }),
      )
      const update = yield* state.request(
        `/session/${state.chat.id}/message/${state.message.id}/part/${state.computer.id}`,
        "owner",
        {
          method: "PATCH",
          body: JSON.stringify(state.computer),
        },
      )
      expect(update.status).toBe(200)
      yield* Effect.promise(() => update.text())
      for (const input of streams) {
        const event = yield* wait(
          Effect.promise(() =>
            input.reader.read(
              (record) => record.includes('"message.part.updated"') && record.includes(state.computer.id),
            ),
          ),
          `${input.path} ${input.viewer} sync=${!!input.sync}: message.part.updated`,
        )
        expect(event.includes(screenshot)).toBe(input.screen)
      }
      const ownerGlobal = streams.find((input) => input.path === "/global/event" && input.screen)!
      const sync = yield* wait(
        Effect.promise(() =>
          ownerGlobal.reader.read((record) => record.includes('"syncEvent"') && record.includes(state.computer.id)),
        ),
        "/global/event owner sync=false: syncEvent",
      )
      expect(sync).not.toContain(screenshot)
    }),
  { trusted: true, git: true, config: { formatter: false, lsp: false } },
)

it.instance(
  "owner sync history omits computer screenshots while ordinary local history retains them",
  () =>
    Effect.gen(function* () {
      Flag.VECTOR_EXPERIMENTAL_WORKSPACES = true
      const state = yield* fixture()
      const response = yield* state.request("/sync/history", "owner", { method: "POST", body: "{}" })
      expect(response.status).toBe(200)
      const body = yield* Effect.promise(() => response.text())
      expect(body).not.toContain(screenshot)
      expect(body).toContain(ordinaryImage)
      expect(JSON.stringify(yield* state.session.messages({ sessionID: state.chat.id }))).toContain(screenshot)
    }),
  { trusted: true, git: true, config: { formatter: false, lsp: false } },
)

it.effect("streamed JSON responses are projected before leaving the guest authorization boundary", () =>
  Effect.gen(function* () {
    const original = {
      type: "tool",
      tool: "computer",
      state: { status: "completed", attachments: [{ url: screenshot }], output: "Observed" },
    }
    const response = yield* ComputerPrivacy.response(
      HttpServerResponse.stream(Stream.make(JSON.stringify(original)).pipe(Stream.encodeText), {
        contentType: "application/json",
      }),
    )
    expect(response.body._tag).toBe("Uint8Array")
    if (response.body._tag !== "Uint8Array") throw new Error("Expected a projected JSON body")
    const body = new TextDecoder().decode(response.body.body)
    expect(body).not.toContain(screenshot)
    expect(body).toContain("Observed")
    expect(original.state.attachments).toHaveLength(1)
  }),
)

it.effect("owner-authenticated upstream SSE is projected before a guest receives its bytes", () =>
  Effect.gen(function* () {
    const event = (tool: string, url: string) =>
      JSON.stringify({
        type: "message.part.updated",
        properties: {
          part: { type: "tool", tool, state: { status: "completed", output: "Observed", attachments: [{ url }] } },
        },
      })
    const wire = `id: computer-event\ndata: ${event("computer", screenshot)}\n\nid: ordinary-event\ndata: ${event("read", ordinaryImage)}\n\n`
    const split = wire.indexOf(screenshot) + 12
    const response = yield* ComputerPrivacy.response(
      HttpServerResponse.stream(Stream.make(wire.slice(0, split), wire.slice(split)).pipe(Stream.encodeText), {
        contentType: "text/event-stream",
      }),
    )
    expect(response.headers["content-type"]).toBe("text/event-stream")
    if (response.body._tag !== "Stream") throw new Error("Expected the projected event stream")
    const body = (yield* response.body.stream.pipe(Stream.decodeText, Stream.runCollect)).join("")
    expect(body).not.toContain(screenshot)
    expect(body).toContain(ordinaryImage)
    expect(body).toContain("id: computer-event")
    expect(body).toContain("Observed")
  }),
)
