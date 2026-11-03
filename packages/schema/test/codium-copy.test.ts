import { describe, expect, test } from "bun:test"
import { CodiumCopy } from "../src/codium-copy"
import { ENTITLEMENTS, PERK_IDS, publicEntitlements, type PerkId } from "../src/codium-entitlements"
import { CodiumPlan } from "../src/codium-plan"

const all = new Set(PERK_IDS)
const models: CodiumCopy.Model[] = [
  {
    id: "lab/basic",
    name: "Basic",
    minPlan: "vector-10",
    contextLength: 128_000,
    plans: ["vector-10", "vector-50", "vector-100", "vector-200"],
  },
  {
    id: "lab/pro",
    name: "Pro model",
    minPlan: "vector-50",
    contextLength: 256_000,
    plans: ["vector-50", "vector-200"],
    contextByPlan: { "vector-50": 256_000, "vector-200": 384_000 },
  },
]

describe("Codium copy follows the server listing", () => {
  test("empty listing has no perk promises, no staged model names and safe taglines", () => {
    for (const plan of CodiumPlan.PLANS) {
      const view = CodiumCopy.tierView(plan.id, new Set(), [])
      expect(view.headlines).toEqual([])
      expect(view.perks).toEqual([])
      expect(view.models).toEqual([])
      expect(view.tagline).not.toMatch(/second lab|phone|Brain|Vault|computer|agent time|priority|Sol|Auto/i)
      expect(view.limits.join(" ")).not.toContain("context")
    }
  })

  test("every relevant listing subset chooses a tagline whose dependencies are listed", () => {
    // Other perk IDs cannot affect this tier's tagline; exhaust its complete dependency truth table.
    for (const plan of CodiumPlan.PLANS) {
      const dependencies = [...new Set(CodiumCopy.TAGLINES[plan.id].flatMap((entry) => entry.requires))]
      for (let mask = 0; mask < 2 ** dependencies.length; mask++) {
        const listed = new Set(dependencies.filter((_, index) => mask & (1 << index)))
        const view = CodiumCopy.tierView(plan.id, listed, models)
        expect(view.taglineRequires.every((perk) => listed.has(perk))).toBe(true)
        for (const irrelevant of PERK_IDS.filter((id) => !dependencies.includes(id)))
          expect(CodiumCopy.tierView(plan.id, new Set([...listed, irrelevant]), models).tagline).toBe(view.tagline)
      }
    }
  })

  test("a dependent perk cannot appear without its listed prerequisite", () => {
    for (const [perk, prerequisites] of Object.entries(CodiumCopy.requires)) {
      const listed = new Set<PerkId>([perk as PerkId])
      expect(CodiumCopy.tierView("vector-200", listed, models).perks.some((item) => item.id === perk)).toBe(false)
      for (const prerequisite of prerequisites) listed.add(prerequisite)
      expect(CodiumCopy.tierView("vector-200", listed, models).perks.some((item) => item.id === perk)).toBe(true)
    }
  })

  test("listed panels remain available on Plus and Pro; model access is the gate", () => {
    for (const plan of ["vector-10", "vector-50"] as const)
      expect(CodiumCopy.tierView(plan, new Set(["review-panel"]), models).perks.map((item) => item.id)).toContain(
        "review-panel",
      )
    expect(CodiumCopy.FREE_WORKSPACE.join(" ")).toContain("three-lab panel")
  })

  test("caps and usage multiples come from canonical entitlements", () => {
    for (const plan of CodiumPlan.PLANS) {
      const caps = ENTITLEMENTS[plan.id]
      const view = CodiumCopy.tierView(plan.id, all, models)
      expect(view.caps).toEqual(publicEntitlements(plan.id, new Set(view.perks.map((perk) => perk.id))))
      expect(view.limits[0]).toBe(`${caps.inFlight} Codium requests at once`)
      expect(view.limits[1]).toBe(`${caps.perMinute} requests a minute`)
      expect(view.limits[2]).toBe(
        caps.dailyShare === null ? "No daily limit" : `Up to ${caps.dailyShare * 100}% of your month a day`,
      )
      if (caps.rank > 1) expect(view.usage).toContain(`${caps.usageMultiple}x Plus's usage`)
    }
    expect(CodiumCopy.tierView("vector-50", all, models).usage).toContain("10% more per dollar")
    expect(CodiumCopy.tierView("vector-100", all, models).usage).toContain("20% more per dollar")
    expect(CodiumCopy.tierView("vector-200", all, models).usage).toContain("25% more per dollar")
  })

  test("effective plan membership wins over the minimum tier and never invents a larger context", () => {
    const max = CodiumCopy.tierView("vector-100", all, models)
    expect(max.models.map((model) => model.id)).toEqual(["lab/basic"])
    expect(max.modelLead).toBeUndefined()
    expect(max.limits).toContain("Up to 128K context on available models")
    expect(CodiumCopy.tierView("vector-200", all, models).limits).toContain("Up to 384K context on available models")
    expect(CodiumCopy.modelAvailable({ id: "legacy/model", name: "Legacy", minPlan: "vector-50" }, "vector-10")).toBe(
      false,
    )
  })

  test("Velocity is planned 550B+ only on Max and Ultra; no Labs product is introduced", () => {
    const coming = CodiumPlan.PLANS.map((plan) => CodiumCopy.tierView(plan.id, all, models).coming)
    expect(coming.map((items) => items.length)).toEqual([0, 0, 1, 1])
    expect(CodiumCopy.COMING.velocity.label).toBe("Coming")
    expect(CodiumCopy.COMING.velocity.text).toContain("planned 550B+")
    expect(CodiumCopy.COMING.velocity.text).toContain("not part of today's purchase")
    expect(CodiumCopy.COMING.velocity.text).not.toMatch(
      /available|included|free|guaranteed|soon|built on|based on|202\d|quarter/i,
    )
    expect(JSON.stringify(coming)).not.toContain("Labs")
  })

  test("GitHub agent and Vector computer copy clearly separate where work runs", () => {
    const caps = ENTITLEMENTS["vector-200"]
    for (const id of ["github-agents", "github-no-secret", "scheduled", "reviews", "brain-cloud"] as const) {
      expect(CodiumCopy.PERK_COPY[id].text(caps)).toContain("in your own repo, on your own Actions minutes")
      expect(CodiumCopy.PERK_COPY[id].text(caps)).not.toMatch(/hosted|compute|cloud hours|cloud capacity|our cloud/i)
    }
    for (const id of ["computer", "overnight"] as const) {
      expect(CodiumCopy.PERK_COPY[id].text(caps)).toContain(CodiumCopy.COMPUTER_LABEL)
      expect(CodiumCopy.PERK_COPY[id].text(caps)).not.toMatch(/GitHub|Actions/)
    }
  })
})
