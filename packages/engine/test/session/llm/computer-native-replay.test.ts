import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { MessageV2 } from "@/session/message-v2"
import { LLMNative } from "@/session/llm/native-request"
import { MessageID, PartID, SessionID } from "@/session/schema"
import type { Provider } from "@/provider/provider"
import { testEffect } from "../../lib/effect"

const it = testEffect(Layer.empty)
const model: Provider.Model = {
  id: ModelV2.ID.make("gpt-5.5"),
  providerID: ProviderV2.ID.make("openai"),
  api: { id: "gpt-5.5", npm: "@ai-sdk/openai", url: "https://api.openai.com/v1" },
  name: "fixture",
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: { text: true, image: true, audio: false, video: false, pdf: false },
    output: { text: true, image: false, audio: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 200000, output: 16000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}
const sessionID = SessionID.make("ses_native_replay")
const messageID = MessageID.make("msg_native_replay")
const check = { id: "check_1", code: "fixture", message: "Check this step." }
const raw = {
  type: "computer_call",
  id: "cu_1",
  call_id: "call_1",
  action: { type: "click", x: 10, y: 20, button: "left" },
  pending_safety_checks: [check],
}

function history(state?: SessionV1.ToolPart["state"]): SessionV1.WithParts[] {
  return [
    {
      info: {
        id: messageID,
        sessionID,
        role: "assistant",
        parentID: MessageID.make("msg_native_user"),
        time: { created: 0 },
        modelID: model.id,
        providerID: model.providerID,
        mode: "build",
        agent: "build",
        path: { cwd: "/fixture", root: "/fixture" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [
        {
          id: PartID.make("prt_native_call"),
          sessionID,
          messageID,
          type: "tool",
          tool: "computer",
          callID: "call_1",
          metadata: { openai: { computerCall: raw, itemId: "cu_1", callId: "call_1" } },
          state: state ?? {
            status: "completed",
            input: { actions: [{ action: "click", x: 10, y: 20 }], safety_checks: [check] },
            output: "<untrusted_screen>Frame 1</untrusted_screen>",
            title: "fixture",
            time: { start: 0, end: 1 },
            metadata: {
              native: { provider: "openai", acknowledgedSafetyChecks: [check], computerDeclined: false },
            },
            attachments: [
              {
                id: PartID.make("prt_native_image"),
                sessionID,
                messageID,
                type: "file",
                mime: "image/png",
                url: "data:image/png;base64,aW1hZ2U=",
              },
            ],
          },
        },
      ],
    },
  ]
}

it.effect("native result replay retains screenshot content and only the confirmed acknowledgements", () =>
  Effect.gen(function* () {
    const stored = history()
    const before = JSON.stringify(stored)
    const messages = yield* MessageV2.toModelMessagesEffect(stored, model)
    expect(messages.filter((message) => message.role === "user")).toHaveLength(0)
    const request = LLMNative.request({ model, apiKey: "fixture", messages })
    const call = request.messages.flatMap((message) => message.content).find((part) => part.type === "tool-call")
    const result = request.messages.flatMap((message) => message.content).find((part) => part.type === "tool-result")
    expect(call?.providerMetadata?.openai?.computerCall).toEqual(raw)
    expect(result?.providerMetadata?.openai).toMatchObject({
      acknowledgedSafetyChecks: [check],
      computerDeclined: false,
    })
    expect(result?.result).toEqual({
      type: "content",
      value: [
        { type: "text", text: "<untrusted_screen>Frame 1</untrusted_screen>" },
        { type: "file", mime: "image/png", uri: "data:image/png;base64,aW1hZ2U=" },
      ],
    })
    expect(JSON.stringify(stored)).toBe(before)
  }),
)

it.effect("pruning a native screenshot retains the frame text and safety outcome without image bytes", () =>
  Effect.gen(function* () {
    const messages = yield* MessageV2.toModelMessagesEffect(history(), model, {
      dropMedia: new Set(["prt_native_call"]),
    })
    const request = LLMNative.request({ model, apiKey: "fixture", messages })
    const result = request.messages.flatMap((message) => message.content).find((part) => part.type === "tool-result")
    expect(result?.result).toEqual({
      type: "text",
      value: "<untrusted_screen>Frame 1</untrusted_screen>\n[Earlier screenshot removed]",
    })
    expect(result?.providerMetadata?.openai?.acknowledgedSafetyChecks).toEqual([check])
  }),
)

it.effect("an interrupted native result preserves the call without claiming rejection or approval", () =>
  Effect.gen(function* () {
    const messages = yield* MessageV2.toModelMessagesEffect(
      history({ status: "running", input: { actions: [{ action: "click", x: 10, y: 20 }] }, time: { start: 0 } }),
      model,
    )
    const request = LLMNative.request({ model, apiKey: "fixture", messages })
    const parts = request.messages.flatMap((message) => message.content)
    expect(parts.find((part) => part.type === "tool-call")?.providerMetadata?.openai?.computerCall).toEqual(raw)
    expect(parts.find((part) => part.type === "tool-result")).toMatchObject({
      result: { type: "error", value: "[Tool execution was interrupted]" },
      providerMetadata: { openai: { computerDeclined: false, acknowledgedSafetyChecks: [] } },
    })
  }),
)

it.effect("a known native rejection survives persisted tool output conversion", () =>
  Effect.gen(function* () {
    const messages = yield* MessageV2.toModelMessagesEffect(
      history({
        status: "completed",
        input: { actions: [{ action: "click", x: 10, y: 20 }] },
        output: "The user declined this action.",
        title: "fixture",
        time: { start: 0, end: 1 },
        metadata: {
          native: { provider: "openai", acknowledgedSafetyChecks: [], computerDeclined: true },
        },
      }),
      model,
    )
    const request = LLMNative.request({ model, apiKey: "fixture", messages })
    expect(
      request.messages.flatMap((message) => message.content).find((part) => part.type === "tool-result")
        ?.providerMetadata?.openai,
    ).toMatchObject({ computerDeclined: true, acknowledgedSafetyChecks: [] })
  }),
)

it.effect("native provenance survives a supported model switch within the same provider family", () =>
  Effect.gen(function* () {
    const selected = { ...model, id: ModelV2.ID.make("gpt-5.4"), api: { ...model.api, id: "gpt-5.4" } }
    const messages = yield* MessageV2.toModelMessagesEffect(history(), selected)
    const request = LLMNative.request({ model: selected, apiKey: "fixture", messages })
    const parts = request.messages.flatMap((message) => message.content)
    expect(parts.find((part) => part.type === "tool-call")?.providerMetadata?.openai?.computerCall).toEqual(raw)
    expect(
      parts.find((part) => part.type === "tool-result")?.providerMetadata?.openai?.acknowledgedSafetyChecks,
    ).toEqual([check])
  }),
)

it.effect("persisted Anthropic partial failures retain their error flag independently from refusal", () =>
  Effect.gen(function* () {
    const selected = {
      ...model,
      id: ModelV2.ID.make("claude-sonnet-5-5"),
      providerID: ProviderV2.ID.make("anthropic"),
      api: { id: "claude-sonnet-5-5", npm: "@ai-sdk/anthropic", url: "https://api.anthropic.com/v1" },
    }
    const stored = history({
      status: "completed",
      input: { member: "click", x: 10, y: 20 },
      output: "<untrusted_screen>The action completed; its following capture failed.</untrusted_screen>",
      title: "fixture",
      time: { start: 0, end: 1 },
      metadata: {
        code: "capture_unavailable",
        native: { provider: "anthropic", acknowledgedSafetyChecks: [], computerDeclined: false },
      },
    })
    stored[0].info = { ...stored[0].info, modelID: selected.id, providerID: selected.providerID } as SessionV1.Assistant
    const part = stored[0].parts[0]
    if (part.type !== "tool") throw new Error("fixture tool is missing")
    part.metadata = { anthropic: { toolset_name: "computer", member: "click", input: { x: 10, y: 20 } } }
    const messages = yield* MessageV2.toModelMessagesEffect(stored, selected)
    const request = LLMNative.request({ model: selected, apiKey: "fixture", messages })
    expect(
      request.messages.flatMap((message) => message.content).find((part) => part.type === "tool-result")
        ?.providerMetadata?.anthropic,
    ).toMatchObject({ toolset_name: "computer", computerDeclined: false, computerError: true })
  }),
)
