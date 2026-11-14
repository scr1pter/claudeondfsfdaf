import { ApiError, handleApiError, json, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import { opsRateLimit, requireOpsCaller } from "../_lib/ops-api.js"
import { listReleases, type ReleaseRecord } from "../_lib/release-guard.js"

export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleOpsReleases(request, response)
}

/** A watch whose end passed this long ago without a verdict shows as ended (superseded, or nothing conclusive). */
const VERDICT_GRACE_MS = 5 * 60_000

export function releaseView(release: ReleaseRecord, now: number) {
  const state =
    release.state === "watching" && release.endAt !== undefined && now > release.endAt + VERDICT_GRACE_MS
      ? "ended"
      : release.state
  return {
    repositoryId: release.repositoryId,
    repository: release.repository,
    environment: release.environment,
    sha: release.sha,
    deployment: release.deployment,
    at: release.at,
    state,
    ...(release.reason ? { reason: release.reason } : {}),
    ...(release.startAt ? { startAt: release.startAt } : {}),
    ...(release.endAt ? { endAt: release.endAt } : {}),
    ...(release.endedAt ? { endedAt: release.endedAt } : {}),
    ...(release.incident ? { incident: release.incident } : {}),
    paths: release.urls.length,
  }
}

/**
 * `GET /api/ops/releases` (WP A48): the production releases Release Guard took, newest first: watching, passed,
 * regressed (with its incident), skipped (with the reason: the day's cap, the Worker's own answer), or ended without a
 * verdict. `?repositoryId=` narrows it to one repository. URLs are not listed, only how many paths were watched.
 * Callers: an unrevoked `vct_` account token or a website session; run tokens get 401 (S3). 240 an hour per account.
 */
export async function handleOpsReleases(
  request: ApiRequest,
  response: ApiResponse,
  fetcher: typeof fetch = fetch,
  clock: () => number = Date.now,
) {
  try {
    if (request.method !== "GET") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use GET for this endpoint.")
    const now = clock()
    const caller = await requireOpsCaller(request, fetcher, now)
    await opsRateLimit(request, response, "ops-read", caller.account, 240, fetcher)
    const query = new URL(request.url ?? "/", "https://vectordev.ai").searchParams.get("repositoryId")
    const repositoryId = query === null ? undefined : Number(query)
    if (repositoryId !== undefined && (!Number.isSafeInteger(repositoryId) || repositoryId <= 0))
      throw new ApiError(400, "OPS_INVALID", "Name the repository by id.")
    const releases = (await listReleases(caller.account, fetcher, 100))
      .filter((release) => repositoryId === undefined || release.repositoryId === repositoryId)
      .slice(0, 50)
    json(response, 200, { releases: releases.map((release) => releaseView(release, now)) })
  } catch (error) {
    handleApiError(response, error)
  }
}
