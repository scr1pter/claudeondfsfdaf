import { expect, test } from "bun:test"
import path from "node:path"

// Owner decision (27 Oct 2026): Codium sells monthly plans only, with no top-ups (codium-tiers-v3-changes.md §3).
// Contract WP A29's done criterion: `git grep -i 'topup\|top-up\|purchased'` finds only OpenRouter's own auto top-up,
// packages/core/src/free-model-choice.ts, release notes and the "no top-ups" phrases. This test runs that search and
// holds every match to the reasons below, so a new top-up offer or a purchased-credits line cannot come back unnoticed.

const root = path.resolve(import.meta.dir, "..")
const self = "test/no-topups.test.ts"
const SEARCH = /topups?|top-ups?|purchased/i

// Words that contain the search without being about top-ups: the desktop updater ("desktopUpdater", "desktop-update").
const UNRELATED = [/desktop[-_]?updat/gi]

/** Whole files, or every file under a prefix or matching a pattern, kept for the reason given. */
const FILES: { file: string | RegExp; reason: string }[] = [
  {
    file: /^docs\/vector\/build\//,
    reason: "The build contract, plans and per-package notes record the removal itself.",
  },
  { file: /^docs\/vector\/handoff-2026-10\//, reason: "Dated handoff notes are history." },
  {
    file: /(?:^|\/)(?:test|tests|e2e)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/,
    reason: "Tests and fixtures assert the removal and decode records written while top-ups existed.",
  },
  {
    file: "packages/core/src/free-model-choice.ts",
    reason: "OpenRouter's own automatic top-ups on a personal free account (named by the contract).",
  },
  {
    file: "api/_lib/codium-funding.ts",
    reason: "The watchdog for OpenRouter's own auto top-up on the Codium account (WP A11).",
  },
  {
    file: "docs/vector/FREE-MODELS.md",
    reason: "OpenRouter's own credits, purchases and auto top-up on the free-models account.",
  },
  {
    file: "docs/vector/owner-actions/release-approval.md",
    reason: "Release approval steps that keep OpenRouter's top-ups off the free-models account.",
  },
  {
    file: "api/model-plans/topup.ts",
    reason: "The removed top-up route, which answers JSON 410 MODEL_TOPUP_REMOVED for older clients.",
  },
  {
    file: "packages/core/src/model-plan-status.ts",
    reason: "The client decodes the legacy purchased field and ignores an older site's top-ups (H7).",
  },
  {
    file: "api/_lib/codium-ledger.ts",
    reason: "A ledger line written before the removal still decodes as kind topup; nothing writes one.",
  },
  {
    file: "packages/schema/src/codium-plan.ts",
    reason: "The deprecated, empty TOPUPS export stays until its last reader is gone (contract §4.1).",
  },
  {
    file: "packages/web/scripts/model-plan-setup.ts",
    reason: "Setup archives the legacy top-up prices an earlier version created (contract §2).",
  },
  {
    file: "packages/web/scripts/setup-model-plans.ts",
    reason: "Setup archives the legacy top-up prices an earlier version created (contract §2).",
  },
  {
    file: "packages/cloud/src/codium-ci-tests.ts",
    reason: "The CI lane selects the test files that guard the removal by their names.",
  },
  {
    file: "packages/web/src/data/vector-releases.ts",
    reason: "Shipped release notes keep the words they shipped with.",
  },
  { file: "packages/web/public/changelog.json", reason: "Shipped release notes keep the words they shipped with." },
  {
    file: "packages/web/src/pages/legal/terms.astro",
    reason: "Legal pages change only in A60's release commit (H8); A30 drafts the replacement on codium-legal.",
  },
  {
    file: "packages/web/src/pages/legal/privacy.astro",
    reason: "Legal pages change only in A60's release commit (H8); A30 drafts the replacement on codium-legal.",
  },
]

/** Phrases allowed anywhere. A line passes when nothing matching the search is left once these are taken out. */
const PHRASES: { pattern: RegExp; reason: string }[] = [
  {
    pattern:
      /\bno\s+(?:more\s+)?`?top-?ups?`?|\bsells? no top-?ups\b|\bno longer sells? top-?ups\b|\btop-?ups (?:are gone|were removed)\b|\bwhile top-?ups existed\b|\bsold top-?ups\b/gi,
    reason: 'Saying there are no top-ups ("no top-ups", "sells no top-ups", "the route that sold top-ups").',
  },
  {
    pattern:
      /\bauto(?:matic)? top-?ups?\b|\btopupWatchdog\b|\w*OPENROUTER_TOPUP_THRESHOLD\w*|\bcredits purchased over the account's life\b/gi,
    reason:
      "OpenRouter's own auto top-up and credit purchases, which fund an OpenRouter balance; Vector never sells them.",
  },
  {
    pattern: /\blegacy (?:Codium )?top-?ups?\b/gi,
    reason: "The legacy top-up prices, links and intents that are archived or ignored.",
  },
  {
    pattern: /\bMODEL_TOPUP_(?:REMOVED|EXHAUSTED)\b|\bhandleModelTopupRemoved\b|\/api\/model-plans\/topup\b/g,
    reason: "The removed route's 410 answer, and the code that is never sent again.",
  },
  {
    pattern: /\bSTRIPE_MODEL_TOPUP_\*|\bMODEL_TOPUP_\*_CREDITS_USD\b|\bSTRIPE_MODEL_TOPUP_\{[^}]*\}_PRICE_ID\b/g,
    reason: "Removed variables, named only to say nothing reads them.",
  },
  {
    pattern: /\bpurchased:\s*\{\s*bought:\s*false\s*\}/g,
    reason: "The legacy status field every answer still carries for older decoders (H7).",
  },
  {
    pattern: /[?&]model_topup=/g,
    reason: "The legacy return parameter older desktops ignore.",
  },
  {
    // The 1.99.108 release notes, as shipped; docs-content.ts repeats them word for word in its changelog.
    pattern:
      /whether purchased credits are available, running low or used up, never an amount|lists \$10, \$50, \$100 and \$200 monthly plans and top-ups, and its buttons say Coming soon until sales open/g,
    reason: "Shipped release notes keep the words they shipped with.",
  },
]

/** Single lines kept as they are, each matching exactly one line of its file. */
const LINES: { file: string; line: string; reason: string }[] = [
  {
    file: "api/_lib/codium-keys.ts",
    line: "// `Codium <id> …` is the name purchased-credit keys had before this change.",
    reason: "The funding check still recognises keys created under the old name.",
  },
  {
    file: "api/_lib/model-plan-account.ts",
    line: "// Codium sells monthly plans only (WP A04). A record written while top-ups existed may still carry `topupCheckout`,",
    reason: "An account record written before the removal still decodes; its old fields are ignored.",
  },
  {
    file: "api/_lib/model-plan-account.ts",
    line: "// purchased credits that would need honouring.",
    reason: "Explains why the old fields need no migration: sales never opened.",
  },
  {
    file: "api/_lib/model-plan-billing.ts",
    line: "* nothing; an older Vector that still offers a top-up shows the message instead of a bare 404.",
    reason: "Explains the removed route's 410 answer.",
  },
  {
    file: "packages/app/src/components/settings-v2/account-model.ts",
    line: "* monthly plans only, so nothing here speaks of credits or top-ups. While Codium is not on sale and the account has",
    reason: "Says the account model has no top-ups.",
  },
  // The website decodes the legacy fields of older servers (H7) and offers nothing from them: each line is listed, so
  // a new top-up offer or message in this file is still caught.
  ...[
    "topups?: ModelPlan[]",
    "purchased?: { bought: boolean; state?: LegacyCreditState }",
    "(value.topups !== undefined && !Array.isArray(value.topups)) ||",
    "const packs = Array.isArray(value.topups) ? value.topups.map(readPlan) : undefined",
    "...(packs === undefined ? {} : { topups: packs }),",
    "const legacy = value.purchased === undefined ? undefined : readLegacyCredits(value.purchased)",
    "...(legacy ? { purchased: legacy } : {}),",
  ].map((line) => ({
    file: "packages/web/src/lib/model-plans.ts",
    line,
    reason: "The website still decodes an older server's topups and purchased fields; nothing offers them.",
  })),
]

type Match = { file: string; line: number; text: string }

function search(): Match[] {
  const result = Bun.spawnSync(
    ["git", "grep", "-n", "-I", "-i", "-z", "-e", "topup", "-e", "top-up", "-e", "purchased"],
    {
      cwd: root,
    },
  )
  // git grep exits 1 when nothing matches, and 2 or more on an error.
  if (result.exitCode > 1) throw new Error(result.stderr.toString())
  return result.stdout
    .toString()
    .split("\n")
    .filter(Boolean)
    .map((row) => {
      const [file, line, ...text] = row.split("\0")
      return { file: file!, line: Number(line), text: text.join("\0") }
    })
}

const fileReason = (file: string) =>
  FILES.find((entry) => (typeof entry.file === "string" ? entry.file === file : entry.file.test(file)))

function remainder(text: string) {
  let rest = text
  for (const pattern of [...UNRELATED, ...PHRASES.map((entry) => entry.pattern)]) rest = rest.replace(pattern, " ")
  return rest
}

function violation(match: Match) {
  if (match.file === self) return false
  if (fileReason(match.file)) return false
  if (LINES.some((entry) => entry.file === match.file && entry.line === match.text.trim())) return false
  return SEARCH.test(remainder(match.text))
}

const matches = search()

test("every top-up or purchased mention in the repository is one the reasons allow", () => {
  // The search has to reach the sources it guards, or an empty result would mean nothing.
  expect(matches.length).toBeGreaterThan(100)
  expect(matches.some((match) => match.file === "api/model-plans/topup.ts")).toBe(true)
  const found = matches.filter(violation).map((match) => `${match.file}:${match.line}: ${match.text.trim()}`)
  expect(found).toEqual([])
})

test("each named file and line still has a match, so the allowances stay as small as they can", async () => {
  for (const entry of FILES) {
    expect(entry.reason.length).toBeGreaterThan(0)
    if (typeof entry.file === "string") expect(matches.some((match) => match.file === entry.file)).toBe(true)
  }
  for (const entry of LINES) {
    expect(entry.reason.length).toBeGreaterThan(0)
    const lines = (await Bun.file(path.join(root, entry.file)).text()).split("\n")
    expect(lines.filter((line) => line.trim() === entry.line)).toHaveLength(1)
    expect(SEARCH.test(remainder(entry.line))).toBe(true)
  }
  for (const entry of PHRASES) expect(entry.reason.length).toBeGreaterThan(0)
})

// Codium is monthly plans, its usage shown as a share of the month (codium-tiers-v3-changes.md): nothing the app or
// the core says about it speaks of credits. Two phrases stay: free models need "no payment or credits", and older
// servers' " Buy credits at …" suffix is still recognised so it can be replaced.
const CREDIT_SOURCES = ["packages/app/src", "packages/core/src"]
const CREDIT_COPY_ALLOWED = [/\bno payment or credits needed\b/gi, /^ Buy credits at \$\{PURCHASE_URL\}$/g]
const LITERAL = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g

/** Prose string literals (they hold a space) that say "credits", outside comments and tests. */
function creditCopy(rows: readonly Match[]) {
  return rows.flatMap((row) => {
    const code = row.text.trim()
    if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return []
    return [...row.text.matchAll(LITERAL)]
      .map((literal) => literal[2]!)
      .filter((literal) => /\s/.test(literal) && /\bcredits\b/i.test(literal))
      .filter((literal) =>
        /\bcredits\b/i.test(CREDIT_COPY_ALLOWED.reduce((rest, allowed) => rest.replace(allowed, " "), literal)),
      )
      .map((literal) => `${row.file}:${row.line}: ${literal}`)
  })
}

test("app and core copy never speaks of Codium credits", () => {
  const result = Bun.spawnSync(
    ["git", "grep", "-n", "-I", "-i", "-z", "-e", "credits", "--", ...CREDIT_SOURCES, ":!*.test.ts", ":!*.test.tsx"],
    { cwd: root },
  )
  if (result.exitCode > 1) throw new Error(result.stderr.toString())
  const rows = result.stdout
    .toString()
    .split("\n")
    .filter(Boolean)
    .map((row) => {
      const [file, line, ...text] = row.split("\0")
      return { file: file!, line: Number(line), text: text.join("\0") }
    })
  expect(rows.length).toBeGreaterThan(0)
  expect(creditCopy(rows)).toEqual([])
  const caught = (text: string) => creditCopy([{ file: "packages/app/src/x.ts", line: 1, text }]).length > 0
  expect(caught('  why: "Lists Vector Codium plans and credits",')).toBe(true)
  expect(caught('? "Runs on Vector Codium, since it spends your credits."')).toBe(true)
  expect(caught('body: "Use free models with no payment or credits needed."')).toBe(false)
  expect(caught("const LEGACY_CREDITS = ` Buy credits at ${PURCHASE_URL}`")).toBe(false)
  expect(caught('if (action !== "credits") return')).toBe(false)
  expect(caught("// the share of this month's credits left")).toBe(false)
})

test("the check catches a top-up offer and leaves the allowed phrases alone", () => {
  const caught = (text: string, file = "packages/web/src/components/marketing/codium/Offer.tsx") =>
    violation({ file, line: 1, text })
  for (const text of [
    "Buy a $10 top-up",
    "Top-ups carry forward until they are used.",
    "Your purchased credits are running low.",
    "topupCheckout(account, price)",
    "No top-ups here, but buy a top-up below.",
    "Keep automatic top-ups off, or add a top-up.",
  ])
    expect(caught(text)).toBe(true)
  for (const text of [
    "Monthly plans only, no top-ups",
    "There are no top-ups or overage charges.",
    "Codium sells no top-ups.",
    "Match the Codium account's dashboard auto top-up threshold.",
    "Keep automatic top-ups off.",
    "answers JSON 410 MODEL_TOPUP_REMOVED",
    "purchased: { bought: false },",
    "desktopUpdaterMetadataFiles",
    "Legacy top-up links and intents never select a product or trigger checkout.",
  ])
    expect(caught(text)).toBe(false)
  // A file allowed for one reason is still checked line by line once it leaves the list.
  expect(caught("Buy a $10 top-up", "api/_lib/codium-funding.ts")).toBe(false)
  expect(caught("Buy a $10 top-up", "api/_lib/codium-pool.ts")).toBe(true)
})
