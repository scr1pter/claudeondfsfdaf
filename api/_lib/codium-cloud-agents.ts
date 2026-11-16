import { CodiumRunTrigger } from "../../packages/schema/src/codium-run-trigger.js"
import type { EntitlementSnapshot, Entitlements } from "../../packages/schema/src/codium-entitlements.js"
import type { PlanId } from "../../packages/schema/src/codium-plan.js"
import { readEntitlement } from "./codium-entitlements.js"
import { requireUsableSnapshot } from "./codium-snapshot.js"
import { readSwitch } from "./codium-switches.js"
import { modelPlansEnabled } from "./model-plan-config.js"

export type CloudAgentLimits = Entitlements["cloudAgents"]
export type CloudAgentAllowance =
  | {
      readonly active: true
      readonly plan: PlanId
      readonly limits: CloudAgentLimits
      readonly allowanceSeconds: number
      readonly meterEpoch: string
      readonly periodEnd: number
      readonly premiumModels: boolean
      readonly revokedBefore?: number
    }
  | {
      readonly active: false
      readonly reason:
        | "none"
        | "payment"
        | "dispute"
        | "fraud"
        | "closing"
        | "service-off"
        | "source-unavailable"
        | "not-in-plan"
    }

/** One source of limits: the reconciled snapshot, including ramps and current subscription state. */
export function cloudAgentView(
  snapshot: EntitlementSnapshot | undefined,
  source: CodiumRunTrigger.RunSource,
  now: number,
): CloudAgentAllowance {
  if (!CodiumRunTrigger.ENABLED_SOURCES.has(source)) return { active: false, reason: "source-unavailable" }
  if (!snapshot || snapshot.state === "none") return { active: false, reason: "none" }
  if (snapshot.reason === "closing") return { active: false, reason: "closing" }
  if (snapshot.state === "paused") return { active: false, reason: "payment" }
  if (snapshot.state === "frozen")
    return {
      active: false,
      reason:
        snapshot.reason === "disputed"
          ? "dispute"
          : snapshot.reason === "early_fraud_warning"
            ? "fraud"
            : "service-off",
    }
  if (snapshot.state === "ended") return { active: false, reason: "none" }
  const current = requireUsableSnapshot(snapshot, now)
  if (!current.plan || !current.subscription || current.meterEpoch === "none") return { active: false, reason: "none" }
  const caps = current.caps.cloudAgents
  if (
    caps.atOnce <= 0 ||
    caps.hours <= 0 ||
    caps.longestRunMin <= 0 ||
    ((source === "schedule" || source === "github-schedule") && caps.scheduledPerDay <= 0)
  )
    return { active: false, reason: "not-in-plan" }
  return {
    active: true,
    plan: current.plan,
    limits: { ...caps, runCeilingShare: Math.min(caps.runCeilingShare, current.caps.dailyShare ?? 1) },
    allowanceSeconds: Math.floor(caps.hours * 3600),
    meterEpoch: current.meterEpoch,
    periodEnd: current.periodEnd,
    premiumModels: current.caps.rank >= 3,
    ...(current.revokedBefore === undefined ? {} : { revokedBefore: current.revokedBefore }),
  }
}

/** Fresh snapshots make no billing-network request; switch/store failures propagate so the mint fails closed. */
export async function cloudAgentAllowance(
  account: string,
  input: { source: CodiumRunTrigger.RunSource; now?: number },
  fetcher: typeof fetch = fetch,
): Promise<CloudAgentAllowance> {
  if (!modelPlansEnabled()) return { active: false, reason: "service-off" }
  if (!CodiumRunTrigger.ENABLED_SOURCES.has(input.source)) return { active: false, reason: "source-unavailable" }
  const now = input.now ?? Date.now()
  if (
    (await readSwitch("cloudAgents", fetcher, { now })) !== "on" ||
    (await readSwitch("codium", fetcher, { now })) !== "on"
  )
    return { active: false, reason: "service-off" }
  return cloudAgentView(await readEntitlement(account, fetcher, now), input.source, now)
}
