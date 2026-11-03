import { afterEach, expect } from "bun:test"
import { ConfigProvider, Effect, Fiber, Layer, Schema } from "effect"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { createVectorClient } from "@vectordevai/sdk/v2"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { GUEST_REQUEST_HEADER, FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { SessionAudience } from "@vectordevai/core/session/audience"
import { PtyTicket } from "@vectordevai/core/pty/ticket"
import { RequestPrincipal } from "@vectordevai/protocol/middleware/authorization"
import type { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { Session } from "@/session/session"
import { SessionMemory } from "@/session/memory"
import { SessionID } from "@/session/schema"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  workspaceRoutingLayer,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { workspaceLayerWithRuntimeFlags } from "../fixture/workspace"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { httpApiLayer } from "./httpapi-layer"

const allowedID = SessionID.make("ses_workflow_http_authorized")
const auth = (username: string, password: string) =>
  `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
const owner = { authorization: auth("vector", "owner-secret") }
const guest = { authorization: auth("guest", "guest-secret") }
const forwarded = { ...owner, [GUEST_REQUEST_HEADER]: "1" }
const serverConfig = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    VECTOR_SERVER_USERNAME: "vector",
    VECTOR_SERVER_PASSWORD: "owner-secret",
    VECTOR_SERVER_GUEST_USERNAME: "guest",
    VECTOR_SERVER_GUEST_PASSWORD: "guest-secret",
    VECTOR_SERVER_GUEST_SESSIONS: allowedID,
    VECTOR_DISABLE_BACKGROUND_SUBAGENTS: false,
    VECTOR_DISABLE_DEFAULT_PLUGINS: true,
  }),
)
const it = testEffect(Layer.mergeAll(httpApiLayer.pipe(Layer.provide(serverConfig)), TestLLMServer.layer))
const spec = JSON.stringify({
  version: 1,
  title: "Review one file",
  defaults: { agent: "explore", model: "lmstudio/test-model" },
  stages: [{ id: "review", prompt: "Review the fixture file and return a short finding.", on_error: "fail" }],
})
const ref = { providerID: "lmstudio", modelID: "test-model" }
const call = <A>(run: () => Promise<A>) => Effect.promise(run)

const fixture = Effect.fn("WorkflowHttpTest.fixture")(function* (extra: Partial<ConfigV1.Info> = {}) {
  const llm = yield* TestLLMServer
  const directory = yield* tmpdirScoped({
    trusted: true,
    config: { ...testProviderConfig(llm.url), model: "lmstudio/test-model", ...extra },
  })
  const server = yield* HttpServer.HttpServer
  const baseUrl = HttpServer.formatAddress(server.address)
  const client = (headers = owner) => createVectorClient({ baseUrl, directory, headers, throwOnError: true })
  const sdk = client()
  // V2 permits a caller-selected ID. Its legacy projection gives the real owner-start path a new empty session,
  // while the fixed ID grants the guest view/control scope without granting server ownership.
  const created = yield* call(() =>
    fetch(new URL("/api/session", baseUrl), {
      method: "POST",
      headers: { ...owner, "content-type": "application/json" },
      body: JSON.stringify({ id: allowedID, title: "Workflow HTTP parent", location: { directory } }),
    }),
  )
  expect(created.status, yield* call(() => created.text())).toBe(200)
  const parent = (yield* call(() => sdk.session.get({ sessionID: allowedID }))).data!
  expect(parent.id).toBe(allowedID)
  const raw = (route: string, headers: Record<string, string> = owner, body?: unknown) =>
    call(() =>
      fetch(new URL(route, baseUrl), {
        method: body === undefined ? "GET" : "POST",
        headers: { ...headers, "x-vector-directory": directory, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  return { sdk, client, raw, llm, directory, parent }
})

function finished(sdk: ReturnType<typeof createVectorClient>, runID: string) {
  return pollWithTimeout(
    call(() => sdk.experimental.workflow.get({ sessionID: allowedID, runID })).pipe(
      Effect.map((result) => {
        const status = result.data?.task.status
        return status === "completed" || status === "failed" || status === "stopped" ? result.data : undefined
      }),
    ),
    "Workflow never reached a terminal state",
    "10 seconds",
  )
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

it.live("owner preview validates without writes; guests and forwarded guests cannot preview or mutate", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    const before = (yield* call(() => f.sdk.session.messages({ sessionID: allowedID }))).data!
    expect(before).toHaveLength(0)
    expect((yield* call(() => f.sdk.experimental.capabilities.get())).data?.workflows).toBe(true)
    const valid = (yield* call(() => f.sdk.experimental.workflow.validate({ workflowValidateInput: { spec } }))).data!
    expect(valid).toMatchObject({ ok: true, issues: [] })
    expect(valid.plan?.stages[0].model).toBe("lmstudio/test-model")
    const invalid = (yield* call(() => f.sdk.experimental.workflow.validate({ workflowValidateInput: { spec: "{" } })))
      .data!
    expect(invalid.ok).toBe(false)
    expect(invalid.issues.length).toBeGreaterThan(0)
    expect((yield* call(() => f.sdk.experimental.workflow.saved())).data).toEqual({ workflows: [] })
    for (const headers of [guest, forwarded]) {
      for (const [route, body] of [
        ["/experimental/workflow/saved", undefined],
        ["/experimental/workflow/validate", { spec }],
        [`/experimental/session/${allowedID}/workflow`, { spec }],
        [`/experimental/session/${allowedID}/workflow/ses_missing/resume`, {}],
      ] as const) {
        const response = yield* f.raw(route, headers, body)
        expect(response.status, yield* call(() => response.text())).toBe(403)
      }
    }
    expect((yield* call(() => f.sdk.session.messages({ sessionID: allowedID }))).data).toEqual(before)
    expect((yield* call(() => f.sdk.session.children({ sessionID: allowedID }))).data).toHaveLength(0)
    expect(yield* f.llm.inputs).toHaveLength(0)
  }),
)

it.live(
  "new-session owner start preserves HTTP prompt history and never calls a model as coordinator",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      yield* f.llm.text("The fixture file has been reviewed.", { usage: { input: 11, output: 7 } })
      const started = (yield* call(() =>
        f.sdk.experimental.workflow.start({ sessionID: allowedID, workflowStartInput: { spec } }),
      )).data!
      const result = yield* finished(f.sdk, started.runID)
      expect(result.task.status).toBe("completed")
      expect(result.spec).toBe(spec)
      expect(yield* f.llm.inputs).toHaveLength(1)
      const run = (yield* call(() => f.sdk.session.get({ sessionID: started.runID }))).data!
      expect(run.agent).toBe("workflow")
      const children = (yield* call(() => f.sdk.session.children({ sessionID: started.runID }))).data!
      expect(children).toHaveLength(1)
      const messages = (yield* call(() => f.sdk.session.messages({ sessionID: allowedID }))).data!
      const launch = messages.find((message) =>
        message.parts.some((part) => part.type === "tool" && part.tool === "workflow"),
      )!
      expect(launch.info.role).toBe("assistant")
      const user = messages[0]
      expect(user.info.role).toBe("user")
      expect(
        user.parts.some((part) => part.type === "text" && part.text.startsWith("Run workflow Review one file")),
      ).toBe(true)
      expect(user.parts.find((part) => part.type === "text")?.metadata?.[SessionMemory.COMMAND]).toMatchObject({
        source: "command",
      })
      if (launch.info.role !== "assistant") throw new Error("Owner launch did not create an assistant")
      expect(launch.info.parentID).toBe(user.info.id)
      expect(launch.info.tokens).toEqual({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
      expect(launch.parts.find((part) => part.type === "tool" && part.tool === "workflow")).toMatchObject({
        state: { status: "completed", input: { action: "run" } },
      })

      const listed = (yield* call(() => f.client(guest).experimental.workflow.list({ sessionID: allowedID }))).data!
      expect(listed.runs.map((task) => task.id)).toEqual([started.runID])
      for (const headers of [guest, forwarded]) {
        const detail = (yield* call(() =>
          f.client(headers).experimental.workflow.get({ sessionID: allowedID, runID: started.runID }),
        )).data!
        expect(detail.task.id).toBe(started.runID)
        expect(detail).not.toHaveProperty("spec")
      }
      const foreign = (yield* call(() => f.sdk.session.create({ title: "Different parent" }))).data!
      const wrongParent = yield* f.raw(`/experimental/session/${foreign.id}/workflow/${started.runID}`)
      expect(wrongParent.status).toBe(400)
      expect(yield* call(() => wrongParent.json())).toMatchObject({ code: "not_found" })
      expect((yield* f.raw(`/experimental/session/${foreign.id}/workflow`, guest)).status).toBe(403)

      yield* f.llm.text("The workflow completed successfully.", { usage: { input: 15, output: 5 } })
      const reply = (yield* call(() =>
        f.sdk.session.prompt({
          sessionID: allowedID,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "Summarize the workflow result." }],
        }),
      )).data!
      expect(reply.info.role).toBe("assistant")
      if (reply.info.role === "assistant") expect(reply.info.error).toBeUndefined()
      const inputs = yield* f.llm.inputs
      expect(inputs, JSON.stringify(reply)).toHaveLength(2)
      const wire = inputs[1].messages as {
        role: string
        tool_call_id?: string
        tool_calls?: { id: string; function: { name: string } }[]
      }[]
      const index = wire.findIndex((message) => message.tool_calls?.some((tool) => tool.function.name === "workflow"))
      expect(index).toBeGreaterThan(0)
      expect(wire.slice(0, index).some((message) => message.role === "user")).toBe(true)
      expect(wire[index].role).toBe("assistant")
      const id = wire[index].tool_calls!.find((tool) => tool.function.name === "workflow")!.id
      expect(wire.slice(index + 1)).toContainEqual(expect.objectContaining({ role: "tool", tool_call_id: id }))
      expect(wire.at(-1)?.role).toBe("user")
    }),
  30_000,
)

it.live(
  "owner start refuses a busy parent atomically without inserting synthetic history",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const release = Promise.withResolvers<void>()
      yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()))
      yield* f.llm.hold("Ordinary response", release.promise)
      const prompt = yield* call(() =>
        f.sdk.session.prompt({
          sessionID: allowedID,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "Wait for the fixture response." }],
        }),
      ).pipe(Effect.forkChild)
      yield* awaitWithTimeout(f.llm.wait(1), "Parent prompt never reached the model", "10 seconds")
      const response = yield* f.raw(`/experimental/session/${allowedID}/workflow`, owner, { spec })
      expect(response.status).toBe(400)
      expect(yield* call(() => response.json())).toMatchObject({ code: "busy" })
      const messages = (yield* call(() => f.sdk.session.messages({ sessionID: allowedID }))).data!
      expect(
        messages.flatMap((message) => message.parts).some((part) => part.type === "tool" && part.tool === "workflow"),
      ).toBe(false)
      expect((yield* call(() => f.sdk.session.children({ sessionID: allowedID }))).data).toHaveLength(0)
      release.resolve()
      yield* Fiber.join(prompt)
      expect(yield* f.llm.inputs).toHaveLength(1)
    }),
  30_000,
)

it.live(
  "resuming a running workflow refuses before inserting another owner turn",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const release = Promise.withResolvers<void>()
      yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()))
      yield* f.llm.hold("Worker finished", release.promise)
      const started = (yield* call(() =>
        f.sdk.experimental.workflow.start({ sessionID: allowedID, workflowStartInput: { spec } }),
      )).data!
      yield* awaitWithTimeout(f.llm.wait(1), "Workflow worker never reached the model", "10 seconds")
      const before = (yield* call(() => f.sdk.session.messages({ sessionID: allowedID }))).data!
      const response = yield* f.raw(`/experimental/session/${allowedID}/workflow/${started.runID}/resume`, owner, {})
      expect(response.status).toBe(400)
      expect(yield* call(() => response.json())).toMatchObject({ code: "running" })
      expect((yield* call(() => f.sdk.session.messages({ sessionID: allowedID }))).data).toEqual(before)
      release.resolve()
      expect((yield* finished(f.sdk, started.runID)).task.status).toBe("completed")
      expect(yield* f.llm.inputs).toHaveLength(1)
    }),
  30_000,
)

it.live(
  "owner resume reuses required inputs stored by the first run",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      yield* f.llm.text("Checked the original topic.", { usage: { input: 9, output: 4 } })
      const required = JSON.stringify({
        version: 1,
        title: "Required input workflow",
        inputs: { topic: { required: true } },
        defaults: { agent: "explore", model: "lmstudio/test-model" },
        stages: [{ id: "review", prompt: "Review {{inputs.topic}}", on_error: "fail" }],
      })
      const started = (yield* call(() =>
        f.sdk.experimental.workflow.start({
          sessionID: allowedID,
          workflowStartInput: { spec: required, inputs: { topic: "the original topic" } },
        }),
      )).data!
      expect((yield* finished(f.sdk, started.runID)).task.status).toBe("completed")
      const resumed = (yield* call(() =>
        f.sdk.experimental.workflow.resume({
          sessionID: allowedID,
          runID: started.runID,
          workflowResumeInput: {},
        }),
      )).data!
      expect(resumed.runID).toBe(started.runID)
      expect((yield* finished(f.sdk, started.runID)).task.status).toBe("completed")
      // The unchanged completed node is reused. A missing input must neither refuse the preview nor create new work.
      expect(yield* f.llm.inputs).toHaveLength(1)
      expect((yield* call(() => f.sdk.session.children({ sessionID: started.runID }))).data).toHaveLength(1)
      const messages = (yield* call(() => f.sdk.session.messages({ sessionID: allowedID }))).data!
      expect(
        messages
          .flatMap((message) => message.parts)
          .some(
            (part) =>
              part.type === "text" &&
              part.text.startsWith("Resume workflow Required input workflow") &&
              part.text.includes("the original topic"),
          ),
      ).toBe(true)
    }),
  30_000,
)

for (const denied of ["task", "workflow"] as const) {
  it.live(`capability and owner start respect default-agent ${denied} denial`, () =>
    Effect.gen(function* () {
      const f = yield* fixture({ permission: { [denied]: "deny" } })
      expect((yield* call(() => f.sdk.experimental.capabilities.get())).data?.workflows).toBe(false)
      const response = yield* f.raw(`/experimental/session/${allowedID}/workflow`, owner, { spec })
      expect(response.status).toBe(400)
      // 4.9 names a start the owner's settings turn off `disabled`, apart from an authorization refusal.
      expect(yield* call(() => response.json())).toMatchObject({ code: "disabled" })
      expect((yield* call(() => f.sdk.session.messages({ sessionID: allowedID }))).data).toHaveLength(0)
      expect((yield* call(() => f.sdk.session.children({ sessionID: allowedID }))).data).toHaveLength(0)
      expect(yield* f.llm.inputs).toHaveLength(0)
    }),
  )
}

const routing = testEffect(
  Layer.mergeAll(
    NodeHttpServer.layerTest,
    NodeServices.layer,
    workspaceLayerWithRuntimeFlags({ experimentalWorkspaces: true }),
    LayerNode.compile(LayerNode.group([SessionAudience.node, FreeModelGuests.node, PtyTicket.node])),
    layerWebSocketConstructorGlobal,
  ),
)

for (const forwardedGuest of [false, true])
  routing.live(
    `workspace routing rejects ${forwardedGuest ? "forwarded guest" : "guest"} workflow mutations before remote-owner forwarding`,
    () =>
      Effect.gen(function* () {
        const directory = yield* tmpdirScoped({ git: true })
        const lookedUp: string[] = []
        const api = HttpApi.make("workflow-forwarding-probe").add(
          HttpApiGroup.make("workflow")
            .add(
              HttpApiEndpoint.post("start", "/experimental/session/:sessionID/workflow", {
                params: Schema.Struct({ sessionID: SessionID }),
                query: WorkspaceRoutingQuery,
                success: Schema.Boolean,
              }),
              HttpApiEndpoint.post("resume", "/experimental/session/:sessionID/workflow/:runID/resume", {
                params: Schema.Struct({ sessionID: SessionID, runID: SessionID }),
                query: WorkspaceRoutingQuery,
                success: Schema.Boolean,
              }),
            )
            .middleware(WorkspaceRoutingMiddleware),
        )
        yield* HttpApiBuilder.layer(api).pipe(
          Layer.provide(
            HttpApiBuilder.group(api, "workflow", (handlers) =>
              handlers.handle("start", () => Effect.succeed(false)).handle("resume", () => Effect.succeed(false)),
            ),
          ),
          Layer.provide(
            workspaceRoutingLayer.pipe(Layer.provide([layerWebSocketConstructorGlobal, FetchHttpClient.layer])),
          ),
          Layer.provide(
            Layer.mock(Session.Service)({
              get: (id) =>
                Effect.sync(() => {
                  lookedUp.push(id)
                  throw new Error("Guest reached target-session lookup")
                }),
            }),
          ),
          HttpRouter.provideRequest(
            Layer.succeed(
              RequestPrincipal,
              forwardedGuest
                ? { kind: "owner" as const, username: "vector" }
                : {
                    kind: "guest" as const,
                    username: "guest",
                    workspaceIDs: new Set<string>(),
                    workspaceDirectories: new Map<string, string>(),
                    sessionIDs: new Set<string>([allowedID]),
                  },
            ),
          ),
          HttpRouter.serve,
          Layer.build,
          Effect.flatMap(() =>
            Effect.forEach(
              [
                `/experimental/session/${allowedID}/workflow`,
                `/experimental/session/${allowedID}/workflow/ses_run/resume`,
              ],
              (route) =>
                Effect.gen(function* () {
                  const response = yield* HttpClientRequest.post(route).pipe(
                    HttpClientRequest.setHeader("x-vector-directory", directory),
                    HttpClientRequest.setHeader(GUEST_REQUEST_HEADER, forwardedGuest ? "1" : "0"),
                    HttpClient.execute,
                  )
                  expect(response.status, yield* response.text).toBe(403)
                }),
            ),
          ),
          Effect.scoped,
        )
        expect(lookedUp).toEqual([])
      }),
  )

it.live("an invalid owner start returns its structured validation issues", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    const response = yield* f.raw(`/experimental/session/${allowedID}/workflow`, owner, {
      spec: JSON.stringify({ version: 1, title: "Broken", stages: [{ id: "a", prompt: "Review", promt: "typo" }] }),
    })
    expect(response.status).toBe(400)
    const body = (yield* call(() => response.json())) as { code: string; issues?: { path: string; message: string }[] }
    expect(body.code).toBe("invalid")
    expect(body.issues).toContainEqual(expect.objectContaining({ path: "/stages/0/promt" }))
    expect((yield* call(() => f.sdk.session.children({ sessionID: allowedID }))).data).toHaveLength(0)
    expect(yield* f.llm.inputs).toHaveLength(0)
  }),
)
