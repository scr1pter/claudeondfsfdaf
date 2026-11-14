import { luaKeyTypes } from "./lua.js"
import { JOB_ID_PATTERN, LIMITS, type PlatformId } from "../../../packages/schema/src/everywhere.js"
import { ApiError } from "../http.js"
import { KEEP_MS, everywhereKeys } from "./keys.js"
import { runScript, setValue, storeInteger, storeUnavailable, type Store } from "./store.js"

/*
 * Delivery dedupe (contract 3.2 step 4) and single-use ids. A delivery id (`X-GitHub-Delivery`, `Linear-Delivery`,
 * Slack `event_id`, an A2A message id) is claimed with `SET NX` as `pending` for 60 seconds, then marked `done` for 7
 * days. A second delivery of the same id is `seen` and gets its 200 at once with no work. A delivery whose work never
 * finished before admission is free again after 60 seconds. Intake reserves `pending:<jid>` and atomically changes
 * it to `job:<jid>` with job creation, retained for seven days even if the create response or process is lost.
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

/** Shared by atomic job admission; the delivery key also keeps its admitted jid for seven days. */
export function deliveryKey(platform: PlatformId, deliveryId: string) {
  checkDelivery(deliveryId)
  return everywhereKeys.delivery(platform, deliveryId)
}

/** Claims a delivery: `new` the first time, `seen` for every later delivery of the same id while it is remembered. */
export async function claimDelivery(store: Store, platform: PlatformId, deliveryId: string, jid?: string): Promise<DeliveryClaim> {
  if (jid !== undefined && !JOB_ID_PATTERN.test(jid)) throw new ApiError(400, "EVERYWHERE_DELIVERY_INVALID", "Invalid admission id.")
  const fresh = await setValue(store, deliveryKey(platform, deliveryId), jid === undefined ? "pending" : `pending:${jid}`, {
    ttlMs: KEEP_MS.deliveryPending,
    onlyNew: true,
  })
  return fresh ? "new" : "seen"
}

/** Marks a claimed delivery done, so retries in the next 7 days are answered at once. */
export const FINISH_DELIVERY_SCRIPT = luaKeyTypes(["string"]) + [
  "local current = redis.call('GET', KEYS[1])",
  "if current and string.sub(current, 1, 4) == 'job:' then return 0 end",
  "if ARGV[2] ~= '' and current ~= ARGV[2] then return 0 end",
  "redis.call('SET', KEYS[1], 'done', 'PX', ARGV[1])",
  "return 1",
].join(" ")

export async function finishDelivery(store: Store, platform: PlatformId, deliveryId: string, jid?: string): Promise<void> {
  if (jid !== undefined && !JOB_ID_PATTERN.test(jid)) throw new ApiError(400, "EVERYWHERE_DELIVERY_INVALID", "Invalid admission id.")
  const changed = storeInteger(await runScript(store, FINISH_DELIVERY_SCRIPT, [deliveryKey(platform, deliveryId)], [KEEP_MS.deliveryDone, jid === undefined ? "" : `pending:${jid}`]))
  if (changed !== 0 && changed !== 1) throw storeUnavailable()
}

/**
 * Uses a single-use id once (a Forge token's `jti`, an offer's `jti`, a GitHub handoff's run): true the first time,
 * false for every later use while the key lives. `key` comes from `everywhereKeys`.
 */
export async function useOnce(store: Store, key: string, ttlMs: number): Promise<boolean> {
  return setValue(store, key, "1", { ttlMs, onlyNew: true })
}
