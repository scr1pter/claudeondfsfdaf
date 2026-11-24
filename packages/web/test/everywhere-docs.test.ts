import { describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { SWITCH_CACHE_MS, SWITCH_NAMES, SWITCH_VALUES } from "../../../api/_lib/codium-switches"
import { ENV_NAMES, LAPTOP_ROUTE_WIRED, parseDataKey, parseOfferSigningKey } from "../../../api/_lib/everywhere/config"
import { SWEEP_LIMIT } from "../../../api/_lib/everywhere/jobs"
import { KEEP_MS } from "../../../api/_lib/everywhere/keys"
import { offerPublicKey, signOffer } from "../../../api/_lib/everywhere/offer"
import { LIMITS, OFFER_KEY_ID_PATTERN, TIMING, createJobId } from "../../../packages/schema/src/everywhere"
import { COMPUTER_SEEN_MS, renderHelp } from "../../../packages/schema/src/everywhere-policy"
import { OFFER_KEYS, createOfferVerifier } from "../../desktop/src/main/everywhere-offer"
import { docsNav } from "../src/data/docs-nav"

// VE-44 (EV-24): the unreleased docs draft and the owner's go-live guides. The draft must say what the contract holds
// and promise nothing it refuses; the guides must agree with the code they configure. Everything here reads files from
// this checkout, and the key commands run in a temporary folder that is removed afterwards. Nothing reaches the network.

const web = path.join(import.meta.dir, "..")
const root = path.join(web, "../..")
const read = (file: string) => Bun.file(path.join(root, file)).text()

// The three pages the owner moves from src/drafts to the same paths under src/pages at 2.0.0 (each guide's At 2.0.0).
// The page is read, and a guide's path to any of them counts as present, at either address, so the move turns only the
// routing case ("is unrouted") red: that case is its one deliberate tripwire.
const MOVED = ["everywhere.astro", "everywhere/link.astro", "docs/everywhere.astro"]
const DRAFTS = "packages/web/src/drafts/"
const PAGES = "packages/web/src/pages/"
const moved = new Map(
  MOVED.flatMap((file) => [[DRAFTS + file, PAGES + file] as const, [PAGES + file, DRAFTS + file] as const]),
)
const DRAFT = (await Bun.file(path.join(root, PAGES, "docs/everywhere.astro")).exists())
  ? PAGES + "docs/everywhere.astro"
  : DRAFTS + "docs/everywhere.astro"
const OWNER = "docs/vector/owner-actions"
const PLATFORMS = ["github", "slack", "linear", "jira"] as const
const TRACKERS = ["slack", "linear", "jira"] as const
type Platform = (typeof PLATFORMS)[number]
const TITLES: Record<Platform, string> = { github: "GitHub", slack: "Slack", linear: "Linear", jira: "Jira" }
const HEADINGS = [
  "Where things stand",
  "Before you start",
  "Keys (once, for every platform)",
  "Settings",
  "Go-live steps",
  "Turning it on",
  "Live acceptance",
  "Turning it off",
  "Texts you provide",
  "At 2.0.0",
  "Listing (after use, separate from go-live)",
]
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const page = await read(DRAFT)
const guides = new Map(
  await Promise.all(
    PLATFORMS.map(async (platform) => [platform, await read(`${OWNER}/vector-everywhere-${platform}.md`)] as const),
  ),
)
const guide = (platform: Platform) => guides.get(platform) ?? ""

/** The page's visible text: the frontmatter dropped, tags removed, entities decoded, whitespace folded. */
function plain(html: string) {
  return html
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/<[^>]+>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ")
    .trim()
}

/** One `## ` section of a guide, from its heading to the next one. */
function section(markdown: string, heading: string) {
  const start = markdown.indexOf(`\n## ${heading}\n`)
  if (start < 0) return ""
  const body = markdown.slice(start + 1)
  const end = body.indexOf("\n## ")
  return end < 0 ? body : body.slice(0, end + 1)
}

/** The Settings table's rows as [name, value, while unset]; prettier's padded cells parse the same. */
function rows(markdown: string) {
  return section(markdown, "Settings")
    .split("\n")
    .filter((line) => /^\|\s*`[A-Z_]+`\s*\|/.test(line))
    .map((line) =>
      line
        .split(/(?<!\\)\|/)
        .slice(1, -1)
        .map((cell) => cell.trim()),
    )
    .map((cells) => ({ name: cells[0]!.replaceAll("`", ""), value: cells[1] ?? "", off: cells[2] ?? "", cells }))
}

const text = plain(page)

// Each pattern names the contract item it guards. Case-insensitive unless the comment says otherwise; every pattern
// uses word boundaries, so "Slack", "provider", "maximum" and "as soon as" never match (the allowed-sentences case).
const DENY: { pattern: RegExp; guards: string }[] = [
  // Comparative and parity claims (spec rules: no claim of parity with any other product, owner's rule on copy).
  { pattern: /\b(better|faster|cheaper|safer|smarter|easier) than\b/i, guards: "comparative" },
  { pattern: /\bunlike (other|most|any)\b/i, guards: "comparative" },
  { pattern: /\bparity\b|\bon par\b/i, guards: "parity" },
  { pattern: /\bthe only (tool|agent|product|app|assistant)\b/i, guards: "comparative" },
  { pattern: /\bthe best\b|\bindustry\b|\bleading (tool|agent|product)\b/i, guards: "comparative" },
  { pattern: /\bcompared (to|with)\b|\bversus\b|\bvs\.|\bjust like\b/i, guards: "comparative" },
  // Other products by name; case-sensitive.
  { pattern: /\b(Copilot|Cursor|Devin|Codex|Claude|Windsurf|Jules|ChatGPT)\b/, guards: "other products" },
]
const PAGE_DENY: { pattern: RegExp; guards: string }[] = [
  ...DENY,
  // No Actions route for platform jobs until R-A4 and R-C8 (spec 3.6), and no hosted computer (Q9).
  { pattern: /\bGitHub Actions\b|\bActions minutes\b|\brunners?\b/i, guards: "R-A4, R-C8" },
  { pattern: /\bhosted computer\b|\bVector's computer\b|\bin the cloud\b|\bcloud computer\b/i, guards: "Q9" },
  // GitHub laptop-first waits for @vector and Q13.
  { pattern: /\blaptop[- ]first\b|\bbinder\b/i, guards: "Q13, R-A5, R-A6" },
  // Teammates never run on someone else's computer (Q2, Q3, E14), and there is no allowlist.
  { pattern: /\bteammates? (can|may) (run|use|spend) (on )?your\b|\byour team\b|\ballowlist\b/i, guards: "Q2, Q3" },
  // Approvals are refused, never asked on a phone (Q7).
  { pattern: /\bphones?\b|\bpasskeys?\b/i, guards: "Q7" },
  // Slack reads only the mention's thread (Q5): no search and no other history.
  { pattern: /\bsearch/i, guards: "Q5" },
  { pattern: /\b(all|every|other) (channels?|messages|conversations)\b/i, guards: "Q5" },
  // No CLI at launch (Q11).
  { pattern: /\bvector everywhere (status|run)\b/i, guards: "Q11" },
  // No prices or plans; plan names case-sensitive.
  {
    pattern: /[$€£]\s*\d|\bprices?\b|\bpricing\b|\bpaid plans?\b|\bfree plans?\b|\bvector-(10|50|100|200)\b/i,
    guards: "prices",
  },
  { pattern: /\b(Plus|Pro|Max|Ultra)\b/, guards: "plan names" },
  // No compliance claims.
  { pattern: /\bGDPR\b|\bSOC ?2\b|\bHIPAA\b|\bFedRAMP\b|\bISO ?27001\b/i, guards: "compliance" },
  { pattern: /\bcompliant\b|\bcompliance\b|\bcertified\b|\bend-to-end\b/i, guards: "compliance" },
  // No guarantees of service; SLA case-sensitive.
  {
    pattern: /\bguarantee[sd]?\b|\balways on\b|\b24\/7\b|\buptime\b|\binstant(ly)?\b|\breal[- ]time\b/i,
    guards: "guarantees",
  },
  { pattern: /\bSLA\b/, guards: "guarantees" },
  // Nothing about availability: the page is unreleased.
  { pattern: /\bnow available\b|\bcoming soon\b|\bbeta\b|\bpreview\b/i, guards: "availability" },
  // Linear and Jira post no summary until `privateResult` exists (EV-23 (c)).
  { pattern: /\bIn Linear and Jira\b[^.]*\bsummar/i, guards: "EV-23 (c)" },
  // The desktop page cannot write the settings yet, and older engines refuse a file with them (EV-21, Ruling on (a)).
  { pattern: /\bsettings file\b/i, guards: "EV-21 (a)" },
  // Owner rule: Vector has no projects.
  { pattern: /\bprojects?\b/i, guards: "no projects" },
]
// A folder on someone's machine: a home folder on macOS, Linux or Windows, root's, or an agent's scratch folder.
const MACHINE_PATH = /(?<![\w.-])(?:\/Users|\/home|\/root)\/[A-Za-z0-9._-]+\/|[A-Za-z]:\\Users\\|\/tmp\/claude-/
const DRAFTING =
  /\bwe (collect|store|retain|process|share|use)\b|\byou (agree|consent|acknowledge)\b|\bpersonal data\b|\bdata controller\b|\blawful basis\b|\bby (installing|using)\b/i

describe("the docs draft", () => {
  test("is unrouted: not under src/pages, no docs-nav entry, its import valid from both places", async () => {
    const lines = page.split("\n")
    expect(lines[0]).toBe("---")
    expect(lines[1]).toBe(
      "// Unreleased draft: Astro routes only src/pages, so this page is not built, linked or listed in the sitemap.",
    )
    expect(page).toContain("export const prerender = true")
    expect(page).toContain('<DocsPage id="everywhere">')
    // Where the owner moves it at 2.0.0 (spec 6.5): not there before.
    expect(await Bun.file(path.join(web, "src/pages/docs/everywhere.astro")).exists()).toBe(false)
    const pages = [...new Bun.Glob("**/*").scanSync({ cwd: path.join(web, "src/pages") })]
    expect(pages.length).toBeGreaterThan(10)
    expect(pages.filter((file) => /everywhere/i.test(file))).toEqual([])
    const links = docsNav.flatMap((group) => group.links)
    expect(links.map((link) => link.id)).toContain("automations")
    expect(links.filter((link) => /everywhere/i.test(link.id))).toEqual([])
    expect(await read("packages/web/src/data/docs-nav.ts")).not.toMatch(/everywhere/i)
    const config = await read("packages/web/astro.config.mjs")
    expect(config).not.toMatch(/everywhere|drafts/i)
    // The keep line each guide's At 2.0.0 adds to the pruned site (step 2) is not there before the move.
    expect(await read("script/prune-vector-site.mjs")).not.toMatch(/["']everywhere["']/)
    // The only import resolves into src/layouts from src/drafts/docs now and from src/pages/docs after the move.
    const frontmatter = page.split("\n---\n")[0] ?? ""
    const imports = [...frontmatter.matchAll(/from "(\.[^"]+)"/g)].map((match) => match[1]!)
    expect(imports).toEqual(["../../layouts/DocsPage.astro"])
    for (const from of ["src/drafts/docs", "src/pages/docs"]) {
      const target = path.resolve(web, from, imports[0]!)
      expect(target).toBe(path.join(web, "src/layouts/DocsPage.astro"))
      expect(await Bun.file(target).exists()).toBe(true)
    }
    // DocsPage throws for an id with no docs-nav entry, so the 2.0.0 move fails loudly without one.
    expect(await read("packages/web/src/layouts/DocsPage.astro")).toContain("has no entry in docs-nav.ts")
    // Nothing imports the draft or links its future address.
    const src = path.join(web, "src")
    const files = [...new Bun.Glob("**/*.{ts,tsx,astro,mjs,js,md,mdx}").scanSync({ cwd: src })]
    expect(files.length).toBeGreaterThan(100)
    const texts = await Promise.all(
      files.map(async (file) => ({ file, text: await Bun.file(path.join(src, file)).text() })),
    )
    expect(
      texts
        .filter((item) => item.file !== "drafts/docs/everywhere.astro")
        .filter((item) => /drafts\/docs\/everywhere|\/docs\/everywhere\b/.test(item.text))
        .map((item) => item.file),
    ).toEqual([])
  })

  test("says what the contract holds", () => {
    const has = (phrase: string) => expect(text.toLowerCase()).toContain(phrase.toLowerCase())
    // The brief's pinned sentences. "Your code stays off Vector's servers." was narrowed to what E4 holds by the phase
    // review of 2026-11-21 (deviations log, "everywhere-finish lane").
    has(
      "A job's request reaches Vector's servers only as encrypted text for at most 2 hours; your repository's code does not",
    )
    has("The job runs on your computer first, in its own copy of the repository.")
    has("Slack history is read only for the thread of a mention:")
    has("A closed lid means queued:")
    has("A job waits at most 2 hours for your computer, and at most 10 minutes in Jira.")
    has("Only your own linked account can start a job, and it runs only on your own computer.")
    // The same numbers, from the code that enforces them.
    expect(TIMING.queueMs).toBeLessThan(TIMING.bodyTtlMs)
    has(`waits at most ${Math.ceil(TIMING.queueMs / HOUR)} hours`)
    has(`encrypted text for at most ${TIMING.bodyTtlMs / HOUR} hours`)
    has(`${TIMING.jiraQueueMs / MINUTE} minutes in Jira`)
    has(`A Jira job runs at most ${TIMING.jiraRunMs / MINUTE} minutes`)
    has(`at most ${LIMITS.threadMessages} messages`)
    has(`once, for ${KEEP_MS.linkCode / MINUTE} minutes`)
    has(`jobs of the last ${KEEP_MS.job / DAY} days`)
    has(`audit log of the last ${KEEP_MS.audit / DAY} days`)
    has(`checked in for ${COMPUTER_SEEN_MS / DAY} days`)
    // "Code stays off Vector's servers" is qualified where the user's own model choice sends code through Vector, and
    // how the gateway handles it is left to the privacy policy: the page restates no retention or third-party fact.
    has("Vector Codium")
    has("unless you choose a Vector Codium model (below)")
    has("pass through Vector's model gateway; how they are handled is in the")
    has("Your code stays off Vector's servers, except as described below when you choose a Vector Codium model.")
    expect(page).toContain('href="/legal/privacy#codium"')
    for (const restated of ["does not store", "OpenRouter", "retain"])
      expect(text.toLowerCase()).not.toContain(restated.toLowerCase())
    // Laptop facts the page promises.
    has("On macOS and Windows a job edits files and runs no commands.")
    has("Only a private repository's branch is pushed. A public repository's branch stays on your computer.")
    // A push already admitted is never interrupted (desktop everywhere-runner.ts, the publishing git), so a stop that
    // comes after it leaves the branch; since EV-03 the runner opens no draft pull request after a stop.
    has("Stopping it aborts the job on your computer and nothing more is pushed.")
    has("A push that has already started finishes, but no draft pull request opens for it.")
    expect(text.toLowerCase()).not.toContain("draft pull request can still open")
    has("it refuses every approval request")
    has("the summary may name files but carries no code")
    has("Nobody else's request runs on your computer or uses your plan.")
    has("Guests, people from other organizations, bots and automation rules start nothing.")
    has("Vector's servers can only lower them")
  })

  test("names every control word the help text does", () => {
    const words = new Set(
      TRACKERS.flatMap((platform) => [...renderHelp(platform).matchAll(/`([a-z]+)/g)].map((match) => match[1]!)),
    )
    expect([...words].sort()).toEqual(["help", "link", "repo", "status", "stop", "unlink"])
    expect([...words].filter((word) => !page.includes(`<code>${word}`))).toEqual([])
  })

  test("links only pages that exist, and never the unreleased account pages", async () => {
    const hrefs = [...page.matchAll(/href="([^"]+)"/g)].map((match) => match[1]!)
    expect(hrefs.sort()).toEqual(["/docs/vectorscope#github", "/legal/privacy#codium"])
    expect(await read("packages/web/src/pages/legal/privacy.astro")).toContain('id="codium"')
    expect(await read("packages/web/src/pages/docs/vectorscope.astro")).toContain('id="github"')
    // The account page moves at 2.0.0 too; until then it is named in text only (EV-24 (c)).
    expect(page).not.toMatch(/href=["'{`][^"'`]*\/everywhere/)
    expect(page).not.toContain("vectordev.ai/everywhere")
    expect(text).toContain("the Vector everywhere page")
  })

  test("promises nothing the contract refuses", () => {
    expect(PAGE_DENY.filter((rule) => rule.pattern.test(text)).map((rule) => rule.guards)).toEqual([])
    expect(DRAFTING.test(text)).toBe(false)
  })

  test("the deny list leaves ordinary sentences alone", () => {
    const allowed = [
      "Mention @Vector in a Slack channel.",
      "A hosted model's provider receives it, as in any other session.",
      "The maximum is 15 messages.",
      "Vector replies as soon as the job ends.",
      "That reply would be misleading.",
      "Each instance keeps the switch for 30 seconds.",
      "The only exceptions are listed below.",
      "A teammate with their own linked account and their own computer can start jobs that run there.",
      "Professional workspaces and Linear teams.",
      "Each server keeps the switch, and Vector's servers can only lower them.",
    ]
    expect(
      allowed.flatMap((sentence) =>
        PAGE_DENY.filter((rule) => rule.pattern.test(sentence)).map((rule) => `${rule.guards}: ${sentence}`),
      ),
    ).toEqual([])
    // And each family still catches what it is for.
    const caught = [
      "Vector is faster than the rest.",
      "It runs in GitHub Actions.",
      "Approve it on your phone.",
      "Pricing starts at $5.",
      "Upgrade to Pro.",
      "It is SOC 2 compliant.",
      "We guarantee 24/7 uptime.",
      "Now available in beta.",
      "Open a project first.",
      "Your teammates can run on your computer.",
    ]
    expect(caught.filter((sentence) => !PAGE_DENY.some((rule) => rule.pattern.test(sentence)))).toEqual([])
  })
})

describe("the owner's go-live guides", () => {
  test("share their headings, in order, with only the platform in the title", async () => {
    for (const platform of PLATFORMS) {
      const markdown = guide(platform)
      const lines = markdown.split("\n")
      expect({ platform, title: lines[0] }).toEqual({
        platform,
        title: `# Vector everywhere on ${TITLES[platform]}: going live`,
      })
      expect(lines.filter((line) => line.startsWith("# "))).toHaveLength(1)
      expect({
        platform,
        headings: lines.filter((line) => line.startsWith("## ")).map((line) => line.slice(3)),
      }).toEqual({
        platform,
        headings: HEADINGS,
      })
    }
    // The lead's amendment: no legal or privacy drafts are written.
    expect(await Bun.file(path.join(root, OWNER, "vector-everywhere-legal-drafts.md")).exists()).toBe(false)
  })

  test("keep the shared sections byte-identical", () => {
    for (const heading of ["Keys (once, for every platform)", "Turning it off", "At 2.0.0"]) {
      const sections = PLATFORMS.map((platform) => section(guide(platform), heading))
      expect(sections[0]!.length).toBeGreaterThan(200)
      expect({ heading, same: sections.every((item) => item === sections[0]) }).toEqual({ heading, same: true })
    }
    // GitHub has nothing to turn on yet, so only the three trackers share the turn-on order.
    const on = TRACKERS.map((platform) => section(guide(platform), "Turning it on"))
    expect(on[0]!.length).toBeGreaterThan(200)
    expect(on.every((item) => item === on[0])).toBe(true)
    const github = section(guide("github"), "Turning it on")
    expect(github).toContain("`HANDOFF_UNAVAILABLE`")
    expect(github).toContain("Do not add `github` to `VECTOR_EVERYWHERE_PLATFORMS`")
  })

  test("have a Settings row for every setting the code reads, each platform its own", () => {
    const common = Object.entries(ENV_NAMES)
      .filter(([key]) => !/^(slack|linear|jira)/.test(key))
      .map(([, name]) => name)
    const own = (platform: Platform) =>
      Object.entries(ENV_NAMES)
        .filter(([key]) => key.startsWith(platform))
        .map(([, name]) => name)
    const covered = new Set<string>()
    for (const platform of PLATFORMS) {
      const table = rows(guide(platform))
      const expected = [...common, ...own(platform)]
      // A row the parser missed would make the comparison below vacuous.
      expect({ platform, count: table.length }).toEqual({ platform, count: expected.length })
      expect({ platform, names: table.map((row) => row.name).sort() }).toEqual({
        platform,
        names: [...expected].sort(),
      })
      expect(table.filter((row) => row.cells.length !== 3 || row.value.length < 10 || row.off.length < 10)).toEqual([])
      for (const row of table) covered.add(row.name)
    }
    expect([...covered].sort()).toEqual(Object.values(ENV_NAMES).sort())
    // CRON_SECRET is Codium's too: never regenerated here, and the sweep's own minimum is stated.
    const cron = rows(guide("slack")).find((row) => row.name === ENV_NAMES.cronSecret)
    expect(cron?.value).toContain("do not change or regenerate it")
    expect(cron?.value).toContain("at least 16 characters")
    expect(cron?.off).toContain("401")
    const enabled = rows(guide("slack")).find((row) => row.name === ENV_NAMES.enabled)
    expect(enabled?.off).toContain("claim answers 409")
    expect(enabled?.off).toContain("`{enabled: false}`")
  })

  test("their key commands make keys the code accepts", async () => {
    const keys = section(guide("slack"), "Keys (once, for every platform)")
    const commands = [...keys.matchAll(/^\s*node -e '([^']+)'\s*$/gm)].map((match) => match[1]!)
    expect(commands).toHaveLength(2)
    // The pair is made in a new, empty folder, never in a checkout where `git add` could take the private key.
    const fresh = keys.indexOf('cd "$(mktemp -d)"')
    expect(fresh).toBeGreaterThan(-1)
    expect(fresh).toBeLessThan(keys.indexOf(commands[1]!))
    expect(keys).not.toMatch(/repository root|your checkout|in the repository/i)
    // The data key's warning covers the installations it seals, not only live jobs.
    expect(keys).toContain("never rotate it")
    expect(keys).toContain("disconnects every Slack, Linear and Jira installation")
    const directory = await mkdtemp(path.join(tmpdir(), "everywhere-docs-keys-"))
    try {
      const run = async (code: string) => {
        const child = Bun.spawn([process.execPath, "-e", code], {
          cwd: directory,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        })
        const [status, out, err] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        expect({ status, err }).toEqual({ status: 0, err: "" })
        return out.trim()
      }
      const data = await run(commands[0]!)
      expect(data).toHaveLength(44)
      expect(parseDataKey(data)).toBeDefined()
      const printed = await run(commands[1]!)
      expect(printed).toMatch(/^[A-Za-z0-9_-]{43}$/)
      const file = path.join(directory, "offer-signing.pem")
      if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600)
      const pem = await Bun.file(file).text()
      const key = parseOfferSigningKey(pem)
      expect(key).toBeDefined()
      // Pasted as one line with \n escapes, it reads the same.
      expect(parseOfferSigningKey(pem.trim().replaceAll("\n", "\\n"))).toBeDefined()
      const kid = "ve-2026-12"
      expect(OFFER_KEY_ID_PATTERN.test(kid)).toBe(true)
      const offerKey = { kid, key: key! }
      expect(offerPublicKey(offerKey).publicKey).toBe(printed)
      const account = randomUUID()
      const now = Date.now()
      const signed = signOffer(offerKey, { account, jid: createJobId(now), now })
      const verify = createOfferVerifier({
        account,
        keys: { [kid]: printed },
        now: () => now,
        useOnce: async () => true,
      })
      expect((await verify(signed.offer))?.jid).toBe(signed.claims.jid)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("turn it off in EV-04's order, with only the switch's own values", async () => {
    const off = section(guide("slack"), "Turning it off")
    const at = (needle: string) => {
      const index = off.indexOf(needle)
      expect({ needle, found: index >= 0 }).toEqual({ needle, found: true })
      return index
    }
    expect(at("switch to `stop`")).toBeLessThan(at("at least 2 minutes"))
    expect(at("at least 2 minutes")).toBeLessThan(at("Unset `VECTOR_EVERYWHERE_ENABLED`"))
    expect(off).toContain("`no-new`")
    // Every backticked word but a switch name or the flag's own true and false is an `everywhere` switch value, so
    // Codium's `off`, which the switch does not take, is never named.
    const allowed = new Set<string>(SWITCH_VALUES.everywhere)
    const names = new Set<string>(SWITCH_NAMES)
    const values = [...off.matchAll(/`([a-z][a-z-]*)`/g)]
      .map((match) => match[1]!)
      .filter((word) => !names.has(word) && word !== "true" && word !== "false")
    expect(values.length).toBeGreaterThan(0)
    expect(values.filter((word) => !allowed.has(word))).toEqual([])
    // Two minutes cover one switch cache period and one cron minute, and each further batch is the sweep's own.
    expect(SWITCH_CACHE_MS + MINUTE).toBeLessThanOrEqual(2 * MINUTE)
    expect(off).toContain(`each server keeps the switch for ${SWITCH_CACHE_MS / 1000} seconds`)
    expect(off).toContain(`one more minute for every further ${SWEEP_LIMIT} live jobs`)
    const vercel = (await Bun.file(path.join(root, "vercel.json")).json()) as {
      crons?: { path: string; schedule: string }[]
    }
    expect(vercel.crons).toContainEqual({ path: "/api/everywhere/sweep", schedule: "* * * * *" })
  })

  test("turn it on from the stop switch, with Remote live and only the owner allowed", () => {
    const on = section(guide("slack"), "Turning it on")
    const at = (needle: string) => {
      const index = on.indexOf(needle)
      expect({ needle, found: index >= 0 }).toEqual({ needle, found: true })
      return index
    }
    expect(at("switch to `stop`")).toBeLessThan(at("`VECTOR_EVERYWHERE_ENABLED` to `true`"))
    expect(at("`VECTOR_EVERYWHERE_ENABLED` to `true`")).toBeLessThan(at("back to `on`"))
    expect(on).toContain("redeploy")
    expect(on).toContain("`VECTOR_EVERYWHERE_ALLOW_ACCOUNTS` to your own account id only")
    // The laptop route needs Remote live (adapters/remote.ts reads offline otherwise).
    expect(on).toContain("`VECTOR_REMOTE_ENABLED`")
    expect(on).toContain("`remote` switch")
    expect(on).toContain("Never set the flag on a deployment without the cron")
    // `readConfig` counts GitHub as always configured, so listing it opens it: the order never lists it.
    expect(on).toContain("never `github`")
    expect(on).toContain("leave it as it is")
  })

  test("put go-live before the listing, with each platform's own steps", () => {
    const golive = (platform: Platform) => section(guide(platform), "Go-live steps")
    const listing = (platform: Platform) => section(guide(platform), "Listing (after use, separate from go-live)")
    expect(listing("slack")).toContain("10 active workspaces")
    expect(listing("slack")).toContain("20 monthly active users")
    expect(listing("linear")).toContain("320×320")
    expect(golive("linear")).toContain("integration-directory submission")
    expect(listing("jira")).toContain("security questionnaire")
    expect(listing("jira")).toContain("security contact")
    expect(listing("jira")).toContain("partner")
    // The owner's commit replacing the all-zero app id also updates the test that pins it.
    expect(golive("jira")).toContain("`packages/web/test/everywhere-jira-manifest.test.ts`")
    expect(listing("github")).toContain("No listing is needed")
    expect(guide("github")).toContain("HANDOFF_UNAVAILABLE")
    expect(guide("github")).toContain("Q13")
  })

  test("name every open gate while it is open", async () => {
    // Tripwires: whoever changes either of these updates every guide's Before you start in the same change.
    expect(LAPTOP_ROUTE_WIRED).toBe(false)
    expect(Object.keys(OFFER_KEYS)).toEqual([])
    const desktop = await read("packages/app/src/components/settings-v2/everywhere-model.ts")
    const readOnly = desktop.includes("This page shows those settings and changes none of them.")
    for (const platform of PLATFORMS) {
      const before = section(guide(platform), "Before you start")
      expect({
        platform,
        wired: before.includes("`LAPTOP_ROUTE_WIRED`"),
        keys: before.includes("`OFFER_KEYS`"),
      }).toEqual({
        platform,
        wired: true,
        keys: true,
      })
      // While the desktop page writes nothing, every guide says so; when it writes, the gate goes.
      expect({ platform, gate: before.includes("Ruling on (a)") }).toEqual({ platform, gate: readOnly })
    }
    expect(page.includes('Rewrite "Set it up" when the write path lands.')).toBe(readOnly)
    // Until EV-21 labels the desktop's GitHub calls, the runner's `github` guard declines every job under Vector Local,
    // and the page says exactly that; when the guard goes, the page says what Vector Local must allow.
    const guarded = (await read("packages/desktop/src/main/everywhere-runner.ts")).includes(
      'if (need.source === "github" && policy.enabled) return false',
    )
    expect(text.includes("With Vector Local on, the computer declines jobs.")).toBe(guarded)
    expect(page.includes("When the guard goes, say what Vector Local must")).toBe(guarded)
    expect(text).toContain("Linear team ID")
    expect(text).toContain("Jira key")
    expect(text).toContain("Add repository")
    for (const platform of TRACKERS) {
      const before = section(guide(platform), "Before you start")
      expect(before).toContain("verified GitHub binding")
      expect(before).toContain("PUB-8")
    }
    for (const platform of ["linear", "jira"] as const) {
      const before = section(guide(platform), "Before you start")
      expect(before).toContain(platform === "linear" ? "Linear team ID" : "Jira project key")
      expect(before).toContain("Add repository")
      expect(before).toContain("`privateResult`")
    }
    // Wording that promises routes not built is a gate exactly while it is there.
    for (const platform of ["slack", "linear"] as const)
      expect({
        platform,
        gate: section(guide(platform), "Before you start").includes("(or in GitHub Actions)"),
      }).toEqual({
        platform,
        gate: renderHelp(platform).includes("GitHub Actions"),
      })
    const manifest = (await Bun.file(path.join(root, "integrations/slack/manifest.json")).json()) as {
      display_information: { description: string }
      features: { agent_view: { agent_description: string } }
    }
    const promises = /runner/i.test(
      manifest.display_information.description + manifest.features.agent_view.agent_description,
    )
    expect(section(guide("slack"), "Before you start").includes("GitHub runner")).toBe(promises)
  })

  test("list the legal and privacy texts the owner provides, and draft none", () => {
    for (const platform of TRACKERS) {
      const texts = section(guide(platform), "Texts you provide")
      for (const needle of [
        "https://vectordev.ai/legal/privacy",
        "`packages/web/src/pages/legal/privacy.astro`",
        "https://vectordev.ai/legal/terms",
        "`test/codium-legal.test.ts`",
        'Consent text for "This computer takes jobs"',
        "`PERK_COPY.everywhere`",
      ])
        expect({ platform, needle, found: texts.includes(needle) }).toEqual({ platform, needle, found: true })
    }
    const slack = section(guide("slack"), "Texts you provide")
    expect(slack).toContain("Landing page")
    expect(slack).toContain("Support page")
    const jira = section(guide("jira"), "Texts you provide")
    expect(jira).toContain("security questionnaire")
    expect(jira).toContain("`inScopeEUD: true`")
    for (const platform of PLATFORMS)
      expect({ platform, drafted: DRAFTING.test(guide(platform)) }).toEqual({ platform, drafted: false })
  })

  test("name only paths and links that exist", async () => {
    const exists = (file: string) => Bun.file(path.join(root, file)).exists()
    // Each page the owner moves at 2.0.0 is at exactly one of its two addresses, before the move and after it.
    for (const file of MOVED)
      expect({ file, at: [await exists(DRAFTS + file), await exists(PAGES + file)].filter(Boolean).length }).toEqual({
        file,
        at: 1,
      })
    const present = async (file: string) => {
      if (await exists(file)) return true
      const other = moved.get(file)
      return other !== undefined && (await exists(other))
    }
    const missing: string[] = []
    for (const platform of PLATFORMS) {
      const markdown = guide(platform)
      const paths = [...markdown.matchAll(/`((?:packages|api|integrations|docs|script|test)\/[^`\s]+)`/g)]
        .map((match) => match[1]!)
        .filter((file) => !/[*{}:]/.test(file))
      expect(paths.length).toBeGreaterThan(5)
      const links = [...markdown.matchAll(/\]\((?!https?:|#|\/)([^)\s]+)\)/g)].map((match) =>
        path.posix.normalize(path.posix.join(OWNER, match[1]!.replace(/#.*$/, ""))),
      )
      for (const file of [...paths, ...links]) if (!(await present(file))) missing.push(`${platform}: ${file}`)
    }
    expect(missing).toEqual([])
  })

  test("leak no secret, address or machine path, and make no comparative claim", () => {
    const sources: [string, string][] = [
      [DRAFT, page],
      ...PLATFORMS.map((platform) => [platform, guide(platform)] as [string, string]),
    ]
    const leaks = [
      /-----BEGIN [A-Z ]+-----\s*[A-Za-z0-9+/=]{16,}/,
      /\bxox[abposr]-/,
      /\bghp_|\bgithub_pat_|\bgho_/,
      /\blin_api_|\blin_oauth_/,
      /\bAKIA[0-9A-Z]{16}\b/,
      /\bsk-[A-Za-z0-9_-]{16,}/,
      // A secret-like setting given a value.
      /\b[A-Z][A-Z0-9_]*(SECRET|KEY|TOKEN)[A-Z0-9_]*\s*[=:]\s*["']?[^\s"'`|]{16,}/,
      // An email address.
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
      MACHINE_PATH,
    ]
    expect(
      sources.flatMap(([name, source]) =>
        [...leaks, ...DENY.map((rule) => rule.pattern)]
          .filter((pattern) => pattern.test(source))
          .map((pattern) => `${name}: ${pattern}`),
      ),
    ).toEqual([])
    // The machine-path pattern catches each kind of local folder and leaves repository paths and site routes alone.
    const caught = [
      "Run it from /Users/someone/src.",
      "Run it from /home/someone/src.",
      "Run it from /root/.config/vector.",
      "Run it from C:\\Users\\someone\\src.",
      "Logs are in /tmp/claude-0/scratchpad.",
    ]
    expect(caught.filter((sentence) => !MACHINE_PATH.test(sentence))).toEqual([])
    const allowed = [
      "The page is packages/web/src/drafts/docs/everywhere.astro.",
      "See /docs/vectorscope#github and /legal/privacy#codium.",
      "The Account ID column on /owner/codium.",
      "The cron calls /api/everywhere/sweep.",
      'Make the pair in a new folder: cd "$(mktemp -d)".',
    ]
    expect(allowed.filter((sentence) => MACHINE_PATH.test(sentence))).toEqual([])
  })
})
