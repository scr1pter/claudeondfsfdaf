import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LLM, LLMError, Message, ToolCallPart, ToolDefinition } from "../src"
import { Auth, LLMClient } from "../src/route"
import { AnthropicMessages } from "../src/protocols/anthropic-messages"
import { it } from "./lib/effect"
import { dynamicResponse, fixedResponse } from "./lib/http"
import { sseEvents } from "./lib/sse"

const model = AnthropicMessages.route
  .with({ endpoint: { baseURL: "https://api.anthropic.test/v1/" }, auth: Auth.header("x-api-key", "test") })
  .model({ id: "claude-sonnet-5-5" })

const computer = ToolDefinition.make({
  name: "computer",
  description: "Use the approved desktop apps.",
  inputSchema: { type: "object", properties: { action: { type: "string" } } },
  native: "computer",
})

const BATCH_FAILURE = "Not executed: an earlier computer action in this turn failed."
const SCREEN = "<untrusted_screen>\nScreenshot 3, 1440 × 900.\n</untrusted_screen>"
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII="

const call = (id = "toolu_computer_1", member = "click", input: Record<string, unknown> = { coordinate: [120, 230] }) =>
  ToolCallPart.make({
    id,
    name: "computer",
    input: { member, ...input },
    providerMetadata: { anthropic: { toolset_name: "computer", member, input } },
  })

const stream = (input: unknown, partial?: readonly string[]) =>
  sseEvents(
    { type: "message_start", message: { usage: { input_tokens: 12 } } },
    {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "toolu_computer_1",
        name: "click",
        toolset_name: "computer",
        input,
      },
    },
    ...(partial ?? []).map((part) => ({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: part },
    })),
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } },
    { type: "message_stop" },
  )

const request = LLM.request({ model, prompt: "Click the approved app.", tools: [computer], cache: "none" })

describe("Anthropic computer toolset", () => {
  it.effect("lowers a native computer definition without a function name or schema", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(request)

      expect(prepared.body.tools).toEqual([{ type: "computer_toolset_20260801", configs: { zoom: { enabled: true } } }])
      expect(prepared.body.tools?.[0]).not.toHaveProperty("name")
      expect(prepared.body.tools?.[0]).not.toHaveProperty("input_schema")
    }),
  )

  it.effect("keeps generic computer definitions as ordinary function tools", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(
        LLM.updateRequest(request, {
          tools: [
            ToolDefinition.make({
              name: "computer",
              description: "Generic desktop tool.",
              inputSchema: { type: "object", properties: {} },
            }),
          ],
        }),
      )

      expect(prepared.body.tools).toEqual([
        { name: "computer", description: "Generic desktop tool.", input_schema: { type: "object", properties: {} } },
      ])
    }),
  )

  it.effect("withholds the native toolset when tool choice is none", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(
        LLM.updateRequest(request, { toolChoice: "none" }),
      )
      expect(prepared.body.tools).toBeUndefined()
    }),
  )

  it.effect("lowers typed server-side tool clearing without editing signed history", () =>
    Effect.gen(function* () {
      const messages = [
        Message.assistant([
          {
            type: "reasoning",
            text: "Inspect the approved app.",
            providerMetadata: { anthropic: { signature: "signed" } },
          },
          call(),
        ]),
        Message.tool({
          id: "toolu_computer_1",
          name: "computer",
          result: SCREEN,
          resultType: "text",
        }),
      ]
      const prepared = yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(
        LLM.updateRequest(request, {
          messages,
          providerOptions: {
            anthropic: {
              contextManagement: {
                edits: [
                  {
                    type: "clear_tool_uses_20250919",
                    trigger: { type: "tool_uses", value: 28 },
                    keep: { type: "tool_uses", value: 3 },
                    clearAtLeast: { type: "input_tokens", value: 1000 },
                    clearToolInputs: false,
                    excludeTools: ["read", "edit"],
                  },
                ],
              },
            },
          },
        }),
      )
      expect(prepared.body.context_management).toEqual({
        edits: [
          {
            type: "clear_tool_uses_20250919",
            trigger: { type: "tool_uses", value: 28 },
            keep: { type: "tool_uses", value: 3 },
            clear_at_least: { type: "input_tokens", value: 1000 },
            clear_tool_inputs: false,
            exclude_tools: ["read", "edit"],
          },
        ],
      })
      expect(prepared.body.messages[0]?.content[0]).toEqual({
        type: "thinking",
        thinking: "Inspect the approved app.",
        signature: "signed",
      })
      expect(messages[0]?.content[0]).toMatchObject({ type: "reasoning", text: "Inspect the approved app." })
    }),
  )

  it.effect("merges the context-management beta with caller beta headers", () =>
    Effect.gen(function* () {
      yield* LLMClient.generate(
        LLM.updateRequest(request, {
          http: { headers: { "Anthropic-Beta": "other-beta,context-management-2025-06-27", "x-client": "fixture" } },
          providerOptions: {
            anthropic: {
              contextManagement: {
                edits: [{ type: "clear_tool_uses_20250919", keep: { type: "tool_uses", value: 3 } }],
              },
            },
          },
        }),
      ).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.sync(() => {
              expect(input.request.headers["anthropic-beta"]).toBe("other-beta,context-management-2025-06-27")
              expect(input.request.headers["x-client"]).toBe("fixture")
              expect(input.request.headers["anthropic-version"]).toBe("2023-06-01")
              return input.respond(sseEvents({ type: "message_delta", delta: { stop_reason: "end_turn" } }), {
                headers: { "content-type": "text/event-stream" },
              })
            }),
          ),
        ),
      )
    }),
  )

  for (const contextManagement of [
    { edits: [{ type: "clear_tool_uses_20250919", keep: { type: "tool_uses", value: -1 } }] },
    { edits: [{ type: "unsupported_edit" }] },
  ]) {
    it.effect(`refuses unsupported or malformed context edits: ${JSON.stringify(contextManagement)}`, () =>
      Effect.gen(function* () {
        const error = yield* LLMClient.prepare(
          LLM.updateRequest(request, {
            providerOptions: { anthropic: { contextManagement } },
          }),
        ).pipe(Effect.flip)
        expect(error).toBeInstanceOf(LLMError)
        expect(error.reason).toMatchObject({ _tag: "InvalidRequest" })
      }),
    )
  }

  it.effect("parses a streamed toolset member as one local computer call", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(fixedResponse(stream({}, ['{"coordinate":', "[120,230]}"]))),
      )

      expect(response.toolCalls).toHaveLength(1)
      expect(response.toolCalls[0]).toMatchObject(call())
      expect(response.toolCalls[0]?.providerExecuted).not.toBe(true)
      expect(response.events.filter((event) => event.type === "tool-call")).toHaveLength(1)
      expect(response.events.at(-1)).toMatchObject({ type: "finish", reason: "tool-calls" })
    }),
  )

  it.effect("parses complete input from the toolset start block", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(fixedResponse(stream({ coordinate: [120, 230] }))),
      )

      expect(response.toolCalls).toHaveLength(1)
      expect(response.toolCalls[0]).toMatchObject(call())
    }),
  )

  it.effect("round-trips the parsed member and preserves its image and fenced screen text", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(fixedResponse(stream({}, ['{"coordinate":[120,230]}']))),
      )
      const prepared = yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(
        LLM.updateRequest(request, {
          messages: [
            Message.user("Click the approved app."),
            response.message,
            Message.tool({
              id: "toolu_computer_1",
              name: "computer",
              resultType: "content",
              result: [
                { type: "file", mime: "image/png", uri: `data:image/png;base64,${PIXEL}` },
                { type: "text", text: SCREEN },
              ],
            }),
          ],
        }),
      )

      expect(prepared.body.messages[1]).toEqual({
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_computer_1",
            name: "click",
            toolset_name: "computer",
            input: { coordinate: [120, 230] },
          },
        ],
      })
      expect(prepared.body.messages[2]).toEqual({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_computer_1",
            toolset_name: "computer",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/png", data: PIXEL } },
              { type: "text", text: SCREEN },
            ],
          },
        ],
      })
    }),
  )

  it.effect("projects the engine's raw computer output into images and text", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(
        LLM.updateRequest(request, {
          messages: [
            Message.assistant([call()]),
            Message.tool({
              id: "toolu_computer_1",
              name: "computer",
              result: {
                output: SCREEN,
                metadata: { code: "stopped", frame: { id: "frame-3" } },
                attachments: [{ mime: "image/png", url: `data:image/png;base64,${PIXEL}` }],
              },
            }),
          ],
        }),
      )
      expect(prepared.body.messages[1]?.content).toEqual([
        {
          type: "tool_result",
          tool_use_id: "toolu_computer_1",
          toolset_name: "computer",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: PIXEL } },
            { type: "text", text: SCREEN },
          ],
          is_error: true,
        },
      ])
    }),
  )

  it.effect("keeps the wire member authoritative when an input contains a member field", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(fixedResponse(stream({ coordinate: [120, 230], member: "screenshot" }))),
      )
      expect(response.toolCalls[0]?.input).toEqual({ coordinate: [120, 230], member: "click" })
      const prepared = yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(
        LLM.updateRequest(request, {
          messages: [response.message, Message.tool({ id: "toolu_computer_1", name: "computer", result: "Done." })],
        }),
      )
      expect(prepared.body.messages[0]?.content).toEqual([
        {
          type: "tool_use",
          id: "toolu_computer_1",
          name: "click",
          input: { coordinate: [120, 230], member: "screenshot" },
          toolset_name: "computer",
        },
      ])
    }),
  )

  it.effect("round-trips zoom coordinates without changing their screenshot space", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(
        LLM.updateRequest(request, {
          messages: [
            Message.assistant([call("toolu_zoom", "zoom", { region: [100, 200, 600, 700] })]),
            Message.tool({ id: "toolu_zoom", name: "computer", result: SCREEN, resultType: "text" }),
            Message.assistant([call("toolu_click", "click", { coordinate: [1200, 800] })]),
          ],
        }),
      )
      expect(prepared.body.messages[0]?.content).toMatchObject([
        { name: "zoom", toolset_name: "computer", input: { region: [100, 200, 600, 700] } },
      ])
      expect(prepared.body.messages[2]?.content).toMatchObject([
        { name: "click", toolset_name: "computer", input: { coordinate: [1200, 800] } },
      ])
    }),
  )

  for (const text of [
    "The user stopped computer use.",
    "The user did not approve this sensitive action.",
    BATCH_FAILURE,
  ]) {
    it.effect(`echoes the toolset on a synthesized error: ${text}`, () =>
      Effect.gen(function* () {
        const prepared = yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(
          LLM.updateRequest(request, {
            // Replay remains valid after the current request stops offering Hands.
            tools: [],
            messages: [
              Message.assistant([call()]),
              Message.tool({ id: "toolu_computer_1", name: "computer", result: text, resultType: "error" }),
            ],
          }),
        )

        expect(prepared.body.messages[1]).toEqual({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_computer_1",
              toolset_name: "computer",
              content: [{ type: "text", text }],
              is_error: true,
            },
          ],
        })
      }),
    )
  }

  it.effect("marks the exact batch-failure text as an error even in a text result", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(
        LLM.updateRequest(request, {
          messages: [
            Message.assistant([call()]),
            Message.tool({ id: "toolu_computer_1", name: "computer", result: BATCH_FAILURE, resultType: "text" }),
          ],
        }),
      )
      expect(prepared.body.messages[1]).toEqual({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_computer_1",
            toolset_name: "computer",
            content: [{ type: "text", text: BATCH_FAILURE }],
            is_error: true,
          },
        ],
      })
    }),
  )

  it.effect("marks a persisted declined computer result as an error", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(
        LLM.updateRequest(request, {
          messages: [
            Message.assistant([call()]),
            Message.tool({
              id: "toolu_computer_1",
              name: "computer",
              result: "The user stopped computer use.",
              resultType: "text",
              providerMetadata: { anthropic: { computerDeclined: true } },
            }),
          ],
        }),
      )
      expect(prepared.body.messages[1]?.content[0]).toMatchObject({ toolset_name: "computer", is_error: true })
    }),
  )

  it.effect("preserves a partially executed call while marking its persisted capture failure as an error", () =>
    Effect.gen(function* () {
      const failure = "<untrusted_screen>\nThe action ran, but a fresh screenshot was unavailable.\n</untrusted_screen>"
      const prepared = yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(
        LLM.updateRequest(request, {
          messages: [
            Message.assistant([call()]),
            Message.tool({
              id: "toolu_computer_1",
              name: "computer",
              result: [{ type: "text", text: failure }],
              resultType: "content",
              providerMetadata: { anthropic: { computerDeclined: false, computerError: true } },
            }),
          ],
        }),
      )
      expect(prepared.body.messages[0]?.content).toEqual([
        {
          type: "tool_use",
          id: "toolu_computer_1",
          name: "click",
          input: { coordinate: [120, 230] },
          toolset_name: "computer",
        },
      ])
      expect(prepared.body.messages[1]?.content).toEqual([
        {
          type: "tool_result",
          tool_use_id: "toolu_computer_1",
          toolset_name: "computer",
          content: [{ type: "text", text: failure }],
          is_error: true,
        },
      ])
    }),
  )

  it.effect("does not label unrelated function results as computer toolset results", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(
        LLM.updateRequest(request, {
          messages: [
            Message.assistant([
              call(),
              ToolCallPart.make({ id: "toolu_lookup", name: "lookup", input: { query: "weather" } }),
            ]),
            Message.make({
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  id: "toolu_computer_1",
                  name: "computer",
                  result: { type: "text", value: SCREEN },
                },
                { type: "tool-result", id: "toolu_lookup", name: "lookup", result: { type: "text", value: "Sunny" } },
              ],
            }),
          ],
        }),
      )

      expect(prepared.body.messages[1]?.content).toEqual([
        {
          type: "tool_result",
          tool_use_id: "toolu_computer_1",
          toolset_name: "computer",
          content: [{ type: "text", text: SCREEN }],
        },
        { type: "tool_result", tool_use_id: "toolu_lookup", content: "Sunny" },
      ])
    }),
  )

  for (const input of [null, [], "click"]) {
    it.effect(`refuses a toolset call with non-object input ${JSON.stringify(input)}`, () =>
      Effect.gen(function* () {
        const error = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(stream(input))), Effect.flip)
        expect(error).toBeInstanceOf(LLMError)
        expect(error.reason).toMatchObject({ _tag: "InvalidProviderOutput" })
      }),
    )
  }

  it.effect("refuses malformed streamed toolset JSON", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(request).pipe(
        Effect.provide(fixedResponse(stream({}, ['{"coordinate":']))),
        Effect.flip,
      )
      expect(error).toBeInstanceOf(LLMError)
      expect(error.reason).toMatchObject({ _tag: "InvalidProviderOutput" })
    }),
  )
})
