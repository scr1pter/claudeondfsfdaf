import { createHash, timingSafeEqual } from "node:crypto"
import { Hosted } from "../../packages/schema/src/hosted.js"
import { enforceRateLimit, requireTrustedJsonRequest } from "./abuse.js"
import { requireAccountUser } from "./account.js"
import { requireRecentGoogleSignIn } from "./codium-owner-api.js"
import { readSwitchState, writeSwitch } from "./codium-switches.js"
import { checkHostedDrift, hostedBudget, reapHostedSessions, runHostedNightly } from "./hosted-crons.js"
import {
  downloadRedirect,
  eraseHostedComputer,
  hostedComputers,
  hostedStatus,
  issueViewer,
  listHostedSessions,
  listSuspensions,
  parseStart,
  recordHeartbeat,
  releaseHostedSession,
  releaseHostedSuspension,
  requestDownload,
  requireHostedRunRequest,
  startHostedSession,
  stopHostedSession,
  suspendHostedAccount,
  takeOverHostedSession,
  type SessionOptions,
} from "./hosted-sessions.js"
import { readDownloadToken } from "./hosted-tokens.js"
import {
  ApiError,
  handleApiError,
  json,
  queryValue,
  readJson,
  redirect,
  requireMethod,
  type ApiRequest,
  type ApiResponse,
} from "./http.js"
import { readEntitlement } from "./model-plan-account.js"
import { modelPlanRequireMarkedTokens } from "./model-plan-config.js"
import { requireUnrevokedAccount, requireUnrevokedCliToken } from "./revocation.js"
import { requireUsageOwner } from "./usage.js"
import { phoneAppOrigin } from "./web-push.js"

/*
 * The cloud computer's routes (contract §4.19, WP A53). Each route file is a thin wrapper around one handler here, so
 * the tests drive the handlers with injected services.
 *
 * Callers:
 * - the person: an unrevoked `vct_` account token (the desktop's own sign-in or `vector login` to start, since a session
 *   spends Codium; any account token to read) or a website session (the site or the phone app). Run tokens get 401 (S3);
 * - the computer: its session's `vht_` run token on the heartbeat only, never with browser headers (S7);
 * - the crons: `CRON_SECRET`; the owner: a Google owner session, a fresh sign-in for changes (S5); the budget
 *   workflow: `VECTOR_HOSTED_BUDGET_READ_SECRET`.
 */

export type HostedRouteOptions = SessionOptions

type Caller = { account: string; via: "token" | "session"; marked: boolean; source: Hosted.SessionSource }

function header(request: Pick<ApiRequest, "headers">, name: string) {
  const value = request.headers[name]
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? ""
}

/** The person behind a request. Run tokens and anything that is not a bearer credential get 401 before any lookup. */
export async function requireHostedCaller(
  request: Pick<ApiRequest, "headers">,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<Caller> {
  const bearer = /^Bearer\s+(\S+)$/i.exec(header(request, "authorization"))?.[1]
  if (!bearer || bearer.length > 8192 || bearer.startsWith("vrt_") || bearer.startsWith("vht_"))
    throw new ApiError(401, "SIGN_IN_REQUIRED", "Sign in to Vector to use your cloud computer.")
  if (bearer.startsWith("vct_")) {
    const claims = await requireUnrevokedCliToken(bearer, fetcher, now)
    const marked = claims.client === "desktop" || claims.client === "cli"
    return { account: claims.id, via: "token", marked, source: claims.client === "desktop" ? "desktop" : "cli" }
  }
  const user = await requireAccountUser(request, fetcher)
  await requireUnrevokedAccount(user.id, fetcher)
  const phone = phoneAppOrigin()
  return { account: user.id, via: "session", marked: true, source: phone && header(request, "origin") === phone ? "phone" : "desktop" }
}

/** A change's JSON body, from the site, the phone app or the desktop app (no origin), at most `bytes`. */
async function readBody(request: ApiRequest, bytes: number, fields: readonly string[]) {
  const phone = phoneAppOrigin()
  requireTrustedJsonRequest(request, bytes, phone ? [phone] : [])
  const body = await readJson<unknown>(request, bytes)
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new ApiError(400, "HOSTED_REQUEST", "Send the request as a JSON object.")
  if (Object.keys(body).some((key) => !fields.includes(key)))
    throw new ApiError(400, "HOSTED_REQUEST", `Send only ${fields.join(", ")}.`)
  return body as Record<string, unknown>
}

function limit(
  request: ApiRequest,
  response: ApiResponse,
  scope: string,
  identifier: string,
  count: number,
  fetcher: typeof fetch,
) {
  return enforceRateLimit(
    request,
    response,
    { scope, identifier, limit: count, windowSeconds: 3600, requirePersistent: true },
    fetcher,
  )
}

function clockOf(options: HostedRouteOptions) {
  return options.clock ?? Date.now
}

// ── Sessions ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `/api/hosted/sessions`. `GET`: the account's sessions, newest first, live ones first (600 an hour). `POST {size,
 * jobMinutes, prompt, title?}`: starts a session (30 an hour), answering it. Starting spends Codium, so it takes a
 * website session or a marked token (the desktop's own sign-in, `vector login`); a token copied from
 * vectordev.ai/auth/cli gets 401 CODIUM_SIGN_IN_REQUIRED (S2), unless the owner set MODEL_PLAN_REQUIRE_MARKED_TOKENS=false.
 */
export async function handleHostedSessions(
  request: ApiRequest,
  response: ApiResponse,
  options: HostedRouteOptions = {},
) {
  const fetcher = options.fetcher ?? fetch
  const clock = clockOf(options)
  try {
    if (request.method === "GET") {
      const caller = await requireHostedCaller(request, fetcher, clock())
      await limit(request, response, "hosted-read", caller.account, 600, fetcher)
      return json(response, 200, { sessions: await listHostedSessions(caller.account, fetcher) })
    }
    requireMethod(request, "POST")
    const body = await readBody(request, 40_000, ["size", "jobMinutes", "prompt", "title"])
    const caller = await requireHostedCaller(request, fetcher, clock())
    if (!caller.marked && modelPlanRequireMarkedTokens())
      throw new ApiError(401, "CODIUM_SIGN_IN_REQUIRED", "Sign in to Vector again or run vector login to use Vector Codium.")
    await limit(request, response, "hosted-start", caller.account, 30, fetcher)
    const session = await startHostedSession(caller.account, parseStart(body, caller.source), options)
    json(response, 201, { session })
  } catch (error) {
    handleApiError(response, error)
  }
}

export type SessionAction = "stop" | "takeover" | "release" | "viewer" | "download"

/**
 * `POST /api/hosted/sessions/:id/{stop, takeover, release, viewer, download}` (240 an hour):
 * - `stop`: stops the session (its computer's disk is saved), idempotent;
 * - `takeover` / `release`: the person takes control (at most 30 minutes at a time) and gives it back;
 * - `viewer {mode: "view" | "control"}`: a live view link with a single-use, five-minute token in its fragment;
 *   control only during a take-over;
 * - `download`: the session's files: a 24-hour link once the computer has packed them, else `{ready: false}` while it
 *   packs them. `GET …/download?t=<link token>` (no sign-in: the link is the key) redirects to a 15-minute signed link.
 */
export async function handleHostedSessionAction(
  request: ApiRequest,
  response: ApiResponse,
  action: SessionAction,
  options: HostedRouteOptions = {},
) {
  const fetcher = options.fetcher ?? fetch
  const clock = clockOf(options)
  try {
    const id = queryValue(request, "id") ?? ""
    if (action === "download" && request.method === "GET") {
      response.setHeader("referrer-policy", "no-referrer")
      const claims = readDownloadToken(queryValue(request, "t") ?? "", id, clock())
      if (!claims) throw new ApiError(404, "HOSTED_SESSION_NOT_FOUND", "This download link is not valid any more.")
      await limit(request, response, "hosted-download", claims.s, 60, fetcher)
      return redirect(response, 302, await downloadRedirect(id, options))
    }
    requireMethod(request, "POST")
    const body = await readBody(request, 1_024, action === "viewer" ? ["mode"] : [])
    const caller = await requireHostedCaller(request, fetcher, clock())
    await limit(request, response, "hosted-action", caller.account, 240, fetcher)
    switch (action) {
      case "stop":
        return json(response, 200, { session: await stopHostedSession(caller.account, id, options) })
      case "takeover":
        return json(response, 200, { session: await takeOverHostedSession(caller.account, id, options) })
      case "release":
        return json(response, 200, { session: await releaseHostedSession(caller.account, id, options) })
      case "viewer":
        return json(response, 200, await issueViewer(caller.account, id, body.mode, options))
      case "download": {
        const answer = await requestDownload(caller.account, id, options)
        return json(response, answer.ready ? 200 : 202, answer)
      }
    }
  } catch (error) {
    handleApiError(response, error)
  }
}

/**
 * `POST /api/hosted/sessions/:id/heartbeat`: the computer's daemon, on the run-API host, with the session's run token
 * (added by the provider's proxy) and no browser headers (S7). 600 an hour per session.
 */
export async function handleHostedHeartbeat(request: ApiRequest, response: ApiResponse, options: HostedRouteOptions = {}) {
  const fetcher = options.fetcher ?? fetch
  const clock = clockOf(options)
  try {
    requireMethod(request, "POST")
    const claims = await requireHostedRunRequest(request, fetcher, clock())
    const id = queryValue(request, "id") ?? ""
    await limit(request, response, "hosted-heartbeat", claims.session, 600, fetcher)
    const contentType = header(request, "content-type")
    if (contentType && !contentType.toLowerCase().startsWith("application/json"))
      throw new ApiError(415, "CONTENT_TYPE_INVALID", "Send this request as JSON.")
    json(response, 200, await recordHeartbeat(claims, id, await readJson<unknown>(request, 4_096), options))
  } catch (error) {
    handleApiError(response, error)
  }
}

// ── Status and computers ───────────────────────────────────────────────────────────────────────────────────────────

/** `GET /api/hosted/status`: what the person's surfaces show (shares, counts and times only). 600 an hour. */
export async function handleHostedStatus(request: ApiRequest, response: ApiResponse, options: HostedRouteOptions = {}) {
  const fetcher = options.fetcher ?? fetch
  const clock = clockOf(options)
  try {
    requireMethod(request, "GET")
    const caller = await requireHostedCaller(request, fetcher, clock())
    await limit(request, response, "hosted-read", caller.account, 600, fetcher)
    const snapshot = await readEntitlement(caller.account, fetcher, clock())
    json(response, 200, await hostedStatus(caller.account, snapshot, options))
  } catch (error) {
    handleApiError(response, error)
  }
}

/**
 * `/api/hosted/computers`. `GET`: the account's computers, which run a session now, and when their disks are deleted
 * if a deletion is set. `POST {computer, action: "erase"}`: deletes that computer and its saved disk, refused while a
 * session runs on it.
 */
export async function handleHostedComputers(request: ApiRequest, response: ApiResponse, options: HostedRouteOptions = {}) {
  const fetcher = options.fetcher ?? fetch
  const clock = clockOf(options)
  try {
    if (request.method === "GET") {
      const caller = await requireHostedCaller(request, fetcher, clock())
      await limit(request, response, "hosted-read", caller.account, 600, fetcher)
      const snapshot = await readEntitlement(caller.account, fetcher, clock())
      return json(response, 200, await hostedComputers(caller.account, snapshot, options))
    }
    requireMethod(request, "POST")
    const body = await readBody(request, 1_024, ["computer", "action"])
    const caller = await requireHostedCaller(request, fetcher, clock())
    await limit(request, response, "hosted-action", caller.account, 240, fetcher)
    if (body.action !== "erase") throw new ApiError(400, "HOSTED_REQUEST", "Choose erase.")
    json(response, 200, await eraseHostedComputer(caller.account, body.computer, options))
  } catch (error) {
    handleApiError(response, error)
  }
}

// ── Crons ──────────────────────────────────────────────────────────────────────────────────────────────────────────

function requireCron(request: ApiRequest) {
  const supplied = Buffer.from(String(request.headers.authorization ?? ""))
  const expected = Buffer.from(`Bearer ${process.env.CRON_SECRET ?? ""}`)
  if (!process.env.CRON_SECRET || supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
    throw new ApiError(401, "NOT_AUTHORIZED", "This endpoint is reserved for the cloud computer's jobs.")
}

/** The three crons (§4.19): the reaper every minute, the drift check every 10 minutes, the nightly job at 02:30 UTC. */
export async function handleHostedCron(
  request: ApiRequest,
  response: ApiResponse,
  kind: "reaper" | "drift" | "nightly",
  options: HostedRouteOptions & { budgetMs?: number } = {},
) {
  try {
    requireMethod(request, "GET")
    requireCron(request)
    const run = kind === "reaper" ? reapHostedSessions : kind === "drift" ? checkHostedDrift : runHostedNightly
    json(response, 200, await run(options))
  } catch (error) {
    handleApiError(response, error)
  }
}

// ── Owner ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const ACCOUNT = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i

/**
 * `/api/hosted/admin/flags` (owner only, S5). `GET`: the hosted switch's place and the accounts on hold. `POST {action,
 * account?, reason?}`: `drain` (no new sessions: the `hosted` switch at no-new), `stop` (every session stops), `resume`
 * (on), `suspend {account, reason?}` (put one account's cloud computer on hold; the reaper stops its sessions) and
 * `release {account}`. Changes need a Google sign-in under 10 minutes old.
 */
export async function handleHostedFlags(request: ApiRequest, response: ApiResponse, options: HostedRouteOptions = {}) {
  const fetcher = options.fetcher ?? fetch
  const clock = clockOf(options)
  response.setHeader("x-robots-tag", "noindex, nofollow, noarchive")
  try {
    const owner = await requireUsageOwner(request, fetcher)
    const actor = `owner:${createHash("sha256").update(owner.email).digest("hex")}`
    if (request.method === "GET") {
      await limit(request, response, "hosted-owner-read", actor, 120, fetcher)
      const state = await readSwitchState("hosted", fetcher, { fresh: true, now: clock() })
      return json(response, 200, { hosted: state.value, changedAt: state.changedAt, onHold: await listSuspensions(fetcher) })
    }
    requireMethod(request, "POST")
    requireRecentGoogleSignIn(request, clock())
    requireTrustedJsonRequest(request, 1_024)
    await limit(request, response, "hosted-owner-write", actor, 30, fetcher)
    const body = await readJson<Record<string, unknown>>(request, 1_024)
    switch (body?.action) {
      case "drain":
      case "stop":
      case "resume": {
        const value = body.action === "drain" ? "no-new" : body.action === "stop" ? "stop" : "on"
        const saved = await writeSwitch("hosted", value, actor, fetcher, clock())
        return json(response, 200, { hosted: saved.value, changed: saved.changed })
      }
      case "suspend":
      case "release": {
        if (typeof body.account !== "string" || !ACCOUNT.test(body.account))
          throw new ApiError(400, "HOSTED_REQUEST", "Name the account by its id.")
        if (body.action === "release") {
          await releaseHostedSuspension(body.account, fetcher)
          return json(response, 200, { account: body.account, onHold: false })
        }
        const reason = typeof body.reason === "string" ? body.reason.slice(0, 200) : undefined
        await suspendHostedAccount(body.account, { reason: "owner", ...(reason ? { detail: reason } : {}), at: clock() }, fetcher)
        return json(response, 200, { account: body.account, onHold: true })
      }
    }
    throw new ApiError(400, "HOSTED_REQUEST", "Choose drain, stop, resume, suspend or release.")
  } catch (error) {
    handleApiError(response, error)
  }
}

/**
 * `GET /api/hosted/admin/budget?cycleEnd=<ms>` (the budget workflow of WP A56, with
 * `Authorization: Bearer <VECTOR_HOSTED_BUDGET_READ_SECRET>`): the hosted team's worst-case cost for the rest of the
 * billing cycle. Owner-side only.
 */
export async function handleHostedBudget(request: ApiRequest, response: ApiResponse, options: HostedRouteOptions = {}) {
  const fetcher = options.fetcher ?? fetch
  const clock = clockOf(options)
  response.setHeader("x-robots-tag", "noindex, nofollow, noarchive")
  try {
    requireMethod(request, "GET")
    const secret = process.env.VECTOR_HOSTED_BUDGET_READ_SECRET?.trim() ?? ""
    const supplied = Buffer.from(header(request, "authorization"))
    const expected = Buffer.from(`Bearer ${secret}`)
    if (secret.length < 32 || supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      throw new ApiError(401, "NOT_AUTHORIZED", "This endpoint is reserved for the hosted budget workflow.")
    const now = clock()
    const cycleEnd = Number(queryValue(request, "cycleEnd"))
    if (!Number.isSafeInteger(cycleEnd) || cycleEnd <= now || cycleEnd > now + 40 * 86_400_000)
      throw new ApiError(400, "HOSTED_REQUEST", "Send cycleEnd, the billing cycle's end in ms, within 40 days.")
    json(response, 200, await hostedBudget({ cycleEnd }, { fetcher, clock }))
  } catch (error) {
    handleApiError(response, error)
  }
}
