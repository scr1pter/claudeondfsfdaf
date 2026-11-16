import { describe, expect, test } from "bun:test"
import type { Part } from "@vectordevai/sdk/v2"
import { Hands } from "@vectordevai/schema/hands"
import { extractPromptFromParts } from "./prompt"

describe("extractPromptFromParts", () => {
  test("restores multiple uploaded attachments", () => {
    const parts = [
      {
        id: "text_1",
        type: "text",
        text: "check these",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
      {
        id: "file_1",
        type: "file",
        mime: "image/png",
        url: "data:image/png;base64,AAA",
        filename: "a.png",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
      {
        id: "file_2",
        type: "file",
        mime: "application/pdf",
        url: "data:application/pdf;base64,BBB",
        filename: "b.pdf",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
    ] satisfies Part[]

    const result = extractPromptFromParts(parts)

    expect(result).toHaveLength(3)
    expect(result[0]).toMatchObject({ type: "text", content: "check these" })
    expect(result.slice(1)).toMatchObject([
      { type: "image", filename: "a.png", mime: "image/png", dataUrl: "data:image/png;base64,AAA" },
      { type: "image", filename: "b.pdf", mime: "application/pdf", dataUrl: "data:application/pdf;base64,BBB" },
    ])
  })
})

describe("extractPromptFromParts computer mentions", () => {
  const base = { sessionID: "ses_1", messageID: "msg_1" }
  const mention = `@${Hands.MENTION}`
  const notes = { key: "app:macos:com.apple.notes", name: "Notes" }
  let id = 0
  const typed = (text: string): Part => ({ ...base, id: `text_${++id}`, type: "text", text })
  const marker = (value: Record<string, unknown>, extra: Record<string, unknown> = {}): Part => ({
    ...base,
    id: `text_${++id}`,
    type: "text",
    text: "",
    synthetic: true,
    metadata: { [Hands.MARKER]: value, ...extra },
  })
  const feature = () => marker({ kind: "feature" })
  const app = (identity = notes) => marker({ kind: "app", ...identity })
  const shape = (prompt: ReturnType<typeof extractPromptFromParts>) =>
    prompt.map((part) =>
      part.type === "image"
        ? { type: part.type }
        : {
            type: part.type,
            content: part.content,
            start: part.start,
            end: part.end,
            ...(part.type === "computer" && part.app ? { app: part.app } : {}),
          },
    )

  test("a feature and an app marker restore their pills in place with recomputed offsets", () => {
    const between = " copy the total into "
    const text = `${mention}${between}@Notes please`
    const at = mention.length + between.length
    expect(shape(extractPromptFromParts([typed(text), feature(), app()]))).toEqual([
      { type: "computer", content: mention, start: 0, end: mention.length },
      { type: "text", content: between, start: mention.length, end: at },
      { type: "computer", content: "@Notes", start: at, end: at + 6, app: notes },
      { type: "text", content: " please", start: at + 6, end: text.length },
    ])
  })

  test("two identical app markers claim distinct spans in order", () => {
    const text = "@Notes then @Notes again, and @Notes is plain"
    const restored = extractPromptFromParts([typed(text), app(), app()])
    expect(restored.flatMap((part) => (part.type === "computer" ? [part.start] : []))).toEqual([0, 12])
    expect(restored.map((part) => ("content" in part ? part.content : "")).join("")).toBe(text)
  })

  test("a marker never takes text an agent or file pill already holds", () => {
    const text = `ask @${Hands.MENTION} and also ${mention} here`
    const agent = text.indexOf(`@${Hands.MENTION}`)
    const restored = extractPromptFromParts([
      typed(text),
      {
        ...base,
        id: "agent_1",
        type: "agent",
        name: Hands.MENTION,
        source: { value: `@${Hands.MENTION}`, start: agent, end: agent + mention.length },
      },
      {
        ...base,
        id: "file_1",
        type: "file",
        mime: "text/plain",
        url: "file:///repo/a.ts",
        source: { type: "file", path: "a.ts", text: { value: "here", start: text.length - 4, end: text.length } },
      },
      feature(),
    ])
    expect(restored.map((part) => [part.type, part.type === "image" ? -1 : part.start])).toEqual([
      ["text", 0],
      ["agent", agent],
      ["text", agent + mention.length],
      ["computer", text.indexOf(mention, agent + 1)],
      ["text", text.indexOf(mention, agent + 1) + mention.length],
      ["file", text.length - 4],
    ])
  })

  test("only an exact, whole mention matches; otherwise the text stays plain and no pill appears", () => {
    for (const text of [`${mention}ome is a word`, `${mention.toLowerCase()} lowercase`, "no mention at all"])
      expect(extractPromptFromParts([typed(text), feature()])).toEqual([
        { type: "text", content: text, start: 0, end: text.length },
      ])
    // An app marker matches its own name only.
    expect(extractPromptFromParts([typed("open @Note"), app()])).toEqual([
      { type: "text", content: "open @Note", start: 0, end: 10 },
    ])
  })

  test("malformed markers, non-synthetic text and plain @ text restore nothing", () => {
    const text = `${mention} open @Notes`
    const malformed: Part[] = [
      marker({ kind: "app", key: notes.key }),
      marker({ kind: "app", name: "Notes" }),
      marker({ kind: "other" }),
      marker("feature" as unknown as Record<string, unknown>),
      { ...base, id: "t_x", type: "text", text: "", metadata: { [Hands.MARKER]: { kind: "feature" } } },
      {
        ...base,
        id: "t_y",
        type: "text",
        text: "x",
        synthetic: true,
        metadata: { [Hands.MARKER]: { kind: "feature" } },
      },
    ]
    expect(extractPromptFromParts([typed(text), ...malformed])).toEqual([
      { type: "text", content: text, start: 0, end: text.length },
    ])
    expect(extractPromptFromParts([typed(text)])).toEqual([{ type: "text", content: text, start: 0, end: text.length }])
  })

  test("extra marker fields never reach the restored pill", () => {
    const restored = extractPromptFromParts([
      typed("@Notes"),
      marker({ kind: "app", ...notes, grant: "always" }, { other: true }),
    ])
    expect(restored).toEqual([{ type: "computer", content: "@Notes", start: 0, end: 6, app: notes }])
  })

  test("images stay last, after restored pills", () => {
    const text = `${mention} read this`
    const restored = extractPromptFromParts([
      typed(text),
      feature(),
      { ...base, id: "file_img", type: "file", mime: "image/png", url: "data:image/png;base64,AAA", filename: "a.png" },
    ])
    expect(shape(restored).map((part) => part.type)).toEqual(["computer", "text", "image"])
  })
})
