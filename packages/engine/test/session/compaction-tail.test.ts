import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { SessionCompaction } from "../../src/session/compaction"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
const model = ProviderTest.model()
const sessionID = SessionID.make("ses_compaction_tail")

function message(index: number, text = "x".repeat(400)): SessionV1.WithParts {
  const id = MessageID.make(`msg_tail_${index}`)
  return {
    info: {
      id,
      sessionID,
      parentID: MessageID.make("msg_tail_parent"),
      role: "assistant",
      time: { created: index },
      providerID: model.providerID,
      modelID: model.id,
      agent: "build",
      mode: "build",
      path: { cwd: "/project", root: "/project" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [{ id: PartID.make(`prt_tail_${index}`), messageID: id, sessionID, type: "text", text }],
  }
}

const estimate = SessionCompaction.estimate

function png(width: number, height: number, bytes = 24) {
  const data = Buffer.alloc(bytes)
  data.set([137, 80, 78, 71, 13, 10, 26, 10])
  data.writeUInt32BE(width, 16)
  data.writeUInt32BE(height, 20)
  return `data:image/png;base64,${data.toString("base64")}`
}

function screenshot(index: number, url: string, frame?: { width: number; height: number }): SessionV1.WithParts {
  const msg = message(index, "Screenshot captured")
  msg.parts.push({
    id: PartID.make(`prt_image_${index}`),
    messageID: msg.info.id,
    sessionID,
    type: "tool",
    tool: "computer",
    callID: `call_image_${index}`,
    state: {
      status: "completed",
      input: { action: "screenshot" },
      title: "Screenshot",
      output: "Screenshot 1",
      metadata: frame ? { frame } : {},
      time: { start: 0, end: 1 },
      attachments: [
        {
          id: PartID.make(`prt_image_attachment_${index}`),
          messageID: msg.info.id,
          sessionID,
          type: "file",
          mime: "image/png",
          url,
        },
      ],
    },
  })
  return msg
}

describe("compaction image estimate", () => {
  it.effect("counts visual tokens independently of screenshot transport size across provider conversions", () =>
    Effect.gen(function* () {
      const small = screenshot(0, png(1024, 768))
      const large = screenshot(0, png(1024, 768, 3 * 1024 * 1024))
      for (const npm of ["@ai-sdk/openai", "@ai-sdk/anthropic", "@ai-sdk/openai-compatible", "@ai-sdk/google"]) {
        const selectedModel = { ...model, api: { ...model.api, npm } }
        const baseline = yield* estimate({ messages: [small], model: selectedModel })
        expect(yield* estimate({ messages: [large], model: selectedModel })).toBe(baseline)
        expect(baseline).toBeGreaterThan(250)
        expect(baseline).toBeLessThan(5_000)
      }
    }),
  )

  it.effect("uses image dimensions and saved frame metadata, with a bounded fallback for unknown images", () =>
    Effect.gen(function* () {
      const selectedModel = { ...model, api: { ...model.api, npm: "@ai-sdk/anthropic" } }
      const small = yield* estimate({ messages: [screenshot(0, png(64, 64))], model: selectedModel })
      const large = yield* estimate({ messages: [screenshot(0, png(1440, 900))], model: selectedModel })
      const saved = yield* estimate({
        messages: [screenshot(0, "data:image/png;base64,invalid", { width: 1440, height: 900 })],
        model: selectedModel,
      })
      expect(large).toBeGreaterThan(small)
      expect(saved).toBe(large)
      for (const url of ["data:image/png;base64,invalid", png(0, 0)]) {
        const tokens = yield* estimate({ messages: [screenshot(0, url)], model: selectedModel })
        expect(tokens).toBeGreaterThan(1_000)
        expect(tokens).toBeLessThan(5_000)
      }
      const id = MessageID.make("msg_remote_image")
      const remote: SessionV1.WithParts = {
        info: {
          id,
          role: "user",
          sessionID,
          agent: "build",
          model: { providerID: model.providerID, modelID: model.id },
          time: { created: 0 },
        },
        parts: [
          {
            id: PartID.make("prt_remote_image"),
            messageID: id,
            sessionID,
            type: "file",
            mime: "image/png",
            url: "https://example.invalid/screenshot.png",
          },
        ],
      }
      const tokens = yield* estimate({ messages: [remote], model: selectedModel })
      expect(tokens).toBeGreaterThan(1_000)
      expect(tokens).toBeLessThan(5_000)
    }),
  )

  it.effect("counts only images sent to the model and still accounts for actual text", () =>
    Effect.gen(function* () {
      const photo = screenshot(0, png(1440, 900))
      const baseline = yield* estimate({ messages: [photo], model })
      const moreText = screenshot(0, png(1440, 900))
      moreText.parts.push({
        id: PartID.make("prt_more_text"),
        messageID: moreText.info.id,
        sessionID,
        type: "text",
        text: "x".repeat(4_000),
      })
      expect(yield* estimate({ messages: [moreText], model })).toBeGreaterThan(baseline + 999)
      const compacted = screenshot(0, png(1440, 900))
      const part = compacted.parts[1]!
      if (part.type === "tool" && part.state.status === "completed") part.state.time.compacted = 1
      expect(yield* estimate({ messages: [compacted], model })).toBeLessThan(baseline)
      const failed = screenshot(0, png(1440, 900))
      if (failed.info.role === "assistant") failed.info.error = { name: "UnknownError", data: { message: "failed" } }
      expect(yield* estimate({ messages: [failed], model })).toBe(yield* estimate({ messages: [], model }))
    }),
  )

  it.effect("reads JPEG, GIF and WebP header dimensions without decoding pixels", () =>
    Effect.gen(function* () {
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 64, 0, 64, 1, 1, 0x11, 0])
      const gif = Buffer.from([71, 73, 70, 56, 57, 97, 64, 0, 64, 0])
      const webp = Buffer.alloc(30)
      webp.write("RIFF", 0)
      webp.write("WEBP", 8)
      webp.write("VP8X", 12)
      webp.writeUIntLE(63, 24, 3)
      webp.writeUIntLE(63, 27, 3)
      const selectedModel = { ...model, api: { ...model.api, npm: "@ai-sdk/anthropic" } }
      const expected = yield* estimate({ messages: [screenshot(0, png(64, 64))], model: selectedModel })
      for (const data of [jpeg, gif, webp]) {
        const image = screenshot(0, `data:image/png;base64,${data.toString("base64")}`)
        expect(yield* estimate({ messages: [image], model: selectedModel })).toBe(expected)
      }
    }),
  )

  it.effect("bounds estimates for extreme declared image dimensions", () =>
    Effect.gen(function* () {
      for (const npm of ["@ai-sdk/google", "@ai-sdk/anthropic", "@ai-sdk/openai", "@ai-sdk/unknown"]) {
        const selectedModel = { ...model, api: { ...model.api, id: "vision-test", npm } }
        const tokens = yield* estimate({ messages: [screenshot(0, png(1_000_000, 1_000_000))], model: selectedModel })
        expect(tokens).toBeGreaterThan(250)
        expect(tokens).toBeLessThan(9_000)
      }
    }),
  )

  it.effect("retains the same recent screenshot suffix when base64 grows by several megabytes", () =>
    Effect.gen(function* () {
      const messages = [message(0), message(1), screenshot(2, png(1024, 768)), message(3)]
      const budget = yield* estimate({ messages: messages.slice(2), model })
      for (const bytes of [24, 3 * 1024 * 1024]) {
        messages[2] = screenshot(2, png(1024, 768, bytes))
        expect(
          yield* SessionCompaction.splitTurn({
            messages,
            model,
            turn: { start: 0, end: messages.length, id: messages[0]!.info.id },
            budget,
            estimate,
          }),
        ).toEqual({ start: 2, id: messages[2]!.info.id })
      }
    }),
  )
})

describe("compaction tail selection", () => {
  it.effect("retains the earliest exact-budget suffix with logarithmic conversions", () =>
    Effect.gen(function* () {
      const messages = Array.from({ length: 128 }, (_, index) => message(index))
      const input = { messages, model, turn: { start: 0, end: messages.length, id: messages[0]!.info.id }, budget: 0 }
      const budget = yield* estimate({ ...input, messages: messages.slice(120) })
      const converted = new Array<number>()
      const selected = yield* SessionCompaction.splitTurn({
        ...input,
        budget,
        estimate: (suffix) => {
          converted.push(suffix.messages.length)
          return estimate(suffix)
        },
      })
      expect(selected).toEqual({ start: 120, id: messages[120]!.info.id })
      expect(converted.length).toBeLessThanOrEqual(8)
      expect(converted.reduce((sum, count) => sum + count, 0)).toBeLessThan(384)
    }),
  )

  it.effect("keeps empty and skipped messages at the first fitting plateau within the turn", () =>
    Effect.gen(function* () {
      const messages = Array.from({ length: 7 }, (_, index) => message(index))
      messages[2]!.parts = []
      if (messages[3]!.info.role === "assistant")
        messages[3]!.info.error = { name: "UnknownError", data: { message: "failed" } }
      messages[4]!.parts = [{ ...messages[4]!.parts[0]!, type: "step-start" }]
      const input = { messages, model, turn: { start: 0, end: 6, id: messages[0]!.info.id }, budget: 0 }
      const budget = yield* estimate({ ...input, messages: messages.slice(5, 6) })
      expect(
        yield* SessionCompaction.splitTurn({
          ...input,
          budget,
          estimate,
        }),
      ).toEqual({ start: 2, id: messages[2]!.info.id })
    }),
  )

  it.effect("returns no suffix when the budget cannot hold one and respects a nonzero turn start", () =>
    Effect.gen(function* () {
      const messages = Array.from({ length: 5 }, (_, index) => message(index))
      const input = { messages, model, turn: { start: 2, end: 5, id: messages[2]!.info.id }, budget: 0 }
      for (const budget of [0, 1])
        expect(
          yield* SessionCompaction.splitTurn({
            ...input,
            budget,
            estimate,
          }),
        ).toBeUndefined()
      const converted = new Array<number>()
      expect(
        yield* SessionCompaction.splitTurn({
          ...input,
          budget: 100_000,
          estimate: (suffix) => {
            converted.push(suffix.messages.length)
            return estimate(suffix)
          },
        }),
      ).toEqual({
        start: 3,
        id: messages[3]!.info.id,
      })
      expect(converted).toEqual([2])
      const budget = yield* estimate({ ...input, messages: messages.slice(4) })
      expect(
        yield* SessionCompaction.splitTurn({
          ...input,
          budget,
          estimate,
        }),
      ).toEqual({ start: 4, id: messages[4]!.info.id })
    }),
  )

  it.effect("preserves suffix ordering for tools, injected media and signed reasoning", () =>
    Effect.gen(function* () {
      const messages = Array.from({ length: 6 }, (_, index) => message(index))
      messages[1]!.parts.push({
        id: PartID.make("prt_tail_tool"),
        messageID: messages[1]!.info.id,
        sessionID,
        type: "tool",
        tool: "read",
        callID: "call_tail_media",
        state: {
          status: "completed",
          input: { filePath: "/project/image.png" },
          title: "Image",
          metadata: {},
          output: "image contents",
          time: { start: 0, end: 1 },
          attachments: [
            {
              id: PartID.make("prt_tail_media"),
              messageID: messages[1]!.info.id,
              sessionID,
              type: "file",
              mime: "image/png",
              url: `data:image/png;base64,${"A".repeat(400)}`,
            },
          ],
        },
      })
      messages[2]!.parts = [
        {
          id: PartID.make("prt_tail_reasoning"),
          messageID: messages[2]!.info.id,
          sessionID,
          type: "reasoning",
          text: "reasoning",
          time: { start: 0, end: 1 },
          metadata: { anthropic: { signature: "signed" } },
        },
        {
          id: PartID.make("prt_tail_separator"),
          messageID: messages[2]!.info.id,
          sessionID,
          type: "text",
          text: "",
        },
      ]
      messages[3]!.parts = []
      for (const npm of ["@ai-sdk/openai", "@ai-sdk/openai-compatible", "@ai-sdk/anthropic"]) {
        const selectedModel = { ...model, api: { ...model.api, npm } }
        const sizes = yield* Effect.forEach(messages, (_, index) =>
          estimate({ messages: messages.slice(index), model: selectedModel }),
        )
        sizes.slice(1).forEach((size, index) => expect(size).toBeLessThanOrEqual(sizes[index]!))
        for (const budget of sizes.slice(1).flatMap((size) => [size, size - 1])) {
          const expected = sizes.findIndex((size, index) => index > 0 && size <= budget)
          const input = {
            messages,
            model: selectedModel,
            turn: { start: 0, end: messages.length, id: messages[0]!.info.id },
            budget,
          }
          const selected = yield* SessionCompaction.splitTurn({
            ...input,
            estimate,
          })
          expect(selected?.start).toBe(expected < 0 ? undefined : expected)
        }
      }
    }),
  )
})

// A fork's history starts with its parent's, inherited up to the fork point. Its own messages cannot point back into
// the parent's, so the tail a summary keeps starts at its first own message (the floor) or after it (5.E.3).
describe("compaction tail floor", () => {
  const prompt = (index: number): SessionV1.WithParts => {
    const id = MessageID.make(`msg_floor_${String(index).padStart(2, "0")}`)
    return {
      info: {
        id,
        sessionID,
        role: "user",
        time: { created: index },
        agent: "build",
        model: { providerID: model.providerID, modelID: model.id },
      },
      parts: [{ id: PartID.make(`prt_floor_${index}`), messageID: id, sessionID, type: "text", text: "y".repeat(400) }],
    }
  }
  const reply = (index: number): SessionV1.WithParts => {
    const item = message(index)
    const id = MessageID.make(`msg_floor_${String(index).padStart(2, "0")}`)
    return { info: { ...item.info, id }, parts: item.parts.map((part) => ({ ...part, messageID: id })) }
  }
  // Two inherited turns of the parent, then the fork's own two: its assignment (the floor) and a follow-up.
  const messages = [prompt(0), reply(1), prompt(2), reply(3), prompt(4), reply(5), reply(6), prompt(7), reply(8)]
  const floor = messages[4]!.info.id
  const cfg = (preserve: number) => ({ compaction: { tail_turns: 3, preserve_recent_tokens: preserve } })

  it.effect("keeps the parent's turns out of the tail", () =>
    Effect.gen(function* () {
      const open = yield* SessionCompaction.select({ messages, cfg: cfg(100_000), model })
      expect(open.tail_start_id).toBe(messages[2]!.info.id)
      const floored = yield* SessionCompaction.select({ messages, cfg: cfg(100_000), model, floor })
      expect(floored.tail_start_id).toBe(floor)
      // Everything before the floor, the parent's history included, is summarized.
      expect(floored.head).toEqual(messages.slice(0, 4))
    }),
  )

  it.effect("splits within the fork's own turns, and keeps no tail when none of them fits", () =>
    Effect.gen(function* () {
      const last = yield* estimate({ messages: messages.slice(8), model })
      const split = yield* SessionCompaction.select({ messages, cfg: cfg(last), model, floor })
      expect(split.tail_start_id).toBe(messages[8]!.info.id)
      const none = yield* SessionCompaction.select({ messages, cfg: cfg(1), model, floor })
      expect(none).toEqual({ head: messages, tail_start_id: undefined })
    }),
  )
})
