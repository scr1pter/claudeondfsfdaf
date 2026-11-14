import { beforeAll, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import { Hands } from "@vectordevai/schema/hands"
import type { ComputerPart } from "./prompt"

let createPromptState: typeof import("./prompt").createPromptState
let isPromptEqual: typeof import("./prompt").isPromptEqual

beforeAll(async () => {
  // These tests exercise prompt data, without mounting a router or the surrounding application providers.
  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => ({}),
    useLocation: () => ({}),
    useSearchParams: () => [{}, () => undefined],
  }))
  const prompt = await import("./prompt")
  createPromptState = prompt.createPromptState
  isPromptEqual = prompt.isPromptEqual
})

const feature = (): ComputerPart => ({
  type: "computer",
  content: `@${Hands.MENTION}`,
  start: 0,
  end: Hands.MENTION.length + 1,
})

describe("computer prompt parts", () => {
  test("equality preserves feature versus app identity, app renames and visible content", () => {
    const part: ComputerPart = { ...feature(), app: { key: "app:macos:com.apple.notes", name: "Notes" } }
    expect(isPromptEqual([feature()], [feature()])).toBe(true)
    expect(isPromptEqual([part], [{ ...part, app: { ...part.app! } }])).toBe(true)
    for (const changed of [
      feature(),
      { ...part, app: { ...part.app!, key: "app:macos:other" } },
      { ...part, app: { ...part.app!, name: "Renamed" } },
      { ...part, content: "@Changed display" },
    ])
      expect(isPromptEqual([part], [changed])).toBe(false)
    expect(isPromptEqual([feature()], [{ ...feature(), type: "text" }])).toBe(false)
  })

  test("setting a prompt owns its nested app identity and can replace it with a feature pill", () => {
    createRoot((dispose) => {
      const prompt = createPromptState()
      const part: ComputerPart = {
        type: "computer",
        content: "@Notes",
        start: 0,
        end: 6,
        app: { key: "app:macos:com.apple.notes", name: "Notes" },
      }
      prompt.set([part], part.end)
      part.app!.key = "app:macos:changed"
      part.app!.name = "Changed outside the prompt"
      expect(prompt.current()[0]).toMatchObject({
        type: "computer",
        app: { key: "app:macos:com.apple.notes", name: "Notes" },
      })
      expect(prompt.dirty()).toBe(true)
      prompt.set([feature()])
      expect(prompt.current()).toEqual([feature()])
      prompt.reset()
      expect(prompt.dirty()).toBe(false)
      dispose()
    })
  })

  test("setting mixed parts keeps existing file, agent and image behavior", () => {
    createRoot((dispose) => {
      const prompt = createPromptState()
      prompt.set([
        { type: "text", content: "Use ", start: 0, end: 4 },
        { type: "agent", name: "explore", content: "@explore", start: 4, end: 12 },
        { type: "file", path: "src/a.ts", content: "@src/a.ts", start: 12, end: 21 },
        {
          type: "image",
          id: "image",
          filename: "image.png",
          mime: "image/png",
          dataUrl: "data:image/png;base64,aGVsbG8=",
        },
        feature(),
      ])
      expect(prompt.current().map((part) => part.type)).toEqual(["text", "agent", "file", "image", "computer"])
      expect(isPromptEqual(prompt.current(), [...prompt.current()])).toBe(true)
      dispose()
    })
  })
})
