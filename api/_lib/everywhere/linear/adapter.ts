import { randomUUID } from "node:crypto"
import { TERMINAL_STATES, isRepositoryName, type InboundTrigger } from "../../../../packages/schema/src/everywhere.js"
import { EVERYWHERE_PAGE, renderRefusal } from "../../../../packages/schema/src/everywhere-policy.js"
import { ApiError } from "../../http.js"
import type { EverywhereConfig } from "../config.js"
import { eraseInstallation } from "../erase.js"
import { checkInstallAuthority, findLink, findMapping, installGuards, installationAuthority, readInstallSnapshot } from "../identity.js"
import { checkJobAuthority, jobEraser, openReply, readJob, updateJobReply, type JobsContext } from "../jobs.js"
import { everywhereKeys } from "../keys.js"
import { replaceNativeReservation } from "../native-resource.js"
import type { JobView, NativeReservation, PlatformAdapter, ReplyReference } from "../platform.js"
import type { Ports } from "../ports.js"
import { fencedStore } from "../authority.js"
import { getValue, setValue, swapValue } from "../store.js"
import { linearApi, LinearFailure, type LinearApi } from "./client.js"
import { linearAccess } from "./credentials.js"
import { linearPlan, linearThought } from "./render.js"
import { linearOptions, restoreLinearSelection } from "./selection.js"
import { linearId, linearObject, verifyLinear } from "./verify.js"

export type LinearDeps = {
  readonly config: () => EverywhereConfig
  readonly context: () => JobsContext
  readonly ports: Ports
  readonly fetcher?: typeof fetch
  readonly sleep?: (ms: number) => Promise<void>
  /** Owner surface port: must deliver privately and idempotently by account + jid. Absent means held, never public. */
  readonly privateResult?: (input: { readonly account: string; readonly jid: string; readonly text: string }) => Promise<void>
}

function reference(reply: ReplyReference) {
  if (!linearId(reply.session) || !linearId(reply.user)) throw new ApiError(400, "LINEAR_REFERENCE_INVALID", "The Linear session is unavailable.")
  return { session: reply.session, user: reply.user }
}

function triggerView(trigger: InboundTrigger): JobView {
  return { jid: "", platform: "linear", installation: trigger.installation, shared: trigger.shared,
    reply: { session: trigger.thread.ref, ref: trigger.thread.ref, user: trigger.actor.userId, delivery: trigger.deliveryId } }
}

export function createLinearAdapter(deps: LinearDeps): PlatformAdapter {
  const ctx = deps.context
  const erase = async (installation: string) => {
    const snapshot = await readInstallSnapshot(ctx().store, installation)
    if (snapshot) await eraseInstallation({ ...ctx(), jobs: jobEraser(ctx().store) }, installation, "revoked", { expected: snapshot })
  }
  const assertAuthority = async (view: JobView) => {
    const current = await readInstallSnapshot(ctx().store, view.installation)
    if (!current || (view.reply.appUser !== undefined && view.reply.appUser !== current.record.botUserId) || ((view.job || view.reply.installRevision !== undefined) &&
      (typeof view.reply.installRevision !== "string" || installationAuthority(current) !== view.reply.installRevision)))
      throw new ApiError(409, "LINEAR_AUTHORITY_CHANGED", "The Linear connection changed. This result is held for review.")
    await checkInstallAuthority(ctx(), view.installation, current)
    if (view.job) await checkJobAuthority(ctx(), view.job)
    if (view.job && await getValue(ctx().store, everywhereKeys.nativeResource("linear", view.installation, reference(view.reply).session)) !== view.jid)
      throw new ApiError(409, "LINEAR_SESSION_CHANGED", "This Linear session has moved to another task.")
    return current
  }
  const client = (view: JobView, deadline?: number, final = false): LinearApi => async (operation, variables) => {
    await assertAuthority(view)
    if (view.job) {
      const current = await readJob(ctx().store, view.jid)
      if (!current || (!final && TERMINAL_STATES.has(current.state)) || (current.state === "cancelled" && !["create", "activity"].includes(operation)))
        throw new ApiError(409, "LINEAR_STOPPED", "This Linear task has ended.")
    }
    const config = deps.config().linear
    if (!config) throw new LinearFailure(false)
    const access = await linearAccess({ context: ctx, config, installation: view.installation, fetcher: deps.fetcher, deadline })
    const current = await assertAuthority(view)
    // A concurrent refresh can preserve the authorization revision while rotating credentials. Hold rather than
    // send the obsolete token and mistake its 401 for revocation of the newer valid pair.
    if (current.record.tokenEnc !== access.record.tokenEnc) throw new LinearFailure(false)
    const scoped = fencedStore(ctx().store, await installGuards(ctx(), view.installation, current))
    return linearApi({ token: access.token, fetcher: deps.fetcher, now: () => ctx().now, deadline,
      beforeRequest: async () => {
        const latest = await assertAuthority(view)
        if (latest.raw !== current.raw || latest.record.tokenEnc !== access.record.tokenEnc) throw new LinearFailure(false)
        if (view.job) {
          const job = await readJob(ctx().store, view.jid)
          if (!job || (!final && TERMINAL_STATES.has(job.state)) || (job.state === "cancelled" && !["create", "activity"].includes(operation)))
            throw new ApiError(409, "LINEAR_STOPPED", "This Linear task has ended.")
        }
      },
      // Access-token auth failures are renewable or ambiguous; they never prove grant revocation.
      cooldown: {
        read: async () => {
          const score = await ctx().store(["ZSCORE", everywhereKeys.linearRetry(view.installation), "until"])
          if (score === null || score === undefined) return 0
          if (typeof score !== "string" || !/^[0-9]{1,16}$/.test(score)) throw new LinearFailure(false)
          return Number(score)
        },
        write: async (at) => { await scoped(["ZADD", everywhereKeys.linearRetry(view.installation), "GT", Math.ceil(at), "until"]); await scoped(["PEXPIRE", everywhereKeys.linearRetry(view.installation), 86_400_000]) },
      },
    })(operation, variables)
  }

  const locked = async <T>(view: JobView, terminal: boolean, work: () => Promise<T>): Promise<T | undefined> => {
    const key = everywhereKeys.nativeResourceLock("linear", view.installation, reference(view.reply).session)
    const owner = randomUUID()
    if (!await setValue(ctx().store, key, owner, { ttlMs: 120_000, onlyNew: true })) {
      if (terminal) throw new LinearFailure(false)
      return undefined
    }
    try { return await work() } finally { await swapValue(ctx().store, key, owner, undefined) }
  }

  const receipt = async (view: JobView, kind: string) => {
    if (view.job) {
      const current = await readJob(ctx().store, view.jid)
      const known = current && openReply(ctx(), current)?.[kind]
      if (linearId(known)) return known
      const id = randomUUID()
      if (!await updateJobReply(ctx(), view.jid, { [kind]: id })) throw new LinearFailure(true)
      return id
    }
    const key = everywhereKeys.linearReceipt(view.installation, `${view.reply.delivery ?? view.reply.session}:${kind}`)
    const snapshot = await assertAuthority(view)
    await setValue(fencedStore(ctx().store, await installGuards(ctx(), view.installation, snapshot)), key, randomUUID(), { ttlMs: 7 * 86_400_000, onlyNew: true })
    const id = await getValue(ctx().store, key)
    if (!linearId(id)) throw new LinearFailure(true)
    return id
  }

  const activity = async (view: JobView, kind: string, content: { readonly type: "thought" | "elicitation" | "response" | "error"; readonly body: string },
    options: { readonly ephemeral?: boolean; readonly signal?: "auth" | "select"; readonly signalMetadata?: Readonly<Record<string, unknown>>; readonly deadline?: number; readonly final?: boolean } = {}) => {
    const ref = reference(view.reply)
    const id = await receipt(view, kind)
    const call = client(view, options.deadline, options.final)
    try {
      const data = await call("create", { input: { id, agentSessionId: ref.session, content,
        ...(options.ephemeral ? { ephemeral: true } : {}), ...(options.signal ? { signal: options.signal, signalMetadata: options.signalMetadata } : {}) } })
      const result = linearObject(data.agentActivityCreate)
      if (result.success !== true || linearObject(result.agentActivity).id !== id) throw new LinearFailure(true)
    } catch (error) {
      if (!(error instanceof LinearFailure) || !error.uncertain) throw error
      // The published API accepts a stable activity UUID. Recover that exact native object after a lost response.
      const data = await call("activity", { id })
      const found = linearObject(data.agentActivity)
      const record = (await assertAuthority(view)).record
      if (found.id !== id || linearObject(found.agentSession).id !== ref.session || linearObject(found.user).id !== record.botUserId ||
        linearObject(found.content).__typename !== `AgentActivity${content.type[0]!.toUpperCase()}${content.type.slice(1)}Content` || linearObject(found.content).body !== content.body)
        throw new LinearFailure(true)
      if (options.signal && found.signal !== options.signal) throw new LinearFailure(true)
      if (options.signal === "auth") {
        const metadata = linearObject(found.signalMetadata)
        if (["url", "providerName", "userId"].some((field) => metadata[field] !== options.signalMetadata?.[field])) throw new LinearFailure(true)
      }
      if (options.signal === "select") {
        const returned = linearObject(found.signalMetadata).options
        const sent = options.signalMetadata?.options
        if (!Array.isArray(returned) || !Array.isArray(sent) || returned.length !== sent.length ||
          sent.some((item, index) => linearObject(returned[index]).value !== linearObject(item).value || linearObject(returned[index]).label !== linearObject(item).label)) throw new LinearFailure(true)
      }
    }
  }

  const adapter: PlatformAdapter = {
    id: "linear", ackMs: 4_000, heartbeats: true,
    verify: async (raw, headers, now) => verifyLinear(raw, headers, deps.config().linear?.webhookSecret, now),
    parse: () => ({ ignore: "installation-required" }),
    acknowledge: async (view) => {
      if (view.reply.initial === true && view.reply.stop !== true) await activity(view, "initialActivityId", { type: "thought", body: "Received your request. Checking the connection and workspace." }, { ephemeral: true, deadline: ctx().now + 8_000 })
    },
    prepare: async (parsed) => {
      if (parsed.trigger.kind === "stop") return parsed // Signed exact creator + linked sponsor checks cancel first; no context or membership API follows stop.
      const view = { ...triggerView(parsed.trigger), reply: parsed.reply }
      const snapshot = await assertAuthority(view)
      const checked = { ...view, reply: { ...view.reply, installRevision: installationAuthority(snapshot) } }
      const call = client(checked)
      const user = linearObject((await call("user", { id: parsed.trigger.actor.userId })).user)
      if (user.id !== parsed.trigger.actor.userId) return { ignore: "identity" }
      const actor = { ...parsed.trigger.actor, bot: user.app !== false, guest: user.guest !== false,
        external: user.active !== true || linearObject(user.organization).id !== parsed.trigger.installation.slice("linear:".length) }
      if (actor.bot || actor.guest || actor.external || parsed.reply.needsPrompt === true) return { ...parsed, trigger: { ...parsed.trigger, actor } }
      const mapping = await findMapping(ctx().store, parsed.trigger.installation, parsed.place)
      const selected = await restoreLinearSelection({ parsed, call, authority: installationAuthority(snapshot), bot: snapshot.record.botUserId ?? "", repositories: mapping?.repositories ?? [] })
      if (!selected && isRepositoryName(parsed.trigger.task)) throw new ApiError(409, "LINEAR_SELECTION_UNVERIFIED", "Choose the exact repository option or send your coding task again.")
      return { ...parsed, trigger: { ...parsed.trigger, actor, ...(selected ?? {}) }, reply: { ...parsed.reply, installRevision: installationAuthority(snapshot) } }
    },
    control: async (parsed) => {
      if (parsed.reply.needsPrompt !== true) return false
      const linked = await findLink(ctx().store, parsed.trigger.installation, parsed.trigger.actor.userId)
      if (!linked) await adapter.linkPrompt(parsed.trigger)
      else await activity({ ...triggerView(parsed.trigger), reply: parsed.reply }, "originActivityId", { type: "elicitation",
        body: "Send your own coding task in this session before Vector starts. A delegation alone does not establish who requested the work." })
      return true
    },
    reserve: async (parsed, view): Promise<NativeReservation | undefined> => locked(view, false, async () => {
      const snapshot = await assertAuthority(view)
      const scoped = fencedStore(ctx().store, await installGuards(ctx(), view.installation, snapshot))
      const key = everywhereKeys.nativeResource("linear", view.installation, parsed.trigger.thread.ref)
      const previous = await getValue(ctx().store, key)
      if (previous) {
        const job = await readJob(ctx().store, previous)
        // A fresh pending pointer has no job yet. Its 30 s lease must expire; never race that worker into a second job.
        if (!job || !TERMINAL_STATES.has(job.state)) return undefined
        if (!await replaceNativeReservation(scoped, key, previous, view.jid)) return undefined
      } else if (!await setValue(scoped, key, view.jid, { ttlMs: 30_000, onlyNew: true })) return undefined
      return { resource: parsed.trigger.thread.ref, owner: view.jid }
    }),
    progress: async (view, milestone) => {
      if (!view.job) return
      await locked(view, false, async () => {
        const current = await readJob(ctx().store, view.jid)
        if (!current || TERMINAL_STATES.has(current.state)) return
        const reply = openReply(ctx(), current) ?? {}
        if (milestone === "heartbeat" && typeof reply.lastNativeAt === "number" && ctx().now - reply.lastNativeAt < 20 * 60_000) return
        const call = client(view)
        if (milestone === "started") {
          if (!linearId(view.reply.issue) || !linearId(view.reply.team)) throw new LinearFailure(false)
          const issue = linearObject((await call("issue", { id: view.reply.issue })).issue)
          if (issue.id !== view.reply.issue || linearObject(issue.team).id !== view.reply.team) throw new LinearFailure(false)
          if (!["started", "completed", "canceled"].includes(String(linearObject(issue.state).type))) {
            const team = linearObject((await call("states", { id: view.reply.team })).team)
            if (team.id !== view.reply.team) throw new LinearFailure(false)
            const first = (Array.isArray(linearObject(team.states).nodes) ? linearObject(team.states).nodes as unknown[] : []).map(linearObject)
              .filter((state) => linearId(state.id) && typeof state.position === "number" && Number.isFinite(state.position)).sort((left, right) => Number(left.position) - Number(right.position))[0]
            if (first) {
              const result = linearObject((await call("start", { id: view.reply.issue, state: first.id })).issueUpdate)
              if (result.success !== true) throw new LinearFailure(true)
            }
          }
        }
        await activity(view, `activity_${milestone}_${Math.floor(ctx().now / (20 * 60_000))}`, { type: "thought", body: linearThought(milestone) }, { ephemeral: true })
        if (!await updateJobReply(ctx(), view.jid, { lastNativeAt: ctx().now })) throw new LinearFailure(true)
        if (milestone !== "heartbeat") {
          const result = linearObject((await call("session", { id: reference(view.reply).session, input: { plan: linearPlan(milestone) } })).agentSessionUpdate)
          if (result.success !== true) throw new LinearFailure(true)
        }
      })
    },
    finish: async (view, result) => {
      await locked(view, true, async () => {
        const current = await readJob(ctx().store, view.jid)
        if (!current) throw new LinearFailure(false)
        const cancelled = current.state === "cancelled"
        const call = client(view, undefined, true)
        if (!cancelled) {
          const page = new URL(`https://${EVERYWHERE_PAGE}`)
          page.searchParams.set("job", view.jid)
          const links = [{ label: "Vector job", url: page.href }, ...(current.result?.prUrl ? [{ label: "Draft pull request", url: current.result.prUrl }] : [])]
          if (linearObject((await call("session", { id: reference(view.reply).session,
            input: { plan: linearPlan("pushing", "completed"), addedExternalUrls: links } })).agentSessionUpdate).success !== true) throw new LinearFailure(true)
        }
        await activity(view, "resultActivityId", { type: current.outcome === "failed" || current.state === "failed" ? "error" : "response", body: result.text }, { final: true })
        if (result.privateText && openReply(ctx(), current)?.privateDelivered !== true) {
          if (!deps.privateResult) throw new ApiError(503, "LINEAR_PRIVATE_DELIVERY_UNAVAILABLE", "The private result is held until the owner surface is connected.")
          await assertAuthority(view)
          await deps.privateResult({ account: current.sponsor, jid: current.jid, text: result.privateText })
          if (!await updateJobReply(ctx(), view.jid, { privateDelivered: true })) throw new LinearFailure(true)
        }
      })
    },
    linkPrompt: (trigger) => activity(triggerView(trigger), "authActivityId", { type: "elicitation", body: "Link your own Vector account to continue." },
      { signal: "auth", signalMetadata: { url: `https://${EVERYWHERE_PAGE}`, providerName: "Vector", userId: trigger.actor.userId } }),
    help: (trigger) => activity(triggerView(trigger), "helpActivityId", { type: "response", body: "Send your coding task in this session. Link your own Vector account, choose a mapped repository, and keep your computer online. Use the native stop control to cancel." }),
    refuse: (trigger, code) => activity(triggerView(trigger), "refusalActivityId", { type: "error", body: renderRefusal(code, { platform: "linear", shared: trigger.shared }) }),
    repositoryPrompt: async (trigger, _repositories, view) => {
      if (!view || !linearId(view.reply.team)) throw new LinearFailure(false)
      const snapshot = await assertAuthority(view)
      const mapping = await findMapping(ctx().store, trigger.installation, String(view.reply.team))
      const nonce = await receipt(view, "repositoryActivityId")
      const options = linearOptions(installationAuthority(snapshot), String(view.reply.team), mapping?.repositories ?? [], nonce)
      if (!options.length) {
        await activity(view, "mappingActivityId", { type: "elicitation", body: "Ask the workspace connector to map this team to a repository in Vector settings, then send your task again." })
        return
      }
      await activity(view, "repositoryActivityId", { type: "elicitation", body: "Choose one of this team's mapped repositories." }, { signal: "select", signalMetadata: { options } })
    },
    erase,
  }
  return adapter
}
