import { expect, test } from "bun:test"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { JsonSchemaCheck } from "@vectordevai/core/json-schema-check"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { createStructuredOutputTool } from "@/session/prompt"
import { ToolJsonSchema } from "@/tool/json-schema"
import { WorkflowTool } from "@/tool/workflow"

const schema: JSONSchema7 = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  maxProperties: 20,
  properties: {
    text: { type: "string", minLength: 2, maxLength: 4, enum: ["aa", "bbb"] },
    fixed: { type: "string", const: "ok" },
    n: { type: "number", minimum: 0, maximum: 10, exclusiveMinimum: 1, exclusiveMaximum: 9, multipleOf: 2 },
    items: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 2, uniqueItems: true },
    object: { type: "object", minProperties: 1, maxProperties: 2, additionalProperties: { type: "integer" } },
    nullable: { type: "string", nullable: true },
    any: { anyOf: [{ type: "integer" }, { type: "boolean" }] },
    one: { oneOf: [{ type: "number" }, { type: "boolean" }] },
    all: { allOf: [{ type: "string" }, { not: { const: "bad" } }] },
    ref: { $ref: "#/$defs/word", maxLength: 3 },
    legacy: { $ref: "#/definitions/count" },
    unrestricted: true,
    forbidden: false,
  },
  required: ["text", "fixed", "n", "items", "object", "nullable", "any", "one", "all", "ref", "legacy"],
  $defs: { word: { type: "string", minLength: 2 } },
  definitions: { count: { type: "integer" } },
} as JSONSchema7
const valid = {
  text: "aa",
  fixed: "ok",
  n: 4,
  items: ["a"],
  object: { x: 1 },
  nullable: null,
  any: true,
  one: 1,
  all: "yes",
  ref: "aa",
  legacy: 1,
  unrestricted: { nested: [false, null, 7] },
}
const invalid = [
  { ...valid, text: "x" },
  { ...valid, text: "aaaaa" },
  { ...valid, text: "cc" },
  { ...valid, fixed: "no" },
  { ...valid, n: 0 },
  { ...valid, n: 10 },
  { ...valid, n: 3 },
  { ...valid, items: [] },
  { ...valid, items: ["a", "b", "c"] },
  { ...valid, items: ["a", "a"] },
  { ...valid, object: {} },
  { ...valid, object: { x: 1, y: 2, z: 3 } },
  { ...valid, object: { x: "bad" } },
  { ...valid, nullable: 2 },
  { ...valid, any: "bad" },
  { ...valid, one: [] },
  { ...valid, all: "bad" },
  { ...valid, ref: "a" },
  { ...valid, ref: "abcd" },
  { ...valid, legacy: 1.5 },
  { ...valid, forbidden: null },
  { ...valid, extra: true },
]

const providers = [
  { id: "anthropic", npm: "@ai-sdk/anthropic", model: "claude-sonnet-4-20250514" },
  { id: "openai", npm: "@ai-sdk/openai", model: "gpt-4.1" },
  { id: "google", npm: "@ai-sdk/google", model: "gemini-2.5-flash" },
  { id: "moonshotai", npm: "@ai-sdk/openai-compatible", model: "kimi-k2" },
] as const
const metadata = (input: (typeof providers)[number]): Provider.Model => ({
  id: ModelV2.ID.make(input.model),
  providerID: ProviderV2.ID.make(input.id),
  api: { id: input.model, npm: input.npm, url: "https://fixture.invalid" },
  name: input.model,
  capabilities: {
    attachment: false,
    reasoning: false,
    temperature: true,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 128000, output: 8192 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
})

for (const provider of providers)
  test(`${provider.id} wire retains the bounded exact contract and engine rejects invalid output`, async () => {
    const checked = JsonSchemaCheck.accept(schema, { object: true })
    expect(checked.ok).toBe(true)
    if (!checked.ok) throw new Error(checked.reason)
    const model = metadata(provider)
    const structured = ProviderTransform.schema(model, schema, { restate: true })
    expect(structured.description).toContain(checked.normalized)
    expect(new TextEncoder().encode(JSON.stringify(structured)).byteLength).toBeLessThan(64 * 1024)
    let captured: string | undefined
    const fetch = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        captured = typeof init?.body === "string" ? init.body : undefined
        throw new Error("Offline fixture captured the wire request; no network was used")
      },
      { preconnect: () => undefined },
    )
    const api =
      provider.id === "anthropic"
        ? createAnthropic({ apiKey: "fixture", fetch })(provider.model)
        : provider.id === "openai"
          ? createOpenAI({ apiKey: "fixture", fetch })(provider.model)
          : provider.id === "google"
            ? createGoogleGenerativeAI({ apiKey: "fixture", fetch })(provider.model)
            : createOpenAICompatible({
                name: "moonshotai",
                baseURL: "https://fixture.invalid",
                apiKey: "fixture",
                fetch,
              })(provider.model)
    await api
      .doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "Return a checked object." }] }],
        tools: [
          { type: "function", name: "StructuredOutput", description: "Checked output", inputSchema: structured },
          {
            type: "function",
            name: "workflow",
            description: "Run workflow",
            inputSchema: ProviderTransform.schema(model, ToolJsonSchema.fromSchema(WorkflowTool.PublicParameters)),
          },
        ],
        maxOutputTokens: 1,
      })
      .then(
        () => undefined,
        () => undefined,
      )
    expect(captured).toBeDefined()
    const wire: unknown = JSON.parse(captured!)
    const strings = (value: unknown): string[] =>
      typeof value === "string"
        ? [value]
        : Array.isArray(value)
          ? value.flatMap(strings)
          : value && typeof value === "object"
            ? Object.values(value).flatMap(strings)
            : []
    expect(strings(wire).some((value) => value.includes(checked.normalized))).toBe(true)
    expect(strings(wire)).toContain("workflow")
    let saved = 0
    const tool = createStructuredOutputTool({
      schema: checked.schema,
      model,
      onSuccess: () => {
        saved++
      },
      retryCount: 5,
    })
    const result = await tool.execute!(valid, { toolCallId: "valid", messages: [] })
    expect(result).toMatchObject({ metadata: { valid: true } })
    expect(saved).toBe(1)
    for (const value of invalid) {
      expect(JsonSchemaCheck.validate(checked.schema, value).length).toBeGreaterThan(0)
      const reject = createStructuredOutputTool({
        schema: checked.schema,
        model,
        onSuccess: () => {
          saved++
        },
        retryCount: 5,
      })
      expect(await reject.execute!(value, { toolCallId: "invalid", messages: [] })).toMatchObject({
        metadata: { valid: false },
      })
    }
    expect(saved).toBe(1)
  })

test("restatement does not change ordinary transforms or admit cyclic/deep/oversized schemas", () => {
  const model = metadata(providers[1])
  expect(
    ProviderTransform.schema(model, { type: "object", properties: { n: { type: "number", minimum: 2 } } }),
  ).toEqual({ type: "object", properties: { n: { type: "number" } } })
  expect(JsonSchemaCheck.accept({ type: "object", $ref: "#" }).ok).toBe(false)
  expect(JsonSchemaCheck.accept({ type: "object", description: "x".repeat(16 * 1024) }).ok).toBe(false)
  let nested: unknown = { type: "string" }
  for (let i = 0; i < 9; i++) nested = { type: "object", properties: { next: nested } }
  expect(JsonSchemaCheck.accept(nested).ok).toBe(false)
})
