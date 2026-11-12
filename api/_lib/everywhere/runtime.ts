import { readConfig } from "./config.js"
import { createJobEvents } from "./events.js"
import type { JobsContext } from "./jobs.js"
import type { Platforms } from "./platform.js"
import { safePorts } from "./ports.js"
import { createSlackAdapter, type SlackDeps } from "./slack/adapter.js"
import { createSlackRoutes } from "./slack/routes.js"
import { everywhereStore } from "./store.js"

export function productionSlackDeps() {
  return { config: readConfig, context: productionContext, ports: safePorts() }
}

export function configuredPlatforms(deps: SlackDeps): Platforms {
  const config = deps.config()
  return { ...(config.enabled && config.platforms.has("slack") && config.slack ? { slack: createSlackAdapter(deps) } : {}) }
}

export function productionPlatforms(): Platforms {
  return configuredPlatforms(productionSlackDeps())
}

export function productionContext(): JobsContext {
  const config = readConfig()
  return { store: everywhereStore(), keys: config.dataKeys, offer: config.offer, now: Date.now() }
}

/** Production jobs routes and the cron share exactly the same posting hooks. */
export const productionJobEvents = createJobEvents(productionContext, productionPlatforms)

export const productionSlackRoutes = createSlackRoutes(productionSlackDeps())
