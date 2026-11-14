import { describe, expect, test } from "bun:test"
import { createOpenAI } from "@ai-sdk/openai"
import { streamText } from "ai"
import { Effect } from "effect"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { CodexAuthPlugin } from "@/plugin/openai/codex"
import { LLMRequestPrep } from "@/session/llm/request"
import { ProviderTransform } from "@/provider/transform"

type Input = Parameters<typeof LLMRequestPrep.prepare>[0]
type Hooks = Awaited<ReturnType<typeof CodexAuthPlugin>>
type ParamsHook = NonNullable<Hooks["chat.params"]>
type HeadersHook = NonNullable<Hooks["chat.headers"]>

async function titleRequest(options: {
  name?: string
  small?: boolean
  fast?: boolean
  allowance?: number
  output?: number
  context?: number
}) {
  const hooks = await CodexAuthPlugin({} as never)
  const called: string[] = []
  const selected = {
    id: "gpt-6.1-sol",
    providerID: "openai",
    api: { id: "gpt-6.1-sol", url: "https://example.invalid/v1", npm: "@ai-sdk/openai" },
    name: "Synthetic model",
    capabilities: {
      temperature: false,
      reasoning: true,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { output: options.output ?? 128_000, context: options.context ?? 400_000 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-04-23",
  } as unknown as Input["model"]
  const value: Input = {
    user: {
      id: "msg_title_plugin",
      sessionID: "ses_title_plugin",
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make(selected.id) },
      executionMode: options.fast ? "fast" : "normal",
    } as Input["user"],
    sessionID: "ses_title_plugin",
    agent: {
      name: options.name ?? "title",
      mode: "primary",
      prompt: "Return a short synthetic title.",
      options: {},
      permission: [],
    },
    small: options.small ?? true,
    model: selected,
    system: [],
    messages: [{ role: "user", content: "Summarize a synthetic code change." }],
    tools: {},
    provider: {
      id: ProviderV2.ID.make("openai"),
      name: "openai",
      source: "config",
      env: [],
      options: {},
      models: {},
    },
    auth: { type: "api", key: "synthetic-key-never-sent-outside-loopback" },
    plugin: {
      trigger: (name, input, output) =>
        Effect.promise(async () => {
          if (name === "chat.params") {
            called.push(name)
            await hooks["chat.params"]?.(input as Parameters<ParamsHook>[0], output as Parameters<ParamsHook>[1])
          }
          if (name === "chat.headers")
            await hooks["chat.headers"]?.(input as Parameters<HeadersHook>[0], output as Parameters<HeadersHook>[1])
          return output
        }),
      list: () => Effect.succeed([hooks]),
      init: () => Effect.void,
    },
    flags: { outputTokenMax: options.allowance ?? 32_000, client: "test" } as Input["flags"],
    isWorkflow: false,
  }
  const prepared = await Effect.runPromise(LLMRequestPrep.prepare(value))
  const requests: Array<Record<string, unknown>> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push((await request.json()) as Record<string, unknown>)
      const events = [
        { type: "response.created", response: { id: "resp_title_plugin", created_at: 1, model: selected.api.id } },
        { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
      ]
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  try {
    const sdk = createOpenAI({ apiKey: "local-test-only", baseURL: `${server.url.origin}/v1` })
    await streamText({
      model: sdk.responses(selected.api.id),
      messages: prepared.messages,
      maxOutputTokens: prepared.params.maxOutputTokens,
      providerOptions: ProviderTransform.providerOptions(selected, prepared.params.options),
      headers: prepared.headers,
    }).consumeStream()
    expect(called).toEqual(["chat.params"])
    expect(requests).toHaveLength(1)
    return { prepared, body: requests[0]! }
  } finally {
    server.stop(true)
  }
}

describe("automatic title cap through the built-in OpenAI plugin", () => {
  test.each([
    { fast: false, allowance: 32_000, output: 128_000, context: 400_000, expected: 512 },
    { fast: true, allowance: 32_000, output: 128_000, context: 400_000, expected: 512 },
    { fast: true, allowance: 96, output: 128_000, context: 400_000, expected: 96 },
    { fast: false, allowance: 32_000, output: 128, context: 400_000, expected: 128 },
    { fast: false, allowance: 32_000, output: 0, context: 1_024, expected: 256 },
  ])("sends $expected tokens after plugin hooks with fast=$fast", async (selected) => {
    const result = await titleRequest(selected)
    expect(result.prepared.params.maxOutputTokens).toBe(selected.expected)
    expect(result.body.max_output_tokens).toBe(selected.expected)
  })

  test.each([
    { name: "build", small: false },
    { name: "title", small: false },
    { name: "brain.learn", small: true },
  ])("preserves the plugin's normal omission for $name small=$small", async (selected) => {
    const result = await titleRequest(selected)
    expect(result.prepared.params.maxOutputTokens).toBeUndefined()
    expect(result.body).not.toHaveProperty("max_output_tokens")
  })
})
