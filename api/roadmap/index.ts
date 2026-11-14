import { enforceRateLimit, requireTrustedJsonRequest } from "../_lib/abuse.js"
import { includes, requireEntitlement } from "../_lib/codium-entitlements.js"
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
import { castBallot, nominateFeature, roadmapView, type RoadmapRefusal, type RoadmapView } from "../_lib/roadmap.js"

const HOUR_SECONDS = 60 * 60

export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleRoadmap(request, response)
}

/**
 * `GET|POST /api/roadmap` (WP A34), for Settings → Roadmap vote in the desktop app. Only a Vector account token
 * (`vct_`, from the desktop's sign-in or the CLI) is accepted; run tokens never are (S3).
 *
 * GET answers the roadmap as this account sees it (`RoadmapView`): this quarter's ballot while it is upcoming or open,
 * the account's own ballot and nomination, the results of the latest closed vote, and whether the account may vote and
 * nominate now. POST `{action: "vote", quarter, choice}` casts or changes the account's ballot until the vote closes;
 * POST `{action: "nominate", quarter, title, detail?}` records Ultra's one nomination of the quarter. Both answer the
 * updated view.
 *
 * Who may vote is decided here from the entitlement snapshot, never by the client (S1): Max and Ultra while the plan
 * is active or renewing (contract §4.4), nominating on Ultra only. A refusal is the contract's own answer: 402
 * `MODEL_PLAN_REQUIRED` or `MODEL_PLAN_PAYMENT_REQUIRED`, 403 `CODIUM_PERK_REQUIRED {perk, plan}` or
 * `MODEL_PLAN_BLOCKED`, 503 `MODEL_PLAN_RENEWING`. With a fresh snapshot nothing here calls Stripe (M4).
 */
export async function handleRoadmap(
  request: ApiRequest,
  response: ApiResponse,
  fetcher: typeof fetch = fetch,
  clock: () => number = Date.now,
) {
  try {
    if (request.method !== "GET" && request.method !== "POST") requireMethod(request, "GET")
    if (request.method === "POST") requireTrustedJsonRequest(request, 2_048)
    const token = /^Bearer (vct_[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)$/.exec(String(request.headers.authorization ?? ""))?.[1]
    if (!token) throw new ApiError(401, "CLI_TOKEN_INVALID", "Sign in to Vector again to continue.")
    const account = await requireUnrevokedCliToken(token, fetcher)
    await enforceRateLimit(
      request,
      response,
      { scope: "roadmap", identifier: account.id, limit: 120, windowSeconds: HOUR_SECONDS, requirePersistent: true },
      fetcher,
    )
    if (request.method === "POST") {
      await enforceRateLimit(
        request,
        response,
        {
          scope: "roadmap-write",
          identifier: account.id,
          limit: 30,
          windowSeconds: HOUR_SECONDS,
          requirePersistent: true,
        },
        fetcher,
      )
      await write(account.id, await readJson<unknown>(request, 2_048), fetcher, clock())
    }
    const now = clock()
    json(response, 200, await roadmapView(account.id, await access(account.id, fetcher, now), fetcher, now))
  } catch (error) {
    handleApiError(response, error)
  }
}

async function write(account: string, body: unknown, fetcher: typeof fetch, now: number) {
  const input = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
  if (input.action === "vote") {
    const snapshot = await requireEntitlement(account, "vote", fetcher, now)
    await castBallot(account, { quarter: input.quarter, choice: input.choice, plan: plan(snapshot.plan) }, fetcher, now)
    return
  }
  if (input.action === "nominate") {
    const snapshot = await requireEntitlement(account, "nominate", fetcher, now)
    await nominateFeature(
      account,
      { quarter: input.quarter, title: input.title, detail: input.detail, plan: plan(snapshot.plan) },
      fetcher,
      now,
    )
    return
  }
  throw new ApiError(400, "ROADMAP_ACTION_INVALID", "Send a vote or a nomination.")
}

function plan<T>(value: T | null) {
  // A usable snapshot always has a plan; this only narrows the type.
  if (!value) throw new ApiError(402, "MODEL_PLAN_REQUIRED", "Choose a Vector Codium plan to use this.")
  return value
}

/** Whether the account may vote and nominate now, for the view; a refusal becomes a reason, never an error. */
async function access(
  account: string,
  fetcher: typeof fetch,
  now: number,
): Promise<{ vote: RoadmapView["vote"]; nominate: boolean }> {
  try {
    const snapshot = await requireEntitlement(account, "vote", fetcher, now)
    return { vote: { allowed: true }, nominate: includes(snapshot.caps, "nominate") }
  } catch (error) {
    return { vote: { allowed: false, reason: refusal(error) }, nominate: false }
  }
}

function refusal(error: unknown): RoadmapRefusal {
  const code = error instanceof ApiError ? error.code : undefined
  if (code === "MODEL_PLAN_REQUIRED" || code === "CODIUM_PERK_REQUIRED" || code === "MODEL_PLAN_ACCOUNT_CLOSING")
    return "plan"
  if (code === "MODEL_PLAN_PAYMENT_REQUIRED") return "payment"
  if (code === "MODEL_PLAN_BLOCKED") return "hold"
  return "unavailable"
}
