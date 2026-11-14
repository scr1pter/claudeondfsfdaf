/*
 * The report tracker as the app sees it (WP A33). The desktop main process keeps the ids of the bug reports this
 * computer sent and asks vectordev.ai what became of them; the app only ever sees each report's title (the first 60
 * characters this computer kept), when it was sent, the hash the public changelog would list for it, and its status.
 * All of it is free for everyone: nothing here depends on a plan.
 */

/** A report this computer sent: the hash is the first 16 hex digits of its id's SHA-256, as the changelog lists it. */
export type LocalReport = { hash: string; title: string; sentAt: number }
export type ReportStatusView = LocalReport & { status?: string; fixedIn?: string; commit?: string }
export type ReportStatuses = {
  reports: ReportStatusView[]
  /** ok: statuses came from vectordev.ai; local-off: Vector Local keeps the check off; unavailable: it failed. */
  checked: "ok" | "local-off" | "unavailable"
}

export type ReportsPlatform = {
  /** The reports this computer sent in the last 180 days, newest first. Reads nothing from the network. */
  list(): Promise<LocalReport[]>
  /** The same reports with their statuses from vectordev.ai. */
  status(): Promise<ReportStatuses>
}

/** What's New shows this when a release in the update fixed a report this computer sent. */
export const FIXED_REPORT_TITLE = "A problem you reported is fixed in this version"

/**
 * A report's status as Settings > Account words it. A status this version does not know, or none at all, reads
 * "Received": the report reached the team, and nothing here promises when anything more happens.
 */
export function reportStatusLabel(report: Pick<ReportStatusView, "status" | "fixedIn">) {
  switch (report.status) {
    case "read":
      return "Read by the Vector team"
    case "fixing":
      return "Being fixed"
    case "fixed":
      return report.fixedIn ? `Fixed in v${report.fixedIn}` : "Fixed"
    case "closed":
      return "Closed"
    default:
      return "Received"
  }
}

/** The line under the list of reports, for a check that did not come back with statuses. */
export function reportCheckNote(checked: ReportStatuses["checked"]) {
  if (checked === "local-off")
    return "Vector Local keeps status checks off. Allow Report status in Vector Local to see what happened to each report."
  if (checked === "unavailable") return "Vector could not check for updates to your reports. Try again shortly."
  return undefined
}

/** The short form of a fixing commit, as Settings shows it. */
export function shortCommit(commit: string | undefined) {
  return commit ? commit.slice(0, 7) : undefined
}
