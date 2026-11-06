import { expect, test } from "bun:test"
import { ModelPlanStatus } from "../src/model-plan-status"
import { ModelPlanStatus1_99_111 } from "./fixture/model-plan-status-1.99.111"
import { ModelPlanStatus1_99_112 } from "./fixture/model-plan-status-1.99.112"

// H7: Vector 1.99.111 and 1.99.112 are installed and keep reading status and config. Their decoders, frozen as they
// shipped, must decode every answer the current gateway gives (§4.11), and the current lenient decoder must keep the
// fields it knows while dropping what it does not. The bodies here are shape examples; the real status and config
// handlers' answers go through the same frozen decoders in packages/web/test/model-plan-status-api.test.ts.

const released = [
  ["1.99.111", ModelPlanStatus1_99_111],
  ["1.99.112", ModelPlanStatus1_99_112],
] as const

const renewsAt = 1_790_000_000_000
const plan = {
  id: "vector-50",
  name: "Pro",
  left: 0.58,
  renewsAt,
  cancelAtPeriodEnd: false,
  state: "active",
}
const base = { listed: [], purchased: { bought: false }, empty: false, low: false }
// The shapes api/_lib/model-plan-status.ts answers, one per state (§4.11, A18).
const answers: Record<string, Record<string, unknown>> = {
  active: {
    enabled: true,
    active: true,
    customer: true,
    access: true,
    plan: {
      ...plan,
      scheduled: { id: "vector-10", name: "Plus", at: renewsAt },
      today: { used: 0.25, resetsAt: renewsAt - 1_000, reached: false },
      forecastDate: "2026-11-27",
      ramp: { until: renewsAt - 5_000 },
    },
    ...base,
    entitlements: { rank: 2, inFlight: 4, dailyShare: 0.15 },
    meters: { hosted: { used: 0.1 }, brain: { used: 0.02, cap: 0.1 }, remote: { computers: 1, limit: 3 } },
    history: [{ day: "2026-10-29", used: 0.04 }],
    founding: { number: 12 },
    velocity: "coming",
  },
  paused: {
    enabled: true,
    active: true,
    customer: true,
    access: false,
    plan: { ...plan, state: "paused", reason: "payment_failed", action: "update-card" },
    ...base,
  },
  frozen: {
    enabled: true,
    active: true,
    customer: true,
    access: false,
    plan: { ...plan, state: "frozen", reason: "dispute" },
    ...base,
  },
  renewing: {
    enabled: true,
    active: true,
    customer: true,
    access: true,
    plan: { ...plan, state: "renewing" },
    ...base,
  },
  todayReached: {
    enabled: true,
    active: true,
    customer: true,
    access: true,
    plan: { ...plan, today: { used: 1, resetsAt: renewsAt - 1_000, reached: true } },
    ...base,
  },
  noPlan: { enabled: true, active: false, access: false, ...base, empty: true },
  closing: { enabled: true, active: false, customer: true, access: false, ...base, empty: true },
  switchedOff: { enabled: false, active: true, customer: true, access: false, plan, ...base },
  // A later gateway's values this release does not know yet.
  unknownValues: {
    enabled: true,
    active: true,
    customer: true,
    access: true,
    plan: {
      ...plan,
      state: "hibernating",
      reason: "a-new-reason",
      action: "teleport",
      today: { used: 4, resetsAt: renewsAt, reached: false },
      scheduled: { id: "vector-500" },
      forecastDate: "next week",
      ramp: { until: "soon" },
    },
    ...base,
    listed: ["github-agents", "a-new-perk", 7],
    meters: { hosted: { used: 9 }, vault: { usedBytes: 10, quotaBytes: 100 }, teleporter: { used: 0.5 } },
    history: [{ day: "2026-10-29", used: 0.04 }, { day: "yesterday", used: 2 }, "x"],
    founding: { number: -1 },
    velocity: "available",
    labs: "coming",
    entitlements: "all",
  },
}

const config = {
  product: "Vector Codium",
  enabled: true,
  currency: "usd",
  interval: "month",
  catalogUpdated: "2026-10-30",
  models: [{ id: "deepseek/deepseek-v4.1-flash-1017", name: "DeepSeek V4.1 Flash" }],
  plans: [
    { id: "vector-10", name: "Plus", price: 10, available: true, tasks: [[5, 50]] },
    { id: "vector-50", name: "Pro", price: 50, available: true, multiple: 5, tasks: [null] },
  ],
  listed: [],
}

const respond = (body: unknown) => async () => Response.json(body)

test("the released decoders read every current status answer without an error", async () => {
  for (const [version, decoder] of released)
    for (const [name, body] of Object.entries(answers)) {
      const status = await decoder.fetchStatus("vct_token.signature", respond(body))
      expect({ version, name, error: status.error }).toEqual({ version, name, error: undefined })
      expect(status).toMatchObject({ signedIn: true, access: body.access, purchased: { bought: false } })
      expect(decoder.notice(status)?.kind).toBe(
        ModelPlanStatus.notice(ModelPlanStatus.fromRemote(body as never, body))?.kind,
      )
    }
})

test("the released decoders read the current configuration", async () => {
  for (const [, decoder] of released) {
    expect(await decoder.salesOpen(respond(config))).toBe(true)
    expect(await decoder.fetchOffers(respond(config))).toEqual({
      enabled: true,
      plans: [
        { id: "vector-10", name: "Plus", price: 10, available: true },
        { id: "vector-50", name: "Pro", price: 50, available: true },
      ],
      topups: [],
    })
  }
  expect(await ModelPlanStatus.salesOpen(respond(config))).toBe(true)
})

test("the current decoder keeps every field it knows and drops only unknown values", async () => {
  const active = await ModelPlanStatus.fetchStatus("vct_token.signature", respond(answers.active))
  expect(active).toEqual({
    signedIn: true,
    enabled: true,
    access: true,
    customer: true,
    plan: {
      id: "vector-50",
      name: "Pro",
      left: 0.58,
      renewsAt,
      cancelAtPeriodEnd: false,
      state: "active",
      scheduled: { id: "vector-10", name: "Plus", at: renewsAt },
      today: { used: 0.25, resetsAt: renewsAt - 1_000, reached: false },
      forecastDate: "2026-11-27",
      ramp: { until: renewsAt - 5_000 },
    },
    listed: [],
    entitlements: { rank: 2, inFlight: 4, dailyShare: 0.15 },
    meters: { hosted: { used: 0.1 }, brain: { used: 0.02, cap: 0.1 }, remote: { computers: 1, limit: 3 } },
    history: [{ day: "2026-10-29", used: 0.04 }],
    founding: { number: 12 },
    velocity: "coming",
    purchased: { bought: false },
    empty: false,
    low: false,
  })
  const unknown = await ModelPlanStatus.fetchStatus("vct_token.signature", respond(answers.unknownValues))
  expect(unknown.error).toBeUndefined()
  expect(unknown.plan).toEqual({ id: "vector-50", name: "Pro", left: 0.58, renewsAt, cancelAtPeriodEnd: false })
  expect(unknown).toMatchObject({
    listed: ["github-agents"],
    meters: { vault: { usedBytes: 10, quotaBytes: 100 } },
    history: [{ day: "2026-10-29", used: 0.04 }],
    labs: "coming",
  })
  for (const key of ["founding", "velocity", "entitlements"]) expect(unknown).not.toHaveProperty(key)
  expect(unknown.meters).not.toHaveProperty("hosted")
  // An answer without `purchased` (top-ups are gone) still decodes for this release.
  const { purchased: _, ...withoutPurchased } = answers.renewing
  expect(await ModelPlanStatus.fetchStatus("vct_token.signature", respond(withoutPurchased))).toMatchObject({
    plan: { state: "renewing" },
    purchased: { bought: false },
  })
})

test("paused, frozen and switched-off answers read as the notice that explains them", async () => {
  const read = (name: string) => ModelPlanStatus.fetchStatus("vct_token.signature", respond(answers[name]))
  expect(ModelPlanStatus.notice(await read("paused"))).toEqual({
    kind: "empty",
    text: "Your Codium plan is paused until its payment goes through. Update your card to continue.",
  })
  expect(ModelPlanStatus.notice(await read("frozen"))?.text).toBe(
    "Your Codium plan is on hold. Contact Vector support.",
  )
  // Codium off comes with the plan and its share, and says so first.
  const off = await read("switchedOff")
  expect(off.plan?.left).toBe(0.58)
  expect(ModelPlanStatus.describe(off)[0]).toBe("Vector Codium is not available right now.")
  const reached = ModelPlanStatus.describe(await read("todayReached"))
  expect(reached).toContain("Today: 100% of today's limit used")
})
