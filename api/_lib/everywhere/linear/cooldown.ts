import { everywhereKeys } from "../keys.js"
import { storeScore, type Store } from "../store.js"
import type { LinearCooldown } from "./client.js"

/**
 * One installation's Linear rate-limit cooldown. Reads use the plain store, so a stale cooldown never blocks a fenced
 * call; writes use the installation's fenced store and an atomic max, so a shorter reset cannot shorten a longer one.
 */
export function linearCooldown(read: Store, write: Store, installation: string): LinearCooldown {
  const key = everywhereKeys.linearRetry(installation)
  return {
    read: async () => storeScore(await read(["ZSCORE", key, "until"])),
    write: async (at) => {
      await write(["ZADD", key, "GT", Math.ceil(at), "until"])
      // Every reset Linear names is capped at one day, so this constant TTL never drops a longer score.
      await write(["PEXPIRE", key, 86_400_000])
    },
  }
}
