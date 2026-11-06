import type { Event } from "@vectordevai/sdk/v2/client"
import { Billing } from "@vectordevai/schema/billing"

/** Observe existing events without fetching transcripts or polling while Settings is closed. */
export function observeCodiumTurns(ended: () => void) {
  const latest = new Map<string, { id: string; created: number; codium: boolean; ended: boolean }>()
  return (event: Event) => {
    if (event.type === "session.deleted") {
      latest.delete(event.properties.info.id)
      return
    }
    if (event.type === "message.updated") {
      const info = event.properties.info
      if (info.role !== "assistant") return
      const previous = latest.get(info.sessionID)
      if (previous && previous.created > info.time.created) return
      latest.delete(info.sessionID)
      latest.set(info.sessionID, {
        id: info.id,
        created: info.time.created,
        codium: Boolean(Billing.of(info)),
        ended: previous?.id === info.id && previous.ended,
      })
      if (latest.size > 200) latest.delete(latest.keys().next().value!)
      return
    }
    const id =
      event.type === "session.idle"
        ? event.properties.sessionID
        : event.type === "session.status" && event.properties.status.type === "idle"
          ? event.properties.sessionID
          : undefined
    if (!id) return
    const turn = latest.get(id)
    if (!turn || turn.ended) return
    turn.ended = true
    if (turn.codium) ended()
  }
}
