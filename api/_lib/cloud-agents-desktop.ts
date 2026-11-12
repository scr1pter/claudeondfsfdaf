import { enforceRateLimit, requireTrustedJsonRequest } from "./abuse.js"
import { verifyDesktopToken } from "./cli-token.js"
import { bindingFor } from "./cloud-agents-binding.js"
import { createBrainUploadApi } from "./cloud-agents-brain-api.js"
import { bindBrainUpload } from "./cloud-agents-brain.js"
import { cloudAgentEntitlement, cloudAgentRevokedBefore } from "./cloud-agents-entitlement.js"
import { listedPerks } from "./codium-perks.js"
import { liveRun } from "./cloud-agents-ledger.js"
import { requireRunToken } from "./cloud-agents-run-token.js"
import { prepareCloudRun } from "./cloud-agents-start.js"
import { githubApp } from "./github-app.js"
import { cloudBrainArtifactKey } from "./cloud-agents-artifact.js"
import { recordRunBrainContext } from "./cloud-agents-runs.js"
import { ApiError, json, readJson, requireMethod, type ApiRequest, type ApiResponse } from "./http.js"
import { persistentStore } from "./persistent-store.js"
import { requireUnrevokedCliToken } from "./revocation.js"

const ID = /^[1-9]\d{0,15}$(?![\s\S])/
const UPLOAD = /^vbu_[A-Za-z0-9_-]{32}$(?![\s\S])/
const HASH = /^[0-9a-f]{64}$(?![\s\S])/
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)

/** Website sessions and ordinary CLI tokens cannot establish an owner-started desktop attachment. */
export async function requireCloudAgentsDesktop(request: ApiRequest, fetcher: typeof fetch = fetch, now = Date.now()) {
  const header = request.headers.authorization
  if (typeof header !== "string" || !header.startsWith("Bearer vct_")) throw unavailable()
  const user = verifyDesktopToken(header.slice("Bearer ".length), now)
  await requireUnrevokedCliToken(header.slice("Bearer ".length), fetcher, now)
  return { account: user.id }
}

/** Routes stay off until the complete desktop/runner attachment flow has passed acceptance. */
export function createDesktopCloudAgentApi(
  input: {
    store?: typeof persistentStore
    fetcher?: typeof fetch
    now?: () => number
    env?: Readonly<Record<string, string | undefined>>
    app?: typeof githubApp
    prepare?: typeof prepareCloudRun
    bind?: typeof bindBrainUpload
    eligible?: (account: string) => Promise<boolean>
    limit?: (request: ApiRequest, response: ApiResponse, account: string, scope: string, count: number) => Promise<void>
  } = {},
) {
  const store = input.store ?? persistentStore
  const now = input.now ?? Date.now
  const fetcher = input.fetcher ?? fetch
  const app = input.app ?? githubApp
  const env = input.env ?? process.env
  const eligible =
    input.eligible ??
    (async (account: string) => {
      const [allowance, listed] = await Promise.all([
        cloudAgentEntitlement(account, { source: "desktop", now: now() }, fetcher),
        listedPerks(fetcher),
      ])
      return allowance.active && listed.has("github-agents") && listed.has("brain-cloud")
    })
  const requireEligible = async (account: string) => {
    if (!(await eligible(account))) throw unavailable()
  }
  const limit =
    input.limit ??
    ((request, response, account, scope, count) =>
      enforceRateLimit(request, response, {
        identifier: account,
        scope,
        limit: count,
        windowSeconds: 3600,
        requirePersistent: true,
      }))
  const enabled = () => {
    if (env.VECTOR_GITHUB_BRAIN_ENABLED !== "true") throw unavailable()
  }
  const desktop = async (request: ApiRequest) => {
    enabled()
    const owner = await requireCloudAgentsDesktop(request, fetcher, now())
    await requireEligible(owner.account)
    return owner
  }
  const repository = async (account: string, repositoryId: string) => {
    if (!ID.test(repositoryId) || !Number.isSafeInteger(Number(repositoryId))) throw unavailable()
    const binding = await bindingFor(repositoryId, store)
    if (!binding || binding.account !== account || binding.suspended || Number(binding.workflowVersion) < 3)
      throw unavailable()
    const current = await app.attachmentRepository(binding)
    if (
      current.repositoryId !== repositoryId ||
      current.generation !== binding.generation ||
      typeof current.publicRepository !== "boolean"
    )
      throw unavailable()
    return current
  }
  const attachments = createBrainUploadApi({
    store,
    now,
    env,
    desktop,
    repository,
    limit,
    conversation: async (run, attachment) => {
      await recordRunBrainContext({ ...run, sha256: attachment.sha256, now: now() }, store)
      return cloudBrainArtifactKey(
        { sub: run.account, repo: run.repositoryId, gen: run.generation, thr: run.thread },
        { sha256: attachment.sha256, publicRepository: run.publicRepository },
        env,
      )
    },
    run: async (request) => {
      enabled()
      const claims = await requireRunToken(
        request,
        { allowAfterDeadline: false },
        { now: now(), store, revokedBefore: (account) => cloudAgentRevokedBefore(account, fetcher) },
      )
      await requireEligible(claims.sub)
      const live = await liveRun(claims.sub, claims.rid, store)
      if (
        !live ||
        live.jti !== claims.jti ||
        live.gen !== claims.gen ||
        live.repo !== claims.repo ||
        live.thr !== claims.thr ||
        live.deadline !== claims.dl ||
        live.triggerSource !== "desktop" ||
        live.src !== "github-dispatch" ||
        live.pur !== "task" ||
        !live.ticketHash ||
        !HASH.test(live.ticketHash)
      )
        throw unavailable()
      const current = await repository(claims.sub, claims.repo)
      return {
        account: claims.sub,
        repositoryId: claims.repo,
        generation: claims.gen,
        ticketHash: live.ticketHash,
        originalSource: "desktop" as const,
        deadline: claims.dl,
        publicRepository: current.publicRepository,
        rid: claims.rid,
        jti: claims.jti,
        thread: claims.thr,
      }
    },
  })
  const start = async (request: ApiRequest, response: ApiResponse) => {
    requireMethod(request, "POST")
    if (request.url?.includes("?")) throw unavailable()
    requireTrustedJsonRequest(request, 104_000)
    const owner = await desktop(request)
    await limit(request, response, owner.account, "cloud-brain-desktop-start", 10)
    const value = await readJson<unknown>(request, 104_000)
    if (
      !record(value) ||
      Object.keys(value).some((field) => !["repositoryId", "prompt", "brain"].includes(field)) ||
      typeof value.repositoryId !== "string" ||
      typeof value.prompt !== "string" ||
      !value.prompt.trim() ||
      Buffer.byteLength(value.prompt) > 100_000 ||
      !record(value.brain) ||
      Object.keys(value.brain).some((field) => !["uploadId", "sha256"].includes(field)) ||
      typeof value.brain.uploadId !== "string" ||
      !UPLOAD.test(value.brain.uploadId) ||
      typeof value.brain.sha256 !== "string" ||
      !HASH.test(value.brain.sha256)
    )
      throw unavailable()
    const current = await repository(owner.account, value.repositoryId)
    const prepared = await (input.prepare ?? prepareCloudRun)(
      {
        account: owner.account,
        source: "desktop",
        purpose: "task",
        target: { kind: "github-run", repositoryId: Number(current.repositoryId) },
        prompt: value.prompt,
      },
      { store, now, fetcher, app, brainUpload: value.brain.uploadId },
    )
    if (!prepared.ok) throw unavailable()
    try {
      await (input.bind ?? bindBrainUpload)(
        {
          account: owner.account,
          ...current,
          uploadId: value.brain.uploadId,
          sha256: value.brain.sha256,
          ticketHash: prepared.ticketHash,
        },
        { store, now, env },
      )
      const dispatched = await prepared.dispatch()
      if (!dispatched.ok) throw unavailable()
      json(response, 200, { ok: true, dispatchedAt: dispatched.dispatchedAt })
    } catch (error) {
      await prepared.cancel()
      throw error
    }
  }
  return {
    ...attachments,
    start: async (request: ApiRequest, response: ApiResponse) => {
      response.setHeader("x-content-type-options", "nosniff")
      response.setHeader("referrer-policy", "no-referrer")
      await start(request, response).catch(() => {
        if (!request.readableEnded) {
          response.setHeader("connection", "close")
          request.resume()
        }
        json(response, 503, {
          error: {
            code: "BRAIN_UPLOAD_UNAVAILABLE",
            message: "This repository attachment is unavailable. Update setup and try again from the desktop.",
          },
        })
      })
    },
  }
}

function unavailable() {
  return new ApiError(503, "BRAIN_UPLOAD_UNAVAILABLE", "This repository attachment is unavailable.")
}
export const desktopCloudAgentApi = createDesktopCloudAgentApi()
