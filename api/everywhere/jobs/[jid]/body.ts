import { requireRunToken, type RunTokenDeps } from "../../../_lib/cloud-agents-run-token.js"
import { codiumAccountAuthority } from "../../../_lib/everywhere/adapters/account.js"
import { createRunBodyVisibility } from "../../../_lib/everywhere/adapters/cloud-agents.js"
import type { AccountAuthorityPort } from "../../../_lib/everywhere/authority.js"
import { platformOn, readConfig, type Env } from "../../../_lib/everywhere/config.js"
import { isBusy, readRunBody } from "../../../_lib/everywhere/jobs.js"
import { everywhereStore, type Store } from "../../../_lib/everywhere/store.js"
import { admits, codiumSwitches, readEverywhereSwitch, type CodiumSwitches } from "../../../_lib/everywhere/switch.js"
import {
  ApiError,
  handleApiError,
  json,
  queryValue,
  requireMethod,
  type ApiRequest,
  type ApiResponse,
} from "../../../_lib/http.js"
import { persistentStore } from "../../../_lib/persistent-store.js"

/*
 * Vector everywhere: an Actions run reads its job's body by reference (contract 3.6, R-A4, VE-30, E4, E11).
 *
 *   GET /api/everywhere/jobs/<jid>/body   Authorization: Bearer vrt_…   → {task, context, outside}
 *
 * Only @vector's run token works, checked by its own verifier until the run's deadline (signature, claims, the live
 * run, the binding and revocation; 401 otherwise). The body goes only to the run that `run:<rid>` links to this job,
 * which the start hook writes, and only once (410 after). Another account's job, another run's token, an unlinked
 * run, a GitHub job, a job whose repository is no longer confirmed private and a job whose platform is no longer
 * listed all get the same 404, which leaves the read unspent. While the feature is off (the flag or the data
 * key) the route answers 404 `EVERYWHERE_OFF` before the token or the store is read, and under the `stop` switch after
 * the token. The body, its context and the requester's label are never logged; only fixed lines with a rid or a jid
 * are, by the token check and the jobs module.
 */

export const config = { api: { bodyParser: false } }

export type BodyRouteDeps = {
  readonly env?: Env
  readonly store?: Store
  /** The account-deletion authority (Codium's tombstone); the default is the production adapter. */
  readonly accountAuthority?: AccountAuthorityPort
  /** For the default store's and switches' calls. */
  readonly fetcher?: typeof fetch
  readonly now?: () => number
  /** Codium's switches (R-C6); the default reads Codium's own record. */
  readonly switches?: CodiumSwitches
  /** The run token check's store and revocation seam; the defaults are @vector's. */
  readonly runTokens?: Pick<RunTokenDeps, "store" | "revokedBefore">
  readonly visibility?: ReturnType<typeof createRunBodyVisibility>
}

export function createJobBodyRoute(deps: BodyRouteDeps = {}) {
  const clock = deps.now ?? Date.now
  return async (request: ApiRequest, response: ApiResponse) => {
    try {
      requireMethod(request, "GET")
      const everywhere = readConfig(deps.env ?? process.env)
      if (!everywhere.enabled) return json(response, 404, { error: { code: "EVERYWHERE_OFF" } })
      const now = clock()
      const claims = await requireRunToken(request, { allowAfterDeadline: false }, { now, ...deps.runTokens })
      const fetcher = deps.fetcher ?? fetch
      if (!admits(await readEverywhereSwitch(everywhere, deps.switches ?? codiumSwitches(fetcher)), "running"))
        return json(response, 404, { error: { code: "EVERYWHERE_OFF" } })
      const accountAuthority = deps.accountAuthority ?? codiumAccountAuthority
      const visibility =
        deps.visibility ??
        createRunBodyVisibility({
          store: deps.runTokens?.store ?? ((command) => persistentStore(command, fetcher)),
        })
      const verdict = await readRunBody(
        {
          store: deps.store ?? everywhereStore(fetcher, accountAuthority),
          keys: everywhere.dataKeys,
          now,
          accountAuthority,
        },
        {
          jid: queryValue(request, "jid") ?? "",
          account: claims.sub,
          rid: claims.rid,
          repository: claims.repo,
          platformOn: (platform) => platformOn(everywhere, platform),
          isPrivate: async (repository) => {
            const observed = await visibility({
              account: claims.sub,
              repositoryId: repository.id,
              generation: claims.gen,
              fullName: repository.fullName,
            })
            return observed === "private" && clock() < claims.dl
          },
        },
      )
      if (verdict.ok) return json(response, 200, verdict.body)
      if (verdict.status === 410)
        throw new ApiError(410, verdict.code, "This job's request was already read or is no longer kept.")
      throw notFound()
    } catch (error) {
      if (isBusy(error))
        return handleApiError(
          response,
          new ApiError(503, "EVERYWHERE_BUSY", "Vector everywhere is busy. Try again.", { retryAfterSeconds: 2 }),
        )
      // A closed account or a removed platform link: the job is no longer this run's to read.
      if (error instanceof ApiError && error.code === "EVERYWHERE_AUTHORITY_CHANGED")
        return handleApiError(response, notFound())
      handleApiError(response, error)
    }
  }
}

function notFound() {
  return new ApiError(404, "NOT_FOUND", "Not found.")
}

export default createJobBodyRoute()
