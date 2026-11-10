import { describe, expect, test } from "bun:test"
import { CodiumEntitlements } from "../src/codium-entitlements"
import type { EntitlementSnapshot, Entitlements, PerkId } from "../src/codium-entitlements"
import { CodiumPlan, type PlanId } from "../src/codium-plan"
import { CodiumRunTrigger, type RunTrigger } from "../src/codium-run-trigger"

const { ENTITLEMENTS, PERK_IDS, publicEntitlements } = CodiumEntitlements
const ids = CodiumPlan.PLANS.map((plan) => plan.id)
const tiers = ids.map((id) => ENTITLEMENTS[id])
const banned = /usd|price|credit|cost|\$/i

// Every leaf of a value, by dotted path. A null object (no cloud computer on Plus) is one leaf.
function leaves(value: unknown, prefix = ""): [string, unknown][] {
  if (value && typeof value === "object" && !Array.isArray(value))
    return Object.entries(value).flatMap(([key, item]) => leaves(item, prefix ? `${prefix}.${key}` : key))
  return [[prefix, value]]
}
function at(value: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (item, key) => (item && typeof item === "object" ? (item as Record<string, unknown>)[key] : undefined),
      value,
    )
}
function keys(value: unknown): string[] {
  if (!value || typeof value !== "object") return []
  return Object.entries(value).flatMap(([key, item]) => [key, ...keys(item)])
}

describe("plans", () => {
  test("rank orders Plus, Pro, Max and Ultra, and an id Vector does not sell ranks below every plan", () => {
    expect(ids.map((id) => CodiumPlan.rank(id))).toEqual([1, 2, 3, 4])
    for (const id of ids) expect(ENTITLEMENTS[id].rank).toBe(CodiumPlan.rank(id))
    for (const id of ["vector-20", "codium-topup-10", "", "VECTOR-10"]) expect(CodiumPlan.rank(id)).toBe(0)
    expect(ids.every((id) => CodiumPlan.isPlanId(id))).toBe(true)
    for (const id of ["vector-20", "codium-topup-50", undefined, 10, null]) expect(CodiumPlan.isPlanId(id)).toBe(false)
  })

  test("there are no top-ups, and a name is looked up among the plans only", () => {
    expect(CodiumPlan.TOPUPS).toEqual([])
    expect(CodiumPlan.name("vector-200")).toBe("Ultra")
    expect(CodiumPlan.name("codium-topup-50")).toBeUndefined()
  })
})

describe("entitlements", () => {
  test("every plan has the caps the contract sets", () => {
    expect(Object.keys(ENTITLEMENTS).sort()).toEqual([...ids].sort())
    const row = (pick: (caps: Entitlements) => unknown) => tiers.map(pick)
    expect(row((caps) => caps.usageMultiple)).toEqual([1, 5.5, 12, 25])
    expect(row((caps) => caps.inFlight)).toEqual([3, 6, 12, 24])
    expect(row((caps) => caps.perMinute)).toEqual([30, 60, 120, 200])
    expect(row((caps) => caps.dailyShare)).toEqual([0.25, 0.25, 0.4, null])
    expect(row((caps) => caps.contextMax)).toEqual([262_144, 262_144, 512_000, 768_000])
    expect(row((caps) => [caps.priority, caps.fastLanes, caps.previewModels])).toEqual([
      [false, false, false],
      [false, false, false],
      [true, true, false],
      [true, true, true],
    ])
    expect(row((caps) => caps.purposeShare)).toEqual(Array(4).fill({ brain: 0.1 }))
    expect(row((caps) => caps.cloudAgents)).toEqual([
      { atOnce: 1, hours: 5, longestRunMin: 30, scheduledPerDay: 0, runCeilingShare: 0.1 },
      { atOnce: 1, hours: 15, longestRunMin: 45, scheduledPerDay: 0, runCeilingShare: 0.1 },
      { atOnce: 2, hours: 40, longestRunMin: 45, scheduledPerDay: 5, runCeilingShare: 0.1 },
      { atOnce: 6, hours: 120, longestRunMin: 120, scheduledPerDay: 20, runCeilingShare: 0.1 },
    ])
    expect(row((caps) => caps.remote.computers)).toEqual([1, 3, 5, 5])
    expect(row((caps) => caps.vault)).toEqual([
      { gb: 0, versionDays: 30 },
      { gb: 10, versionDays: 30 },
      { gb: 25, versionDays: 30 },
      { gb: 50, versionDays: 30 },
    ])
    expect(row((caps) => caps.hosted)).toEqual([
      null,
      null,
      { computers: 1, hours: 20, jobMin: 240, diskDays: 7, sizes: ["standard"] },
      { computers: 3, hours: 60, jobMin: 720, diskDays: 30, sizes: ["standard", "large"] },
    ])
    expect(row((caps) => caps.overnight)).toEqual([
      null,
      null,
      { perNight: 3, atOnce: 1, recurringPerDay: 5 },
      { perNight: 10, atOnce: 3, recurringPerDay: 20 },
    ])
    expect(row((caps) => caps.ops)).toEqual([
      null,
      null,
      {
        onCall: { urls: 5, intervalSec: 300, domains: 3, fixRunsPerDay: 3 },
        releaseGuard: { perDay: 10, watchMin: 30, paths: 5 },
        shipDesk: { cardsPerMonth: 100, keepDays: 30, images: 8 },
      },
      {
        onCall: { urls: 10, intervalSec: 60, domains: 10, fixRunsPerDay: 10 },
        releaseGuard: { perDay: 30, watchMin: 60, paths: 5 },
        shipDesk: { cardsPerMonth: 400, keepDays: 90, images: 8 },
      },
    ])
    expect(row((caps) => [caps.secondOpinion, caps.playbooks, caps.vote, caps.nominate])).toEqual([
      [false, false, false, false],
      [true, true, false, false],
      [true, true, true, false],
      [true, true, true, true],
    ])
    expect(row((caps) => caps.reports)).toEqual([
      { tag: "plus", perHour: 15, readFirst: false },
      { tag: "pro", perHour: 15, readFirst: false },
      { tag: "max", perHour: 30, readFirst: true },
      { tag: "ultra", perHour: 30, readFirst: true },
    ])
    expect(row((caps) => caps.foundingBoost)).toEqual([1.1, 1.1, null, null])
    expect(row((caps) => [caps.velocity, caps.labs])).toEqual([
      [null, null],
      [null, null],
      ["coming", null],
      ["coming", "coming"],
    ])
  })

  test("a higher plan never has less: every cap and flag is non-decreasing from Plus to Ultra", () => {
    const paths = [
      ...new Set(
        tiers.flatMap((caps) =>
          leaves(caps)
            .filter(([, value]) => typeof value === "number" || typeof value === "boolean" || Array.isArray(value))
            .map(([path]) => path),
        ),
      ),
    ]
    // The founding boost is for Plus and Pro only, and is checked on its own below.
    const checked = paths.filter((path) => path !== "foundingBoost")
    // The scan has to reach the nested caps, or a pass would mean nothing.
    expect(checked).toContain("ops.shipDesk.cardsPerMonth")
    expect(checked).toContain("hosted.sizes")
    for (const path of checked) {
      const order = tiers.map((caps) => {
        const value = at(caps, path)
        // A plan without the perk (null, or a field inside a null perk) has the least; no daily limit is the most.
        if (value === null || value === undefined) return path === "dailyShare" ? Infinity : -Infinity
        if (typeof value === "boolean") return value ? 1 : 0
        if (Array.isArray(value)) return value.length
        // On Call checks more often on a higher plan: a shorter interval is more.
        return path === "ops.onCall.intervalSec" ? -(value as number) : (value as number)
      })
      for (let index = 1; index < order.length; index++)
        expect({ path, higher: order[index]! >= order[index - 1]! }).toEqual({ path, higher: true })
    }
    // A larger cloud computer never replaces the standard one.
    for (const caps of tiers) if (caps.hosted) expect(caps.hosted.sizes[0]).toBe("standard")
  })

  test("caps hold counts, hours, shares and flags only, never money", () => {
    const found = tiers.flatMap((caps) => keys(caps)).filter((key) => banned.test(key))
    expect(found).toEqual([])
    for (const caps of tiers)
      for (const [path, value] of leaves(caps)) {
        expect({
          path,
          ok: value === null || ["number", "boolean", "string"].includes(typeof value) || Array.isArray(value),
        }).toEqual({ path, ok: true })
        if (typeof value === "string") expect(value).not.toMatch(banned)
      }
    // Every share is a share of the month.
    for (const caps of tiers)
      for (const share of [caps.dailyShare, caps.purposeShare.brain, caps.cloudAgents.runCeilingShare])
        if (share !== null) expect(share > 0 && share <= 1).toBe(true)
  })

  test("the module source carries no dollar figure", async () => {
    for (const file of ["codium-entitlements.ts", "codium-run-trigger.ts"]) {
      const source = await Bun.file(new URL(`../src/${file}`, import.meta.url)).text()
      expect(source).not.toMatch(/\$\s?\d|\busd\b/i)
    }
  })

  test("each plan has the perks the tier table gives it, and no others", () => {
    for (const [index, caps] of tiers.entries()) {
      const plan = ids[index]!
      const high = plan === "vector-100" || plan === "vector-200"
      expect(caps.cloudAgents.atOnce).toBeGreaterThanOrEqual(1)
      if (!high) expect(caps.cloudAgents.scheduledPerDay).toBe(0)
      expect(caps.ops !== null).toBe(high)
      expect(caps.hosted !== null).toBe(high)
      expect(caps.overnight !== null).toBe(high)
      expect(caps.foundingBoost !== null).toBe(!high)
      expect(caps.velocity === "coming").toBe(high)
      expect(caps.velocity === "coming" || caps.velocity === null).toBe(true)
      expect(caps.labs === "coming").toBe(plan === "vector-200")
      expect(caps.labs === "coming" || caps.labs === null).toBe(true)
      // One run's ceiling never exceeds the daily limit.
      if (caps.dailyShare !== null) expect(caps.cloudAgents.runCeilingShare).toBeLessThanOrEqual(caps.dailyShare)
    }
  })

  test("the caps cannot be changed at run time", () => {
    const caps = ENTITLEMENTS["vector-100"] as { inFlight: number; hosted: { hours: number } }
    expect(Object.isFrozen(ENTITLEMENTS)).toBe(true)
    expect(() => {
      caps.inFlight = 99
    }).toThrow()
    expect(() => {
      caps.hosted.hours = 99
    }).toThrow()
    expect(() => (ENTITLEMENTS["vector-200"].hosted!.sizes as string[]).push("huge")).toThrow()
    expect(ENTITLEMENTS["vector-100"].inFlight).toBe(12)
  })
})

describe("publicEntitlements", () => {
  const all = new Set<PerkId>(PERK_IDS)
  const none = new Set<PerkId>()
  const always = [
    "rank",
    "usageMultiple",
    "inFlight",
    "perMinute",
    "dailyShare",
    "contextMax",
    "fastLanes",
    "reports",
    "velocity",
    "labs",
  ]

  test("with nothing listed, only the model caps, report tags and the Coming items show", () => {
    for (const id of ids) {
      const view = publicEntitlements(id, none)
      expect(Object.keys(view).sort()).toEqual([...always].sort())
      expect(view.reports?.readFirst).toBe(false)
      expect(view.velocity).toBe(ENTITLEMENTS[id].velocity)
      expect(view.labs).toBe(ENTITLEMENTS[id].labs)
    }
  })

  test("with every perk listed, it is the plan's caps without the dormant preview flag", () => {
    for (const id of ids) {
      const { previewModels: _, ...caps } = ENTITLEMENTS[id]
      expect(publicEntitlements(id, all)).toEqual(caps)
    }
  })

  test("a perk's numbers show only while it is listed", () => {
    const only = (...perks: PerkId[]) => new Set<PerkId>(perks)
    const fields: [PerkId, (keyof Entitlements)[]][] = [
      ["priority", ["priority"]],
      ["brain", ["purposeShare"]],
      ["github-agents", ["cloudAgents"]],
      ["remote", ["remote"]],
      ["vault", ["vault"]],
      ["computer", ["hosted"]],
      ["overnight", ["overnight"]],
      ["second-opinion", ["secondOpinion"]],
      ["playbooks", ["playbooks"]],
      ["vote", ["vote", "nominate"]],
      ["founding", ["foundingBoost"]],
      ["on-call", ["ops"]],
      ["release-guard", ["ops"]],
      ["ship-desk", ["ops"]],
    ]
    for (const id of ids)
      for (const [perk, names] of fields) {
        const view = publicEntitlements(id, only(perk))
        expect(Object.keys(view).sort()).toEqual([...always, ...names].sort())
        for (const name of names)
          if (name !== "ops" && name !== "cloudAgents") expect(view[name]).toEqual(ENTITLEMENTS[id][name])
      }

    // Scheduled runs sit inside the cloud-agent caps and read 0 until they are listed.
    expect(publicEntitlements("vector-200", only("github-agents")).cloudAgents).toEqual({
      ...ENTITLEMENTS["vector-200"].cloudAgents,
      scheduledPerDay: 0,
    })
    expect(publicEntitlements("vector-200", only("github-agents", "scheduled")).cloudAgents).toEqual(
      ENTITLEMENTS["vector-200"].cloudAgents,
    )
    expect(publicEntitlements("vector-200", only("scheduled")).cloudAgents).toBeUndefined()

    // The three ops perks share one object; an unlisted one reads as none.
    expect(publicEntitlements("vector-100", only("release-guard")).ops).toEqual({
      onCall: { urls: 0, intervalSec: 0, domains: 0, fixRunsPerDay: 0 },
      releaseGuard: ENTITLEMENTS["vector-100"].ops!.releaseGuard,
      shipDesk: { cardsPerMonth: 0, keepDays: 0, images: 0 },
    })
    expect(publicEntitlements("vector-10", only("on-call", "release-guard", "ship-desk")).ops).toBeNull()

    // Read first is a perk of its own; the tag and the hourly limit always show.
    expect(publicEntitlements("vector-100", only("reports-first")).reports).toEqual(ENTITLEMENTS["vector-100"].reports)
    expect(publicEntitlements("vector-100", none).reports).toEqual({ tag: "max", perHour: 30, readFirst: false })

    // A plan without the perk says so once the perk is listed.
    expect(publicEntitlements("vector-50", only("computer")).hosted).toBeNull()
  })

  test("the answer is a copy that carries no money", () => {
    const view = publicEntitlements("vector-200", all) as unknown as {
      hosted: { sizes: string[] }
      reports: { perHour: number }
    }
    view.hosted.sizes.push("huge")
    view.reports.perHour = 99
    expect(ENTITLEMENTS["vector-200"].hosted!.sizes).toEqual(["standard", "large"])
    expect(ENTITLEMENTS["vector-200"].reports.perHour).toBe(30)
    for (const id of ids) expect(keys(publicEntitlements(id, all)).filter((key) => banned.test(key))).toEqual([])
    expect(publicEntitlements("vector-20" as PlanId, all)).toEqual({})
  })
})

describe("snapshot and run-trigger contracts", () => {
  test("the snapshot names no money", () => {
    // Every field present, so the scan covers the whole type; the compiler rejects a field the type does not have.
    const snapshot: Required<EntitlementSnapshot> = {
      v: 1,
      version: 3,
      livemode: false,
      account: "acct",
      state: "active",
      reason: "owner",
      plan: "vector-100",
      subscription: "sub_1",
      periodStart: 1,
      periodEnd: 2,
      meterEpoch: "sub_1:1",
      cancelAtPeriodEnd: false,
      scheduled: { plan: "vector-50", at: 2 },
      founding: { number: 7, boost: false },
      firstPaidAt: 1,
      firstHighPaidAt: 1,
      memberSince: 1,
      ramp: { hostedUntil: 1, poolUntil: 1, browserFrom: 1 },
      revokedBefore: 1,
      caps: ENTITLEMENTS["vector-100"],
      updatedAt: 1,
      checkedAt: 1,
      source: "webhook",
    }
    expect(keys(snapshot).filter((key) => banned.test(key))).toEqual([])
    expect(CodiumEntitlements.PLAN_STATES).toEqual(["none", "active", "renewing", "paused", "ended", "frozen"])
    expect(CodiumEntitlements.PLAN_REASONS).toHaveLength(9)
  })

  test("runs start from every source except the reserved Slack, Linear and Jira", () => {
    const reserved = ["slack", "linear", "jira"] as const
    for (const source of reserved) expect(CodiumRunTrigger.ENABLED_SOURCES.has(source)).toBe(false)
    expect([...CodiumRunTrigger.ENABLED_SOURCES]).toEqual(
      CodiumRunTrigger.RUN_SOURCES.filter((source) => !(reserved as readonly string[]).includes(source)),
    )
    expect(CodiumRunTrigger.ENABLED_SOURCES.size).toBe(8)
    const trigger: Required<RunTrigger> = {
      source: "github-comment",
      account: "acct",
      requestedBy: { platform: "github", userId: "1" },
      target: { kind: "github-run", repositoryId: 1, branch: "main" },
      prompt: "fix the failing test",
      criteria: ["tests pass"],
      deliverBy: 1,
      purpose: "task",
    }
    expect(keys(trigger).filter((key) => banned.test(key))).toEqual([])
  })
})
