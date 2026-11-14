import { describe, expect, test } from "bun:test"
import { Hands } from "@vectordevai/schema/hands"
import {
  composerTakes,
  handoffPrompt,
  holdsHandoff,
  onComposerPrompt,
  requestComposerPrompt,
  type ComposerPrompt,
} from "./composer-handoff"

describe("composer prompts", () => {
  test("go to exactly one composer and report whether one took them", () => {
    expect(requestComposerPrompt({ text: "nobody listening", send: true })).toBe(false)
    const first: ComposerPrompt[] = []
    const second: ComposerPrompt[] = []
    const stopFirst = onComposerPrompt((request) => first.push(request) > 0)
    const stopSecond = onComposerPrompt((request) => second.push(request) > 0)
    expect(requestComposerPrompt({ text: "Fix the finding", send: true })).toBe(true)
    expect(first).toEqual([{ text: "Fix the finding", send: true }])
    expect(second).toEqual([])
    stopFirst()
    stopSecond()
    expect(requestComposerPrompt({ text: "after", send: false })).toBe(false)
  })

  test("a composer that declines (it holds an unsent draft) leaves the request to the next, or to the caller", () => {
    const taken: string[] = []
    const stopBusy = onComposerPrompt(() => false)
    expect(requestComposerPrompt({ text: "Fix the finding", send: true })).toBe(false)
    const stopFree = onComposerPrompt((request) => taken.push(request.text) > 0)
    expect(requestComposerPrompt({ text: "Fix the finding", send: true })).toBe(true)
    expect(taken).toEqual(["Fix the finding"])
    stopBusy()
    stopFree()
  })
})

describe("composer handoff", () => {
  test("a composer takes a prompt only when it is empty and its session shows a message box", () => {
    expect(composerTakes({ dirty: false, context: [], open: true })).toBe(true)
    // A selection added to context stays across sends, so it is not a draft.
    expect(composerTakes({ dirty: false, context: [{}, { comment: "  " }], open: true })).toBe(true)
    expect(composerTakes({ dirty: true, context: [], open: true })).toBe(false)
    // A line comment is sent and cleared with the next message, so it is unsent work.
    expect(composerTakes({ dirty: false, context: [{ comment: "rename this" }], open: true })).toBe(false)
    // A subagent session, or one waiting on a permission or a question, has no message box.
    expect(composerTakes({ dirty: false, context: [], open: false })).toBe(false)
  })

  test("a handed-over prompt is sent only while the composer still holds exactly it", () => {
    const text = "Fix the finding"
    const part = (content: string) => ({ type: "text", content, start: 0, end: content.length })
    expect(holdsHandoff([part(text)], text)).toBe(true)
    // An empty composer is never sent: a submit there stops a running turn.
    expect(holdsHandoff([part("")], text)).toBe(false)
    expect(holdsHandoff([part("")], "")).toBe(false)
    expect(holdsHandoff([part(`${text} and also this`)], text)).toBe(false)
    expect(holdsHandoff([part(text), { type: "image" }], text)).toBe(false)
  })

  test("a computer example becomes a real pill in either composer, and a pill draft is never sent on its own", () => {
    const text = `@${Hands.MENTION} put my October receipts into a Numbers table`
    const mention = `@${Hands.MENTION}`
    const parts = handoffPrompt({ text, send: false, mention: "computer" })
    expect(parts).toEqual([
      { type: "computer", content: mention, start: 0, end: mention.length },
      { type: "text", content: text.slice(mention.length), start: mention.length, end: text.length },
    ])
    expect(handoffPrompt({ text, send: false })).toEqual([{ type: "text", content: text, start: 0, end: text.length }])
    expect(holdsHandoff(parts, text)).toBe(false)
  })
})
