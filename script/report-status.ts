// The owner's tool for the report tracker (WP A33): sets a bug report's status, and for a fix records the release in
// packages/web/src/data/fixed-reports.json, from which the public changelog lists the report's hash so the desktop can
// say "A problem you reported is fixed in this version".
//
//   bun script/report-status.ts <report-id> <status> [--fixed-in <version>] [--commit <sha>] [--mode live|test]
//
// <status> is received, read, fixing, fixed or closed; fixed needs --fixed-in, the release that carries the fix. The
// store comes from KV_REST_API_URL and KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_*), as on vectordev.ai; they are
// never printed. Records live under the Codium store prefix of the mode vectordev.ai ran in when the report arrived
// (test until a live Stripe key is configured), so without --mode both modes are looked in. Nothing promises a
// response time: a status says what was done, never when.
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type { StripeMode } from "../api/_lib/model-plan-stripe"
import {
  isReportStatus,
  REPORT_STATUSES,
  reportHash,
  setReportStatus,
  validReportCommit,
  validReportId,
  validReportVersion,
  type ReportStatus,
} from "../api/_lib/support-reports"

export const FIXED_REPORTS_FILE = path.join(import.meta.dir, "..", "packages/web/src/data/fixed-reports.json")
const HASH = /^[0-9a-f]{16}$/

/** Release version → hashes of the reports it fixed, as packages/web/scripts/build-changelog.ts reads it. */
export type FixedReports = Record<string, string[]>

export type ReportStatusArguments = {
  id: string
  status: ReportStatus
  fixedIn?: string
  commit?: string
  mode?: StripeMode
}

/** Reads the command line, or throws with what is wrong. */
export function parseReportStatusArguments(argv: readonly string[]): ReportStatusArguments {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]!
    if (!value.startsWith("--")) {
      positional.push(value)
      continue
    }
    const name = value.slice(2)
    const next = argv[index + 1]
    if (!["fixed-in", "commit", "mode"].includes(name) || next === undefined || next.startsWith("--"))
      throw new Error(`Unknown or empty option ${value}.`)
    flags[name] = next
    index++
  }
  const [id, status, ...rest] = positional
  if (rest.length || !id || !status)
    throw new Error("Usage: bun script/report-status.ts <report-id> <status> [--fixed-in <version>] [--commit <sha>]")
  if (!validReportId(id)) throw new Error("A report id is r_ followed by 26 letters and digits.")
  if (!isReportStatus(status)) throw new Error(`A status is one of: ${REPORT_STATUSES.join(", ")}.`)
  const fixedIn = flags["fixed-in"]
  const commit = flags.commit?.toLowerCase()
  const mode = flags.mode
  if (fixedIn !== undefined && !validReportVersion(fixedIn))
    throw new Error("The fixing release is a version like 1.99.114.")
  if (commit !== undefined && !validReportCommit(commit)) throw new Error("The fixing commit is 7 to 40 hex digits.")
  if (mode !== undefined && mode !== "live" && mode !== "test") throw new Error("--mode is live or test.")
  if (status === "fixed" && !fixedIn) throw new Error("A fixed report needs --fixed-in, the release that fixed it.")
  if (status !== "fixed" && (fixedIn || commit)) throw new Error("--fixed-in and --commit go with the fixed status.")
  return {
    id,
    status,
    ...(fixedIn ? { fixedIn } : {}),
    ...(commit ? { commit } : {}),
    ...(mode ? { mode: mode as StripeMode } : {}),
  }
}

export function validFixedReports(value: unknown): value is FixedReports {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.entries(value as Record<string, unknown>).every(
      ([version, hashes]) =>
        validReportVersion(version) &&
        Array.isArray(hashes) &&
        hashes.every((hash) => typeof hash === "string" && HASH.test(hash)) &&
        new Set(hashes).size === hashes.length,
    )
  )
}

/** The list with the report's hash under `version`, and under no other release; versions and hashes stay sorted. */
export function withFixedReport(list: FixedReports, version: string, id: string): FixedReports {
  const hash = reportHash(id)
  const next: FixedReports = {}
  for (const key of Object.keys({ ...list, [version]: [] }).sort(compareVersions)) {
    const hashes = (list[key] ?? []).filter((item) => item !== hash)
    if (key === version) hashes.push(hash)
    if (hashes.length) next[key] = hashes.sort()
  }
  return next
}

/** The list without the report's hash, for a report whose fix was taken back. */
export function withoutFixedReport(list: FixedReports, id: string): FixedReports {
  const hash = reportHash(id)
  return Object.fromEntries(
    Object.entries(list)
      .map(([version, hashes]) => [version, hashes.filter((item) => item !== hash)] as const)
      .filter(([, hashes]) => hashes.length),
  )
}

function compareVersions(left: string, right: string) {
  const a = left.split(".").map(Number)
  const b = right.split(".").map(Number)
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return (a[index] ?? 0) - (b[index] ?? 0)
  return 0
}

async function main(argv: readonly string[]) {
  const input = parseReportStatusArguments(argv)
  const update = {
    status: input.status,
    ...(input.fixedIn ? { fixedIn: input.fixedIn } : {}),
    ...(input.commit ? { commit: input.commit } : {}),
  }
  const modes: StripeMode[] = input.mode ? [input.mode] : ["live", "test"]
  let found: StripeMode | undefined
  for (const mode of modes) {
    if (await setReportStatus(input.id, update, { mode })) {
      found = mode
      break
    }
  }
  if (!found)
    throw new Error(
      `${input.id} is not in the store${input.mode ? ` under ${input.mode} mode` : ""}: it was never stored, is older than 180 days, or was erased with its account.`,
    )
  const raw: unknown = JSON.parse(await readFile(FIXED_REPORTS_FILE, "utf8"))
  if (!validFixedReports(raw)) throw new Error(`${FIXED_REPORTS_FILE} is not a list of releases and report hashes.`)
  const next = input.fixedIn ? withFixedReport(raw, input.fixedIn, input.id) : withoutFixedReport(raw, input.id)
  if (JSON.stringify(next) !== JSON.stringify(raw))
    await writeFile(FIXED_REPORTS_FILE, `${JSON.stringify(next, null, 2)}\n`)
  console.log(
    `${input.id}: ${input.status}${input.fixedIn ? ` in ${input.fixedIn}` : ""} (${found} store).` +
      (input.fixedIn
        ? " Commit packages/web/src/data/fixed-reports.json with that release so its changelog lists the fix."
        : ""),
  )
}

if (import.meta.main) {
  await main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
