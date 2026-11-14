import { describe, expect, test } from "bun:test"
import { NoteWindow } from "../../src/task/note-window"

// When a parent's held completion notes go out, from the window alone.

describe("NoteWindow.delay", () => {
  const { QUIET, HOLD } = NoteWindow

  test("a busy parent gets its notes at once", () => {
    expect(NoteWindow.delay({ now: 100, first: 100, last: 100, busy: true, siblings: 3 })).toBe(0)
  })

  test("with no other job running, an idle parent waits QUIET after the last note", () => {
    expect(NoteWindow.delay({ now: 1_000, first: 0, last: 1_000, busy: false, siblings: 0 })).toBe(QUIET)
    expect(NoteWindow.delay({ now: 1_200, first: 0, last: 1_000, busy: false, siblings: 0 })).toBe(QUIET - 200)
  })

  test("while another job runs, the notes are held until HOLD after the first", () => {
    expect(NoteWindow.delay({ now: 1_000, first: 0, last: 1_000, busy: false, siblings: 1 })).toBe(HOLD - 1_000)
  })

  test("never past HOLD after the first note", () => {
    // Notes keep landing: the quiet time would run past the hold.
    expect(NoteWindow.delay({ now: 4_500, first: 0, last: 4_500, busy: false, siblings: 0 })).toBe(HOLD - 4_500)
    expect(NoteWindow.delay({ now: 4_000, first: 0, last: 4_000, busy: false, siblings: 2 })).toBe(HOLD - 4_000)
  })

  test("never negative", () => {
    expect(NoteWindow.delay({ now: 60_000, first: 0, last: 1_000, busy: false, siblings: 0 })).toBe(0)
    expect(NoteWindow.delay({ now: 60_000, first: 0, last: 59_000, busy: false, siblings: 1 })).toBe(0)
  })

  test("quiet and hold override QUIET and HOLD", () => {
    expect(NoteWindow.delay({ now: 10, first: 0, last: 10, busy: false, siblings: 0, quiet: 20, hold: 100 })).toBe(20)
    expect(NoteWindow.delay({ now: 10, first: 0, last: 10, busy: false, siblings: 1, quiet: 20, hold: 100 })).toBe(90)
    expect(NoteWindow.delay({ now: 95, first: 0, last: 95, busy: false, siblings: 0, quiet: 20, hold: 100 })).toBe(5)
  })
})
