import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { ModelCatalog } from "@vectordevai/core/model-catalog"
import { HttpRecorder } from "@vectordevai/http-recorder"
import { HttpRecorderInternal } from "@vectordevai/http-recorder/internal"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { tool, type ModelMessage, type JSONValue } from "ai"
import { Effect, Layer, Stream } from "effect"
import path from "node:path"
import z from "zod"
import { Auth } from "@/auth"
import { Provider } from "@/provider/provider"

import { Filesystem } from "@/util/filesystem"
import { LLMEvent, LLMResponse } from "@vectordevai/llm"
import { RequestExecutor } from "@vectordevai/llm/route"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Env } from "@/env"
import type { Agent } from "../../src/agent/agent"
import { LLM } from "../../src/session/llm"
import { MessageID, SessionID } from "../../src/session/schema"
import { TestInstance, trustWorkspace } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { LayerNodePlatform } from "@vectordevai/core/effect/app-node-platform"
import { Database } from "@vectordevai/core/database/database"
import { ProjectTable } from "@vectordevai/core/project/sql"
import { SessionTable } from "@vectordevai/core/session/sql"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { AbsolutePath } from "@vectordevai/core/schema"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceRef } from "@/effect/instance-ref"
import { eq } from "drizzle-orm"

const FIXTURES_DIR = path.join(import.meta.dir, "../fixtures/recordings")
const owned = "vector-native-recorded-test-registration"

const replayOpenAIOAuth = {
  type: "oauth",
  refresh: "fixture-refresh-token",
  access: "fixture-access-token",
  expires: Date.now() + 60 * 60 * 1000,
  accountId: "fixture-account",
  clientId: owned,
  enterpriseUrl: "https://auth.openai.com",
} satisfies Auth.Info

type RecordedScenario = {
  readonly id: string
  readonly name: string
  readonly providerID: ProviderV2.ID
  readonly modelID: string
  readonly cassette: string
  readonly protocol: string
  readonly tags: ReadonlyArray<string>
  readonly canRecord: () => boolean
  readonly replayAuth?: Auth.Info
  readonly stableID?: string
  readonly config: (model: ModelCatalog.Provider["models"][string]) => Partial<ConfigV1.Info>
}

const cloneModel = (model: ModelCatalog.Provider["models"][string]) => {
  const cloned = structuredClone(model)
  const { experimental, ...rest } = cloned
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- The config schema accepts the same model shape except object-valued experimental metadata.
  if (typeof experimental === "boolean") {
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- The fixture model already matches config input when experimental is boolean.
    return cloned as NonNullable<NonNullable<ConfigV1.Info["provider"]>[string]["models"]>[string]
  }
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Dropping non-boolean experimental metadata makes the fixture model match config input.
  return rest as NonNullable<NonNullable<ConfigV1.Info["provider"]>[string]["models"]>[string]
}

const envValue = (...names: string[]) => names.map((name) => process.env[name]).find(Boolean)
const providerConfig = (input: {
  readonly providerID: ProviderV2.ID
  readonly name: string
  readonly env: string[]
  readonly npm: string
  readonly api: string
  readonly model: ModelCatalog.Provider["models"][string]
  readonly options: Record<string, unknown>
}): Partial<ConfigV1.Info> => ({
  enabled_providers: [input.providerID],
  provider: {
    [input.providerID]: {
      name: input.name,
      env: input.env,
      npm: input.npm,
      api: input.api,
      models: { [input.model.id]: cloneModel(input.model) },
      options: input.options,
    },
  },
})

const SYNTHETIC_OPENAI_SCENARIO = {
  id: "openai-api-key-synthetic",
  name: "OpenAI API key (synthetic replay)",
  providerID: ProviderV2.ID.openai,
  modelID: "gpt-5.5",
  cassette: "session/synthetic-openai-tool-loop",
  protocol: "openai-responses",
  tags: ["vector", "synthetic", "api-key", "tool-loop"],
  canRecord: () => false,
  config: (model) =>
    providerConfig({
      providerID: ProviderV2.ID.openai,
      name: "OpenAI",
      env: ["OPENAI_API_KEY"],
      npm: "@ai-sdk/openai",
      api: "https://api.openai.com/v1",
      model,
      options: {
        apiKey: "fixture-openai-key",
        // The cassette intercepts native requests. A runtime regression must fail locally, not contact a live API.
        baseURL: "http://127.0.0.1:1/v1",
      },
    }),
} satisfies RecordedScenario

const RECORDED_SCENARIOS = [
  SYNTHETIC_OPENAI_SCENARIO,
  {
    id: "openai-oauth",
    name: "OpenAI OAuth",
    providerID: ProviderV2.ID.openai,
    modelID: "gpt-5.5",
    cassette: "session/native-openai-oauth-tool-loop",
    protocol: "openai-responses",
    tags: ["vector", "native", "oauth", "tool-loop"],
    canRecord: () => false,
    replayAuth: replayOpenAIOAuth,
    stableID: "openai-oauth",
    config: (model) =>
      providerConfig({
        providerID: ProviderV2.ID.openai,
        name: "OpenAI",
        env: ["OPENAI_API_KEY"],
        npm: "@ai-sdk/openai",
        api: "https://api.openai.com/v1",
        model,
        options: { baseURL: "https://api.openai.com/v1" },
      }),
  },
  {
    id: "anthropic-api-key",
    name: "Anthropic API key",
    providerID: ProviderV2.ID.anthropic,
    modelID: "claude-haiku-4-5-20251001",
    cassette: "session/native-anthropic-tool-loop",
    protocol: "anthropic-messages",
    tags: ["vector", "native", "tool-loop"],
    canRecord: () => Boolean(envValue("VECTOR_RECORD_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY")),
    config: (model) =>
      providerConfig({
        providerID: ProviderV2.ID.anthropic,
        name: "Anthropic",
        env: ["ANTHROPIC_API_KEY"],
        npm: "@ai-sdk/anthropic",
        api: "https://api.anthropic.com/v1",
        model,
        options: {
          apiKey: shouldRecord
            ? envValue("VECTOR_RECORD_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY")
            : "fixture-anthropic-key",
          baseURL: "https://api.anthropic.com/v1",
        },
      }),
  },
] satisfies ReadonlyArray<RecordedScenario>

const shouldRecord = process.env.RECORD === "true"
const selectedScenarios = new Set(
  (envValue("VECTOR_RECORDED_SCENARIO", "RECORDED_PROVIDER") ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean),
)

function isSelected(scenario: RecordedScenario) {
  if (selectedScenarios.size === 0) return true
  return [scenario.id, scenario.name, scenario.providerID, scenario.cassette, ...scenario.tags]
    .map((item) => item.toLowerCase())
    .some((item) => selectedScenarios.has(item))
}

const canRun = (scenario: RecordedScenario) =>
  shouldRecord
    ? scenario.canRecord()
    : HttpRecorderInternal.hasCassetteSync(scenario.cassette, { directory: FIXTURES_DIR })

const recordError = (scenario: RecordedScenario) => `Missing recording credentials for ${scenario.name}.`

const redactRecordedBody = (body: string) =>
  body
    .replace(/wrk_[A-Z0-9]+/g, "wrk_redacted")
    .replace(/"safety_identifier"\s*:\s*"user-[^"]+"/g, '"safety_identifier":"user_redacted"')
    .replace(/"(access|access_token|refresh|refresh_token|accountId|account_id)"\s*:\s*"[^"]+"/g, '"$1":"redacted"')

function authLayer(scenario: RecordedScenario) {
  const replayAuth = shouldRecord ? undefined : scenario.replayAuth
  if (!replayAuth) return undefined
  return Layer.mock(Auth.Service)({
    get: (providerID) => Effect.succeed(providerID === scenario.providerID ? replayAuth : undefined),
    all: () => Effect.succeed({ [scenario.providerID]: replayAuth }),
  })
}

async function loadFixture(providerID: string, modelID: string) {
  const data = await modelsFixture
  const provider = data[providerID]
  if (!provider) throw new Error(`Missing provider in fixture: ${providerID}`)
  const model = provider.models[modelID]
  if (!model) throw new Error(`Missing model in fixture: ${modelID}`)
  return model
}

const modelsFixture = Filesystem.readJson<Record<string, ModelCatalog.Provider>>(
  path.join(import.meta.dir, "../tool/fixtures/models-api.json"),
)

function recordedNativeLLMLayer(scenario: RecordedScenario) {
  const auth = authLayer(scenario)
  // Only the HTTP client is recorded; RequestExecutor and the vector LLM stack remain real.
  const metadata = {
    provider: scenario.providerID,
    protocol: scenario.protocol,
    route: scenario.protocol,
    tags: scenario.tags,
  }
  const redact = {
    url: (url: string) => url.replace("http://127.0.0.1:1/v1", "https://api.openai.com/v1"),
    body: redactRecordedBody,
  }
  const recordedHttp = shouldRecord
    ? HttpRecorderInternal.cassetteLayer(scenario.cassette, {
        directory: FIXTURES_DIR,
        mode: "record",
        metadata,
        redactor: HttpRecorderInternal.Redactor.make(redact),
      })
    : HttpRecorder.http(scenario.cassette, { directory: FIXTURES_DIR, metadata, redact })
  return AppNodeBuilder.build(
    LayerNode.group([Provider.node, LLM.node, Database.node, EventV2Bridge.node, SessionProjector.node]),
    [
      [Database.node, Database.layerFromPath(":memory:")],
      [LayerNodePlatform.requestExecutor, RequestExecutor.layer.pipe(Layer.provide(recordedHttp))],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalNativeLlm: true })],
      ...(auth ? ([[Auth.node, auth]] as const) : []),
    ],
  )
}

const writeConfig = (directory: string, scenario: RecordedScenario, model: ModelCatalog.Provider["models"][string]) =>
  Effect.promise(() =>
    Bun.write(
      path.join(directory, "vector.json"),
      JSON.stringify({ $schema: "https://vectordev.ai/config.json", ...scenario.config(model) }),
    ),
  )

const collect = (input: LLM.StreamInput) =>
  Effect.gen(function* () {
    const llm = yield* LLM.Service
    return Array.from(yield* llm.stream(input).pipe(Stream.runCollect))
  })

const ordinarySession = Effect.fnUntraced(function* (sessionID: SessionID) {
  const database = yield* Database.Service
  if (yield* database.db.select({ id: SessionTable.id }).from(SessionTable).where(eq(SessionTable.id, sessionID)).get())
    return
  const instance = yield* InstanceRef
  if (!instance) return yield* Effect.die("InstanceRef not provided")
  yield* database.db
    .insert(ProjectTable)
    .values({ id: instance.project.id, worktree: AbsolutePath.make(instance.worktree), sandboxes: [] })
    .onConflictDoNothing()
    .run()
  const events = yield* EventV2Bridge.Service
  yield* events.publish(SessionV1.Event.Created, {
    sessionID,
    info: SessionV1.SessionInfo.make({
      id: sessionID,
      projectID: instance.project.id,
      directory: instance.directory,
      slug: "native-recorded-fixture",
      title: "Native recorded fixture",
      version: "test",
      time: { created: 1, updated: 1 },
    }),
  })
})

const WEATHER_RESULT = { temperature: 22, condition: "sunny" } as const
const WEATHER_SYSTEM =
  "Use the get_weather tool exactly once to look up Paris, then reply with exactly: Paris is sunny."
const WEATHER_USER = "What is the weather in Paris?"

const weatherTool = tool({
  description: "Get the current weather for a city.",
  inputSchema: z.object({ city: z.string() }),
  execute: async () => WEATHER_RESULT,
})

const toolRoundtrip = (
  events: ReadonlyArray<LLMEvent>,
  call: { readonly id: string; readonly name: string; readonly input: unknown },
  result: JSONValue,
): ModelMessage[] => [
  {
    role: "assistant",
    content: [
      ...events.filter(LLMEvent.is.reasoningEnd).map((part) => ({
        type: "reasoning" as const,
        text: events
          .filter(LLMEvent.is.reasoningDelta)
          .filter((event) => event.id === part.id)
          .map((event) => event.text)
          .join(""),
        providerMetadata: part.providerMetadata,
      })),
      { type: "tool-call", toolCallId: call.id, toolName: call.name, input: call.input },
    ],
  },
  {
    role: "tool",
    content: [
      { type: "tool-result", toolCallId: call.id, toolName: call.name, output: { type: "json", value: result } },
    ],
  },
]

const driveToolLoop = (scenario: RecordedScenario) =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const model = yield* Effect.promise(() => loadFixture(scenario.providerID, scenario.modelID))
    yield* writeConfig(test.directory, scenario, model)
    yield* Effect.promise(() => trustWorkspace(test.directory))

    const stableID = scenario.stableID ?? scenario.providerID
    const sessionID = SessionID.make(`session-recorded-${stableID}-loop`)
    yield* ordinarySession(sessionID)
    const modelID = ModelV2.ID.make(model.id)
    const agent = {
      name: "test",
      mode: "primary",
      prompt: "Answer using tools when appropriate.",
      options: {},
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
      temperature: 0,
    } satisfies Agent.Info
    const provider = yield* Provider.Service
    const resolved = yield* provider.getModel(scenario.providerID, modelID)

    const userMessage = { role: "user", content: WEATHER_USER } satisfies ModelMessage
    const base = {
      user: {
        id: MessageID.make(`msg_user-recorded-${stableID}-loop`),
        sessionID,
        role: "user",
        time: { created: 0 },
        agent: agent.name,
        model: { providerID: scenario.providerID, modelID },
      } satisfies SessionV1.User,
      sessionID,
      model: resolved,
      agent,
      system: [WEATHER_SYSTEM],
      tools: { get_weather: weatherTool },
    }

    const turn1 = yield* collect({ ...base, messages: [userMessage] })
    const toolCall = turn1.find(LLMEvent.is.toolCall)
    expect(toolCall).toBeDefined()
    expect(turn1.find(LLMEvent.is.toolResult)).toBeDefined()
    expect(toolCall!.name).toBe("get_weather")
    expect(toolCall!.input).toMatchObject({ city: expect.stringMatching(/Paris/i) })
    expect(turn1.filter(LLMEvent.is.stepFinish)).toHaveLength(1)

    const turn2 = yield* collect({
      ...base,
      messages: [userMessage, ...toolRoundtrip(turn1, toolCall!, WEATHER_RESULT)],
    })

    expect(LLMResponse.text({ events: turn2 })).toMatch(/Paris is sunny/i)
    expect(turn2.filter(LLMEvent.is.finish)).toHaveLength(1)
    expect(turn2.filter(LLMEvent.is.toolCall)).toHaveLength(0)
  })

describe("session.llm native recorded", () => {
  // Recorded OAuth requests use a synthetic Vector-owned registration, never the disabled built-in sign-in.
  const before = process.env.VECTOR_OPENAI_OAUTH_CLIENT_ID
  beforeAll(() => {
    process.env.VECTOR_OPENAI_OAUTH_CLIENT_ID = owned
  })
  afterAll(() => {
    if (before === undefined) delete process.env.VECTOR_OPENAI_OAUTH_CLIENT_ID
    else process.env.VECTOR_OPENAI_OAUTH_CLIENT_ID = before
  })
  for (const scenario of RECORDED_SCENARIOS.filter(isSelected)) {
    if (!canRun(scenario)) {
      if (shouldRecord && selectedScenarios.size > 0) {
        test(`${scenario.name}: drives a tool loop to a final text answer`, () => {
          throw new Error(recordError(scenario))
        })
        continue
      }
      test.skip(`${scenario.name}: drives a tool loop to a final text answer`, () => {})
      continue
    }
    const it = testEffect(recordedNativeLLMLayer(scenario))
    it.instance(`${scenario.name}: drives a tool loop to a final text answer`, () => driveToolLoop(scenario))
  }

  const policy = testEffect(
    AppNodeBuilder.build(Provider.node, [
      [
        Auth.node,
        Layer.mock(Auth.Service)({
          get: (id) => Effect.succeed(id === ProviderV2.ID.openai ? replayOpenAIOAuth : undefined),
          all: () =>
            Effect.succeed({
              openai: replayOpenAIOAuth,
              "unsupported-fixture": { type: "api" as const, key: "fixture-unsupported-key" },
            }),
        }),
      ],
      [Env.node, Layer.mock(Env.Service)({ get: () => Effect.succeed(undefined), all: () => Effect.succeed({}) })],
    ]),
  )

  policy.instance(
    "OpenAI OAuth alone resolves a native-session model",
    () =>
      Effect.gen(function* () {
        const provider = yield* Provider.Service
        expect((yield* provider.list())[ProviderV2.ID.openai]).toBeDefined()
        const model = yield* provider.getModel(ProviderV2.ID.openai, ModelV2.ID.make("gpt-5.5"))
        expect(String(model.providerID)).toBe("openai")
      }),
    { trusted: true, config: { enabled_providers: [ProviderV2.ID.openai] } },
  )

  for (const id of ["unsupported-fixture", "unsupported-fixture-two"]) {
    policy.instance(
      `${id} admits an explicitly configured custom provider without adding a built-in`,
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make(id), ModelV2.ID.make("gpt-5.2-codex"))
          expect(String(model.providerID)).toBe(id)
          expect((yield* provider.list())[ProviderV2.ID.make(id)]?.options).toMatchObject({
            apiKey: "fixture-custom-key",
            baseURL: "https://custom.example.test/v1",
          })
        }),
      {
        trusted: true,
        config: {
          enabled_providers: [ProviderV2.ID.make(id)],
          provider: {
            [id]: {
              npm: "@ai-sdk/openai-compatible",
              options: {
                apiKey: "fixture-custom-key",
                baseURL: "https://custom.example.test/v1",
              },
              models: { "gpt-5.2-codex": { name: "Custom fixture" } },
            },
          },
        },
      },
    )
  }
})
