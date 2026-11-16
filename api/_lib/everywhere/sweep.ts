import { ApiError, json, requireMethod, type ApiRequest, type ApiResponse } from "../http.js"
import { readConfig, type EverywhereConfig } from "./config.js"
import { postPending } from "./events.js"
import { sweepDue, type JobsContext } from "./jobs.js"
import type { Platforms } from "./platform.js"
import { productionContext, productionPlatforms } from "./runtime.js"
import { bearerMatches } from "./signature.js"
import { readEverywhereSwitch } from "./switch.js"

export function createSweep(deps: {
  readonly config?: () => EverywhereConfig
  readonly context?: () => JobsContext
  readonly platforms?: () => Platforms
  readonly stopped?: () => Promise<boolean>
} = {}) {
  return async (request: ApiRequest, response: ApiResponse) => {
    try {
      requireMethod(request, "GET")
      const config = (deps.config ?? readConfig)()
      const authorization = request.headers.authorization
      if (!bearerMatches(typeof authorization === "string" ? authorization : undefined, config.cronSecret))
        throw new ApiError(401, "CRON_UNAUTHORIZED", "This endpoint is restricted.")
      const context = deps.context ?? productionContext
      const stop = deps.stopped ? await deps.stopped() : await readEverywhereSwitch(config) === "stop"
      const ended = await sweepDue(context(), { stop })
      const posted = await postPending(context, deps.platforms ?? productionPlatforms)
      return json(response, 200, { ended: ended.length, posted })
    } catch (error) {
      return json(response, error instanceof ApiError ? error.statusCode : 503, {
        error: { code: error instanceof ApiError ? error.code : "EVERYWHERE_UNAVAILABLE" },
      })
    }
  }
}
