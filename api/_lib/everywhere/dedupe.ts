import { LIMITS, type PlatformId } from "../../../packages/schema/src/everywhere.js"
import { ApiError } from "../http.js"
import { KEEP_MS, everywhereKeys } from "./keys.js"
import { setValue, type Store } from "./store.js"

/*
 * Delivery dedupe (contract 3.2 step 4) and single-use ids. A delivery id (`X-GitHub-Delivery`, `Linear-Delivery`,
 * Slack `event_id`, an A2A message id) is claimed with `SET NX` as `pending` for 60 seconds, then marked `done` for 7
 * days. A second delivery of the same id is `seen` and gets its 200 at once with no work. A delivery whose work never
 * finished (the function died) is free again after 60 seconds, in time for the platform's retry.
 */

export type DeliveryClaim = "new" | "seen"

function checkDelivery(deliveryId: string) {
  if (
    typeof deliveryId !== "string" ||
    !deliveryId ||
    deliveryId.length > LIMITS.deliveryIdChars ||
    /[\x00-\x1f\x7f]/.test(deliveryId)
  )
    throw new ApiError(400, "EVERYWHERE_DELIVERY_INVALID", "This delivery has no usable id.")
}

/** Claims a delivery: `new` the first time, `seen` for every later delivery of the same id while it is remembered. */
export async function claimDelivery(store: Store, platform: PlatformId, deliveryId: string): Promise<DeliveryClaim> {
  checkDelivery(deliveryId)
  const fresh = await setValue(store, everywhereKeys.delivery(platform, deliveryId), "pending", {
    ttlMs: KEEP_MS.deliveryPending,
    onlyNew: true,
  })
  return fresh ? "new" : "seen"
}

/** Marks a claimed delivery done, so retries in the next 7 days are answered at once. */
export async function finishDelivery(store: Store, platform: PlatformId, deliveryId: string): Promise<void> {
  checkDelivery(deliveryId)
  await setValue(store, everywhereKeys.delivery(platform, deliveryId), "done", { ttlMs: KEEP_MS.deliveryDone })
}

/**
 * Uses a single-use id once (a Forge token's `jti`, an offer's `jti`, a GitHub handoff's run): true the first time,
 * false for every later use while the key lives. `key` comes from `everywhereKeys`.
 */
export async function useOnce(store: Store, key: string, ttlMs: number): Promise<boolean> {
  return setValue(store, key, "1", { ttlMs, onlyNew: true })
}
