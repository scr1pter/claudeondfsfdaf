import { afterEach, describe, expect, test } from "bun:test"

import {
  advanceSchedule,
  createScheduledAgents,
  describeCatchUp,
  pausedStatus,
  scheduledAgentTargets,
  type ScheduledAgentEngine,
  type ScheduledAgentRecord,
} from "./scheduled-agents"

const once = { kind: "once", at: "2026-08-20T10:00:00.000Z" } as const
const daily = { kind: "daily", time: "09:00" } as const
const weekdays = { kind: "weekdays", time: "09:00" } as const
const mondays = { kind: "weekly", weekday: 1, time: "09:00" } as const

// The recurrence arithmetic runs in the process's local zone, so a real DST
// assertion needs a process pinned to a zone that observes one. Bun fixes the
// zone the first time a Date is built — which a sibling test file may already
// have done — so this runs in a fresh process rather than hoping a late
// process.env.TZ still takes.
function inNewYork(script: string): unknown {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      [
        `const { advanceSchedule } = await import(${JSON.stringify(`${import.meta.dir}/scheduled-agents.ts`)})`,
        `console.log(JSON.stringify((() => {${script}})()))`,
      ].join("\n"),
    ],
    cwd: import.meta.dir,
    env: { ...process.env, TZ: "America/New_York" },
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  const report = result.stdout
    .toString()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .findLast((line) => line.startsWith("{") || line.startsWith("["))
  if (!report) throw new Error(`The time-zone subprocess returned no JSON.\n${result.stdout.toString()}`)
  return JSON.parse(report)
}

describe("pausedStatus — pausing", () => {
  test("parks a pending run", () => {
    expect(pausedStatus({ status: "scheduled", recurrence: once }, true)).toBe("canceled")
  })

  test("leaves every other state untouched", () => {
    for (const status of ["running", "completed", "failed", "canceled"] as const) {
      expect(pausedStatus({ status, recurrence: once }, true)).toBe(status)
    }
  })
})

describe("pausedStatus — resuming", () => {
  test("re-arms a run that pausing had parked", () => {
    expect(pausedStatus({ status: "canceled", recurrence: once }, false)).toBe("scheduled")
  })

  test("does NOT resurrect a finished one-shot run", () => {
    // The bug this guards: resuming used to force "scheduled" unconditionally,
    // so a completed or failed one-shot task ran a second time.
    expect(pausedStatus({ status: "completed", recurrence: once }, false)).toBe("completed")
    expect(pausedStatus({ status: "failed", recurrence: once }, false)).toBe("failed")
  })

  test("does not disturb a run that is currently executing", () => {
    expect(pausedStatus({ status: "running", recurrence: once }, false)).toBe("running")
  })

  test("a one-shot task with no recurrence behaves like an explicit once", () => {
    expect(pausedStatus({ status: "completed", recurrence: undefined }, false)).toBe("completed")
    expect(pausedStatus({ status: "canceled", recurrence: undefined }, false)).toBe("scheduled")
  })

  test("re-arms a recurring task even from a terminal state", () => {
    // A pause straddling a run leaves a recurring task "completed" (the
    // completion handler only reschedules when !paused), so resuming has to
    // put it back on the schedule or the task is silently dead forever.
    expect(pausedStatus({ status: "completed", recurrence: daily }, false)).toBe("scheduled")
    expect(pausedStatus({ status: "failed", recurrence: daily }, false)).toBe("scheduled")
    expect(pausedStatus({ status: "canceled", recurrence: daily }, false)).toBe("scheduled")
  })
})

describe("advanceSchedule — recurrence arithmetic", () => {
  test("daily keeps the same wall-clock time across spring forward", () => {
    // Clocks jump forward at 02:00 on 2026-03-08 in New York, so 09:00 the next
    // morning is only 23 real hours away — the proof this is wall-clock
    // arithmetic and not "the last run plus 24 hours".
    const report = inNewYork(`
      const slot = new Date(2026, 2, 7, 9, 0, 0, 0)
      const advanced = advanceSchedule({ kind: "daily", time: "09:00" }, slot, slot)
      return {
        day: advanced.next.getDate(),
        hours: advanced.next.getHours(),
        minutes: advanced.next.getMinutes(),
        elapsedHours: (advanced.next.getTime() - slot.getTime()) / 3600000,
      }
    `)
    expect(report).toEqual({ day: 8, hours: 9, minutes: 0, elapsedHours: 23 })
  })

  test("daily keeps the same wall-clock time across fall back", () => {
    // Clocks go back at 02:00 on 2026-11-01 in New York: a 25-hour day.
    const report = inNewYork(`
      const slot = new Date(2026, 9, 31, 9, 0, 0, 0)
      const advanced = advanceSchedule({ kind: "daily", time: "09:00" }, slot, slot)
      return {
        month: advanced.next.getMonth(),
        day: advanced.next.getDate(),
        hours: advanced.next.getHours(),
        minutes: advanced.next.getMinutes(),
        elapsedHours: (advanced.next.getTime() - slot.getTime()) / 3600000,
      }
    `)
    expect(report).toEqual({ month: 10, day: 1, hours: 9, minutes: 0, elapsedHours: 25 })
  })

  test("a weekly task still lands on its weekday across the same boundary", () => {
    const report = inNewYork(`
      const slot = new Date(2026, 9, 26, 9, 0, 0, 0)
      const advanced = advanceSchedule({ kind: "weekly", weekday: 1, time: "09:00" }, slot, slot)
      return {
        weekday: advanced.next.getDay(),
        month: advanced.next.getMonth(),
        day: advanced.next.getDate(),
        hours: advanced.next.getHours(),
      }
    `)
    expect(report).toEqual({ weekday: 1, month: 10, day: 2, hours: 9 })
  })

  test("weekly picks the right weekday, a whole week on", () => {
    const slot = new Date(2026, 7, 17, 9, 0, 0, 0)
    expect(slot.getDay()).toBe(1)
    const advanced = advanceSchedule(mondays, slot, slot)
    expect(advanced?.next.getDay()).toBe(1)
    expect(advanced?.next.getDate()).toBe(24)
    expect(advanced?.next.getHours()).toBe(9)
  })

  test("weekly from a mid-week slot lands on the next Monday, not seven days out", () => {
    const advanced = advanceSchedule(mondays, new Date(2026, 7, 19, 9, 0, 0, 0), new Date(2026, 7, 19, 9, 0, 0, 0))
    expect(advanced?.next.getDay()).toBe(1)
    expect(advanced?.next.getDate()).toBe(24)
  })

  test("weekdays steps over the weekend", () => {
    const friday = new Date(2026, 7, 21, 9, 0, 0, 0)
    expect(friday.getDay()).toBe(5)
    const advanced = advanceSchedule(weekdays, friday, friday)
    expect(advanced?.next.getDay()).toBe(1)
    expect(advanced?.next.getDate()).toBe(24)
  })

  test("a late or long run does not drag the schedule later", () => {
    // Ran at 09:00, finished at 16:42. Anchoring on the slot instead of the
    // clock is what keeps tomorrow at 09:00 rather than 16:42.
    const advanced = advanceSchedule(daily, new Date(2026, 7, 19, 9, 0, 0, 0), new Date(2026, 7, 19, 16, 42, 0, 0))
    expect(advanced?.next.getDate()).toBe(20)
    expect(advanced?.next.getHours()).toBe(9)
    expect(advanced?.next.getMinutes()).toBe(0)
    expect(advanced?.skipped).toBe(0)
  })

  test("a window missed while the app was closed collapses into one occurrence", () => {
    const advanced = advanceSchedule(daily, new Date(2026, 7, 14, 9, 0, 0, 0), new Date(2026, 7, 19, 10, 0, 0, 0))
    expect(advanced?.next.getDate()).toBe(20)
    expect(advanced?.next.getHours()).toBe(9)
    // 15th, 16th, 17th, 18th and this morning's 19th all elapsed unrun.
    expect(advanced?.skipped).toBe(5)
  })

  test("a one-shot never advances", () => {
    expect(advanceSchedule(once, new Date(once.at), new Date(once.at))).toBeUndefined()
  })
})

describe("describeCatchUp", () => {
  test("stays quiet when nothing was missed", () => {
    expect(describeCatchUp({ missedRuns: undefined })).toBeUndefined()
    expect(describeCatchUp({ missedRuns: 0 })).toBeUndefined()
  })

  test("says how many runs were skipped", () => {
    expect(describeCatchUp({ missedRuns: 4 })).toContain("4 earlier runs were missed")
    expect(describeCatchUp({ missedRuns: 1 })).toContain("1 earlier run was")
  })
})

describe("scheduledAgentTargets", () => {
  test("reads a legacy single-directory record as one target", () => {
    expect(scheduledAgentTargets({ directory: "/repos/alpha" })).toEqual([{ directory: "/repos/alpha" }])
  })

  test("ignores an empty targets array rather than running nowhere", () => {
    expect(scheduledAgentTargets({ directory: "/repos/alpha", targets: [] })).toEqual([{ directory: "/repos/alpha" }])
  })
})

// --- Engine-level harness -------------------------------------------------
// Everything below drives the real scheduler with an injected clock, store and
// engine transport. Nothing sleeps: the injected delay advances the clock,
// which is also what settles the engine's active-session registry.

const ENGINE: ScheduledAgentEngine = { url: "http://127.0.0.1:4096", username: null, password: null }

const started: Array<{ stop: () => void }> = []
afterEach(() => started.splice(0).forEach((runtime) => runtime.stop()))

function harness(options: {
  at: Date
  records?: ScheduledAgentRecord[]
  failing?: string[]
  sessions?: Record<string, string>
  onActivePoll?: () => void
  legacyShape?: boolean
  staleAssistantPolls?: number
  incompleteAssistantPolls?: number
  allowance?: {
    allowed: boolean
    state: "ok" | "warn" | "blocked"
    reason?: string
    remainingUsd?: number
    budgetUsd?: number
  }
  // `prompted` says whether this session has been prompted in this harness,
  // so a reading can differ before and after the run.
  spend?: (sessionId: string, prompted: boolean) => unknown
  sessionModel?: { providerID: string; id: string }
  sessionUsage?: (completed: boolean) => Record<string, unknown>
  promptFailure?: string
  // How the turn's last assistant message finished, "stop" unless set.
  finish?: string
}) {
  const clock = { at: options.at }
  const persisted = { value: JSON.parse(JSON.stringify(options.records ?? [])) as unknown }
  const calls: string[] = []
  const aborted: string[] = []
  const sessionDirectory = new Map(Object.entries(options.sessions ?? {}))
  const promptedAt = new Map<string, number>()
  const created: string[] = []
  const createdModels: unknown[] = []
  const spendChecks: Array<{ runId: string; source: string; reserve?: boolean; billing?: "codium" }> = []
  const reserved = new Map<string, number>()
  const released: string[] = []
  const prompts: unknown[] = []
  const spendRecords: Array<{
    projectPath: string
    runId: string
    provider: string
    model: string
    source: string
    totalCostUsd?: number
    totalTokens?: number
    billing?: "codium"
  }> = []
  let contextPolls = 0

  const runtime = createScheduledAgents({
    // Round-trips through JSON exactly as electron-store does, so a field this
    // module sets to undefined really does vanish from the stored record.
    store: {
      get: () => JSON.parse(JSON.stringify(persisted.value)),
      set: (_key, value) => {
        persisted.value = JSON.parse(JSON.stringify(value))
      },
    },
    now: () => new Date(clock.at),
    delay: async (milliseconds) => {
      clock.at = new Date(clock.at.getTime() + milliseconds)
    },
    spend: async () => ({
      checkAllowance: async (input) => {
        spendChecks.push(input)
        if (input.billing === "codium") return { allowed: true, state: "ok", unmeasuredRuns: 0 }
        const allowance = {
          unmeasuredRuns: 0,
          ...(options.allowance ?? { allowed: true, state: "ok" as const }),
        }
        // The real ledger's budget is its remaining headroom under a per-run cap.
        const budgetUsd = allowance.budgetUsd ?? allowance.remainingUsd
        if (input.reserve && allowance.allowed && budgetUsd !== undefined) reserved.set(input.runId, budgetUsd)
        return { ...allowance, budgetUsd }
      },
      recordRunCost: async (input) => {
        spendRecords.push(input)
        return undefined
      },
      release: (runId) => {
        released.push(runId)
      },
    }),
    request: async (_engine, path, init) => {
      calls.push(`${init?.method ?? "GET"} ${path}`)
      if (path === "/api/session") {
        const id = `ses_new_${created.length + 1}`
        created.push(id)
        const body = init?.body as
          | { location?: { directory?: string }; model?: { providerID?: string; id?: string; variant?: string } }
          | undefined
        sessionDirectory.set(id, body?.location?.directory ?? "")
        createdModels.push(body?.model)
        return { data: { id } }
      }
      if (path === "/api/session/active") {
        options.onActivePoll?.()
        // A prompted session stays in the registry until the clock moves, which
        // it only does inside the injected delay — so every run is observed
        // active exactly once and then settles.
        return {
          data: Object.fromEntries(
            [...promptedAt].filter(([, at]) => clock.at.getTime() <= at).map(([id]) => [id, {}]),
          ),
        }
      }
      const session = /^\/api\/session\/([^/]+)$/.exec(path)
      if (session) {
        const sessionId = decodeURIComponent(session[1] ?? "")
        const completed = promptedAt.has(sessionId)
        return {
          data: {
            cost: completed ? 0.25 : 0,
            // The default transport represents a modern engine with separated own-token aggregates.
            tokensOwnOnly: true,
            subagentTokensOwnOnly: true,
            tokens: {
              input: completed ? 10 : 0,
              output: completed ? 5 : 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            model: options.sessionModel ?? { providerID: "provider-test", id: "model-test" },
            ...options.sessionUsage?.(completed),
          },
        }
      }
      const match = /^\/api\/session\/([^/]+)\/([a-z]+)/.exec(path)
      const sessionId = decodeURIComponent(match?.[1] ?? "")
      if (match?.[2] === "spend") return options.spend?.(sessionId, promptedAt.has(sessionId)) ?? {}
      if (match?.[2] === "prompt") {
        prompts.push(init?.body)
        if (options.promptFailure) throw new Error(options.promptFailure)
        promptedAt.set(sessionId, clock.at.getTime())
        return { data: { id: "msg_0001" } }
      }
      if (match?.[2] === "interrupt") {
        aborted.push(sessionId)
        promptedAt.delete(sessionId)
        return undefined
      }
      const failed = options.failing?.includes(sessionDirectory.get(sessionId) ?? "")
      const error = failed ? { message: `boom in ${sessionDirectory.get(sessionId)}` } : undefined
      contextPolls += 1
      if (contextPolls <= (options.staleAssistantPolls ?? 0)) {
        return { data: [{ id: "msg_0000", type: "assistant", finish: "stop" }] }
      }
      if (contextPolls <= (options.staleAssistantPolls ?? 0) + (options.incompleteAssistantPolls ?? 0)) {
        return { data: [{ id: "msg_0002", type: "assistant" }] }
      }
      // The shape the v2 route this module calls actually returns: a flat
      // message, no `info` envelope. The fixture used to return the legacy
      // envelope, which is precisely why every run being recorded as failed
      // went unnoticed here while failing against a real engine.
      if (options.legacyShape) return { data: [{ info: { id: "msg_0002", role: "assistant", error } }] }
      return { data: [{ id: "msg_0002", type: "assistant", finish: options.finish ?? "stop", error }] }
    },
  })

  runtime.start(async () => ENGINE)
  started.push(runtime)
  return {
    runtime,
    clock,
    calls,
    aborted,
    created,
    createdModels,
    spendChecks,
    spendRecords,
    reserved,
    released,
    prompts,
    contextPolls: () => contextPolls,
    record: (id = "task-1") => runtime.list().find((item) => item.id === id),
  }
}

function scheduledRecord(overrides: Partial<ScheduledAgentRecord>): ScheduledAgentRecord {
  return {
    id: "task-1",
    prompt: "Summarise what changed overnight.",
    model: { providerID: "provider-current", id: "model-current", variant: "balanced" },
    directory: "/repos/alpha",
    runAt: new Date(2026, 7, 19, 9, 0, 0, 0).toISOString(),
    status: "scheduled",
    createdAt: new Date(2026, 7, 1, 9, 0, 0, 0).toISOString(),
    ...overrides,
  }
}

describe("catching up after the app was closed", () => {
  test("runs once for the whole missed window and says how much it skipped", async () => {
    const harnessed = harness({
      at: new Date(2026, 7, 19, 10, 0, 0, 0),
      // Last fired five days ago; the machine was asleep since.
      records: [scheduledRecord({ recurrence: daily, runAt: new Date(2026, 7, 14, 9, 0, 0, 0).toISOString() })],
    })

    await harnessed.runtime.tick()

    expect(harnessed.calls.filter((call) => call === "POST /api/session")).toHaveLength(1)
    expect(harnessed.calls.filter((call) => call.endsWith("/prompt"))).toHaveLength(1)

    const record = harnessed.record()
    expect(record?.status).toBe("scheduled")
    expect(record?.missedRuns).toBe(5)
    expect(describeCatchUp(record ?? {})).toContain("5 earlier runs were missed")
    const next = new Date(record?.runAt ?? 0)
    expect(next.getDate()).toBe(20)
    expect(next.getHours()).toBe(9)
  })

  test("a second tick right afterwards does not fire the backlog again", async () => {
    const harnessed = harness({
      at: new Date(2026, 7, 19, 10, 0, 0, 0),
      records: [scheduledRecord({ recurrence: daily, runAt: new Date(2026, 7, 14, 9, 0, 0, 0).toISOString() })],
    })

    await harnessed.runtime.tick()
    await harnessed.runtime.tick()
    await harnessed.runtime.tick()

    expect(harnessed.calls.filter((call) => call === "POST /api/session")).toHaveLength(1)
  })

  test("four late runs in a row never drag the daily time off 09:00", async () => {
    const harnessed = harness({
      at: new Date(2026, 7, 19, 9, 0, 0, 0),
      records: [scheduledRecord({ recurrence: daily })],
    })

    const landed: number[] = []
    for (const _day of [1, 2, 3, 4]) {
      // Ticks are 20s apart and a run takes minutes, so every real run starts
      // late. "now + interval" scheduling would walk the time forward daily.
      harnessed.clock.at = new Date(Date.parse(harnessed.record()?.runAt ?? "") + 37 * 60_000)
      await harnessed.runtime.tick()
      landed.push(new Date(harnessed.record()?.runAt ?? 0).getHours())
    }

    expect(landed).toEqual([9, 9, 9, 9])
    expect(new Date(harnessed.record()?.runAt ?? 0).getMinutes()).toBe(0)
    expect(harnessed.record()?.missedRuns).toBeUndefined()
  })
})

describe("running across repositories", () => {
  const multiRepo = scheduledRecord({
    directory: "/repos/alpha",
    targets: [{ directory: "/repos/alpha" }, { directory: "/repos/beta" }, { directory: "/repos/gamma" }],
    recurrence: daily,
  })

  test("records one result per repository and one failure does not fail the rest", async () => {
    const harnessed = harness({
      at: new Date(2026, 7, 19, 9, 0, 0, 0),
      records: [multiRepo],
      failing: ["/repos/beta"],
    })

    await harnessed.runtime.tick()

    const record = harnessed.record()
    expect(record?.results?.map((result) => [result.directory, result.status])).toEqual([
      ["/repos/alpha", "completed"],
      ["/repos/beta", "failed"],
      ["/repos/gamma", "completed"],
    ])
    // The whole task is not condemned by one repository, but the failure is
    // still on the record for the tray and the panel to show.
    expect(record?.status).toBe("scheduled")
    expect(record?.error).toBe("/repos/beta: boom in /repos/beta")
    expect(record?.results?.[1]?.error).toBe("boom in /repos/beta")
  })

  test("the healthy repositories are not blocked by the failing one", async () => {
    const harnessed = harness({
      at: new Date(2026, 7, 19, 9, 0, 0, 0),
      records: [multiRepo],
      failing: ["/repos/alpha"],
    })

    await harnessed.runtime.tick()

    expect(harnessed.created).toHaveLength(3)
    expect(harnessed.calls.filter((call) => call.endsWith("/prompt"))).toHaveLength(3)
    expect(harnessed.record()?.results?.filter((result) => result.status === "completed")).toHaveLength(2)
  })

  test("every repository failing still keeps the schedule, carrying the error", async () => {
    const harnessed = harness({
      at: new Date(2026, 7, 19, 9, 0, 0, 0),
      records: [multiRepo],
      failing: ["/repos/alpha", "/repos/beta", "/repos/gamma"],
    })

    await harnessed.runtime.tick()

    const record = harnessed.record()
    // A daily task that dies on one bad morning is not a schedule, so it goes
    // back to "scheduled" carrying the error rather than ending as "failed".
    expect(record?.status).toBe("scheduled")
    expect(record?.error).toContain("/repos/gamma: boom in /repos/gamma")
    expect(new Date(record?.runAt ?? 0).getDate()).toBe(20)
  })

  test("a one-shot fan-out that fails everywhere ends failed", async () => {
    const harnessed = harness({
      at: new Date(2026, 7, 19, 9, 0, 0, 0),
      records: [scheduledRecord({ ...multiRepo, recurrence: undefined })],
      failing: ["/repos/alpha", "/repos/beta", "/repos/gamma"],
    })

    await harnessed.runtime.tick()

    expect(harnessed.record()?.status).toBe("failed")
  })

  test("shows up under every repository it targets", () => {
    const harnessed = harness({ at: new Date(2026, 7, 19, 8, 0, 0, 0), records: [multiRepo] })

    expect(harnessed.runtime.list({ directory: "/repos/gamma" })).toHaveLength(1)
    expect(harnessed.runtime.list({ directory: "/repos/delta" })).toHaveLength(0)
  })
})

describe("targeting an existing session", () => {
  test("continues the thread instead of opening a new session", async () => {
    const harnessed = harness({
      at: new Date(2026, 7, 19, 9, 0, 0, 0),
      records: [
        scheduledRecord({
          recurrence: daily,
          targets: [{ directory: "/repos/alpha", sessionId: "ses_established" }],
        }),
      ],
    })

    await harnessed.runtime.tick()

    expect(harnessed.created).toHaveLength(0)
    expect(harnessed.calls).not.toContain("POST /api/session")
    expect(harnessed.calls).toContain("POST /api/session/ses_established/prompt")
    expect(harnessed.record()?.results?.[0]?.sessionId).toBe("ses_established")
    expect(harnessed.record()?.sessionId).toBe("ses_established")
  })

  test("mixes an established thread with a fresh session in another repository", async () => {
    const harnessed = harness({
      at: new Date(2026, 7, 19, 9, 0, 0, 0),
      records: [
        scheduledRecord({
          targets: [{ directory: "/repos/alpha", sessionId: "ses_established" }, { directory: "/repos/beta" }],
        }),
      ],
    })

    await harnessed.runtime.tick()

    expect(harnessed.created).toEqual(["ses_new_1"])
    expect(harnessed.record()?.results?.map((result) => result.sessionId)).toEqual(["ses_established", "ses_new_1"])
  })

  test("create() keeps the session pin on a single-target task", () => {
    const harnessed = harness({ at: new Date(2026, 7, 19, 8, 0, 0, 0) })

    const record = harnessed.runtime.create({
      prompt: "Keep the release notes up to date.",
      targets: [{ directory: "/repos/alpha", sessionId: "ses_established" }],
      runAt: new Date(2026, 7, 19, 9, 0, 0, 0).toISOString(),
      recurrence: daily,
    })

    expect(record.directory).toBe("/repos/alpha")
    expect(record.targets).toEqual([{ directory: "/repos/alpha", sessionId: "ses_established" }])
  })

  test("create() rejects a fresh unattended session without a pinned model", () => {
    const harnessed = harness({ at: new Date(2026, 7, 19, 8, 0, 0, 0) })
    expect(() =>
      harnessed.runtime.create({
        prompt: "Check the release.",
        directory: "/repos/alpha",
        runAt: new Date(2026, 7, 19, 9, 0, 0, 0).toISOString(),
      }),
    ).toThrow("Choose a model")
  })
})

describe("engine message shapes", () => {
  test("pins the saved model when opening an unattended session", async () => {
    const harnessed = harness({ at: new Date(2026, 7, 19, 9, 0, 0, 0), records: [scheduledRecord({})] })
    await harnessed.runtime.tick()
    expect(harnessed.createdModels).toEqual([
      { providerID: "provider-current", id: "model-current", variant: "balanced" },
    ])
  })

  test("a v2 flat assistant message settles the run as completed", async () => {
    const harnessed = harness({ at: new Date(2026, 7, 19, 9, 0, 0, 0), records: [scheduledRecord({})] })
    await harnessed.runtime.tick()
    expect(harnessed.record()?.status).toBe("completed")
    expect(harnessed.calls).toContain("GET /api/session/ses_new_1/context")
    expect(harnessed.calls.some((call) => call.includes("/message?limit="))).toBe(false)
  })

  test("a v2 flat assistant error settles the run as failed", async () => {
    const harnessed = harness({
      at: new Date(2026, 7, 19, 9, 0, 0, 0),
      records: [scheduledRecord({})],
      failing: ["/repos/alpha"],
    })
    await harnessed.runtime.tick()
    expect(harnessed.record()?.status).toBe("failed")
    expect(harnessed.record()?.error).toContain("boom in /repos/alpha")
  })

  test("does not mistake an older assistant turn for the scheduled response", async () => {
    const harnessed = harness({
      at: new Date(2026, 7, 19, 9, 0, 0, 0),
      records: [scheduledRecord({ targets: [{ directory: "/repos/alpha", sessionId: "ses_established" }] })],
      staleAssistantPolls: 1,
    })

    await harnessed.runtime.tick()

    expect(harnessed.record()?.status).toBe("completed")
    expect(harnessed.contextPolls()).toBe(2)
  })

  test("waits for a V2 assistant finish reason instead of accepting a projected partial turn", async () => {
    const harnessed = harness({
      at: new Date(2026, 7, 19, 9, 0, 0, 0),
      records: [scheduledRecord({})],
      incompleteAssistantPolls: 1,
    })

    await harnessed.runtime.tick()

    expect(harnessed.record()?.status).toBe("completed")
    expect(harnessed.contextPolls()).toBe(2)
  })

  // The legacy envelope is still accepted so a future route change cannot
  // silently strand the poller the way calling v2 did.
  test("a legacy { info: { role } } assistant message still settles the run", async () => {
    const harnessed = harness({
      at: new Date(2026, 7, 19, 9, 0, 0, 0),
      records: [scheduledRecord({})],
      legacyShape: true,
    })
    await harnessed.runtime.tick()
    expect(harnessed.record()?.status).toBe("completed")
  })
})

describe("unattended spend limits", () => {
  test("checks the scheduled allowance before opening an engine session", async () => {
    const harnessed = harness({
      at: new Date(2026, 7, 19, 9, 0, 0, 0),
      records: [scheduledRecord({})],
      allowance: { allowed: false, state: "blocked", reason: "Daily automation spend cap reached." },
    })

    await harnessed.runtime.tick()

    expect(harnessed.created).toHaveLength(0)
    expect(harnessed.calls).toHaveLength(0)
    expect(harnessed.record()?.status).toBe("failed")
    expect(harnessed.record()?.error).toContain("Daily automation spend cap reached")
    expect(harnessed.spendChecks).toHaveLength(1)
    expect(harnessed.spendChecks[0]?.source).toBe("scheduled")
  })

  test("records the session's cost and tokens against the scheduled run", async () => {
    const harnessed = harness({
      at: new Date(2026, 7, 19, 9, 0, 0, 0),
      records: [scheduledRecord({})],
    })

    await harnessed.runtime.tick()

    expect(harnessed.spendRecords).toHaveLength(1)
    expect(harnessed.spendRecords[0]).toMatchObject({
      projectPath: "/repos/alpha",
      provider: "provider-test",
      model: "model-test",
      source: "scheduled",
      totalCostUsd: 0.25,
      totalTokens: 15,
    })
  })

  test("still records usage when the provider finishes with an error", async () => {
    const harnessed = harness({
      at: new Date(2026, 7, 19, 9, 0, 0, 0),
      records: [scheduledRecord({})],
      failing: ["/repos/alpha"],
    })

    await harnessed.runtime.tick()

    expect(harnessed.record()?.status).toBe("failed")
    expect(harnessed.spendRecords).toHaveLength(1)
    expect(harnessed.spendRecords[0]?.totalCostUsd).toBe(0.25)
  })

  test("sends the remaining headroom as the run's live budget and holds it", async () => {
    const harnessed = harness({
      at: new Date(2026, 7, 19, 9, 0, 0, 0),
      records: [scheduledRecord({})],
      allowance: { allowed: true, state: "ok", remainingUsd: 5 },
    })

    await harnessed.runtime.tick()

    expect(harnessed.prompts[0]).toMatchObject({ resume: true, budget: { usd: 5 } })
    expect([...harnessed.reserved.values()]).toEqual([5])
    expect(harnessed.released).toEqual([...harnessed.reserved.keys()])
  })

  test("sends no budget when nothing is capped", async () => {
    const harnessed = harness({ at: new Date(2026, 7, 19, 9, 0, 0, 0), records: [scheduledRecord({})] })

    await harnessed.runtime.tick()

    expect(harnessed.prompts[0]).toMatchObject({ resume: true, budget: undefined })
    expect(harnessed.reserved.size).toBe(0)
  })

  const guardReading = (sessionId: string, message: string) => ({
    data: {
      sessionID: sessionId,
      state: "stopped",
      reason: "cap",
      message,
      budget: { usd: 5 },
      spentUsd: 5.02,
      steps: 12,
      unpricedSteps: 0,
      costKind: "priced",
    },
  })

  test("a run the spend guard cut short fails with the guard's message and records its measured cost", async () => {
    const message =
      "Spend cap reached: $5.02 spent against a $5.00 cap for this run. Vector stopped after the step that crossed it."
    const harnessed = harness({
      at: new Date(2026, 7, 19, 9, 0, 0, 0),
      records: [scheduledRecord({})],
      allowance: { allowed: true, state: "ok", remainingUsd: 5 },
      spend: (sessionId, prompted) => (prompted ? guardReading(sessionId, message) : {}),
      // The stopped turn's last step asked for another one.
      finish: "tool-calls",
    })

    await harnessed.runtime.tick()

    expect(harnessed.record()?.status).toBe("failed")
    expect(harnessed.record()?.results?.[0]?.error).toBe(message)
    expect(harnessed.spendRecords[0]?.totalCostUsd).toBe(5.02)
  })

  test("a run whose final answer crossed the cap completes and records its measured cost", async () => {
    const message =
      "Spend cap reached: $5.02 spent against a $5.00 cap for this run, on a step that ended its turn. Its answer stands, and Vector starts no further step under this cap."
    const harnessed = harness({
      at: new Date(2026, 7, 19, 9, 0, 0, 0),
      records: [scheduledRecord({})],
      allowance: { allowed: true, state: "ok", remainingUsd: 5 },
      spend: (sessionId, prompted) => (prompted ? guardReading(sessionId, message) : {}),
    })

    await harnessed.runtime.tick()

    expect(harnessed.record()?.status).toBe("completed")
    expect(harnessed.record()?.results?.[0]?.error).toBeUndefined()
    expect(harnessed.spendRecords[0]?.totalCostUsd).toBe(5.02)
  })

  // A recurring automation continues one session, whose spend route answers
  // with the last run it had: an earlier recurrence, or the user's own turn.
  const earlierRun = (sessionId: string) => ({
    data: {
      sessionID: sessionId,
      state: "stopped",
      reason: "cap",
      message: "Spend cap reached on an earlier run.",
      budget: { usd: 5 },
      spentUsd: 3,
      steps: 9,
      unpricedSteps: 0,
      costKind: "priced",
    },
  })

  test("a prompt the engine never admitted fails with its own error and records no earlier run's spend", async () => {
    const harnessed = harness({
      at: new Date(2026, 7, 19, 9, 0, 0, 0),
      records: [scheduledRecord({ targets: [{ directory: "/repos/alpha", sessionId: "ses_established" }] })],
      allowance: { allowed: true, state: "ok", remainingUsd: 5 },
      spend: earlierRun,
      promptFailure: "Vector engine request failed (503)",
    })

    await harnessed.runtime.tick()

    expect(harnessed.record()?.results?.[0]?.status).toBe("failed")
    expect(harnessed.record()?.results?.[0]?.error).toContain("Vector engine request failed (503)")
    expect(harnessed.spendRecords[0]?.totalCostUsd).toBe(0)
    expect(harnessed.released).toEqual([...harnessed.reserved.keys()])
  })

  test("a spend reading that has not moved since before the prompt is not this run's", async () => {
    const harnessed = harness({
      at: new Date(2026, 7, 19, 9, 0, 0, 0),
      records: [scheduledRecord({ targets: [{ directory: "/repos/alpha", sessionId: "ses_established" }] })],
      allowance: { allowed: true, state: "ok", remainingUsd: 5 },
      spend: earlierRun,
    })

    await harnessed.runtime.tick()

    expect(harnessed.record()?.results?.[0]?.status).toBe("completed")
    expect(harnessed.spendRecords[0]?.totalCostUsd).toBe(0.25)
  })

  test("every target of one launch asks for its hold inside the check", async () => {
    const harnessed = harness({
      at: new Date(2026, 7, 19, 9, 0, 0, 0),
      records: [scheduledRecord({ targets: [{ directory: "/repos/alpha" }, { directory: "/repos/beta" }] })],
      allowance: { allowed: true, state: "ok", remainingUsd: 5 },
    })

    await harnessed.runtime.tick()

    expect(harnessed.spendChecks.map((check) => check.reserve)).toEqual([true, true])
    expect(harnessed.prompts).toHaveLength(2)
  })
})

describe("legacy single-directory records", () => {
  const legacy: ScheduledAgentRecord = {
    id: "task-legacy",
    title: "Morning brief",
    prompt: "Summarise what changed overnight.",
    directory: "/repos/legacy",
    recurrence: daily,
    paused: false,
    runAt: new Date(2026, 7, 19, 9, 0, 0, 0).toISOString(),
    status: "scheduled",
    createdAt: "2026-08-01T12:00:00.000Z",
  }

  test("fails a model-less legacy run before opening a session", async () => {
    const harnessed = harness({ at: new Date(2026, 7, 19, 9, 0, 0, 0), records: [legacy] })

    expect(harnessed.runtime.list({ directory: "/repos/legacy" })).toHaveLength(1)
    await harnessed.runtime.tick()

    const record = harnessed.record("task-legacy")
    expect(harnessed.created).toEqual([])
    expect(record?.directory).toBe("/repos/legacy")
    expect(record?.results?.map((result) => [result.directory, result.status])).toEqual([["/repos/legacy", "failed"]])
    expect(record?.status).toBe("scheduled")
    expect(record?.results?.[0]?.error).toContain("saved without a model")
    expect(new Date(record?.runAt ?? 0).getDate()).toBe(20)
  })

  test("create() still writes the old shape for a plain one-directory task", () => {
    const harnessed = harness({ at: new Date(2026, 7, 19, 8, 0, 0, 0) })

    const record = harnessed.runtime.create({
      prompt: "Check the dependencies.",
      model: { providerID: "provider-current", id: "model-current" },
      directory: "/repos/legacy",
      runAt: new Date(2026, 7, 19, 9, 0, 0, 0).toISOString(),
    })

    expect(record.directory).toBe("/repos/legacy")
    expect(record.targets).toBeUndefined()
    expect(record.model).toEqual({ providerID: "provider-current", id: "model-current" })
  })

  test("a record left running by a crash is failed, and a recurring one is re-armed", async () => {
    const harnessed = harness({
      at: new Date(2026, 7, 19, 12, 0, 0, 0),
      records: [{ ...legacy, status: "running", startedAt: legacy.runAt }],
    })

    const record = harnessed.runtime.list().at(0)
    expect(record?.error).toContain("Interrupted by app restart")
    expect(record?.status).toBe("scheduled")
    expect(new Date(record?.runAt ?? 0).getDate()).toBe(20)
  })
})

describe("pause, resume and cancel", () => {
  test("a paused task does not run, and resuming re-arms it in the future", async () => {
    const harnessed = harness({
      at: new Date(2026, 7, 19, 10, 0, 0, 0),
      records: [scheduledRecord({ recurrence: daily })],
    })

    expect(harnessed.runtime.setPaused("task-1", true).status).toBe("canceled")
    await harnessed.runtime.tick()
    expect(harnessed.calls).toHaveLength(0)
    expect(harnessed.runtime.workState().armedTasks).toBe(0)

    const resumed = harnessed.runtime.setPaused("task-1", false)
    expect(resumed.status).toBe("scheduled")
    // 09:00 today is already gone, so resuming must not park it in the past.
    expect(Date.parse(resumed.runAt)).toBeGreaterThan(harnessed.clock.at.getTime())
    await harnessed.runtime.tick()
    expect(harnessed.calls).toHaveLength(0)
    expect(harnessed.runtime.workState().armedTasks).toBe(1)
  })

  test("pausing and resuming an active recurring run does not skip its next occurrence", async () => {
    let toggle = () => {}
    let toggled = false
    const harnessed = harness({
      at: new Date(2026, 7, 19, 9, 0, 0, 0),
      records: [scheduledRecord({ recurrence: daily })],
      onActivePoll: () => {
        if (toggled) return
        toggled = true
        toggle()
      },
    })
    toggle = () => {
      expect(harnessed.runtime.setPaused("task-1", true).status).toBe("running")
      expect(harnessed.runtime.setPaused("task-1", false).status).toBe("running")
    }

    await harnessed.runtime.tick()

    const next = new Date(harnessed.record()?.runAt ?? 0)
    expect(next.getDate()).toBe(20)
    expect(next.getHours()).toBe(9)
  })

  test("cancelling a scheduled task stops it from ever running", async () => {
    const harnessed = harness({
      at: new Date(2026, 7, 19, 10, 0, 0, 0),
      records: [scheduledRecord({ recurrence: daily })],
    })

    expect((await harnessed.runtime.cancel("task-1"))?.status).toBe("canceled")
    await harnessed.runtime.tick()

    expect(harnessed.calls).toHaveLength(0)
  })

  test("cancelling mid-run aborts every repository's session and does not reschedule", async () => {
    const cancel = { fire: () => {} }
    const harnessed = harness({
      at: new Date(2026, 7, 19, 9, 0, 0, 0),
      records: [
        scheduledRecord({
          recurrence: daily,
          targets: [{ directory: "/repos/alpha" }, { directory: "/repos/beta" }],
        }),
      ],
      onActivePoll: () => cancel.fire(),
    })
    cancel.fire = () => void harnessed.runtime.cancel("task-1")

    await harnessed.runtime.tick()

    expect([...new Set(harnessed.aborted)].sort()).toEqual(["ses_new_1", "ses_new_2"])
    expect(harnessed.calls.some((call) => call.endsWith("/interrupt"))).toBe(true)
    expect(harnessed.calls.some((call) => call.endsWith("/abort"))).toBe(false)
    const record = harnessed.record()
    expect(record?.status).toBe("canceled")
    // Still the original slot: a cancelled run must not roll the task forward.
    expect(new Date(record?.runAt ?? 0).getDate()).toBe(19)
  })

  test("removing a task drops it from the store", () => {
    const harnessed = harness({ at: new Date(2026, 7, 19, 8, 0, 0, 0), records: [scheduledRecord({})] })

    expect(harnessed.runtime.remove("task-1")).toHaveLength(0)
    expect(harnessed.runtime.list()).toHaveLength(0)
  })
})

describe("manual runs and reporting", () => {
  test("running a task by hand does not shift its recurrence off 09:00", async () => {
    const harnessed = harness({
      at: new Date(2026, 7, 19, 14, 30, 0, 0),
      records: [scheduledRecord({ recurrence: daily, runAt: new Date(2026, 7, 20, 9, 0, 0, 0).toISOString() })],
    })

    const pulled = harnessed.runtime.runNext()
    expect(pulled?.scheduledFor).toBe(new Date(2026, 7, 20, 9, 0, 0, 0).toISOString())
    await harnessed.runtime.tick()

    const next = new Date(harnessed.record()?.runAt ?? 0)
    expect(next.getHours()).toBe(9)
    expect(next.getMinutes()).toBe(0)
    // Tomorrow's occurrence is the one that was pulled forward, so the schedule
    // resumes the day after — never at 14:30.
    expect(next.getDate()).toBe(21)
    expect(harnessed.record()?.scheduledFor).toBeUndefined()
  })

  test("announces each finished run once, with the failure attached", async () => {
    const finished: Array<string | undefined> = []
    const harnessed = harness({
      at: new Date(2026, 7, 19, 9, 0, 0, 0),
      records: [scheduledRecord({ targets: [{ directory: "/repos/alpha" }, { directory: "/repos/beta" }] })],
      failing: ["/repos/beta"],
    })
    harnessed.runtime.onRunFinished((record) => finished.push(record.error))

    await harnessed.runtime.tick()

    expect(finished).toEqual(["/repos/beta: boom in /repos/beta"])
  })

  test("a notification listener failure cannot fail or advance the run again", async () => {
    const harnessed = harness({
      at: new Date(2026, 7, 19, 9, 0, 0, 0),
      records: [scheduledRecord({ recurrence: daily })],
    })
    harnessed.runtime.onRunFinished(() => {
      throw new Error("desktop notifications are unavailable")
    })

    await harnessed.runtime.tick()

    const record = harnessed.record()
    expect(record?.error).toBeUndefined()
    expect(new Date(record?.runAt ?? 0).getDate()).toBe(20)
  })

  test("work state counts armed tasks and the soonest run", () => {
    const soon = new Date(2026, 7, 19, 9, 0, 0, 0)
    const harnessed = harness({
      at: new Date(2026, 7, 19, 8, 0, 0, 0),
      records: [
        scheduledRecord({ id: "task-1", runAt: new Date(2026, 7, 19, 11, 0, 0, 0).toISOString() }),
        scheduledRecord({ id: "task-2", runAt: soon.toISOString() }),
      ],
    })

    expect(harnessed.runtime.workState().armedTasks).toBe(2)
    expect(harnessed.runtime.workState().nextRunAt).toBe(soon.getTime())
    expect(harnessed.runtime.workState().inFlightRuns).toBe(0)
  })
})

test("a saved Codium schedule cannot bypass dollars when its existing session now uses an own key", async () => {
  const harnessed = harness({
    at: new Date(2026, 7, 19, 10, 0),
    records: [
      scheduledRecord({
        model: { providerID: "vector-plan", id: "codium-model" },
        targets: [{ directory: "/repos/alpha", sessionId: "ses_established" }],
      }),
    ],
    sessionModel: { providerID: "provider-own", id: "own-model" },
    allowance: { allowed: false, state: "blocked", reason: "Own-key dollars exhausted" },
  })
  await harnessed.runtime.tick()
  expect(harnessed.spendChecks[0]?.billing).toBeUndefined()
  expect(harnessed.prompts).toEqual([])
  expect(harnessed.record()?.results?.[0]?.error).toContain("Own-key dollars exhausted")
})

test("a continued Codium session uses its actual model despite an older own-key schedule", async () => {
  const harnessed = harness({
    at: new Date(2026, 7, 19, 10, 0),
    records: [scheduledRecord({ targets: [{ directory: "/repos/alpha", sessionId: "ses_established" }] })],
    sessionModel: { providerID: "vector-plan", id: "codium-model" },
    allowance: { allowed: false, state: "blocked", reason: "Own-key dollars exhausted" },
  })
  await harnessed.runtime.tick()
  expect(harnessed.spendChecks[0]?.billing).toBe("codium")
  expect(harnessed.prompts).toHaveLength(1)
  expect(harnessed.reserved.size).toBe(0)
})

for (const mixed of [false, true]) {
  test(`${mixed ? "mixed" : "Codium-only"} scheduled usage passes separated own totals and Codium to the ledger`, async () => {
    const harnessed = harness({
      at: new Date(2026, 7, 19, 10),
      records: [scheduledRecord({ model: { providerID: "vector-plan", id: "coding" } })],
      sessionModel: { providerID: "vector-plan", id: "coding" },
      sessionUsage: (completed) => ({
        cost: completed && mixed ? 0.12 : 0,
        tokens: { input: completed && mixed ? 80 : 0 },
        codiumSteps: completed ? 3 : 0,
      }),
    })
    await harnessed.runtime.tick()
    expect(harnessed.spendChecks[0]?.billing).toBe("codium")
    expect(harnessed.spendRecords[0]).toMatchObject({
      totalCostUsd: mixed ? 0.12 : 0,
      totalTokens: mixed ? 80 : 0,
      billing: "codium",
    })
    expect(harnessed.reserved.size).toBe(0)
  })
}

test("an own scheduled recurrence does not inherit Codium billing from earlier turns", async () => {
  const harnessed = harness({
    at: new Date(2026, 7, 19, 10),
    records: [scheduledRecord({ targets: [{ directory: "/repos/alpha", sessionId: "ses_established" }] })],
    sessionUsage: () => ({ codiumSteps: 5 }),
  })
  await harnessed.runtime.tick()
  expect(harnessed.spendRecords[0]).toMatchObject({ totalCostUsd: 0.25, totalTokens: 15 })
  expect(harnessed.spendRecords[0]?.billing).toBeUndefined()
})

for (const proof of [undefined, false]) {
  test(`legacy scheduled totals with ${proof === undefined ? "missing" : "unknown"} provenance keep own dollars but hide tokens`, async () => {
    const harnessed = harness({
      at: new Date(2026, 7, 19, 10),
      records: [scheduledRecord({ targets: [{ directory: "/repos/alpha", sessionId: "ses_established" }] })],
      sessionUsage: (completed) => ({
        cost: completed ? 0.12 : 0,
        tokens: { input: completed ? 9_080 : 9_000 },
        tokensOwnOnly: proof,
        // Existing modern counts plus a new Codium turn still cannot prove the old aggregate is separated.
        codiumSteps: completed ? 8 : 5,
      }),
    })
    await harnessed.runtime.tick()
    expect(harnessed.record()?.status).toBe("completed")
    expect(harnessed.spendRecords).toHaveLength(1)
    expect(harnessed.spendRecords[0]).toMatchObject({
      totalCostUsd: 0.12,
      billing: "codium",
      provider: "provider-test",
    })
    expect(harnessed.spendRecords[0]?.totalTokens).toBeUndefined()
  })
}
