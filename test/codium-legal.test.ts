import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import path from "node:path"
import { CODIUM_CHECKOUT_CONSENT, CODIUM_TERMS_DATE } from "../api/_lib/codium-consent"
import { PERK_IDS } from "../packages/schema/src/codium-entitlements"

// Contract invariant H8: the legal pages change only in a release commit that bumps their dates. Each page is pinned
// here by its effective date, so editing a page without moving it to a new, pinned date fails. WP A30 drafts the
// Vector Codium terms and privacy changes (contract §7.2) on the codium-legal branch, with their checks below; A60's
// release commit merges it after the legal read, sets both pages and CODIUM_TERMS_DATE to the release date, leaves out
// each "where available" block whose perk is not listed at launch, and pins the new hashes.

const root = path.join(import.meta.dir, "..")
const PAGES = {
  terms: "packages/web/src/pages/legal/terms.astro",
  privacy: "packages/web/src/pages/legal/privacy.astro",
} as const
type Page = keyof typeof PAGES

/**
 * sha256 of each page's source (LF line endings) at each effective date it carried. One hash per date. November 2,
 * 2026 is the A30 draft for the legal read, not a published version: A60 replaces it with the release date.
 */
const PINNED: Record<Page, Record<string, string>> = {
  terms: {
    "October 28, 2026": "05491512221a30ef76b175cad4c7d78628530fce91b448a92a92ec0747d144c1",
    "November 2, 2026": "c9b093706ae1bb5c5dd40a6602996580c8c0a83d91b631501b88967de5a63f51",
  },
  privacy: {
    "October 28, 2026": "fcf0280dd3d0b34d008cd18f6084ec143821c1d1a33d7499db0a54fad350e26e",
    "November 2, 2026": "a074a11e187f3f0c56dcc80e60a27beb059c94806d164a274c3f39c9a8fd9b47",
  },
}

const read = async (page: Page) => (await Bun.file(path.join(root, PAGES[page])).text()).replace(/\r\n/g, "\n")
const source = { terms: await read("terms"), privacy: await read("privacy") }
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

/** The `updated` prop LegalPage renders as "Effective …". */
function effective(text: string) {
  const dates = [...text.matchAll(/\bupdated="([^"]*)"/g)].map((match) => match[1]!)
  expect(dates).toHaveLength(1)
  return dates[0]!
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

/** "October 28, 2026" → "2026-10-28", or undefined when it is not a real calendar date in that form. */
function isoDate(date: string) {
  const match = /^([A-Z][a-z]+) (\d{1,2}), (\d{4})$/.exec(date)
  const month = MONTHS.indexOf(match?.[1] ?? "")
  if (!match || month < 0) return undefined
  const parsed = new Date(Date.UTC(Number(match[3]), month, Number(match[2])))
  if (parsed.getUTCMonth() !== month || parsed.getUTCDate() !== Number(match[2])) return undefined
  return parsed.toISOString().slice(0, 10)
}

const anchors = (text: string) => new Set([...text.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]!))

describe("H8: legal pages change only with a new effective date", () => {
  for (const page of Object.keys(PAGES) as Page[]) {
    test(`${page}: the content matches the hash pinned for its effective date`, () => {
      const date = effective(source[page])
      expect(isoDate(date)).toBeDefined()
      const pinned = PINNED[page][date]
      const actual = sha256(source[page])
      // Changing a legal page needs a release commit that moves its date and pins the new hash here.
      expect(
        pinned === actual
          ? "pinned"
          : `${PAGES[page]} changed without a new effective date, or ${date} is not pinned (sha256 ${actual})`,
      ).toBe("pinned")
    })
  }

  test("each pinned date is a real date and has one hash", () => {
    for (const versions of Object.values(PINNED))
      for (const [date, hash] of Object.entries(versions)) {
        expect(isoDate(date)).toBeDefined()
        expect(hash).toMatch(/^[0-9a-f]{64}$/)
      }
  })

  test("checkout records the date of the terms the page shows", () => {
    // The billing record stores the terms date a subscriber agreed to (contract §7.2), so it must be the page's.
    expect(isoDate(effective(source.terms))).toBe(CODIUM_TERMS_DATE)
  })

  test("both pages carry the same effective date", () => {
    expect(effective(source.privacy)).toBe(effective(source.terms))
  })
})

describe("links into the legal pages", () => {
  test("the checkout consent links to the terms' Codium section", () => {
    expect(CODIUM_CHECKOUT_CONSENT).toContain("(https://vectordev.ai/legal/terms#codium)")
    expect(anchors(source.terms).has("codium")).toBe(true)
  })

  test("every link to a section of the terms or privacy policy lands on an anchor that exists", () => {
    const result = Bun.spawnSync(
      [
        "git",
        "grep",
        "-n",
        "-I",
        "-o",
        "-E",
        "-e",
        "/legal/(terms|privacy)#[A-Za-z0-9_-]+",
        "--",
        ".",
        ":!docs/vector/build",
      ],
      { cwd: root },
    )
    // git grep exits 1 when nothing matches, and 2 or more on an error.
    if (result.exitCode > 1) throw new Error(result.stderr.toString())
    const links = result.stdout
      .toString()
      .split("\n")
      .filter(Boolean)
      .map((row) => {
        const [, page, anchor] = /\/legal\/(terms|privacy)#([A-Za-z0-9_-]+)$/.exec(row) ?? []
        return { row, page: page as Page, anchor: anchor! }
      })
    // The search has to reach the links it guards, or an empty result would mean nothing.
    expect(links.some((link) => link.row.startsWith("api/_lib/codium-consent.ts:"))).toBe(true)
    const broken = links.filter((link) => !anchors(source[link.page]).has(link.anchor)).map((link) => link.row)
    expect(broken).toEqual([])
  })
})

/** The markup an anchor names: an h3 runs to the next h3, div or the section's end; a block element to its close. */
function block(text: string, id: string) {
  const open = new RegExp(`<(h3|div|p|ul|li|section)\\b[^>]*\\bid="${id}"[^>]*>`).exec(text)
  if (!open) throw new Error(`No element has id="${id}"`)
  const rest = text.slice(open.index + open[0].length)
  if (open[1] !== "h3") return rest.slice(0, rest.indexOf(`</${open[1]}>`))
  const end = rest.search(/<h3\b|<div\b|<\/section>/)
  return end < 0 ? rest : rest.slice(0, end)
}

/** Visible text: tags dropped and whitespace collapsed. */
const plain = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
const textOf = (page: Page, id: string) => plain(block(source[page], id))
const between = (text: string, from: string, to: string) =>
  text.slice(text.indexOf(from), text.indexOf(to, text.indexOf(from)))

// Promises the copy guards (H2, H3) never allow, here or anywhere else.
const NEVER = [/\bexclusive\b/i, /\bevery (?:PR|pull request)\b/i, /24\/7/, /\bSLA\b/, /\bunlimited\b/i, /@vector\b/i]

describe("Vector Codium terms (contract §7.2, drafted by A30)", () => {
  const section = plain(block(source.terms, "codium"))

  test("§3 is retitled and holds every Codium anchor", () => {
    expect(source.terms).toContain('<section id="codium">\n    <h2>3. Cost and Vector Codium plans</h2>')
    for (const id of [
      "codium-plans",
      "codium-models",
      "codium-usage",
      "codium-coming",
      "codium-github",
      "codium-hosted",
      "codium-ops",
      "codium-consent",
    ])
      expect(block(source.terms, "codium")).toContain(`id="${id}"`)
    // Anchors the site already links to stay where they were.
    for (const id of ["free-models", "codium-data"]) expect(anchors(source.terms).has(id)).toBe(true)
  })

  test("what §3 keeps from the earlier text", () => {
    for (const phrase of [
      "Vector is free to download and use.",
      "may charge you separately under their own terms",
      "continued free access is not guaranteed",
      "any applicable taxes and the total payable",
      "will be communicated before they apply, with an opportunity to cancel and any consent required by law",
      "Records of purchases are retained as required by law.",
      "accurately metered usage is not refundable solely because your usage ran out sooner than expected",
      "correct confirmed billing errors",
      "Usage has no cash value and is not transferable",
    ])
      expect(section).toContain(phrase)
  })

  test("plans: monthly only, renewal, upgrades, downgrades, failed payments, refunds, disputes and the ramp", () => {
    const text = textOf("terms", "codium-plans")
    for (const pattern of [
      /sold as monthly plans only/,
      /no top-ups and no overage charges/,
      /renews automatically each month/,
      /cancel at any time .*keep your plan until the end of the period you have paid for/,
      /upgrade .*starts a new monthly period on the day you upgrade and is charged in full/,
      /unused usage of your current month carries into that new period only/,
      /downgrade starts at your next renewal/,
      /If a payment fails, Vector Codium and your plan's features pause/,
      /does not extend the month/,
      /after Stripe's retries, your plan ends/,
      /full refund of a payment, or a dispute of it, ends what that payment bought/,
      /possibly fraudulent, Vector may refund it and end the plan/,
      /suspended while a payment is disputed or flagged/,
      /New Max and Ultra subscriptions.* start with reduced limits for a short period/,
    ])
      expect(text).toMatch(pattern)
  })

  test("models, usage and limits", () => {
    const models = textOf("terms", "codium-models")
    expect(models).toMatch(/differ by plan and are listed at vectordev\.ai\/codium/)
    expect(models).toMatch(/temporarily unavailable/)
    expect(models).toMatch(/replace a model with a comparable one/)
    expect(models).toMatch(/does not reduce the usage, models or limits included in a month you have paid for/)
    expect(models).toMatch(/apply from your next renewal after the notice/)
    const usage = textOf("terms", "codium-usage")
    expect(usage).toMatch(/shown only as a whole-number percentage/)
    expect(usage).toMatch(/labelled “Codium” instead of with token counts or prices/)
    expect(usage).toMatch(/may lag/)
    expect(usage).toMatch(/does not roll over/)
    expect(usage).toMatch(/daily limit/)
    expect(usage).toMatch(/not a promise of a number of tokens, requests, completed tasks or successful results/)
    expect(usage).toMatch(/Your own keys and free models keep working/)
  })

  test("Coming: the Velocity clause word for word, and the same for every item tagged Coming (H2)", () => {
    const text = textOf("terms", "codium-coming")
    expect(text).toContain(
      "Vector Velocity is in development and is not part of what any subscription buys today. If it launches, we intend to offer it only on Max and Ultra. We don't promise that it will launch, or when.",
    )
    expect(text).toMatch(/The same applies to every item tagged “Coming”/)
    expect(block(source.terms, "codium-coming")).not.toContain("<a")
    for (const banned of [
      /\bavailable\b/i,
      /\bincluded\b/i,
      /\bfree\b/i,
      /guarantee/i,
      /\bsoon\b/i,
      /\bquarter\b/i,
      new RegExp(`\\b(?:${MONTHS.join("|")})\\b`),
      /\b20\d\d\b/,
      /\d\s*B\b|parameter/i,
      /built on|based on/i,
      /OpenAI|Anthropic|Google|DeepSeek|Moonshot|Kimi|Meta|Llama|Mistral|Qwen|Alibaba|Zhipu|GLM/,
    ])
      expect(text).not.toMatch(banned)
  })

  test("GitHub agents: model access only, in your own repository, on your own Actions minutes (H4)", () => {
    const text = textOf("terms", "codium-github")
    expect(text).toMatch(
      /sells only Codium model access inside runs in your own repository, on your own Actions minutes/,
    )
    expect(text).toMatch(/under your GitHub account and GitHub's terms, and GitHub bills the Actions minutes/)
    expect(text).toMatch(/only that repository's software work/)
    expect(text).toMatch(/Anyone with write, maintain or admin access to a repository you connect/)
    expect(text).toMatch(/measured by Vector from Codium requests, not from GitHub's minutes/)
    expect(text).toMatch(/also works without a plan, with your own model key stored as a repository secret/)
    expect(text).not.toMatch(/hosted|compute|cloud hours|cloud capacity|our cloud/i)
  })

  test("cloud computer and production checks are where-available blocks with their own rules", () => {
    const hosted = textOf("terms", "codium-hosted")
    expect(hosted).toMatch(/counts toward your month's usage/)
    expect(hosted).toMatch(/Vector may stop or pause a session/)
    for (const use of [/mining/, /spam/, /scraping a website against that site's terms/, /CAPTCHAs/, /bot checks/])
      expect(hosted).toMatch(use)
    expect(hosted).toMatch(/browser profile is wiped after each job/)
    expect(hosted).toMatch(/keeps the disk for 14 days so you can download your files, and then deletes it/)
    // Cloud computer copy never mentions GitHub or Actions (H4).
    expect(hosted).not.toMatch(/GitHub|\bActions\b/)
    const ops = textOf("terms", "codium-ops")
    expect(ops).toMatch(/checks only domains you have verified/)
    expect(ops).toMatch(/only to open pull requests automatically/)
    expect(ops).toMatch(/Vector never merges a pull request/)
    expect(ops).toMatch(/On Call is Vector's agent, not a person/)
    expect(ops).toMatch(/no uptime, availability or response-time promise/)
  })

  test("consent: an immediate start, 14-day withdrawal and the founding lock, as checkout says", () => {
    const text = textOf("terms", "codium-consent")
    expect(text).toMatch(/ask Vector to start your plan immediately/)
    expect(text).toMatch(/withdraw within 14 days of subscribing .*you pay for what you used before you withdrew/)
    expect(text).toMatch(/your price won't go up while you stay subscribed/)
    expect(text).toMatch(/If you change plans, you pay the new plan's current price/)
    expect(text).toMatch(
      /Founding members on Plus and Pro also get 10% more usage; this does not apply to Max or Ultra/,
    )
    expect(text).toMatch(/Founding membership ends when your subscription ends/)
    // The checkout text a subscriber agrees to says the same thing.
    expect(CODIUM_CHECKOUT_CONSENT).toContain("ask Vector to start my plan now")
    expect(CODIUM_CHECKOUT_CONSENT).toContain("If I withdraw within 14 days I pay for what I used.")
  })

  test("acceptable use adds mining, spam, scraping, CAPTCHAs and agent work unrelated to the repository", () => {
    const text = plain(between(source.terms, "<h2>8. Acceptable use</h2>", "</section>"))
    for (const use of [
      /cryptocurrency mining/,
      /spam/,
      /scraping a website against that site's terms/,
      /solving CAPTCHAs or bypassing bot checks/,
      /GitHub agents for work unrelated to the repository they run in/,
    ])
      expect(text).toMatch(use)
  })

  test("§3 has no credits, top-ups, amounts or banned promises", () => {
    const rest = section.replace(/\bno top-ups\b/g, "")
    for (const banned of [
      /credit/i,
      /top-?ups?/i,
      /purchased/i,
      /one-time/i,
      /\$\s?\d/,
      /\d[\d,.]*\s*[KM]?\s+tokens/i,
      ...NEVER,
    ])
      expect(rest).not.toMatch(banned)
  })
})

describe("Vector Codium privacy changes (contract §7.2, drafted by A30)", () => {
  const codium = plain(between(source.privacy, 'id="codium"', 'id="training"'))

  test("every new section has its anchor, and the old ones stay", () => {
    for (const id of [
      "codium",
      "codium-retention",
      "codium-billing",
      "codium-counters",
      "codium-github",
      "roadmap-votes",
      "vault",
      "remote",
      "hosted-computer",
      "production-checks",
      "codium-deletion",
      "report-tracking",
      "codium-usage-counts",
      "retention",
      "training",
      "included-models",
    ])
      expect(anchors(source.privacy).has(id)).toBe(true)
  })

  test("the Codium part has no top-ups, credits, purchased credits or amounts", () => {
    for (const banned of [/top-?ups?/i, /credit/i, /purchased/i, /\$\s?\d/]) expect(codium).not.toMatch(banned)
  })

  test("billing record, short-lived counters and deletion", () => {
    const billing = textOf("privacy", "codium-billing")
    expect(billing).toMatch(/sold as monthly plans only/)
    expect(billing).toMatch(/Stripe customer, subscription, invoice and charge identifiers/)
    expect(billing).toMatch(/your plan and billing period/)
    expect(billing).toMatch(/consent to the Codium terms, with the date of the terms you accepted/)
    expect(billing).toMatch(/summary of your plan's current state/)
    const counters = textOf("privacy", "codium-counters")
    expect(counters).toMatch(/about eleven minutes at most/)
    expect(counters).toMatch(/until 40 days after the billing period ends/)
    expect(counters).toMatch(/never request content/)
    const deletion = textOf("privacy", "codium-deletion")
    expect(deletion).toMatch(/erases your Codium records/)
    expect(deletion).toMatch(/Only pseudonymous ledger lines/)
  })

  test("GitHub run records, report records, ballots and usage check-ins", () => {
    const github = textOf("privacy", "codium-github")
    expect(github).toMatch(
      /repository's numeric identifier is bound to your Vector account, until the binding is removed/,
    )
    expect(github).toMatch(/run identifier, the GitHub event that started it/)
    expect(github).toMatch(/GitHub login or numeric user identifier of the person who started it, kept for 90 days/)
    expect(github).toMatch(/when the run started and stopped/)
    expect(github).toMatch(/logs are GitHub's records/)
    expect(github).toMatch(/on a public repository anyone can read them/)
    expect(github).toMatch(/Actions artifacts/)
    const reports = textOf("privacy", "report-tracking")
    expect(reports).toMatch(/for 180 days/)
    expect(reports).toMatch(/never contains the text of your report/)
    expect(textOf("privacy", "roadmap-votes")).toMatch(/Ballots and nominations are deleted with your account/)
    const counts = textOf("privacy", "codium-usage-counts")
    expect(counts).toMatch(/Codium token totals, cost and Codium model identifiers are not sent/)
    expect(counts).toMatch(/activity counts.* still include Codium work/)
  })

  test("where-available paragraphs: Vault, Remote, cloud computer and production checks", () => {
    const vault = textOf("privacy", "vault")
    expect(vault).toMatch(/encrypts each backup on your computer/)
    expect(vault).toMatch(/Vector never receives your recovery code/)
    expect(vault).toMatch(/read-only for 30 days/)
    const remote = textOf("privacy", "remote")
    expect(remote).toMatch(/relay/)
    expect(remote).toMatch(/encrypt what they exchange end to end/)
    expect(remote).toMatch(/devices you pair/)
    expect(remote).toMatch(/push subscriptions/)
    expect(remote).toMatch(/carry only a title/)
    const hosted = textOf("privacy", "hosted-computer")
    expect(hosted).toMatch(/recordings are visible only to you and kept for 30 days/)
    expect(hosted).toMatch(/Nothing is recorded while you have taken over control/)
    expect(hosted).toMatch(/Vercel runs the computer, and Cloudflare stores its recordings/)
    expect(hosted).toMatch(/Zero data retention covers the model requests your jobs make, not the computer's disk/)
    expect(hosted).not.toMatch(/GitHub|\bActions\b/)
    const checks = textOf("privacy", "production-checks")
    expect(checks).toMatch(/production URLs and domains/)
    expect(checks).toMatch(/check results/)
    expect(checks).toMatch(/deployment and pull request events/)
    expect(checks).toMatch(/screenshots/)
    expect(checks).toMatch(/for 30 or 90 days depending on your plan/)
  })

  test("§12 lists the retention periods", () => {
    const list = textOf("privacy", "retention")
    for (const period of [/eleven minutes/, /three days/, /40 days/, /90 days/, /180 days/, /about 13 months/])
      expect(list).toMatch(period)
  })

  test("no banned promise in the Codium paragraphs", () => {
    for (const banned of NEVER) expect(codium).not.toMatch(banned)
  })
})

describe("where-available blocks (published only once their perk is listed)", () => {
  /** Each element marked data-where-available, with the text up to its closing tag (they do not nest). */
  const blocks = (page: Page) =>
    [...source[page].matchAll(/<(\w+)\b[^>]*\bdata-where-available="([^"]*)"[^>]*>/g)].map((match) => {
      const rest = source[page].slice(match.index + match[0].length)
      return {
        id: /\bid="([^"]+)"/.exec(match[0])?.[1],
        perks: match[2]!.split(" "),
        text: plain(rest.slice(0, rest.indexOf(`</${match[1]}>`))),
      }
    })

  test("each names perks from the listing, so A60 can keep exactly the listed ones", () => {
    const known = new Set<string>(PERK_IDS)
    for (const page of Object.keys(PAGES) as Page[])
      for (const entry of blocks(page)) {
        expect(entry.perks.length).toBeGreaterThan(0)
        for (const perk of entry.perks) expect(known.has(perk)).toBe(true)
      }
  })

  test("the services not built yet are where-available blocks, and each says so", () => {
    expect(blocks("terms").map((entry) => entry.id)).toEqual(["codium-hosted", "codium-ops"])
    const privacy = blocks("privacy")
    expect(privacy.filter((entry) => entry.id).map((entry) => entry.id)).toEqual([
      "vault",
      "remote",
      "hosted-computer",
      "production-checks",
    ])
    // §12's retention list repeats the same three services, without anchors.
    expect(privacy.filter((entry) => !entry.id).map((entry) => entry.perks.join(" "))).toEqual([
      "vault",
      "computer overnight",
      "on-call release-guard ship-desk",
    ])
    for (const page of Object.keys(PAGES) as Page[])
      for (const entry of blocks(page)) expect(entry.text).toMatch(/^[^.]{0,80}\(where available\)/)
  })
})
