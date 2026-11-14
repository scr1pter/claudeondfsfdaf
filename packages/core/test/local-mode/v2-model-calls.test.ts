import * as OpenAIChat from "@vectordevai/llm/protocols/openai-chat"
import { Auth } from "@vectordevai/llm/route"
import { Database } from "@vectordevai/core/database/database"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { EventV2 } from "@vectordevai/core/event"
import { PermissionV2 } from "@vectordevai/core/permission"
import { AgentV2 } from "@vectordevai/core/agent"
import { Config } from "@vectordevai/core/config"
import { Project } from "@vectordevai/core/project"
import { ProjectTable } from "@vectordevai/core/project/sql"
import { AbsolutePath } from "@vectordevai/core/schema"
import { SessionV2 } from "@vectordevai/core/session"
import { SessionAudience } from "@vectordevai/core/session/audience"
import { Snapshot } from "@vectordevai/core/snapshot"
import { Prompt } from "@vectordevai/core/session/prompt"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { SessionExecution } from "@vectordevai/core/session/execution"
import { SessionRunCoordinator } from "@vectordevai/core/session/run-coordinator"
import { SessionRunner } from "@vectordevai/core/session/runner"
import * as SessionRunnerLLM from "@vectordevai/core/session/runner/llm"
import { SessionRunnerModel } from "@vectordevai/core/session/runner/model"
import { ToolRegistry } from "@vectordevai/core/tool/registry"
import { ToolOutputStore } from "@vectordevai/core/tool-output-store"
import { SessionTable } from "@vectordevai/core/session/sql"
import { SessionStore } from "@vectordevai/core/session/store"
import { Location } from "@vectordevai/core/location"
import { SystemContextRegistry } from "@vectordevai/core/system-context/registry"
import { SystemContext } from "@vectordevai/core/system-context"
import { SkillGuidance } from "@vectordevai/core/skill/guidance"
import { ReferenceGuidance } from "@vectordevai/core/reference/guidance"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { LocalProbe } from "@vectordevai/core/local-mode/probe"
import { afterAll, afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import path from "node:path"
import { testEffect } from "../lib/effect"
import { NetworkGuard } from "../lib/network-guard"

// A V2 runner turn under Vector Local, with nothing leaving this computer: the request executor the platform builds
// (LayerNodePlatform.requestExecutor, which the native runtime shares) decides every model call before it is sent. The
// model server is a fake on 127.0.0.1 that answers with a recorded OpenAI chat stream.

const guard = NetworkGuard.use()

afterEach(async () => {
  Egress.configure(LocalPolicy.OFF)
  await Egress.erase()
})

const recording = await Bun.file(
  path.resolve(import.meta.dir, "../fixtures/recordings/session-runner/openai-chat-streams-text.json"),
).json()
const chats: string[] = []
const stream = () =>
  new Response(recording.interactions[0].response.body, {
    headers: { "content-type": "text/event-stream; charset=utf-8", connection: "close" },
  })
// Where a redirect from the model server would send a prompt, if Vector followed it.
const elsewhere = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => {
    chats.push(`elsewhere ${new URL(request.url).pathname}`)
    return stream()
  },
})
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    const url = new URL(request.url)
    // What a generic OpenAI-compatible server says about itself, which the identity check reads.
    if (request.method === "GET")
      return url.pathname === "/v1/models"
        ? Response.json({ object: "list", data: [{ id: "gpt-4o-mini" }] })
        : new Response("Not found", { status: 404 })
    chats.push(url.pathname)
    if (url.pathname.startsWith("/moved/"))
      return new Response(null, {
        status: 307,
        headers: { location: `http://127.0.0.1:${elsewhere.port}/v1/chat/completions` },
      })
    return stream()
  },
})
const origin = `http://127.0.0.1:${server.port}`
afterAll(() => {
  server.stop(true)
  elsewhere.stop(true)
})

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    deniedResources: () => Effect.succeed([]),
    assert: () => Effect.die("unused"),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const at = (baseURL: string) =>
  OpenAIChat.route
    .with({ endpoint: { baseURL }, auth: Auth.bearer("fixture"), generation: { maxTokens: 20, temperature: 0 } })
    .model({ id: "gpt-4o-mini" })
// The model a turn runs on: the server's own address, unless a test moves it.
const current = { model: at(`${origin}/v1`) }
const models = SessionRunnerModel.layerWith(() => Effect.succeed(current.model))
const systemContext = AppNodeBuilder.build(SystemContextRegistry.node)
const skillGuidance = Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const referenceGuidance = Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const config = Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))
const runnerLayer = AppNodeBuilder.build(SessionRunnerLLM.node, [
  [Snapshot.node, Snapshot.noopLayer],
  [SessionRunnerModel.node, models],
  [SystemContextRegistry.node, systemContext],
  [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
  [SkillGuidance.node, skillGuidance],
  [ReferenceGuidance.node, referenceGuidance],
  [Config.node, config],
  [PermissionV2.node, permission],
  [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
])
const execution = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const sessionRunner = yield* SessionRunner.Service
    const coordinator = yield* SessionRunCoordinator.make<SessionV2.ID, SessionRunner.RunError>({
      drain: (sessionID, force) => sessionRunner.run({ sessionID, force }),
    })
    return SessionExecution.Service.of({
      resumeFreeModels: () => Effect.die("Free-model retry is outside this fixture"),
      active: coordinator.active,
      resume: coordinator.run,
      wake: coordinator.wake,
      interrupt: coordinator.interrupt,
    })
  }),
).pipe(Layer.provide(runnerLayer))
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      AgentV2.node,
      ToolRegistry.node,
      SessionRunnerModel.node,
      SystemContextRegistry.node,
      SkillGuidance.node,
      ReferenceGuidance.node,
      Config.node,
      Snapshot.node,
      SessionRunnerLLM.node,
      SessionV2.node,
      LocalProbe.holdsNode,
    ]),
    [
      [PermissionV2.node, permission],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      [SessionRunnerModel.node, models],
      [SystemContextRegistry.node, systemContext],
      [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
      [SkillGuidance.node, skillGuidance],
      [ReferenceGuidance.node, referenceGuidance],
      [Config.node, config],
      [Snapshot.node, Snapshot.noopLayer],
      [SessionExecution.node, execution],
    ],
  ),
)

const turn = Effect.fn("test.turn")(function* (id: string) {
  const db = (yield* Database.Service).db
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  const sessionID = SessionV2.ID.make(id)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: id,
      directory: "/project",
      title: "test",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  const stored = yield* db
    .select({ parentID: SessionTable.parent_id })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
    .pipe(Effect.orDie)
  if (!stored) return yield* Effect.die("Fixture Session was not inserted")
  const audience = SessionAudience.make({ db })
  if (stored.parentID && !(yield* audience.knows(stored.parentID)))
    return yield* Effect.die("Fixture Session parent was not registered")
  yield* audience.register({ sessionID, parentID: stored.parentID ?? undefined, actor: "owner" }).pipe(Effect.orDie)
  const session = yield* SessionV2.Service
  yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Say hello in one short sentence." }), resume: false })
  yield* session.resume(sessionID).pipe(Effect.ignore)
  return yield* session.context(sessionID)
})

describe("a V2 runner turn under Vector Local", () => {
  it.effect("decides each model call as one to the listed server, and follows no redirect", () =>
    Effect.gen(function* () {
      chats.length = 0
      Egress.configure(LocalPolicy.resolve({ global: { enabled: true, endpoints: [origin] } }))
      const messages = yield* turn("ses_v2_local")
      expect(messages[1]).toMatchObject({ type: "assistant", finish: "stop" })
      const calls = Egress.events().filter((event) => event.purpose === "inference")
      expect(chats.length).toBeGreaterThan(0)
      expect(calls).toHaveLength(chats.length)
      for (const call of calls)
        expect(call).toMatchObject({ source: "local-inference", origin, class: "listed", decision: "allow" })

      // A server that answers a model call with a redirect gets the call, and the prompt goes nowhere else.
      chats.length = 0
      current.model = at(`${origin}/moved/v1`)
      const moved = yield* turn("ses_v2_redirect").pipe(
        Effect.ensuring(Effect.sync(() => (current.model = at(`${origin}/v1`)))),
      )
      expect(moved.some((message) => message.type === "assistant" && message.finish === "stop")).toBe(false)
      expect(chats.length).toBeGreaterThan(0)
      expect(chats.every((path) => path === "/moved/v1/chat/completions")).toBe(true)
      expect(guard.outside()).toEqual([])
    }),
  )

  it.effect("checks a listed server against its pin before the first model call, and holds one that changed", () =>
    Effect.gen(function* () {
      chats.length = 0
      // The server was added as a vLLM server; a generic OpenAI-compatible one answers on its port now.
      Egress.configure(
        LocalPolicy.resolve({
          global: { enabled: true, endpoints: [origin], pins: { [origin]: { kind: "vllm", version: "0.11.0" } } },
        }),
      )
      const holds = yield* LocalProbe.HoldsService
      const messages = yield* turn("ses_v2_pinned")
      const held = holds.held(origin)
      holds.confirm(origin)
      expect(messages.some((message) => message.type === "assistant" && message.finish === "stop")).toBe(false)
      expect(chats).toEqual([])
      expect(held).toBe(LocalProbe.changedMessage(origin))
      expect(Egress.events().filter((event) => event.purpose === "inference")).toEqual([])
      expect(guard.outside()).toEqual([])
    }),
  )

  it.effect("sends nothing to a server whose identity changed until the user confirms it", () =>
    Effect.gen(function* () {
      chats.length = 0
      Egress.configure(LocalPolicy.resolve({ global: { enabled: true, endpoints: [origin] } }))
      const holds = yield* LocalProbe.HoldsService
      holds.hold(origin, LocalProbe.changedMessage(origin))
      const messages = yield* turn("ses_v2_held")
      expect(messages.some((message) => message.type === "assistant" && message.finish === "stop")).toBe(false)
      expect(chats).toEqual([])
      expect(Egress.events().filter((event) => event.purpose === "inference")).toEqual([])
      holds.confirm(origin)
      expect(guard.outside()).toEqual([])
    }),
  )

  it.effect("decides and logs nothing with Vector Local off", () =>
    Effect.gen(function* () {
      chats.length = 0
      const messages = yield* turn("ses_v2_off")
      expect(messages[1]).toMatchObject({ type: "assistant", finish: "stop" })
      expect(chats.length).toBeGreaterThan(0)
      expect(Egress.events()).toEqual([])
    }),
  )
})
