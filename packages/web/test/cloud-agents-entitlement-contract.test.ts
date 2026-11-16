import { expect, test } from "bun:test"
import { ENTITLEMENTS, type EntitlementSnapshot } from "../../schema/src/codium-entitlements"
import { CodiumPlan } from "../../schema/src/codium-plan"
import { cloudAgentView } from "../../../api/_lib/codium-cloud-agents"

const now = 1_800_000_000_000
const snapshot = (plan: CodiumPlan.PlanId): EntitlementSnapshot => ({
  v: 1,
  version: 1,
  livemode: false,
  account: "00000000-0000-4000-8000-000000000001",
  state: "active",
  plan,
  subscription: "sub_test",
  periodStart: now - 1000,
  periodEnd: now + 86_400_000,
  meterEpoch: `sub_test:${now - 1000}`,
  cancelAtPeriodEnd: false,
  caps: ENTITLEMENTS[plan],
  updatedAt: now,
  checkedAt: now,
  ramp: { hostedUntil: 0, browserFrom: 0 },
  source: "request",
})

test("all plans take limits from the canonical snapshot and preserve its meter epoch", () => {
  for (const plan of CodiumPlan.PLANS) {
    const current = snapshot(plan.id)
    const allowance = cloudAgentView(current, "desktop", now)
    expect(allowance.active).toBe(true)
    if (!allowance.active) throw new Error("Missing active fixture allowance")
    expect(allowance.limits).toEqual(ENTITLEMENTS[plan.id].cloudAgents)
    expect(allowance.allowanceSeconds).toBe(ENTITLEMENTS[plan.id].cloudAgents.hours * 3600)
    expect(allowance.meterEpoch).toBe(current.meterEpoch)
    expect(allowance.premiumModels).toBe(ENTITLEMENTS[plan.id].rank >= 3)
  }
})
test("reserved sources, schedule caps, billing holds and closing never yield an active allowance", () => {
  const plus = snapshot("vector-10")
  expect(cloudAgentView(plus, "github-schedule", now)).toEqual({ active: false, reason: "not-in-plan" })
  expect(cloudAgentView(plus, "slack", now)).toEqual({ active: false, reason: "source-unavailable" })
  for (const [state, reason, refusal] of [
    ["paused", "payment_failed", "payment"],
    ["frozen", "disputed", "dispute"],
    ["frozen", "early_fraud_warning", "fraud"],
    ["ended", "closing", "closing"],
  ] as const)
    expect(cloudAgentView({ ...plus, state, reason }, "desktop", now)).toEqual({ active: false, reason: refusal })
  expect(cloudAgentView(undefined, "desktop", now)).toEqual({ active: false, reason: "none" })
  expect(() =>
    cloudAgentView({ ...plus, state: "renewing", periodEnd: now - 7 * 86_400_000 }, "desktop", now),
  ).toThrow()
})
