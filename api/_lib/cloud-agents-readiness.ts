import { CodiumPlan } from "../../packages/schema/src/codium-plan.js"
import { artifactCryptoReady } from "./cloud-agents-artifact.js"
import { brainUploadCryptoReady } from "./cloud-agents-brain.js"
import { runTokenCryptoReady } from "./cloud-agents-run-crypto.js"
import { githubApp } from "./github-app.js"
import {
  planView,
  servedPlanModels,
  verifiedGatewayModel,
  type ModelPlanCatalogOptions,
} from "./model-plan-catalog-policy.js"
import { persistentStore } from "./persistent-store.js"

/**
 * Dependency availability only: no account admission, owner consent, native qualification or release authority.
 * These ports are deliberately not registered as public perks until the actual runtime/release evidence qualifies.
 */
export function createCloudAgentsReadiness(
  input: {
    app?: Pick<typeof githubApp, "readiness">
    store?: typeof persistentStore
    env?: Readonly<Record<string, string | undefined>>
    /** Local closed tests may qualify their own catalog. Production passes no override. */
    catalog?: Pick<ModelPlanCatalogOptions, "models" | "qualify">
    now?: () => number
  } = {},
) {
  const app = input.app ?? githubApp
  const store = input.store ?? persistentStore
  const env = input.env ?? process.env

  async function agents(fetcher: typeof fetch = fetch) {
    try {
      if (!runTokenCryptoReady(env) || !artifactCryptoReady(env)) return false
      const [pong, models] = await Promise.all([
        store(["PING"], fetcher),
        servedPlanModels(input.catalog ?? {}, fetcher),
      ])
      const at = (input.now ?? Date.now)()
      return (
        pong === "PONG" &&
        CodiumPlan.PLANS.every((plan) =>
          models.some((model) => {
            if (model.manualOnly) return false
            const view = planView(model, plan.id, input.catalog?.qualify ?? verifiedGatewayModel, at)
            return view.access && view.served
          }),
        )
      )
    } catch {
      return false
    }
  }

  async function noSecret(fetcher: typeof fetch = fetch) {
    try {
      return (await agents(fetcher)) && (await app.readiness())
    } catch {
      return false
    }
  }

  async function brainCloud(fetcher: typeof fetch = fetch) {
    try {
      if (
        env.VECTOR_GITHUB_BRAIN_ENABLED !== "true" ||
        env.CODIUM_TRACK_B_LIVE !== "true" ||
        !brainUploadCryptoReady(env)
      )
        return false
      // Approved context and proposal import invoke no helper. Do not add a helper-model or listed-brain dependency.
      return await noSecret(fetcher)
    } catch {
      return false
    }
  }

  return { agents, noSecret, brainCloud }
}

export const cloudAgentsReadiness = createCloudAgentsReadiness()
