import type { Highlight } from "@/components/dialog-release-notes"
import { FIXED_REPORT_TITLE, type LocalReport } from "@/support-reports"

/*
 * What's New, as data: the changelog vectordev.ai publishes (packages/web/scripts/build-changelog.ts) read into the
 * highlights of the releases between the version seen last and this one. A release that fixed reports also lists
 * their hashes (`fixedReports`, WP A33); when one matches a report this computer sent, What's New opens with
 * "A problem you reported is fixed in this version". The match happens here, on this computer: the changelog names no
 * report, and the report ids never leave the desktop's main process.
 */

type ParsedRelease = {
  tag?: string
  highlights: Highlight[]
  fixedReports: string[]
}

const HASH = /^[0-9a-f]{16}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function getText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const text = value.trim()
    return text.length > 0 ? text : undefined
  }

  if (typeof value === "number") return String(value)
  return
}

function normalizeVersion(value: string | undefined) {
  const text = value?.trim()
  if (!text) return
  return text.startsWith("v") || text.startsWith("V") ? text.slice(1) : text
}

function parseMedia(value: unknown, alt: string): Highlight["media"] | undefined {
  if (!isRecord(value)) return
  const type = getText(value.type)?.toLowerCase()
  const src = getText(value.src) ?? getText(value.url)
  if (!src) return
  if (type !== "image" && type !== "video") return

  return { type, src, alt }
}

function parseHighlight(value: unknown): Highlight | undefined {
  if (!isRecord(value)) return

  const title = getText(value.title)
  if (!title) return

  const description = getText(value.description) ?? getText(value.shortDescription)
  if (!description) return

  const media = parseMedia(value.media, title)
  return { title, description, media }
}

function parseFixedReports(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.filter((hash): hash is string => typeof hash === "string" && HASH.test(hash))
}

function parseRelease(value: unknown): ParsedRelease | undefined {
  if (!isRecord(value)) return
  const tag = getText(value.tag) ?? getText(value.tag_name) ?? getText(value.name)
  const fixedReports = parseFixedReports(value.fixedReports)

  if (!Array.isArray(value.highlights)) {
    return { tag, highlights: [], fixedReports }
  }

  const highlights = value.highlights.flatMap((group) => {
    if (!isRecord(group)) return []

    const source = getText(group.source)
    if (!source) return []
    if (!source.toLowerCase().includes("desktop")) return []

    if (Array.isArray(group.items)) {
      return group.items.map((item) => parseHighlight(item)).filter((item): item is Highlight => item !== undefined)
    }

    const item = parseHighlight(group)
    if (!item) return []
    return [item]
  })

  return { tag, highlights, fixedReports }
}

export function parseChangelog(value: unknown): ParsedRelease[] | undefined {
  if (Array.isArray(value)) {
    return value.map(parseRelease).filter((release): release is ParsedRelease => release !== undefined)
  }

  if (!isRecord(value)) return
  if (!Array.isArray(value.releases)) return

  return value.releases.map(parseRelease).filter((release): release is ParsedRelease => release !== undefined)
}

/** The releases newer than `previous`, up to and including `current`, newest first. */
function releasesBetween(input: { releases: ParsedRelease[]; current?: string; previous?: string }) {
  const current = normalizeVersion(input.current)
  const previous = normalizeVersion(input.previous)
  const releases = input.releases

  const start = (() => {
    if (!current) return 0
    const index = releases.findIndex((release) => normalizeVersion(release.tag) === current)
    return index === -1 ? 0 : index
  })()

  const end = (() => {
    if (!previous) return releases.length
    const index = releases.findIndex((release, i) => i >= start && normalizeVersion(release.tag) === previous)
    return index === -1 ? releases.length : index
  })()

  return releases.slice(start, end)
}

function sliceHighlights(input: { releases: ParsedRelease[]; current?: string; previous?: string }) {
  const highlights = releasesBetween(input).flatMap((release) => release.highlights)
  const seen = new Set<string>()
  const unique = highlights.filter((highlight) => {
    const key = dedupeKey(highlight)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return unique.slice(0, 5)
}

function dedupeKey(highlight: Highlight) {
  return [highlight.title, highlight.description, highlight.media?.type ?? "", highlight.media?.src ?? ""].join("\n")
}

export function loadReleaseHighlights(value: unknown, current?: string, previous?: string) {
  const releases = parseChangelog(value)
  if (!releases?.length) return []
  return sliceHighlights({ releases, current, previous })
}

/**
 * The reports this computer sent that a release in the update fixed, newest first. The changelog is the only source:
 * nothing else says a report was fixed.
 */
export function fixedReports(value: unknown, reports: readonly LocalReport[], current?: string, previous?: string) {
  const releases = parseChangelog(value)
  if (!releases?.length || !reports.length) return []
  const fixed = new Set(releasesBetween({ releases, current, previous }).flatMap((release) => release.fixedReports))
  return reports.filter((report) => fixed.has(report.hash)).sort((a, b) => b.sentAt - a.sentAt)
}

/** The highlight that opens What's New when the update fixed reports this computer sent, or undefined. */
export function fixedReportHighlight(
  value: unknown,
  reports: readonly LocalReport[],
  current?: string,
  previous?: string,
): Highlight | undefined {
  const matched = fixedReports(value, reports, current, previous)
  if (!matched.length) return
  return {
    title: FIXED_REPORT_TITLE,
    description:
      matched.length === 1
        ? "Thank you for reporting it. Settings > Account shows each report you sent and what became of it."
        : `${matched.length} problems you reported are fixed. Thank you for reporting them. Settings > Account shows each report you sent and what became of it.`,
    reports: matched.map((report) => report.title).filter(Boolean),
  }
}
