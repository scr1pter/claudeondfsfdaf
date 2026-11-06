import { createHmac, timingSafeEqual } from "node:crypto"
import { Option, Schema } from "effect"
import { notifyOwner } from "../_lib/codium-owner.js"
import { escalateHostedSwitch } from "../_lib/codium-switches.js"
import {
  ApiError,
  handleApiError,
  json,
  readRawBody,
  requireMethod,
  type ApiRequest,
  type ApiResponse,
} from "../_lib/http.js"

export const config = { api: { bodyParser: false } }
export const maxDuration = 30
const MAX_BODY_BYTES = 16_384
const Whole = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
// Vercel Spend Management's flat callback. Its threshold is authoritative; spend/budget rounding is not.
const Spend = Schema.Struct({
  teamId: Schema.String,
  budgetAmount: Whole,
  currentSpend: Whole,
  thresholdPercent: Whole,
})

/** Signed callbacks only escalate Vector's own hosted guard; they never call a Vercel account/deployment API. */
export async function handleVercelSpend(
  request: ApiRequest,
  response: ApiResponse,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  response.setHeader("x-robots-tag", "noindex, nofollow, noarchive")
  try {
    requireMethod(request, "POST")
    if (request.body !== undefined)
      throw new ApiError(400, "VERCEL_SPEND_RAW_BODY_REQUIRED", "The original webhook body is required.")
    const raw = await readRawBody(request, MAX_BODY_BYTES)
    const header = request.headers["x-vercel-signature"]
    if (typeof header !== "string" || !/^[a-f0-9]{40}$/i.test(header)) throw invalidSignature()
    const teams = configuredTeams()
    const signature = Buffer.from(header, "hex")
    // Check every configured secret before parsing. Payload teamId alone must never choose or authenticate a secret.
    const verified = teams.filter((team) =>
      timingSafeEqual(createHmac("sha1", team.secret).update(raw).digest(), signature),
    )
    if (!verified.length) throw invalidSignature()
    const spend = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(Spend))(raw.toString("utf8")))
    if (!spend) throw new ApiError(400, "VERCEL_SPEND_PAYLOAD_INVALID", "The signed spend callback could not be read.")
    const team = verified.find((value) => value.id === spend.teamId)
    if (!team) throw invalidSignature()
    const threshold =
      spend.thresholdPercent >= 100 ? 100 : spend.thresholdPercent >= 75 ? 75 : spend.thresholdPercent >= 50 ? 50 : 0
    if (!threshold) return json(response, 200, { received: true, escalated: false })
    // The safety write comes first. A notification failure must leave the stricter guard applied and retryable.
    const change =
      team.kind === "hosted" && threshold >= 75
        ? await escalateHostedSwitch(threshold === 100 ? "stop" : "no-new", `vercel-spend:${team.kind}`, fetcher, now)
        : undefined
    const alert = await notifyOwner(
      {
        kind: `vercel-spend:${team.kind}:${threshold}`,
        subject: `Vector ${team.kind === "main" ? "main" : "hosted"} Vercel budget reached ${threshold}%`,
        lines: [
          `The configured ${team.kind === "main" ? "main website" : "hosted computers"} Vercel team reached its ${threshold}% spend notification.`,
          ...(team.kind === "main"
            ? ["This callback sends an owner notification only. Review the budget in Vercel Spend Management."]
            : [
                threshold === 100
                  ? "Vector's hosted guard is stopped. Review the budget before reopening hosted work from the owner page."
                  : threshold === 75
                    ? "Vector's hosted guard refuses new work. Review the budget before reopening hosted work from the owner page."
                    : "Review the budget in Vercel Spend Management before it reaches the hosted guard thresholds.",
              ]),
        ],
      },
      fetcher,
    )
    if (alert === "failed" || alert === "unconfigured")
      throw new ApiError(
        503,
        "VERCEL_SPEND_ALERT_UNAVAILABLE",
        "The spend notification has not been delivered. Retry this callback.",
      )
    json(response, 200, { received: true, escalated: change?.changed ?? false })
  } catch (error) {
    handleApiError(response, error)
  }
}

function configuredTeams() {
  const main = process.env.VERCEL_MAIN_TEAM_ID?.trim()
  const hosted = process.env.VERCEL_HOSTED_TEAM_ID?.trim()
  if (main && hosted && main === hosted)
    throw new ApiError(503, "VERCEL_SPEND_CONFIG_INVALID", "The spend callback teams could not be verified.")
  return [
    { kind: "main" as const, id: main, secret: process.env.VERCEL_SPEND_WEBHOOK_SECRET_MAIN?.trim() },
    { kind: "hosted" as const, id: hosted, secret: process.env.VERCEL_SPEND_WEBHOOK_SECRET_HOSTED?.trim() },
  ].flatMap((team) => (team.id && team.secret ? [{ ...team, id: team.id, secret: team.secret }] : []))
}
function invalidSignature() {
  return new ApiError(401, "VERCEL_SPEND_SIGNATURE_INVALID", "The spend callback could not be verified.")
}

export default async function handler(request: ApiRequest, response: ApiResponse) {
  return handleVercelSpend(request, response)
}
