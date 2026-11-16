import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  ENTITLEMENTS,
  type EntitlementSnapshot,
  type PlanReason,
  type PlanState,
} from "../../schema/src/codium-entitlements"
import { CodiumPlan } from "../../schema/src/codium-plan"
import { ENABLED_SOURCES, RUN_SOURCES, type RunSource } from "../../schema/src/codium-run-trigger"
import { cloudAgentView, type CloudAgentAllowance } from "../../../api/_lib/codium-cloud-agents"
import { cloudAgentEntitlement, cloudAgentRevokedBefore } from "../../../api/_lib/cloud-agents-entitlement"
import "../../../api/_lib/cloud-agents-run-registration"
import { cloudRunReader, registerCloudRunReader } from "../../../api/_lib/cloud-run-reader"
import { runTokensRevokedKey } from "../../../api/_lib/codium-provisioners"
import { buildSnapshot, snapshotKey } from "../../../api/_lib/codium-snapshot"
import { switchKey } from "../../../api/_lib/codium-switches"
import { codiumFakes, codiumTestEnvironment } from "./fixture/codium-fakes"

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

// ── A59 through Codex's seam (BT11) ────────────────────────────────────────────────────────────────────────────────

type Refusal = Extract<CloudAgentAllowance, { active: false }>["reason"]
const REASONS = [
  "none",
  "payment",
  "dispute",
  "fraud",
  "closing",
  "service-off",
  "source-unavailable",
  "not-in-plan",
] as const satisfies readonly Refusal[]
// Fails to compile when the allowance gains a refusal this list does not name.
const exhaustive: [Exclude<Refusal, (typeof REASONS)[number]>] extends [never] ? true : false = true

// Codex's files reach Codium's allowance and run-token mark only through cloud-agents-entitlement.ts (A59), and
// Codium's readers reach Codex's run records only through the registered cloud run reader. Every store read goes to the
// Codium fake through a fetcher passed in, and each snapshot is fresh at `now`, so no case reaches Stripe or waits.
describe("A59 through Codex's seam", () => {
  let fakes = codiumFakes({ now })
  let restore = () => {}
  let accounts = 0
  beforeEach(() => {
    fakes = codiumFakes({ now })
    restore = codiumTestEnvironment()
  })
  afterEach(() => restore())

  // A new identity per call, so the 30-second switch cache (kept per fetcher) never carries a value between calls.
  const fresh = () => ((input: RequestInfo | URL, init?: RequestInit) => fakes.fetcher(input, init)) as typeof fetch
  const account = () => `00000000-0000-4000-8000-${String(++accounts).padStart(12, "0")}`
  const seed = (plan: CodiumPlan.PlanId | null, state: PlanState, reason?: PlanReason) => {
    const stored = buildSnapshot(
      {
        account: account(),
        state,
        ...(reason ? { reason } : {}),
        plan,
        ...(plan ? { subscription: `sub_contract${accounts}` } : {}),
        periodStart: now - 1000,
        periodEnd: now + 86_400_000,
        cancelAtPeriodEnd: false,
        source: "request",
      },
      undefined,
      now,
    )
    fakes.store.set(snapshotKey(stored.account), JSON.stringify(stored))
    return stored
  }

  test("Codex's seam answers Codium's allowance for every plan and source", async () => {
    const reserved = RUN_SOURCES.filter((source) => !ENABLED_SOURCES.has(source))
    expect(reserved).toEqual(["slack", "linear", "jira"])
    for (const plan of CodiumPlan.PLANS) {
      const stored = seed(plan.id, "active")
      for (const source of RUN_SOURCES) {
        const allowance = await cloudAgentEntitlement(stored.account, { source, now }, fresh())
        expect({ plan: plan.id, source, allowance }).toEqual({
          plan: plan.id,
          source,
          allowance: cloudAgentView(stored, source, now),
        })
        const scheduled = source === "schedule" || source === "github-schedule"
        expect({ plan: plan.id, source, allowance }).toMatchObject({
          plan: plan.id,
          source,
          allowance: reserved.includes(source)
            ? { active: false, reason: "source-unavailable" }
            : scheduled && ENTITLEMENTS[plan.id].cloudAgents.scheduledPerDay === 0
              ? { active: false, reason: "not-in-plan" }
              : { active: true, plan: plan.id, meterEpoch: stored.meterEpoch, periodEnd: stored.periodEnd },
        })
      }
    }
  })

  test("every refusal reason reaches Codex's seam, and a store outage fails closed", async () => {
    const seen = new Set<Refusal>()
    const refuse = async (id: string, source: RunSource, reason: Refusal) => {
      expect({ source, allowance: await cloudAgentEntitlement(id, { source, now }, fresh()) }).toEqual({
        source,
        allowance: { active: false, reason },
      })
      seen.add(reason)
    }
    const max = seed("vector-100", "active")
    // Codium off, or a reserved source: refused before anything is read.
    const commands = fakes.store.commands.length
    delete process.env.MODEL_PLANS_ENABLED
    await refuse(max.account, "github-comment", "service-off")
    process.env.MODEL_PLANS_ENABLED = "true"
    await refuse(max.account, "slack", "source-unavailable")
    expect(fakes.store.commands.length).toBe(commands)
    // Either owner switch off.
    for (const name of ["cloudAgents", "codium"] as const) {
      fakes.store.set(
        switchKey(name),
        JSON.stringify({ value: "off", changedAt: now, generation: "g1", offSince: now }),
      )
      await refuse(max.account, "github-comment", "service-off")
      fakes.store.remove(switchKey(name))
    }
    for (const [state, reason, refusal] of [
      ["none", undefined, "none"],
      ["ended", "canceled", "none"],
      ["paused", "payment_failed", "payment"],
      ["frozen", "disputed", "dispute"],
      ["frozen", "early_fraud_warning", "fraud"],
      ["frozen", "owner", "service-off"],
      ["frozen", "refunded", "service-off"],
      ["ended", "closing", "closing"],
    ] as const)
      await refuse(seed(state === "none" ? null : "vector-100", state, reason).account, "github-comment", refusal)
    await refuse(seed("vector-10", "active").account, "github-schedule", "not-in-plan")
    expect([...seen].sort()).toEqual([...REASONS].sort())
    expect(exhaustive).toBe(true)

    fakes.store.down = true
    await expect(cloudAgentEntitlement(max.account, { source: "github-comment", now }, fresh())).rejects.toMatchObject({
      code: "PERSISTENT_STORE_UNAVAILABLE",
    })
  })

  test("the revokedBefore seam is Codium's run-token mark and fails closed", async () => {
    const id = account()
    expect(await cloudAgentRevokedBefore(id, fresh())).toBeUndefined()
    fakes.store.set(runTokensRevokedKey(id), "1800000000000")
    expect(await cloudAgentRevokedBefore(id, fresh())).toBe(1_800_000_000_000)
    fakes.store.set(runTokensRevokedKey(id), "-1")
    await expect(cloudAgentRevokedBefore(id, fresh())).rejects.toMatchObject({
      statusCode: 503,
      code: "CODIUM_OUTBOX_UNAVAILABLE",
    })
    fakes.store.down = true
    await expect(cloudAgentRevokedBefore(id, fresh())).rejects.toMatchObject({ code: "PERSISTENT_STORE_UNAVAILABLE" })
  })

  test("A59: the run records are the one cloud run reader and read nothing while the service is off", async () => {
    const reader = cloudRunReader()
    if (!reader) throw new Error("The cloud run reader is not registered")
    expect(() => registerCloudRunReader(async () => [])).toThrow(/exactly one reader/)
    // No store address at all (codiumTestEnvironment also clears the UPSTASH_* fallbacks), so no request can leave.
    restore()
    restore = codiumTestEnvironment({
      KV_REST_API_URL: undefined,
      KV_REST_API_TOKEN: undefined,
      VECTOR_GITHUB_BRAIN_ENABLED: undefined,
    })
    const id = account()
    expect(await reader(id, { limit: 20 })).toEqual([])
    process.env.VECTOR_GITHUB_BRAIN_ENABLED = "true"
    delete process.env.MODEL_PLANS_ENABLED
    expect(await reader(id, { limit: 20 })).toEqual([])
    // Both switches on: the reader reaches the run records' store seam, which has no address here.
    process.env.MODEL_PLANS_ENABLED = "true"
    await expect(reader(id, { limit: 20 })).rejects.toMatchObject({
      statusCode: 503,
      code: "PERSISTENT_STORE_UNAVAILABLE",
    })
    await expect(reader("not-an-account", { limit: 20 })).rejects.toMatchObject({
      statusCode: 400,
      code: "INVALID_REQUEST",
    })
  })
})
