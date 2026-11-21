import { startCloudRun, type StartCloudRunResult } from "./cloud-agents-start.js"
import { ApiError } from "./http.js"
import { cloudAgentsEnabled } from "./model-plan-config.js"
import type { OpsRunStarter } from "./ops-incidents.js"

/**
 * WP A59: the "Fix it" starter that api/_lib/ops-registration.ts registers. While the cloud-agents service is off it
 * refuses with 503 before anything is read or reserved. Otherwise it starts the run through @vector's `startCloudRun`
 * and throws each refusal as an ApiError with fixed text, which ops-incidents passes through after releasing its claim.
 *
 * It answers no run id: `startCloudRun` has none at dispatch (the run reports its id when it starts), and the ticket's
 * hash is a credential's digest, not a run id. ops-incidents records the fix without one. `deps` is for tests only.
 */
export function createOpsRunStarter(deps: Parameters<typeof startCloudRun>[1] = {}) {
  return (async (trigger) => {
    if (!cloudAgentsEnabled()) throw new ApiError(503, "OPS_FIX_UNAVAILABLE", "Fix runs are not available yet.")
    const result = await startCloudRun(trigger, deps)
    if (!result.ok) throw refusal(result.reason)
    return {}
  }) satisfies OpsRunStarter
}

/** The run service's own reasons are never echoed. */
function refusal(reason: Extract<StartCloudRunResult, { ok: false }>["reason"]) {
  if (reason === "not-bound" || reason === "not-binder")
    return new ApiError(409, "OPS_REPO_NOT_BOUND", "Connect this repository to your Vector account first.")
  if (reason === "app-required")
    return new ApiError(
      503,
      "OPS_FIX_APP_REQUIRED",
      "Install Vector's GitHub App on this repository to start a fix run.",
    )
  if (reason === "dispatch-failed" || reason === "source-unavailable" || reason === "purpose-unavailable")
    return new ApiError(503, "OPS_FIX_UNAVAILABLE", "The fix run could not start. Try again shortly.")
  return new ApiError(403, "OPS_FIX_NOT_ALLOWED", "Your Vector Codium plan does not allow a fix run right now.")
}
