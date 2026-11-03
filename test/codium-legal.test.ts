import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import path from "node:path"
import { CODIUM_CHECKOUT_CONSENT, CODIUM_TERMS_DATE } from "../api/_lib/codium-consent"

// Contract invariant H8: the legal pages change only in a release commit that bumps their dates. Each page is pinned
// here by its effective date, so editing a page without moving it to a new, pinned date fails. WP A30 drafts the
// Vector Codium terms and privacy changes on the codium-legal branch, which adds their checks to this file; A60's
// release commit merges it, sets both pages and CODIUM_TERMS_DATE to the release date and pins the new hashes.

const root = path.join(import.meta.dir, "..")
const PAGES = {
  terms: "packages/web/src/pages/legal/terms.astro",
  privacy: "packages/web/src/pages/legal/privacy.astro",
} as const
type Page = keyof typeof PAGES

/** sha256 of each page's source (LF line endings) at each effective date it carried. One hash per date. */
const PINNED: Record<Page, Record<string, string>> = {
  terms: {
    "October 28, 2026": "05491512221a30ef76b175cad4c7d78628530fce91b448a92a92ec0747d144c1",
  },
  privacy: {
    "October 28, 2026": "fcf0280dd3d0b34d008cd18f6084ec143821c1d1a33d7499db0a54fad350e26e",
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
