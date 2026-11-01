import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { publicModelPlans } from "../../../../../../api/_lib/model-plan-config"
import { codiumPricing } from "../../../lib/codium-pricing"
import { readModelPlanConfig, type ModelPlanConfig } from "../../../lib/model-plans"
import { CodiumPlan } from "@vectordevai/schema/codium-plan"
import { CodiumPricing, CodiumQuestions, codiumMode, codiumModeUrl, type CodiumMode } from "./CodiumPricing"

const config: ModelPlanConfig = {
  enabled: true,
  currency: "usd",
  interval: "month",
  product: "Vector Codium",
  plans: [
    { id: "vector-10", name: "Plus", price: 10, available: true, tasks: [[60, 550], null] },
    { id: "vector-50", name: "Pro", price: 50, available: true, multiple: 5, tasks: [[300, 2700], null] },
  ],
  models: [
    {
      id: "deepseek/deepseek-v4.1-flash-1017",
      name: "Everyday Coder",
      category: "everyday",
      description: "Routine edits.",
    },
    { id: "vendor/unreviewed", name: "Hard Coder", category: "advanced" },
  ],
}
// The deployed configuration contains only precomputed coarse estimates.
const live = readModelPlanConfig(publicModelPlans())
// The deployed configuration with sales switched on, as it will be at launch.
const selling: ModelPlanConfig = {
  ...live,
  enabled: true,
  plans: live.plans.map((plan) => ({ ...plan, available: true })),
}
const closed = (value: ModelPlanConfig): ModelPlanConfig => ({
  ...value,
  enabled: false,
  plans: value.plans.map((plan) => ({ ...plan, available: false })),
})

const render = (value: ModelPlanConfig, mode?: CodiumMode) =>
  renderToStaticMarkup(createElement(CodiumPricing, { pricing: codiumPricing(value), mode }))
const questions = (value: ModelPlanConfig) =>
  renderToStaticMarkup(createElement(CodiumQuestions, { models: codiumPricing(value).models }))
// One part of the island's markup: a tab's panel, or the comparison table.
const part = (html: string, name: "monthly" | "compare") => {
  const starts = {
    monthly: html.indexOf('<div class="cx-panel" data-mode="monthly">'),
    compare: html.indexOf('<section class="cx-compare"'),
  }
  const ends = { monthly: html.indexOf('<p class="cx-note'), compare: html.length }
  return html.slice(starts[name], ends[name])
}
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
const cards = (html: string) => html.split('<article class="cx-card">').slice(1)
const page = () => Bun.file(new URL("../../../pages/codium.astro", import.meta.url)).text()

describe("Codium pricing page", () => {
  test("monthly plans render before hydration without a top-up tab", async () => {
    const html = render(selling)
    expect(cards(part(html, "monthly"))).toHaveLength(4)
    expect(html).not.toContain('data-mode="topup"')
    expect(html).not.toContain('aria-label="Plan type"')
    const source = await page()
    expect(source.indexOf("document.documentElement.dataset.codiumMode")).toBeLessThan(
      source.indexOf('<div class="cx-page">'),
    )
    expect(source).toContain("<CodiumPricing client:load")
    expect(source).toContain("<CodiumQuestions client:load")
    expect(source).toContain("topupsAvailable && new URLSearchParams")
    expect(source).not.toContain("plans and top-ups")
  })

  test("offers the four monthly plans by name, Plus, Pro, Max and Ultra, with no free card, and highlights Pro", () => {
    const monthly = part(render(selling), "monthly")
    expect(live.plans.map((plan) => [plan.id, plan.name, plan.price])).toEqual([
      ["vector-10", "Plus", 10],
      ["vector-50", "Pro", 50],
      ["vector-100", "Max", 100],
      ["vector-200", "Ultra", 200],
    ])
    // The server configuration takes its names from the module the app reads too.
    expect(live.plans.map((plan) => plan.name)).toEqual(CodiumPlan.PLANS.map((plan) => plan.name))
    const plans = cards(monthly)
    expect(plans).toHaveLength(4)
    for (const [index, plan] of live.plans.entries()) {
      expect(plans[index]).toContain(`<h3 class="cx-type-md">${plan.name}</h3>`)
      expect(plans[index]).toContain(
        `<span class="cx-amount cx-type-lg">$${plan.price}</span><span class="cx-per">/month</span>`,
      )
      expect(plans[index]).toContain(`>Get ${plan.name}</button>`)
    }
    // One plan carries the badge and the light button; the others use the dark one.
    expect(monthly.match(/Most popular/g)).toHaveLength(1)
    expect(plans[1]).toContain('<span class="cx-badge cx-type-xs">Most popular</span>')
    expect(plans[1]).toContain('<button class="cx-btn" type="button">Get Pro</button>')
    for (const index of [0, 2, 3]) expect(plans[index]).toContain('class="cx-btn cx-btn--secondary"')
    expect(monthly).not.toContain(">Free<")
    expect(monthly).not.toContain("$0")
    expect(monthly).not.toMatch(/Codium \d/)
  })

  test("every plan card states its typical tasks for each model, and later plans state their usage as a multiple", () => {
    const pricing = codiumPricing(live)
    const plans = cards(part(render(live), "monthly")).map(text)
    expect(plans[0]).toContain(
      "Get started with: Codium credits for every Codium model, every month Typical tasks a month " +
        "DeepSeek V4.1 Flash 1017: 50–500 Claude Haiku 5.5: 30–300 GPT-6 Luna: 60–600 Kimi K3.1 Pro: 5–50 Gemini 4 Argon: 5–50",
    )
    // On phones the comparison table is hidden, so each card carries its own ranges.
    for (const [index, offer] of pricing.monthly.entries())
      for (const [row, model] of pricing.models.entries()) {
        const tasks = offer.tasks[row]!
        expect(plans[index]).toContain(
          `${model.name}: ${tasks.map((value) => value.toLocaleString("en-US")).join("–")}`,
        )
      }
    for (const [index, multiple] of [5, 10, 20].entries())
      expect(plans[index + 1]).toContain(
        `Everything in ${["Plus", "Pro", "Max"][index]}, and: ${multiple}x more usage than Plus`,
      )
    expect(plans[3]).toContain(
      "DeepSeek V4.1 Flash 1017: 1,000–10,000 Claude Haiku 5.5: 600–6,000 GPT-6 Luna: 1,200–12,000 Kimi K3.1 Pro: 100–1,000 Gemini 4 Argon: 100–1,000",
    )
    // What all plans share is labelled as shared, so it never reads as something only that plan adds.
    expect(plans[1]).toContain(
      "Every plan includes Zero-data-retention endpoints No provider keys needed Works in the desktop app and CLI",
    )
    expect(plans[2]).toContain("In the free Vector workspace Parallel agents Subagents Vectorscope code reviews")
    expect(plans[0]).not.toContain("Every plan includes")
    // A model without a reviewed range gets no line.
    const sample = cards(part(render(config), "monthly")).map(text)
    expect(sample[1]).toContain("Everyday Coder: 300–2,700")
    expect(sample[1]).not.toContain("Hard Coder:")
  })

  test("monthly-only configurations do not offer packs, including visits from old top-up links", () => {
    expect(live.topups).toBeUndefined()
    for (const value of [config, live, selling]) {
      for (const mode of ["monthly", "topup"] as const) {
        const html = render(value, mode)
        expect(cards(part(html, "monthly"))).toHaveLength(value.plans.length)
        for (const offer of [
          'data-mode="topup"',
          'aria-label="Plan type"',
          'aria-label="Top-up amount"',
          "credit top-up",
        ])
          expect(html).not.toContain(offer)
      }
    }
  })

  test("the tab is kept in the address, so links, reloads and history restore it", () => {
    expect(codiumMode("")).toBe("monthly")
    expect(codiumMode("?type=topups")).toBe("topup")
    expect(codiumMode("?type=team&ref=x")).toBe("monthly")
    expect(codiumModeUrl("https://vectordev.ai/codium", "topup").href).toBe("https://vectordev.ai/codium?type=topups")
    expect(codiumModeUrl("https://vectordev.ai/codium?type=topups&ref=x#faq", "monthly").href).toBe(
      "https://vectordev.ai/codium?ref=x#faq",
    )
    expect(codiumMode(codiumModeUrl("https://vectordev.ai/codium?ref=x", "topup").search)).toBe("topup")
  })

  test("renewal terms sit in every plan card and in the note under the cards", async () => {
    const html = render(config)
    for (const plan of cards(part(html, "monthly"))) expect(plan).toContain("*Renews monthly until you cancel.")
    const note = text(html.slice(html.indexOf('<p class="cx-note')))
    expect(note).toContain("Plans renew monthly at the listed price until you cancel")
    expect(note).toContain("monthly credits reset each billing period")
    expect(note).not.toContain("top-up credits")
    expect(note).toContain("Any applicable taxes are shown before payment")
    expect(html).toContain('<a href="/legal/terms#codium">Codium terms</a>')
    expect(html.indexOf('<p class="cx-note')).toBeGreaterThan(html.lastIndexOf("<article"))
    const terms = await Bun.file(new URL("../../../pages/legal/terms.astro", import.meta.url)).text()
    expect(terms).toContain("renew automatically at the")
    expect(terms).toContain("Any applicable")
  })

  test("the comparison table has a column per plan and rows for usage, models, typical tasks and the workspace", () => {
    const table = part(render(live), "compare")
    expect(table).toContain('<h2 class="cx-type-lg" id="cx-compare-heading">Compare features across plans</h2>')
    const columns = [...table.matchAll(/<th scope="col">(.*?)<\/th>/g)].map((match) => text(match[1]!).trim())
    expect(columns).toEqual([
      "Feature",
      "Plus $10 /month Coming soon",
      "Pro $50 /month Coming soon",
      "Max $100 /month Coming soon",
      "Ultra $200 /month Coming soon",
    ])
    const groups = [...table.matchAll(/<th class="cx-compare-group"[^>]*><div>.*?<\/svg>(.*?)<\/div>/g)].map(
      (match) => match[1],
    )
    expect(groups).toEqual(["Models", "Typical tasks a month", "Credits", "Included in the free Vector workspace"])
    // Each group is its own row group, headed by a row group header, after the usage row's own body.
    expect(table.match(/<tbody /g)).toHaveLength(groups.length + 1)
    expect(table.match(/<th class="cx-compare-group" colSpan="5" scope="rowgroup">/g)).toHaveLength(groups.length)
    // Below 1140px the table scrolls sideways inside a region that keyboard users can focus.
    expect(table).toContain(
      '<div class="cx-compare-scroll" role="region" aria-labelledby="cx-compare-heading" tabindex="0">',
    )
    const rows = new Map(
      [...table.matchAll(/<tr><th scope="row">(.*?)<\/th>(.*?)<\/tr>/g)].map((match) => [
        match[1]!,
        [...match[2]!.matchAll(/<td>(.*?)<\/td>/g)].map((cell) => text(cell[1]!).trim()),
      ]),
    )
    expect(rows.get("Usage")).toEqual(["Base", "5x Plus", "10x Plus", "20x Plus"])
    expect(rows.get("DeepSeek V4.1 Flash 1017 (default)")).toEqual(Array(4).fill("Included"))
    expect(rows.get("Claude Haiku 5.5")).toEqual(["30–300", "150–1,500", "300–3,000", "600–6,000"])
    for (const feature of [
      "Parallel agents",
      "Vectorscope code reviews",
      "Vector Cloud",
      "Any provider with your own key",
    ])
      expect(rows.get(feature)).toEqual(Array(4).fill("Included"))
    expect(rows.get("Monthly plans only")).toEqual(Array(4).fill("Included"))
    expect(rows.has("Top-ups when credits run low")).toBe(false)
    // A model without a reviewed range shows a dash for every plan.
    const sample = part(render(config), "compare")
    expect(sample).toContain('<tr><th scope="row">Hard Coder</th><td><span class="cx-mark cx-mark--no cx-type-md">—')
  })

  test("the launch catalog publishes coarse estimates without private assumptions", () => {
    expect(codiumPricing(live).monthly.every((offer) => offer.tasks.every((tasks) => tasks !== null))).toBe(true)
    expect(codiumPricing(live).models.map((model) => model.name)).toEqual([
      "DeepSeek V4.1 Flash 1017",
      "Claude Haiku 5.5",
      "GPT-6 Luna",
      "Kimi K3.1 Pro",
      "Gemini 4 Argon",
    ])
    expect(codiumPricing(live).models.find((model) => model.category === "advanced")?.description).toContain(
      "Uses credits faster than the everyday models",
    )
  })

  test("never exposes credit amounts, model prices or the markup, in the page or its island props", () => {
    for (const value of [config, live, selling]) {
      const pricing = codiumPricing(value)
      for (const offer of [...pricing.monthly, ...pricing.topups])
        expect(Object.keys(offer).sort()).toEqual(["available", "id", "multiple", "name", "price", "tasks"])
      for (const model of pricing.models)
        expect(Object.keys(model).every((key) => ["id", "name", "category", "description"].includes(key))).toBe(true)
      const props = JSON.stringify(pricing)
      for (const key of ["credits", "inputPrice", "outputPrice", "contextLength"])
        expect(props).not.toContain(`"${key}"`)
      for (const mode of ["monthly", "topup"] as const) {
        const html = render(value, mode) + questions(value)
        for (const word of ["markup", "margin", "per million", "M tokens", "%"]) expect(html).not.toContain(word)
        // Only purchase prices appear in dollars: no dollar value of credits and no model prices.
        for (const amount of html.match(/\$\d+(?:,\d{3})*(?:\.\d+)?/g) ?? [])
          expect(["$10", "$50", "$100", "$200"]).toContain(amount)
        expect(html).not.toMatch(/\d[\d,]* (Codium )?credits/)
      }
    }
  })

  test("questions are independent toggles that all start closed", () => {
    const html = questions(live)
    expect(html).toContain('<h2 class="cx-type-lg" id="cx-faq-heading">Questions &amp; Answers</h2>')
    const buttons = [...html.matchAll(/id="(cx-faq-q-[^"]+)" aria-expanded="(true|false)" aria-controls="([^"]+)"/g)]
    expect(buttons).toHaveLength(9)
    for (const match of buttons) {
      expect(match[2]).toBe("false")
      expect(html).toContain(`<div class="cx-faq-region" id="${match[3]}">`)
    }
    // Answers that can all be open at once are not landmarks.
    expect(html).not.toContain('role="region"')
    expect(html.match(/data-state="closed"/g)).toHaveLength(9)
    expect([...html.matchAll(/aria-controls="[^"]+">(.*?)<svg/g)].map((match) => text(match[1]!).trim())).toEqual([
      "What is the right plan for me?",
      "Do I need Codium to use Vector?",
      "How do Codium credits work?",
      "What happens when my credits run out?",
      "Which models are included, and where do my requests go?",
      "Are prices inclusive of taxes?",
      "Where can I see my balance?",
      "How can I make my credits last longer?",
      "Can I cancel any time?",
    ])
    const answers = text(html)
    expect(answers).toContain(
      "Use DeepSeek V4.1 Flash 1017, Claude Haiku 5.5, or GPT-6 Luna for routine work and save Kimi K3.1 Pro or Gemini 4 Argon",
    )
    expect(answers).toContain(
      "Start with Plus to try Codium on everyday coding. Pro suits coding with agents most days, Max daily agent " +
        "work across repositories, and Ultra long sessions with parallel agents.",
    )
    expect(answers).not.toMatch(/Codium \d/)
    expect(answers).toContain("no overage charges and no top-ups")
    expect(answers).not.toContain("Buy a top-up")
    expect(answers).not.toContain("a top-up covers a busy week")
    expect(answers).toContain("routes them only to zero-data-retention endpoints")
    for (const model of live.models ?? []) expect(html).toContain(`<strong>${model.name}</strong>`)
    expect(html).toContain('<a href="/account">account page</a>')
    expect(html).toContain('<a href="/legal/privacy#codium">privacy policy</a>')
  })

  test("headings step down one level at a time below the page title", () => {
    for (const mode of ["monthly", "topup"] as const) {
      const levels = [...(render(config, mode) + questions(config)).matchAll(/<h([1-6])[\s>]/g)].map((match) =>
        Number(match[1]),
      )
      // The page's own h1 sits above the islands, so they start at h2.
      expect(levels[0]).toBe(2)
      for (const [index, level] of levels.entries())
        if (index > 0) expect(level - levels[index - 1]!).toBeLessThanOrEqual(1)
    }
  })

  test("with sales switched off every buy button says Coming soon, stays disabled and keeps its size", () => {
    for (const value of [config, live]) {
      const html = render(closed(value))
      const buys = [...html.matchAll(/<button class="(cx-btn[^"]*)" type="button"( disabled="")?>(.*?)<\/button>/g)]
      // Each monthly plan has a card button and a comparison-table button.
      expect(buys).toHaveLength(value.plans.length * 2)
      for (const match of buys) {
        expect(match[2]).toBe(' disabled=""')
        expect(match[3]).toBe("Coming soon")
      }
      // The same classes as when sales are on, so the same size; only the table's buttons are small.
      const open = [...render(value).matchAll(/<button class="(cx-btn[^"]*)"/g)].map((match) => match[1])
      expect(buys.map((match) => match[1])).toEqual(open)
      expect(html).not.toContain(">Compare plans</button>")
      expect(html).not.toMatch(/>(?:Get|Buy) [^<]*<\/button>/)
    }
    // A plan that reports itself available still waits while the product as a whole is off.
    expect(render({ ...config, enabled: false })).not.toContain("Get Plus")
    expect(render(live)).toContain("Coming soon")
    const open = render(config)
    expect(open).not.toContain("Coming soon")
    expect(open).not.toContain("disabled")
  })

  test("the page uses the landing page's top bar, without the Vector mark in its corner, and its footer box", async () => {
    const source = await page()
    const lander = await Bun.file(new URL("../../Lander.astro", import.meta.url)).text()
    // The same components the landing page renders, in the same places around the page's main.
    expect(lander).toContain('<MarketingNav active="home" />')
    expect(lander).toContain("<SiteFooter />")
    expect(source).toContain('import MarketingNav from "../components/marketing/MarketingNav.astro"')
    expect(source).toContain('import SiteFooter from "../components/marketing/SiteFooter.astro"')
    // The bar sits in a .vector-marketing wrapper so LanderMaterials lights it exactly as on the landing page.
    const nav = source.indexOf('<div class="vector-marketing cx-bar">\n      <MarketingNav active="codium" />')
    expect(nav).toBeGreaterThan(source.indexOf('<div class="cx-page">'))
    expect(source.indexOf('<main class="cx-main">')).toBeGreaterThan(nav)
    expect(source.indexOf("<SiteFooter />")).toBeGreaterThan(source.indexOf("</main>"))
    expect(source).toContain('import LanderMaterials from "../components/marketing/LanderMaterials.astro"')
    expect(source).toContain("<LanderMaterials />")
    expect(source).toContain("Get started with Vector.")
    // The page's own header, menu, footer, theme switch and wordmark are gone.
    for (const removed of ["cx-header", "cx-logo", "cx-menu", "cx-footer", "cx-theme", "wordmark", "localStorage"])
      expect(source).not.toContain(removed)

    // The bar keeps the Vector mark, as on the landing page.
    const bar = await Bun.file(new URL("../MarketingNav.astro", import.meta.url)).text()
    expect(bar).toContain('<a class="site-brand" href="/" aria-label="Vector home">')
    expect(source).not.toContain("brand={false}")
  })

  test("the page is dark only, and its own typeface stops at main so the bar and footer match the landing page", async () => {
    const css = await Bun.file(new URL("./codium-pricing.css", import.meta.url)).text()
    expect(css).toContain("--cx-bg: #131017;")
    expect(css.match(/--cx-bg:/g)).toHaveLength(1)
    expect(css).toContain("color-scheme: dark;")
    for (const removed of ["prefers-color-scheme", "data-cx-theme", "color-scheme: light", "data-cx-menu"])
      expect(css).not.toContain(removed)
    expect(css).toContain(".cx-page {\n  --cx-sec")
    expect(css).toMatch(/^\.cx-main \{[^}]*font-family: "Geist Variable"/m)
    expect(css).toMatch(/^\.cx-bar > \.site-header \{[^}]*font-family: var\(--font-sans\);/m)
    expect(css).toMatch(/^\.cx-page > \.site-footer \{\n  font-family: var\(--font-landing\);/m)
    expect(css.match(/font-family:/g)).toHaveLength(3)
    // The landing page gives its bar Geist and its footer the landing face.
    const lander = await Bun.file(new URL("../../Lander.astro", import.meta.url)).text()
    expect(lander).toMatch(/\.vector-marketing > :global\(\.site-header\) \{\n    font-family: var\(--font-sans\);/)
    expect(lander).toMatch(/\.vector-marketing \{[^}]*font-family: var\(--font-landing\);/)
    // The bar's glass, rim and paint come from LanderMaterials itself, not a copy that could drift.
    const materials = await Bun.file(new URL("../LanderMaterials.astro", import.meta.url)).text()
    expect(materials).toContain(".vector-marketing .site-header .site-nav::before")
    expect(css).not.toMatch(/linear-gradient\(90deg/)
  })

  test("the bar scrolls away as on the landing page, and the table header and Q&A heading stick to the window top", async () => {
    const css = await Bun.file(new URL("./codium-pricing.css", import.meta.url)).text()
    // Positioned, so the cells' visually hidden labels are clipped by the scroller instead of widening the page.
    expect(css).toContain(".cx-compare-scroll {\n  /* Positioned")
    expect(css).toMatch(/\.cx-compare-scroll \{[^}]*position: relative;/)
    // The bar's own rule pins it, but the landing page makes every child of its wrapper relative, so it scrolls away
    // there; /codium does the same, so no pricing content can show above, beside or below a pinned bar.
    const bar = await Bun.file(new URL("../MarketingNav.astro", import.meta.url)).text()
    const motion = await Bun.file(new URL("../LanderMotion.astro", import.meta.url)).text()
    const wide = bar.match(/\.site-header \{[^}]*position: sticky;\n    top: (\d+)px;/)
    expect(wide).not.toBeNull()
    expect(motion).toMatch(/\.vector-marketing > \* \{\n    position: relative;/)
    expect(css).toMatch(/^\.cx-bar > \.site-header \{\n  position: relative;/m)
    // Nothing is left holding space for a pinned bar.
    for (const removed of ["--cx-nav", "--cx-header", "scroll-padding"]) expect(css).not.toContain(removed)
    // The header row sticks to the window top at every width; below 1140px its sideways scroller holds it in place.
    expect(css).toMatch(/^\.cx-compare thead th \{\n  position: sticky;\n  top: 0;/m)
    expect(css.match(/\.cx-compare thead th \{[^}]*top:/g)).toHaveLength(1)
    expect(css).toMatch(/@media \(min-width: 1140px\) \{\n  \.cx-compare-scroll \{\n    overflow: visible;\n  \}\n\}/)
    // The Q&A heading (sticky from 900px, on a 16px root) keeps the bar's own gap from the window top.
    const faq = css.match(/\.cx-faq-title > div \{\n    position: sticky;\n    top: ([\d.]+)rem;/)
    expect(faq).not.toBeNull()
    expect(Number(faq![1]) * 16).toBe(Number(wide![1]))
  })

  test("/pricing sends visitors to the Codium page, which the deploy keeps", async () => {
    const vercel = await Bun.file(new URL("../../../../../../vercel.json", import.meta.url)).json()
    expect(vercel.redirects).toContainEqual({ source: "/pricing", destination: "/codium", permanent: false })
    expect(await Bun.file(new URL("../../../../../../script/prune-vector-site.mjs", import.meta.url)).text()).toContain(
      '"codium"',
    )
  })
})
