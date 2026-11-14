import type { RunTrigger } from "../../packages/schema/src/codium-run-trigger.js"
import { Hosted } from "../../packages/schema/src/hosted.js"
import { enforceRateLimit, requireTrustedJsonRequest } from "./abuse.js"
import { requireHostedCaller } from "./hosted-api.js"
import {
  addRecurringJob,
  approveHostedJob,
  cancelHostedJob,
  enqueueHostedJob,
  listHostedJobs,
  readHostedJob,
  recordJobReport,
  removeRecurringJob,
  type JobOptions,
} from "./hosted-jobs.js"
import { requireHostedRunRequest } from "./hosted-sessions.js"
import {
  ApiError,
  handleApiError,
  json,
  queryValue,
  readJson,
  requireMethod,
  type ApiRequest,
  type ApiResponse,
} from "./http.js"
import { modelPlanRequireMarkedTokens } from "./model-plan-config.js"
import { phoneAppOrigin } from "./web-push.js"

/*
 * Done by Morning's routes (contract §4.19 `/api/hosted/jobs`, WP A55). Each route file is a thin wrapper around one
 * handler here, so the tests drive the handlers with injected services.
 *
 * Callers, as for the cloud computer's other routes (hosted-api.ts): the person, with an unrevoked `vct_` account token
 * or a website session (queueing spends Codium later, so it needs the desktop's own sign-in, `vector login` or a
 * website session); the job's session, with its own `vht_` run token, on the report only, never with browser headers
 * (S3, S7). Run tokens get 401 on every person's route.
 */

const JOB_FIELDS = ["prompt", "criteria", "deliverBy", "startAfter", "jobMinutes", "size", "title", "pages", "recurring"]

function header(request: Pick<ApiRequest, "headers">, name: string) {
  const value = request.headers[name]
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? ""
}

/** A change's JSON body, from the site, the phone app or the desktop app (no origin), at most `bytes`. */
async function readBody(request: ApiRequest, bytes: number, fields: readonly string[]) {
  const phone = phoneAppOrigin()
  requireTrustedJsonRequest(request, bytes, phone ? [phone] : [])
  const body = await readJson<unknown>(request, bytes)
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new ApiError(400, "HOSTED_REQUEST", "Send the request as a JSON object.")
  if (Object.keys(body).some((key) => !fields.includes(key)))
    throw new ApiError(400, "HOSTED_REQUEST", `Send only ${fields.join(", ") || "an empty object"}.`)
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

/**
 * `/api/hosted/jobs`. `GET`: the queue (its state, the plan's Done by Morning caps, the newest jobs and the recurring
 * jobs; 600 an hour). `POST {prompt, criteria, deliverBy, startAfter?, jobMinutes?, size?, title?, pages?}` queues one
 * job; with `recurring: {timeOfDay, days?}` (and `pages`) it saves a recurring job instead (60 an hour). Every cap
 * comes from the snapshot, never from the body (S1).
 */
export async function handleHostedJobs(request: ApiRequest, response: ApiResponse, options: JobOptions = {}) {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  try {
    if (request.method === "GET") {
      const caller = await requireHostedCaller(request, fetcher, clock())
      await limit(request, response, "hosted-read", caller.account, 600, fetcher)
      return json(response, 200, await listHostedJobs(caller.account, options))
    }
    requireMethod(request, "POST")
    const body = await readBody(request, 64_000, JOB_FIELDS)
    const caller = await requireHostedCaller(request, fetcher, clock())
    if (!caller.marked && modelPlanRequireMarkedTokens())
      throw new ApiError(401, "CODIUM_SIGN_IN_REQUIRED", "Sign in to Vector again or run vector login to use Vector Codium.")
    await limit(request, response, "hosted-jobs", caller.account, 60, fetcher)
    if (body.recurring !== undefined) {
      if (body.deliverBy !== undefined || body.startAfter !== undefined)
        throw new ApiError(400, "HOSTED_REQUEST", "A recurring job takes its times from its schedule.")
      return json(response, 201, { recurring: await addRecurringJob(caller.account, body, options) })
    }
    const trigger = {
      source: caller.source,
      account: caller.account,
      target: { kind: "hosted-job", ...(body.size !== undefined ? { size: body.size } : {}) },
      prompt: body.prompt,
      criteria: body.criteria,
      deliverBy: body.deliverBy,
      purpose: "task",
    } as unknown as RunTrigger
    const job = await enqueueHostedJob(trigger, {
      ...options,
      ...(body.title !== undefined ? { title: body.title as string } : {}),
      ...(body.jobMinutes !== undefined ? { jobMinutes: body.jobMinutes as number } : {}),
      ...(body.startAfter !== undefined ? { startAfter: body.startAfter as number } : {}),
      ...(body.pages !== undefined ? { pages: body.pages as string[] } : {}),
    })
    json(response, 201, { job })
  } catch (error) {
    handleApiError(response, error)
  }
}

/**
 * `/api/hosted/jobs/:id` (a job `jb_…` or a recurring job `jr_…`). `GET`: the job, with 15-minute links to its
 * recording while it is kept (only its owner gets here), or the recurring job. `POST {action: "cancel"}`: cancels the
 * job (a queued one gives its night's count back; a running one's session stops), or removes the recurring job.
 */
export async function handleHostedJob(request: ApiRequest, response: ApiResponse, options: JobOptions = {}) {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  try {
    const id = queryValue(request, "id") ?? ""
    if (request.method === "GET") {
      const caller = await requireHostedCaller(request, fetcher, clock())
      await limit(request, response, "hosted-read", caller.account, 600, fetcher)
      if (Hosted.RECURRING_ID.test(id)) {
        const recurring = (await listHostedJobs(caller.account, options)).recurring.find((item) => item.id === id)
        if (!recurring) throw new ApiError(404, "HOSTED_JOB_NOT_FOUND", "This Done by Morning job was not found.")
        return json(response, 200, { recurring })
      }
      return json(response, 200, await readHostedJob(caller.account, id, options))
    }
    requireMethod(request, "POST")
    const body = await readBody(request, 1_024, ["action"])
    const caller = await requireHostedCaller(request, fetcher, clock())
    await limit(request, response, "hosted-action", caller.account, 240, fetcher)
    if (body.action !== "cancel") throw new ApiError(400, "HOSTED_REQUEST", "Choose cancel.")
    if (Hosted.RECURRING_ID.test(id)) return json(response, 200, await removeRecurringJob(caller.account, id, fetcher))
    json(response, 200, { job: await cancelHostedJob(caller.account, id, options) })
  } catch (error) {
    handleApiError(response, error)
  }
}

/**
 * `POST /api/hosted/jobs/:id/report`: the job's session reports, on the run-API host, with that job's own run token
 * (added by the provider's proxy) and no browser headers (S7). 120 an hour per session. Two steps (hosted-jobs.ts
 * `recordJobReport`): the work, answered with the judge to ask; then the judge's pass or fail per criterion.
 */
export async function handleHostedJobReport(request: ApiRequest, response: ApiResponse, options: JobOptions = {}) {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  try {
    requireMethod(request, "POST")
    const claims = await requireHostedRunRequest(request, fetcher, clock())
    await limit(request, response, "hosted-job-report", claims.session, 120, fetcher)
    const contentType = header(request, "content-type")
    if (contentType && !contentType.toLowerCase().startsWith("application/json"))
      throw new ApiError(415, "CONTENT_TYPE_INVALID", "Send this request as JSON.")
    const id = queryValue(request, "id") ?? ""
    json(response, 200, await recordJobReport(claims, id, await readJson<unknown>(request, 64_000), options))
  } catch (error) {
    handleApiError(response, error)
  }
}

/**
 * `POST /api/hosted/jobs/:id/approve`: the person approves the job's pull request. The answer is its address, for the
 * person's own client to open; the server records when and merges nothing (S9). 240 an hour.
 */
export async function handleHostedJobApprove(request: ApiRequest, response: ApiResponse, options: JobOptions = {}) {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  try {
    requireMethod(request, "POST")
    await readBody(request, 1_024, [])
    const caller = await requireHostedCaller(request, fetcher, clock())
    await limit(request, response, "hosted-action", caller.account, 240, fetcher)
    json(response, 200, await approveHostedJob(caller.account, queryValue(request, "id") ?? "", options))
  } catch (error) {
    handleApiError(response, error)
  }
}
