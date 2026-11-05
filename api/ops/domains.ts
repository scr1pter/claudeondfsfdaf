import { timingSafeEqual } from "node:crypto"
import { ApiError, handleApiError, json, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import {
  addOpsDomain,
  listOpsDomains,
  opsRateLimit,
  readOpsBody,
  removeOpsDomain,
  requireOpsCaller,
  requireOpsCaps,
  reverifyOpsDomains,
  verifyOpsDomain,
  type OpsVerifyOptions,
} from "../_lib/ops-api.js"
import { requireOpsService } from "../_lib/ops-worker.js"

export const maxDuration = 60
const BUDGET_MS = 45_000

export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleOpsDomains(request, response)
}

/** The daily job calls with `Authorization: Bearer <CRON_SECRET>`; every other request is an account's. */
function fromCron(request: ApiRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const supplied = Buffer.from(String(request.headers.authorization ?? ""))
  const expected = Buffer.from(`Bearer ${secret}`)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

/**
 * `/api/ops/domains` (WP A47): the domains an account verified for On Call and Release Guard.
 *
 * - `GET`: each domain with its status (`pending`, `verified`, `lost`), what to publish to prove it (a DNS TXT record at
 *   `_vector-verify.<domain>` or the file `/.well-known/vector-verify.txt`), when it is next checked, and whether it is
 *   past the plan's count; the plan's count; whether the Worker has the current list. 240 an hour per account.
 * - `POST {domain}`: adds a domain to verify (the same domain again answers it unchanged), within the plan's count.
 * - `POST {domain, verify: true}`: checks it now. 20 an hour per account.
 * - `DELETE {domain}`: removes it and the On Call URLs on it, whatever the plan.
 * - `GET` with the cron secret: the daily job (contract §4.19, 04:10 UTC) checks again each verified domain whose week
 *   is up and updates the Worker. It answers counts only.
 *
 * Writes take 60 an hour per account. Adding and checking need the ops services and a plan that includes them.
 */
export async function handleOpsDomains(
  request: ApiRequest,
  response: ApiResponse,
  fetcher: typeof fetch = fetch,
  clock: () => number = Date.now,
  options: OpsVerifyOptions = {},
) {
  try {
    if (request.method === "GET" && fromCron(request))
      return json(response, 200, await reverifyOpsDomains({ fetcher, clock, budgetMs: BUDGET_MS, ...options }))
    const now = clock()
    if (request.method === "GET") {
      const caller = await requireOpsCaller(request, fetcher, now)
      await opsRateLimit(request, response, "ops-read", caller.account, 240, fetcher)
      return json(response, 200, await listOpsDomains(caller.account, fetcher, now))
    }
    if (request.method !== "POST" && request.method !== "DELETE")
      throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use GET, POST or DELETE for this endpoint.")
    const body = await readOpsBody(request, request.method === "POST" ? ["domain", "verify"] : ["domain"])
    const caller = await requireOpsCaller(request, fetcher, now)
    await opsRateLimit(request, response, "ops-write", caller.account, 60, fetcher)
    if (request.method === "DELETE")
      return json(response, 200, await removeOpsDomain(caller.account, body.domain, fetcher, now))
    if (body.verify !== undefined && typeof body.verify !== "boolean")
      throw new ApiError(400, "OPS_INVALID", "Send verify: true to check the domain now.")
    await requireOpsService(fetcher, now)
    const caps = await requireOpsCaps(caller.account, fetcher, now)
    if (body.verify !== true)
      return json(response, 200, await addOpsDomain(caller.account, body.domain, caps, fetcher, now))
    await opsRateLimit(request, response, "ops-verify", caller.account, 20, fetcher)
    json(response, 200, await verifyOpsDomain(caller.account, body.domain, caps, fetcher, now, options))
  } catch (error) {
    handleApiError(response, error)
  }
}
