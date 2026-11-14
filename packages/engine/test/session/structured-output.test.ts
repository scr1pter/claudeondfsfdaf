import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { Exit, Schema } from "effect"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionID, MessageID } from "../../src/session/schema"

const decodeFormat = Schema.decodeUnknownExit(SessionV1.Format)
const decodeUser = Schema.decodeUnknownExit(SessionV1.User)
const decodeAssistant = Schema.decodeUnknownExit(SessionV1.Assistant)

describe("structured-output.OutputFormat", () => {
  test("parses text format", () => {
    const result = decodeFormat({ type: "text" })
    expect(Exit.isSuccess(result)).toBe(true)
    if (Exit.isSuccess(result)) {
      expect(result.value.type).toBe("text")
    }
  })

  test("parses json_schema format with defaults", () => {
    const result = decodeFormat({
      type: "json_schema",
      schema: { type: "object", properties: { name: { type: "string" } } },
    })
    expect(Exit.isSuccess(result)).toBe(true)
    if (Exit.isSuccess(result)) {
      expect(result.value.type).toBe("json_schema")
      if (result.value.type === "json_schema") {
        expect(result.value.retryCount).toBe(2) // default value
      }
    }
  })

  test("parses json_schema format with custom retryCount", () => {
    const result = decodeFormat({
      type: "json_schema",
      schema: { type: "object" },
      retryCount: 5,
    })
    expect(Exit.isSuccess(result)).toBe(true)
    if (Exit.isSuccess(result) && result.value.type === "json_schema") {
      expect(result.value.retryCount).toBe(5)
    }
  })

  test("rejects invalid type", () => {
    const result = decodeFormat({ type: "invalid" })
    expect(Exit.isFailure(result)).toBe(true)
  })

  test("rejects json_schema without schema", () => {
    const result = decodeFormat({ type: "json_schema" })
    expect(Exit.isFailure(result)).toBe(true)
  })

  test("rejects negative retryCount", () => {
    const result = decodeFormat({
      type: "json_schema",
      schema: { type: "object" },
      retryCount: -1,
    })
    expect(Exit.isFailure(result)).toBe(true)
  })
})

describe("structured-output.StructuredOutputError", () => {
  test("creates error with message and retries", () => {
    const error = new SessionV1.StructuredOutputError({
      message: "Failed to validate",
      retries: 3,
    })

    expect(error.name).toBe("StructuredOutputError")
    expect(error.data.message).toBe("Failed to validate")
    expect(error.data.retries).toBe(3)
  })

  test("converts to object correctly", () => {
    const error = new SessionV1.StructuredOutputError({
      message: "Test error",
      retries: 2,
    })

    const obj = error.toObject()
    expect(obj.name).toBe("StructuredOutputError")
    expect(obj.data.message).toBe("Test error")
    expect(obj.data.retries).toBe(2)
  })

  test("isInstance correctly identifies error", () => {
    const error = new SessionV1.StructuredOutputError({
      message: "Test",
      retries: 1,
    })

    expect(SessionV1.StructuredOutputError.isInstance(error)).toBe(true)
    expect(SessionV1.StructuredOutputError.isInstance({ name: "other" })).toBe(false)
  })
})

describe("structured-output.UserMessage", () => {
  test("user message accepts outputFormat", () => {
    const result = decodeUser({
      id: MessageID.ascending(),
      sessionID: SessionID.descending(),
      role: "user",
      time: { created: Date.now() },
      agent: "default",
      model: { providerID: "anthropic", modelID: "claude-3" },
      outputFormat: {
        type: "json_schema",
        schema: { type: "object" },
      },
    })
    expect(Exit.isSuccess(result)).toBe(true)
  })

  test("user message works without outputFormat (optional)", () => {
    const result = decodeUser({
      id: MessageID.ascending(),
      sessionID: SessionID.descending(),
      role: "user",
      time: { created: Date.now() },
      agent: "default",
      model: { providerID: "anthropic", modelID: "claude-3" },
    })
    expect(Exit.isSuccess(result)).toBe(true)
  })
})

describe("structured-output.AssistantMessage", () => {
  const baseAssistantMessage = {
    id: MessageID.ascending(),
    sessionID: SessionID.descending(),
    role: "assistant" as const,
    parentID: MessageID.ascending(),
    modelID: "claude-3",
    providerID: "anthropic",
    mode: "default",
    agent: "default",
    path: { cwd: "/test", root: "/test" },
    cost: 0.001,
    tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now() },
  }

  test("assistant message accepts structured", () => {
    const result = decodeAssistant({
      ...baseAssistantMessage,
      structured: { company: "Anthropic", founded: 2021 },
    })
    expect(Exit.isSuccess(result)).toBe(true)
    if (Exit.isSuccess(result)) {
      expect(result.value.structured).toEqual({ company: "Anthropic", founded: 2021 })
    }
  })

  test("assistant message works without structured_output (optional)", () => {
    const result = decodeAssistant(baseAssistantMessage)
    expect(Exit.isSuccess(result)).toBe(true)
  })
})

describe("structured-output.createStructuredOutputTool", () => {
  test("creates tool with description", () => {
    const tool = SessionPrompt.createStructuredOutputTool({
      schema: { type: "object" },
      onSuccess: () => {},
    })

    expect(tool.description).toContain("structured format")
  })

  test("creates tool with schema as inputSchema", () => {
    const schema = {
      type: "object",
      properties: {
        company: { type: "string" },
        founded: { type: "number" },
      },
      required: ["company"],
    }

    const tool = SessionPrompt.createStructuredOutputTool({
      schema,
      onSuccess: () => {},
    })

    // AI SDK wraps schema in { jsonSchema: {...} }
    expect(tool.inputSchema).toBeDefined()
    const inputSchema = tool.inputSchema as any
    expect(inputSchema.jsonSchema?.properties?.company).toBeDefined()
    expect(inputSchema.jsonSchema?.properties?.founded).toBeDefined()
  })

  test("strips $schema property from inputSchema", () => {
    const schema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { name: { type: "string" } },
    }

    const tool = SessionPrompt.createStructuredOutputTool({
      schema,
      onSuccess: () => {},
    })

    // AI SDK wraps schema in { jsonSchema: {...} }
    const inputSchema = tool.inputSchema as any
    expect(inputSchema.jsonSchema?.$schema).toBeUndefined()
  })

  test("execute calls onSuccess with valid args", async () => {
    let capturedOutput: unknown

    const tool = SessionPrompt.createStructuredOutputTool({
      schema: { type: "object", properties: { name: { type: "string" } } },
      onSuccess: (output) => {
        capturedOutput = output
      },
    })

    expect(tool.execute).toBeDefined()
    const testArgs = { name: "Test Company" }
    const result = await tool.execute!(testArgs, {
      toolCallId: "test-call-id",
      messages: [],
      abortSignal: undefined as any,
    })

    expect(capturedOutput).toEqual(testArgs)
    expect(result.output).toBe("Structured output captured successfully.")
    expect(result.metadata.valid).toBe(true)
  })

  test("advertises required fields in the input schema", async () => {
    // The AI SDK does not check a JSON Schema tool's input; execute() does (see the validation tests below).
    const tool = SessionPrompt.createStructuredOutputTool({
      schema: {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
        },
        required: ["name", "age"],
      },
      onSuccess: () => {},
    })

    // The schema requires both 'name' and 'age'
    expect(tool.inputSchema).toBeDefined()
    const inputSchema = tool.inputSchema as any
    expect(inputSchema.jsonSchema?.required).toContain("name")
    expect(inputSchema.jsonSchema?.required).toContain("age")
  })

  test("advertises property types in the input schema", async () => {
    const tool = SessionPrompt.createStructuredOutputTool({
      schema: {
        type: "object",
        properties: {
          count: { type: "number" },
        },
        required: ["count"],
      },
      onSuccess: () => {},
    })

    // The schema defines 'count' as a number
    expect(tool.inputSchema).toBeDefined()
    const inputSchema = tool.inputSchema as any
    expect(inputSchema.jsonSchema?.properties?.count?.type).toBe("number")
  })

  test("execute handles nested objects", async () => {
    let capturedOutput: unknown

    const tool = SessionPrompt.createStructuredOutputTool({
      schema: {
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: {
              name: { type: "string" },
              email: { type: "string" },
            },
            required: ["name"],
          },
        },
        required: ["user"],
      },
      onSuccess: (output) => {
        capturedOutput = output
      },
    })

    // Valid nested object
    const validResult = await tool.execute!(
      { user: { name: "John", email: "john@test.com" } },
      {
        toolCallId: "test-call-id",
        messages: [],
        abortSignal: undefined as any,
      },
    )

    expect(capturedOutput).toEqual({ user: { name: "John", email: "john@test.com" } })
    expect(validResult.metadata.valid).toBe(true)

    // Verify schema has correct nested structure
    const inputSchema = tool.inputSchema as any
    expect(inputSchema.jsonSchema?.properties?.user?.type).toBe("object")
    expect(inputSchema.jsonSchema?.properties?.user?.properties?.name?.type).toBe("string")
    expect(inputSchema.jsonSchema?.properties?.user?.required).toContain("name")
  })

  test("execute handles arrays", async () => {
    let capturedOutput: unknown

    const tool = SessionPrompt.createStructuredOutputTool({
      schema: {
        type: "object",
        properties: {
          tags: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["tags"],
      },
      onSuccess: (output) => {
        capturedOutput = output
      },
    })

    // Valid array
    const validResult = await tool.execute!(
      { tags: ["a", "b", "c"] },
      {
        toolCallId: "test-call-id",
        messages: [],
        abortSignal: undefined as any,
      },
    )

    expect(capturedOutput).toEqual({ tags: ["a", "b", "c"] })
    expect(validResult.metadata.valid).toBe(true)

    // Verify schema has correct array structure
    const inputSchema = tool.inputSchema as any
    expect(inputSchema.jsonSchema?.properties?.tags?.type).toBe("array")
    expect(inputSchema.jsonSchema?.properties?.tags?.items?.type).toBe("string")
  })

  test("toModelOutput returns text value", async () => {
    const tool = SessionPrompt.createStructuredOutputTool({
      schema: { type: "object" },
      onSuccess: () => {},
    })

    expect(tool.toModelOutput).toBeDefined()
    const modelOutput = await Promise.resolve(
      tool.toModelOutput!({
        toolCallId: "test-call-id",
        input: {},
        output: {
          output: "Test output",
        },
      }),
    )

    expect(modelOutput.type).toBe("text")
    if (modelOutput.type !== "text") throw new Error("expected text model output")
    expect(modelOutput.value).toBe("Test output")
  })
})

describe("structured-output.validation", () => {
  const schema = {
    type: "object",
    properties: { answer: { type: "number" } },
    required: ["answer"],
    additionalProperties: false,
  }
  const options = { toolCallId: "call", messages: [], abortSignal: undefined as any }

  // The run loop builds the tool again for every step and keeps the count of invalid calls itself.
  const step = (input: { invalid: { count: number }; retryCount?: number; kept: unknown[]; schema?: object }) =>
    SessionPrompt.createStructuredOutputTool({
      schema: input.schema ?? schema,
      onSuccess: (output) => input.kept.push(output),
      retryCount: input.retryCount,
      invalid: input.invalid,
    })

  test("invalid calls on separate steps get an error up to retryCount, then the value is kept as invalid", async () => {
    const invalid = { count: 0 }
    const kept: unknown[] = []
    for (const attempt of [1, 2]) {
      const result = await step({ invalid, retryCount: 2, kept }).execute!({ answer: "four" }, options)
      expect(result.metadata).toEqual({ valid: false })
      expect(result.output).toBe(
        "Invalid structured output: /answer must be number, not string. Call StructuredOutput again with JSON that matches the schema.",
      )
      expect(invalid.count).toBe(attempt)
      expect(kept).toEqual([])
    }
    const last = await step({ invalid, retryCount: 2, kept }).execute!({ answer: "four", extra: true }, options)
    expect(last.metadata).toEqual({ valid: false, captured: true })
    expect(kept).toEqual([{ answer: "four", extra: true }])
  })

  test("a valid call after invalid ones is kept as valid", async () => {
    const invalid = { count: 0 }
    const kept: unknown[] = []
    expect((await step({ invalid, kept }).execute!({}, options)).metadata).toEqual({ valid: false })
    expect((await step({ invalid, kept }).execute!({ answer: 4 }, options)).metadata).toEqual({ valid: true })
    expect(kept).toEqual([{ answer: 4 }])
  })

  test("the count defaults to the format's retryCount of 2", async () => {
    const invalid = { count: 0 }
    const kept: unknown[] = []
    for (const _ of [1, 2]) await step({ invalid, kept }).execute!({}, options)
    expect(kept).toEqual([])
    expect((await step({ invalid, kept }).execute!({}, options)).metadata).toEqual({ valid: false, captured: true })
  })

  test("a large retryCount stops at 5 invalid calls, so a caller cannot run up unbounded steps", async () => {
    const invalid = { count: 0 }
    const kept: unknown[] = []
    for (const _ of [1, 2, 3, 4, 5])
      expect((await step({ invalid, retryCount: 1000, kept }).execute!({}, options)).metadata).toEqual({ valid: false })
    expect(invalid.count).toBe(5)
    const last = await step({ invalid, retryCount: 1000, kept }).execute!({}, options)
    expect(last.metadata).toEqual({ valid: false, captured: true })
    expect(kept).toEqual([{}])
  })

  test("retryCount 0 keeps an invalid value at once", async () => {
    const invalid = { count: 0 }
    const kept: unknown[] = []
    const result = await step({ invalid, retryCount: 0, kept }).execute!({ answer: "four" }, options)
    expect(result.metadata).toEqual({ valid: false, captured: true })
    expect(result.output).toBe("Structured output captured successfully.")
    expect(kept).toEqual([{ answer: "four" }])
    expect(invalid.count).toBe(0)
  })

  test("a schema the checker refuses is passed on and not validated", async () => {
    const invalid = { count: 0 }
    const kept: unknown[] = []
    const refused = { type: "object", properties: { code: { type: "string", pattern: "^[A-Z]+$" } } }
    const tool = step({ invalid, retryCount: 2, kept, schema: refused })
    expect((tool.inputSchema as any).jsonSchema.properties.code.pattern).toBe("^[A-Z]+$")
    const result = await tool.execute!({ code: 42 }, options)
    expect(result.metadata).toEqual({ valid: true })
    expect(kept).toEqual([{ code: 42 }])
  })

  test("bounds a provider drops are restated in the schema rendered for it", () => {
    const bounded = {
      type: "object",
      properties: { score: { type: "integer", description: "Score", minimum: 1, maximum: 5 } },
      required: ["score"],
    }
    const render = (npm: string) =>
      (
        SessionPrompt.createStructuredOutputTool({
          schema: bounded,
          onSuccess: () => {},
          model: { providerID: "p", id: "m", api: { id: "m", npm } } as any,
        }).inputSchema as any
      ).jsonSchema.properties.score
    expect(render("@ai-sdk/openai")).toEqual({ type: "integer", description: "Score (minimum: 1, maximum: 5)" })
    expect(render("@ai-sdk/google").description).toBe("Score (minimum: 1, maximum: 5)")
    // Anthropic keeps every bound, so nothing is restated.
    expect(render("@ai-sdk/anthropic")).toEqual(bounded.properties.score)
  })
})
