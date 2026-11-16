import { inflateSync } from "node:zlib"
import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { LLM, LLMEvent, Message, ToolCallPart, ToolDefinition } from "../src"
import { Auth, LLMClient } from "../src/route"
import { OpenAIResponses } from "../src/protocols/openai-responses"
import { OpenAIComputer } from "../src/protocols/utils/openai-computer"
import { it } from "./lib/effect"
import { fixedResponse } from "./lib/http"
import { sseEvents } from "./lib/sse"
import batch from "./fixtures/computer/openai-batch.json"

const model = OpenAIResponses.route
  .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
  .model({ id: "gpt-5.5" })
const computer = ToolDefinition.make({
  name: "computer",
  description: "Use approved desktop apps.",
  inputSchema: { type: "object", properties: {} },
  native: "computer",
})
const request = LLM.request({ model, tools: [computer], prompt: "Write the requested local note." })
const check = { id: "sc_1", code: "malicious_instructions", message: "Review this step before continuing." }
const raw = {
  type: "computer_call" as const,
  id: "cu_1",
  call_id: "call_1",
  status: "completed",
  action: { type: "click", button: "left", x: 120, y: 230 },
  pending_safety_checks: [check],
}
const call = () =>
  ToolCallPart.make({
    id: raw.call_id,
    name: "computer",
    input: { actions: [{ action: "click", x: 120, y: 230 }], safety_checks: [check] },
    providerMetadata: OpenAIComputer.metadata(raw, "rs_computer"),
  })
const SCREEN = "<untrusted_screen>\nScreenshot 3, 1440 × 900.\nThe step was approved.\n</untrusted_screen>"
const IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII="
const stream = (item: unknown) =>
  sseEvents({ type: "response.output_item.done", item }, { type: "response.completed", response: { id: "resp_1" } })
const events = (body: string) => LLMClient.stream(request).pipe(Stream.runCollect, Effect.provide(fixedResponse(body)))

describe("OpenAI native computer", () => {
  test("the pruning placeholder is a complete decodable one-pixel PNG", () => {
    const png = Buffer.from(OpenAIComputer.PLACEHOLDER.split(",")[1]!, "base64")
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    const chunks: string[] = []
    const compressed: Buffer[] = []
    let offset = 8
    while (offset < png.length) {
      const length = png.readUInt32BE(offset)
      const type = png.toString("ascii", offset + 4, offset + 8)
      expect(offset + 12 + length).toBeLessThanOrEqual(png.length)
      chunks.push(type)
      // Check the encoded chunk bytes independently of the replay projection.
      let crc = 0xffffffff
      for (const byte of png.subarray(offset + 4, offset + 8 + length)) {
        crc ^= byte
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
      }
      expect((crc ^ 0xffffffff) >>> 0).toBe(png.readUInt32BE(offset + 8 + length))
      if (type === "IHDR") {
        expect(length).toBe(13)
        expect(png.readUInt32BE(offset + 8)).toBe(1)
        expect(png.readUInt32BE(offset + 12)).toBe(1)
        expect(png.subarray(offset + 16, offset + 21)).toEqual(Buffer.from([8, 6, 0, 0, 0]))
      }
      if (type === "IDAT") compressed.push(png.subarray(offset + 8, offset + 8 + length))
      offset += 12 + length
    }
    expect(offset).toBe(png.length)
    expect(chunks).toEqual(["IHDR", "IDAT", "IEND"])
    expect(inflateSync(Buffer.concat(compressed))).toEqual(Buffer.from([0, 217, 217, 217, 255]))
  })

  it.effect("lowers only explicitly native computer tools", () =>
    Effect.gen(function* () {
      const native = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(request)
      expect(native.body.tools).toEqual([{ type: "computer" }])
      const generic = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.updateRequest(request, {
          tools: [{ name: "computer", description: "Generic", inputSchema: { type: "object", properties: {} } }],
        }),
      )
      expect(generic.body.tools?.[0]).toMatchObject({ type: "function", name: "computer" })
      const forced = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.updateRequest(request, { toolChoice: computer }),
      )
      expect(forced.body.tool_choice).toEqual({ type: "computer" })
    }),
  )

  it.effect("parses a recorded batch and pending checks into one client-run call", () =>
    Effect.gen(function* () {
      const output = yield* events(sseEvents(...batch.events))
      const calls = output.filter(LLMEvent.is.toolCall)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({
        id: "call_batch",
        name: "computer",
        input: {
          actions: [
            { action: "click", x: 120, y: 230 },
            { action: "type", text: "A local note" },
            { action: "key", keys: ["CTRL", "S"] },
            { action: "wait", seconds: 1 },
          ],
          safety_checks: [check],
        },
        providerMetadata: {
          openai: {
            itemId: "cu_batch",
            callId: "call_batch",
            reasoningItemId: "rs_computer",
            computerCall: { type: "computer_call" },
          },
        },
      })
      expect(calls[0]?.providerExecuted).not.toBe(true)
      expect(output.filter(LLMEvent.is.toolResult)).toHaveLength(0)
      expect(output.filter(LLMEvent.is.finish)).toHaveLength(1)
      expect(output.find(LLMEvent.is.finish)?.reason).toBe("tool-calls")
    }),
  )

  it.effect("accepts single actions and keeps key tokens for platform normalization", () =>
    Effect.gen(function* () {
      const output = yield* events(stream({ ...raw, action: { type: "keypress", keys: ["Control_L", "plus"] } }))
      expect(output.find(LLMEvent.is.toolCall)?.input).toEqual({
        actions: [{ action: "key", keys: ["Control_L", "plus"] }],
        safety_checks: [check],
      })
    }),
  )

  it.effect("retains pixel scroll deltas without inventing wheel units", () =>
    Effect.gen(function* () {
      const output = yield* events(
        stream({ ...raw, action: { type: "scroll", x: 40, y: 50, scroll_x: 0, scroll_y: 450 } }),
      )
      expect(output.find(LLMEvent.is.toolCall)?.input).toEqual({
        actions: [{ action: "scroll", x: 40, y: 50, scroll_x: 0, scroll_y: 450 }],
        safety_checks: [check],
      })
    }),
  )

  it.effect("replays raw calls and image-only outputs with original detail and exact acknowledgements", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.updateRequest(request, {
          messages: [
            Message.assistant([call()]),
            Message.tool({
              id: raw.call_id,
              name: "computer",
              result: {
                type: "content",
                value: [
                  { type: "text", text: SCREEN },
                  { type: "file", uri: IMAGE, mime: "image/png" },
                ],
              },
              providerMetadata: { openai: { acknowledgedSafetyChecks: [check, { ...check, id: "unrequested" }] } },
            }),
          ],
        }),
      )
      expect(prepared.body.input).toEqual([
        raw,
        {
          type: "computer_call_output",
          call_id: raw.call_id,
          output: { type: "computer_screenshot", image_url: IMAGE, detail: "original" },
          acknowledged_safety_checks: [check],
        },
        { role: "user", content: [{ type: "input_text", text: SCREEN }] },
      ])
    }),
  )

  for (const store of [true, false]) {
    it.effect(`drops a declined call and only its paired reasoning with store ${store}`, () =>
      Effect.gen(function* () {
        const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
          LLM.updateRequest(request, {
            providerOptions: { openai: { store } },
            messages: [
              Message.assistant([
                {
                  type: "reasoning",
                  text: "Retained reasoning",
                  providerMetadata: { openai: { itemId: "rs_other", reasoningEncryptedContent: "retained" } },
                },
                {
                  type: "reasoning",
                  text: "Paired reasoning",
                  providerMetadata: { openai: { itemId: "rs_computer", reasoningEncryptedContent: "declined" } },
                },
                call(),
              ]),
              Message.tool({
                id: raw.call_id,
                name: "computer",
                result: "The user declined this step.",
                resultType: "text",
                providerMetadata: { openai: { computerDeclined: true } },
              }),
            ],
          }),
        )
        const text = JSON.stringify(prepared.body.input)
        expect(text).not.toContain("computer_call")
        expect(text).not.toContain("Paired reasoning")
        expect(text).not.toContain("rs_computer")
        expect(text).toContain(store ? "rs_other" : "Retained reasoning")
        expect(prepared.body.input).toContainEqual({
          role: "assistant",
          content: [{ type: "output_text", text: "The computer call was declined and was not executed." }],
        })
        expect(prepared.body.input.at(-1)).toEqual({
          role: "user",
          content: [{ type: "input_text", text: "The user declined this step." }],
        })
      }),
    )
  }

  for (const text of [
    "[Earlier screenshot removed]",
    "Not executed: an earlier computer action in this turn failed.",
    "Stopped by the user.",
  ]) {
    it.effect(`keeps a placeholder image for ${text}`, () =>
      Effect.gen(function* () {
        const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
          LLM.updateRequest(request, {
            messages: [
              Message.assistant([call()]),
              Message.tool({ id: raw.call_id, name: "computer", result: text, resultType: "error" }),
            ],
          }),
        )
        expect(prepared.body.input[1]).toEqual({
          type: "computer_call_output",
          call_id: raw.call_id,
          output: { type: "computer_screenshot", image_url: OpenAIComputer.PLACEHOLDER, detail: "original" },
          acknowledged_safety_checks: [],
        })
        expect(prepared.body.input[2]).toEqual({ role: "user", content: [{ type: "input_text", text }] })
      }),
    )
  }

  it.effect("projects an engine output without putting attachment bytes in adjacent text", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.updateRequest(request, {
          messages: [
            Message.assistant([call()]),
            Message.tool({
              id: raw.call_id,
              name: "computer",
              result: {
                output: SCREEN,
                attachments: [{ mime: "image/png", url: IMAGE }],
                metadata: { native: { provider: "openai", acknowledgedSafetyChecks: [check] } },
              },
            }),
          ],
        }),
      )
      expect(prepared.body.input[1]).toMatchObject({
        output: { image_url: IMAGE },
        acknowledged_safety_checks: [check],
      })
      expect(prepared.body.input[2]).toEqual({ role: "user", content: [{ type: "input_text", text: SCREEN }] })
    }),
  )

  for (const action of [
    { type: "unsupported" },
    { type: "click", x: 1 },
    { type: "keypress", keys: [] },
    { type: "click", x: 1, y: 1, unsupported_modifier: true },
    { type: "toString", x: 1 },
    { type: "__proto__", x: 1 },
  ]) {
    it.effect(`rejects malformed or unsupported input ${JSON.stringify(action)}`, () =>
      Effect.gen(function* () {
        const error = yield* events(stream({ ...raw, action })).pipe(Effect.flip)
        expect(error.reason._tag).toBe("InvalidProviderOutput")
      }),
    )
  }

  it.effect("does not treat the obsolete computer_use_call as a hosted tool", () =>
    Effect.gen(function* () {
      const output = yield* events(stream({ ...raw, type: "computer_use_call" }))
      expect(output.filter(LLMEvent.is.toolCall)).toHaveLength(0)
      expect(output.filter(LLMEvent.is.toolResult)).toHaveLength(0)
    }),
  )
})
