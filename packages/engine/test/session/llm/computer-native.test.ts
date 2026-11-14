import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ToolCallPart, ToolRuntime, type LLMRequest } from "@vectordevai/llm"
import type { LLMClientShape } from "@vectordevai/llm/route"
import { jsonSchema, tool, type ModelMessage } from "ai"
import { Effect, Layer, Stream } from "effect"
import { ComputerNative } from "@/computer/native"
import { LLMNativeRuntime } from "@/session/llm/native-runtime"
import type { Provider } from "@/provider/provider"
import { testEffect } from "../../lib/effect"

const computer = tool({
  description: "Use approved desktop apps",
  inputSchema: jsonSchema({ type: "object", properties: { action: { type: "string" } }, required: ["action"] }),
})

function model(
  provider: "openai" | "anthropic" = "openai",
  id = provider === "openai" ? "gpt-5.5" : "claude-sonnet-5-5",
): Provider.Model {
  return {
    id: ModelV2.ID.make(id),
    providerID: ProviderV2.ID.make(provider),
    api: {
      id,
      npm: provider === "openai" ? "@ai-sdk/openai" : "@ai-sdk/anthropic",
      url: `https://api.${provider}.com/v1`,
    },
    name: id,
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 200_000, output: 32_000 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
  }
}

function fixture(overrides: Partial<ComputerNative.Input> = {}): ComputerNative.Input {
  const selected = overrides.model ?? model()
  return {
    sessionID: "ses_native",
    model: selected,
    provider: {
      id: selected.providerID,
      name: selected.providerID,
      source: "config",
      env: [],
      options: { apiKey: "fixture-provider-key" },
      models: {},
    },
    auth: { type: "api", key: "fixture-provider-key" },
    tools: { computer },
    messages: [],
    config: { computer: { native_tools: "auto" } },
    requested: true,
    ...overrides,
  }
}

function history(metadata?: Record<string, Record<string, unknown>>, storage = "providerOptions"): ModelMessage[] {
  return [
    {
      role: "assistant",
      content: [
        Object.assign(
          {
            type: "tool-call" as const,
            toolCallId: "call_previous",
            toolName: "computer",
            input: { action: "screenshot" },
          },
          metadata ? { [storage]: metadata } : {},
        ),
      ],
    },
  ]
}

describe("computer native runtime choice", () => {
  test("only the explicit native model families opt in with the supported API-key runtime", () => {
    for (const id of ["gpt-5.4", "gpt-5.5"])
      expect(ComputerNative.make().wants(fixture({ model: model("openai", id) }))).toBe(true)
    for (const id of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"])
      expect(ComputerNative.make().wants(fixture({ model: model("anthropic", id) }))).toBe(true)
    for (const id of ["gpt-5-mini", "gpt-5.5-unknown", "claude-sonnet-4-5"])
      expect(
        ComputerNative.make().wants(fixture({ model: model(id.startsWith("claude") ? "anthropic" : "openai", id) })),
      ).toBe(false)
  })

  test("off, omitted configuration, unavailable tools and unsupported runtime stay generic", () => {
    for (const input of [
      fixture({ config: {} }),
      fixture({ config: { computer: { native_tools: "off" } } }),
      fixture({ tools: {} }),
      fixture({ provider: { ...fixture().provider, options: {} } }),
      fixture({ model: { ...model(), api: { ...model().api, npm: "@ai-sdk/openai-compatible" } } }),
      fixture({
        model: {
          ...model(),
          capabilities: { ...model().capabilities, input: { ...model().capabilities.input, image: false } },
        },
      }),
    ])
      expect(ComputerNative.make().wants(input)).toBe(false)
  })

  test("offering the tool alone does not opt in or permanently choose generic", () => {
    const choice = ComputerNative.make()
    expect(choice.wants(fixture({ requested: false }))).toBe(false)
    expect(choice.wants(fixture({ requested: false }))).toBe(false)
    expect(choice.wants(fixture({ requested: true }))).toBe(true)
  })

  test("a chosen runtime persists across turns and stays isolated between conversations", () => {
    const choice = ComputerNative.make()
    expect(choice.wants(fixture())).toBe(true)
    expect(choice.wants(fixture({ requested: false }))).toBe(true)
    expect(choice.wants(fixture({ sessionID: "ses_other", requested: false }))).toBe(false)
    expect(choice.wants(fixture({ sessionID: "ses_other", config: {} }))).toBe(false)
    expect(choice.wants(fixture({ sessionID: "ses_other" }))).toBe(false)
    expect(choice.wants(fixture({ requested: false }))).toBe(true)
  })

  test("generic computer history prevents upgrading after a process restart", () => {
    expect(ComputerNative.make().wants(fixture({ messages: history() }))).toBe(false)
    const native = history({ openai: { computerCall: { type: "computer_call", call_id: "call_previous" } } })
    expect(ComputerNative.make().wants(fixture({ messages: [...native, ...history()] }))).toBe(false)
  })

  test("stored provider metadata restores each native choice without a new mention", () => {
    for (const storage of ["providerOptions", "providerMetadata"]) {
      expect(
        ComputerNative.make().wants(
          fixture({
            requested: false,
            messages: history(
              { openai: { computerCall: { type: "computer_call", call_id: "call_previous" } } },
              storage,
            ),
          }),
        ),
      ).toBe(true)
      expect(
        ComputerNative.make().wants(
          fixture({
            model: model("anthropic"),
            requested: false,
            messages: history({ anthropic: { toolset_name: "computer", member: "screenshot" } }, storage),
          }),
        ),
      ).toBe(true)
    }
  })

  test("model, auth and config fallback stay generic for the conversation", () => {
    for (const changed of [
      fixture({ model: model("openai", "gpt-5-mini") }),
      fixture({ model: model("anthropic") }),
      fixture({ config: { computer: { native_tools: "off" } } }),
      fixture({ auth: { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: 1 } }),
    ]) {
      const choice = ComputerNative.make()
      expect(choice.wants(fixture())).toBe(true)
      expect(choice.wants(changed)).toBe(false)
      expect(choice.wants(fixture())).toBe(false)
    }
  })

  test("a helper request without the computer tool does not erase an existing selection", () => {
    const choice = ComputerNative.make()
    expect(choice.wants(fixture())).toBe(true)
    expect(choice.wants(fixture({ tools: {}, config: {}, model: model("openai", "gpt-5-mini") }))).toBe(false)
    expect(choice.wants(fixture({ requested: false }))).toBe(true)
  })

  test("forget removes only the requested in-memory conversation choice", () => {
    const choice = ComputerNative.make()
    expect(choice.wants(fixture({ config: {} }))).toBe(false)
    expect(choice.wants(fixture({ sessionID: "ses_keep" }))).toBe(true)
    choice.forget("ses_native")
    expect(choice.wants(fixture())).toBe(true)
    expect(choice.wants(fixture({ sessionID: "ses_keep", requested: false }))).toBe(true)
  })

  describe("subscription runtime compatibility", () => {
    const owned = "vector-hands-native-fixture"
    const before = process.env.VECTOR_OPENAI_OAUTH_CLIENT_ID
    beforeAll(() => {
      process.env.VECTOR_OPENAI_OAUTH_CLIENT_ID = owned
    })
    afterAll(() => {
      if (before === undefined) delete process.env.VECTOR_OPENAI_OAUTH_CLIENT_ID
      else process.env.VECTOR_OPENAI_OAUTH_CLIENT_ID = before
    })
    test("OpenAI OAuth needs its supported fetch override and Anthropic OAuth remains generic", () => {
      const auth = {
        type: "oauth" as const,
        access: "fixture-access",
        refresh: "fixture-refresh",
        expires: 1,
        clientId: owned,
        enterpriseUrl: "https://auth.openai.com",
      }
      expect(ComputerNative.make().wants(fixture({ auth }))).toBe(false)
      expect(
        ComputerNative.make().wants(
          fixture({
            auth,
            provider: { ...fixture().provider, options: { apiKey: "fixture-key", fetch: async () => new Response() } },
          }),
        ),
      ).toBe(true)
      expect(
        ComputerNative.make().wants(
          fixture({
            model: model("anthropic"),
            auth: {
              type: "oauth",
              access: "fixture-access",
              refresh: "fixture-refresh",
              expires: 1,
            },
          }),
        ),
      ).toBe(false)
    })
  })
})

const it = testEffect(Layer.empty)

function bridge(provider?: "openai" | "anthropic") {
  const seen: { args: unknown; context: unknown; call: string }[] = []
  const abort = new AbortController().signal
  const tools = LLMNativeRuntime.nativeTools(
    {
      computer: tool({
        description: computer.description,
        inputSchema: computer.inputSchema,
        execute: async (args, options) => {
          seen.push({ args, context: options.experimental_context, call: options.toolCallId })
          return { output: "The approved action completed.", metadata: {} }
        },
      }),
    },
    { messages: [], abort, computer: provider, computerPlatform: "darwin" },
  )
  const run = (input: unknown) =>
    ToolRuntime.dispatch(tools, ToolCallPart.make({ id: "call_native", name: "computer", input }))
  return { seen, run }
}

describe("native computer execution bridge", () => {
  it.effect("the runtime marks only the selected computer definition as provider-native", () =>
    Effect.gen(function* () {
      const requests: LLMRequest[] = []
      const llmClient: LLMClientShape = {
        prepare: () => Effect.die("The fixture does not prepare HTTP requests."),
        generate: () => Effect.die("The fixture does not generate responses."),
        stream: (request) => {
          requests.push(request)
          return Stream.empty
        },
      }
      const lookup = tool({ description: "Read fixture data", inputSchema: jsonSchema({ type: "object" }) })
      const base = fixture()
      for (const selected of ["openai", undefined] as const) {
        const runtime = LLMNativeRuntime.stream({
          model: base.model,
          provider: base.provider,
          auth: base.auth,
          llmClient,
          messages: [],
          tools: { computer, lookup },
          headers: {},
          abort: new AbortController().signal,
          computer: selected,
          computerPlatform: "darwin",
        })
        expect(runtime.type).toBe("supported")
        if (runtime.type === "unsupported") throw new Error(runtime.reason)
        expect(yield* Stream.runCollect(runtime.stream)).toEqual([])
      }
      expect(requests).toHaveLength(2)
      expect(requests[0].tools.find((item) => item.name === "computer")?.native).toBe("computer")
      expect(requests[1].tools.find((item) => item.name === "computer")?.native).toBeUndefined()
      expect(requests[1].tools.find((item) => item.name === "computer")).toMatchObject({
        description: computer.description,
        inputSchema: { required: ["action"] },
      })
      expect(requests[0].tools.find((item) => item.name === "lookup")).toEqual(
        requests[1].tools.find((item) => item.name === "lookup"),
      )
      expect(requests[0].tools.find((item) => item.name === "lookup")?.native).toBeUndefined()
    }),
  )

  it.effect("native toolset input reaches the ordinary tool as normalized arguments", () =>
    Effect.gen(function* () {
      const test = bridge("anthropic")
      const result = yield* test.run({ member: "key", text: "Super_L+Left" })
      expect(result.result.type).not.toBe("error")
      expect(test.seen).toEqual([
        {
          args: { action: "key", keys: "cmd+arrowleft" },
          context: { computerNative: { provider: "anthropic", safetyChecks: [] } },
          call: "call_native",
        },
      ])
    }),
  )

  it.effect("provider checks and exact pixel scroll deltas travel outside model tool arguments", () =>
    Effect.gen(function* () {
      const test = bridge("openai")
      const checks = [{ id: "check_1", code: "sensitive", message: "Confirm this action" }]
      const result = yield* test.run({
        actions: [
          { action: "key", keys: ["CTRL", "A"] },
          { action: "scroll", x: 10, y: 20, scroll_x: -7, scroll_y: 101 },
        ],
        safety_checks: checks,
      })
      expect(result.result.type).not.toBe("error")
      expect(test.seen).toEqual([
        {
          args: {
            action: "key",
            actions: [
              { action: "key", keys: "ctrl+a" },
              { action: "scroll", x: 10, y: 20 },
            ],
          },
          context: {
            computerNative: { provider: "openai", safetyChecks: checks, scrolls: [{ index: 1, dx: -7, dy: 101 }] },
          },
          call: "call_native",
        },
      ])
    }),
  )

  it.effect("invalid native members and invalid safety envelopes never invoke the tool", () =>
    Effect.gen(function* () {
      for (const [provider, input] of [
        ["anthropic", { member: "unknown", action: "screenshot" }],
        ["openai", { actions: [{ action: "screenshot" }], safety_checks: null }],
        ["openai", { actions: [{ action: "screenshot" }], safety_checks: [{ id: "check_1", code: "sensitive" }] }],
        [
          "openai",
          { actions: [{ action: "screenshot" }, { action: "scroll", x: 1, y: 2, scroll_x: 0, scroll_y: 10001 }] },
        ],
      ] as const) {
        const test = bridge(provider)
        const result = yield* test.run(input)
        expect(result.result.type).toBe("error")
        expect(test.seen).toEqual([])
      }
    }),
  )

  it.effect("generic runtime computer arguments are passed through without a native context", () =>
    Effect.gen(function* () {
      const test = bridge()
      const args = { action: "screenshot" }
      yield* test.run(args)
      expect(test.seen).toEqual([{ args, context: undefined, call: "call_native" }])
    }),
  )
})
