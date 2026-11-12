import { readConfig } from "./config.js"
import { createJobEvents } from "./events.js"
import type { JobsContext } from "./jobs.js"
import type { PlatformAdapter, Platforms } from "./platform.js"
import type { PlatformId } from "../../../packages/schema/src/everywhere.js"
import { everywhereStore } from "./store.js"

const adapters: Partial<Record<PlatformId, PlatformAdapter>> = {}

/** Platform route modules register their configured adapter; the dormant runtime has no platform credentials. */
export function registerPlatform(adapter: PlatformAdapter): void {
  adapters[adapter.id] = adapter
}

export function productionPlatforms(): Platforms {
  return adapters
}

export function productionContext(): JobsContext {
  const config = readConfig()
  return { store: everywhereStore(), keys: config.dataKeys, offer: config.offer, now: Date.now() }
}

/** Production jobs routes and the cron share exactly the same posting hooks. */
export const productionJobEvents = createJobEvents(productionContext, productionPlatforms)
