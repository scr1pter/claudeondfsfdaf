import { describe, expect, test } from "bun:test"
import { ComputerScreenshotHistory } from "./screenshot-history"

const image = { id: "file", type: "file", mime: "image/jpeg", url: "data:image/jpeg;base64,AAAA" }

function computer(input: { id?: string; sessionID?: string; end?: number; state?: Record<string, unknown> } = {}) {
  return {
    id: input.id ?? "prt_a",
    sessionID: input.sessionID ?? "ses_a",
    messageID: "msg_a",
    type: "tool",
    tool: "computer",
    callID: "call_a",
    state: input.state ?? {
      status: "completed",
      input: { action: "screenshot" },
      output: "Looked at Numbers",
      title: "Looked at Numbers",
      metadata: { action: "screenshot", app: "Numbers" },
      time: { start: 1, end: input.end ?? 100 },
      attachments: [image],
    },
  }
}

describe("deletion selections", () => {
  test("only all alone, or a cutoff and/or a conversation, is accepted", () => {
    expect(ComputerScreenshotHistory.decode({ all: true })).toEqual({ all: true })
    expect(ComputerScreenshotHistory.decode({ before: 5 })).toEqual({ before: 5 })
    expect(ComputerScreenshotHistory.decode({ sessionID: "ses_a" })).toEqual({ sessionID: "ses_a" })
    expect(ComputerScreenshotHistory.decode({ sessionID: "ses_a", before: 5 })).toEqual({
      before: 5,
      sessionID: "ses_a",
    })
    for (const value of [
      undefined,
      null,
      "all",
      [],
      {},
      { all: false },
      { all: true, before: 1 },
      { before: -1 },
      { before: Number.POSITIVE_INFINITY },
      { before: "1" },
      { sessionID: "" },
      { sessionID: "../ses" },
      { sessionID: "ses_a", extra: true },
    ])
      expect(ComputerScreenshotHistory.decode(value)).toBeUndefined()
  })
})

describe("which cached parts a deletion changes", () => {
  test("a computer part with media, inside the selection", () => {
    const part = computer({ end: 100 })
    expect(ComputerScreenshotHistory.removes(part, { all: true })).toBe(true)
    expect(ComputerScreenshotHistory.removes(part, { before: 101 })).toBe(true)
    expect(ComputerScreenshotHistory.removes(part, { before: 100 })).toBe(false)
    expect(ComputerScreenshotHistory.removes(part, { sessionID: "ses_a" })).toBe(true)
    expect(ComputerScreenshotHistory.removes(part, { sessionID: "ses_b" })).toBe(false)
    expect(ComputerScreenshotHistory.removes(part, { sessionID: "ses_a", before: 50 })).toBe(false)
    expect(ComputerScreenshotHistory.removes(part, { sessionID: "ses_a", before: 150 })).toBe(true)
  })

  test("other tools keep their files, and a part already removed is left alone", () => {
    const other = { ...computer(), tool: "read" }
    expect(ComputerScreenshotHistory.removes(other, { all: true })).toBe(false)
    const removed = ComputerScreenshotHistory.tombstone(computer())
    expect(ComputerScreenshotHistory.removes(removed, { all: true })).toBe(false)
    const text = { id: "t", type: "text", sessionID: "ses_a" }
    expect(ComputerScreenshotHistory.removes(text, { all: true })).toBe(false)
  })

  test("a call without an end time is dated by its message, and removed when neither is known", () => {
    const part = computer({
      state: { status: "error", input: {}, error: "x", time: { start: 1 }, attachments: [image] },
    })
    expect(ComputerScreenshotHistory.removes(part, { before: 10 }, 5)).toBe(true)
    expect(ComputerScreenshotHistory.removes(part, { before: 10 }, 50)).toBe(false)
    expect(ComputerScreenshotHistory.removes(part, { before: 10 })).toBe(true)
  })

  test("media is found wherever the engine looks for it: attachments, screenshots and file or image nodes", () => {
    expect(ComputerScreenshotHistory.hasMedia({ output: "text", metadata: { app: "Numbers" } })).toBe(false)
    expect(ComputerScreenshotHistory.hasMedia({ attachments: [] })).toBe(true)
    expect(
      ComputerScreenshotHistory.hasMedia({ metadata: { native: { result: [{ type: "image", data: "x" }] } } }),
    ).toBe(true)
    expect(ComputerScreenshotHistory.hasMedia({ metadata: { screenshots: ["x"] } })).toBe(true)
    let deep: Record<string, unknown> = {}
    const root = deep
    for (let index = 0; index < 100; index++) deep = deep.next = {}
    expect(ComputerScreenshotHistory.hasMedia(root)).toBe(true)
  })
})

describe("the removal marker (E13's tombstone)", () => {
  test("media goes, the rest of the step stays, and the marker is set", () => {
    const part = computer()
    const removed = ComputerScreenshotHistory.tombstone(part)
    expect(removed).not.toBe(part)
    expect(removed.state).toEqual({
      status: "completed",
      input: { action: "screenshot" },
      output: "Looked at Numbers",
      title: "Looked at Numbers",
      metadata: { action: "screenshot", app: "Numbers", screenshotRemoved: true },
      time: { start: 1, end: 100 },
    })
    expect({ ...removed, state: undefined }).toEqual({ ...part, state: undefined })
    // The original object is not changed: the history store applies the copy itself.
    expect(part.state.attachments).toHaveLength(1)
  })

  test("a page applies every deletion it missed and leaves the rest untouched", () => {
    const old = computer({ id: "prt_old", end: 10 })
    const recent = computer({ id: "prt_new", end: 1_000 })
    const text = { id: "prt_text", type: "text", sessionID: "ses_a", text: "hello" }
    const [first, second, third] = ComputerScreenshotHistory.apply<{ type: string; sessionID?: string }>(
      [old, recent, text],
      [{ before: 100 }],
    )
    expect((first as typeof old).state).toMatchObject({ metadata: { screenshotRemoved: true } })
    expect(second).toBe(recent)
    expect(third).toBe(text)
    expect(ComputerScreenshotHistory.apply([recent], [{ before: 100 }, { sessionID: "ses_a" }])[0]).not.toBe(recent)
  })
})
