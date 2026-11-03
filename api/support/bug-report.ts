import { Resend } from "resend"
import type { Entitlements } from "../../packages/schema/src/codium-entitlements.js"
import { enforceRateLimit, requireTrustedJsonRequest, stableAbuseIdentifier } from "../_lib/abuse.js"
import { readSnapshot } from "../_lib/codium-snapshot.js"
import {
  ApiError,
  handleApiError,
  json,
  readJson,
  requireMethod,
  type ApiRequest,
  type ApiResponse,
} from "../_lib/http.js"
import { requireUnrevokedCliToken } from "../_lib/revocation.js"
import { createReportRecord, discardReportRecord, newReportId, reportSubjectTag } from "../_lib/support-reports.js"

// Bug reports come from the desktop app's in-workspace bug button. The report
// body is user-authored text, so it is only ever rendered as escaped HTML and
// the reply-to address is validated before it reaches Resend.
const REPORT_TO = process.env.VECTOR_BUG_REPORT_TO || "krishnabharadwaj0521@gmail.com"
const MAX_MESSAGE = 8_000
const MAX_CONTEXT_FIELDS = 20
const MAX_CONTEXT_KEY = 64
const MAX_CONTEXT_VALUE = 500
/** Reports an hour: without a sign-in, per address; signed in without an active plan, per account. */
const FREE_PER_HOUR = 5
/**
 * A ceiling per address for signed-in reports, above the largest plan's own limit, so many accounts on one address
 * cannot flood the inbox.
 */
const SIGNED_IN_PER_ADDRESS_HOUR = 60
const HOUR_SECONDS = 60 * 60

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value)

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function optionalText(value: unknown, maximum: number) {
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "string") throw new ApiError(400, "REPORT_INVALID", "The report metadata is invalid.")
  const normalized = value.trim()
  if (normalized.length > maximum) throw new ApiError(400, "REPORT_INVALID", "The report metadata is too long.")
  return normalized || undefined
}

function reportContext(value: unknown) {
  if (value === undefined) return [] as [string, string][]
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "REPORT_INVALID", "The report context is invalid.")
  }
  const entries = Object.entries(value)
  if (entries.length > MAX_CONTEXT_FIELDS) {
    throw new ApiError(400, "REPORT_INVALID", "The report includes too many context fields.")
  }
  return entries.map(([key, raw]) => {
    const normalizedKey = key.trim()
    const normalizedValue = typeof raw === "string" ? raw.trim() : ""
    if (!normalizedKey || normalizedKey.length > MAX_CONTEXT_KEY || normalizedValue.length > MAX_CONTEXT_VALUE) {
      throw new ApiError(400, "REPORT_INVALID", "The report context is invalid.")
    }
    return [normalizedKey, normalizedValue] as [string, string]
  })
}

/**
 * Who sent the report. Without an Authorization header, nobody: the report is anonymous and limited per address. With
 * one, it must be a Vector account token (the desktop's or a CLI's) that is valid and not revoked, else 401; run tokens
 * never count here (S3). A signed-in account gets its plan's tag and limit only while the plan is active or renewing
 * (§4.4), read from the stored snapshot alone, so a report never waits on Stripe.
 */
async function reportCaller(request: ApiRequest, response: ApiResponse, fetcher: typeof fetch) {
  const authorization = request.headers.authorization
  if (authorization === undefined) {
    await enforceRateLimit(
      request,
      response,
      { scope: "bug-report-ip", limit: FREE_PER_HOUR, windowSeconds: HOUR_SECONDS },
      fetcher,
    )
    return undefined
  }
  await enforceRateLimit(
    request,
    response,
    { scope: "bug-report-ip-signed", limit: SIGNED_IN_PER_ADDRESS_HOUR, windowSeconds: HOUR_SECONDS },
    fetcher,
  )
  const token = /^Bearer (vct_[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)$/.exec(String(authorization))?.[1]
  if (!token) throw new ApiError(401, "CLI_TOKEN_INVALID", "Sign in to Vector again to continue.")
  const account = await requireUnrevokedCliToken(token, fetcher)
  const reports = await planReports(account.id, fetcher)
  await enforceRateLimit(
    request,
    response,
    {
      scope: "bug-report-account",
      identifier: account.id,
      limit: reports?.perHour ?? FREE_PER_HOUR,
      windowSeconds: HOUR_SECONDS,
    },
    fetcher,
  )
  return { account: account.id, reports }
}

async function planReports(account: string, fetcher: typeof fetch): Promise<Entitlements["reports"] | undefined> {
  const snapshot = await readSnapshot(account, fetcher).catch(() => undefined)
  if (!snapshot?.plan || (snapshot.state !== "active" && snapshot.state !== "renewing")) return undefined
  const reports = snapshot.caps.reports
  return reports.perHour > 0 ? reports : undefined
}

export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleBugReport(request, response)
}

/**
 * `POST /api/support/bug-report` (WP A33 adds the tracker). Emails the report to the owner and answers
 * `{delivered: true, id, report?: {id, status}}`: `id` is the email's id, as before, and `report.id` the report's own
 * `r_` id, which the desktop keeps to follow its status. The store keeps metadata only (support-reports.ts); when it
 * cannot be written the report still goes out, without `report`.
 */
export async function handleBugReport(request: ApiRequest, response: ApiResponse, fetcher: typeof fetch = fetch) {
  try {
    requireMethod(request, "POST")
    requireTrustedJsonRequest(request, 32_000)
    const caller = await reportCaller(request, response, fetcher)
    const raw = await readJson<unknown>(request, 32_000)
    if (!isRecord(raw)) {
      throw new ApiError(400, "INVALID_JSON", "The request body must be a JSON object.")
    }
    const message = typeof raw.message === "string" ? raw.message.trim() : ""
    if (!message) throw new ApiError(400, "EMPTY_REPORT", "Describe the bug before sending the report.")
    if (message.length > MAX_MESSAGE) {
      throw new ApiError(413, "REPORT_TOO_LONG", `Keep the report under ${MAX_MESSAGE} characters.`)
    }
    const reporter = optionalText(raw.email, 320)
    if (reporter && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(reporter)) {
      throw new ApiError(400, "EMAIL_INVALID", "Enter a valid reply email or leave it blank.")
    }
    const replyTo = reporter?.toLowerCase()
    if (replyTo) {
      await enforceRateLimit(
        request,
        response,
        {
          scope: "bug-report-email",
          limit: 3,
          windowSeconds: 24 * 60 * 60,
          identifier: stableAbuseIdentifier(replyTo),
        },
        fetcher,
      )
    }
    const version = optionalText(raw.version, 80)
    const platform = optionalText(raw.platform, 80)
    const arch = optionalText(raw.arch, 80)
    const channel = optionalText(raw.channel, 80)
    const context = reportContext(raw.context)
    if (!process.env.RESEND_API_KEY || !process.env.VECTOR_PURCHASE_EMAIL_FROM) {
      throw new ApiError(503, "EMAIL_NOT_CONFIGURED", "Bug report email is not configured.")
    }

    // The record is written first, so every id the owner sees in an email can have its status set.
    const reports = caller?.reports
    const candidate = newReportId()
    const tracked = await createReportRecord(
      candidate,
      {
        ...(reports ? { tag: reports.tag, readFirst: reports.readFirst } : {}),
        ...(caller ? { account: caller.account } : {}),
      },
      fetcher,
    )
    const reportId = tracked ? candidate : undefined
    const tag = reports ? reportSubjectTag(reports) : undefined
    const environment = [
      ["Report", reportId],
      ["Plan", tag],
      ["Version", version],
      ["Platform", platform],
      ["Arch", arch],
      ["Channel", channel],
      ["Reporter", replyTo ?? "(not provided)"],
      ...context,
    ].filter((entry): entry is [string, string] => Boolean(entry[1]))

    const sent = new Resend(process.env.RESEND_API_KEY).emails.send({
      from: process.env.VECTOR_PURCHASE_EMAIL_FROM,
      to: REPORT_TO,
      replyTo,
      subject: `${tag ? `${tag} ` : ""}Vector bug report${version ? ` · v${version}` : ""}`,
      text: [message, "", "---", ...environment.map(([key, value]) => `${key}: ${value}`)].join("\n"),
      html: `
        <div style="font-family:Inter,Arial,sans-serif;max-width:620px;margin:auto;padding:32px;color:#17151b">
          <h1 style="font-size:20px;margin:0 0 16px">Vector bug report</h1>
          <pre style="white-space:pre-wrap;word-break:break-word;padding:16px;border:1px solid #ded8e8;border-radius:12px;background:#f7f4fb;font-family:ui-monospace,monospace;font-size:13px;line-height:1.6">${escapeHtml(message)}</pre>
          <table style="margin-top:24px;border-collapse:collapse;font-size:13px;color:#605a68">
            ${environment
              .map(
                ([key, value]) =>
                  `<tr><td style="padding:4px 16px 4px 0;color:#8a8391">${escapeHtml(key)}</td><td style="padding:4px 0">${escapeHtml(value)}</td></tr>`,
              )
              .join("")}
          </table>
        </div>
      `,
    })
    const result = await sent.catch(async (error: unknown) => {
      if (reportId) await discardReportRecord(reportId, caller?.account, fetcher)
      throw error
    })

    if (result.error) {
      if (reportId) await discardReportRecord(reportId, caller?.account, fetcher)
      throw new ApiError(502, "EMAIL_FAILED", result.error.message)
    }
    json(response, 200, {
      delivered: true,
      id: result.data?.id,
      ...(reportId ? { report: { id: reportId, status: "received" } } : {}),
    })
  } catch (error) {
    handleApiError(response, error)
  }
}
