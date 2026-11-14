import { registerStatusMeter } from "./model-plan-status.js"
import { cardsUsed } from "./ship-desk.js"

/*
 * The Ship Desk status meter (WP A49; contract §4.11 `meters.shipDesk {used}`): the share of the plan's cards a month
 * counted this period, for Settings and the phone. It is read only while `ship-desk` is listed (the meter registry's
 * rule), and only from routes that import this module, so it never sits beside the ops provisioner, whose import would
 * form a cycle through model-plan-account.ts (A40's note). A store that cannot be read leaves the meter out.
 */

registerStatusMeter("ship-desk", "shipDesk", async (snapshot, fetcher) => {
  const cap = snapshot.caps.ops?.shipDesk.cardsPerMonth ?? 0
  if (cap < 1) return undefined
  const used = await cardsUsed(snapshot, fetcher)
  return used === undefined ? undefined : { used: Math.min(1, used / cap) }
})
