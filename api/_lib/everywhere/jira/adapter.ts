import { TERMINAL_STATES, type InboundTrigger } from "../../../../packages/schema/src/everywhere.js"
import { renderRefusal } from "../../../../packages/schema/src/everywhere-policy.js"
import { ApiError } from "../../http.js"
import type { EverywhereConfig } from "../config.js"
import { seal } from "../crypto.js"
import { eraseInstallation } from "../erase.js"
import { findMapping, installationAuthority, readInstallSnapshot, readLinkSnapshot, type RepoRef } from "../identity.js"
import { jobEraser, openReply, readJob, type JobsContext } from "../jobs.js"
import { everywhereKeys } from "../keys.js"
import { replaceNativeReservation } from "../native-resource.js"
import type { JobView, PlatformAdapter } from "../platform.js"
import type { Ports } from "../ports.js"
import { sha256Hex } from "../signature.js"
import { getValue, setValue } from "../store.js"
import { JiraFailure } from "./client.js"
import { JIRA_UUID } from "./fit.js"
import { jiraJobState } from "./render.js"
import { JIRA_TERMINAL, readJiraTask, writeJiraTask, type JiraTaskRecord, type JiraTaskSnapshot } from "./task-store.js"

export type JiraDeps = {
  readonly config: () => EverywhereConfig
  readonly context: () => JobsContext
  readonly ports: Ports
  readonly fetcher?: typeof fetch
  readonly sleep?: (ms: number) => Promise<void>
  /** Tests may tighten the native 50 s response bound; production always uses at most 50 s. */
  readonly requestTimeoutMs?: number
  readonly privateResult?: (input: { readonly account: string; readonly jid: string; readonly text: string }) => Promise<void>
}

export function jiraChoice(authority: string, task: string, place: string, repository: RepoRef) {
  return `vej1:${sha256Hex(authority, "\0", task, "\0", place, "\0", String(repository.id ?? ""), "\0", repository.fullName.toLowerCase())}`
}

export function createJiraAdapter(deps: JiraDeps) {
  const ctx = deps.context
  const assertTask = async (view: JobView) => {
    if (typeof view.reply.task !== "string" || !JIRA_UUID.test(view.reply.task)) throw new JiraFailure()
    const task = await readJiraTask(ctx().store, view.reply.task)
    const snapshot = await readInstallSnapshot(ctx().store, view.installation)
    if (!task || !snapshot || task.record.installation !== view.installation || task.record.userId !== view.reply.user ||
      task.record.contextId !== view.reply.ref || task.record.forgeInstallationId !== snapshot.record.forgeInstallationId ||
      task.record.authority !== installationAuthority(snapshot) || view.reply.installRevision !== task.record.authority)
      throw new ApiError(409, "JIRA_AUTHORITY_CHANGED", "The Jira connection changed. This result is held for review.")
    if (view.job && (view.job.requester.userId !== task.record.userId || view.job.installation !== task.record.installation ||
      (task.record.jid !== undefined ? task.record.jid !== view.jid : await getValue(ctx().store, everywhereKeys.nativeResource("jira", view.installation, task.record.contextId)) !== view.jid)))
      throw new ApiError(409, "JIRA_TASK_CHANGED", "The Jira task has moved to another request.")
    const account = view.job?.sponsor ?? task.record.account
    const linked = account ? await readLinkSnapshot(ctx().store, task.record.installation, task.record.userId) : undefined
    if (account && linked?.record.account !== account) throw new ApiError(409, "JIRA_LINK_CHANGED", "The Jira account link changed.")
    return { task, snapshot, account, linkRaw: linked?.raw }
  }
  const persist = async (view: JobView, update: (record: JiraTaskRecord) => JiraTaskRecord, input: { readonly draft?: unknown; readonly clearDraft?: boolean } = {}) => {
    const checked = await assertTask(view)
    const next = update({ ...checked.task.record, ...(checked.account ? { account: checked.account } : {}) })
    const linked = next.account ? await readLinkSnapshot(ctx().store, next.installation, next.userId) : undefined
    if (next.account && linked?.record.account !== next.account) throw new ApiError(409, "JIRA_LINK_CHANGED", "The Jira account link changed.")
    if (await writeJiraTask(ctx(), next, { expected: checked.task, installationRaw: checked.snapshot.raw, linkRaw: linked?.raw, ...input }) !== "written") throw new JiraFailure()
  }
  const triggerView = async (trigger: InboundTrigger): Promise<JobView> => {
    const id = await getValue(ctx().store, everywhereKeys.jiraContext(trigger.installation, trigger.actor.userId, trigger.thread.ref))
    const task = id && JIRA_UUID.test(id) ? await readJiraTask(ctx().store, id) : undefined
    if (!task || task.record.userId !== trigger.actor.userId || task.record.installation !== trigger.installation) throw new JiraFailure()
    return { jid: "", platform: "jira", installation: trigger.installation, shared: true,
      reply: { task: task.record.id, ref: task.record.contextId, user: task.record.userId, installRevision: task.record.authority } }
  }
  const control = async (trigger: InboundTrigger, state: JiraTaskRecord["state"], code?: JiraTaskRecord["code"], text?: string) => {
    const view = await triggerView(trigger)
    await persist(view, (record) => JIRA_TERMINAL.has(record.state) ? record : ({ ...record, state, code,
      ...(text ? { resultEnc: seal(ctx().keys, text, everywhereKeys.jiraTask(record.id)) } : {}) }))
  }
  const adapter: PlatformAdapter = {
    id: "jira", ackMs: 55_000,
    verify: async () => ({ ok: false, status: 401 }),
    parse: () => ({ ignore: "verified-a2a-route-required" }),
    acknowledge: async () => undefined,
    reserve: async (parsed, view) => {
      const checked = await assertTask(view)
      if (JIRA_TERMINAL.has(checked.task.record.state)) return undefined
      const key = everywhereKeys.nativeResource("jira", view.installation, parsed.trigger.thread.ref)
      const previous = await getValue(ctx().store, key)
      if (previous) {
        const job = await readJob(ctx().store, previous)
        if (!job || !TERMINAL_STATES.has(job.state) || !await replaceNativeReservation(ctx().store, key, previous, view.jid)) return undefined
      } else if (!await setValue(ctx().store, key, view.jid, { ttlMs: 30_000, onlyNew: true })) return undefined
      return { resource: parsed.trigger.thread.ref, owner: view.jid }
    },
    progress: async (view) => {
      if (!view.job) return
      const current = await readJob(ctx().store, view.jid)
      if (!current || TERMINAL_STATES.has(current.state)) return
      await persist(view, (record) => JIRA_TERMINAL.has(record.state) ? record : ({ ...record, jid: view.jid, state: jiraJobState(current), code: undefined, resultEnc: undefined }), { clearDraft: true })
    },
    finish: async (view, result) => {
      if (!view.job) throw new JiraFailure()
      const current = await readJob(ctx().store, view.jid)
      if (!current) throw new JiraFailure()
      await persist(view, (record) => JIRA_TERMINAL.has(record.state) && record.jid ? record : ({ ...record, jid: current.jid, state: jiraJobState(current), code: undefined,
        resultEnc: seal(ctx().keys, result.text, everywhereKeys.jiraTask(record.id)) }), { clearDraft: true })
      if (result.privateText) {
        const checked = await assertTask(view)
        if (checked.task.record.privateDelivered) return
        if (!deps.privateResult) throw new ApiError(503, "JIRA_PRIVATE_DELIVERY_UNAVAILABLE", "The private result is held until the owner surface is connected.")
        await deps.privateResult({ account: current.sponsor, jid: current.jid, text: result.privateText })
        await persist(view, (record) => ({ ...record, privateDelivered: true }))
      }
    },
    linkPrompt: (trigger) => control(trigger, "AUTH_REQUIRED", "link"),
    help: (trigger) => control(trigger, "REJECTED", "unsupported"),
    refuse: (trigger, code) => control(trigger, "REJECTED", undefined, renderRefusal(code, { platform: "jira", shared: true })),
    repositoryPrompt: async (trigger, _repositories, view) => {
      if (!view || typeof view.reply.place !== "string") throw new JiraFailure()
      const checked = await assertTask(view)
      const mapping = await findMapping(ctx().store, trigger.installation, view.reply.place)
      const options = (mapping?.repositories ?? []).slice(0, 20).map((repository) => ({ repository,
        value: jiraChoice(checked.task.record.authority, checked.task.record.id, String(view.reply.place), repository) }))
      const text = options.length ? `Reply with one exact repository option:\n${options.map((option) => `${option.value} — ${option.repository.fullName}`).join("\n")}` :
        "Ask the site connector to map this Jira project to a repository, then send your task again."
      await persist(view, (record) => ({ ...record, state: "INPUT_REQUIRED", code: "repository", resultEnc: seal(ctx().keys, text, everywhereKeys.jiraTask(record.id)) }),
        { draft: { kind: "repository", parsed: { trigger, place: view.reply.place, reply: view.reply }, options } })
    },
    erase: (installation) => eraseInstallation({ ...ctx(), jobs: jobEraser(ctx().store) }, installation, "revoked").then(() => undefined),
  }
  return { adapter, assertTask, persist }
}

/** A current job reference is recovered through the atomic admission pointer, not an HTTP callback's memory. */
export async function jiraTaskJob(ctx: JobsContext, task: JiraTaskSnapshot) {
  const jid = task.record.jid ?? await getValue(ctx.store, everywhereKeys.nativeResource("jira", task.record.installation, task.record.contextId))
  if (!jid) return undefined
  const job = await readJob(ctx.store, jid)
  const reply = job && openReply(ctx, job)
  if (!job || job.platform !== "jira" || job.installation !== task.record.installation || job.requester.userId !== task.record.userId ||
    reply?.task !== task.record.id || reply.ref !== task.record.contextId || reply.installRevision !== task.record.authority) return undefined
  return job
}
