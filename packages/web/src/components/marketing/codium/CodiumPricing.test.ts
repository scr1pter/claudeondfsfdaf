import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { CodiumCopy } from "@vectordevai/schema/codium-copy"
import { CodiumPlan } from "@vectordevai/schema/codium-plan"
import { ENTITLEMENTS, PERK_IDS, publicEntitlements } from "@vectordevai/schema/codium-entitlements"
import { codiumPricing, refreshCodiumPricing } from "../../../lib/codium-pricing"
import { readModelPlanConfig, type ModelPlanConfig } from "../../../lib/model-plans"
import { CodiumPricing, codiumPlansUrl } from "./CodiumPricing"

const models: NonNullable<ModelPlanConfig["models"]> = [
  {
    id: "lab/basic",
    name: "Basic coder",
    minPlan: "vector-10",
    contextLength: 128_000,
    plans: CodiumPlan.PLANS.map((plan) => plan.id),
    category: "everyday",
  },
  {
    id: "lab/advanced",
    name: "Advanced coder",
    minPlan: "vector-50",
    contextLength: 256_000,
    plans: ["vector-50", "vector-200"],
    contextByPlan: { "vector-50": 256_000, "vector-200": 384_000 },
    category: "advanced",
  },
]
const full: ModelPlanConfig = {
  enabled: true,
  currency: "usd",
  interval: "month",
  product: "Vector Codium",
  listed: [...PERK_IDS],
  models,
  plans: CodiumPlan.PLANS.map((plan) => ({
    ...plan,
    available: true,
    multiple: ENTITLEMENTS[plan.id].usageMultiple,
    caps: publicEntitlements(plan.id, new Set(PERK_IDS)),
    tasks: [
      [10, 100],
      [3, 30],
    ],
  })),
}
const empty: ModelPlanConfig = {
  ...full,
  listed: [],
  models: [],
  enabled: false,
  plans: full.plans.map((plan) => ({ ...plan, available: false })),
}
const render = (config: ModelPlanConfig) =>
  renderToStaticMarkup(createElement(CodiumPricing, { pricing: codiumPricing(config) }))
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
const cards = (html: string) => [...html.matchAll(/<article\b[\s\S]*?<\/article>/g)].map((match) => match[0])

function reply(body: unknown, ok = true) {
  return async () =>
    new Response(JSON.stringify(body), {
      status: ok ? 200 : 503,
      headers: { "content-type": "application/json" },
    })
}

describe("Codium pricing", () => {
  test("renders the four monthly prices, premium styles and a single Recommended badge", () => {
    const html = render(full)
    const plans = cards(html)
    expect(plans).toHaveLength(4)
    for (const [index, plan] of CodiumPlan.PLANS.entries()) {
      expect(plans[index]).toContain(`data-plan="${plan.id}"`)
      expect(plans[index]).toContain(`>${plan.name}</h3>`)
      expect(plans[index]).toContain(`>$${plan.price}</span>`)
      expect(plans[index]).toContain(`Get ${plan.name}`)
      expect(plans[index]!.includes("cx-card--premium")).toBe(index > 0)
    }
    expect(html.match(/Recommended/g)).toHaveLength(1)
    expect(plans[1]).toContain("Recommended")
    expect(html).not.toContain("Most popular")
  })

  test("the empty listing advertises no gated card perks or staged models", () => {
    const html = render(empty)
    for (const card of cards(html)) {
      expect(card).not.toContain(">Headlines<")
      expect(card).not.toMatch(/Brain Vault|Second opinion|Ship Desk|Cloud computer|GitHub agents|Sol Deep|Astra|Terra/)
      expect(card).toContain("Model access is not available yet")
      expect(card).toContain('disabled=""')
      expect(card).toContain("Coming soon")
    }
    expect(html).not.toContain("Vector Labs")
    expect(html).not.toContain("768K")
  })

  test("cards keep tagline, usage, headlines, models, Coming and limits in that order", () => {
    const max = cards(render(full))[2]!
    const positions = ["cx-lead", "cx-usage", ">Headlines<", ">Models<", ">Coming<", ">Limits<", "cx-footnote"].map(
      (needle) => max.indexOf(needle),
    )
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    for (const card of cards(render(full)))
      expect(card).toContain("Coming items are not part of today&#x27;s purchase and have no date")
  })

  test("every cap and multiple reflects entitlements; only accepted model variants are offered", () => {
    const view = codiumPricing(full)
    for (const [index, plan] of CodiumPlan.PLANS.entries()) {
      const caps = ENTITLEMENTS[plan.id]
      const card = text(cards(render(full))[index]!)
      expect(card).toContain(`${caps.inFlight} Codium requests at once`)
      expect(card).toContain(`${caps.perMinute} requests a minute`)
      expect(card).toContain(
        caps.dailyShare === null ? "No daily limit" : `Up to ${caps.dailyShare * 100}% of your month a day`,
      )
      expect(view.monthly[index]!.models.every((model) => model.plans?.includes(plan.id))).toBe(true)
    }
    expect(view.monthly[2]!.models.map((model) => model.id)).toEqual(["lab/basic"])
    expect(view.monthly[2]!.tasks[1]).toBeNull()
    expect(text(cards(render(full))[2]!)).not.toContain("Everything in Pro")
    expect(text(cards(render(full))[3]!)).toContain("Up to 384K context")
    expect(cards(render(full)).slice(0, 2).join("")).not.toContain("trust builds")
    expect(
      cards(render(full))
        .slice(2)
        .every((card) => card.includes("New Max and Ultra")),
    ).toBe(true)
  })

  test("old top-up links and old pack configurations still show only monthly plans", () => {
    const legacy = { ...full, topups: [{ id: "old-pack", name: "Old pack", price: 20, available: true }] }
    const html = render(legacy)
    expect(cards(html)).toHaveLength(4)
    expect(html).not.toMatch(/Plan type|Top-up amount|Old pack|\$20(?:<|\s)|data-mode/)
    expect(codiumPlansUrl("https://vectordev.ai/codium?type=topups&ref=x#faq").href).toBe(
      "https://vectordev.ai/codium?ref=x#faq",
    )
  })

  test("comparison groups keep the free workspace Included at every tier", () => {
    const html = render(full)
    for (const label of [
      "Usage",
      "Headline perks",
      "Models",
      "Typical tasks a month",
      "Limits",
      "Coming",
      "Every plan includes",
      "Included in the free Vector workspace",
    ])
      expect(html).toContain(`<div>${label}</div>`)
    const workspace = html.slice(
      html.indexOf("<div>Included in the free Vector workspace</div>"),
      html.indexOf("</table>"),
    )
    for (const label of CodiumCopy.FREE_WORKSPACE) expect(text(workspace)).toContain(label)
    expect(workspace.match(/>Included<\/span>/g)).toHaveLength(CodiumCopy.FREE_WORKSPACE.length * 4)
    expect(workspace).not.toContain("Not included")
    expect(html).toContain('role="region" aria-labelledby="cx-compare-heading" tabindex="0"')
  })

  test("Velocity remains planned, with no Labs and no unsupported sales promises", () => {
    const html = render(full)
    const plans = cards(html)
    expect(plans.slice(0, 2).join("")).not.toContain("Vector Velocity")
    for (const card of plans.slice(2)) {
      expect(card).toContain("Vector Velocity")
      expect(card).toContain('class="cx-coming-pill">Coming')
      expect(text(card)).toContain("planned 550B+ parameter")
      expect(text(card)).toContain("not part of today's purchase")
    }
    expect(text(html)).not.toMatch(/Vector Labs|exclusive|every PR|every pull request|guaranteed|24\/7|\bSLA\b/i)
  })

  test("printed dollar values are purchase prices, and percentage copy stays in approved forms", () => {
    for (const config of [full, empty]) {
      const visible = text(render(config))
      for (const value of visible.match(/\$\d+(?:[,.]\d+)*/g) ?? [])
        expect(["$10", "$50", "$100", "$200"]).toContain(value)
      const remaining = visible.replace(/Up to \d+% of your month a day/g, "").replace(/\d+% more per dollar/g, "")
      expect(remaining).not.toContain("%")
      expect(visible).not.toMatch(/\d[\d,]* (?:credits|tokens)|inputPrice|outputPrice|markup|margin/)
    }
  })

  test("all eleven FAQ questions start collapsed and are independently labelled", () => {
    const html = render(full)
    const buttons = [...html.matchAll(/id="(cx-faq-q-[^"]+)" aria-expanded="(true|false)" aria-controls="([^"]+)"/g)]
    expect(buttons).toHaveLength(11)
    for (const item of buttons) {
      expect(item[2]).toBe("false")
      expect(html).toContain(`id="${item[3]}"`)
    }
    expect(html).toContain("in your own repo, on your own Actions minutes")
    expect(html).toContain("charged in full")
    expect(html).toContain("A downgrade starts at renewal")
    expect(html).toContain("A failed payment pauses Codium")
  })

  test("runtime refresh replaces a stale listing and keeps the remaining model locks", async () => {
    const refreshed = await refreshCodiumPricing(
      codiumPricing(full),
      reply({
        ...full,
        listed: ["second-opinion"],
        plans: full.plans.map((plan) => ({
          ...plan,
          caps: publicEntitlements(plan.id as CodiumPlan.PlanId, new Set(["second-opinion"])),
        })),
      }),
    )
    expect(refreshed.listed).toEqual(["second-opinion"])
    expect(refreshed.monthly.flatMap((plan) => plan.perks).every((perk) => perk.id === "second-opinion")).toBe(true)
    expect(refreshed.monthly[2]!.models.map((model) => model.id)).toEqual(["lab/basic"])
  })

  test("failed or malformed refresh removes stale perks, models and checkout availability", async () => {
    for (const fetcher of [
      reply({}, false),
      reply({ ...full, listed: ["invented-perk"] }),
      async () => {
        throw new Error("offline")
      },
    ]) {
      const refreshed = await refreshCodiumPricing(codiumPricing(full), fetcher)
      expect(refreshed.listed).toEqual([])
      expect(refreshed.models).toEqual([])
      expect(refreshed.monthly.every((plan) => !plan.available && !plan.perks.length)).toBe(true)
    }
  })

  test("build projection contains no runtime perks and page retains its shared navigation", async () => {
    const source = await Bun.file(new URL("../../../pages/codium.astro", import.meta.url)).text()
    expect(source).toContain("publicCodiumTiers(fetch, { runtime: false })")
    expect(source).toContain("<CodiumPricing client:load")
    expect(source).toContain('<MarketingNav active="codium" />')
    expect(source).toContain("<SiteFooter />")
    expect(source).not.toContain("data-codium-mode")
    const css = await Bun.file(new URL("./codium-pricing.css", import.meta.url)).text()
    expect(css).toContain("color-scheme: dark")
    expect(css).toContain(".cx-card--premium")
    expect(css).toContain(".cx-coming-pill")
    expect(css).not.toContain("data-codium-mode")
  })

  test("public parser drops private financial data before it can reach island props", () => {
    const read = readModelPlanConfig({
      ...full,
      secretAllowance: 123456,
      plans: full.plans.map((plan) => ({ ...plan, credits: 123456 })),
      models: models.map((model) => ({ ...model, inputPrice: 88, outputPrice: 99 })),
    })
    const serialized = JSON.stringify(codiumPricing(read))
    expect(serialized).not.toMatch(/secretAllowance|credits|inputPrice|outputPrice|123456/)
  })
})
