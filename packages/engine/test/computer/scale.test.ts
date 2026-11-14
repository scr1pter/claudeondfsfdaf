import { describe, expect, test } from "bun:test"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import type { ConfigV1 } from "@vectordevai/core/v1/config/config"
import type { Computer } from "@vectordevai/schema/computer"
import { Effect } from "effect"
import { ComputerModels } from "@/computer/models"
import { ComputerScale } from "@/computer/scale"
import { Config } from "@/config/config"
import { Image } from "@/image/image"
import type { Provider } from "@/provider/provider"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

function model(
  options: {
    provider?: string
    id?: string
    api?: string
    npm?: string
    context?: number
    image?: boolean
    cache?: number
  } = {},
): Provider.Model {
  return {
    id: ModelV2.ID.make(options.id ?? "gpt-5.5"),
    providerID: ProviderV2.ID.make(options.provider ?? "openai"),
    api: {
      id: options.api ?? options.id ?? "gpt-5.5",
      npm: options.npm ?? "@ai-sdk/openai",
      url: "https://example.test",
    },
    name: "Test vision model",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: true,
      toolcall: true,
      input: { text: true, image: options.image ?? true, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: options.cache ?? 0, write: 0 } },
    limit: { context: options.context ?? 200_000, output: 8192 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
  }
}

const attachment: ConfigV1.Info = { attachment: { image: { max_width: 1024, max_height: 600 } } }
const it = testEffect(
  LayerNode.compile(Image.node, [[Config.node, TestConfig.layer({ get: () => Effect.succeed(attachment) })]]),
)

describe("computer model capabilities", () => {
  test("only explicitly supported API IDs select a native wire", () => {
    for (const id of ["gpt-5.4", "gpt-5.5"])
      expect(ComputerModels.native(model({ id: "friendly-alias", api: id }))).toBe("openai")
    for (const name of ["opus", "sonnet", "haiku"])
      for (const version of ["5-5", "5.5"])
        expect(
          ComputerModels.native(
            model({
              provider: "anthropic",
              npm: "@ai-sdk/anthropic",
              id: "friendly-alias",
              api: `claude-${name}-${version}`,
            }),
          ),
        ).toBe("anthropic")
    for (const selected of [
      model({ api: "gpt-6" }),
      model({ api: "gpt-6.1" }),
      model({ api: "gpt-5.5-unknown" }),
      model({ api: "anthropic/gpt-5.5" }),
      model({ api: "unsupported", id: "gpt-5.5" }),
      model({ provider: "proxy" }),
      model({ npm: "@ai-sdk/openai-compatible" }),
      model({ image: false }),
      model({ provider: "anthropic", npm: "@ai-sdk/anthropic", api: "claude-opus-6" }),
    ])
      expect(ComputerModels.native(selected)).toBeUndefined()
  })

  test("tiers preserve the generic vision and text-only fallback", () => {
    expect(ComputerModels.tier(model())).toBe("best")
    expect(ComputerModels.tier(model({ api: "gpt-6" }))).toBe("great")
    expect(
      ComputerModels.tier(model({ provider: "local", npm: "@ai-sdk/openai-compatible", id: "local-vision" })),
    ).toBe("good")
    expect(ComputerModels.tier(model({ image: false }))).toBe("reader")
  })

  test("Gemini package and API IDs use the grid even behind another provider", () => {
    for (const selected of [
      model({ provider: "google", npm: "@ai-sdk/google", id: "alias" }),
      model({ provider: "vertex", npm: "@ai-sdk/google-vertex", id: "alias" }),
      model({ provider: "proxy", npm: "@ai-sdk/openai-compatible", api: "google/gemini-3.1-pro" }),
    ])
      expect(ComputerModels.coords(selected)).toBe("grid1000")
    expect(ComputerModels.coords(model())).toBe("pixels")
  })
})

describe("computer capture plan", () => {
  test("family, context and attachment bounds apply before capture", () => {
    expect(ComputerScale.plan(model())).toEqual({
      maxWidth: 1440,
      maxHeight: 900,
      maxPixels: 1_296_000,
      coords: "pixels",
      keep: 3,
      batch: 25,
    })
    expect(
      ComputerScale.plan(model({ provider: "google", npm: "@ai-sdk/google", id: "gemini-3.1-pro" })),
    ).toMatchObject({ maxWidth: 1440, maxHeight: 900, coords: "grid1000", batch: 25 })
    expect(
      ComputerScale.plan(model({ provider: "anthropic", npm: "@ai-sdk/anthropic", id: "claude-sonnet-5.5" })),
    ).toMatchObject({ maxWidth: 1440, maxHeight: 900, maxPixels: 1_150_000 })
    expect(
      ComputerScale.plan(model({ provider: "local", npm: "@ai-sdk/openai-compatible", id: "local-vision" })),
    ).toMatchObject({ maxWidth: 1280, maxHeight: 800, maxPixels: 1_024_000, batch: 1 })
    for (const context of [0, 99_999])
      expect(ComputerScale.plan(model({ context }))).toMatchObject({
        maxWidth: 1024,
        maxHeight: 640,
        maxPixels: 655_360,
        keep: 2,
        batch: 1,
      })
    expect(ComputerScale.plan(model({ context: 100_000 }))).toMatchObject({ maxWidth: 1440, keep: 3, batch: 25 })
    expect(ComputerScale.plan(model(), attachment)).toMatchObject({
      maxWidth: 1024,
      maxHeight: 600,
      maxPixels: 614_400,
    })
    expect(
      ComputerScale.plan(model(), { computer: { screenshots: { max_width: 800, max_height: 500, keep: 1 } } }),
    ).toMatchObject({ maxWidth: 800, maxHeight: 500, maxPixels: 400_000, keep: 1 })
    expect(ComputerScale.plan(model({ context: 99_999 }), { computer: { screenshots: { keep: 10 } } })).toMatchObject({
      keep: 2,
      batch: 1,
    })
    expect(ComputerScale.plan(model({ provider: "custom", id: "custom-vision", cache: 1 }))).toMatchObject({
      batch: 25,
    })
  })

  for (const [name, width, height, output] of [
    ["Retina physical pixels", 3456, 2234, { w: 1392, h: 900 }],
    ["1x landscape", 2560, 1440, { w: 1440, h: 810 }],
    ["Windows physical pixels at 125% DPI", 1920, 1080, { w: 1440, h: 810 }],
    ["portrait", 1440, 2560, { w: 506, h: 900 }],
    ["exact width bound", 2205, 900, { w: 1440, h: 587 }],
    ["small capture", 640, 480, { w: 640, h: 480 }],
  ] as const)
    test(`fits ${name} without changing coordinate space`, () => {
      expect(ComputerScale.fit(width, height, ComputerScale.plan(model()))).toEqual(output)
    })

  test("pixel limits hold for server-side caps and extreme aspect ratios", () => {
    const budget = ComputerScale.plan(
      model({ provider: "anthropic", npm: "@ai-sdk/anthropic", id: "claude-sonnet-5.5" }),
    )
    const result = ComputerScale.fit(1440, 900, budget)
    expect(result.w * result.h).toBeLessThanOrEqual(budget.maxPixels)
    expect(result.w).toBeLessThan(1440)
    expect(result.h).toBeLessThan(900)
    expect(ComputerScale.fit(1, 10000, { maxWidth: 1440, maxHeight: 10000, maxPixels: 10 })).toEqual({ w: 1, h: 10 })
    expect(ComputerScale.fit(10000, 1, { maxWidth: 10000, maxHeight: 900, maxPixels: 10 })).toEqual({ w: 10, h: 1 })
    for (const width of [0, -1, 1.5, NaN, Infinity])
      expect(() => ComputerScale.fit(width, 900, budget)).toThrow(RangeError)
  })

  it.effect("an image captured to the attachment-capped plan survives Image.normalize unchanged", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const size = ComputerScale.fit(3456, 2234, ComputerScale.plan(model(), attachment))
      const source = new photon.PhotonImage(new Uint8Array(size.w * size.h * 4).fill(255), size.w, size.h)
      const input = {
        id: PartID.ascending(),
        messageID: MessageID.ascending(),
        sessionID: SessionID.make("ses_scale"),
        type: "file" as const,
        mime: "image/png",
        url: `data:image/png;base64,${Buffer.from(source.get_bytes()).toString("base64")}`,
      }
      source.free()
      const image = yield* Image.Service
      expect(yield* image.normalize(input)).toBe(input)
      expect(size.w).toBeLessThanOrEqual(1024)
      expect(size.h).toBeLessThanOrEqual(600)
    }),
  )
})

describe("computer frame coordinates", () => {
  const frame: Computer.Frame = {
    id: "frame",
    scope: "display",
    display: "left",
    bounds: { x: -1728, y: -120, w: 1728, h: 1117 },
    scale: 2,
    image: { w: 1392, h: 900 },
    at: 0,
    hash: "0000000000000000",
  }

  test("grid endpoints reach the actual edge pixels, independent of global DIP and scale", () => {
    expect(ComputerScale.fromGrid({ x: 0, y: 0 }, frame)).toEqual({ x: 0, y: 0 })
    expect(ComputerScale.fromGrid({ x: 999, y: 999 }, frame)).toEqual({ x: 1391, y: 899 })
    expect(ComputerScale.fromGrid({ x: 500, y: 500 }, frame)).toEqual({ x: 696, y: 450 })
    expect(ComputerScale.fromGrid(999, 1)).toBe(0)
  })

  test("invalid grid coordinates are rejected instead of clamped into the screen", () => {
    for (const value of [-1, 1000, 0.5, NaN, Infinity]) {
      expect(() => ComputerScale.fromGrid(value, frame.image.w)).toThrow(RangeError)
      expect(() => ComputerScale.fromGrid({ x: 0, y: value }, frame)).toThrow(RangeError)
    }
    expect(() => ComputerScale.fromGrid(0, 0)).toThrow(RangeError)
  })

  test("bounds check uses the latest full frame's integer pixel coordinates", () => {
    expect(ComputerScale.inBounds(0, 0, frame)).toBe(true)
    expect(ComputerScale.inBounds(1391, 899, frame)).toBe(true)
    for (const [x, y] of [
      [-1, 0],
      [0, -1],
      [1392, 0],
      [0, 900],
      [1727, 1116],
      [0.1, 0],
      [NaN, 0],
      [0, Infinity],
    ])
      expect(ComputerScale.inBounds(x, y, frame)).toBe(false)
  })
})
