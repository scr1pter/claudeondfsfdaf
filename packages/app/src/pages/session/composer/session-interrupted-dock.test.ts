import { afterEach, describe, expect, test } from "bun:test"
import {
  dismissInterrupted,
  interruptedDockState,
  loadInterruptedDismissed,
  saveInterruptedDismissed,
} from "./session-interrupted-dock"

/*
 * The composer region's interrupted dock (5.I.4): what it names on a root session, what Resume all resumes, and the
 * dismissal kept per root in localStorage.
 */

afterEach(() => localStorage.clear())

const helpers = [
  { id: "ses_a", resumable: true },
  { id: "ses_b", resumable: true },
  { id: "ses_c", resumable: false },
]

describe("interrupted dock", () => {
  test("names every interrupted helper on the root's page; Resume all takes the resumable ones", () => {
    expect(interruptedDockState({ root: true, helpers, dismissed: [] })).toEqual({
      ids: ["ses_a", "ses_b", "ses_c"],
      resumable: ["ses_a", "ses_b"],
    })
  })

  test("shows nothing on a subagent's own page or with nothing interrupted", () => {
    expect(interruptedDockState({ root: false, helpers, dismissed: [] })).toBeUndefined()
    expect(interruptedDockState({ root: true, helpers: [], dismissed: [] })).toBeUndefined()
  })

  test("an engine without resume still shows the dock, with Dismiss only", () => {
    expect(interruptedDockState({ root: true, helpers: [{ id: "ses_a", resumable: false }], dismissed: [] })).toEqual({
      ids: ["ses_a"],
      resumable: [],
    })
  })

  test("Dismiss hides the helpers it named; a later interruption shows the dock again", () => {
    const state = interruptedDockState({ root: true, helpers, dismissed: [] })!
    const dismissed = dismissInterrupted([], state)
    expect(interruptedDockState({ root: true, helpers, dismissed })).toBeUndefined()
    const later = [...helpers, { id: "ses_d", resumable: true }]
    expect(interruptedDockState({ root: true, helpers: later, dismissed })).toEqual({
      ids: ["ses_d"],
      resumable: ["ses_d"],
    })
  })

  test("a helper listed twice is named once", () => {
    expect(
      interruptedDockState({ root: true, helpers: [helpers[0]!, helpers[0]!, helpers[1]!], dismissed: [] })?.ids,
    ).toEqual(["ses_a", "ses_b"])
  })

  test("dismissal is stored per root in localStorage, bounded, and survives a reload", () => {
    expect(loadInterruptedDismissed("ses_root")).toEqual([])
    saveInterruptedDismissed("ses_root", ["ses_a", "ses_b", "ses_a"])
    expect(loadInterruptedDismissed("ses_root")).toEqual(["ses_a", "ses_b"])
    expect(loadInterruptedDismissed("ses_other")).toEqual([])
    const many = Array.from({ length: 250 }, (_, index) => `ses_${index}`)
    const kept = saveInterruptedDismissed("ses_root", many)
    expect(kept).toHaveLength(200)
    expect(kept[0]).toBe("ses_50")
    expect(loadInterruptedDismissed("ses_root")).toEqual(kept)
  })

  test("unreadable storage reads as nothing dismissed", () => {
    localStorage.setItem("vector.interruptedDock.dismissed.v1:ses_root", "{not json")
    expect(loadInterruptedDismissed("ses_root")).toEqual([])
    localStorage.setItem("vector.interruptedDock.dismissed.v1:ses_root", JSON.stringify({ ids: ["x"] }))
    expect(loadInterruptedDismissed("ses_root")).toEqual([])
    localStorage.setItem("vector.interruptedDock.dismissed.v1:ses_root", JSON.stringify(["ses_a", 4, null]))
    expect(loadInterruptedDismissed("ses_root")).toEqual(["ses_a"])
  })
})
