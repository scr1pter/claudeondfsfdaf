import { enforceRateLimit, requireTrustedJsonRequest } from "./abuse.js"
import { bindingFor } from "./cloud-agents-binding.js"
import { cloudRunArtifactKey, cloudBrainArtifactKey } from "./cloud-agents-artifact.js"
import { requireCloudAgentsDesktop } from "./cloud-agents-desktop.js"
import { ownerCloudRun } from "./cloud-agents-runs.js"
import { githubApp } from "./github-app.js"
import { ApiError, json, readJson, requireMethod, type ApiRequest, type ApiResponse } from "./http.js"
import { persistentStore } from "./persistent-store.js"
import { GithubAgents } from "../../packages/core/src/github-agents.js"

export type OwnerArtifactReadInput = { rid: string; artifactId: string }
export type OwnerArtifactReadKey = {
  key: string
  keyId: string
  repositoryId: string
  thread: string
  rid: string
  artifactId: string
  publicRepository: boolean
}

/** Account-owner export authority is separate from live inference/dispatch authority and may read a completed run. */
export function createOwnerArtifactReadApi(
  input: {
    store?: typeof persistentStore
    fetcher?: typeof fetch
    now?: () => number
    env?: Readonly<Record<string, string | undefined>>
    app?: typeof githubApp
    limit?: (request: ApiRequest, response: ApiResponse, account: string) => Promise<void>
  } = {},
) {
  const store = input.store ?? persistentStore
  const fetcher = input.fetcher ?? fetch
  const now = input.now ?? Date.now
  const env = input.env ?? process.env
  const app = input.app ?? githubApp
  const limit =
    input.limit ??
    ((request, response, account) =>
      enforceRateLimit(request, response, {
        scope: "cloud-brain-owner-artifact",
        identifier: account,
        limit: 20,
        windowSeconds: 3600,
        requirePersistent: true,
      }))
  const read = async (request: ApiRequest, response: ApiResponse) => {
    requireMethod(request, "POST")
    if (env.VECTOR_GITHUB_BRAIN_ENABLED !== "true" || request.url?.includes("?")) throw unavailable()
    requireTrustedJsonRequest(request, 2000)
    const owner = await requireCloudAgentsDesktop(request, fetcher, now())
    await limit(request, response, owner.account)
    const body = await readJson<unknown>(request, 2000)
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some((field) => !["rid", "artifactId"].includes(field)) ||
      !("rid" in body) ||
      typeof body.rid !== "string" ||
      !GithubAgents.RUN_ID_PATTERN.test(body.rid) ||
      !("artifactId" in body) ||
      typeof body.artifactId !== "string" ||
      !/^[1-9]\d{0,15}$(?![\s\S])/.test(body.artifactId) ||
      !Number.isSafeInteger(Number(body.artifactId))
    )
      throw unavailable()
    const record = await ownerCloudRun(owner.account, body.rid, store)
    const binding = await bindingFor(record.repositoryId, store)
    if (!binding || binding.account !== owner.account || binding.generation !== record.generation || binding.suspended)
      throw unavailable()
    const metadata = await app.ownerArtifact(binding, record, body.artifactId)
    // Re-check after slow metadata calls. This key read never restores an expired run/model grant.
    const renewed = await requireCloudAgentsDesktop(request, fetcher, now())
    const current = await bindingFor(record.repositoryId, store)
    if (
      renewed.account !== owner.account ||
      !current ||
      current.account !== owner.account ||
      current.suspended ||
      current.generation !== record.generation ||
      metadata.repositoryId !== record.repositoryId ||
      metadata.generation !== record.generation
    )
      throw unavailable()
    const claims = { sub: owner.account, repo: record.repositoryId, gen: record.generation, thr: record.thread }
    const key = record.brain ? cloudBrainArtifactKey(claims, record.brain, env) : cloudRunArtifactKey(claims, env)
    const result: OwnerArtifactReadKey = {
      ...key,
      repositoryId: record.repositoryId,
      thread: record.thread,
      rid: record.rid,
      artifactId: body.artifactId,
      publicRepository: metadata.publicRepository,
    }
    json(response, 200, result)
  }
  return async (request: ApiRequest, response: ApiResponse) => {
    response.setHeader("x-content-type-options", "nosniff")
    response.setHeader("referrer-policy", "no-referrer")
    await read(request, response).catch(() => {
      if (!request.readableEnded) {
        response.setHeader("connection", "close")
        request.resume()
      }
      json(response, 503, {
        error: {
          code: "ARTIFACT_READ_UNAVAILABLE",
          message: "This GitHub result is unavailable. Reconnect the repository and try again from the desktop.",
        },
      })
    })
  }
}
function unavailable() {
  return new ApiError(503, "ARTIFACT_READ_UNAVAILABLE", "This GitHub result is unavailable.")
}
export const ownerArtifactReadApi = createOwnerArtifactReadApi()
