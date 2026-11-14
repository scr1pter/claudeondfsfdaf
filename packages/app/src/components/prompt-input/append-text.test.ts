import { describe, expect, test } from "bun:test"
import { Hands } from "@vectordevai/schema/hands"
import type { Prompt } from "@/context/prompt"
import { appendPromptText } from "./append-text"

const mention = `@${Hands.MENTION}`
const image = {
  type: "image" as const,
  id: "image-1",
  filename: "shot.png",
  mime: "image/png",
  dataUrl: "data:image/png;base64,AAA",
}
const text = (content: string, start: number) => ({
  type: "text" as const,
  content,
  start,
  end: start + content.length,
})
const joined = (prompt: Prompt) => prompt.map((part) => ("content" in part ? part.content : "")).join("")

describe("dictation append", () => {
  test("an empty or blank draft becomes the transcript alone", () => {
    expect(appendPromptText([text("", 0)], "  hello there ")).toEqual({ prompt: [text("hello there", 0)], cursor: 11 })
    expect(appendPromptText([], "hello")).toEqual({ prompt: [text("hello", 0)], cursor: 5 })
    expect(appendPromptText([text("   ", 0)], "hello")).toEqual({ prompt: [text("hello", 0)], cursor: 5 })
  })

  test("a blank transcript changes nothing", () => {
    expect(appendPromptText([text("draft", 0)], " \n ")).toBeUndefined()
  })

  test("trailing whitespace collapses to one space and text stays one part", () => {
    expect(appendPromptText([text("draft  \n", 0)], "more")).toEqual({ prompt: [text("draft more", 0)], cursor: 10 })
  })

  test("computer, agent and file pills keep their places, offsets and identities", () => {
    const app = { key: "app:macos:com.apple.notes", name: "Notes" }
    const prompt: Prompt = [
      text("ask ", 0),
      { type: "agent", name: "review", content: "@review", start: 4, end: 11 },
      text(" in ", 11),
      {
        type: "file",
        path: "src/a.ts",
        content: "@src/a.ts",
        start: 15,
        end: 24,
        selection: { startLine: 1, endLine: 2, startChar: 0, endChar: 0 },
      },
      text(" with ", 24),
      { type: "computer", content: mention, start: 30, end: 30 + mention.length },
      text(" and ", 30 + mention.length),
      { type: "computer", content: "@Notes", start: 35 + mention.length, end: 41 + mention.length, app },
      text(" ", 41 + mention.length),
      image,
    ]
    const result = appendPromptText(prompt, "copy the totals")!
    const expected = `ask @review in @src/a.ts with ${mention} and @Notes copy the totals`
    expect(joined(result.prompt)).toBe(expected)
    expect(result.cursor).toBe(expected.length)
    expect(result.prompt.map((part) => part.type)).toEqual([
      "text",
      "agent",
      "text",
      "file",
      "text",
      "computer",
      "text",
      "computer",
      "text",
      "image",
    ])
    for (const part of result.prompt)
      if (part.type !== "image") expect(expected.slice(part.start, part.end)).toBe(part.content)
    const notes = result.prompt.find((part) => part.type === "computer" && part.app)
    expect(notes).toMatchObject({ app })
    // The nested identity is a copy, so editing the new draft never edits the old one.
    expect(notes?.type === "computer" && notes.app).not.toBe(app)
    expect(result.prompt.at(-1)).toBe(image)
  })

  test("a draft that ends in a pill gets the transcript as text after it", () => {
    const result = appendPromptText(
      [{ type: "computer", content: mention, start: 0, end: mention.length }],
      "open Numbers",
    )!
    expect(result.prompt).toEqual([
      { type: "computer", content: mention, start: 0, end: mention.length },
      text(" open Numbers", mention.length),
    ])
  })

  test("images alone keep their place after the transcript", () => {
    expect(appendPromptText([text("", 0), image], "describe this")).toEqual({
      prompt: [text("describe this", 0), image],
      cursor: 13,
    })
  })
})
