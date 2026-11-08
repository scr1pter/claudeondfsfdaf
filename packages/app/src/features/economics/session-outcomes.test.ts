import { describe, expect, test } from "bun:test"
import { knownCostUsd } from "./economics-types"
import { createSessionOutcomeRecorder, measureReplyTime, outcomeFromSession } from "./session-outcomes"

const usage = { input: 1_000, output: 300, reasoning: 0, cache: { read: 0, write: 0 } }

function session(overrides: Partial<Parameters<typeof outcomeFromSession>[0]> = {}) {
  return outcomeFromSession({
    sessionID: "s1",
    projectId: "/repo",
    messages: [
      { info: { id: "m0", role: "user" } },
      {
        info: {
          id: "m1",
          role: "assistant",
          providerID: "anthropic",
          modelID: "claude-sonnet-5",
          cost: 0.02,
          tokens: usage,
          finish: "stop",
          time: { created: 1_000, completed: 6_000 },
        },
      },
    ],
    spend: { cost: 0.02 },
    parts: { m0: [{ type: "text", text: "fix the login form styling" } as never] },
    ...overrides,
  })
}

describe("outcomeFromSession", () => {
  test("retains failure and spend when an unmetered latest attempt changes the effort preset", () => {
    const info = {
      role: "assistant",
      providerID: "p",
      modelID: "m",
      variant: "low",
      tokens: usage,
      cost: 0.1,
      finish: "stop",
      time: { created: 1, completed: 2 },
    }
    const outcome = session({
      messages: [{ info }, { info: { ...info, variant: "max", tokens: {}, cost: 0, error: { name: "APIError" } } }],
      spend: { cost: 0.1 },
    })
    expect(outcome).toMatchObject({ variant: { kind: "mixed" }, execution: "failed", hadChecks: false })
    expect(outcome).toMatchObject({ costUsd: 0.1, costPriced: false })
    expect(outcome?.usage?.input).toBe(usage.input)
  })

  test("a stopped reply keeps the session's known cost unranked; a refused one leaves it fully priced", () => {
    const info = {
      role: "assistant",
      providerID: "p",
      modelID: "m",
      tokens: usage,
      cost: 0.1,
      finish: "stop",
      time: { created: 1, completed: 2 },
    }
    const ended = (error: { name: string; data?: { statusCode: number } }) =>
      session({
        messages: [{ info }, { info: { ...info, id: "refused", tokens: {}, cost: 0, error } }],
        parts: { refused: [] },
        spend: { cost: 0.1 },
      })
    const stopped = ended({ name: "MessageAbortedError" })
    expect(stopped).toMatchObject({ costUsd: 0.1, costPriced: false, model: "m", execution: "aborted" })
    expect(knownCostUsd(stopped!)).toBeUndefined()
    const refused = ended({ name: "APIError", data: { statusCode: 429 } })
    expect(refused).toMatchObject({ costUsd: 0.1, costPriced: true, model: "m", execution: "failed" })
    expect(knownCostUsd(refused!)).toBe(0.1)
  })

  test("records the provider, model, measured cost, and latency", () => {
    const outcome = session()!
    expect(outcome.provider).toBe("anthropic")
    expect(outcome.model).toBe("claude-sonnet-5")
    expect(outcome.costUsd).toBeCloseTo(0.02, 10)
    // Every response had a price, so even a 0 here would mean free rather than unknown.
    expect(outcome.costPriced).toBe(true)
    expect(outcome.usage?.input).toBe(1_000)
    expect(outcome.latencyMs).toBe(5_000)
    expect(outcome.latencyKind).toBe("assistant-reply-sum")
    expect(outcome.execution).toBe("completed")
  })

  test("execution status follows terminal evidence without inventing validation or discarding paid work", () => {
    const info = {
      id: "assistant",
      role: "assistant",
      providerID: "p",
      modelID: "m",
      cost: 0.1,
      tokens: usage,
      time: { created: 1, completed: 2 },
      finish: "stop",
    }
    for (const [patch, execution] of [
      [{ error: { name: "APIError" } }, "failed"],
      [{ error: { name: "MessageAbortedError" } }, "aborted"],
      [{ finish: "length" }, "incomplete"],
      [{ finish: "tool-calls" }, "incomplete"],
      [{ time: { created: 1 } }, "incomplete"],
      [{ finish: undefined }, "incomplete"],
      [{ finish: "tool-calls", structured: { answer: true } }, "completed"],
    ] as const) {
      const result = session({ messages: [{ info: { ...info, ...patch } }], spend: { cost: 0.1 } })!
      expect(result.execution).toBe(execution)
      expect(result.costUsd).toBe(0.1)
      expect(result.hadChecks).toBe(false)
      expect(result.checksPassed).toBeUndefined()
    }
    expect(session({ messages: [{ info }, { info: { role: "user" } }], spend: { cost: 0.1 } })?.execution).toBe(
      "incomplete",
    )
    expect(
      session({
        messages: [{ info }, { info: { ...info, id: "copied", forked: true, error: { name: "APIError" } } }],
        spend: { cost: 0.1 },
      })?.execution,
    ).toBe("completed")
    const mixed = session({
      messages: [{ info }, { info: { ...info, modelID: "different", tokens: {}, error: { name: "APIError" } } }],
      spend: { cost: 0.1 },
    })
    expect(mixed?.execution).toBe("failed")
    expect(mixed?.mixedModels).toBe(true)
    expect(mixed?.model).toBeUndefined()
    expect(mixed?.costUsd).toBeUndefined()
  })

  test("counts what the session's subagents spent as part of its cost", () => {
    expect(session({ spend: { cost: 0.02, subagentCost: 0.5 } })!.costUsd).toBeCloseTo(0.52, 10)
    // A subagent step with no listed price leaves the task's cost unknown, not short.
    const unpriced = session({ spend: { cost: 0.02, subagentCost: 0.5, subagentUnpricedSteps: 1 } })!
    expect(unpriced.costUsd).toBeUndefined()
    expect(unpriced.costPriced).toBeUndefined()
  })

  test("measures latency from this session's own replies, not history a fork copied in", () => {
    const outcome = session({
      messages: [
        { info: { id: "m0", role: "user" } },
        {
          info: {
            id: "old",
            role: "assistant",
            providerID: "anthropic",
            modelID: "claude-sonnet-5",
            cost: 0,
            forked: true,
            tokens: usage,
            time: { created: 1_000, completed: 2_000 },
          },
        },
        {
          info: {
            id: "m1",
            role: "assistant",
            providerID: "anthropic",
            modelID: "claude-sonnet-5",
            cost: 0.02,
            tokens: usage,
            time: { created: 3_600_000, completed: 3_660_000 },
          },
        },
      ],
    })!
    expect(outcome.latencyMs).toBe(60_000)
  })

  test("keeps the same sample identity across later session captures", () => {
    expect(session()!.id).toBe(session()!.id)
    expect(session()!.id).toContain("s1")
  })

  test("sums active response duration without counting time between user turns", () => {
    const messages = [
      {
        info: {
          role: "assistant",
          providerID: "p",
          modelID: "m",
          tokens: usage,
          cost: 0.1,
          time: { created: 1_000, completed: 3_000 },
        },
      },
      {
        info: {
          role: "assistant",
          providerID: "p",
          modelID: "m",
          tokens: usage,
          cost: 0.2,
          time: { created: 3_600_000, completed: 3_601_000 },
        },
      },
    ]
    expect(session({ messages })?.latencyMs).toBe(3_000)
    expect(session({ messages, spend: { cost: 0.3 } })?.costUsd).toBeCloseTo(0.3)
  })

  test("does not invent duration for unfinished or invalid replies", () => {
    const messages = [
      { info: { role: "assistant", providerID: "p", modelID: "m", tokens: usage, time: { created: 1_000 } } },
      {
        info: {
          role: "assistant",
          providerID: "p",
          modelID: "m",
          tokens: usage,
          time: { created: NaN, completed: 3_000 },
        },
      },
    ]
    expect(session({ messages })?.latencyMs).toBeUndefined()
    expect(session({ messages })?.latencyKind).toBeUndefined()
  })

  test("a completed recovery does not hide an earlier unknown interval, including an unmetered attempt", () => {
    const info = {
      role: "assistant",
      providerID: "p",
      modelID: "m",
      variant: "low",
      tokens: usage,
      cost: 0.1,
      finish: "stop",
      time: { created: 10, completed: 30 },
    }
    for (const tokens of [usage, {}]) {
      const outcome = session({
        messages: [{ info: { ...info, tokens, error: { name: "APIError" }, time: { created: 1 } } }, { info }],
        spend: { cost: 0.2 },
      })!
      expect(outcome.execution).toBe("completed")
      expect(outcome.usage?.input).toBeGreaterThanOrEqual(usage.input)
      expect(outcome.latencyMs).toBeUndefined()
      expect(outcome.latencyKind).toBeUndefined()
    }
  })

  test("timing rejects missing, reversed, nonfinite or overflowing sums but preserves measured zero", () => {
    for (const time of [
      undefined,
      { created: 1 },
      { created: 3, completed: 2 },
      { created: -1, completed: 2 },
      { created: NaN, completed: 2 },
      { created: 1, completed: Infinity },
    ]) {
      expect(measureReplyTime([{ role: "assistant", time }])).toBeUndefined()
    }
    expect(measureReplyTime([])).toBeUndefined()
    expect(measureReplyTime([{ role: "assistant", time: { created: 1, completed: 1 } }])).toEqual({
      latencyMs: 0,
      latencyKind: "assistant-reply-sum",
    })
    expect(
      measureReplyTime([
        { role: "assistant", time: { created: 0, completed: Number.MAX_VALUE } },
        { role: "assistant", time: { created: 0, completed: Number.MAX_VALUE } },
      ]),
    ).toBeUndefined()
  })

  test("timing excludes fork copies and user gaps while retaining recorded tools and waits in reply spans", () => {
    expect(
      measureReplyTime([
        { role: "assistant", forked: true, time: { created: 0 } },
        { role: "user", time: { created: 1 } },
        { role: "assistant", time: { created: 2, completed: 12 } },
        { role: "user", time: { created: 10_000 } },
        { role: "assistant", time: { created: 10_002, completed: 10_032 } },
      ]),
    ).toEqual({ latencyMs: 40, latencyKind: "assistant-reply-sum" })
  })

  test("categorises from the first user message", () => {
    expect(session()!.category).toBeTruthy()
  })

  test("returns undefined when nothing reached a provider", () => {
    expect(session({ messages: [{ info: { id: "m0", role: "user" } }] })).toBeUndefined()
  })

  test("returns undefined when usage was never reported", () => {
    expect(
      session({
        messages: [{ info: { id: "m1", role: "assistant", providerID: "x", modelID: "y", cost: 0 } }],
      }),
    ).toBeUndefined()
  })

  test("counts distinct edited files, not tool calls", () => {
    const outcome = session({
      parts: {
        m0: [{ type: "text", text: "do it" } as never],
        m1: [
          { type: "tool", tool: "edit", state: { input: { filePath: "a.ts" } } },
          { type: "tool", tool: "edit", state: { input: { filePath: "a.ts" } } },
          { type: "tool", tool: "write", state: { input: { filePath: "b.ts" } } },
          { type: "tool", tool: "read", state: { input: { filePath: "c.ts" } } },
        ],
      },
    })!
    expect(outcome.changedFiles).toBe(2)
  })

  test("tolerates a session with no parts at all", () => {
    const outcome = session({ parts: {} })!
    expect(outcome.changedFiles).toBe(0)
    expect(outcome.category).toBeTruthy()
  })
})

describe("session outcome refresh", () => {
  test("retries a failed capture without marking its revision recorded", async () => {
    const calls: number[] = []
    const recorder = createSessionOutcomeRecorder(async () => {
      calls.push(1)
      if (calls.length === 1) throw new Error("history fetch failed")
    })
    await recorder.idle("s1", "/repo/retry")
    expect(calls).toHaveLength(2)
    await recorder.idle("s1", "/repo/retry")
    expect(calls).toHaveLength(2)
  })

  test("bounds persistent failures per revision and permits a later turn to recover", async () => {
    const state = { calls: 0, fail: true }
    const recorder = createSessionOutcomeRecorder(async () => {
      state.calls += 1
      if (state.fail) throw new Error("storage unavailable")
    })
    await Promise.all([recorder.idle("s1", "/repo/failure"), recorder.idle("s1", "/repo/failure")])
    await recorder.idle("s1", "/repo/failure")
    expect(state.calls).toBe(3)
    state.fail = false
    recorder.changed("s1", "/repo/failure", 10)
    await recorder.idle("s1", "/repo/failure")
    expect(state.calls).toBe(4)
  })

  test("duplicate idles, including missing usage, fetch once until new work completes", async () => {
    const calls: string[] = []
    const recorder = createSessionOutcomeRecorder(async (sessionID) => {
      calls.push(sessionID)
    })
    await Promise.all([recorder.idle("s1", "/repo"), recorder.idle("s1", "/repo")])
    await recorder.idle("s1", "/repo")
    expect(calls).toEqual(["s1"])
    recorder.changed("s1", "/repo", 20)
    await recorder.idle("s1", "/repo")
    recorder.changed("s1", "/repo", 10)
    await recorder.idle("s1", "/repo")
    expect(calls).toEqual(["s1", "s1"])
  })

  test("coalesces a newer idle while rejecting the superseded in-flight snapshot", async () => {
    const gate = Promise.withResolvers<void>()
    const committed: string[] = []
    const calls: string[] = []
    const recorder = createSessionOutcomeRecorder(async (sessionID, _directory, current) => {
      calls.push(sessionID)
      if (calls.length === 1) await gate.promise
      if (current()) committed.push(sessionID)
    })
    recorder.changed("s1", "/repo", 10)
    const first = recorder.idle("s1", "/repo")
    recorder.changed("s1", "/repo", 20)
    const next = recorder.idle("s1", "/repo")
    gate.resolve()
    await Promise.all([first, next])
    expect(calls).toHaveLength(2)
    expect(committed).toEqual(["s1"])
  })

  test("a root update during capture retries even without another idle event", async () => {
    const gate = Promise.withResolvers<void>()
    const committed: boolean[] = []
    const recorder = createSessionOutcomeRecorder(async (_id, _directory, current) => {
      if (!committed.length) await gate.promise
      committed.push(current())
    })
    recorder.changed("s1", "/repo", 10)
    const pending = recorder.idle("s1", "/repo")
    recorder.changed("s1", "/repo", 20)
    gate.resolve()
    await pending
    expect(committed).toEqual([false, true])
  })

  test("isolates directories and stops pending writes after disposal", async () => {
    const gate = Promise.withResolvers<void>()
    const committed: string[] = []
    const recorder = createSessionOutcomeRecorder(async (_sessionID, directory, current) => {
      if (directory === "/repo/slow") await gate.promise
      if (current()) committed.push(directory)
    })
    const pending = recorder.idle("s1", "/repo/slow")
    await recorder.idle("s1", "/repo/fast")
    recorder.dispose()
    gate.resolve()
    await pending
    expect(committed).toEqual(["/repo/fast"])
  })
})

test("session task cost includes title spend without changing main model or token attribution", () => {
  const outcome = session({ spend: { cost: 0.025, subagentCost: 0.5 } })!
  expect(outcome.costUsd).toBeCloseTo(0.525)
  expect(outcome.provider).toBe("anthropic")
  expect(outcome.model).toBe("claude-sonnet-5")
  expect(outcome.usage?.input).toBe(1_000)
  expect(session({ spend: { cost: 0.025, unpricedSteps: 1 } })?.costUsd).toBeUndefined()
  expect(session({ spend: undefined })?.costUsd).toBeUndefined()
})

test("late ancillary usage refreshes an already recorded idle session", async () => {
  const calls: string[] = []
  const recorder = createSessionOutcomeRecorder(async (id) => {
    calls.push(id)
  })
  recorder.changed("s1", "/repo", 100)
  await recorder.idle("s1", "/repo")
  await recorder.refresh("s1", "/repo", 101)
  await recorder.idle("s1", "/repo")
  expect(calls).toEqual(["s1", "s1"])
  recorder.dispose()
})

test("Codium and mixed delegated Codium usage never become dollar recommendation evidence", () => {
  expect(session({ spend: { cost: 0.02, codiumSteps: 1 } })).toBeUndefined()
  expect(session({ spend: { cost: 0.02, subagentCodiumSteps: 1 } })).toBeUndefined()
  expect(
    session({
      messages: [
        {
          info: {
            role: "assistant",
            providerID: "vector-plan",
            modelID: "vector-flash",
            tokens: usage,
            cost: 0,
            finish: "stop",
          },
        },
      ],
    }),
  ).toBeUndefined()
})
