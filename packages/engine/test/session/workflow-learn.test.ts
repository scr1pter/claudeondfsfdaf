import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainDatabase } from "@vectordevai/core/brain/database"
import { BrainWorkflow } from "@vectordevai/core/brain/workflow"
import { ChildEnvironment } from "@vectordevai/core/child-environment"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import type { TaskSize } from "@vectordevai/core/task-size"
import type { SessionV1 } from "@vectordevai/core/v1/session"
import { Agent } from "../../src/agent/agent"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionTaskSize } from "../../src/session/task-size"
import { SessionWorkflow } from "../../src/session/workflow"
import { reply, TestLLMServer } from "../lib/llm-server"
import { chat, engine, providerConfig, ref, send, settle, setup } from "./learning-fixture"

// Self-tuned workflows in the session runtime (section 6), end to end against the fake LLM server: a build request's
// run is recorded once it is over, numbers only, its children's tokens included and a cost that is not priced left
// unknown; where the repository's runs earned it and nobody chose for Vector, Thorough work goes at the model's default
// effort, recorded on the assistant message with its reason, the same on every step and kept while the cache is warm.
// Anything the user, the agent or config chose, a guest, --pure, observe mode and `sizing.learn: false` stop it.

const it = engine()
const pure = engine({ pure: true })

type Row = Record<string, unknown>

const rows = Effect.fn("test.rows")(function* (repository: string) {
  const db = (yield* BrainDatabase.Service).db
  return yield* db.all<Row>(sql`SELECT * FROM brain_workflow_run WHERE repository_id = ${repository} ORDER BY id`)
})

const lastMessage = (body: Record<string, unknown>) => (Array.isArray(body.messages) ? body.messages.at(-1) : undefined)

const assistants = Effect.fn("test.assistants")(function* (sessionID: Session.Info["id"]) {
  return (yield* (yield* Session.Service).messages({ sessionID })).flatMap((message) =>
    message.info.role === "assistant" ? [message.info] : [],
  )
})

// Runs that earn the learned default: Thorough work here passed as often at default effort for far fewer tokens. It
// takes 30 checked runs a side for the pass rate's lower bound to clear the margin when every run passed.
const earned = Effect.fn("test.earned")(function* (place: Brain.Place) {
  const workflow = yield* BrainWorkflow.Service
  const run = (index: number, effort: string, tokens: number) =>
    workflow.record(place, {
      sessionID: "ses_earlier",
      requestID: `msg_${effort}_${index}`,
      at: Date.now() - index * 1000,
      tier: "thorough",
      effortTier: "thorough",
      agent: "build",
      providerID: ref.providerID,
      modelID: ref.modelID,
      effort,
      effortSource: "size",
      subagents: 0,
      subagentModels: {},
      judgeRounds: 0,
      outcome: "pass",
      signal: "recovered",
      costKinds: { local: 4 },
      steps: 4,
      unpricedSteps: 0,
      tokens: { input: tokens, output: tokens / 10, reasoning: 0, cacheRead: 0 },
      partial: false,
    })
  for (const index of Array.from({ length: 30 }, (_, at) => at + 1)) {
    yield* run(index, "default", 10_000)
    yield* run(index, "high", 40_000)
  }
})

it.instance(
  "a build request's run is recorded: its size, effort, subagents and children's tokens, and a local model's cost stays unknown",
  () =>
    Effect.gen(function* () {
      const { place } = yield* setup()
      const llm = yield* TestLLMServer
      yield* llm.tool("escalate", { reason: "A refactor across the whole parser" })
      yield* llm.tool("task", {
        description: "Split the lexer",
        prompt: "Move the lexer into src/lexer.ts and keep its tests passing.",
        subagent_type: "general",
        background: false,
      })
      yield* llm.text("Moved the lexer.", { usage: { input: 700, output: 70 } })
      yield* llm.text("Refactored the parser.", { usage: { input: 300, output: 30 } })
      yield* send(yield* chat(), "Refactor the parser module into smaller files")
      yield* settle()
      const [row] = yield* rows(place.repository)
      expect(row).toMatchObject({
        tier: "thorough",
        effort_tier: "thorough",
        agent: "build",
        provider_id: "lmstudio",
        model_id: "test-model",
        effort: "high",
        effort_source: "size",
        subagents: 1,
        subagent_model: "parent",
        judge_rounds: 0,
        outcome: "none",
        cost_usd: null,
        partial: 0,
        runs: 1,
      })
      expect(JSON.parse(row!.subagent_models as string)).toEqual({ "lmstudio/test-model": 1 })
      // The child's tokens count toward the run.
      expect(row!.tokens_input).toBeGreaterThanOrEqual(1000)
      expect(row!.tokens_output).toBeGreaterThanOrEqual(100)
      expect(Object.keys(JSON.parse(row!.cost_kinds as string))).toEqual(["local"])
    }),
  { git: true },
  90_000,
)

it.instance(
  "only general subagents say where general subagents run: explore launches record no subagent model",
  () =>
    Effect.gen(function* () {
      const { place } = yield* setup()
      const llm = yield* TestLLMServer
      const explore = {
        description: "Find the lexer",
        prompt: "Find where the lexer lives.",
        subagent_type: "explore",
        background: false,
      }
      // Explore alone, which task.ts runs on the small model whenever that is cheaper.
      yield* llm.tool("escalate", { reason: "A refactor across the whole parser" })
      yield* llm.tool("task", explore)
      yield* llm.text("The lexer is in src/parser.ts.")
      yield* llm.text("Found the lexer.")
      yield* send(yield* chat(), "Refactor the parser module into smaller files")
      yield* settle()
      // Explore, then a general subagent on the parent's model.
      yield* llm.tool("escalate", { reason: "A refactor across the whole parser" })
      yield* llm.tool("task", explore)
      yield* llm.text("The lexer is in src/parser.ts.")
      yield* llm.tool("task", {
        description: "Split the lexer",
        prompt: "Move the lexer into src/lexer.ts.",
        subagent_type: "general",
        background: false,
      })
      yield* llm.text("Moved the lexer.")
      yield* llm.text("Refactored the parser.")
      yield* send(yield* chat(), "Refactor the parser module into smaller files")
      yield* settle()
      const [explored, mixed] = yield* rows(place.repository)
      expect(explored).toMatchObject({ subagents: 1, subagent_model: null })
      expect(JSON.parse(explored!.subagent_models as string)).toEqual({})
      expect(mixed).toMatchObject({ subagents: 2, subagent_model: "parent" })
      expect(JSON.parse(mixed!.subagent_models as string)).toEqual({ "lmstudio/test-model": 1 })
    }),
  { git: true },
  120_000,
)

it.instance(
  "a Vector an agent started records no run: its prompts are that agent's, not the owner's",
  () =>
    Effect.gen(function* () {
      const { place } = yield* setup()
      const llm = yield* TestLLMServer
      const marker = process.env[ChildEnvironment.AGENT_MARKER]
      process.env[ChildEnvironment.AGENT_MARKER] = "ses_outer"
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (marker === undefined) delete process.env[ChildEnvironment.AGENT_MARKER]
          else process.env[ChildEnvironment.AGENT_MARKER] = marker
        }),
      )
      yield* llm.tool("escalate", { reason: "A refactor across the whole parser" })
      yield* llm.text("Refactored the parser.")
      yield* send(yield* chat(), "Refactor the parser module into smaller files")
      yield* settle()
      expect(yield* rows(place.repository)).toEqual([])
    }),
  { git: true },
  90_000,
)

it.instance(
  "a priced run's cost is known, and a background subagent still running marks the run partial",
  () =>
    Effect.gen(function* () {
      const { place } = yield* setup({ model: { cost: { input: 3, output: 15 } } })
      const llm = yield* TestLLMServer
      const sessionID = yield* chat()
      // Every step reports its usage: a step without counters is incomplete, and leaves the run's cost unknown.
      yield* llm.push(
        reply().tool("escalate", { reason: "A refactor across the whole parser" }).usage({ input: 800, output: 40 }),
      )
      yield* llm.push(
        reply()
          .tool("task", {
            description: "Split the lexer",
            prompt: "Move the lexer into src/lexer.ts.",
            subagent_type: "general",
            background: true,
          })
          .usage({ input: 900, output: 60 }),
      )
      // The subagent's request, whose last message is its brief, never ends; the parent's answer does.
      yield* llm.pushMatch((hit) => JSON.stringify(lastMessage(hit.body)).includes("Move the lexer"), reply().hang())
      yield* llm.text("Started the lexer split in the background.", { usage: { input: 1000, output: 100 } })
      yield* send(sessionID, "Refactor the parser module into smaller files")
      yield* settle()
      const [row] = yield* rows(place.repository)
      yield* (yield* SessionPrompt.Service).cancel(sessionID)
      expect(row?.partial).toBe(1)
      expect(row?.cost_usd).toBeGreaterThan(0)
      expect(Object.keys(JSON.parse(row!.cost_kinds as string))).toEqual(["priced"])
    }),
  { git: true },
  90_000,
)

it.instance(
  "a learned default drops Thorough's high effort, the same on every step, recorded with its reason; caps unchanged",
  () =>
    Effect.gen(function* () {
      const { place } = yield* setup({ model: { cost: { input: 0, output: 0, cache_read: 0.1 } } })
      const llm = yield* TestLLMServer
      yield* earned(place)
      const sessionID = yield* chat()
      yield* llm.tool("escalate", { reason: "A refactor across the whole parser" })
      yield* llm.tool("glob", { pattern: "src/**/*.ts" })
      yield* llm.text("Refactored the parser.")
      yield* send(sessionID, "Refactor the parser module into smaller files", { budget: { usd: 5, steps: 50 } })
      yield* settle()
      const [standard, ...thorough] = yield* assistants(sessionID)
      // Standard work has no cheaper effort to learn.
      expect(standard?.workflow).toBeUndefined()
      expect(thorough.map((info) => info.size)).toEqual(["thorough", "thorough"])
      expect(thorough[0]?.workflow).toMatchObject({ effort: "default", source: "learned" })
      expect(thorough[0]?.workflow?.reason).toContain(
        "Thorough work here passed 30 of 30 checked runs at default effort",
      )
      expect(thorough[1]?.workflow).toEqual(thorough[0]!.workflow!)
      // The user's own pick stays theirs: they made none.
      expect(thorough.map((info) => info.variant)).toEqual([undefined, undefined])
      const recorded = (yield* rows(place.repository)).find((row) => row.session_id === sessionID)
      expect(recorded).toMatchObject({ effort: "default", effort_source: "learned" })
      expect(JSON.parse(recorded!.advice as string)).toMatchObject({ effort: "default", source: "learned" })
      expect((yield* (yield* SpendGuard.Service).snapshot(sessionID))?.budget).toMatchObject({ usd: 5, steps: 50 })

      // The runs that earned it are gone, but the cache is warm: the next request keeps the effort it ran at.
      yield* (yield* BrainWorkflow.Service).reset(place)
      yield* llm.text("Carried on.")
      yield* send(sessionID, "continue")
      const next = (yield* assistants(sessionID)).at(-1)
      expect(next?.size).toBe("thorough")
      expect(next?.workflow?.effort).toBe("default")
    }),
  { git: true },
  90_000,
)

it.instance(
  "general subagents take the provider's cheaper small model where the runs here earned it",
  () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const provider = providerConfig(llm.url, { cost: { input: 3, output: 15 } }).provider!.lmstudio!
      const parent = provider.models!["test-model"]!
      const { place } = yield* setup({
        config: {
          small_model: "lmstudio/small-model",
          provider: {
            lmstudio: {
              ...provider,
              models: {
                ...provider.models,
                "small-model": { ...parent, id: "small-model", cost: { input: 1, output: 5 } },
              },
            },
          },
        },
      })
      const workflow = yield* BrainWorkflow.Service
      for (const index of Array.from({ length: 30 }, (_, at) => at + 1))
        for (const [model, cost] of [
          ["small", 0.2],
          ["parent", 1],
        ] as const)
          yield* workflow.record(place, {
            sessionID: "ses_earlier",
            requestID: `msg_${model}_${index}`,
            at: Date.now() - index * 1000,
            tier: "thorough",
            effortTier: "thorough",
            agent: "build",
            providerID: ref.providerID,
            modelID: ref.modelID,
            effort: "high",
            effortSource: "size",
            subagents: 1,
            subagentModel: model,
            subagentModels: { [`lmstudio/${model === "small" ? "small-model" : "test-model"}`]: 1 },
            judgeRounds: 0,
            outcome: "pass",
            signal: "recovered",
            costUsd: cost,
            costKinds: { priced: 4 },
            steps: 4,
            unpricedSteps: 0,
            tokens: { input: 1000, output: 100, reasoning: 0, cacheRead: 0 },
            partial: false,
          })
      const sessionID = yield* chat()
      yield* llm.tool("escalate", { reason: "A refactor across the whole parser" })
      yield* llm.tool("task", {
        description: "Split the lexer",
        prompt: "Move the lexer into src/lexer.ts.",
        subagent_type: "general",
        background: false,
      })
      yield* llm.text("Moved the lexer.")
      yield* llm.text("Refactored the parser.")
      yield* send(sessionID, "Refactor the parser module into smaller files")
      const thorough = (yield* assistants(sessionID)).filter((info) => info.size === "thorough")
      expect(thorough[0]?.workflow).toMatchObject({ subagentModel: "small", source: "learned" })
      expect(thorough[0]?.workflow?.effort).toBeUndefined()
      const models = (yield* llm.hits).map((hit) => hit.body.model)
      expect(models).toContain("small-model")
      expect(models.filter((model) => model === "small-model")).toHaveLength(1)
    }),
  { git: true },
  90_000,
)

// 5.E.1: a model the brief names is the agent's pick, not where general subagents run by default.
it.instance(
  "a general subagent on a model its brief named teaches no subagent model",
  () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const provider = providerConfig(llm.url, { cost: { input: 3, output: 15 } }).provider!.lmstudio!
      const parent = provider.models!["test-model"]!
      const { place } = yield* setup({
        config: {
          small_model: "lmstudio/small-model",
          provider: {
            lmstudio: {
              ...provider,
              models: {
                ...provider.models,
                "small-model": { ...parent, id: "small-model", cost: { input: 1, output: 5 } },
              },
            },
          },
        },
      })
      const sessionID = yield* chat()
      yield* llm.tool("escalate", { reason: "A refactor across the whole parser" })
      yield* llm.tool("task", {
        description: "Split the lexer",
        prompt: "Move the lexer into src/lexer.ts.",
        subagent_type: "general",
        model: "small",
        background: false,
      })
      yield* llm.text("Moved the lexer.")
      yield* llm.text("Refactored the parser.")
      yield* send(sessionID, "Refactor the parser module into smaller files")
      yield* settle()
      expect((yield* llm.hits).map((hit) => hit.body.model)).toContain("small-model")
      const [row] = yield* rows(place.repository)
      expect(row).toMatchObject({ subagents: 1, subagent_model: null })
      expect(JSON.parse(row!.subagent_models as string)).toEqual({})
    }),
  { git: true },
  90_000,
)

it.instance(
  "only the build agent's own choice-free requests take a learned default",
  () =>
    Effect.gen(function* () {
      const { place } = yield* setup()
      const workflow = yield* SessionWorkflow.Service
      const brain = yield* Brain.Service
      const sessions = yield* Session.Service
      const agents = yield* Agent.Service
      const build = yield* agents.get("build")
      const model = yield* (yield* Provider.Service).getModel(ref.providerID, ref.modelID)
      const base = {
        session: yield* sessions.create({ title: "Workflow" }),
        agent: build,
        stepAgent: build,
        user: { id: "msg_user", role: "user", model: { ...ref } } as unknown as SessionV1.User,
        model,
        provider: yield* (yield* Provider.Service).getProvider(ref.providerID),
        result: { tier: "thorough", source: "auto", reasons: ["work"], judge: true, agents: [] } as TaskSize.Result,
        guest: false,
      }
      expect(place.held).toBe(false)
      expect(yield* workflow.eligible(base)).toBe(true)
      const refused = [
        { agent: { ...build, name: "research" } },
        { user: { ...base.user, model: { ...ref, variant: "high" } } as unknown as SessionV1.User },
        { result: { ...base.result, source: "user" } as TaskSize.Result },
        { result: { ...base.result, reasons: ["explicit:think"] } },
        { result: { ...base.result, reasons: ["capped"] } },
        { stepAgent: { ...build, variant: "high" } },
        { stepAgent: { ...build, options: { reasoningEffort: "low" } } },
        { model: { ...model, options: { thinking: { type: "enabled", budgetTokens: 1024 } } } },
        { provider: { ...base.provider, options: { openai: { reasoningEffort: "high" } } } },
        { guest: true },
        { session: yield* sessions.create({ title: "Helper", internal: "autocomplete" }) },
        { session: yield* sessions.create({ title: "Child", parentID: base.session.id }) },
      ]
      for (const change of refused) expect(yield* workflow.eligible({ ...base, ...change })).toBe(false)
      // A user's variant named default is no pick.
      expect(
        yield* workflow.eligible({
          ...base,
          user: { ...base.user, model: { ...ref, variant: "default" } } as unknown as SessionV1.User,
        }),
      ).toBe(true)
      yield* brain.setLearnSettings({ workflow: "observe" })
      yield* Effect.addFinalizer(() => brain.setLearnSettings({ workflow: "apply" }))
      expect(yield* workflow.eligible(base)).toBe(false)
    }),
  { git: true },
  60_000,
)

it.instance(
  "sizing.learn: false keeps the size's defaults, and the guest's session takes none",
  () =>
    Effect.gen(function* () {
      const { place } = yield* setup({ config: { sizing: { learn: false } } })
      const llm = yield* TestLLMServer
      yield* earned(place)
      const sessionID = yield* chat()
      yield* llm.tool("escalate", { reason: "A refactor across the whole parser" })
      yield* llm.text("Refactored the parser.")
      yield* send(sessionID, "Refactor the parser module into smaller files")
      expect((yield* assistants(sessionID)).every((info) => info.workflow === undefined)).toBe(true)

      const guest = yield* chat()
      yield* (yield* FreeModelGuests.Service).mark(guest)
      yield* llm.tool("escalate", { reason: "A refactor across the whole parser" })
      yield* llm.text("Refactored the parser.")
      yield* send(guest, "Refactor the parser module into smaller files")
      yield* settle()
      expect((yield* assistants(guest)).every((info) => info.workflow === undefined)).toBe(true)
      expect((yield* rows(place.repository)).some((row) => row.session_id === guest)).toBe(false)
    }),
  { git: true },
  90_000,
)

pure.instance(
  "--pure neither applies learned defaults nor records runs",
  () =>
    Effect.gen(function* () {
      const { place } = yield* setup()
      const llm = yield* TestLLMServer
      yield* earned(place)
      const sessionID = yield* chat()
      yield* llm.tool("escalate", { reason: "A refactor across the whole parser" })
      yield* llm.text("Refactored the parser.")
      yield* send(sessionID, "Refactor the parser module into smaller files")
      yield* settle()
      expect((yield* assistants(sessionID)).every((info) => info.workflow === undefined)).toBe(true)
      expect((yield* rows(place.repository)).some((row) => row.session_id === sessionID)).toBe(false)
    }),
  { git: true },
  90_000,
)

describe("SessionWorkflow helpers", () => {
  test("reasoning options count at the top level and under a provider's key", () => {
    expect(SessionWorkflow.sets({ reasoningEffort: "high" })).toBe(true)
    expect(SessionWorkflow.sets({ anthropic: { thinking: { type: "enabled" } } })).toBe(true)
    expect(SessionWorkflow.sets({ enable_thinking: true })).toBe(true)
    expect(SessionWorkflow.sets({ temperature: 0.2, openai: { store: false } })).toBe(false)
    expect(SessionWorkflow.sets(undefined)).toBe(false)
  })

  const advice = (input: Partial<BrainWorkflow.Advice>) =>
    ({ effortTier: "thorough", source: "learned", reason: "Runs here say so.", ...input }) as BrainWorkflow.Advice

  test("while the cache is warm the effort is the request before it's, whatever the runs advise now", () => {
    const previous = { effort: "default" as const, source: "learned" as const, reason: "Before." }
    expect(SessionWorkflow.applied(undefined, { warm: true, previous })).toEqual(previous)
    expect(SessionWorkflow.applied(advice({ effort: "default" }), { warm: true })).toBeUndefined()
    expect(SessionWorkflow.applied(advice({ split: "solo" }), { warm: true, previous })).toEqual({
      effort: "default",
      split: "solo",
      source: "learned",
      reason: "Runs here say so.",
    })
  })

  test("on a cold cache the advice alone decides", () => {
    const previous = { effort: "default" as const, source: "learned" as const, reason: "Before." }
    expect(SessionWorkflow.applied(undefined, { warm: false, previous })).toBeUndefined()
    expect(SessionWorkflow.applied(advice({ effort: "default" }), { warm: false })).toEqual({
      effort: "default",
      source: "learned",
      reason: "Runs here say so.",
    })
  })

  test("who chose the effort: the user, the agent, config, an explicit ask, a learned default, or the size", () => {
    const user = (variant?: string) => ({ model: { ...ref, variant } }) as unknown as SessionV1.User
    const agent = { name: "build", mode: "primary", permission: [], options: {} } as unknown as Agent.Info
    const model = { options: {} } as unknown as Provider.Model
    const provider = { options: {} } as unknown as Provider.Info
    const result = { tier: "thorough", source: "auto", reasons: ["work"], judge: true, agents: [] } as TaskSize.Result
    const base = { user: user(), stepAgent: agent, model, provider, result, effortTier: "thorough" as const }
    expect(SessionWorkflow.source({ ...base, user: user("max") })).toEqual({ effort: "max", source: "user" })
    expect(SessionWorkflow.source({ ...base, stepAgent: { ...agent, variant: "low" } })).toEqual({
      effort: "low",
      source: "agent",
    })
    expect(
      SessionWorkflow.source({ ...base, model: { options: { thinking: {} } } as unknown as Provider.Model }),
    ).toEqual({ effort: "high", source: "config" })
    expect(SessionWorkflow.source({ ...base, result: { ...result, reasons: ["explicit:thorough"] } })).toEqual({
      effort: "high",
      source: "explicit",
    })
    expect(
      SessionWorkflow.source({ ...base, workflow: { effort: "default", source: "explore", reason: "Trying." } }),
    ).toEqual({ effort: "default", source: "explore" })
    expect(SessionWorkflow.source(base)).toEqual({ effort: "high", source: "size" })
  })

  test("a small model is cheaper only when it costs less on every price, both priced", () => {
    const model = (id: string, input: number, output: number, unpriced = false) =>
      ({ id, capabilities: { toolcall: true }, cost: { input, output, unpriced } }) as unknown as Provider.Model
    expect(SessionWorkflow.cheaper(model("small", 1, 5), model("big", 3, 15))).toBe(true)
    expect(SessionWorkflow.cheaper(model("small", 1, 20), model("big", 3, 15))).toBe(false)
    expect(SessionWorkflow.cheaper(model("small", 3, 15), model("big", 3, 15))).toBe(false)
    expect(SessionWorkflow.cheaper(model("small", 0, 0, true), model("big", 3, 15))).toBe(false)
    expect(SessionWorkflow.cheaper(undefined, model("big", 3, 15))).toBe(false)
  })
})

describe("a request's warm cache", () => {
  const user = (id: string, created: number, text: string) =>
    ({
      info: { id, sessionID: "ses_warm", role: "user", agent: "build", time: { created }, model: ref },
      parts: [{ id: `prt_${id}`, messageID: id, sessionID: "ses_warm", type: "text", text }],
    }) as unknown as SessionV1.WithParts
  const answer = (id: string, parentID: string, created: number) =>
    ({
      info: {
        id,
        sessionID: "ses_warm",
        role: "assistant",
        parentID,
        agent: "build",
        time: { created, completed: created + 1_000 },
        finish: "stop",
      },
      parts: [{ id: `prt_${id}`, messageID: id, sessionID: "ses_warm", type: "text", text: "Done." }],
    }) as unknown as SessionV1.WithParts
  const history = (gap: number) => [
    user("msg_01", 0, "Refactor the parser module into smaller files"),
    answer("msg_02", "msg_01", 1_000),
    user("msg_03", 2_000 + gap, "Now rename the lexer tokens to match"),
    answer("msg_04", "msg_03", 3_000 + gap),
  ]
  const lifetime = 5 * 60_000

  test("holds within the cache's lifetime of the request before, on a provider that caches", () => {
    expect(SessionTaskSize.size({ messages: history(0), caching: true, lifetime }).map((item) => item.warm)).toEqual([
      false,
      true,
    ])
  })

  test("goes once the lifetime has passed, and never holds where the provider does not cache", () => {
    expect(SessionTaskSize.size({ messages: history(lifetime + 1), caching: true, lifetime }).at(-1)?.warm).toBe(false)
    expect(SessionTaskSize.size({ messages: history(0), caching: false, lifetime }).at(-1)?.warm).toBe(false)
  })
})
