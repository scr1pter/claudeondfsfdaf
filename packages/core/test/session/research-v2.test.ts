import { afterAll, describe, expect } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { LLMClient, LLMEvent, Model, type LLMClientShape, type LLMRequest } from "@vectordevai/llm"
import { OpenAIChat } from "@vectordevai/llm/protocols/openai-chat"
import type { Permission } from "@vectordevai/schema/permission"
import { asc, eq } from "drizzle-orm"
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { AgentV2 } from "@vectordevai/core/agent"
import { BrainEmbed } from "@vectordevai/core/brain/embed"
import { BrainWorker } from "@vectordevai/core/brain/worker/host"
import { Config } from "@vectordevai/core/config"
import { ConfigAgent } from "@vectordevai/core/config/agent"
import { ConfigAgentPlugin } from "@vectordevai/core/config/plugin/agent"
import { Database } from "@vectordevai/core/database/database"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { makeLocationNode } from "@vectordevai/core/effect/app-node"
import { LayerNodePlatform } from "@vectordevai/core/effect/app-node-platform"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { EventV2 } from "@vectordevai/core/event"
import { EventTable } from "@vectordevai/core/event/sql"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Global } from "@vectordevai/core/global"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { Location } from "@vectordevai/core/location"
import { PermissionV2 } from "@vectordevai/core/permission"
import { AgentPlugin } from "@vectordevai/core/plugin/agent"
import { Project } from "@vectordevai/core/project"
import { ProjectTable } from "@vectordevai/core/project/sql"
import { QuestionV2 } from "@vectordevai/core/question"
import { ReferenceGuidance } from "@vectordevai/core/reference/guidance"
import { ResearchNetwork } from "@vectordevai/core/research/network"
import { ResearchOutbound } from "@vectordevai/core/research/outbound"
import { ResearchPlan } from "@vectordevai/core/research/plan"
import { ResearchProvenance } from "@vectordevai/core/research/provenance"
import { ResearchReader } from "@vectordevai/core/research/reader"
import { ResearchStore } from "@vectordevai/core/research/store"
import { AbsolutePath } from "@vectordevai/core/schema"
import { SessionV2 } from "@vectordevai/core/session"
import { SessionAudience } from "@vectordevai/core/session/audience"
import { SessionExecution } from "@vectordevai/core/session/execution"
import { SessionInput } from "@vectordevai/core/session/input"
import { SessionMessage } from "@vectordevai/core/session/message"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { Prompt } from "@vectordevai/core/session/prompt"
import { SessionRunCoordinator } from "@vectordevai/core/session/run-coordinator"
import { SessionRunner } from "@vectordevai/core/session/runner"
import { SessionRunnerLLM } from "@vectordevai/core/session/runner/llm"
import { SessionRunnerModel } from "@vectordevai/core/session/runner/model"
import { SessionInputTable, SessionMessageTable, SessionTable } from "@vectordevai/core/session/sql"
import { SessionStore } from "@vectordevai/core/session/store"
import { SkillGuidance } from "@vectordevai/core/skill/guidance"
import { Snapshot } from "@vectordevai/core/snapshot"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { SystemContext } from "@vectordevai/core/system-context"
import { SystemContextRegistry } from "@vectordevai/core/system-context/registry"
import { ApplicationTools } from "@vectordevai/core/tool/application-tools"
import { QuestionTool } from "@vectordevai/core/tool/question"
import { ResearchNoteTool } from "@vectordevai/core/tool/research-note"
import { ResearchPlanTool } from "@vectordevai/core/tool/research-plan"
import { ResearchReadTool } from "@vectordevai/core/tool/research-read"
import { ResearchReportTool } from "@vectordevai/core/tool/research-report"
import { ResearchRunV2 } from "@vectordevai/core/tool/research-run"
import { ResearchSearchTool } from "@vectordevai/core/tool/research-search"
import { ToolRegistry } from "@vectordevai/core/tool/registry"
import { Tool } from "@vectordevai/core/tool/tool"
import { WebFetchTool } from "@vectordevai/core/tool/webfetch"
import type { ConfigResearchV1 } from "@vectordevai/core/v1/config/research"
import { FakeWeb } from "../lib/fake-web"
import { NetworkGuard } from "../lib/network-guard"
import { ResearchScript } from "../lib/research-script"
import { testEffect } from "../lib/effect"
import { agentHost, host } from "../plugin/host"

// Deep research on the V2 runner (phase V1R, section 5.1 for V2), against a scripted provider and the fake web, with
// the strict network guard: a prompt names the agent that answers it, durably, so a queued or steered research prompt
// promoted at a later boundary runs under research, and an exact retry must name the same agent. The research agent's
// rules only narrow, its tools are its own, and the scripted research run stores the rows the V1 runner stores.

// A page of the user's intranet, too long to show whole, and a public page that links into the user's network and to a
// cloud metadata address.
const INTRANET = "Internal plan: the Quillfeather rollout keeps account number 773019256 until spring."
const METADATA = "http://169.254.169.254/latest/meta-data/"
const guard = NetworkGuard.use()
const web = FakeWeb.start({
  sites: {
    ...FakeWeb.sites(),
    intranet: {
      "/plan": {
        headers: { "content-type": "text/plain" },
        body: [INTRANET, ...Array.from({ length: 3_000 }, () => "Heat pump rollout notes.")].join("\n"),
      },
    },
    portal: {
      "/": (_request, context) => ({
        headers: { "content-type": "text/html; charset=utf-8" },
        body: [
          "<html><head><title>Heat pump field notes</title></head><body><main><article>",
          "<h1>Heat pump field notes</h1>",
          ...Array.from(
            { length: 6 },
            () =>
              "<p>Air-source heat pumps in cold climates were measured over two winters, and delivered heating energy fell in most homes that were studied.</p>",
          ),
          `<p>See the <a href="${context.direct("docs", "/private/notes")}">team notes</a> and the <a href="${METADATA}">instance details</a>.</p>`,
          "</article></main></body></html>",
        ].join("\n"),
      }),
    },
  },
})
const root = mkdtempSync(path.join(os.tmpdir(), "vector-research-v2-"))
// The desktop app's browser bridge, as the desktop hands it to the engine: its research browsers answer each search
// with the fake web's pages, as a results page would list them, and keep every command they were sent.
const sent: Record<string, unknown>[] = []
const desktop = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    const body = (await request.json()) as Record<string, unknown>
    sent.push(body)
    const results = [
      {
        url: web.url("article", "/"),
        title: "How heat pumps cut heating bills in cold climates",
        snippet: "412 homes.",
      },
      { url: web.url("copy", "/heat-pumps"), title: "How heat pumps cut heating bills (syndicated)", snippet: "" },
      { url: web.url("docs", "/report.pdf"), title: "Heat pump field study (PDF)", snippet: "" },
    ]
    return Response.json(
      body.command === "research.search"
        ? { ok: true, generation: "copy", search: { engine: "google", results, tried: [] } }
        : { ok: true, generation: "copy" },
    )
  },
})
process.env.VECTOR_BROWSER_BRIDGE_URL = `http://127.0.0.1:${desktop.port}`
process.env.VECTOR_BROWSER_BRIDGE_TOKEN = "bridge-token"
// The searches that reached the desktop's research browsers.
const searched = () => sent.filter((body) => body.command === "research.search").length
afterAll(async () => {
  delete process.env.VECTOR_BROWSER_BRIDGE_URL
  delete process.env.VECTOR_BROWSER_BRIDGE_TOKEN
  await desktop.stop(true)
  await web.close()
  rmSync(root, { recursive: true, force: true })
})

// The provider, scripted: each turn takes the next response, and a gated turn waits until its gate opens.
type Turn = {
  readonly events: readonly LLMEvent[]
  readonly gate?: Deferred.Deferred<void>
  readonly started?: Deferred.Deferred<void>
}
const requests: LLMRequest[] = []
const turns: Turn[] = []
const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((request: LLMRequest) => {
      requests.push(request)
      const turn = turns.shift() ?? { events: say("Done.") }
      const events = Stream.fromIterable(turn.events)
      if (!turn.gate) return events
      return Stream.unwrap(
        (turn.started ? Deferred.succeed(turn.started, undefined) : Effect.void).pipe(
          Effect.andThen(Deferred.await(turn.gate)),
          Effect.as(events),
        ),
      )
    }) as unknown as LLMClientShape["stream"],
    generate: () => Effect.die("unused"),
  }),
)

const ids = { call: 0, text: 0 }
function call(name: string, input: Record<string, unknown>): LLMEvent[] {
  const id = `call-${++ids.call}`
  return [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.toolCall({ id, name, input }),
    LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
    LLMEvent.finish({ reason: "tool-calls" }),
  ]
}
function say(text: string): LLMEvent[] {
  const id = `text-${++ids.text}`
  return [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.textStart({ id }),
    LLMEvent.textDelta({ id, text }),
    LLMEvent.textEnd({ id }),
    LLMEvent.stepFinish({ index: 0, reason: "stop" }),
    LLMEvent.finish({ reason: "stop" }),
  ]
}

// The user's own config (a document and a folder of agent files), and a repository's, which a test may set.
const settings: {
  rules: Permission.Ruleset
  research: ConfigResearchV1.Info
  agents?: Record<string, ConfigAgent.Info>
  folder?: Config.Directory
  repository?: Config.Document
} = { rules: [], research: {} }
const own = () =>
  new Config.Document({
    type: "document",
    info: new Config.Info({
      permissions: settings.rules,
      research: settings.research,
      ...(settings.agents ? { agents: settings.agents } : {}),
    }),
  })
const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () =>
      Effect.sync(() => [
        own(),
        ...(settings.folder ? [settings.folder] : []),
        ...(settings.repository ? [settings.repository] : []),
      ]),
    scope: (entry) => (entry === settings.repository ? "project" : "global"),
  }),
)

// Coding and outside tools a research agent must never be offered (a teammate message, an application's tool), and a
// file read whose text is the repository's. webfetch is the real one.
const NOTES = "The Falcon migration moves the ledger to the reconcileLedgerEntries service before release 4417203."
const coding = Layer.effectDiscard(
  ToolRegistry.Service.use((registry) =>
    registry.register(
      Object.fromEntries(
        ["bash", "edit", "read", "send_teammate_message", "mcp_github_create_issue"].map((name) => [
          name,
          Tool.make({
            description: `Fake ${name}`,
            input: Schema.Struct({}),
            output: Schema.Struct({ text: Schema.String }),
            toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
            execute: () => Effect.succeed({ text: name === "read" ? NOTES : `${name} ran` }),
          }),
        ]),
      ),
    ),
  ),
)
const codingNode = makeLocationNode({ name: "test/research-v2-tools", layer: coding, deps: [ToolRegistry.node] })

const model = Model.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })
// $2 per million input tokens and $10 per million output tokens, for a test whose steps must cost something.
const priced = SessionRunnerModel.withPricing(
  Model.make({ id: "priced-model", provider: "fake", route: OpenAIChat.route }),
  [{ input: 2, output: 10, cache: { read: 0, write: 0 } }],
)
const chosen = { model }
const replacements: LayerNode.Replacements = [
  [LayerNodePlatform.llmClient, client],
  [SessionRunnerModel.node, SessionRunnerModel.layerWith(() => Effect.sync(() => chosen.model))],
  [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
  [SkillGuidance.node, Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })],
  [ReferenceGuidance.node, Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })],
  [Snapshot.node, Snapshot.noopLayer],
  [Config.node, config],
  [
    Global.node,
    Global.layerWith({
      home: root,
      data: path.join(root, "data"),
      cache: path.join(root, "cache"),
      config: path.join(root, "config"),
      state: path.join(root, "state"),
      tmp: path.join(root, "tmp"),
    }),
  ],
  [BrainWorker.node, BrainWorker.layerInline],
  [BrainEmbed.node, BrainEmbed.layerOff],
  // The fake web's names resolve to this computer and count as public, as the reader's own tests have them.
  [
    ResearchNetwork.node,
    Layer.succeed(ResearchNetwork.Service, { resolver: web.resolver, publicNames: [FakeWeb.DOMAIN] }),
  ],
]
const runner = AppNodeBuilder.build(SessionRunnerLLM.node, replacements)
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
).pipe(Layer.provide(runner))
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      QuestionV2.node,
      SessionProjector.node,
      SessionStore.node,
      ApplicationTools.node,
      AgentV2.node,
      PermissionV2.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      codingNode,
      WebFetchTool.node,
      QuestionTool.node,
      ResearchPlanTool.node,
      ResearchSearchTool.node,
      ResearchReadTool.node,
      ResearchNoteTool.node,
      ResearchReportTool.node,
      ResearchRunV2.node,
      ResearchStore.node,
      FSUtil.node,
      Location.node,
      SessionRunnerModel.node,
      SystemContextRegistry.node,
      SkillGuidance.node,
      ReferenceGuidance.node,
      Config.node,
      Snapshot.node,
      SessionRunnerLLM.node,
      SessionExecution.node,
      SessionV2.node,
      SpendGuard.node,
    ]),
    [...replacements, [SessionExecution.node, execution]],
  ),
)

const sessionID = SessionV2.ID.make("ses_research_v2")
const RESEARCH = AgentV2.researchID

// A fresh session in the repository, the built-in agents with the user's config rules on top, and a provider with
// nothing scripted yet.
const setup = (input: { readonly rules?: Permission.Ruleset; readonly research?: ConfigResearchV1.Info } = {}) =>
  Effect.gen(function* () {
    settings.rules = input.rules ?? []
    settings.research = input.research ?? {}
    settings.agents = undefined
    settings.folder = undefined
    settings.repository = undefined
    requests.length = 0
    turns.length = 0
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "research",
        directory: "/project",
        title: "research",
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
    const agents = yield* AgentV2.Service
    const location = yield* Location.Service
    yield* AgentPlugin.Plugin.effect(host({ agent: agentHost(agents) })).pipe(
      Effect.provideService(Location.Service, location),
    )
    yield* ConfigAgentPlugin.Plugin.effect(host({ agent: agentHost(agents) })).pipe(
      Effect.provideService(Config.Service, yield* Config.Service),
      Effect.provideService(FSUtil.Service, yield* FSUtil.Service),
    )
  })

// Answers each plan card with the next of `cards` (Start once they run out) and each permission with `reply`, and
// keeps what was asked.
const answering = (input: { readonly cards?: readonly string[]; readonly reply?: PermissionV2.Reply } = {}) =>
  Effect.gen(function* () {
    const question = yield* QuestionV2.Service
    const permission = yield* PermissionV2.Service
    const cards = [...(input.cards ?? [])]
    const asked = { cards: [] as string[], permissions: [] as PermissionV2.Request[] }
    yield* Effect.gen(function* () {
      while (true) {
        for (const request of yield* question.list()) {
          asked.cards.push(request.questions[0]?.question ?? "")
          yield* question
            .reply({ requestID: request.id, answers: [[cards.shift() ?? ResearchPlan.START]] })
            .pipe(Effect.ignore)
        }
        for (const request of yield* permission.list()) {
          asked.permissions.push(request)
          yield* permission.reply({ requestID: request.id, reply: input.reply ?? "once" }).pipe(Effect.ignore)
        }
        yield* Effect.sleep(5)
      }
    }).pipe(Effect.forkScoped)
    return asked
  })

const research = (text: string, extra: Partial<Prompt> = {}) => Prompt.make({ text, agent: RESEARCH, ...extra })
const tools = (request: LLMRequest | undefined) => (request?.tools ?? []).map((tool) => tool.name).toSorted()
const system = (request: LLMRequest | undefined) => (request?.system ?? []).map((part) => part.text).join("\n")
const agentPrompt = Effect.gen(function* () {
  const agents = yield* AgentV2.Service
  return (yield* agents.get(RESEARCH))?.system ?? ""
})

// The completed research tool calls of the session, with what each recorded and the text the model read.
const recorded = (name: string) =>
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    return ResearchRunV2.calls(yield* store.all(sessionID), name)
  })
const plan = (question: string) =>
  call("research_plan", { question, subquestions: ["Which steps keep it online?"], scope: "web", depth: "focused" })

const RESEARCH_TOOLS = [...AgentV2.researchTools].filter((tool) => tool !== "grep" && tool !== "glob").toSorted()

describe("Deep research on the V2 runner", () => {
  it.live("a queued research input promotes under research, and the build turn before it keeps build's tools", () =>
    Effect.gen(function* () {
      yield* setup()
      const session = yield* SessionV2.Service
      const gate = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      turns.push({ events: say("Fixing it."), gate, started }, { events: say("I will plan the research first.") })

      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fix the failing build" }), resume: false })
      const running = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      const queued = yield* session.prompt({
        sessionID,
        prompt: research("Research how much heat pumps save in cold climates."),
        delivery: "queue",
      })
      // Durable before the wake, with its agent.
      expect(queued.prompt.agent).toBe(RESEARCH)
      expect((yield* Database.Service.use(({ db }) => SessionInput.find(db, queued.id)))?.prompt.agent).toBe(RESEARCH)
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(running)

      expect(requests).toHaveLength(2)
      // The build turn: build's tools, none of research's.
      expect(tools(requests[0])).toContain("bash")
      expect(tools(requests[0]).filter((name) => name.startsWith("research_"))).toEqual([])
      // The queued prompt's turn runs under research, with research's system prompt and only its tools.
      expect(system(requests[1])).toContain(yield* agentPrompt)
      expect(tools(requests[1])).toEqual(RESEARCH_TOOLS)
      const messages = yield* session.messages({ sessionID, order: "asc" })
      expect(messages.map((message) => [message.type, "agent" in message ? message.agent : undefined])).toEqual([
        ["user", undefined],
        ["assistant", "build"],
        ["user", RESEARCH],
        ["assistant", RESEARCH],
      ])
      expect(guard.outside()).toEqual([])
    }),
  )

  it.live("a steer promoted at a safe boundary carries its own agent, and the next prompt without one is build's", () =>
    Effect.gen(function* () {
      yield* setup()
      const session = yield* SessionV2.Service
      const gate = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      turns.push(
        { events: call("bash", {}), gate, started },
        { events: say("Switching to the research.") },
        { events: say("Back to the build.") },
      )

      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Run the tests" }), resume: false })
      const running = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* session.prompt({ sessionID, prompt: research("Also research heat pump savings."), resume: false })
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(running)

      // The build turn's tool call settled, then the steer was promoted and the continuation ran under research.
      expect(requests).toHaveLength(2)
      expect(tools(requests[0])).toContain("bash")
      expect(system(requests[1])).toContain(yield* agentPrompt)
      expect(tools(requests[1])).toEqual(RESEARCH_TOOLS)

      // A prompt that names no agent is answered by the session's own, as a V1 message without one is.
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Now fix the build" }), resume: false })
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(3)
      expect(tools(requests[2])).toContain("bash")
      expect(system(requests[2])).not.toContain(yield* agentPrompt)
      const assistants = (yield* session.messages({ sessionID, order: "asc" })).flatMap((message) =>
        message.type === "assistant" ? [message.agent] : [],
      )
      expect(assistants).toEqual(["build", RESEARCH, "build"])
    }),
  )

  it.live("an agent switch after a research prompt wins over it", () =>
    Effect.gen(function* () {
      yield* setup()
      const session = yield* SessionV2.Service
      turns.push({ events: say("Researching.") }, { events: say("Building.") })
      yield* session.prompt({ sessionID, prompt: research("Research heat pumps."), resume: false })
      yield* session.resume(sessionID)
      yield* session.switchAgent({ sessionID, agent: "build" })
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(2)
      expect(tools(requests[0])).toEqual(RESEARCH_TOOLS)
      expect(tools(requests[1])).toContain("bash")
    }),
  )

  it.live("a prompt's agent is in its durable events, so a replayed projection keeps it", () =>
    Effect.gen(function* () {
      yield* setup()
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      turns.push({ events: say("Researching.") })
      const admitted = yield* session.prompt({ sessionID, prompt: research("Research heat pumps."), resume: false })
      yield* session.resume(sessionID)
      const recorded = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)

      yield* events.remove(sessionID)
      yield* db.delete(SessionInputTable).where(eq(SessionInputTable.session_id, sessionID)).run().pipe(Effect.orDie)
      yield* db
        .delete(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* events.replayAll(
        recorded.map((event) => ({
          id: event.id,
          aggregateID: event.aggregate_id,
          seq: event.seq,
          type: event.type,
          data: event.data,
        })),
      )

      expect((yield* SessionInput.find(db, admitted.id))?.prompt.agent).toBe(RESEARCH)
      expect((yield* session.messages({ sessionID, order: "asc" }))[0]).toMatchObject({ type: "user", agent: RESEARCH })
    }),
  )

  it.live(
    "research's default caps hold a run without a cap of the user's own, and an armed budget keeps its place",
    () =>
      Effect.gen(function* () {
        yield* setup({ research: { limits: { focused: { steps: 40 } } } })
        const session = yield* SessionV2.Service
        const spend = yield* SpendGuard.Service
        turns.push({ events: say("Researching.") }, { events: say("Building.") }, { events: say("Researching more.") })

        yield* session.prompt({ sessionID, prompt: research("Research heat pumps."), resume: false })
        yield* session.resume(sessionID)
        // Focused's caps, with the user's own step limit for Focused laid over them.
        expect((yield* spend.snapshot(sessionID))?.budget).toEqual({ usd: ResearchPlan.LIMITS.focused.usd, steps: 40 })

        // A build run takes none of research's caps.
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fix the build" }), resume: false })
        yield* session.resume(sessionID)
        expect((yield* spend.snapshot(sessionID))?.budget).toEqual({})

        // A budget the owner armed for the run is theirs, and research's caps do not replace it.
        yield* spend.arm(sessionID, { usd: 0.25 })
        yield* session.prompt({ sessionID, prompt: research("Keep researching."), resume: false })
        yield* session.resume(sessionID)
        expect((yield* spend.snapshot(sessionID))?.budget).toEqual({ usd: 0.25 })
      }),
  )

  it.live("a cap the owner armed stays theirs in the drain after it stops, whatever research's default caps are", () =>
    Effect.gen(function* () {
      yield* setup()
      const session = yield* SessionV2.Service
      const spend = yield* SpendGuard.Service
      const gate = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      // The build step costs $0.502, more than the owner's $0.25 cap, so the run stops after it.
      const costly = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "costly" }),
        LLMEvent.textDelta({ id: "costly", text: "Fixing it." }),
        LLMEvent.textEnd({ id: "costly" }),
        LLMEvent.stepFinish({
          index: 0,
          reason: "stop",
          usage: { inputTokens: 1_000, nonCachedInputTokens: 1_000, outputTokens: 50_000 },
        }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      turns.push({ events: costly, gate, started }, { events: say("Researching.") })
      chosen.model = priced

      yield* spend.arm(sessionID, { usd: 0.25 })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fix the failing build" }), resume: false })
      const running = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      // A research steer admitted during the stopped turn drains under a fresh run that keeps the stopped run's cap.
      yield* session.prompt({ sessionID, prompt: research("Research heat pump savings."), resume: false })
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(running)
      expect((yield* spend.snapshot(sessionID))?.stopped?.reason).toBe("cap")

      yield* session.resume(sessionID)
      expect(requests).toHaveLength(2)
      expect(tools(requests[1])).toEqual(RESEARCH_TOOLS)
      expect((yield* spend.snapshot(sessionID))?.budget).toEqual({ usd: 0.25 })
    }).pipe(Effect.ensuring(Effect.sync(() => (chosen.model = model)))),
  )

  it.live("a retry of one prompt ID reconciles only with the same agent", () =>
    Effect.gen(function* () {
      yield* setup()
      const session = yield* SessionV2.Service
      const id = SessionMessage.ID.create()
      const text = "Research heat pump savings."
      const first = yield* session.prompt({ id, sessionID, prompt: research(text), resume: false })

      expect(yield* session.prompt({ id, sessionID, prompt: research(text), resume: false })).toEqual(first)
      for (const prompt of [Prompt.make({ text }), Prompt.make({ text, agent: "build" })]) {
        const failure = yield* session.prompt({ id, sessionID, prompt, resume: false }).pipe(Effect.flip)
        expect(failure).toMatchObject({ _tag: "Session.PromptConflictError", sessionID, messageID: id })
      }
      // An admitted prompt without an agent conflicts with a retry that names one.
      const plain = SessionMessage.ID.create()
      yield* session.prompt({ id: plain, sessionID, prompt: Prompt.make({ text }), resume: false })
      const named = yield* session
        .prompt({ id: plain, sessionID, prompt: research(text), resume: false })
        .pipe(Effect.flip)
      expect(named._tag).toBe("Session.PromptConflictError")
      expect((yield* Database.Service.use(({ db }) => SessionInput.find(db, id)))?.prompt.agent).toBe(RESEARCH)
    }),
  )

  it.live(
    "the research agent's rules only narrow: a user's allow reopens no coding tool, and other agents never get research's",
    () =>
      Effect.gen(function* () {
        yield* setup({
          rules: [
            { action: "*", resource: "*", effect: "allow" },
            { action: "bash", resource: "*", effect: "allow" },
            { action: "edit", resource: "*", effect: "allow" },
            { action: "webfetch", resource: "*", effect: "allow" },
            { action: "research_*", resource: "*", effect: "allow" },
          ],
        })
        const agents = yield* AgentV2.Service
        const lead = yield* agents.get(RESEARCH)
        const build = yield* agents.get(AgentV2.defaultID)
        expect(lead).toBeDefined()
        const rules = lead?.permissions ?? []
        for (const action of ["bash", "edit", "write", "apply_patch", "webfetch", "websearch", "todowrite", "skill"])
          expect([action, PermissionV2.evaluate(action, "*", rules).effect]).toEqual([action, "deny"])
        // The run's first page read still asks, a broad allow notwithstanding, and so do secret files.
        expect(PermissionV2.evaluate("research_read", "run", rules).effect).toBe("ask")
        expect(PermissionV2.evaluate("read", "src/app.ts", rules).effect).toBe("allow")
        expect(PermissionV2.evaluate("read", ".env", rules).effect).toBe("ask")
        expect(PermissionV2.evaluate("private_network", "http://10.0.0.2", rules).effect).toBe("ask")
        // A user's allow does reach build, but never the research tools: those are research's alone.
        expect(PermissionV2.evaluate("bash", "*", build?.permissions ?? []).effect).toBe("allow")
        expect(
          PermissionV2.evaluate(
            "research_plan",
            "*",
            build?.permissions ?? [],
            AgentV2.reserved({ id: AgentV2.defaultID, info: build }),
          ).effect,
        ).toBe("deny")

        const session = yield* SessionV2.Service
        turns.push({ events: say("Researching.") }, { events: say("Building.") })
        yield* session.prompt({ sessionID, prompt: research("Research heat pumps."), resume: false })
        yield* session.resume(sessionID)
        yield* session.prompt({
          sessionID,
          prompt: Prompt.make({ text: "Fix the build", agent: "build" }),
          resume: false,
        })
        yield* session.resume(sessionID)
        expect(tools(requests[0])).toEqual(RESEARCH_TOOLS)
        expect(tools(requests[1]).filter((name) => name.startsWith("research_"))).toEqual([])
      }),
  )

  it.live("a deny for one resource offers research no tool but its own: no teammate message, no application tool", () =>
    Effect.gen(function* () {
      // The user's deny is kept as written, so it is the last rule matching every tool; research's own allow-list,
      // a ruleset of its own, still decides what research is offered.
      yield* setup({ rules: [{ action: "*", resource: "*.pem", effect: "deny" }] })
      const session = yield* SessionV2.Service
      turns.push({ events: say("Researching.") }, { events: say("Building.") })
      yield* session.prompt({ sessionID, prompt: research("Research heat pumps."), resume: false })
      yield* session.resume(sessionID)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fix the build" }), resume: false })
      yield* session.resume(sessionID)

      expect(tools(requests[0])).toEqual(RESEARCH_TOOLS)
      // Build keeps both.
      expect(tools(requests[1])).toEqual(expect.arrayContaining(["send_teammate_message", "mcp_github_create_issue"]))
    }),
  )

  it.live(
    "an agent this location lacks answers no prompt, and a research agent config removed is offered no research tool",
    () =>
      Effect.gen(function* () {
        yield* setup()
        const session = yield* SessionV2.Service
        const agents = yield* AgentV2.Service
        turns.push({ events: say("Building.") }, { events: say("Still building.") }, { events: say("No plan.") })
        const research_ = (name: string) => name.startsWith("research_")

        // A prompt that names an agent there is no such agent for is the session's agent's.
        yield* session.prompt({
          sessionID,
          prompt: Prompt.make({ text: "Research heat pumps.", agent: "researcher-typo" }),
          resume: false,
        })
        yield* session.resume(sessionID)
        expect(tools(requests[0])).toContain("bash")
        expect(tools(requests[0]).filter(research_)).toEqual([])

        // Config disabled the research agent: a research prompt is the session's agent's too.
        yield* agents.transform((draft) => draft.remove(RESEARCH))
        yield* session.prompt({ sessionID, prompt: research("Research heat pumps."), resume: false })
        yield* session.resume(sessionID)
        expect(tools(requests[1])).toContain("bash")
        expect(tools(requests[1]).filter(research_)).toEqual([])

        // A session whose own agent is the missing research agent is offered no research tool, so no plan card goes
        // unanswered and approves itself.
        yield* session.switchAgent({ sessionID, agent: RESEARCH })
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Research heat pumps." }), resume: false })
        yield* session.resume(sessionID)
        expect(requests).toHaveLength(3)
        expect(tools(requests[2]).filter(research_)).toEqual([])
        const assistants = (yield* session.messages({ sessionID, order: "asc" })).flatMap((message) =>
          message.type === "assistant" ? [message.agent] : [],
        )
        expect(assistants).toEqual(["build", "build", RESEARCH])
      }),
  )

  it.live("the scripted research run on V2 stores the rows the V1 runner stores", () =>
    Effect.gen(function* () {
      yield* setup()
      const asked = yield* answering()
      const session = yield* SessionV2.Service
      for (const item of ResearchScript.calls(web)) turns.push({ events: call(item.tool, item.input) })
      turns.push({ events: say(ResearchScript.CLOSING) })

      yield* session.prompt({ sessionID, prompt: research(ResearchScript.PROMPT), resume: false })
      yield* session.resume(sessionID)

      const [planned] = yield* recorded("research_plan")
      const runID = planned?.structured.runID
      expect(typeof runID).toBe("string")
      expect(planned?.structured).toMatchObject({ approved: true, answer: "start", plan: { depth: "focused" } })
      const run = yield* ResearchRunV2.Service
      const store = yield* ResearchStore.Service
      const detail = yield* store.get(run.place(), runID as string)
      expect(detail).toBeDefined()
      expect(ResearchScript.rows(detail!, web)).toEqual(
        yield* Effect.promise(() => Bun.file(ResearchScript.FIXTURE).json()),
      )

      // One plan card, and one approval for the run's pages: for this run only, and never saved.
      expect(asked.cards).toHaveLength(1)
      expect(asked.cards[0]).toContain(`Research: ${ResearchScript.QUESTION}`)
      // What this runner does not run yet is said on the card.
      expect(asked.cards[0]).toContain("Deep's researchers and judge are not on this runner yet.")
      expect(asked.cards[0]).toContain(ResearchRunV2.PRIVATE)
      const approvals = asked.permissions.filter((request) => request.action === "research_read")
      expect(approvals).toHaveLength(1)
      expect(approvals[0]).toMatchObject({ resources: [runID], save: [] })
      expect(approvals[0]?.metadata?.description).toBe(ResearchPlan.READ_APPROVAL)
      // Pages come back fenced, the copy points at the page it copies, and the quote that is not in S1 saves nothing.
      const reads = yield* recorded("research_read")
      expect(reads[0]?.text).toContain("untrusted_web_page")
      expect(reads[1]?.text).toContain("is a copy of S1")
      const notes = yield* recorded("research_note")
      expect(notes.map((note) => note.structured.refused === true)).toEqual([false, false, true, false])
      expect(notes[2]?.text).toContain("not in S1")
      expect(notes[3]?.text).toContain("as a paraphrase")
      const [report] = yield* recorded("research_report")
      expect(report?.text).toContain(ResearchReportTool.HELD)
      // Every provider turn of the run was its own request, all under research.
      expect(requests).toHaveLength(ResearchScript.calls(web).length + 1)
      for (const request of requests) expect(tools(request)).toEqual(RESEARCH_TOOLS)
      expect(guard.outside()).toEqual([])
    }),
  )

  it.live("an address no search result, page link or typed message gave is refused, and nothing is fetched", () =>
    Effect.gen(function* () {
      yield* setup()
      yield* answering()
      const session = yield* SessionV2.Service
      const before = web.count("article")
      turns.push(
        {
          events: call("research_plan", {
            question: ResearchScript.QUESTION,
            subquestions: ResearchScript.SUBQUESTIONS,
            scope: "web",
            depth: "focused",
          }),
        },
        { events: call("research_read", { url: web.url("article", "/") }) },
        { events: call("research_read", { url: `${web.url("article", "/")}?ref=badge-4417` }) },
      )
      yield* session.prompt({ sessionID, prompt: research("Research how much heat pumps save."), resume: false })
      yield* session.resume(sessionID)

      const reads = yield* recorded("research_read")
      expect(reads.map((read) => [read.text, read.structured.refused])).toEqual([
        [ResearchProvenance.REFUSAL, "provenance"],
        [ResearchProvenance.REFUSAL, "provenance"],
      ])
      expect(web.count("article") - before).toBe(0)
      expect(guard.outside()).toEqual([])
    }),
  )

  it.live("a search that would send text from a file the session read is refused before it leaves", () =>
    Effect.gen(function* () {
      yield* setup()
      yield* answering()
      const session = yield* SessionV2.Service
      const before = searched()
      turns.push(
        { events: call("read", {}) },
        {
          events: call("research_plan", {
            question: "How do teams migrate a ledger service?",
            subquestions: ["Which steps keep it online?"],
            scope: "web",
            depth: "focused",
          }),
        },
        { events: call("research_search", { query: NOTES }) },
        { events: call("research_search", { query: "ledger service migration without downtime" }) },
      )
      yield* session.prompt({
        sessionID,
        prompt: research("Research how teams migrate a ledger service."),
        resume: false,
      })
      yield* session.resume(sessionID)

      const searches = yield* recorded("research_search")
      expect(searches[0]?.structured.refused).toBe("outbound")
      expect(searches[0]?.text).toBe(ResearchOutbound.REFUSAL)
      expect(searches[1]?.structured.refused).toBeUndefined()
      // Only the public query reached the research browser, and only it counts against the run's budget.
      expect(searched() - before).toBe(1)
      const runID = (yield* recorded("research_plan"))[0]?.structured.runID as string
      const run = yield* ResearchRunV2.Service
      const store = yield* ResearchStore.Service
      const detail = yield* store.get(run.place(), runID)
      expect(detail?.queries).toEqual(["ledger service migration without downtime"])
      expect(guard.outside()).toEqual([])
    }),
  )

  it.live(
    "with Vector Local's Web access None, research is offered no tool that reaches the web and plans the brain",
    () =>
      Effect.gen(function* () {
        yield* setup()
        yield* answering()
        Egress.configure(LocalPolicy.resolve({ global: { enabled: true, web: "none" } }))
        const session = yield* SessionV2.Service
        turns.push(
          {
            events: call("research_plan", {
              question: ResearchScript.QUESTION,
              subquestions: ResearchScript.SUBQUESTIONS,
              scope: "web",
              depth: "focused",
            }),
          },
          { events: say("I will use the repository's files.") },
        )
        yield* session.prompt({ sessionID, prompt: research("Research heat pump savings."), resume: false })
        yield* session.resume(sessionID)

        for (const request of requests) {
          expect(tools(request)).not.toContain("research_search")
          expect(tools(request)).not.toContain("research_read")
          expect(tools(request)).toContain("research_plan")
        }
        const [planned] = yield* recorded("research_plan")
        expect(planned?.structured).toMatchObject({ approved: true, plan: { scope: "brain" } })
        expect(planned?.text).toContain(ResearchPlan.OFFLINE)
      }).pipe(Effect.ensuring(Effect.sync(() => Egress.configure(LocalPolicy.OFF)))),
  )

  it.live(
    "a repository's config from an earlier version naming a search server changes nothing: research searches in its research browser",
    () =>
      Effect.gen(function* () {
        yield* setup()
        // Research had a search setting once; a config file that still holds one loads, and the setting is dropped.
        settings.repository = new Config.Document({
          type: "document",
          info: Schema.decodeUnknownSync(Config.Info)({
            research: { search: { provider: "searxng", url: web.url("old-search", "/") } },
          }),
        })
        yield* answering()
        const session = yield* SessionV2.Service
        const before = searched()
        turns.push(
          {
            events: call("research_plan", {
              question: ResearchScript.QUESTION,
              subquestions: ResearchScript.SUBQUESTIONS,
              scope: "web",
              depth: "focused",
            }),
          },
          { events: call("research_search", { query: "heat pump savings" }) },
        )
        yield* session.prompt({ sessionID, prompt: research("Research heat pump savings."), resume: false })
        yield* session.resume(sessionID)

        const [search] = yield* recorded("research_search")
        expect(search?.structured).toMatchObject({ provider: "browser", engine: "google" })
        expect(search?.structured.refused).toBeUndefined()
        expect(searched() - before).toBe(1)
        expect(web.count("old-search")).toBe(0)
        // The lead's own research browser, by the run and its session, closed again once the search came back.
        expect(sent.slice(-2).map((body) => [body.command, body.sessionID, body.agent])).toEqual([
          ["research.search", sessionID, "research"],
          ["research.close", sessionID, "research"],
        ])
      }),
  )

  it.live("pages webfetch read on the user's own network, and their saved copies read back, stay out of searches", () =>
    Effect.gen(function* () {
      yield* setup()
      const asked = yield* answering()
      const session = yield* SessionV2.Service
      const before = searched()

      // Build fetches an intranet page after the private network ask, too long to show whole, then reads it back.
      turns.push({ events: call("webfetch", { url: web.direct("intranet", "/plan"), format: "text" }) })
      turns.push({ events: say("Fetched.") })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fetch our plan page" }), resume: false })
      yield* session.resume(sessionID)
      const [fetched] = yield* recorded("webfetch")
      expect(fetched?.structured.private).toBe(true)
      expect(fetched?.outputPaths).toHaveLength(1)
      turns.push({ events: call("read", { path: fetched?.outputPaths[0] }) }, { events: say("Read it.") })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Read the saved copy" }), resume: false })
      yield* session.resume(sessionID)

      // Then the user switches to Deep research.
      turns.push(
        { events: plan("How are heat pump rollouts budgeted?") },
        { events: call("research_search", { query: INTRANET }) },
        { events: call("research_search", { query: "heat pump account number 773019256" }) },
        // The saved private page's read-back is private too: this ten-word run is shorter than the work's threshold.
        {
          events: call("research_search", {
            query: "The Falcon migration moves the ledger to the reconcileLedgerEntries",
          }),
        },
        { events: call("research_search", { query: "heat pump rollout budgets" }) },
      )
      yield* session.prompt({
        sessionID,
        prompt: research("Research how heat pump rollouts are budgeted."),
        resume: false,
      })
      yield* session.resume(sessionID)

      const searches = yield* recorded("research_search")
      expect(searches.map((search) => search.structured.refused)).toEqual([
        "outbound",
        "outbound",
        "outbound",
        undefined,
      ])
      expect(searched() - before).toBe(1)
      expect(
        asked.permissions.filter(
          (request) => request.action === "private_network" && request.resources[0] === web.origin,
        ),
      ).toHaveLength(1)
      expect(guard.outside()).toEqual([])
    }),
  )

  it.live("the user's own agent prompts are private facts, and a repository's are the work", () =>
    Effect.gen(function* () {
      yield* setup()
      const folder = path.join(root, "own-config")
      mkdirSync(path.join(folder, "agents"), { recursive: true })
      writeFileSync(
        path.join(folder, "agents", "helper.md"),
        "---\ndescription: Drafts replies\n---\nYou draft customer replies for Marigold Logistics in a calm voice.\n",
      )
      settings.folder = new Config.Directory({ type: "directory", path: AbsolutePath.make(folder) })
      settings.agents = {
        reviewer: new ConfigAgent.Info({
          system: "You review pull requests for Brightwater Analytics before release.",
        }),
      }
      settings.repository = new Config.Document({
        type: "document",
        info: new Config.Info({
          agents: { triage: new ConfigAgent.Info({ system: "Label issues for the Corvid team." }) },
        }),
      })
      yield* answering()
      const session = yield* SessionV2.Service
      const before = searched()
      turns.push(
        { events: plan("How do heat pumps perform in cold climates?") },
        {
          events: call("research_search", {
            query: "You review pull requests for Brightwater Analytics before release",
          }),
        },
        {
          events: call("research_search", {
            query: "You draft customer replies for Marigold Logistics in a calm voice",
          }),
        },
        { events: call("research_search", { query: "Corvid heat pump study" }) },
      )
      yield* session.prompt({ sessionID, prompt: research("Research heat pumps in cold climates."), resume: false })
      yield* session.resume(sessionID)

      const searches = yield* recorded("research_search")
      expect(searches.map((search) => search.structured.refused)).toEqual(["outbound", "outbound", undefined])
      expect(searched() - before).toBe(1)
    }),
  )

  it.live(
    "a prompt's words clear nothing for searches, and its addresses are read as links: the user's own network is refused",
    () =>
      Effect.gen(function* () {
        yield* setup()
        const asked = yield* answering()
        const session = yield* SessionV2.Service
        const before = { searched: searched(), notes: web.count("docs", "/private/notes") }
        const intranet = web.direct("docs", "/private/notes")
        turns.push(
          { events: call("read", {}) },
          { events: plan("How do teams migrate a ledger service?") },
          // The prompt quotes the file too, but a V2 prompt may be another agent's, so it clears nothing.
          { events: call("research_search", { query: NOTES }) },
          { events: call("research_read", { url: web.url("article", "/") }) },
          { events: call("research_read", { url: intranet }) },
        )
        yield* session.prompt({
          sessionID,
          prompt: research(
            `Research ledger migrations. ${NOTES} Start from ${web.url("article", "/")} and ${intranet}`,
          ),
          resume: false,
        })
        yield* session.resume(sessionID)

        const [search] = yield* recorded("research_search")
        expect(search?.structured.refused).toBe("outbound")
        expect(searched() - before.searched).toBe(0)
        // The public address in the prompt is read; the one on the user's own network is refused without asking.
        const reads = yield* recorded("research_read")
        expect(reads.map((read) => [read.input.url, read.structured.status])).toEqual([
          [web.url("article", "/"), "read"],
          [intranet, "failed"],
        ])
        expect(reads[1]?.text).toContain(ResearchRunV2.PRIVATE)
        expect(web.count("docs", "/private/notes") - before.notes).toBe(0)
        expect(asked.permissions.filter((request) => request.action === "private_network")).toEqual([])
        expect(guard.outside()).toEqual([])
      }),
  )

  it.live("a public page's links into the user's network or to a cloud metadata address are refused", () =>
    Effect.gen(function* () {
      yield* setup()
      const asked = yield* answering()
      const session = yield* SessionV2.Service
      const before = web.count("docs", "/private/notes")
      const portal = web.url("portal", "/")
      const intranet = web.direct("docs", "/private/notes")
      turns.push(
        { events: plan("How do heat pumps perform in cold climates?") },
        { events: call("research_read", { url: portal, links: true }) },
        { events: call("research_read", { url: intranet }) },
        { events: call("research_read", { url: METADATA }) },
      )
      yield* session.prompt({ sessionID, prompt: research(`Research the field notes at ${portal}`), resume: false })
      yield* session.resume(sessionID)

      const reads = yield* recorded("research_read")
      expect(reads[0]?.structured.links).toEqual(expect.arrayContaining([intranet, METADATA]))
      expect(reads.slice(1).map((read) => [read.input.url, read.structured.status])).toEqual([
        [intranet, "failed"],
        [METADATA, "failed"],
      ])
      expect(reads[1]?.text).toContain(ResearchRunV2.PRIVATE)
      expect(reads[2]?.text).toContain(ResearchReader.METADATA)
      expect(web.count("docs", "/private/notes") - before).toBe(0)
      expect(asked.permissions.filter((request) => request.action === "private_network")).toEqual([])
      expect(guard.outside()).toEqual([])
    }),
  )

  it.live("a private source the run saved stays private context when it is read again", () =>
    Effect.gen(function* () {
      yield* setup()
      yield* answering()
      const session = yield* SessionV2.Service
      const before = searched()
      const gate = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      turns.push(
        { events: plan("How are heat pump pilots budgeted?") },
        { events: call("research_read", { source: "S1" }), gate, started },
        {
          events: call("research_search", { query: "The Kestrelmoor pilot keeps its budget until the spring review" }),
        },
        { events: call("research_search", { query: "heat pump pilot budget" }) },
      )
      yield* session.prompt({ sessionID, prompt: research("Research heat pump pilot budgets."), resume: false })
      const running = yield* session.resume(sessionID).pipe(Effect.forkChild)
      // Once the plan is approved, the run holds a page read on the user's own network, as a typed address on the V1
      // runner saves one.
      yield* Deferred.await(started)
      const runID = (yield* recorded("research_plan"))[0]?.structured.runID as string
      const run = yield* ResearchRunV2.Service
      const store = yield* ResearchStore.Service
      const url = "http://wiki.corp.internal/pilot"
      yield* store.addSource(run.place(), runID, {
        url,
        canonical: url,
        site: "wiki.corp.internal",
        title: "Pilot plan",
        status: "read",
        chunks: [{ text: "The Kestrelmoor pilot keeps its budget until the spring review.", chunk: 0 }],
        private: true,
      })
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(running)

      const [again] = yield* recorded("research_read")
      expect(again?.structured).toMatchObject({ source: "S1", private: true })
      const searches = yield* recorded("research_search")
      expect(searches.map((search) => search.structured.refused)).toEqual(["outbound", undefined])
      expect(searched() - before).toBe(1)
    }),
  )
})
