import { cloudAgentAllowance, type CloudAgentAllowance } from "./codium-cloud-agents.js"
import { runTokensRevokedBefore } from "./codium-provisioners.js"
import type { RunSource } from "../../packages/schema/src/codium-run-trigger.js"

export { RUN_SOURCES, ENABLED_SOURCES } from "../../packages/schema/src/codium-run-trigger.js"
export type { RunSource, RunTrigger } from "../../packages/schema/src/codium-run-trigger.js"
export type { CloudAgentAllowance, CloudAgentLimits } from "./codium-cloud-agents.js"

/** A59: Codium's reconciled snapshot is the only source of current authority and limits. */
export function cloudAgentEntitlement(
  accountId: string,
  input: { source: RunSource; now?: number },
  fetcher: typeof fetch = fetch,
): Promise<CloudAgentAllowance> {
  return cloudAgentAllowance(accountId, input, fetcher)
}

/** Milliseconds; failures propagate so mints, gateway calls and artifact access all fail closed. */
export function cloudAgentRevokedBefore(accountId: string, fetcher: typeof fetch = fetch): Promise<number | undefined> {
  return runTokensRevokedBefore(accountId, fetcher)
}
