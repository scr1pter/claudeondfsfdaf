import { describe, expect, test } from "bun:test"
import { DateTime, Option, Schema } from "effect"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { EventV2 } from "@vectordevai/core/event"
import { ModelV2 } from "@vectordevai/core/model"
import { SessionEvent } from "@vectordevai/schema/session-event"
import { stepUsage, summarizeUsage } from "@/session/session"
import { SessionID } from "@/session/schema"

describe("session usage", () => {
  test("aggregates real assistant usage into daily activity and streaks", () => {
    const today = new Date()
    today.setHours(12, 0, 0, 0)
    const yesterday = new Date(today)
    yesterday.setDate(yesterday.getDate() - 1)
    const earlier = new Date(today)
    earlier.setDate(earlier.getDate() - 4)

    const result = summarizeUsage([
      assistant(today.getTime(), 100, 0.02, 5_000),
      assistant(yesterday.getTime(), 50, 0.01, 2_000),
      assistant(earlier.getTime(), 25, 0.005, 1_000),
    ])

    expect(result.lifetimeTokens).toBe(175)
    expect(result.lifetimeCost).toBeCloseTo(0.035)
    expect(result.peakTokens).toBe(100)
    expect(result.longestTaskMs).toBe(5_000)
    expect(result.currentStreak).toBe(2)
    expect(result.longestStreak).toBe(2)
    expect(result.completedChats).toBe(3)
    expect(result.conversations).toBe(1)
    expect(result.activeDays).toBe(3)
    expect(result.averageTokensPerChat).toBe(58)
    expect(result.favoriteModels[0]).toMatchObject({
      providerID: "test-provider",
      modelID: "test-model",
      percentage: 100,
    })
    expect(result.effortLevels[0]).toMatchObject({ id: "default", label: "Default", percentage: 100 })
    expect(result.days).toHaveLength(3)
  })

  test("keeps helper spend in the totals but out of task timing and counts", () => {
    const today = new Date()
    today.setHours(12, 0, 0, 0)
    const start = today.getTime()
    const helpers = new Map([["ses_review", "vectorscope.review"]])

    const result = summarizeUsage(
      [
        assistant(start, 100, 0.02, 4_000),
        assistant(start + 10, 60, 0.03, 2_000),
        assistant(start + 20, 900, 0.4, 90_000, { sessionID: "ses_review" }),
      ],
      [],
      helpers,
    )

    expect(result.lifetimeTokens).toBe(1_060)
    expect(result.lifetimeCost).toBeCloseTo(0.45)
    expect(result.modelResponses).toBe(3)
    expect(result.longestTaskMs).toBe(4_000)
    expect(result.longestTaskTokens).toBe(100)
    expect(result.averageTaskMs).toBe(3_000)
    expect(result.completedChats).toBe(2)
    expect(result.conversations).toBe(1)
    expect(result.days[0]?.tasks).toBe(2)
    expect(result.helpers).toEqual([{ id: "vectorscope.review", sessions: 1, responses: 1, tokens: 900, cost: 0.4 }])
  })

  test("keeps Codium activity while excluding every Codium token and cost subtotal", () => {
    const today = new Date()
    today.setHours(12, 0, 0, 0)
    const yesterday = new Date(today)
    yesterday.setDate(yesterday.getDate() - 1)
    const own = assistant(today.getTime(), 100, 0.5, 1_000)
    const codium = {
      ...assistant(yesterday.getTime(), 9_000, 42, 20_000, { providerID: "vector-plan", variant: "max" }),
      tokens: { input: 5_000, output: 1_000, reasoning: 1_000, cache: { read: 1_000, write: 1_000 } },
    }
    const result = summarizeUsage([own, codium])
    expect(result).toMatchObject({
      lifetimeTokens: 100,
      lifetimeCost: 0.5,
      inputTokens: 100,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedTokens: 0,
      peakTokens: 100,
      longestTaskMs: 20_000,
      longestTaskTokens: 0,
      averageTokensPerChat: 50,
      completedChats: 2,
      modelResponses: 2,
      conversations: 1,
      activeDays: 2,
      currentStreak: 2,
      longestStreak: 2,
      unpricedResponses: 1,
      codiumResponses: 1,
    })
    expect(result.days[0]).toMatchObject({ tokens: 0, cost: 0, tasks: 1, codium: 1 })
    expect(result.favoriteModels).toEqual([
      { providerID: "test-provider", modelID: "test-model", tokens: 100, responses: 1, percentage: 100 },
    ])
    expect(result.effortLevels).toEqual([
      { id: "default", label: "Default", tokens: 100, responses: 1, percentage: 100 },
    ])
    expect(codium.tokens.input).toBe(5_000)
  })

  test("counts Codium helpers and deduplicated ancillary attempts without exposing their usage", () => {
    const now = Date.now()
    const title = { ...ancillary(now), billing: "codium" as const, sessionID: SessionID.make("ses_review") }
    const result = summarizeUsage(
      [{ ...assistant(now, 10_000, 12, 50_000, { sessionID: "ses_review" }), billing: "codium" }],
      [title, title],
      new Map([["ses_review", "vectorscope.review"]]),
    )
    expect(result).toMatchObject({
      lifetimeTokens: 0,
      lifetimeCost: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedTokens: 0,
      codiumResponses: 2,
      unpricedResponses: 2,
      modelResponses: 1,
      completedChats: 0,
      activeDays: 0,
    })
    expect(result.favoriteModels).toEqual([])
    expect(result.effortLevels).toEqual([])
    expect(result.days[0]).toMatchObject({ tokens: 0, cost: 0, tasks: 0, codium: 2 })
    expect(result.helpers).toEqual([
      { id: "vectorscope.review", sessions: 1, responses: 1, tokens: 0, cost: 0, codiumSteps: 2 },
    ])
  })

  test("keeps Codium-only days and excludes Codium from zero-token preference percentages", () => {
    const now = Date.now()
    const codium = assistant(now, 0, 0, 1_000, { providerID: "vector-plan" })
    const result = summarizeUsage([codium])
    expect(result.days).toHaveLength(1)
    expect(result.days[0]).toMatchObject({ tokens: 0, tasks: 1, codium: 1 })
    expect(result).toMatchObject({
      completedChats: 1,
      modelResponses: 1,
      activeDays: 1,
      codiumResponses: 1,
      unpricedResponses: 1,
    })
    expect(result.favoriteModels).toEqual([])
    const mixed = summarizeUsage([codium, assistant(now + 1, 0, 0, 1_000)])
    expect(mixed.favoriteModels[0]?.percentage).toBe(100)
    expect(mixed.effortLevels[0]?.percentage).toBe(100)
  })

  test("preserves the V2 stored billing flag and hides Codium compaction usage", () => {
    const sessionID = SessionID.make("ses_codium_v2")
    const base = {
      id: "msg_codium_v2",
      sessionID,
      type: "assistant",
      created: Date.now(),
      completed: Date.now() + 100,
      agent: "build",
      model: JSON.stringify({ id: "m", providerID: "test-provider" }),
      cost: 9,
      unpriced: 0,
      billing: "codium",
      tokens: JSON.stringify({ input: 50, output: 10, reasoning: 5, cache: { read: 4, write: 3 } }),
      finish: "stop",
      error: null,
    }
    const messages = stepUsage([base, { ...base, id: "msg_compaction", type: "compaction", model: null }])
    expect(messages).toHaveLength(2)
    expect(messages.every((message) => message.billing === "codium")).toBe(true)
    const result = summarizeUsage(messages)
    expect(result).toMatchObject({
      lifetimeTokens: 0,
      lifetimeCost: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      codiumResponses: 2,
      unpricedResponses: 2,
      modelResponses: 2,
      completedChats: 1,
    })
    expect(result.favoriteModels).toEqual([])
  })

  test("returns an empty summary before the first model response", () => {
    expect(summarizeUsage([])).toEqual({
      lifetimeTokens: 0,
      lifetimeCost: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedTokens: 0,
      peakTokens: 0,
      longestTaskMs: 0,
      longestTaskTokens: 0,
      averageTaskMs: 0,
      currentStreak: 0,
      longestStreak: 0,
      completedChats: 0,
      conversations: 0,
      activeDays: 0,
      averageTokensPerChat: 0,
      modelResponses: 0,
      favoriteModels: [],
      effortLevels: [],
      days: [],
    })
  })

  test("counts responses on a model with no listed price, which the lifetime cost leaves out", () => {
    const now = Date.now()
    const result = summarizeUsage([
      assistant(now, 600, 0.06, 1_000),
      { ...assistant(now + 1, 300, 0, 1_000), unpriced: true },
    ])
    expect(result.lifetimeCost).toBe(0.06)
    expect(result.unpricedResponses).toBe(1)
  })

  test("adds title spend without changing transcript activity, model attribution, or streaks", () => {
    const today = new Date()
    today.setHours(12, 0, 0, 0)
    const day = (offset: number) => {
      const date = new Date(today)
      date.setDate(date.getDate() + offset)
      return date.getTime()
    }
    const messages = [assistant(day(-1), 100, 0.2, 1_000), assistant(day(-3), 50, 0.1, 2_000)]
    const before = summarizeUsage(messages)
    const after = summarizeUsage(messages, [ancillary(day(0)), ancillary(day(-2)), ancillary(day(-1))])

    expect(after.lifetimeCost).toBeCloseTo(before.lifetimeCost + 0.375)
    expect(after.days.reduce((sum, value) => sum + value.cost, 0)).toBe(after.lifetimeCost)
    expect(after.days.filter((value) => value.tasks === 0)).toHaveLength(2)
    expect(after.days.filter((value) => value.tasks === 0).every((value) => value.tokens === 12)).toBe(true)
    expect(after.lifetimeTokens).toBe(before.lifetimeTokens + 36)
    expect(after.inputTokens).toBe(before.inputTokens + 30)
    expect(after.outputTokens).toBe(before.outputTokens + 6)
    expect(after.favoriteModels).toEqual(before.favoriteModels)
    expect(after.effortLevels).toEqual(before.effortLevels)
    expect(after.completedChats).toBe(before.completedChats)
    expect(after.currentStreak).toBe(1)
    expect(after.longestStreak).toBe(1)
  })

  test("title-only spend does not create assistant responses or activity", () => {
    const result = summarizeUsage([], [ancillary(Date.now())])
    expect(result.lifetimeCost).toBe(0.125)
    expect(result.days).toHaveLength(1)
    expect(result.days[0]).toMatchObject({ cost: 0.125, tasks: 0, tokens: 12 })
    expect(result.lifetimeTokens).toBe(12)
    expect(result.modelResponses).toBe(0)
    expect(result.completedChats).toBe(0)
    expect(result.activeDays).toBe(0)
  })

  test("deduplicates paid attempt identity across sessions while retaining distinct attempts", () => {
    const first = ancillary(Date.now())
    const copy = SessionEvent.AncillaryUsage.data.make({ ...first, sessionID: SessionID.make("ses_copy") })
    const second = { ...first, usageID: EventV2.ID.create() }
    expect(summarizeUsage([], [first, copy, copy, second]).lifetimeCost).toBe(0.25)
    expect(summarizeUsage([], [copy, first])).toEqual(summarizeUsage([], [first]))
  })

  test("conflicting copies count as one unknown attempt without an arbitrary amount or date", () => {
    const first = ancillary(Date.now())
    const conflicts = [
      { ...first, cost: 0.5 },
      { ...first, timestamp: DateTime.makeUnsafe(DateTime.toEpochMillis(first.timestamp) - 86_400_000) },
      { ...first, model: { ...first.model, id: ModelV2.ID.make("other") } },
      { ...first, tokens: { ...first.tokens!, output: 3 } },
      { ...first, incomplete: true },
    ]
    conflicts.forEach((copy) => {
      const expected = { ...summarizeUsage([]), unpricedResponses: 1 }
      expect(summarizeUsage([], [first, copy, first])).toEqual(expected)
      expect(summarizeUsage([], [copy, first, copy])).toEqual(expected)
    })
  })

  test("keeps partial title cost as a subtotal and marks missing usage separately from reported zero", () => {
    const first = ancillary(Date.now())
    const result = summarizeUsage(
      [],
      [
        { ...first, incomplete: true },
        { ...first, usageID: EventV2.ID.create(), cost: 0, unpriced: true },
        { ...first, usageID: EventV2.ID.create(), cost: undefined },
        { ...first, usageID: EventV2.ID.create(), tokens: undefined },
        { ...first, usageID: EventV2.ID.create(), cost: 0 },
      ],
    )
    expect(result.lifetimeCost).toBe(0.25)
    expect(result.unpricedResponses).toBe(4)
    expect(result.modelResponses).toBe(0)
    expect(summarizeUsage([], [{ ...first, cost: 0 }]).unpricedResponses).toBeUndefined()
  })

  test("ranks model and effort preferences by token share", () => {
    const now = Date.now()
    const result = summarizeUsage([
      assistant(now, 600, 0.06, 1_000, { providerID: "anthropic", modelID: "claude-opus-fast", variant: "xhigh" }),
      assistant(now + 1, 300, 0.03, 1_000, { providerID: "openai", modelID: "gpt-5", variant: "medium" }),
      assistant(now + 2, 100, 0.01, 1_000, { providerID: "openai", modelID: "gpt-5", variant: "medium" }),
    ])

    expect(result.favoriteModels).toEqual([
      { providerID: "anthropic", modelID: "claude-opus", tokens: 600, responses: 1, percentage: 60 },
      { providerID: "openai", modelID: "gpt-5", tokens: 400, responses: 2, percentage: 40 },
    ])
    expect(result.effortLevels).toEqual([
      { id: "max", label: "Max", tokens: 600, responses: 1, percentage: 60 },
      { id: "balanced", label: "Balanced", tokens: 400, responses: 2, percentage: 40 },
    ])
    expect(result.days[0]?.tasks).toBe(3)
  })

  // Regression: Session.usage() reads message bodies from the `data` column, which does NOT
  // contain `id`/`sessionID` (those are separate columns). Decoding the raw blob against
  // SessionV1.Info therefore fails and every message is silently dropped, collapsing the
  // whole usage screen to zeros. usage() must merge the columns back before decoding.
  describe("stored-row decode boundary", () => {
    // Shape as persisted in MessageTable.data — no id/sessionID keys.
    const stored = {
      role: "assistant",
      parentID: "msg_parent0001",
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp/vector", root: "/tmp/vector" },
      cost: 0,
      tokens: { total: 8139, input: 8102, output: 23, reasoning: 14, cache: { read: 0, write: 0 } },
      modelID: "anthropic/claude-sonnet-4-5",
      providerID: "anthropic",
      time: { created: Date.now(), completed: Date.now() + 2000 },
      finish: "stop",
    }
    const decode = Schema.decodeUnknownOption(SessionV1.Info)

    test("raw data blob fails to decode without the id/sessionID columns", () => {
      expect(Option.isNone(decode(stored))).toBe(true)
    })

    test("merging id/sessionID from columns decodes and aggregates", () => {
      const decoded = decode({
        ...stored,
        id: "msg_f206a72ca001jl6vbP0871GTzN",
        sessionID: "ses_0dfacf31bffeW0dXr7RumHkEF4",
      })
      expect(Option.isSome(decoded)).toBe(true)
      expect(summarizeUsage(Option.isSome(decoded) ? [decoded.value] : []).lifetimeTokens).toBe(8139)
    })
  })
})

function ancillary(timestamp: number) {
  return Schema.decodeUnknownSync(SessionEvent.AncillaryUsage.data)({
    sessionID: "ses_title",
    timestamp,
    usageID: EventV2.ID.create(),
    purpose: "title",
    model: { providerID: "title-provider", id: "title-model" },
    cost: 0.125,
    tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
  })
}

function assistant(
  created: number,
  tokens: number,
  cost: number,
  duration: number,
  options?: { providerID?: string; modelID?: string; variant?: string; sessionID?: string },
) {
  return {
    id: `message-${created}`,
    sessionID: options?.sessionID ?? "session-usage",
    role: "assistant",
    time: { created, completed: created + duration },
    parentID: `parent-${created}`,
    modelID: options?.modelID ?? "test-model",
    providerID: options?.providerID ?? "test-provider",
    variant: options?.variant,
    mode: "build",
    agent: "build",
    path: { cwd: "/tmp/vector", root: "/tmp/vector" },
    cost,
    tokens: { total: tokens, input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } as unknown as typeof SessionV1.Assistant.Type
}
