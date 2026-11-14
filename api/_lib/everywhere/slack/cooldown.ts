import { everywhereKeys } from "../keys.js"
import { storeScore, type Store } from "../store.js"
import type { SlackMethod } from "./client.js"

/** Atomic max: concurrent shorter Retry-After answers cannot shorten a previous workspace cooldown. */
export function slackCooldown(store: Store, installation: string) {
  return {
    read: async (method: SlackMethod) => storeScore(await store(["ZSCORE", everywhereKeys.slackRetry(installation, method), "until"])),
    write: async (method: SlackMethod, at: number, _ttlMs: number) => {
      if (!Number.isSafeInteger(at) || at <= 0) throw new RangeError("Invalid Slack cooldown")
      const key = everywhereKeys.slackRetry(installation, method)
      await store(["ZADD", key, "GT", at, "until"])
      // Every native Retry-After is capped at one day. Extending this constant TTL never drops a longer score.
      await store(["PEXPIRE", key, 24 * 60 * 60_000])
    },
  }
}
