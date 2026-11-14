import type { EverywhereConfig } from "./config.js"
import type { OAuthExchanges } from "./identity.js"
import { slackExchange } from "./slack/install.js"
import { linearExchange } from "./linear/install.js"

/** Constructed independently in every serverless callback; no route-import registration order is required. */
export function platformExchanges(config: EverywhereConfig, fetcher?: typeof fetch, now: () => number = Date.now): OAuthExchanges {
  return { ...(config.platforms.has("slack") && config.slack ? { slack: slackExchange(config.slack, fetcher) } : {}),
    ...(config.platforms.has("linear") && config.linear ? { linear: linearExchange(config.linear, fetcher, now) } : {}) }
}
