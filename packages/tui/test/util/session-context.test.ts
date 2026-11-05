import { describe, expect, test } from "bun:test"
import type { AssistantMessage } from "@vectordevai/sdk/v2"
import { getSessionContext } from "../../src/util/session-context"

const empty = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
const assistant = (
  id: string,
  tokens: AssistantMessage["tokens"],
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage => ({
  id,
  sessionID: "ses_context",
  role: "assistant",
  parentID: "msg_user",
  providerID: "openai",
  modelID: "gpt-test",
  mode: "build",
  agent: "build",
  path: { cwd: "/repo", root: "/repo" },
  time: { created: 1, completed: 2 },
  finish: "stop",
  cost: 0.1,
  tokens,
  ...overrides,
})

describe("getSessionContext", () => {
  test("uses the latest cached tool turn even when visible output is zero", () => {
    const previous = assistant("previous", { ...empty, input: 500, output: 10 })
    const cached = assistant("cached", { ...empty, reasoning: 200, cache: { read: 500, write: 10 } })
    expect(getSessionContext([previous, cached])).toEqual({ message: cached, tokens: 510 })
  })

  test("uses authoritative totals without allowing them to hide known context components", () => {
    const known = { ...empty, input: 100, output: 20, reasoning: 400, cache: { read: 300, write: 80 } }
    expect(getSessionContext([assistant("reported", { ...known, total: 900 })])?.tokens).toBe(900)
    for (const total of [0, 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(getSessionContext([assistant("fallback", { ...known, total })])?.tokens).toBe(500)
    }
  })

  test("reasoning alone establishes context only through a reported total", () => {
    const reported = assistant("reasoning", { ...empty, reasoning: 400, total: 400 })
    expect(getSessionContext([reported])).toEqual({ message: reported, tokens: 400 })
    expect(getSessionContext([assistant("unreported", { ...empty, reasoning: 400 })])).toBeUndefined()
  })

  test("keeps positive usage from partial and errored turns", () => {
    const previous = assistant("previous", { ...empty, input: 100, output: 10 })
    for (const overrides of [
      { time: { created: 3 }, finish: undefined },
      { error: { name: "UnknownError" as const, data: { message: "Stream interrupted" } } },
    ]) {
      const latest = assistant("partial", { ...empty, cache: { read: 750, write: 0 } }, overrides)
      expect(getSessionContext([previous, latest])).toEqual({ message: latest, tokens: 750 })
    }
  })

  test("skips pending or failed placeholders that reported no context usage", () => {
    const measured = assistant("measured", { ...empty, cache: { read: 750, write: 0 } })
    const pending = assistant("pending", empty, { time: { created: 3 }, finish: undefined, cost: 0 })
    const failed = assistant("failed", empty, {
      error: { name: "UnknownError", data: { message: "Request failed" } },
      cost: 0,
    })
    expect(getSessionContext([measured, pending, failed])).toEqual({ message: measured, tokens: 750 })
    expect(getSessionContext([pending, failed])).toBeUndefined()
    expect(getSessionContext([])).toBeUndefined()
  })

  test("does not change recorded costs or lifetime token components", () => {
    const message = assistant("measured", { ...empty, input: 100, output: 20, reasoning: 400 })
    const before = structuredClone(message)
    expect(getSessionContext([message])?.tokens).toBe(120)
    expect(message).toEqual(before)
  })
})
