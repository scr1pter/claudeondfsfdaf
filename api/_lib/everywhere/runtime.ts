import { readConfig, type EverywhereConfig } from "./config.js"
import { codiumAccountAuthority } from "./adapters/account.js"
import { createJobEvents } from "./events.js"
import type { JobsContext } from "./jobs.js"
import type { Platforms } from "./platform.js"
import { safePorts } from "./ports.js"
import { createSlackAdapter, type SlackDeps } from "./slack/adapter.js"
import { createSlackRoutes } from "./slack/routes.js"
import { createLinearAdapter, type LinearDeps } from "./linear/adapter.js"
import { createLinearWebhook } from "./linear/routes.js"
import { createJiraAdapter } from "./jira/adapter.js"
import { createJiraRoutes } from "./jira/a2a.js"
import { everywhereStore } from "./store.js"

/** Unwired services remain unavailable; account guards use the actual deletion key. */
export function productionPorts(config: EverywhereConfig = readConfig()) {
  return { ...safePorts(config), accountAuthority: codiumAccountAuthority }
}

export function productionPlatformDeps() {
  return { config: readConfig, context: productionContext, ports: productionPorts() }
}

export function configuredPlatforms(deps: SlackDeps & Partial<Pick<LinearDeps, "privateResult" | "sleep">>): Platforms {
  const config = deps.config()
  return {
    ...(config.enabled && config.platforms.has("slack") && config.slack ? { slack: createSlackAdapter(deps) } : {}),
    ...(config.enabled && config.platforms.has("linear") && config.linear ? { linear: createLinearAdapter(deps) } : {}),
    ...(config.enabled && config.platforms.has("jira") && config.jira ? { jira: createJiraAdapter(deps).adapter } : {}),
  }
}

export function productionPlatforms(): Platforms {
  return configuredPlatforms(productionPlatformDeps())
}

export function productionContext(): JobsContext {
  const config = readConfig()
  const accountAuthority = productionPorts(config).accountAuthority
  return {
    store: everywhereStore(fetch, accountAuthority),
    keys: config.dataKeys,
    offer: config.offer,
    now: Date.now(),
    accountAuthority,
  }
}

/** Production jobs routes and the cron share exactly the same posting hooks. */
export const productionJobEvents = createJobEvents(productionContext, productionPlatforms)

export const productionSlackRoutes = createSlackRoutes(productionPlatformDeps())
export const productionLinearWebhook = createLinearWebhook(productionPlatformDeps())
export const productionJiraRoutes = createJiraRoutes(productionPlatformDeps())
