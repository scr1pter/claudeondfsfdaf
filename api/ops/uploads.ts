import { ShipDesk } from "../../packages/schema/src/ship-desk.js"
import { enforceRateLimit, requireTrustedJsonRequest } from "../_lib/abuse.js"
import { ApiError, handleApiError, json, readJson, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import { requireModelPlanCaller } from "../_lib/model-plan-caller.js"
import {
  captureCard,
  finishCapture,
  mintCaptureTicket,
  startCapture,
  ticketHash,
  type ShipDeskContext,
} from "../_lib/ship-desk.js"

export const maxDuration = 60

export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleOpsUploads(request, response)
}

const FIELDS = ["action", "pr", "files", "capture"] as const

function header(request: ApiRequest, name: string) {
  const value = request.headers[name]
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? ""
}

function signInRequired() {
  return new ApiError(401, "SHIP_DESK_TICKET_INVALID", "Send the run's token or a capture ticket.")
}

/**
 * `POST /api/ops/uploads` (WP A49): Ship Desk's screenshots, from `vector ship capture` in the person's own repository.
 *
 * - `{action: "ticket"}` with the run's own token (`Bearer vrt_…`, verified by the registered run verifier, the account
 *   not revoked): a capture ticket for that run. This is the only ops request a run token is accepted for (S3: a run
 *   token reaches its own service's endpoints only), and it can do nothing but ask for a ticket. 120 an hour.
 * - With the ticket (`Bearer vcap_…`), which the capture job holds instead of any `id-token` or run token:
 *   `{action: "card", pr}` (what to capture; starts nothing), `{action: "start", pr, files}` (opens the 15-minute
 *   window on first use; one signed upload per file, at most the card's image count, PNG or WebP up to 5 MB each) and
 *   `{action: "finish", pr, capture}` (each upload checked by its signature and size; the card shows what passed).
 *   120 an hour per ticket.
 */
export async function handleOpsUploads(
  request: ApiRequest,
  response: ApiResponse,
  fetcher: typeof fetch = fetch,
  clock: () => number = Date.now,
  context: Omit<ShipDeskContext, "fetcher" | "now"> = {},
) {
  try {
    if (request.method !== "POST") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use POST for this endpoint.")
    const now = clock()
    requireTrustedJsonRequest(request, 8_192)
    const body = await readJson<unknown>(request, 8_192)
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new ApiError(400, "SHIP_DESK_CAPTURE_INVALID", "Send a JSON object.")
    const input = body as Record<string, unknown>
    if (Object.keys(input).some((name) => !(FIELDS as readonly string[]).includes(name)))
      throw new ApiError(400, "SHIP_DESK_CAPTURE_INVALID", `Send only ${FIELDS.join(", ")}.`)
    const bearer = /^Bearer\s+(\S+)$/i.exec(header(request, "authorization"))?.[1] ?? ""
    const shared = { ...context, fetcher, now }

    if (bearer.startsWith("vrt_")) {
      if (input.action !== "ticket") throw signInRequired()
      const caller = await requireModelPlanCaller(request, fetcher, now)
      if (caller.kind !== "run" || caller.run?.service !== "cloud-agents") throw signInRequired()
      await enforceRateLimit(
        request,
        response,
        {
          scope: "ship-ticket",
          identifier: caller.account.id,
          limit: 120,
          windowSeconds: 3600,
          requirePersistent: true,
        },
        fetcher,
      )
      return json(
        response,
        200,
        await mintCaptureTicket(
          { account: caller.account.id, rid: caller.run.id, deadline: caller.run.deadline },
          shared,
        ),
      )
    }
    if (!ShipDesk.TICKET.test(bearer)) throw signInRequired()
    await enforceRateLimit(
      request,
      response,
      {
        scope: "ship-capture",
        identifier: ticketHash(bearer),
        limit: 120,
        windowSeconds: 3600,
        requirePersistent: true,
      },
      fetcher,
    )
    switch (input.action) {
      case "card":
        return json(response, 200, await captureCard({ ticket: bearer, pr: input.pr }, shared))
      case "start":
        return json(response, 200, await startCapture({ ticket: bearer, pr: input.pr, files: input.files }, shared))
      case "finish":
        return json(
          response,
          200,
          await finishCapture({ ticket: bearer, pr: input.pr, capture: input.capture }, shared),
        )
    }
    throw new ApiError(400, "SHIP_DESK_CAPTURE_INVALID", "Choose card, start or finish.")
  } catch (error) {
    handleApiError(response, error)
  }
}
