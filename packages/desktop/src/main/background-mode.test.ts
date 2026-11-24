import { describe, expect, test } from "bun:test"
import {
  clearQuitRequest,
  decideBackgroundMode,
  isQuitRequested,
  requestQuit,
  type BackgroundModePreference,
} from "./background-mode"

const NOW = Date.parse("2026-08-19T12:00:00.000Z")
const PLATFORMS: NodeJS.Platform[] = ["darwin", "win32", "linux"]

const decide = (input: {
  preference: BackgroundModePreference
  armedTasks: number
  inFlightRuns: number
  everywhereWaiting?: boolean
  platform: NodeJS.Platform
  quitRequested?: boolean
  nextRunAt?: number
}) => decideBackgroundMode({ quitRequested: false, now: NOW, ...input })

test("waiting for Everywhere jobs keeps auto mode resident until the owner quits or disables background mode", () => {
  const state = { armedTasks: 0, inFlightRuns: 0, everywhereWaiting: true, platform: "linux" } as const
  expect(decide({ ...state, preference: "auto" })).toEqual({ keepAlive: true, reason: "Waiting for Vector everywhere jobs" })
  expect(decide({ ...state, preference: "never" }).keepAlive).toBe(false)
  expect(decide({ ...state, preference: "auto", quitRequested: true }).keepAlive).toBe(false)
})

// Every combination of preference, armed tasks, in-flight runs and platform,
// written out rather than derived, so the table is a spec and not a second copy
// of the implementation.
const TABLE: Array<[BackgroundModePreference, number, number, NodeJS.Platform, boolean]> = [
  ["auto", 0, 0, "darwin", true],
  ["auto", 0, 0, "win32", false],
  ["auto", 0, 0, "linux", false],
  ["auto", 0, 1, "darwin", true],
  ["auto", 0, 1, "win32", true],
  ["auto", 0, 1, "linux", true],
  ["auto", 2, 0, "darwin", true],
  ["auto", 2, 0, "win32", true],
  ["auto", 2, 0, "linux", true],
  ["auto", 2, 1, "darwin", true],
  ["auto", 2, 1, "win32", true],
  ["auto", 2, 1, "linux", true],
  ["always", 0, 0, "darwin", true],
  ["always", 0, 0, "win32", true],
  ["always", 0, 0, "linux", true],
  ["always", 0, 1, "darwin", true],
  ["always", 0, 1, "win32", true],
  ["always", 0, 1, "linux", true],
  ["always", 2, 0, "darwin", true],
  ["always", 2, 0, "win32", true],
  ["always", 2, 0, "linux", true],
  ["always", 2, 1, "darwin", true],
  ["always", 2, 1, "win32", true],
  ["always", 2, 1, "linux", true],
  ["never", 0, 0, "darwin", false],
  ["never", 0, 0, "win32", false],
  ["never", 0, 0, "linux", false],
  ["never", 0, 1, "darwin", true],
  ["never", 0, 1, "win32", true],
  ["never", 0, 1, "linux", true],
  ["never", 2, 0, "darwin", false],
  ["never", 2, 0, "win32", false],
  ["never", 2, 0, "linux", false],
  ["never", 2, 1, "darwin", true],
  ["never", 2, 1, "win32", true],
  ["never", 2, 1, "linux", true],
]

describe("decideBackgroundMode — the full table", () => {
  for (const [preference, armedTasks, inFlightRuns, platform, keepAlive] of TABLE) {
    test(`${preference} · ${armedTasks} armed · ${inFlightRuns} in flight · ${platform} → ${keepAlive ? "stays" : "quits"}`, () => {
      const decision = decide({ preference, armedTasks, inFlightRuns, platform })
      expect(decision.keepAlive).toBe(keepAlive)
      expect(decision.reason.length).toBeGreaterThan(0)
    })
  }

  test("an explicit quit intent overrides every other combination", () => {
    for (const [preference, armedTasks, inFlightRuns, platform] of TABLE) {
      const decision = decide({ preference, armedTasks, inFlightRuns, platform, quitRequested: true })
      expect(decision.keepAlive).toBe(false)
      expect(decision.reason).toBe("Quitting Vector")
    }
  })
})

describe("decideBackgroundMode — precedence", () => {
  test("a run in flight outranks the never preference, because quitting would destroy it", () => {
    for (const platform of PLATFORMS) {
      expect(decide({ preference: "never", armedTasks: 0, inFlightRuns: 1, platform }).keepAlive).toBe(true)
    }
  })

  test("never still parks an app whose only work is scheduled for later", () => {
    for (const platform of PLATFORMS) {
      const decision = decide({ preference: "never", armedTasks: 3, inFlightRuns: 0, platform })
      expect(decision.keepAlive).toBe(false)
      expect(decision.reason).toBe("Background mode is off")
    }
  })

  test("macOS keeps its conventional windowless idle, other platforms do not", () => {
    expect(decide({ preference: "auto", armedTasks: 0, inFlightRuns: 0, platform: "darwin" }).reason).toBe("Idle")
    expect(decide({ preference: "auto", armedTasks: 0, inFlightRuns: 0, platform: "win32" }).reason).toBe(
      "Nothing scheduled",
    )
  })

  test("always stays resident on every platform when there is nothing to do", () => {
    for (const platform of PLATFORMS) {
      const decision = decide({ preference: "always", armedTasks: 0, inFlightRuns: 0, platform })
      expect(decision.keepAlive).toBe(true)
      expect(decision.reason).toBe("Idle · staying resident")
    }
  })
})

describe("decideBackgroundMode — the status line", () => {
  test("counts armed tasks and the time to the next one", () => {
    expect(
      decide({
        preference: "auto",
        armedTasks: 2,
        inFlightRuns: 0,
        platform: "darwin",
        nextRunAt: NOW + 14 * 60_000,
      }).reason,
    ).toBe("2 scheduled tasks armed · next in 14m")
  })

  test("stays singular for one task", () => {
    expect(
      decide({ preference: "auto", armedTasks: 1, inFlightRuns: 0, platform: "linux", nextRunAt: NOW + 45_000 }).reason,
    ).toBe("1 scheduled task armed · next in 45s")
  })

  test("spells out hours and days", () => {
    expect(
      decide({
        preference: "auto",
        armedTasks: 1,
        inFlightRuns: 0,
        platform: "linux",
        nextRunAt: NOW + 125 * 60_000,
      }).reason,
    ).toBe("1 scheduled task armed · next in 2h 5m")
    expect(
      decide({ preference: "auto", armedTasks: 1, inFlightRuns: 0, platform: "linux", nextRunAt: NOW + 3 * 3_600_000 })
        .reason,
    ).toBe("1 scheduled task armed · next in 3h")
    expect(
      decide({
        preference: "auto",
        armedTasks: 1,
        inFlightRuns: 0,
        platform: "linux",
        nextRunAt: NOW + 2 * 86_400_000,
      }).reason,
    ).toBe("1 scheduled task armed · next in 2d")
  })

  test("says a task is due rather than counting backwards past its moment", () => {
    expect(
      decide({ preference: "auto", armedTasks: 1, inFlightRuns: 0, platform: "linux", nextRunAt: NOW - 60_000 }).reason,
    ).toBe("1 scheduled task armed · next run is due")
  })

  test("drops the suffix when no next run is known or the timestamp is unusable", () => {
    expect(decide({ preference: "auto", armedTasks: 1, inFlightRuns: 0, platform: "linux" }).reason).toBe(
      "1 scheduled task armed",
    )
    expect(
      decide({ preference: "auto", armedTasks: 1, inFlightRuns: 0, platform: "linux", nextRunAt: Number.NaN }).reason,
    ).toBe("1 scheduled task armed")
  })

  test("counts runs in flight", () => {
    expect(decide({ preference: "auto", armedTasks: 0, inFlightRuns: 1, platform: "darwin" }).reason).toBe(
      "1 background run in progress",
    )
    expect(decide({ preference: "auto", armedTasks: 4, inFlightRuns: 3, platform: "darwin" }).reason).toBe(
      "3 background runs in progress",
    )
  })
})

describe("quit intent", () => {
  test("starts clear, latches on request, and can be cleared for a cancelled quit", () => {
    clearQuitRequest()
    expect(isQuitRequested()).toBe(false)
    requestQuit()
    expect(isQuitRequested()).toBe(true)
    requestQuit()
    expect(isQuitRequested()).toBe(true)
    clearQuitRequest()
    expect(isQuitRequested()).toBe(false)
  })
})
