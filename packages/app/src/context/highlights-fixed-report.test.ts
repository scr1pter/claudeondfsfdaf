import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { FIXED_REPORT_TITLE, reportCheckNote, reportStatusLabel, shortCommit } from "@/support-reports"
import { fixedReportHighlight, fixedReports, loadReleaseHighlights } from "./highlights-model"

// WP A33: What's New says "A problem you reported is fixed in this version" when a release in the update lists the
// hash of a report this computer sent. The match is local: the changelog carries hashes only, and the desktop gives
// the app each report's hash and title, never its id.

const hash = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 16)
const FIXED = "r_aaaaaaaaaaaaaaaaaaaaaaaaaa"
const OTHER = "r_bbbbbbbbbbbbbbbbbbbbbbbbbb"
const OLDER = "r_cccccccccccccccccccccccccc"

const release = (version: string, fixed?: unknown[]) => ({
  tag: `v${version}`,
  highlights: [
    { source: "desktop", items: [{ title: `Vector ${version}`, description: `What changed in ${version}` }] },
  ],
  ...(fixed ? { fixedReports: fixed } : {}),
})
const changelog = {
  releases: [
    release("1.99.115"),
    release("1.99.114", [hash(FIXED), "not-a-hash", 7]),
    release("1.99.113"),
    release("1.99.112", [hash(OLDER)]),
  ],
}
const reports = [
  { hash: hash(FIXED), title: "The diff view froze on a big file", sentAt: 2_000 },
  { hash: hash(OTHER), title: "Settings closes on its own", sentAt: 3_000 },
  { hash: hash(OLDER), title: "Old problem", sentAt: 1_000 },
]

describe("fixed reports in What's New", () => {
  test("a report fixed by a release in the update opens What's New with the notice and its title", () => {
    const highlight = fixedReportHighlight(changelog, reports, "1.99.115", "1.99.113")
    expect(highlight).toMatchObject({
      title: "A problem you reported is fixed in this version",
      reports: ["The diff view froze on a big file"],
    })
    expect(highlight?.title).toBe(FIXED_REPORT_TITLE)
    expect(highlight?.description).not.toMatch(/\d+ problems/)
  })

  test("only releases newer than the last version seen count", () => {
    // 1.99.112's fix was already shown with that update.
    expect(fixedReports(changelog, reports, "1.99.115", "1.99.112").map((report) => report.title)).toEqual([
      "The diff view froze on a big file",
    ])
    expect(fixedReportHighlight(changelog, reports, "1.99.115", "1.99.114")).toBeUndefined()
    // Updating across both fixes lists both, newest report first.
    const both = fixedReportHighlight(changelog, reports, "1.99.115", "1.99.111")
    expect(both?.reports).toEqual(["The diff view froze on a big file", "Old problem"])
    expect(both?.description).toContain("2 problems you reported are fixed")
  })

  test("nothing shows without a matching report, and malformed hashes match nothing", () => {
    expect(fixedReportHighlight(changelog, [], "1.99.115", "1.99.113")).toBeUndefined()
    expect(fixedReportHighlight(changelog, [reports[1]!], "1.99.115", "1.99.111")).toBeUndefined()
    expect(fixedReportHighlight(changelog, [{ hash: "not-a-hash", title: "x", sentAt: 1 }], "1.99.115")).toBeUndefined()
    expect(fixedReportHighlight({ releases: "no" }, reports, "1.99.115")).toBeUndefined()
    expect(fixedReportHighlight(undefined, reports, "1.99.115")).toBeUndefined()
  })

  test("release highlights read as before the tracker", () => {
    expect(loadReleaseHighlights(changelog, "1.99.115", "1.99.113").map((item) => item.title)).toEqual([
      "Vector 1.99.115",
      "Vector 1.99.114",
    ])
    expect(loadReleaseHighlights([release("1.0.0")], "1.0.0")).toEqual([
      { title: "Vector 1.0.0", description: "What changed in 1.0.0", media: undefined },
    ])
    expect(loadReleaseHighlights({}, "1.0.0")).toEqual([])
  })
})

describe("Your reports in Settings > Account", () => {
  test("each status has its words, and a status this version does not know reads Received", () => {
    expect(reportStatusLabel({})).toBe("Received")
    expect(reportStatusLabel({ status: "received" })).toBe("Received")
    expect(reportStatusLabel({ status: "read" })).toBe("Read by the Vector team")
    expect(reportStatusLabel({ status: "fixing" })).toBe("Being fixed")
    expect(reportStatusLabel({ status: "fixed", fixedIn: "1.99.114" })).toBe("Fixed in v1.99.114")
    expect(reportStatusLabel({ status: "fixed" })).toBe("Fixed")
    expect(reportStatusLabel({ status: "closed" })).toBe("Closed")
    expect(reportStatusLabel({ status: "triaged-by-a-future-version" })).toBe("Received")
  })

  test("says why statuses are missing, and shortens the fixing commit", () => {
    expect(reportCheckNote("ok")).toBeUndefined()
    expect(reportCheckNote("local-off")).toContain("Vector Local")
    expect(reportCheckNote("unavailable")).toContain("could not check")
    expect(shortCommit("0123456789abcdef")).toBe("0123456")
    expect(shortCommit(undefined)).toBeUndefined()
  })

  test("no status promises a time", () => {
    const words = ["received", "read", "fixing", "fixed", "closed", undefined].map((status) =>
      reportStatusLabel({ status, fixedIn: "1.99.114" }),
    )
    expect(words.join(" ")).not.toMatch(/hour|day|soon|guarantee|24\/7|within/i)
  })
})
