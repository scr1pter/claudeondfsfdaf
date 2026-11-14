import { expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { CodiumCopy, type PerkId } from "@vectordevai/schema/codium-copy"
import { ENTITLEMENTS, PERK_IDS } from "@vectordevai/schema/codium-entitlements"
import { CodiumPlan } from "@vectordevai/schema/codium-plan"
import { faqs, runGuardRows, spendRows } from "../src/data/docs-content"
import { docsMoved, docsNav } from "../src/data/docs-nav"
import { codiumDocs, HOSTED_PERKS, refreshCodiumDocs } from "../src/lib/codium-docs"

// /docs/codium (contract §7.3, WP A29): every number comes from CodiumCopy and ENTITLEMENTS, a perk shows only while
// the server lists it, #hosted and #coming always render, and nothing on the page reveals an amount of usage.

const source = await Bun.file(new URL("../src/pages/docs/codium.astro", import.meta.url)).text()
// What the page renders: no frontmatter and no client script.
const template = source.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/<script>[\s\S]*?<\/script>/g, "")
const plain = (text: string) =>
  text
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ")
const ANCHORS = ["plans", "models", "usage", "used-up", "github", "hosted", "coming", "payments", "free"]

function raw(id: string) {
  const start = template.indexOf(`<h2 id="${id}">`)
  expect(start).toBeGreaterThan(-1)
  const end = template.indexOf("<h2", start + 1)
  return template.slice(start, end === -1 ? undefined : end)
}
const section = (id: string) => plain(raw(id))

// Every string a view can put on the page, for one listing.
const strings = (view: ReturnType<typeof codiumDocs>) => [
  ...view.plans.flatMap((plan) => [
    plan.name,
    `$${plan.price}`,
    plan.tagline,
    plan.usage,
    ...plan.limits,
    ...plan.features.flatMap((perk) => [perk.label, perk.text]),
    ...plan.hostedLabels,
  ]),
  ...view.hosted.flatMap((perk) => [perk.label, ...perk.offers.map((offer) => offer.text)]),
  ...view.coming.flatMap((item) => [item.name, item.label, item.text]),
  ...view.free,
  ...view.everyPlan,
]

// Every subset of the perks that decide #hosted, with and without the perks they require.
const listings = (() => {
  const pool: PerkId[] = [...HOSTED_PERKS, "alerts"]
  return Array.from({ length: 1 << pool.length }, (_, mask) => pool.filter((_, index) => mask & (1 << index)))
})()

test("every section renders in the contract's order, outside any condition", () => {
  const positions = ANCHORS.map((id) => template.indexOf(`<h2 id="${id}">`))
  expect(positions.every((position) => position > -1)).toBe(true)
  expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  // A heading inside a {…} expression could be left out of the build; each sits at the top level of the template.
  for (const position of positions) {
    const before = template.slice(0, position)
    expect(before.split("{").length - before.split("}").length).toBe(0)
  }
  // #hosted says so when nothing is listed, and that line is not conditional either.
  expect(raw("hosted")).toContain("<p data-codium-hosted-empty>None yet.</p>")
  expect(raw("hosted")).toContain('<ul class="feature-list" data-codium-hosted hidden />')
})

test("the prerender lists no perk, so every plan shows its tagline that needs none", () => {
  const view = codiumDocs([])
  expect(view.hosted).toEqual([])
  for (const plan of view.plans) {
    expect(plan.features).toEqual([])
    expect(plan.hostedLabels).toEqual([])
    expect(plan.tagline).toBe(CodiumCopy.TAGLINES[plan.id].find((entry) => entry.requires.length === 0)!.text)
  }
  // Unknown or misspelled ids from a stale answer never list anything.
  expect(codiumDocs(["cloud-computer", "COMPUTER", ""]).hosted).toEqual([])
})

test("names, prices, usage and limits come from the plans and ENTITLEMENTS", () => {
  const view = codiumDocs([])
  expect(view.plans.map((plan) => [plan.id, plan.name, plan.price])).toEqual(
    CodiumPlan.PLANS.map((plan) => [plan.id, plan.name, plan.price]),
  )
  for (const plan of view.plans) {
    const caps = ENTITLEMENTS[plan.id]
    expect(plan.limits).toEqual([
      `${caps.inFlight} Codium requests at once`,
      `${caps.perMinute} requests a minute`,
      caps.dailyShare === null ? "No daily limit" : `Up to ${Math.round(caps.dailyShare * 100)}% of your month a day`,
    ])
    if (caps.rank > 1) expect(plan.usage).toStartWith(`${caps.usageMultiple}x Plus's usage`)
    expect(plan.ramp).toBe(caps.rank >= 3)
  }
  expect(view.free).toEqual(CodiumCopy.FREE_WORKSPACE)
  expect(view.everyPlan).toEqual(CodiumCopy.EVERY_PLAN)
})

test("a hosted perk shows only while it and what it requires are listed, under the plans that include it", () => {
  for (const listed of listings) {
    const view = codiumDocs(listed)
    const shown = view.hosted.map((perk) => perk.id)
    const enabled = (id: PerkId): boolean =>
      listed.includes(id) && (CodiumCopy.requires[id] ?? []).every((need) => enabled(need))
    expect(shown).toEqual(HOSTED_PERKS.filter((id) => enabled(id)))
    for (const perk of view.hosted)
      expect(perk.offers.map((offer) => offer.plan)).toEqual(
        CodiumPlan.PLANS.filter((plan) => CodiumCopy.PERK_COPY[perk.id].applies(ENTITLEMENTS[plan.id])).map(
          (plan) => plan.name,
        ),
      )
    // A plan names its hosted perks and describes them only under #hosted.
    for (const plan of view.plans) {
      expect(plan.features.some((perk) => HOSTED_PERKS.some((id) => id === perk.id))).toBe(false)
      expect(plan.hostedLabels).toEqual(
        view.hosted.filter((perk) => perk.offers.some((offer) => offer.plan === plan.name)).map((perk) => perk.label),
      )
    }
  }
  const full = codiumDocs([...PERK_IDS])
  const computer = full.hosted.find((perk) => perk.id === "computer")!
  expect(computer.offers.map((offer) => offer.plan)).toEqual(["Max", "Ultra"])
  for (const [index, plan] of (["vector-100", "vector-200"] as const).entries())
    expect(computer.offers[index]!.text).toContain(`${ENTITLEMENTS[plan].hosted!.hours} hours a month`)
})

test("nothing on the page states an amount: only the four prices, no credits, tokens or top-ups", () => {
  const texts = [
    plain(template),
    ...listings.flatMap((listed) => strings(codiumDocs(listed))),
    ...strings(codiumDocs([...PERK_IDS])),
  ]
  for (const text of texts) {
    for (const [, amount] of text.matchAll(/\$\s*([\d.,]+)/g)) expect(["10", "50", "100", "200"]).toContain(amount!)
    expect(text).not.toMatch(/\bcredits?\b|\busd\b|\bcents?\b|\bdollars? (?:of|worth)\b/i)
    expect(text).not.toMatch(/\d[\d,.]*\s*[kKmM]?\s*tokens\b/)
    // A top-up is named only to say there are none.
    for (const match of text.matchAll(/top-?ups?/gi)) expect(text.slice(0, match.index).trimEnd()).toMatch(/\bno$/i)
  }
  // The prerender's prices sit next to the plan names, as $10 to $200 a month.
  expect(source).toContain("{plan.name} · ${plan.price} a month")
})

test("#github summarises cloud agents, links to Vectorscope's GitHub runs and shows no trigger syntax", () => {
  expect(raw("github")).toContain('href="/docs/vectorscope#github"')
  const text = section("github")
  expect(text).toContain("in your own repo, on your own Actions minutes")
  expect(text).toContain("GitHub bills Actions minutes on private repos beyond your GitHub plan's included minutes")
  expect(text).toContain("with your own key as a repo secret")
  expect(text).not.toMatch(/@vector|\/vector\b|\/vs\b|vector github|VECTOR_CLI_TOKEN|workflow_dispatch/i)
  expect(text).not.toMatch(/hosted|compute|cloud hours|cloud capacity|our cloud/i)
})

test("#hosted and the hosted perks never mention GitHub or Actions", () => {
  const texts = [
    section("hosted"),
    ...codiumDocs([...PERK_IDS]).hosted.flatMap((perk) => perk.offers.map((o) => o.text)),
  ]
  for (const text of texts) expect(text).not.toMatch(/github|actions/i)
})

test("Coming items are always tagged Coming, with no date, availability or provider claim", () => {
  const view = codiumDocs([])
  expect(view.coming.map((item) => [item.id, item.label, item.plans])).toEqual([
    ["velocity", "Coming", ["Max", "Ultra"]],
  ])
  const text = section("coming")
  for (const item of view.coming) {
    expect(item.text).not.toMatch(
      /\b(?:available|included|free|guaranteed|soon|built on|based on)\b|\b20\d\d\b|\bQ[1-4]\b|January|February|March|April|May|June|July|August|September|October|November|December/i,
    )
    expect(raw("coming")).toContain("{item.name}")
  }
  expect(text).toContain("have no date and are not part of what a plan buys today")
  expect(text).not.toMatch(/\bsoon\b/i)
  // Plans that will get an item point at #coming rather than restating it.
  expect(raw("plans")).toContain('<a href="#coming">{item.name}</a>')
})

test("the page keeps the copy rules: no exclusivity, guarantees or uptime, and no projects", () => {
  const text = plain(template)
  expect(text).not.toMatch(/exclusive|every PR|every pull request|guarantee|24\/7|\bSLA\b|uptime|response time/i)
  expect(text).not.toMatch(/\bprojects?\b/i)
  for (const id of ANCHORS) expect(section(id).length).toBeGreaterThan(40)
})

test("Vector Codium is a Features page right after Models, and plans and pricing land on it", async () => {
  const features = docsNav.find((group) => group.label === "Features")?.links.map((link) => link.id) ?? []
  expect(features.indexOf("codium")).toBe(features.indexOf("models") + 1)
  expect(source).toContain('<DocsPage id="codium">')
  const vercel = (await Bun.file(new URL("../../../vercel.json", import.meta.url)).json()) as {
    redirects: { source: string; destination: string }[]
  }
  for (const id of ["plans", "pricing"]) {
    expect(docsMoved[id]).toBe("codium")
    expect(vercel.redirects.find((redirect) => redirect.source === `/docs/${id}`)?.destination).toBe("/docs/codium")
  }
})

test("the other docs drop Codium credits and top-ups: Codium steps are not counted in dollars", async () => {
  const docs = new URL("../src/pages/docs/", import.meta.url)
  const pages = (await readdir(docs)).filter((file) => file.endsWith(".astro") && file !== "changelog.astro")
  const texts = [
    ...(await Promise.all(
      pages.map(async (file) => [file, plain(await Bun.file(new URL(file, docs)).text())] as const),
    )),
    ...[...spendRows, ...runGuardRows].map((row) => ["docs-content.ts rows", row.join(" ")] as const),
    ...faqs.map((faq) => ["docs-content.ts faqs", `${faq.question} ${faq.answer}`] as const),
  ]
  for (const [where, text] of texts) {
    expect(
      `${where}: ${text.match(/Codium credits|credits (?:left|from a plan)|purchased|Buy credits/i)?.[0] ?? ""}`,
    ).toBe(`${where}: `)
    // OpenRouter's own automatic top-ups on a personal free account stay; Codium's are only ever "no top-ups".
    for (const match of text.matchAll(/top-?ups?/gi))
      expect(`${where}: ${text.slice(Math.max(0, match.index - 12), match.index + match[0].length)}`).toMatch(
        /(?:\bno|automatic) top-?ups?$/i,
      )
  }
  const page = async (name: string) => plain(await Bun.file(new URL(`${name}.astro`, docs)).text())
  expect(await page("terminal-agent")).toContain(
    "counted in dollars, and neither are Vector Codium steps; step limits still apply to both",
  )
  expect(await page("tokenomics")).toContain("Vector Codium steps are not counted in dollars")
  expect(runGuardRows.find(([term]) => term === "Unpriced is not free")?.[1]).toContain(
    "Vector Codium steps are not counted in dollars and do not count toward the 40 unpriced steps",
  )
  const usedUp = faqs.find((faq) => faq.question === "My Codium month is used up")
  expect(usedUp?.answer).toContain("pauses until your plan renews")
  expect(usedUp?.answer).toContain("Your own keys, Vector Local and free models keep working")
  expect(usedUp?.answer).toContain("There are no top-ups or overage charges")
  expect(await page("troubleshooting")).toContain("what is left of this month can no longer be used")
  expect(await page("desktop-app")).toContain(
    "your Vector Codium plan with how much of this month is left, as a percentage",
  )
})

test("the page script shows the live listing, and lists nothing when the configuration cannot be read", async () => {
  const config = (listed: unknown) => ({
    enabled: false,
    currency: "usd",
    interval: "month",
    plans: CodiumPlan.PLANS.map((plan) => ({ id: plan.id, name: plan.name, price: plan.price, available: false })),
    listed,
  })
  const answer = (status: number, body: unknown) => async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  const calls: [string, RequestInit][] = []
  const live = await refreshCodiumDocs(async (input, init) => {
    calls.push([input, init])
    return answer(200, config(["computer", "priority"]))()
  })
  expect(calls).toEqual([["/api/model-plans/config", { headers: { accept: "application/json" }, cache: "no-store" }]])
  expect(live.hosted.map((perk) => perk.id)).toEqual(["computer"])
  expect(live.plans.find((plan) => plan.id === "vector-100")?.features.map((perk) => perk.id)).toEqual(["priority"])
  expect(live.plans.find((plan) => plan.id === "vector-10")?.features).toEqual([])
  for (const fetcher of [
    answer(503, { error: { code: "MODEL_PLANS_DISABLED" } }),
    answer(200, config(["not-a-perk"])),
    answer(200, { listed: ["computer"] }),
    async (): Promise<Response> => {
      throw new Error("offline")
    },
  ]) {
    const view = await refreshCodiumDocs(fetcher)
    expect(view.hosted).toEqual([])
    expect(view.plans.every((plan) => plan.features.length === 0)).toBe(true)
  }
  // The script replaces the page's lists with each answer, and resets on a back-forward restore.
  expect(source).toContain("list.replaceChildren(...rows)")
  expect(source).toContain("apply(codiumDocs([]))")
})
