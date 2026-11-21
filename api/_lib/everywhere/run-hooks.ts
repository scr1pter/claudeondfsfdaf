import { registerRunSettleListener, registerRunStartListener } from "../cloud-agents-runs.js"
import { createRunHooks, type RunHooksDeps } from "./adapters/cloud-agents.js"
import { readConfig, type EverywhereConfig } from "./config.js"
import { everywhereStore } from "./store.js"
import { readEverywhereSwitch } from "./switch.js"

/*
 * EV-30 (VE-30b, R-A2, R-A3): Vector everywhere's listeners on @vector's run hooks (cloud-agents-runs.ts), registered
 * only while the everywhere config is on. The config is read once, when the function loads; Vercel reads a changed
 * environment only on a new deployment anyway. The listeners hold Vector everywhere's store and never @vector's, so
 * nothing they do can touch a run record; a failure reaches the hooks' own fixed log line. The jobs runtime loads only
 * once a run turns out to be an everywhere job's, which also keeps runtime.ts out of this module's import cycle.
 */

/** Registers both listeners while the config is on, and answers their remover; with the config off, nothing. */
export function registerEverywhereRunHooks(
  options: { readonly config?: EverywhereConfig; readonly hooks?: RunHooksDeps } = {},
) {
  const config = options.config ?? readConfig()
  if (!config.enabled) return undefined
  const hooks = createRunHooks(options.hooks ?? productionHooks(config))
  const removers = [registerRunStartListener(hooks.start), registerRunSettleListener(hooks.settle)]
  return () => removers.forEach((remove) => remove())
}

function productionHooks(config: EverywhereConfig): RunHooksDeps {
  return {
    store: everywhereStore(),
    load: async () => {
      const { productionContext, productionJobEvents } = await import("./runtime.js")
      return {
        context: productionContext,
        settled: async (job) => {
          await productionJobEvents.settled?.(job)
        },
        switch: () => readEverywhereSwitch(config),
      }
    },
  }
}
