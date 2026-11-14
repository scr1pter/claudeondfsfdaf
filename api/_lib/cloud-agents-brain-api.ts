import { enforceRateLimit, requireTrustedJsonRequest } from "./abuse.js"
import { BRAIN_UPLOAD_MAX, commitBrainUpload, prepareBrainUpload, readBrainUpload } from "./cloud-agents-brain.js"
import { ApiError, json, readJson, requireMethod, type ApiRequest, type ApiResponse } from "./http.js"
import type { persistentStore } from "./persistent-store.js"

type Binding = { repositoryId: string; generation: number; publicRepository: boolean }
type RunReader = { account: string; repositoryId: string; generation: number; ticketHash: string;
  originalSource: "desktop"; deadline: number }
/** The GitHub lane supplies the real marked-desktop / live-vrt / binding authorities at its existing API boundary. */
export function createBrainUploadApi(input: {
  desktop: (request: ApiRequest) => Promise<{ account: string }>
  repository: (account: string, repositoryId: string) => Promise<Binding>
  run: (request: ApiRequest, uploadId: string) => Promise<RunReader>
  store?: typeof persistentStore
  now?: () => number
  env?: Readonly<Record<string, string | undefined>>
  limit?: (request: ApiRequest, response: ApiResponse, account: string, scope: string, count: number) => Promise<void>
}) {
  const limit = input.limit ?? ((request, response, account, scope, count) => enforceRateLimit(request, response,
    { identifier: account, scope, limit: count, windowSeconds: 3600, requirePersistent: true }))
  const body = async (request: ApiRequest, bytes: number, fields: readonly string[]) => {
    requireMethod(request, "POST")
    if (request.url?.includes("?")) throw invalid()
    requireTrustedJsonRequest(request, bytes)
    const value = await readJson<unknown>(request, bytes)
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((field) => !fields.includes(field))) throw invalid()
    return value as Record<string, unknown>
  }
  async function prepare(request: ApiRequest, response: ApiResponse) {
    requireMethod(request, "POST")
    const owner = await input.desktop(request)
    await limit(request, response, owner.account, "cloud-brain-prepare", 10)
    const value = await body(request, 2000, ["repositoryId", "sha256", "bytes", "includeBrain"])
    if (typeof value.repositoryId !== "string" || typeof value.sha256 !== "string" || typeof value.bytes !== "number" || value.includeBrain !== true) throw invalid()
    // A browser cannot pick a generation, visibility, source, account, or live-run identity for this attachment.
    const repository = await input.repository(owner.account, value.repositoryId)
    if (repository.repositoryId !== value.repositoryId) throw invalid()
    json(response, 200, await prepareBrainUpload({ ...repository, account: owner.account, sha256: value.sha256,
      bytes: value.bytes, includeBrain: true, source: "desktop" }, input))
  }
  async function commit(request: ApiRequest, response: ApiResponse) {
    requireMethod(request, "POST")
    const owner = await input.desktop(request)
    await limit(request, response, owner.account, "cloud-brain-commit", 20)
    const value = await body(request, Math.ceil((BRAIN_UPLOAD_MAX + 16) * 4 / 3) + 2000, ["uploadId", "nonce", "ciphertext"])
    if (typeof value.uploadId !== "string" || typeof value.nonce !== "string" || typeof value.ciphertext !== "string") throw invalid()
    json(response, 200, await commitBrainUpload({ account: owner.account, uploadId: value.uploadId,
      nonce: value.nonce, ciphertext: value.ciphertext }, input))
  }
  async function download(request: ApiRequest, response: ApiResponse) {
    const value = await body(request, 1000, ["uploadId"])
    if (typeof value.uploadId !== "string") throw invalid()
    const run = await input.run(request, value.uploadId)
    await limit(request, response, run.account, "cloud-brain-download", 120)
    json(response, 200, await readBrainUpload({ ...run, uploadId: value.uploadId }, input))
  }
  const safe = (handler: typeof prepare) => async (request: ApiRequest, response: ApiResponse) => {
    response.setHeader("x-content-type-options", "nosniff")
    response.setHeader("referrer-policy", "no-referrer")
    await handler(request, response).catch((error: unknown) => {
      if (!request.readableEnded) { response.setHeader("connection", "close"); request.resume() }
      const known = error instanceof ApiError ? error : undefined
      json(response, known?.statusCode ?? 503, { error: { code: known?.code ?? "BRAIN_UPLOAD_UNAVAILABLE", message: "This Brain attachment request could not be completed." } })
    })
  }
  return { prepare: safe(prepare), commit: safe(commit), download: safe(download) }
}
function invalid() { return new ApiError(400, "BRAIN_UPLOAD_INVALID", "Prepare and approve this Brain attachment again from your desktop.") }
