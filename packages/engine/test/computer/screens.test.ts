import { describe, expect, test } from "bun:test"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import type { SessionV1 } from "@vectordevai/core/v1/session"
import { ComputerScreens } from "@/computer/screens"
import type { Provider } from "@/provider/provider"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"

const sessionID = SessionID.make("ses_screens")
const messageID = MessageID.make("msg_screens")

function model(freeModel?: Provider.Model["freeModel"], npm = "@ai-sdk/openai"): Provider.Model {
  return {
    id: ModelV2.ID.make("vision"),
    providerID: ProviderV2.ID.make("test"),
    api: { id: "vision", npm, url: "https://example.test" },
    name: "Chosen vision model",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: true,
      toolcall: true,
      input: { text: true, image: true, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 200_000, output: 8192 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
    ...(freeModel ? { freeModel } : {}),
  }
}

function screen(index: number, tool = "computer", mime = "image/png"): SessionV1.ToolPart {
  return {
    id: PartID.make(`prt_${index}`),
    sessionID,
    messageID,
    type: "tool",
    tool,
    callID: `call_${index}`,
    state: {
      status: "completed",
      input: { action: "screenshot" },
      output: `Screenshot ${index}`,
      title: "Observe app",
      time: { start: index, end: index + 1 },
      metadata: { frame: { id: `frame_${index}` } },
      attachments: [
        {
          id: PartID.make(`prt_image_${index}`),
          sessionID,
          messageID,
          type: "file",
          mime,
          url: `data:${mime};base64,c2NyZWVu`,
        },
      ],
    },
  }
}

function history(parts: SessionV1.Part[]): SessionV1.WithParts[] {
  return [
    {
      info: {
        id: messageID,
        sessionID,
        role: "assistant",
        parentID: MessageID.make("msg_user"),
        time: { created: 0 },
        agent: "build",
        mode: "build",
        modelID: ModelV2.ID.make("test"),
        providerID: ProviderV2.ID.make("test"),
        path: { cwd: "/project", root: "/project" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts,
    },
  ]
}

describe("computer screenshot history", () => {
  test.each(["@ai-sdk/openai", "@ai-sdk/openai-compatible"])(
    "switching to a may-train model strips earlier screenshots (%s)",
    async (npm) => {
      const input = history([screen(0)])
      const saved = JSON.stringify(input)
      const selected = await MessageV2.toModelMessages(input, model(undefined, npm))
      const switched = await MessageV2.toModelMessages(input, model({ source: "shared", dataPolicy: "may-train" }, npm))
      expect(JSON.stringify(selected)).toContain("c2NyZWVu")
      expect(JSON.stringify(switched)).not.toContain("c2NyZWVu")
      expect(JSON.stringify(switched)).toContain("Screenshot 0")
      expect(JSON.stringify(switched)).toContain("call_0")
      expect(JSON.stringify(input)).toBe(saved)
    },
  )

  test("unreviewed free models lose screenshots while no-training models retain consented vision", async () => {
    const input = history([screen(0)])
    for (const freeModel of [
      { source: "shared" as const },
      { source: "openrouter" as const, dataPolicy: "unreviewed" as const },
    ])
      expect(JSON.stringify(await MessageV2.toModelMessages(input, model(freeModel)))).not.toContain("c2NyZWVu")
    expect(
      JSON.stringify(await MessageV2.toModelMessages(input, model({ source: "shared", dataPolicy: "no-training" }))),
    ).toContain("c2NyZWVu")
  })

  test("computer privacy preserves other tool attachments and the owner's ordinary image uploads", async () => {
    const image: SessionV1.FilePart = {
      id: PartID.make("prt_uploaded"),
      sessionID,
      messageID: MessageID.make("msg_user"),
      type: "file",
      mime: "image/png",
      url: "data:image/png;base64,dXNlcg==",
    }
    const read = screen(1, "read")
    if (read.state.status !== "completed") throw new Error("Expected completed fixture")
    const input: SessionV1.WithParts[] = [
      {
        info: {
          id: image.messageID,
          sessionID,
          role: "user",
          time: { created: 0 },
          agent: "build",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("vision") },
        },
        parts: [image],
      },
      ...history([
        screen(0),
        { ...read, state: { ...read.state, attachments: [{ ...image, url: "data:image/png;base64,cmVhZA==" }] } },
      ]),
    ]
    const result = JSON.stringify(
      await MessageV2.toModelMessages(input, model({ source: "shared", dataPolicy: "may-train" })),
    )
    expect(result).not.toContain("c2NyZWVu")
    expect(result).toContain("dXNlcg==")
    expect(result).toContain("cmVhZA==")
  })

  test("text-only model helpers and compaction receive no computer screenshot bytes", async () => {
    const input = history([screen(0)])
    const saved = JSON.stringify(input)
    const helper = ComputerScreens.replay(input, model(), { helper: true })
    expect(JSON.stringify(helper)).not.toContain("c2NyZWVu")
    const result = await MessageV2.toModelMessages(input, model(), { stripMedia: true })
    expect(JSON.stringify(result)).not.toContain("c2NyZWVu")
    expect(JSON.stringify(result)).toContain("Screenshot 0")
    expect(JSON.stringify(input)).toBe(saved)
  })

  test("keeps the newest three screenshots when each older image can be pruned", () => {
    const input = history(Array.from({ length: 6 }, (_, index) => screen(index)))
    const saved = JSON.stringify(input)
    expect([...ComputerScreens.keep(input, { keep: 3, batch: 1 })]).toEqual(["prt_0", "prt_1", "prt_2"])
    expect(JSON.stringify(input)).toBe(saved)
    expect([...ComputerScreens.keep(history([screen(0), screen(1)]), { keep: 3, batch: 1 })]).toEqual([])
  })

  test("a small context keeps two with no batching", () => {
    expect([...ComputerScreens.keep(history([screen(0), screen(1), screen(2)]), { keep: 2, batch: 1 })]).toEqual([
      "prt_0",
    ])
  })

  test("cache pruning advances only in complete blocks of 25", () => {
    for (const [count, dropped] of [
      [27, 0],
      [28, 25],
      [52, 25],
      [53, 50],
    ]) {
      const result = ComputerScreens.keep(history(Array.from({ length: count }, (_, index) => screen(index))), {
        keep: 3,
        batch: 25,
      })
      expect([...result]).toEqual(Array.from({ length: dropped }, (_, index) => `prt_${index}`))
      expect(result.has(`prt_${count - 1}`)).toBe(false)
    }
  })

  test("a cached prefix stays identical until the next complete pruning block", () => {
    const parts = Array.from({ length: 52 }, (_, index) => screen(index))
    const first = ComputerScreens.keep(history(parts.slice(0, 28)), { keep: 3, batch: 25 })
    expect(ComputerScreens.keep(history(parts), { keep: 3, batch: 25 })).toEqual(first)
  })

  test("only completed computer images count, preserving other media and tools", () => {
    const parts: SessionV1.Part[] = [
      screen(0),
      screen(1, "browser"),
      screen(2, "read"),
      screen(3, "computer", "application/pdf"),
      {
        id: PartID.make("prt_file"),
        sessionID,
        messageID,
        type: "file",
        mime: "image/png",
        url: "data:image/png;base64,dXNlcg==",
      },
      { ...screen(4), state: { status: "error", input: {}, error: "Capture failed", time: { start: 0, end: 1 } } },
      { ...screen(5), state: { status: "running", input: {}, time: { start: 0 } } },
      screen(6),
      screen(7),
      screen(8),
    ]
    const input = history(parts)
    const saved = JSON.stringify(input)
    expect([...ComputerScreens.keep(input, { keep: 3, batch: 1 })]).toEqual(["prt_0"])
    expect(JSON.stringify(input)).toBe(saved)
  })

  test("history order across assistant messages determines the newest frames", () => {
    const input = [...history([screen(0), screen(1)]), ...history([screen(2), screen(3)]), ...history([screen(4)])]
    expect([...ComputerScreens.keep(input, { keep: 3, batch: 1 })]).toEqual(["prt_0", "prt_1"])
  })
})
