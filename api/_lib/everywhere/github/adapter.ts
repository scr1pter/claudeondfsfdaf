import { ACCOUNT_ID_PATTERN, BODY_LIMITS, GITHUB_EVENTS, TERMINAL_STATES, TIMING, createJobId, decodeGithubReference, githubThreadUrl, isRepositoryName, type InboundTrigger } from "../../../../packages/schema/src/everywhere.js"
import { decideRoute } from "../../../../packages/schema/src/everywhere-policy.js"
import { ApiError, json, readJson, requireMethod, type ApiRequest, type ApiResponse } from "../../http.js"
import { platformOn, readConfig, type EverywhereConfig } from "../config.js"
import { useOnce } from "../dedupe.js"
import { createJob, finishGithubOffer, offerJob, readJob, type JobsContext } from "../jobs.js"
import { KEEP_MS, everywhereKeys } from "../keys.js"
import { countJob, readCounts } from "../limits.js"
import type { PlatformAdapter } from "../platform.js"
import { safePorts, type Ports, type Repository } from "../ports.js"
import { routeFacts } from "../router.js"
import { productionContext } from "../runtime.js"
import { githubStatus, type GithubStatusPort } from "./status.js"

/** The verifier owns signature/audience=handoff/current workflow/ref/SHA/runner checks. Raw claims are insufficient. */
export type GithubHandoffIdentity = { repositoryId: number; repository: string; actorId: number; runId: number; runAttempt: number; eventName: string }
export type GithubHandoffBinding = {
  account: string; githubId: number; installationId: number; laptopFirst: boolean; codiumMode: boolean
  workflowVersion: string; repository: Repository
}

export function createGithubAdapter(input: { readonly context: () => JobsContext; readonly status?: GithubStatusPort }): PlatformAdapter {
  const status = githubStatus({ context: input.context, port: input.status })
  return {
    id: "github", ackMs: 20_000,
    verify: async () => ({ ok: false, status: 501 }), parse: () => ({ ignore: "use-verified-handoff" }),
    acknowledge: async () => undefined,
    progress: async (job, milestone) => {
      if (["received", "finding", "actions", "waiting"].includes(milestone)) return
      await status.progress(job, milestone as Parameters<typeof status.progress>[1])
    },
    finish: (job, result) => status.finish(job, result.text),
    linkPrompt: async () => undefined, help: async () => undefined, refuse: async () => undefined,
    repositoryPrompt: async () => undefined, erase: async () => undefined,
  }
}

export function createGithubHandoff(deps: {
  readonly verify?: (token: string, now: number) => Promise<GithubHandoffIdentity | undefined>
  /** Current active binding; this port owns revocation/suspension and immutable repository/binder checks. */
  readonly binding?: (repositoryId: number) => Promise<GithubHandoffBinding | undefined>
  readonly config?: () => EverywhereConfig
  readonly context?: () => JobsContext
  readonly ports?: Ports
  readonly status?: GithubStatusPort
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
} = {}) {
  const now = deps.now ?? Date.now
  const context = deps.context ?? productionContext
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const adapter = createGithubAdapter({ context, status: deps.status })
  return async (request: ApiRequest, response: ApiResponse) => {
    try {
      requireMethod(request, "POST")
      // Deliberately no production OIDC adapter until R-A5/VE-31 is reviewed and wired.
      if (!deps.verify || !deps.binding) return json(response, 501, { error: { code: "HANDOFF_UNAVAILABLE" } })
      const config = (deps.config ?? readConfig)()
      if (!platformOn(config, "github")) return json(response, 404, { error: { code: "EVERYWHERE_OFF" } })
      const authorization = request.headers.authorization
      const token = typeof authorization === "string" ? /^Bearer ([A-Za-z0-9_.-]{20,16384})$/.exec(authorization)?.[1] : undefined
      const identity = token ? await deps.verify(token, now()) : undefined
      const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0
      if (!identity || !positive(identity.repositoryId) || !positive(identity.actorId) || !positive(identity.runId) || !isRepositoryName(identity.repository))
        return json(response, 401, { error: { code: "HANDOFF_IDENTITY_INVALID" } })
      const back = () => json(response, 200, { handled: false })
      if (identity.runAttempt !== 1 || !(GITHUB_EVENTS as readonly string[]).includes(identity.eventName)) return back()
      const binding = await deps.binding(identity.repositoryId)
      if (!binding || !ACCOUNT_ID_PATTERN.test(binding.account) || binding.githubId !== identity.actorId || !positive(binding.installationId) ||
        !binding.laptopFirst || !binding.codiumMode || binding.repository.id !== identity.repositoryId ||
        binding.repository.fullName.toLowerCase() !== identity.repository.toLowerCase()) return back()
      const body = await readJson<unknown>(request, BODY_LIMITS.github)
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "HANDOFF_INVALID", "Invalid handoff reference.")
      const fields = body as Record<string, unknown>
      if (Object.keys(fields).some((key) => !["kind", "issue", "pr", "commentId", "bodySha256", "thread", "workflowVersion"].includes(key)) ||
        !positive(fields.issue) || !["issue", "pr"].includes(String(fields.kind)) || fields.workflowVersion !== binding.workflowVersion ||
        typeof fields.workflowVersion !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(fields.workflowVersion) ||
        (fields.pr !== undefined && (fields.kind !== "pr" || fields.pr !== fields.issue))) throw new ApiError(400, "HANDOFF_INVALID", "Invalid handoff reference.")
      const reference = decodeGithubReference({ kind: fields.kind, number: fields.issue, actorId: identity.actorId, event: identity.eventName,
        ...(fields.commentId === undefined ? {} : { commentId: fields.commentId }), ...(fields.bodySha256 === undefined ? {} : { bodySha256: fields.bodySha256 }) })
      const ref = `${binding.repository.fullName}#${fields.issue}`
      if (!reference.ok || (fields.thread !== ref && fields.thread !== githubThreadUrl(binding.repository.fullName, reference.value.kind, reference.value.number)))
        throw new ApiError(400, "HANDOFF_INVALID", "Invalid handoff reference.")
      const ctx = context()
      if (!await useOnce(ctx.store, everywhereKeys.handoff(identity.repositoryId, identity.runId), KEEP_MS.handoff)) return back()
      const ports = deps.ports ?? safePorts(config)
      const trigger: InboundTrigger = { platform: "github", installation: `github:${binding.installationId}`, deliveryId: String(identity.runId),
        actor: { userId: String(identity.actorId), bot: false, external: false, guest: false }, kind: "mention", thread: { ref }, task: "", context: [],
        github: reference.value, repository: binding.repository, shared: binding.repository.shared }
      const subject = { sponsor: binding.account, installation: trigger.installation, userId: trigger.actor.userId }
      const counts = await readCounts(ctx.store, subject, now())
      const facts = await routeFacts({ ctx, ports, trigger, sponsor: binding.account, repository: binding.repository, counts, receivedAt: ctx.now,
        github: { actorId: identity.actorId, binderId: binding.githubId } })
      if (decideRoute(facts).action !== "offer" || !(await countJob(ctx.store, subject, now())).admitted) return back()
      const created = await createJob(context(), { platform: "github", installation: trigger.installation, kind: "mention", sponsor: binding.account,
        requester: { userId: trigger.actor.userId, account: binding.account }, repository: binding.repository, shared: trigger.shared,
        github: reference.value, task: "", context: [], reply: { ref } }, { jid: createJobId(now()) })
      if (!created.ok) return back()
      const offered = await offerJob(context(), created.job.jid)
      if (!offered.ok) { await finishGithubOffer(context(), created.job.jid); return back() }
      const deadline = now() + TIMING.offerWindowMs
      const delivery = { state: "pending" as "pending" | "sent" | "unavailable" }
      void ports.offer(binding.account, offered.offer.offer).then((result) => { delivery.state = result }, () => { delivery.state = "unavailable" })
      while (now() < deadline) {
        const job = await readJob(ctx.store, created.job.jid)
        if (!job || job.startedAt !== undefined || TERMINAL_STATES.has(job.state)) break
        if (job.claimedAt === undefined && (delivery.state === "unavailable" || (job.declines?.length ?? 0) >= facts.computers || job.declines?.some((item) => item.reason === "busy"))) break
        await sleep(Math.min(200, deadline - now()))
      }
      const handled = await finishGithubOffer(context(), created.job.jid)
      if (handled) {
        const job = await readJob(ctx.store, created.job.jid)
        if (job) await adapter.progress({ jid: job.jid, platform: "github", installation: job.installation, shared: job.shared, reply: {}, job }, "laptop").catch(() => undefined)
      }
      return json(response, 200, handled ? { handled: true, jid: created.job.jid } : { handled: false })
    } catch (error) {
      // After admission an uncertain failure must not tell a workflow to start a parallel Actions run.
      return json(response, error instanceof ApiError ? error.statusCode : 503, { error: { code: error instanceof ApiError ? error.code : "HANDOFF_UNCERTAIN" } })
    }
  }
}
