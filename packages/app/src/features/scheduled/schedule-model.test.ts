import { describe, expect, test } from "bun:test"
import {
  automationTargetResults,
  automationTargets,
  buildAutomationInput,
  buildAutomationTargets,
  buildRecurrence,
  describeAutomationNextRun,
  describeAutomationTargets,
  describeMissedRuns,
  describeNextRun,
  describeRecurrence,
  filterTasks,
  formatTime,
  nextRun,
  parseTime,
  sortAutomations,
  sortByNextRun,
  supportsGithubSchedule,
  type AutomationDraft,
  type AutomationRecord,
  type ScheduledTask,
} from "./schedule-model"

// A Friday, 10:00 local time.
const friday10 = new Date(2026, 7, 14, 10, 0, 0, 0)

test("GitHub schedules require a recurring task in one repository with a fresh run", () => {
  for (const kind of ["daily", "weekdays", "weekly"] as const) expect(supportsGithubSchedule(kind, [{}])).toBe(true)
  expect(supportsGithubSchedule("once", [{}])).toBe(false)
  expect(supportsGithubSchedule("daily", [])).toBe(false)
  expect(supportsGithubSchedule("daily", [{}, {}])).toBe(false)
  expect(supportsGithubSchedule("daily", [{ sessionId: "local-session" }])).toBe(false)
})

function task(partial: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "t1",
    title: "Task",
    prompt: "do it",
    directory: "/repo",
    recurrence: { kind: "daily", time: "08:00" },
    paused: false,
    createdAt: friday10.toISOString(),
    ...partial,
  }
}

describe("parseTime", () => {
  test("parses valid times", () => {
    expect(parseTime("08:00")).toEqual({ hours: 8, minutes: 0 })
    expect(parseTime("23:59")).toEqual({ hours: 23, minutes: 59 })
  })

  test("rejects impossible or malformed times rather than defaulting to midnight", () => {
    for (const bad of ["24:00", "08:60", "8", "", "abc", "08:0"]) expect(parseTime(bad)).toBeUndefined()
  })
})

describe("formatTime", () => {
  test("renders 12-hour time with midnight and noon correct", () => {
    expect(formatTime("08:00")).toBe("8:00 AM")
    expect(formatTime("16:30")).toBe("4:30 PM")
    expect(formatTime("00:15")).toBe("12:15 AM")
    expect(formatTime("12:00")).toBe("12:00 PM")
  })
})

describe("describeRecurrence", () => {
  test("phrases each kind the way the panel reads", () => {
    expect(describeRecurrence({ kind: "daily", time: "08:00" })).toBe("Every day at 8:00 AM")
    expect(describeRecurrence({ kind: "weekdays", time: "08:00" })).toBe("Weekdays at 8:00 AM")
    expect(describeRecurrence({ kind: "weekly", weekday: 5, time: "08:00" })).toBe("Fridays at 8:00 AM")
  })

  test("names an invalid one-shot instead of rendering a bad date", () => {
    expect(describeRecurrence({ kind: "once", at: "not a date" })).toBe("Invalid schedule")
  })
})

describe("nextRun", () => {
  test("daily rolls to tomorrow once today's time has passed", () => {
    const next = nextRun({ kind: "daily", time: "08:00" }, friday10)!
    expect(next.getDate()).toBe(15)
    expect(next.getHours()).toBe(8)
  })

  test("daily stays today when the time is still ahead", () => {
    const next = nextRun({ kind: "daily", time: "18:00" }, friday10)!
    expect(next.getDate()).toBe(14)
  })

  test("weekdays skips the weekend", () => {
    const next = nextRun({ kind: "weekdays", time: "08:00" }, friday10)!
    expect(next.getDay()).toBe(1)
  })

  test("weekly lands on the right weekday a week out", () => {
    const next = nextRun({ kind: "weekly", weekday: 5, time: "08:00" }, friday10)!
    expect(next.getDay()).toBe(5)
    expect(next.getTime()).toBeGreaterThan(friday10.getTime())
  })

  test("is always strictly in the future so a task cannot immediately re-fire", () => {
    const exactly = new Date(2026, 7, 14, 8, 0, 0, 0)
    expect(nextRun({ kind: "daily", time: "08:00" }, exactly)!.getTime()).toBeGreaterThan(exactly.getTime())
  })

  test("a past one-shot has no next run", () => {
    expect(nextRun({ kind: "once", at: new Date(2020, 0, 1).toISOString() }, friday10)).toBeUndefined()
  })

  test("a future one-shot returns its moment", () => {
    const at = new Date(2026, 7, 20, 9, 0).toISOString()
    expect(nextRun({ kind: "once", at }, friday10)!.toISOString()).toBe(at)
  })

  test("an unparseable time yields no run rather than midnight", () => {
    expect(nextRun({ kind: "daily", time: "nope" }, friday10)).toBeUndefined()
  })
})

describe("describeNextRun", () => {
  test("scales the phrasing by distance", () => {
    expect(describeNextRun(new Date(friday10.getTime() + 30 * 60_000), friday10)).toBe("Next run in 30 minutes")
    expect(describeNextRun(new Date(friday10.getTime() + 3 * 3_600_000), friday10)).toBe("Next run in 3 hours")
    expect(describeNextRun(new Date(friday10.getTime() + 6 * 86_400_000), friday10)).toBe("Next run in 6 days")
  })

  test("singularises", () => {
    expect(describeNextRun(new Date(friday10.getTime() + 86_400_000), friday10)).toBe("Next run in 1 day")
  })

  test("handles no run and an overdue run", () => {
    expect(describeNextRun(undefined, friday10)).toBe("No further runs")
    expect(describeNextRun(new Date(friday10.getTime() - 1000), friday10)).toBe("Due now")
  })
})

describe("filterTasks", () => {
  const tasks = [task({ id: "a", title: "Morning brief" }), task({ id: "b", title: "Nightly", paused: true })]

  test("filters by state", () => {
    expect(filterTasks(tasks, "active", "").map((t) => t.id)).toEqual(["a"])
    expect(filterTasks(tasks, "paused", "").map((t) => t.id)).toEqual(["b"])
    expect(filterTasks(tasks, "all", "")).toHaveLength(2)
  })

  test("searches title and prompt, case-insensitively", () => {
    expect(filterTasks(tasks, "all", "MORNING").map((t) => t.id)).toEqual(["a"])
    expect(filterTasks(tasks, "all", "do it")).toHaveLength(2)
    expect(filterTasks(tasks, "all", "nothing")).toEqual([])
  })
})

describe("sortByNextRun", () => {
  test("paused tasks sink below active ones", () => {
    const sorted = sortByNextRun(
      [task({ id: "paused", paused: true, recurrence: { kind: "daily", time: "18:00" } }), task({ id: "active" })],
      friday10,
    )
    expect(sorted.map((t) => t.id)).toEqual(["active", "paused"])
  })

  test("sooner runs come first", () => {
    const sorted = sortByNextRun(
      [
        task({ id: "later", recurrence: { kind: "weekly", weekday: 5, time: "08:00" } }),
        task({ id: "sooner", recurrence: { kind: "daily", time: "18:00" } }),
      ],
      friday10,
    )
    expect(sorted[0]!.id).toBe("sooner")
  })
})

describe("buildRecurrence", () => {
  test("builds a one-shot from a datetime-local value", () => {
    const built = buildRecurrence({ kind: "once", at: "2026-09-01T08:30", time: "", weekday: 0 })
    expect(built?.kind).toBe("once")
    // Interpreted as local time, so the ISO instant matches the wall clock the
    // user picked rather than being shifted by the timezone offset.
    expect(built?.kind === "once" && new Date(built.at).getHours()).toBe(8)
  })

  test("builds each recurring kind", () => {
    expect(buildRecurrence({ kind: "daily", at: "", time: "07:15", weekday: 0 })).toEqual({
      kind: "daily",
      time: "07:15",
    })
    expect(buildRecurrence({ kind: "weekdays", at: "", time: "07:15", weekday: 0 })).toEqual({
      kind: "weekdays",
      time: "07:15",
    })
    expect(buildRecurrence({ kind: "weekly", at: "", time: "16:00", weekday: 5 })).toEqual({
      kind: "weekly",
      weekday: 5,
      time: "16:00",
    })
  })

  test("returns undefined for input that cannot form a schedule", () => {
    // The form keeps Schedule disabled on undefined, so a task that would never
    // fire cannot be created in the first place.
    expect(buildRecurrence({ kind: "once", at: "", time: "", weekday: 0 })).toBeUndefined()
    expect(buildRecurrence({ kind: "once", at: "not-a-date", time: "", weekday: 0 })).toBeUndefined()
    expect(buildRecurrence({ kind: "daily", at: "", time: "", weekday: 0 })).toBeUndefined()
    expect(buildRecurrence({ kind: "weekly", at: "", time: "09:60", weekday: 1 })).toBeUndefined()
    expect(buildRecurrence({ kind: "weekly", at: "", time: "25:00", weekday: 1 })).toBeUndefined()
  })

  test("accepts a single-digit hour, which parseTime treats as valid", () => {
    expect(buildRecurrence({ kind: "daily", at: "", time: "7:15", weekday: 0 })).toEqual({
      kind: "daily",
      time: "7:15",
    })
  })

  test("a one-shot already in the past yields no next run, so the form blocks it", () => {
    const past = buildRecurrence({ kind: "once", at: "2020-01-01T09:00", time: "", weekday: 0 })
    expect(past).toBeDefined()
    expect(nextRun(past!, new Date())).toBeUndefined()
  })
})

// --- Automations -----------------------------------------------------------

function draft(partial: Partial<AutomationDraft> = {}): AutomationDraft {
  return {
    title: "",
    prompt: "Summarise what changed",
    targets: [{ directory: "/repo-a", enabled: true, sessionId: "" }],
    kind: "daily",
    at: "",
    time: "08:00",
    weekday: 1,
    ...partial,
  }
}

describe("buildAutomationTargets", () => {
  test("keeps only the selected repositories and drops the empty session marker", () => {
    expect(
      buildAutomationTargets([
        { directory: "/repo-a", enabled: true, sessionId: "" },
        { directory: "/repo-b", enabled: false, sessionId: "ses_b" },
        { directory: "/repo-c", enabled: true, sessionId: "ses_c" },
        { directory: "   ", enabled: true, sessionId: "" },
      ]),
    ).toEqual([{ directory: "/repo-a" }, { directory: "/repo-c", sessionId: "ses_c" }])
  })
})

describe("buildAutomationInput", () => {
  test("builds a multi-repo input and mirrors the first target onto directory", () => {
    const built = buildAutomationInput(
      draft({
        title: "  Morning brief  ",
        targets: [
          { directory: "/repo-a", enabled: true, sessionId: "" },
          { directory: "/repo-b/.sandbox", enabled: true, sessionId: "ses_b" },
        ],
      }),
      friday10,
    )
    expect(built.ok).toBe(true)
    expect(built.ok && built.input).toEqual({
      title: "Morning brief",
      prompt: "Summarise what changed",
      recurrence: { kind: "daily", time: "08:00" },
      directory: "/repo-a",
      targets: [{ directory: "/repo-a" }, { directory: "/repo-b/.sandbox", sessionId: "ses_b" }],
      // 08:00 has already passed at 10:00, so the first run is tomorrow.
      runAt: new Date(2026, 7, 15, 8, 0, 0, 0).toISOString(),
    })
  })

  test("names an unnamed automation from the first line of the prompt", () => {
    const built = buildAutomationInput(draft({ prompt: "  Check the deploy\nand report back  " }), friday10)
    expect(built.ok && built.input.title).toBe("Check the deploy")
  })

  test("refuses, with a reason, every way the form can be incomplete", () => {
    expect(buildAutomationInput(draft({ prompt: "   " }), friday10)).toEqual({
      ok: false,
      error: "Write the task this automation should run.",
    })
    expect(buildAutomationInput(draft({ targets: [] }), friday10)).toEqual({
      ok: false,
      error: "Choose at least one repository to run in.",
    })
    expect(
      buildAutomationInput(draft({ targets: [{ directory: "/repo-a", enabled: false, sessionId: "" }] }), friday10),
    ).toEqual({ ok: false, error: "Choose at least one repository to run in." })
    expect(buildAutomationInput(draft({ time: "25:00" }), friday10)).toEqual({
      ok: false,
      error: "Pick a valid time.",
    })
    expect(buildAutomationInput(draft({ kind: "once", at: "" }), friday10)).toEqual({
      ok: false,
      error: "Pick a date and time.",
    })
  })

  test("blocks a one-shot whose moment has already passed instead of creating a dead record", () => {
    expect(buildAutomationInput(draft({ kind: "once", at: "2020-01-01T09:00" }), friday10)).toEqual({
      ok: false,
      error: "That time has already passed. Pick a moment in the future.",
    })
    const future = buildAutomationInput(draft({ kind: "once", at: "2026-08-14T18:00" }), friday10)
    expect(future.ok && future.input.runAt).toBe(new Date(2026, 7, 14, 18, 0, 0, 0).toISOString())
  })
})

function record(partial: Partial<AutomationRecord> = {}): AutomationRecord {
  return {
    id: "a1",
    title: "Automation",
    prompt: "do it",
    recurrence: { kind: "daily", time: "08:00" },
    directory: "/repo-a",
    runAt: new Date(2026, 7, 15, 8, 0, 0, 0).toISOString(),
    status: "scheduled",
    createdAt: friday10.toISOString(),
    ...partial,
  }
}

describe("automationTargets", () => {
  test("reads a record written before multi-repo targeting as its single directory", () => {
    expect(automationTargets(record())).toEqual([{ directory: "/repo-a" }])
    expect(automationTargets(record({ targets: [] }))).toEqual([{ directory: "/repo-a" }])
  })

  test("uses the listed targets when there are any", () => {
    expect(automationTargets(record({ targets: [{ directory: "/repo-b", sessionId: "ses_b" }] }))).toEqual([
      { directory: "/repo-b", sessionId: "ses_b" },
    ])
  })
})

describe("automationTargetResults", () => {
  test("pairs by index, so a new-session target still finds the result that gained a session ID", () => {
    const paired = automationTargetResults(
      record({
        targets: [{ directory: "/repo-a" }, { directory: "/repo-b", sessionId: "ses_b" }],
        results: [
          { directory: "/repo-a", sessionId: "ses_fresh", status: "completed", startedAt: friday10.toISOString() },
          { directory: "/repo-b", sessionId: "ses_b", status: "failed", startedAt: friday10.toISOString() },
        ],
      }),
    )
    expect(paired.map((entry) => [entry.target.directory, entry.result?.status])).toEqual([
      ["/repo-a", "completed"],
      ["/repo-b", "failed"],
    ])
  })

  test("leaves a target that has never run without a result", () => {
    expect(automationTargetResults(record()).map((entry) => entry.result)).toEqual([undefined])
  })
})

describe("describeAutomationTargets", () => {
  const name = (directory: string) => directory.split("/").at(-1) ?? directory

  test("says which session a single target continues", () => {
    expect(describeAutomationTargets([{ directory: "/src/repo-a" }], name)).toBe("repo-a · new session each run")
    expect(describeAutomationTargets([{ directory: "/src/repo-a", sessionId: "ses" }], name)).toBe(
      "repo-a · existing session",
    )
  })

  test("counts repositories once there are several, and admits a mixed selection", () => {
    expect(describeAutomationTargets([{ directory: "/a" }, { directory: "/b" }], name)).toBe(
      "2 repositories · new session each run",
    )
    expect(
      describeAutomationTargets(
        [
          { directory: "/a", sessionId: "x" },
          { directory: "/b", sessionId: "y" },
        ],
        name,
      ),
    ).toBe("2 repositories · existing sessions")
    expect(describeAutomationTargets([{ directory: "/a", sessionId: "x" }, { directory: "/b" }], name)).toBe(
      "2 repositories · 1 existing, 1 new",
    )
  })

  test("does not pretend an empty selection runs somewhere", () => {
    expect(describeAutomationTargets([], name)).toBe("No repositories")
  })
})

describe("describeAutomationNextRun", () => {
  test("trusts the scheduler's own pending slot over recomputing the rule", () => {
    // The rule says 08:00 daily, but the record was pulled forward to 14:00.
    expect(
      describeAutomationNextRun(record({ runAt: new Date(2026, 7, 14, 14, 0, 0, 0).toISOString() }), friday10),
    ).toBe("Next run in 4 hours")
  })

  test("reports paused and running before any arithmetic", () => {
    expect(describeAutomationNextRun(record({ paused: true }), friday10)).toBe("Paused")
    expect(describeAutomationNextRun(record({ status: "running" }), friday10)).toBe("Running now")
  })

  test("falls back to the rule for a settled recurring record, and stops for a one-shot", () => {
    expect(describeAutomationNextRun(record({ status: "completed" }), friday10)).toBe("Next run in 22 hours")
    expect(
      describeAutomationNextRun(
        record({ status: "completed", recurrence: { kind: "once", at: friday10.toISOString() } }),
        friday10,
      ),
    ).toBe("No further runs")
  })

  test("says nothing is coming rather than counting down to an unparseable date", () => {
    expect(describeAutomationNextRun(record({ runAt: "whenever" }), friday10)).toBe("No further runs")
  })
})

describe("describeMissedRuns", () => {
  test("explains a collapsed catch-up instead of implying the schedule kept up", () => {
    expect(describeMissedRuns(1)).toBe(
      "Caught up with a single run; 1 earlier run was missed while Vector was closed and will not be replayed.",
    )
    expect(describeMissedRuns(4)).toBe(
      "Caught up with a single run; 4 earlier runs were missed while Vector was closed and will not be replayed.",
    )
  })

  test("stays silent when nothing was missed", () => {
    expect(describeMissedRuns(0)).toBeUndefined()
    expect(describeMissedRuns(undefined)).toBeUndefined()
  })
})

describe("sortAutomations", () => {
  test("puts imminent runs first, settled ones after, and paused ones last", () => {
    const order = sortAutomations([
      record({ id: "paused-soon", paused: true, runAt: new Date(2026, 7, 14, 11, 0).toISOString() }),
      record({ id: "done", status: "completed", runAt: new Date(2026, 7, 14, 10, 30).toISOString() }),
      record({ id: "later", runAt: new Date(2026, 7, 14, 20, 0).toISOString() }),
      record({ id: "soon", runAt: new Date(2026, 7, 14, 12, 0).toISOString() }),
    ]).map((item) => item.id)
    expect(order).toEqual(["soon", "later", "done", "paused-soon"])
  })
})
