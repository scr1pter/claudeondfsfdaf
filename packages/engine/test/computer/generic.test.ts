import { describe, expect, test } from "bun:test"
import { createAnthropic } from "@ai-sdk/anthropic"
import { asSchema, generateText, jsonSchema, tool, type ModelMessage, type Tool } from "ai"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ComputerGeneric } from "@/computer/generic"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"

type Input = Parameters<ReturnType<typeof ComputerGeneric.make>["prepare"]>[0]

const IMAGE = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=="

function model(npm = "@ai-sdk/anthropic", context = 200_000): Provider.Model {
  return {
    id: ModelV2.ID.make("claude-sonnet-4-5"),
    providerID: ProviderV2.ID.make("anthropic"),
    api: { id: "claude-sonnet-4-5", npm, url: "https://example.invalid" },
    name: "Test model",
    capabilities: {
      temperature: false,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, image: true, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context, output: 8192 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
  }
}

function computer(description = "See approved apps", actions = ["screenshot"], execute?: Tool["execute"]): Tool {
  return tool({
    description,
    inputSchema: jsonSchema({
      type: "object",
      properties: { action: { type: "string", enum: actions } },
      required: ["action"],
      additionalProperties: false,
    }),
    strict: false,
    providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    ...(execute ? { execute } : {}),
  })
}

function input(overrides: Partial<Input> = {}): Input {
  return {
    sessionID: "ses_generic",
    model: model(),
    messages: [{ role: "user", content: "Inspect the approved app." }],
    tools: { computer: computer() },
    options: {},
    ...overrides,
  }
}

function history(signature = "signed-screen-plan"): ModelMessage[] {
  return [
    { role: "user", content: "Inspect the approved app." },
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "Inspect before acting.", providerOptions: { anthropic: { signature } } },
        { type: "text", text: "I will inspect the app." },
        { type: "tool-call", toolCallId: "call_screen", toolName: "computer", input: { action: "screenshot" } },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_screen",
          toolName: "computer",
          output: {
            type: "content",
            value: [
              { type: "text", text: "<untrusted_screen>Screenshot 1, frame 1.</untrusted_screen>" },
              { type: "image-data", mediaType: "image/png", data: IMAGE },
            ],
          },
        },
      ],
    },
  ]
}

function reasoning(messages: ModelMessage[]) {
  return messages.flatMap((message) =>
    message.role === "assistant" && Array.isArray(message.content)
      ? message.content.filter((part) => part.type === "reasoning")
      : [],
  )
}

describe("generic Anthropic computer history", () => {
  test("keeps the advertised definition stable while using the current executor", async () => {
    const state = ComputerGeneric.make()
    const calls: string[] = []
    const first = state.prepare(
      input({ tools: { computer: computer("Initial capabilities", ["screenshot"], async () => calls.push("old")) } }),
    )
    const second = state.prepare(
      input({
        messages: history(),
        tools: {
          computer: {
            ...computer("Recovered capabilities", ["screenshot", "click"], async () => calls.push("current")),
            strict: true,
            providerOptions: { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } },
          },
        },
      }),
    )

    expect(second.tools.computer.description).toBe(first.tools.computer.description)
    expect(asSchema(second.tools.computer.inputSchema).jsonSchema).toEqual(
      asSchema(first.tools.computer.inputSchema).jsonSchema,
    )
    expect(second.tools.computer.strict).toBe(false)
    expect(second.tools.computer.providerOptions).toEqual(first.tools.computer.providerOptions)
    expect(reasoning(second.messages)).toEqual(reasoning(history()))
    await second.tools.computer.execute!({ action: "screenshot" }, { toolCallId: "call_new", messages: [] })
    expect(calls).toEqual(["current"])
  })

  test("uses the current definition in a different conversation", async () => {
    const state = ComputerGeneric.make()
    state.prepare(input())
    const other = state.prepare(
      input({ sessionID: "ses_other", tools: { computer: computer("Other capabilities", ["click"]) } }),
    )
    expect(other.tools.computer.description).toBe("Other capabilities")
    expect((await asSchema(other.tools.computer.inputSchema).jsonSchema).properties).toEqual({
      action: { type: "string", enum: ["click"] },
    })
  })

  test("a resumed conversation drops unverifiable old thinking without changing screen history", () => {
    const state = ComputerGeneric.make()
    const messages = history()
    const saved = JSON.stringify(messages)
    const prepared = state.prepare(input({ messages }))

    expect(reasoning(prepared.messages)).toEqual([])
    expect(prepared.messages.find((message) => message.role === "tool")).toEqual(
      messages.find((message) => message.role === "tool"),
    )
    expect(JSON.stringify(prepared.messages)).toContain("I will inspect the app.")
    expect(JSON.stringify(prepared.messages)).toContain(IMAGE)
    expect(JSON.stringify(messages)).toBe(saved)

    const cached = history()
    const signed = reasoning(cached)[0]
    signed.providerOptions = {
      ...signed.providerOptions,
      anthropic: { ...signed.providerOptions?.anthropic, cacheControl: { type: "ephemeral" } },
    }
    expect(reasoning(state.prepare(input({ messages: cached })).messages)).toEqual([])

    const later = state.prepare(input({ messages: [...messages, ...history("new-signature").slice(1)] }))
    expect(reasoning(later.messages)).toHaveLength(1)
    expect(reasoning(later.messages)[0].providerOptions?.anthropic?.signature).toBe("new-signature")
  })

  test("removing a tool never restores access and discards thinking tied to the previous definition", () => {
    const state = ComputerGeneric.make()
    state.prepare(input())
    const messages = history()
    const removed = state.prepare(input({ messages, tools: {} }))
    expect(removed.tools.computer).toBeUndefined()
    expect(reasoning(removed.messages)).toEqual([])
    expect(removed.messages.find((message) => message.role === "tool")).toEqual(
      messages.find((message) => message.role === "tool"),
    )

    const restored = state.prepare(
      input({
        messages: [...messages, ...history("without-computer").slice(1)],
        tools: { computer: computer("Changed") },
      }),
    )
    expect(restored.tools.computer.description).toBe("See approved apps")
    expect(reasoning(restored.messages)).toEqual([])
  })

  test("a title request sharing the session does not change its computer definition or signed thinking", () => {
    const state = ComputerGeneric.make()
    const first = state.prepare(input())
    const title = input({ tools: {}, messages: [{ role: "user", content: "Give this conversation a short title." }] })
    expect(state.prepare(title)).toBe(title)

    const resumed = state.prepare(
      input({ messages: history(), tools: { computer: computer("Recovered capabilities", ["screenshot", "click"]) } }),
    )
    expect(resumed.tools.computer.description).toBe(first.tools.computer.description)
    expect(asSchema(resumed.tools.computer.inputSchema).jsonSchema).toEqual(
      asSchema(first.tools.computer.inputSchema).jsonSchema,
    )
    expect(reasoning(resumed.messages)).toEqual(reasoning(history()))
  })

  test("forgetting a deleted conversation releases its frozen definition", () => {
    const state = ComputerGeneric.make()
    state.prepare(input())
    state.forget("ses_generic")
    const prepared = state.prepare(input({ tools: { computer: computer("New definition") }, messages: history() }))
    expect(prepared.tools.computer.description).toBe("New definition")
    expect(reasoning(prepared.messages)).toEqual([])
  })

  test("server clearing excludes current and historical non-computer tools and keeps tool inputs", () => {
    const state = ComputerGeneric.make()
    const messages: ModelMessage[] = [
      ...history(),
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "read_old", toolName: "read", input: { path: "notes.txt" } }],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "read_old", toolName: "read", output: { type: "text", value: "notes" } },
        ],
      },
    ]
    const prepared = state.prepare(
      input({
        messages,
        tools: { computer: computer(), shell: computer("Shell"), browser: computer("Browser") },
        options: {
          thinking: { type: "enabled", budgetTokens: 4096 },
          contextManagement: {
            edits: [
              { type: "clear_thinking_20251015", keep: "all" },
              { type: "clear_tool_uses_20250919", clearToolInputs: true },
            ],
          },
        },
      }),
    )
    expect(prepared.options.thinking).toEqual({ type: "enabled", budgetTokens: 4096 })
    expect(prepared.options.contextManagement).toEqual({
      edits: [
        { type: "clear_thinking_20251015", keep: "all" },
        {
          type: "clear_tool_uses_20250919",
          trigger: { type: "tool_uses", value: 28 },
          keep: { type: "tool_uses", value: 3 },
          clearToolInputs: false,
          excludeTools: ["browser", "read", "shell"],
        },
      ],
    })
  })

  test("a small context keeps two computer results with no cache batching", () => {
    const prepared = ComputerGeneric.make().prepare(
      input({ model: model("@ai-sdk/anthropic", 64_000), config: { computer: { screenshots: { keep: 8 } } } }),
    )
    expect(prepared.options.contextManagement).toEqual({
      edits: [
        {
          type: "clear_tool_uses_20250919",
          trigger: { type: "tool_uses", value: 3 },
          keep: { type: "tool_uses", value: 2 },
          clearToolInputs: false,
          excludeTools: [],
        },
      ],
    })
  })

  test("unrelated providers and conversations retain their existing messages and options", () => {
    const state = ComputerGeneric.make()
    const messages = history()
    const options = { thinking: { type: "enabled", budgetTokens: 4096 } }
    const unrelated = state.prepare(input({ model: model("@ai-sdk/openai"), messages, options }))
    expect(unrelated.messages).toBe(messages)
    expect(unrelated.options).toBe(options)

    const ordinary = input({ tools: {}, options })
    const prepared = state.prepare(ordinary)
    expect(prepared.messages).toBe(ordinary.messages)
    expect(prepared.options).toBe(options)
    expect(ComputerGeneric.retainHistory(model())).toBe(true)
    expect(ComputerGeneric.retainHistory(model("@ai-sdk/openai"))).toBe(false)
    expect(ComputerGeneric.retainHistory(model("@openrouter/ai-sdk-provider"))).toBe(false)
  })

  test("the installed Anthropic SDK sends stable tools, signed thinking, screenshots and server clearing", async () => {
    const requests: Array<Record<string, unknown>> = []
    const sdk = createAnthropic({
      apiKey: "test-only",
      fetch: Object.assign(
        async (_request: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
          return new Response(
            JSON.stringify({
              id: "msg_generic_test",
              type: "message",
              role: "assistant",
              model: "claude-sonnet-4-5",
              content: [{ type: "text", text: "Ready." }],
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: { input_tokens: 20, output_tokens: 3 },
            }),
            { headers: { "content-type": "application/json" } },
          )
        },
        { preconnect: fetch.preconnect },
      ),
    })
    const state = ComputerGeneric.make()
    const first = state.prepare(input())
    const second = state.prepare(
      input({
        messages: history(),
        tools: { computer: computer("Changed capabilities", ["screenshot", "click"]) },
        options: { thinking: { type: "enabled", budgetTokens: 4096 } },
      }),
    )
    for (const prepared of [first, second])
      await generateText({
        model: sdk("claude-sonnet-4-5"),
        tools: prepared.tools,
        messages: prepared.messages,
        providerOptions: ProviderTransform.providerOptions(model(), prepared.options),
        maxRetries: 0,
      })

    expect(requests).toHaveLength(2)
    expect(requests[1].tools).toEqual(requests[0].tools)
    expect(requests[1].context_management).toEqual({
      edits: [
        {
          type: "clear_tool_uses_20250919",
          trigger: { type: "tool_uses", value: 28 },
          keep: { type: "tool_uses", value: 3 },
          clear_tool_inputs: false,
          exclude_tools: [],
        },
      ],
    })
    expect(requests[1].messages).toEqual(
      expect.arrayContaining([
        {
          role: "assistant",
          content: expect.arrayContaining([
            { type: "thinking", thinking: "Inspect before acting.", signature: "signed-screen-plan" },
            { type: "tool_use", id: "call_screen", name: "computer", input: { action: "screenshot" } },
          ]),
        },
        {
          role: "user",
          content: expect.arrayContaining([
            {
              type: "tool_result",
              tool_use_id: "call_screen",
              content: [
                { type: "text", text: "<untrusted_screen>Screenshot 1, frame 1.</untrusted_screen>" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: IMAGE } },
              ],
            },
          ]),
        },
      ]),
    )
  })
})
