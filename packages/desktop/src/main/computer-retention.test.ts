import { describe, expect, test } from "bun:test"
import { Computer } from "@vectordevai/schema/computer"
import { Hands } from "@vectordevai/schema/hands"
import type { ComputerScreenshotHistory } from "@vectordevai/app/computer/screenshot-history"
import { defaultPolicy } from "./computer-policy"
import {
  computerPrune,
  createComputerRetention,
  DAY_MS,
  HOUR_MS,
  PRUNE_PATH,
  retentionCutoff,
  STARTUP_MS,
  type ComputerRetentionTimers,
} from "./computer-retention"
import { defaultPrefs } from "./computer-settings"

type Removal = ComputerScreenshotHistory.Removal
const NOW = 1_800_000_000_000

/** Settings exactly as given: the retention module clamps by policy itself, whatever resolve() already did. */
function settings(retention: Computer.Retention, maxRetentionDays?: number): Computer.ResolvedComputerSettings {
  return {
    prefs: { ...defaultPrefs("darwin"), enabled: true, consentedAt: 1, retention },
    policy: { ...defaultPolicy(), ...(maxRetentionDays === undefined ? {} : { managed: true, maxRetentionDays }) },
    always: [],
    builtins: [],
    locked: [],
  }
}

function timers() {
  const pending: { id: number; at: number; every?: number; callback: () => void }[] = []
  let clock = NOW
  let next = 1
  const api: ComputerRetentionTimers = {
    setTimeout: (callback, ms) => {
      const id = next++
      pending.push({ id, at: clock + ms, callback })
      return id as never
    },
    clearTimeout: (timer) => void pending.splice(pending.findIndex((item) => item.id === (timer as never)) >>> 0, 1),
    setInterval: (callback, ms) => {
      const id = next++
      pending.push({ id, at: clock + ms, every: ms, callback })
      return id as never
    },
    clearInterval: (timer) => void pending.splice(pending.findIndex((item) => item.id === (timer as never)) >>> 0, 1),
  }
  return {
    api,
    now: () => clock,
    pending: () => pending.length,
    /** Moves the clock forward, firing every timer due on the way, in order. */
    async advance(ms: number) {
      const end = clock + ms
      for (;;) {
        const due = pending.filter((item) => item.at <= end).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        clock = due.at
        if (due.every) due.at += due.every
        else pending.splice(pending.indexOf(due), 1)
        due.callback()
        await settle()
      }
      clock = end
      await settle()
    },
  }
}

async function settle() {
  for (let index = 0; index < 10; index++) await Promise.resolve()
}

function fixture(current: () => Computer.ResolvedComputerSettings, answer: (removal: Removal) => number = () => 0) {
  const clock = timers()
  const calls: Removal[] = []
  const removed: Removal[] = []
  const warnings: unknown[][] = []
  const children = new Map<number, string>()
  const retention = createComputerRetention({
    settings: { get: current },
    holderSession: (lease) => children.get(lease),
    removed: (removal) => removed.push(removal),
    warn: (...fields) => warnings.push(fields),
    now: clock.now,
    timers: clock.api,
  })
  const prune = async (removal: Removal) => {
    calls.push(removal)
    return answer(removal)
  }
  return { clock, calls, removed, warnings, children, retention, prune }
}

function state(holder?: { sessionID: string; startedAt: number }, lease = 1): Computer.ComputerState {
  return {
    phase: holder ? "working" : "done",
    backend: "local-macos",
    mode: "foreground",
    apps: [],
    queue: [],
    escStops: false,
    stopChord: Hands.STOP_CHORD.darwin,
    lease,
    reduceMotion: false,
    ...(holder ? { holder: { ...holder, directory: "/virtual/repo", title: "Task", actions: 3 } } : {}),
  }
}

describe("screenshot retention (D23, INV-C8)", () => {
  test("7 days prunes before now minus 7 days", async () => {
    const f = fixture(() => settings("7d"))
    f.retention.attach(f.prune)
    expect(f.calls).toEqual([])
    await f.clock.advance(STARTUP_MS)
    expect(f.calls).toEqual([{ before: NOW + STARTUP_MS - 7 * DAY_MS }])
    // And hourly after that, each time against the clock of that sweep.
    await f.clock.advance(HOUR_MS - STARTUP_MS)
    expect(f.calls.at(-1)).toEqual({ before: NOW + HOUR_MS - 7 * DAY_MS })
    await f.clock.advance(HOUR_MS)
    expect(f.calls).toHaveLength(3)
    expect(f.calls.at(-1)).toEqual({ before: NOW + 2 * HOUR_MS - 7 * DAY_MS })
    expect(retentionCutoff("1d", NOW)).toEqual({ before: NOW - DAY_MS })
    expect(retentionCutoff("30d", NOW)).toEqual({ before: NOW - 30 * DAY_MS })
  })

  test("a company maximum clamps a longer choice", async () => {
    const f = fixture(() => settings("30d", 10))
    f.retention.attach(f.prune)
    await f.retention.sweep()
    expect(f.calls).toEqual([{ before: NOW - 7 * DAY_MS }])
    // "Until I delete the conversation" is longer than any maximum; a maximum of 0 keeps nothing past the task.
    const session = fixture(() => settings("session", 365))
    session.retention.attach(session.prune)
    await session.retention.sweep()
    expect(session.calls).toEqual([{ before: NOW - 30 * DAY_MS }])
    const none = fixture(() => settings("7d", 0))
    none.retention.attach(none.prune)
    await none.retention.sweep()
    expect(none.calls).toEqual([{ before: NOW }])
  })

  test("task prunes at task end", async () => {
    let retention: Computer.Retention = "task"
    const f = fixture(
      () => settings(retention),
      () => 2,
    )
    f.retention.attach(f.prune)
    f.children.set(4, "ses_child")
    f.retention.observe(state({ sessionID: "ses_root", startedAt: NOW - 60_000 }, 4))
    f.retention.observe(state({ sessionID: "ses_root", startedAt: NOW - 60_000 }, 4))
    // While the task runs, nothing of it goes; an hourly sweep keeps everything from its start on.
    expect(f.calls).toEqual([])
    await f.retention.sweep()
    expect(f.calls).toEqual([{ before: NOW - 60_000 }])
    f.retention.observe(state(undefined, 4))
    await settle()
    // Its own conversation and the child session that held the lease, only up to the end: a follow-up task can start
    // in the same conversation at once.
    expect(f.calls.slice(1)).toEqual([
      { sessionID: "ses_root", before: NOW },
      { sessionID: "ses_child", before: NOW },
    ])
    expect(f.removed).toEqual(f.calls)
    // A different holder taking over also ends the previous task.
    f.retention.observe(state({ sessionID: "ses_a", startedAt: NOW }, 5))
    f.retention.observe(state({ sessionID: "ses_b", startedAt: NOW + 1 }, 6))
    await settle()
    expect(f.calls.at(-1)).toEqual({ sessionID: "ses_a", before: NOW })
    // Other retention choices leave a finished task's screenshots to the schedule.
    retention = "7d"
    const before = f.calls.length
    f.retention.observe(state(undefined, 6))
    await settle()
    expect(f.calls).toHaveLength(before)
  })

  test("with task retention and no task running, a sweep removes every finished task's screenshots", async () => {
    const f = fixture(() => settings("task"))
    f.retention.attach(f.prune)
    await f.retention.sweep()
    expect(f.calls).toEqual([{ before: NOW }])
  })

  test("until the conversation is deleted schedules nothing", async () => {
    const f = fixture(() => settings("session"))
    f.retention.attach(f.prune)
    await f.clock.advance(3 * HOUR_MS)
    f.retention.observe(state({ sessionID: "ses_root", startedAt: NOW }))
    f.retention.observe(state())
    await settle()
    expect(f.calls).toEqual([])
  })

  test("delete-all sends all: true and returns the count", async () => {
    const f = fixture(
      () => settings("7d"),
      (removal) => ("all" in removal ? 4 : 0),
    )
    f.retention.attach(f.prune)
    const first = f.retention.deleteAll()
    // A second press while the first runs joins it, so its count is never replaced by zero.
    expect(f.retention.deleteAll()).toBe(first)
    expect(await first).toEqual({ removed: 4 })
    expect(f.calls).toEqual([{ all: true }])
    // Delete all tells the windows even when nothing was left, so every copy of the history is checked.
    const empty = fixture(() => settings("7d"))
    empty.retention.attach(empty.prune)
    expect(await empty.retention.deleteAll()).toEqual({ removed: 0 })
    expect(empty.removed).toEqual([{ all: true }])
  })

  test("the windows hear only about deletions that removed something", async () => {
    const f = fixture(
      () => settings("7d"),
      () => 0,
    )
    f.retention.attach(f.prune)
    await f.retention.sweep()
    expect(f.calls).toHaveLength(1)
    expect(f.removed).toEqual([])
  })

  test("deletions run one at a time, in order", async () => {
    const order: string[] = []
    const gates: (() => void)[] = []
    const f = fixture(() => settings("7d"))
    f.retention.attach(async (removal) => {
      order.push(`start ${"all" in removal ? "all" : "sweep"}`)
      await new Promise<void>((resolve) => gates.push(resolve))
      order.push(`end ${"all" in removal ? "all" : "sweep"}`)
      return 1
    })
    const sweep = f.retention.sweep()
    const all = f.retention.deleteAll()
    await settle()
    expect(order).toEqual(["start sweep"])
    gates.shift()!()
    await sweep
    await settle()
    expect(order).toEqual(["start sweep", "end sweep", "start all"])
    gates.shift()!()
    expect(await all).toEqual({ removed: 1 })
  })

  test("failures are reported without detail, and the schedule keeps running", async () => {
    let fail = true
    const f = fixture(() => settings("7d"))
    f.retention.attach(async (removal) => {
      f.calls.push(removal)
      if (fail) throw new TypeError("private storage path /Users/someone/db")
      return 1
    })
    await f.retention.sweep()
    expect(f.warnings).toEqual([["Computer screenshot retention failed", "TypeError"]])
    await expect(f.retention.deleteAll()).rejects.toThrow(`${Hands.NAME} couldn't delete the screenshots. Try again.`)
    expect(f.removed).toEqual([])
    fail = false
    await f.retention.sweep()
    expect(f.removed).toHaveLength(1)
  })

  test("before the engine connects, Delete all fails and nothing is scheduled; stop clears the schedule", async () => {
    const f = fixture(() => settings("7d"))
    await expect(f.retention.deleteAll()).rejects.toThrow()
    await f.retention.sweep()
    expect(f.calls).toEqual([])
    expect(f.clock.pending()).toBe(0)
    f.retention.attach(f.prune)
    expect(f.clock.pending()).toBe(2)
    f.retention.stop()
    expect(f.clock.pending()).toBe(0)
    await f.clock.advance(2 * HOUR_MS)
    expect(f.calls).toEqual([])
  })

  test("a shorter retention applies when it is saved, not at the next hour", async () => {
    let current = settings("30d")
    const f = fixture(() => current)
    f.retention.attach(f.prune)
    const previous = current
    current = settings("1d")
    f.retention.changed(previous)
    await settle()
    expect(f.calls).toEqual([{ before: NOW - DAY_MS }])
    // An unrelated change sweeps nothing.
    f.retention.changed(current)
    await settle()
    expect(f.calls).toHaveLength(1)
  })
})

describe("the engine's prune route", () => {
  test("posts the selection with the owner's credentials and reads the count", async () => {
    const requests: { url: string; init: RequestInit }[] = []
    const prune = computerPrune({ url: "http://127.0.0.1:4096", password: "fixture-password" }, async (url, init) => {
      requests.push({ url: String(url), init })
      return Response.json({ removed: 3 })
    })
    expect(await prune({ all: true })).toBe(3)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe(`http://127.0.0.1:4096${PRUNE_PATH}`)
    expect(requests[0]!.init.method).toBe("POST")
    expect(JSON.parse(String(requests[0]!.init.body))).toEqual({ all: true })
    const headers = requests[0]!.init.headers as Record<string, string>
    expect(headers.authorization).toBe(`Basic ${Buffer.from("vector:fixture-password").toString("base64")}`)
    expect(headers["content-type"]).toBe("application/json")
    // The deletion covers the whole database, so no project directory is named.
    expect(new URL(requests[0]!.url).search).toBe("")
  })

  test("a refused request or an answer that is not a count is an error", async () => {
    const refused = computerPrune(
      { url: "http://127.0.0.1:4096", password: "p" },
      async () => new Response("", { status: 403 }),
    )
    await expect(refused({ before: 1 })).rejects.toThrow("403")
    for (const body of [{ removed: -1 }, { removed: 1.5 }, {}, "text"]) {
      const odd = computerPrune({ url: "http://127.0.0.1:4096", password: "p" }, async () => Response.json(body))
      await expect(odd({ sessionID: "ses_a" })).rejects.toThrow()
    }
  })
})
