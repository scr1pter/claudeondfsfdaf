import { readConfig, type EverywhereConfig } from "./config.js"
import { codiumAccountAuthority } from "./adapters/account.js"
import { createCloudPorts, createHandoffBinding, createHandoffVerifier, createRepositoryPort } from "./adapters/cloud-agents.js"
import { createRemotePorts } from "./adapters/remote.js"
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

/**
 * Unwired services remain unavailable; account guards use the actual deletion key. With the feature off this is
 * safePorts exactly, with no new read. With it on, binding, visibility and cloudSource are @vector's (VE-30a,
 * adapters/cloud-agents.ts), but there is still no prepareCloud, so routing reads neither: it needs an enabled platform
 * source (R-C8/R-A8, the owner's) and EV-30's live mode read. Repository verification uses the sponsor's own binding.
 * The laptop route's presence, offer and plan check (VE-20, adapters/remote.ts) join once offers can be signed.
 * Building the ports does no I/O.
 */
export function productionPorts(config: EverywhereConfig = readConfig(), fetcher?: typeof fetch) {
  const ports = { ...safePorts(config), accountAuthority: codiumAccountAuthority }
  if (!config.enabled) return ports
  const cloud = { ...ports, ...createCloudPorts(), repository: createRepositoryPort() }
  if (!config.offer) return cloud
  return { ...cloud, ...createRemotePorts({ config, fetcher }) }
}

export function productionPlatformDeps() {
  return { config: readConfig, context: productionContext, ports: productionPorts() }
}

/**
 * VE-31: the GitHub handoff's verifier (R-A5's `handoff` audience, loaded on first use), @vector's binding and the
 * ports an offer needs (the route's safePorts default never offers). None while the flag is off, so the route answers
 * 501 before any read (VE-10). The binding says laptopFirst false until Q13/R-A6, so every production handoff answers
 * handled:false. Building them does no I/O.
 */
export function productionHandoffDeps(config: EverywhereConfig = readConfig()) {
  if (!config.enabled) return {}
  return { verify: createHandoffVerifier(), binding: createHandoffBinding(), ports: productionPorts(config) }
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
