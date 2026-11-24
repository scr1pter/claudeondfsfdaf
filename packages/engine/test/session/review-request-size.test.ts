import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { jsonSchema, tool } from "ai"
import { ModelV2 } from "@vectordevai/core/model"
import { MAX_STEPS_PROMPT } from "@vectordevai/core/session/runner/max-steps"
import { ProviderV2 } from "@vectordevai/core/provider"
import type { Provider } from "@/provider/provider"
import type { LLMRequestPrep } from "@/session/llm/request"
import { reviewRequestProjection } from "@/session/review-request-size"

const text = { text: true, image: false, audio: false, video: false, pdf: false }

function selected(npm: string, provider = "lmstudio"): Provider.Model {
  return {
    id: ModelV2.ID.make("test-model"),
    providerID: ProviderV2.ID.make(provider),
    name: "test-model",
    api: { id: "test-model", npm, url: "http://127.0.0.1:1" },
    capabilities: {
      reasoning: false,
      temperature: true,
      attachment: false,
      toolcall: true,
      input: text,
      output: text,
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128_000, output: 2_000 },
    status: "active",
    options: {},
    headers: {},
    release_date: "",
  }
}
const local = selected("@ai-sdk/openai-compatible")
const inspect = (
  prepared: LLMRequestPrep.Prepared,
  model = local,
  conditional?: { text: string; maxSerializedTextChars: number },
) => Effect.runPromise(reviewRequestProjection({ prepared, model, conditional }))

function request(description = "return the review", schemaDescription = "review details"): LLMRequestPrep.Prepared {
  return {
    messages: [
      { role: "system", content: "Review the diff" },
      { role: "user", content: "line 1\nline 2" },
    ],
    system: ["Review the diff"],
    tools: {
      StructuredOutput: tool<{ headers?: string }, string>({
        description,
        strict: false,
        inputSchema: jsonSchema<{ headers?: string }>(async () => ({
          type: "object",
          properties: { headers: { type: "string", description: schemaDescription } },
        })),
        execute: async () => {
          throw new Error("The preview must never execute a tool")
        },
      }),
    },
    params: { maxOutputTokens: 2050, options: {} },
    messageTransformOptions: {},
    headers: {},
  }
}

describe("SF-17 normalized first review request", () => {
  test("counts the selected model, serialized text, resolved function definitions and structured schema", async () => {
    const base = await inspect(request())
    expect(base).toBeDefined()
    const compatibleBody = {
      model: "test-model",
      max_tokens: 2050,
      messages: [
        { role: "system", content: "Review the diff" },
        { role: "user", content: "line 1\nline 2" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "StructuredOutput",
            description: "return the review",
            parameters: { type: "object", properties: { headers: { type: "string", description: "review details" } } },
            strict: false,
          },
        },
      ],
      tool_choice: "required",
      stream: true,
      stream_options: { include_usage: true },
    }
    expect(base!.promptTokens).toBeGreaterThanOrEqual(Math.ceil(JSON.stringify(compatibleBody).length / 3.5))
    const extra = "😀".repeat(175) // 350 UTF-16 characters; JSON does not escape the surrogate pairs.
    expect((await inspect(request("return the review" + extra)))?.promptTokens).toBe(base!.promptTokens + 100)
    expect((await inspect(request("return the review", "review details" + extra)))?.promptTokens).toBe(
      base!.promptTokens + 100,
    )
    const withInvalid = request()
    withInvalid.tools.invalid = tool({
      inputSchema: jsonSchema(() => {
        throw new Error("disabled tool schema")
      }),
    })
    expect(await inspect(withInvalid)).toEqual(base)
  })

  test("counts the one-step agent's terminal instruction and refuses unrelated assistant history", async () => {
    const prepared = request()
    const initial = await inspect(prepared)
    const assistant = { role: "assistant" as const, content: MAX_STEPS_PROMPT }
    const final = await inspect({ ...prepared, messages: [...prepared.messages, assistant] })
    expect(final).toBeDefined()
    expect(final!.promptTokens - initial!.promptTokens).toBeGreaterThanOrEqual(
      Math.floor(MAX_STEPS_PROMPT.length / 3.5),
    )
    expect(await inspect({ ...prepared, messages: [assistant, ...prepared.messages] })).toBeUndefined()
    expect(
      await inspect({ ...prepared, messages: [...prepared.messages, { ...assistant, content: "old transcript" }] }),
    ).toBeUndefined()
  })

  test("measures OAuth instructions in options once and never reads credentials or transport headers", async () => {
    const prepared = request()
    const model = selected("@ai-sdk/openai", "openai")
    const messages = prepared.messages.filter((message) => message.role !== "system")
    const size = async (instruction: string) => {
      const secret = () => {
        throw new Error("connection values are not part of the model request")
      }
      const options = Object.defineProperties(
        { instructions: instruction },
        {
          apiKey: { enumerable: true, get: secret },
          headers: { enumerable: true, get: secret },
        },
      )
      return inspect(
        {
          ...prepared,
          messages,
          system: [instruction],
          params: { ...prepared.params, options },
          get headers() {
            return secret()
          },
        },
        model,
      )
    }
    const first = await size("review")
    expect(first).toBeDefined()
    expect((await size("review" + "x".repeat(350)))?.promptTokens).toBe(first!.promptTokens + 100)
    expect(
      await inspect({ ...prepared, messages, system: ["instructions missing from both messages and options"] }, model),
    ).toBeUndefined()
  })

  test("reserves the serialized conditional payload once inside the actual user text", async () => {
    const prepared = request()
    const candidate = 'issue "1"\n\\next'
    const messages = [{ role: "user" as const, content: `Check: ${candidate}` }]
    const checker = { ...prepared, system: [], messages }
    const base = await inspect(checker)
    expect(base).toBeDefined()
    const bound = { text: candidate, maxSerializedTextChars: JSON.stringify(candidate).length + 350 }
    expect((await inspect(checker, local, bound))?.promptTokens).toBe(base!.promptTokens + 100)
    expect(await inspect(checker, local, { ...bound, maxSerializedTextChars: 0 })).toEqual(base)
    expect(await inspect(checker, local, { ...bound, text: "absent" })).toBeUndefined()
    expect(await inspect({ ...checker, messages: [...messages, ...messages] }, local, bound)).toBeUndefined()
    const paired = { ...checker, messages: [{ role: "user" as const, content: "😀" }] }
    expect(await inspect(paired, local, { ...bound, text: "\ud83d" })).toBeUndefined()
    expect(await inspect(checker, local, { ...bound, maxSerializedTextChars: Number.NaN })).toBeUndefined()
  })

  test("refuses hosted search, presets, plugins and stored context while allowing a concrete OpenRouter free model", async () => {
    const prepared = request()
    const router = selected("@openrouter/ai-sdk-provider", "openrouter")
    const route = (id: string) => ({ ...router, id: ModelV2.ID.make(id), api: { ...router.api, id } })
    expect(await inspect(prepared, route("acme/coder:free"))).toBeDefined()
    for (const id of [
      "acme/coder:nitro:online",
      "acme/coder:online:free",
      "@preset/team",
      "openrouter/auto",
      "openai/gpt-4o-mini-search-preview",
      "openai/o4-mini-deep-research",
    ]) {
      expect(await inspect(prepared, route(id))).toBeUndefined()
    }
    for (const options of [
      { plugins: [{ id: "web" }] },
      { openrouter: { web_search_options: {} } },
      { preset: "team" },
      { model: "openai/gpt-4o-search-preview" },
      { fileData: { fileUri: "unmaterialized" } },
      { google: { cachedContent: "stored" } },
      { anthropic: { mcpServers: [] } },
      { anthropic: { container: "id" } },
    ]) {
      expect(await inspect({ ...prepared, params: { options } }, router)).toBeUndefined()
    }
    const compatible = { ...local, api: { ...local.api, id: "acme/coder:online" } }
    expect(await inspect(prepared, compatible)).toBeUndefined()
  })

  test("returns unavailable for opaque adapters, remote context, attachments and unavailable tool schemas", async () => {
    const prepared = request()
    expect(await inspect(prepared, selected("custom-review-adapter"))).toBeUndefined()
    expect(await inspect(prepared, selected("gitlab-ai-provider"))).toBeUndefined()
    expect(
      await inspect({
        ...prepared,
        messages: [
          {
            role: "user",
            content: [{ type: "file", mediaType: "text/plain", data: new URL("http://127.0.0.1:1/never-fetched") }],
          },
        ],
      }),
    ).toBeUndefined()
    expect(
      await inspect({ ...prepared, params: { options: { previousResponseId: "unmaterialized" } } }),
    ).toBeUndefined()
    const broken = tool({
      inputSchema: jsonSchema(async () => {
        throw new Error("unavailable schema")
      }),
    })
    expect(await inspect({ ...prepared, tools: { broken } })).toBeUndefined()
    for (const provider of ["lmstudio", "vector-plan", "local-free"]) {
      expect(await inspect(prepared, selected("@ai-sdk/openai-compatible", provider))).toBeDefined()
    }
  })
})
