import { requireTrustedJsonRequest } from "../_lib/abuse.js"
import { ApiError, handleApiError, json, readJson, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import { decodeUploads, requireVaultWriter } from "../_lib/vault-api.js"
import { reserveUploads, unavailable, vaultNotFound } from "../_lib/vault-store.js"

// 1000 objects of {id, size} are about 90 KB of JSON.
const BODY_BYTES = 160_000

export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleVaultUploads(request, response)
}

/**
 * `POST /api/vault/uploads {version, objects ≤1000, manifest?: {size}}` (WP A44). The client declares every object of
 * a new version, held already or not, in batches, and its manifest's size in the last request. In one transaction the
 * server reserves quota for what it does not hold (402 `VAULT_QUOTA` when it does not all fit, and then nothing is
 * reserved or signed), records what the version names, and only then signs a PUT for each missing object, carrying
 * its exact size, valid 900 seconds. Answers `{uploads: [{id, url}], present: [id], manifest?: {url}, expiresAt}`.
 * Write rules in vault-api.ts.
 */
export async function handleVaultUploads(
  request: ApiRequest,
  response: ApiResponse,
  fetcher: typeof fetch = fetch,
  clock: () => number = Date.now,
) {
  try {
    requireMethod(request, "POST")
    requireTrustedJsonRequest(request, BODY_BYTES)
    const writer = await requireVaultWriter(request, response, fetcher, clock())
    const now = clock()
    const body = decodeUploads(await readJson(request, BODY_BYTES), now)
    const reserved = await reserveUploads(
      writer.account,
      {
        version: body.version,
        versionAt: body.versionAt,
        objects: body.objects,
        ...(body.manifest ? { manifest: body.manifest.size } : {}),
        quotaBytes: writer.quotaBytes,
        versionDays: writer.versionDays,
      },
      { fetcher, now },
    )
    switch (reserved.status) {
      case "ok":
        return json(response, 200, {
          uploads: reserved.uploads,
          present: reserved.present,
          ...(reserved.manifest ? { manifest: reserved.manifest } : {}),
          expiresAt: reserved.expiresAt,
        })
      case "not_found":
        throw vaultNotFound()
      case "committed":
        throw new ApiError(409, "VAULT_EXISTS", "That backup version is already saved. Run the backup again.")
      case "quota":
        throw new ApiError(
          402,
          "VAULT_QUOTA",
          "Your Brain Vault is full. Forget an older version, or back up to your own GitHub repository.",
        )
      case "versions":
        throw new ApiError(
          402,
          "VAULT_QUOTA",
          "Your Brain Vault holds as many versions as it can. Forget an older version, then back up again.",
        )
      case "open":
        throw new ApiError(429, "RATE_LIMITED", "Too many Brain Vault backups are running. Try again shortly.", {
          retryAfterSeconds: 60,
        })
      case "mismatch":
        throw new ApiError(
          409,
          "VAULT_SIZE_MISMATCH",
          "A piece of this backup was declared with another size. Run the backup again.",
        )
      case "busy":
        throw unavailable(30)
    }
  } catch (error) {
    handleApiError(response, error)
  }
}
