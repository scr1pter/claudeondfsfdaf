export * as NoteWindow from "./note-window"

// When a parent's held completion notes go out (TaskNotify). A busy parent reads them at its next step. An idle one
// gets them after QUIET with no new note, held at most HOLD from the first, and the whole HOLD while another of its
// background jobs still runs, so helpers that finish close together cost one turn.

/** Milliseconds without a new note before an idle parent gets the notes it holds. */
export const QUIET = 1_500
/** Milliseconds a note is held at most, counted from the first note of the window. */
export const HOLD = 5_000

/** Milliseconds from `now` until the held notes go out. `quiet` and `hold` override QUIET and HOLD. */
export function delay(i: {
  now: number
  first: number
  last: number
  busy: boolean
  siblings: number
  quiet?: number
  hold?: number
}): number {
  if (i.busy) return 0
  const latest = i.first + (i.hold ?? HOLD)
  const target = i.siblings > 0 ? latest : Math.min(i.last + (i.quiet ?? QUIET), latest)
  return Math.max(0, target - i.now)
}
