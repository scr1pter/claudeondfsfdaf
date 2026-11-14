import { app } from "electron"
import { createHash } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { arch, platform } from "node:os"
import { dirname, join } from "node:path"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { EgressGuard } from "@vectordevai/core/local-mode/guard"

// Bug reports are sent from the main process so the packaged renderer, which
// runs on a custom protocol, never has to reach the network itself.
const API = (process.env.VECTOR_SUPPORT_API_URL || "https://vectordev.ai/api/support").replace(/\/$/, "")

export type BugReportInput = { message: string; email?: string }
export type BugReportResult = { delivered: boolean; tracked?: boolean; error?: string }

/** A report this computer sent (WP A33), as the renderer sees it: no id, only the hash the changelog would list. */
export type LocalReport = { hash: string; title: string; sentAt: number }
export type ReportStatusView = LocalReport & { status?: string; fixedIn?: string; commit?: string }
export type ReportStatuses = {
  reports: ReportStatusView[]
  /** ok: statuses came from vectordev.ai; local-off: Vector Local keeps the check off; unavailable: it failed. */
  checked: "ok" | "local-off" | "unavailable"
}

type StoredReport = { id: string; title: string; sentAt: number }
export type ReportDependencies = {
  /** The signed-in account token, so the report carries the plan's tag and limit. */
  token?: () => Promise<string | undefined>
  fetch?: typeof fetch
  /** reports.json; userData by default. */
  file?: string
  now?: () => number
  version?: string
}

const REPORT_ID = /^r_[a-z2-7]{26}$/
const TITLE = 60
const KEEP_MS = 180 * 24 * 60 * 60 * 1000
const KEEP = 100
const STATUS = /^[a-z][a-z-]{0,31}$/
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/
const COMMIT = /^[0-9a-f]{7,40}$/
let writes: Promise<unknown> = Promise.resolve()

const reportsFile = (deps: ReportDependencies) => deps.file ?? join(app.getPath("userData"), "reports.json")

/** The title this computer keeps for a report: its first line, at most 60 characters. Never sent anywhere. */
export function reportTitle(message: string) {
  const line =
    message
      .split(/\r?\n/)
      .map((part) => part.replace(/\s+/g, " ").trim())
      .find(Boolean) ?? ""
  return line.length > TITLE ? `${line.slice(0, TITLE - 1).trimEnd()}…` : line
}

/** What the changelog lists for a fixed report: the first 16 hex digits of the id's SHA-256. */
export function reportHash(id: string) {
  return createHash("sha256").update(id).digest("hex").slice(0, 16)
}

export async function sendBugReport(input: BugReportInput, deps: ReportDependencies = {}): Promise<BugReportResult> {
  const message = String(input?.message ?? "").trim()
  if (!message) return { delivered: false, error: "Describe the bug before sending the report." }
  const send = deps.fetch ?? fetch
  const body = JSON.stringify({
    message,
    email: input.email?.trim() || undefined,
    version: deps.version ?? app.getVersion(),
    platform: platform(),
    arch: arch(),
    channel: process.env.VECTOR_CHANNEL || "prod",
  })
  const post = (token?: string) =>
    send(`${API}/bug-report`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    }).catch((cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))))

  // Signed in, the report carries the account token, so a paid plan's tag and limit apply. A token vectordev.ai no
  // longer accepts (expired or revoked) never costs the report: it is sent again without one.
  const token = await deps.token?.().catch(() => undefined)
  let response = await post(token)
  if (token && !(response instanceof Error) && response.status === 401) response = await post()

  if (response instanceof Error) {
    return { delivered: false, error: "Vector could not reach the report service. Check your connection." }
  }
  if (!response.ok) {
    const failure = (await response.json().catch(() => undefined)) as { error?: { message?: string } } | undefined
    return { delivered: false, error: failure?.error?.message ?? "The report could not be delivered." }
  }
  const answer: unknown = await response.json().catch(() => undefined)
  if (!answer || typeof answer !== "object" || !("delivered" in answer) || answer.delivered !== true)
    return { delivered: false, error: "Vector could not confirm report delivery. Your draft is still here." }
  const id =
    "report" in answer && answer.report && typeof answer.report === "object" && "id" in answer.report
      ? answer.report.id
      : undefined
  if (typeof id !== "string" || !REPORT_ID.test(id)) return { delivered: true, tracked: false }
  const kept = await keepReport({ id, title: reportTitle(message), sentAt: (deps.now ?? Date.now)() }, deps)
    .then(() => true)
    .catch(() => false)
  return { delivered: true, tracked: kept }
}

/** The reports this computer sent in the last 180 days, newest first, without their ids. */
export async function listReports(deps: ReportDependencies = {}): Promise<LocalReport[]> {
  return (await readReports(deps)).map(({ id, title, sentAt }) => ({ hash: reportHash(id), title, sentAt }))
}

/**
 * Each report with its status from vectordev.ai (`POST /api/support/reports`). The ids go only there, in the body. With
 * no reports nothing is sent. Vector Local keeps this check off unless the person allows `report-status`.
 */
export async function reportStatuses(deps: ReportDependencies = {}): Promise<ReportStatuses> {
  const stored = await readReports(deps)
  const local = stored.map(({ id, title, sentAt }) => ({ hash: reportHash(id), title, sentAt }))
  if (!stored.length) return { reports: [], checked: "ok" }
  const response = await Egress.fetch(
    "report-status",
    `${API}/reports`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: stored.map((report) => report.id) }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    },
    deps.fetch ? (target, options) => deps.fetch!(target, options) : undefined,
  ).catch((cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))))
  if (response instanceof EgressGuard.EgressBlocked) return { reports: local, checked: "local-off" }
  if (response instanceof Error || !response.ok) return { reports: local, checked: "unavailable" }
  const answer: unknown = await response.json().catch(() => undefined)
  const rows =
    answer && typeof answer === "object" && "reports" in answer && Array.isArray(answer.reports)
      ? answer.reports
      : undefined
  if (!rows) return { reports: local, checked: "unavailable" }
  const statuses = new Map<string, { status: string; fixedIn?: string; commit?: string }>()
  for (const row of rows) {
    if (!row || typeof row !== "object") continue
    const { id, status, fixedIn, commit } = row as Record<string, unknown>
    if (typeof id !== "string" || typeof status !== "string" || !STATUS.test(status)) continue
    statuses.set(id, {
      status,
      ...(typeof fixedIn === "string" && VERSION.test(fixedIn) ? { fixedIn } : {}),
      ...(typeof commit === "string" && COMMIT.test(commit) ? { commit } : {}),
    })
  }
  return {
    reports: stored.map((report, index) => ({ ...local[index]!, ...statuses.get(report.id) })),
    checked: "ok",
  }
}

async function readReports(deps: ReportDependencies): Promise<StoredReport[]> {
  const raw = await readFile(reportsFile(deps), "utf8").catch(() => undefined)
  if (!raw) return []
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return []
  }
  const list = value && typeof value === "object" && "reports" in value ? value.reports : undefined
  if (!Array.isArray(list)) return []
  const now = (deps.now ?? Date.now)()
  return list
    .flatMap((entry): StoredReport[] => {
      if (!entry || typeof entry !== "object") return []
      const { id, title, sentAt } = entry as Record<string, unknown>
      if (typeof id !== "string" || !REPORT_ID.test(id) || typeof title !== "string" || !Number.isSafeInteger(sentAt))
        return []
      if (now - (sentAt as number) > KEEP_MS) return []
      return [{ id, title: title.slice(0, TITLE), sentAt: sentAt as number }]
    })
    .sort((a, b) => b.sentAt - a.sentAt)
    .slice(0, KEEP)
}

function keepReport(report: StoredReport, deps: ReportDependencies) {
  const write = writes.then(async () => {
    const file = reportsFile(deps)
    const reports = [report, ...(await readReports(deps)).filter((entry) => entry.id !== report.id)].slice(0, KEEP)
    await mkdir(dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify({ v: 1, reports }), { mode: 0o600 })
    await rename(temporary, file)
  })
  writes = write.catch(() => undefined)
  return write
}
