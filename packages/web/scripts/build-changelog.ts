// Emits public/changelog.json, the feed the desktop app polls on launch to show
// "what's new". The file has never existed, so the release-notes dialog has
// never once run. Generated from the same release series the site renders, so
// the two cannot drift apart.
import fixedReports from "../src/data/fixed-reports.json"
import { release117, release118, release119, release199, releaseSeries } from "../src/data/vector-releases"

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/
const HASH = /^[0-9a-f]{16}$/

/**
 * The hashes of the reports each release fixed (WP A33), from fixed-reports.json, which the owner's
 * `script/report-status.ts` writes. Each is the first 16 hex digits of a report id's SHA-256, so the changelog names no
 * report and no person; the desktop matches them against the report ids it keeps. A malformed file fails the build.
 */
export function fixedReportHashes(value: unknown = fixedReports): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("fixed-reports.json must map release versions to report hashes.")
  for (const [version, hashes] of Object.entries(value)) {
    if (
      !VERSION.test(version) ||
      !Array.isArray(hashes) ||
      !hashes.every((hash) => typeof hash === "string" && HASH.test(hash)) ||
      new Set(hashes).size !== hashes.length
    )
      throw new Error(`fixed-reports.json: ${version} must list distinct 16-digit report hashes.`)
  }
  return value as Record<string, string[]>
}

/** The changelog's releases, newest first. A release that fixed reports lists their hashes as `fixedReports`. */
export function changelogReleases(fixed: Record<string, string[]> = fixedReportHashes()) {
  // Both arrays: releaseSeries is the 1.0-1.17 arc, release117 the 1.17.x
  // point releases the desktop app actually ships as.
  return [...releaseSeries, ...release117, ...release118, ...release119, ...release199].reverse().map((release) => ({
    tag: `v${release.version}`,
    highlights: [
      {
        // The reader keeps only highlight groups whose source mentions "desktop".
        source: "desktop",
        items: [{ title: release.title, description: release.summary }],
      },
    ],
    ...(fixed[release.version]?.length ? { fixedReports: fixed[release.version] } : {}),
  }))
}

if (import.meta.main) {
  const releases = changelogReleases()
  await Bun.write(`${import.meta.dir}/../public/changelog.json`, JSON.stringify({ releases }, null, 2))
  console.log(`changelog.json: ${releases.length} releases, newest ${releases[0]?.tag}`)
}
