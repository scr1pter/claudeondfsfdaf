import { createStore, produce } from "solid-js/store"

// What Vector learned from each message of a session, from the engine's memory.learned events, for the "Learned 2
// things" chip under the reply (section 6.5). An event carries entry ids only: the chip reads each entry from the
// owner's memory routes, so a guest, who may not read them, sees no chip and none of the words. The engine does not
// keep the event, so the chip lasts as long as the window; Settings > Memory > About you lists everything, with Undo.

type Learned = { readonly sessionID: string; readonly messageID?: string; readonly entryIDs: readonly string[] }

type Events = { on: (type: "memory.learned", listener: (event: { properties: Learned }) => void) => unknown }

const [learned, setLearned] = createStore<Record<string, Record<string, string[]>>>({})

/** Keeps what one event says was learned, once however often the event stream replays it. */
export function record(event: Learned) {
  if (!event.messageID || event.entryIDs.length === 0) return
  const messageID = event.messageID
  setLearned(
    produce((all) => {
      const session = (all[event.sessionID] ??= {})
      session[messageID] = [...new Set([...(session[messageID] ?? []), ...event.entryIDs])]
    }),
  )
}

/** The entries learned from any of these messages of a session: a request, or the replies whose plan card it answered. */
export function learnedFrom(sessionID: string, messageIDs: readonly (string | undefined)[]) {
  const session = learned[sessionID]
  if (!session) return []
  return [...new Set(messageIDs.flatMap((id) => (id ? (session[id] ?? []) : [])))]
}

const watched = new WeakSet<object>()

/**
 * Listens for what Vector learns in a directory's sessions, once per event stream. The composer starts it, since it is
 * on screen before the first reply that could carry a chip.
 */
export function watchLearned(events: Events) {
  if (watched.has(events)) return
  watched.add(events)
  events.on("memory.learned", (event) => record(event.properties))
}

export type ChipItem = {
  /** What was learned; for a learned skill, its name. */
  readonly text: string
  readonly status: string
  /** Learned from what the user typed, rather than from what they ticked on a plan card. */
  readonly typed: boolean
  /** A skill Vector drafted from how the run turned a failing check green. */
  readonly skill?: boolean
}

/** A learned skill's id: `s` and six base32 characters, which no memory entry has (BrainSkill.ID). */
export const SKILL_ID = /^s[0-9a-hjkmnp-tv-z]{6}$/

/** The chip's line: one item in full, more as a count (section 17: "Learned from what you typed: '{text}'"). */
export function chipLabel(items: readonly ChipItem[]) {
  const waiting = items.filter((item) => item.status === "proposed" || item.status === "quarantined").length
  const [item] = items
  if (items.length === 1 && item?.skill)
    return waiting ? `Drafted a skill for your review: ${item.text}` : `Learned a skill: ${item.text}`
  if (items.length === 1 && item) {
    const from = item.typed ? "what you typed" : "your plan card"
    return waiting ? `Saved from ${from} for your review: "${item.text}"` : `Learned from ${from}: "${item.text}"`
  }
  return `Learned ${items.length} things${waiting ? `, ${waiting} waiting for your review` : ""}`
}
