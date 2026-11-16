import {
  DEVICE_ID_PATTERN,
  decodeClaim,
  decodeDecline,
  decodeReport,
  decodeSettle,
  type DeclineCode,
} from "../../../packages/schema/src/everywhere.js"
import { requireTrustedJsonRequest } from "../abuse.js"
import { verifyDesktopToken } from "../cli-token.js"
import {
  ApiError,
  handleApiError,
  json,
  queryValue,
  readJson,
  requireMethod,
  type ApiRequest,
  type ApiResponse,
} from "../http.js"
import { requireUnrevokedCliToken } from "../revocation.js"
import { after } from "./after.js"
import { checkAccount, type AccountAuthorityPort } from "./authority.js"
import { readConfig, type Env, type EverywhereConfig } from "./config.js"
import {
  claimJob,
  declineJob,
  isBusy,
  offerWaiting,
  recordSeen,
  reportJob,
  settleJob,
  sweepAccount,
  type EndedJob,
  type JobRecord,
  type JobsContext,
  type Readiness,
  type Refused,
} from "./jobs.js"
import { everywhereStore, type Store } from "./store.js"
import { admits, codiumSwitches, readEverywhereSwitch, type CodiumSwitches } from "./switch.js"
import { productionJobEvents } from "./runtime.js"

/*
 * The jobs routes a computer calls with its desktop token (contract 3.4, 3.5, E4, E8, E10, E18):
 *
 *   POST /api/everywhere/jobs/claim    {jid, device}                  → {job}
 *   POST /api/everywhere/jobs/decline  {jid, device, reason, lease?}  → {recorded}
 *   POST /api/everywhere/jobs/report   Report (milestones and the heartbeat), header x-vector-device → {action}
 *   POST /api/everywhere/jobs/settle   Settle, header x-vector-device → {settled}
 *   GET  /api/everywhere/jobs/pending  readiness booleans, header x-vector-device → {offers, waiting}
 *
 * Every route takes only the desktop app's own sign-in token (`verifyDesktopToken`), checked against revocation
 * (`requireUnrevokedCliToken`), and answers only for the token's account: another account's job is 404. Reports and
 * settles must come from the device and lease that claimed the job (409). Report and Settle bodies refuse every field
 * outside their shapes (400), so no text, diff or pull request body can reach the server.
 *
 * While the feature is off (VECTOR_EVERYWHERE_ENABLED, the data key) every route answers `stop` before any store
 * read. Under the `stop` switch claims are refused, every report, heartbeat, settle and decline answers `stop`, and
 * the account's live jobs end. `no-new` lets all of this through: it is work on jobs already taken.
 *
 * Each call first sweeps the account's due jobs (3.4's safety net beside the sweep cron).
 */

/** The header that names the computer on report, settle and pending (Report and Settle have no device field). */
export const DEVICE_HEADER = "x-vector-device"

/** The query names of the readiness booleans on `pending` (3.1 `status`). */
export const READINESS_QUERY: Readonly<Record<keyof Readiness, string>> = {
  takesJobs: "jobs",
  remote: "remote",
  localMode: "local",
  sandbox: "sandbox",
  waitForComputer: "wait",
  capsRoom: "room",
  projects: "projects",
}

/** What VE-06 hangs on job changes: progress, results and fixed replies through the platform adapters. */
export type JobEvents = {
  readonly claimed?: (job: JobRecord) => Promise<void>
  readonly declined?: (job: JobRecord, reason: DeclineCode) => Promise<void>
  readonly reported?: (job: JobRecord) => Promise<void>
  readonly settled?: (job: JobRecord) => Promise<void>
  readonly ended?: (ended: EndedJob) => Promise<void>
}

export type JobsApiDeps = {
  readonly accountAuthority?: AccountAuthorityPort
  readonly env?: Env
  readonly store?: Store
  /** For the revocation check's store calls. */
  readonly fetcher?: typeof fetch
  readonly now?: () => number
  /** Codium's switches (R-C6); the default reads them once Codium has an `everywhere` switch. */
  readonly switches?: CodiumSwitches
  readonly events?: JobEvents
}

/** Settle is the largest body: a 1,500-character summary, ids and links. */
const BODY_LIMIT = 16_000
const TOKEN = /^Bearer (vct_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43})$/

type Started =
  | { readonly off: true }
  | {
      readonly off: false
      readonly token: string
      readonly config: EverywhereConfig
      readonly store: Store
      readonly now: number
    }

function header(request: ApiRequest, name: string) {
  const value = request.headers?.[name]
  return Array.isArray(value) ? value[0] : value
}

/** The method, then the desktop token's signature (no store read), then the feature switch. */
function start(request: ApiRequest, deps: JobsApiDeps, method: "GET" | "POST"): Started {
  requireMethod(request, method)
  const now = (deps.now ?? Date.now)()
  const token = TOKEN.exec(header(request, "authorization") ?? "")?.[1]
  if (!token) throw new ApiError(401, "CLI_TOKEN_INVALID", "Sign in to Vector again to continue.")
  verifyDesktopToken(token, now)
  const config = readConfig(deps.env ?? process.env)
  if (!config.enabled) return { off: true }
  return { off: false, token, config, store: deps.store ?? everywhereStore(deps.fetcher ?? fetch), now }
}

type Session = {
  readonly account: string
  readonly ctx: JobsContext
  /** `stop`: nothing on a job may go on. */
  readonly stopped: boolean
}

/** Revocation, then the `everywhere` switch. Under `stop` the account's live jobs end here. */
async function session(started: Started & { readonly off: false }, deps: JobsApiDeps): Promise<Session> {
  const claims = await requireUnrevokedCliToken(started.token, deps.fetcher ?? fetch, started.now)
  const account = claims.id.toLowerCase()
  const ctx: JobsContext = {
    store: started.store,
    accountAuthority: deps.accountAuthority,
    keys: started.config.dataKeys,
    now: started.now,
    ...(started.config.offer ? { offer: started.config.offer } : {}),
  }
  await checkAccount(ctx, account)
  const state = await readEverywhereSwitch(started.config, deps.switches ?? codiumSwitches(deps.fetcher ?? fetch))
  const stopped = !admits(state, "running")
  const ended = await sweepAccount(ctx, account, { stop: stopped })
  announce(deps, ended)
  return { account, ctx, stopped }
}

function announce(deps: JobsApiDeps, ended: readonly EndedJob[]) {
  const hook = deps.events?.ended
  if (!hook) return
  for (const item of ended) void after("everywhere-job-ended", () => hook(item))
}

function event(work: (() => Promise<void>) | undefined) {
  if (work) void after("everywhere-job-event", work)
}

async function body(request: ApiRequest): Promise<unknown> {
  requireTrustedJsonRequest(request, BODY_LIMIT)
  return readJson<unknown>(request, BODY_LIMIT)
}

function invalid(error: string): ApiError {
  return new ApiError(400, "EVERYWHERE_INVALID", "This request is not valid.", { detail: { reason: error } })
}

function refused(verdict: Refused): ApiError {
  if (verdict.status === 404) return new ApiError(404, "NOT_FOUND", "Not found.")
  if (verdict.status === 400) return invalid(verdict.reason ?? "invalid")
  const message =
    verdict.code === "LEASE_MISMATCH"
      ? "This computer does not hold this job."
      : verdict.code === "JOB_EXPIRED"
        ? "This request expired before a computer took it."
        : verdict.code === "JOB_TAKEN"
          ? "This job is no longer available."
          : "This job has ended."
  return new ApiError(409, verdict.code, message)
}

function stopped(): ApiError {
  return new ApiError(409, "EVERYWHERE_STOPPED", "Vector everywhere is paused.", { detail: { action: "stop" } })
}

function device(request: ApiRequest): string {
  const value = header(request, DEVICE_HEADER)
  if (typeof value !== "string" || !DEVICE_ID_PATTERN.test(value)) throw invalid(`${DEVICE_HEADER}: malformed`)
  return value
}

function flag(request: ApiRequest, name: string, fallback: boolean): boolean {
  const value = queryValue(request, name)
  if (value === undefined) return fallback
  if (value === "1" || value === "true") return true
  if (value === "0" || value === "false") return false
  throw invalid(`${name}: not a boolean`)
}

function readiness(request: ApiRequest): Readiness {
  return {
    takesJobs: flag(request, READINESS_QUERY.takesJobs, false),
    remote: flag(request, READINESS_QUERY.remote, false),
    localMode: flag(request, READINESS_QUERY.localMode, false),
    sandbox: flag(request, READINESS_QUERY.sandbox, false),
    // "Wait for my computer" is on unless the computer says otherwise (3.4 step 7).
    waitForComputer: flag(request, READINESS_QUERY.waitForComputer, true),
    capsRoom: flag(request, READINESS_QUERY.capsRoom, false),
    projects: flag(request, READINESS_QUERY.projects, false),
  }
}

function route(work: (request: ApiRequest, response: ApiResponse) => Promise<void>) {
  return async (request: ApiRequest, response: ApiResponse) => {
    try {
      await work(request, response)
    } catch (error) {
      if (isBusy(error)) {
        handleApiError(
          response,
          new ApiError(503, "EVERYWHERE_BUSY", "Vector everywhere is busy. Try again.", { retryAfterSeconds: 2 }),
        )
        return
      }
      handleApiError(response, error)
    }
  }
}

export function createJobsApi(deps: JobsApiDeps = {}) {
  const claim = route(async (request, response) => {
    const started = start(request, deps, "POST")
    if (started.off) throw stopped()
    const decoded = decodeClaim(await body(request))
    if (!decoded.ok) throw invalid(decoded.error)
    const s = await session(started, deps)
    if (s.stopped) throw stopped()
    await recordSeen(s.ctx, s.account, decoded.value.device)
    const verdict = await claimJob(s.ctx, { account: s.account, ...decoded.value })
    if (!verdict.ok) {
      if (verdict.expired) announce(deps, [{ job: verdict.expired, ending: "expired" }])
      throw refused(verdict)
    }
    if (verdict.fresh) event(deps.events?.claimed && (() => deps.events!.claimed!(verdict.record)))
    json(response, 200, { job: verdict.job })
  })

  const decline = route(async (request, response) => {
    const started = start(request, deps, "POST")
    if (started.off) return json(response, 200, { action: "stop" })
    const decoded = decodeDecline(await body(request))
    if (!decoded.ok) throw invalid(decoded.error)
    const s = await session(started, deps)
    if (s.stopped) return json(response, 200, { action: "stop" })
    await recordSeen(s.ctx, s.account, decoded.value.device)
    const verdict = await declineJob(s.ctx, { account: s.account, ...decoded.value })
    if (!verdict.ok) throw refused(verdict)
    const job = verdict.job
    if (job) {
      event(deps.events?.declined && (() => deps.events!.declined!(job, decoded.value.reason)))
      if (job.state === "refused") announce(deps, [{ job }])
    }
    json(response, 200, { recorded: verdict.recorded })
  })

  /** Milestones and the heartbeat (a report whose milestone is `heartbeat`). */
  const report = route(async (request, response) => {
    const started = start(request, deps, "POST")
    if (started.off) return json(response, 200, { action: "stop" })
    const decoded = decodeReport(await body(request))
    if (!decoded.ok) throw invalid(decoded.error)
    const from = device(request)
    const s = await session(started, deps)
    if (s.stopped) return json(response, 200, { action: "stop" })
    const verdict = await reportJob(s.ctx, { account: s.account, device: from, report: decoded.value })
    if (!verdict.ok) throw refused(verdict)
    const job = verdict.job
    if (job && decoded.value.milestone !== "heartbeat")
      event(deps.events?.reported && (() => deps.events!.reported!(job)))
    json(response, 200, {
      action: verdict.action,
      ...(verdict.leaseExpiresAt !== undefined ? { leaseExpiresAt: verdict.leaseExpiresAt } : {}),
    })
  })

  const settle = route(async (request, response) => {
    const started = start(request, deps, "POST")
    if (started.off) return json(response, 200, { action: "stop" })
    const decoded = decodeSettle(await body(request))
    if (!decoded.ok) throw invalid(decoded.error)
    const from = device(request)
    const s = await session(started, deps)
    if (s.stopped) return json(response, 200, { action: "stop" })
    const verdict = await settleJob(s.ctx, { account: s.account, device: from, settle: decoded.value })
    if (!verdict.ok) throw refused(verdict)
    if (verdict.fresh) event(deps.events?.settled && (() => deps.events!.settled!(verdict.job)))
    json(response, 200, { settled: true })
  })

  /** A computer that wants jobs asks for waiting ones, with its readiness booleans (3.4). */
  const pending = route(async (request, response) => {
    const started = start(request, deps, "GET")
    if (started.off) return json(response, 200, { offers: [], waiting: 0, action: "stop" })
    const from = device(request)
    const ready = readiness(request)
    const s = await session(started, deps)
    await recordSeen(s.ctx, s.account, from, ready)
    if (s.stopped) return json(response, 200, { offers: [], waiting: 0, action: "stop" })
    // A computer that cannot take a job right now is not offered one: the job keeps waiting until it can, or expires.
    if (!ready.takesJobs || ready.localMode) return json(response, 200, { offers: [], waiting: 0 })
    const result = await offerWaiting(s.ctx, s.account)
    json(response, 200, result)
  })

  return { claim, decline, report, settle, pending }
}

/** The production routes: environment, store and switches as deployed. */
export const everywhereJobsApi = createJobsApi({ events: productionJobEvents })
