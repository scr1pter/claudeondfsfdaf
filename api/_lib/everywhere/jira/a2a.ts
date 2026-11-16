import { randomUUID } from "node:crypto"
import { LIMITS, TERMINAL_STATES, createJobId, decodeInboundTrigger, isIssueKey, isRepositoryName } from "../../../../packages/schema/src/everywhere.js"
import { renderEnd } from "../../../../packages/schema/src/everywhere-policy.js"
import { ApiError, json, readRawBody, requireMethod, type ApiRequest, type ApiResponse } from "../../http.js"
import { after } from "../after.js"
import { checkAccount } from "../authority.js"
import { platformOn } from "../config.js"
import { seal } from "../crypto.js"
import { eraseInstallation } from "../erase.js"
import { createJobEvents } from "../events.js"
import { findMapping, installationAuthority, issueConnectCode, readInstallSnapshot, readLinkSnapshot, redeemLinkCode } from "../identity.js"
import { createIntake } from "../intake.js"
import { cancelJob, jobEraser, sweepAccount } from "../jobs.js"
import { everywhereKeys, USER_ID_PATTERNS } from "../keys.js"
import type { JobView, ParsedTrigger } from "../platform.js"
import { constantTimeEqual, hmacSha256Hex, sha256Hex } from "../signature.js"
import { getValue, setValue } from "../store.js"
import { createJiraAdapter, jiraChoice, jiraTaskJob, type JiraDeps } from "./adapter.js"
import { jiraClient, JiraFailure } from "./client.js"
import { createFitVerifier, JIRA_UUID, jiraObject, type ForgeInvocation } from "./fit.js"
import { JIRA_INVOCATIONS, jiraRequester, parseJira } from "./parse.js"
import { jiraTask } from "./render.js"
import { JIRA_TERMINAL, readJiraDraft, readJiraTask, writeJiraTask, type JiraTaskRecord, type JiraTaskSnapshot } from "./task-store.js"

function rpcError(response: ApiResponse, id: string | number | null, code: number, reason: string, message: string) {
  return json(response, 200, { jsonrpc: "2.0", id, error: { code, message,
    data: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain: "a2a-protocol.org" }] } })
}

/** Native A2A 1.0 polling. FIT is verified before body parsing; requester tokens never leave this invocation. */
export function createJiraRoutes(deps: JiraDeps) {
  const ctx = deps.context
  const native = createJiraAdapter(deps)
  const events = createJobEvents(ctx, { jira: native.adapter })
  const verify = createFitVerifier({ appId: () => deps.config().jira?.forgeAppId, fetcher: deps.fetcher, now: () => ctx().now })
  const installation = (invocation: ForgeInvocation) => `jira:${invocation.cloudId}`
  const view = (record: JiraTaskRecord): JobView => ({ jid: record.jid ?? "", platform: "jira", installation: record.installation, shared: true,
    reply: { task: record.id, ref: record.contextId, user: record.userId, installRevision: record.authority } })
  const owned = async (invocation: ForgeInvocation, id: string) => {
    if (!JIRA_UUID.test(id)) return undefined
    const task = await readJiraTask(ctx().store, id)
    const current = await readInstallSnapshot(ctx().store, installation(invocation))
    if (!task || task.record.installation !== installation(invocation) || task.record.forgeInstallationId !== invocation.installationId ||
      task.record.userId !== invocation.principal || (current ? task.record.authority !== installationAuthority(current) ||
        current.record.forgeInstallationId !== invocation.installationId : task.record.authority !== "unconnected")) return undefined
    if (current) await checkAccount(ctx(), current.record.connector)
    if (task.record.account) await checkAccount(ctx(), task.record.account)
    if (task.record.account && (await readLinkSnapshot(ctx().store, task.record.installation, task.record.userId))?.record.account !== task.record.account) return undefined
    return task
  }
  const consume = async (invocation: ForgeInvocation) => {
    const key = everywhereKeys.fit(sha256Hex(deps.config().jira!.forgeAppId, "\0", invocation.cloudId, "\0", invocation.installationId, "\0", invocation.jti))
    if (!await setValue(ctx().store, key, "used", { ttlMs: Math.max(1, invocation.expiresAt - ctx().now), onlyNew: true }))
      throw new ApiError(401, "JIRA_INVOCATION_REPLAY", "The Jira invocation has already been used.")
  }
  const terminal = async (task: JiraTaskSnapshot, state: "COMPLETED" | "CANCELED", text: string, job?: Awaited<ReturnType<typeof jiraTaskJob>>) => {
    const update = (record: JiraTaskRecord): JiraTaskRecord => ({ ...record, state, ...(job ? { jid: job.jid } : {}),
      resultEnc: seal(ctx().keys, text, everywhereKeys.jiraTask(record.id)) })
    if (task.record.authority === "unconnected") {
      if (await writeJiraTask(ctx(), update(task.record), { expected: task, clearDraft: true }) !== "written") throw new JiraFailure()
    } else await native.persist({ ...view(task.record), ...(job ? { jid: job.jid, job } : {}) }, update, { clearDraft: true })
  }
  const resolve = async (task: JiraTaskSnapshot) => {
    // Inspect the persisted state before lazy sweep changes a late laptop to lost/expired. The native cap's text
    // must describe that observed state and must not claim the computer stopped.
    if (!JIRA_TERMINAL.has(task.record.state) && ctx().now - task.record.createdAt >= 50 * 60_000) {
      const job = await jiraTaskJob(ctx(), task)
      await terminal(task, "COMPLETED", renderEnd(job?.state === "running" ? "jira-running" : "jira-waiting", "jira"), job)
    }
    if (task.record.account) {
      const ended = await sweepAccount(ctx(), task.record.account, { stop: await deps.ports.switch("everywhere") === "stop" })
      for (const item of ended) await events.ended?.(item).catch(() => undefined)
    }
    const job = await jiraTaskJob(ctx(), task)
    if (job && TERMINAL_STATES.has(job.state)) await events.ended?.({ job, ending: job.ending }).catch(() => undefined)
    const fresh = await readJiraTask(ctx().store, task.record.id) ?? task
    if (JIRA_TERMINAL.has(fresh.record.state)) return { task: fresh, job, wire: jiraTask(ctx(), fresh.record) }
    if (job && TERMINAL_STATES.has(job.state)) return { task: fresh, job, wire: jiraTask(ctx(), fresh.record, undefined, { state: "WORKING", text: "Preparing the result." }) }
    if (!job && fresh.record.state === "SUBMITTED" && ctx().now - fresh.record.createdAt > 2 * 60_000 && fresh.record.authority !== "unconnected") {
      await native.persist(view(fresh.record), (record) => ({ ...record, state: "FAILED", resultEnc: seal(ctx().keys,
        "The request did not start. Send your task again.", everywhereKeys.jiraTask(record.id)) }), { clearDraft: true })
      const failed = await readJiraTask(ctx().store, fresh.record.id)
      if (failed) return { task: failed, job, wire: jiraTask(ctx(), failed.record) }
    }
    return { task: fresh, job, wire: jiraTask(ctx(), fresh.record, job) }
  }
  const call = (invocation: ForgeInvocation, request: ApiRequest) => {
    const token = request.headers["x-forge-oauth-user"]
    if (typeof token !== "string") throw new ApiError(401, "JIRA_USER_TOKEN_REQUIRED", "Jira did not supply the invoking user's authorization.")
    return jiraClient({ cloudId: invocation.cloudId, userToken: token, fetcher: deps.fetcher, store: ctx().store, now: () => ctx().now })
  }
  const intake = async (parsed: ParsedTrigger) => createIntake(native.adapter, { config: deps.config(), store: ctx().store, ports: deps.ports,
    now: () => ctx().now, sleep: deps.sleep }).process(parsed, { jid: createJobId(ctx().now), platform: "jira", installation: parsed.trigger.installation,
      shared: true, reply: parsed.reply })
  const fingerprint = (message: unknown, keyId?: string) => {
    const key = keyId ? ctx().keys.find((key) => key.id === keyId) : ctx().keys[0]
    if (!key) throw new JiraFailure()
    return `${key.id}:${hmacSha256Hex(key.key, "jira-native-message\0", JSON.stringify(message))}`
  }

  const nativeWork = (record: JiraTaskRecord, work: () => Promise<unknown>) => after("jira-task", async () => {
    try { await work() } catch (error) {
      const selection = error instanceof ApiError && error.code === "JIRA_SELECTION_UNVERIFIED"
      await native.persist(view(record), (current) => JIRA_TERMINAL.has(current.state) ? current : ({ ...current,
        state: selection ? "INPUT_REQUIRED" : error instanceof ApiError && error.statusCode === 403 ? "REJECTED" : "FAILED",
        resultEnc: seal(ctx().keys, selection ? "Choose an exact current repository option or send your task again." : "The request could not be verified or completed. Send your task again.", everywhereKeys.jiraTask(current.id)),
      }), { clearDraft: !selection }).catch(() => undefined)
    }
  })
  const link = async (request: ApiRequest, invocation: ForgeInvocation, task: JiraTaskSnapshot, text: string) => {
    await jiraRequester(call(invocation, request), invocation.principal!)
    const result = await redeemLinkCode(ctx(), { code: text.replace(/^link\s+/i, ""), installation: task.record.installation, userId: invocation.principal!,
      actor: { bot: false, guest: false, external: false }, place: "private" })
    await native.persist(view(task.record), (record) => ({ ...record, ...(result.ok ? { account: result.account } : {}), state: result.ok ? "COMPLETED" : "REJECTED", code: undefined,
      resultEnc: seal(ctx().keys, result.ok ? "Your Vector account is linked. Assign Vector a work item or mention it in your own comment." : "The link code could not be used. Create a new one in your Vector account.", everywhereKeys.jiraTask(record.id)),
    }), { clearDraft: true })
    return (await readJiraTask(ctx().store, task.record.id))!
  }
  const a2a = async (request: ApiRequest, response: ApiResponse, signal: AbortSignal) => {
    try {
      requireMethod(request, "POST")
      if (!platformOn(deps.config(), "jira")) return json(response, 404, { error: { code: "EVERYWHERE_OFF" } })
      const raw = await readRawBody(request, 1_048_576)
      signal.throwIfAborted()
      const authorization = request.headers.authorization
      if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) throw new ApiError(401, "JIRA_INVOCATION_INVALID", "The Jira invocation could not be verified.")
      const invocation = await verify(authorization.slice(7))
      signal.throwIfAborted()
      if (!invocation.principal || invocation.moduleKey !== "vector-a2a") throw new ApiError(401, "JIRA_PRINCIPAL_REQUIRED", "A verified Jira requester is required.")
      await consume(invocation)
      signal.throwIfAborted()
      const body = jiraObject(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)))
      const id = typeof body.id === "string" && body.id.length <= 128 || typeof body.id === "number" && Number.isSafeInteger(body.id) ? body.id as string | number : null
      if (body.jsonrpc !== "2.0" || id === null || typeof body.method !== "string") return rpcError(response, id, -32600, "INVALID_REQUEST", "Invalid request")
      const params = jiraObject(body.params)
      if (["SendStreamingMessage", "SubscribeToTask"].includes(body.method)) return rpcError(response, id, -32601, "METHOD_NOT_FOUND", "Streaming is not supported")
      if (body.method === "GetTask" || body.method === "CancelTask") {
        const task = typeof params.id === "string" && await owned(invocation, params.id)
        if (!task) return rpcError(response, id, body.method === "GetTask" ? -32001 : -32002, body.method === "GetTask" ? "TASK_NOT_FOUND" : "TASK_NOT_CANCELABLE", "Task not available")
        const current = await resolve(task)
        signal.throwIfAborted()
        if (body.method === "CancelTask") {
          if (JIRA_TERMINAL.has(current.task.record.state) || current.job && TERMINAL_STATES.has(current.job.state)) return rpcError(response, id, -32002, "TASK_NOT_CANCELABLE", "The task has ended")
          if (current.job) {
            const cancelled = await cancelJob(ctx(), current.job.jid)
            if (!cancelled.ok) return rpcError(response, id, -32002, "TASK_NOT_CANCELABLE", "The task has ended")
            await terminal(current.task, "CANCELED", "Cancelled at your request.", cancelled.job)
            await events.ended?.({ job: cancelled.job }).catch(() => undefined)
          } else await terminal(current.task, "CANCELED", "Cancelled at your request.")
          return json(response, 200, { jsonrpc: "2.0", id, result: jiraTask(ctx(), (await readJiraTask(ctx().store, task.record.id))!.record) })
        }
        return json(response, 200, { jsonrpc: "2.0", id, result: current.wire })
      }
      if (body.method !== "SendMessage") return rpcError(response, id, -32601, "METHOD_NOT_FOUND", "Method not found")
      const message = jiraObject(params.message)
      if (message.role !== "ROLE_USER" || !JIRA_UUID.test(String(message.messageId)) || !Array.isArray(message.parts) || message.parts.length < 1 || message.parts.length > 2 ||
        message.contextId !== undefined && !JIRA_UUID.test(String(message.contextId))) return rpcError(response, id, -32602, "INVALID_PARAMS", "Invalid message")
      const parts = message.parts.map(jiraObject)
      const textParts = parts.filter((part) => typeof part.text === "string")
      const dataParts = parts.filter((part) => part.data && typeof part.data === "object" && !Array.isArray(part.data))
      if (textParts.length !== 1 || dataParts.length > 1 || textParts.length + dataParts.length !== parts.length || String(textParts[0]!.text).length > 32_768)
        return rpcError(response, id, -32602, "INVALID_PARAMS", "Invalid message parts")
      const text = String(textParts[0]!.text).trim()
      const data = dataParts.length ? jiraObject(dataParts[0]!.data) : undefined
      if (data && (data.userAccountId !== invocation.principal || typeof data.agentAccountId !== "string" || !USER_ID_PATTERNS.jira.test(data.agentAccountId)))
        return rpcError(response, id, -32602, "REQUESTER_MISMATCH", "The requester does not match this invocation")
      const install = await readInstallSnapshot(ctx().store, installation(invocation))
      if (install && install.record.forgeInstallationId !== invocation.installationId) throw new ApiError(401, "JIRA_INSTALLATION_CHANGED", "The Jira installation changed.")
      const known = await getValue(ctx().store, everywhereKeys.jiraMessage(installation(invocation), invocation.principal, String(message.messageId)))
      if (known) {
        const previous = await owned(invocation, known)
        if (!previous || !constantTimeEqual(previous.record.inputHash, fingerprint(message, previous.record.inputHash.split(":")[0])))
          return rpcError(response, id, -32602, "MESSAGE_CONFLICT", "The message id has already been used")
        return json(response, 200, { jsonrpc: "2.0", id, result: { task: (await resolve(previous)).wire } })
      }
      const linked = install && await readLinkSnapshot(ctx().store, installation(invocation), invocation.principal)
      const contextPointer = message.contextId && await getValue(ctx().store, everywhereKeys.jiraContext(installation(invocation), invocation.principal, String(message.contextId)))
      const previous = typeof contextPointer === "string" ? await owned(invocation, contextPointer) : undefined
      if (message.contextId && !previous) return rpcError(response, id, -32602, "CONTEXT_NOT_FOUND", "The conversation is not available")
      if (previous && !JIRA_TERMINAL.has(previous.record.state)) {
        const current = await resolve(previous)
        signal.throwIfAborted()
        if (!JIRA_TERMINAL.has(current.task.record.state)) {
          if (install && !data && /^link\s+\S+$/i.test(text)) return json(response, 200, { jsonrpc: "2.0", id,
            result: { task: jiraTask(ctx(), (await link(request, invocation, current.task, text)).record) } })
          if (!data && ["INPUT_REQUIRED", "AUTH_REQUIRED"].includes(current.task.record.state) && install && linked && text && text.length <= LIMITS.taskChars) {
            nativeWork(current.task.record, async () => {
              const read = call(invocation, request)
              await jiraRequester(read, invocation.principal!)
              const draft = jiraObject(await readJiraDraft(ctx(), current.task.record))
              const saved = jiraObject(draft.parsed)
              const base = jiraObject(saved.trigger)
              const original = decodeInboundTrigger(base)
              const options = Array.isArray(draft.options) ? draft.options.map(jiraObject) : []
              const selected = options.find((option) => option.value === text)
              const mapping = typeof saved.place === "string" ? await findMapping(ctx().store, installation(invocation), saved.place) : undefined
              const repository = selected && jiraObject(selected.repository)
              if (current.task.record.code === "repository" && (!original.ok || !repository || !mapping?.repositories.some((entry) => entry.id !== undefined &&
                entry.id === repository.id && entry.fullName === repository.fullName && jiraChoice(current.task.record.authority, current.task.record.id, String(saved.place), entry) === text))) throw new ApiError(409, "JIRA_SELECTION_UNVERIFIED", "Choose an exact current repository option.")
              const hydrated = await parseJira({ data: { userAccountId: invocation.principal, agentAccountId: current.task.record.agentAccountId,
                invocationType: "ISSUE_ASSIGNMENT", issue: { id: current.task.record.issueId, fields: { key: current.task.record.issueKey } } }, text: "", messageId: String(message.messageId),
                invocation, task: current.task.record, call: read })
              if (current.task.record.code !== "repository" && (text.startsWith("vej1:") || isRepositoryName(text))) throw new ApiError(409, "JIRA_SELECTION_UNVERIFIED", "Send your own coding task.")
              const parsed: ParsedTrigger = { ...hydrated.parsed, trigger: { ...hydrated.parsed.trigger, kind: "followup", task: current.task.record.code === "repository" ? original.ok ? original.value.task : "" : text,
                ...(repository ? { repository: { id: Number(repository.id), fullName: String(repository.fullName) } } : {}) } }
              await intake(parsed)
            })
          }
          return json(response, 200, { jsonrpc: "2.0", id, result: { task: current.wire } })
        }
      }
      const contextId = typeof message.contextId === "string" ? message.contextId : randomUUID()
      const issue = jiraObject(data?.issue)
      const issueKey = jiraObject(issue.fields).key
      const unsupported = !!data && !JIRA_INVOCATIONS.includes(data.invocationType as typeof JIRA_INVOCATIONS[number]) || !data && !/^link\s+\S+$/i.test(text)
      const record: JiraTaskRecord = { id: randomUUID(), contextId, messageId: String(message.messageId), inputHash: fingerprint(message), installation: installation(invocation),
        forgeInstallationId: invocation.installationId, userId: invocation.principal, authority: install ? installationAuthority(install) : "unconnected", createdAt: ctx().now,
        ...(linked ? { account: linked.record.account } : {}), state: unsupported ? "REJECTED" : !install || !linked ? "AUTH_REQUIRED" : "SUBMITTED",
        ...(unsupported ? { code: "unsupported" as const } : !install ? { code: "connect" as const } : !linked ? { code: "link" as const } : {}),
        ...(typeof issue.id === "string" && /^[1-9][0-9]{0,19}$/.test(issue.id) && isIssueKey(issueKey) ? { issueId: issue.id, issueKey,
          ...(data ? { agentAccountId: String(data.agentAccountId) } : {}) } : {}) }
      signal.throwIfAborted()
      const written = await writeJiraTask(ctx(), record, { installationRaw: install?.raw, contextExpected: previous?.record.id, linkRaw: linked?.raw })
      signal.throwIfAborted()
      if (written === "duplicate") {
        const existing = await getValue(ctx().store, everywhereKeys.jiraMessage(record.installation, record.userId, record.messageId))
        const task = existing && await owned(invocation, existing)
        if (task && constantTimeEqual(task.record.inputHash, fingerprint(message, task.record.inputHash.split(":")[0])))
          return json(response, 200, { jsonrpc: "2.0", id, result: { task: (await resolve(task)).wire } })
      }
      if (written !== "written") return rpcError(response, id, -32602, "TASK_ADMISSION_CHANGED", "The task could not be admitted. Try again.")
      if (!install && !unsupported) {
        const read = call(invocation, request)
        await jiraRequester(read, invocation.principal)
        const userToken = request.headers["x-forge-oauth-user"] as string
        const code = await issueConnectCode(ctx(), { cloudId: invocation.cloudId, accountId: invocation.principal, userToken, forgeInstallationId: invocation.installationId }, deps.fetcher)
        return json(response, 200, { jsonrpc: "2.0", id, result: { task: jiraTask(ctx(), record, undefined, { state: "AUTH_REQUIRED",
          text: code.ok ? `A Jira admin connects this site at https://vectordev.ai/everywhere using code ${code.code}. This code expires in ten minutes.` : "A Jira admin must connect this site at https://vectordev.ai/everywhere." }) } })
      }
      if (install && !unsupported && !data && /^link\s+\S+$/i.test(text)) {
        const task = await readJiraTask(ctx().store, record.id)
        if (!task) throw new JiraFailure()
        const linked = await link(request, invocation, task, text)
        signal.throwIfAborted()
        return json(response, 200, { jsonrpc: "2.0", id, result: { task: jiraTask(ctx(), linked.record) } })
      }
      if (install && linked && data && !unsupported) nativeWork(record, async () => {
        const hydrated = await parseJira({ data, text, messageId: record.messageId, invocation, task: record, call: call(invocation, request) })
        if (hydrated.needsOrigin) {
          await native.persist({ ...view(record), reply: hydrated.parsed.reply }, (current) => ({ ...current, state: "INPUT_REQUIRED", code: "origin" }), { draft: { kind: "origin", parsed: hydrated.parsed } })
          return
        }
        await intake(hydrated.parsed)
      })
      return json(response, 200, { jsonrpc: "2.0", id, result: { task: jiraTask(ctx(), record) } })
    } catch (error) {
      if (signal.aborted || response.writableEnded) return
      return json(response, error instanceof ApiError ? error.statusCode : 400, { error: { code: error instanceof ApiError ? error.code : "JIRA_REQUEST_INVALID" } })
    }
  }
  const uninstall = async (request: ApiRequest, response: ApiResponse) => {
    try {
      requireMethod(request, "POST")
      if (!platformOn(deps.config(), "jira")) return json(response, 404, { error: { code: "EVERYWHERE_OFF" } })
      const raw = await readRawBody(request, 16_384)
      const authorization = request.headers.authorization
      if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) throw new JiraFailure()
      const invocation = await verify(authorization.slice(7))
      if (invocation.moduleKey !== "vector-uninstall") throw new JiraFailure()
      const body = jiraObject(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)))
      if (jiraObject(body.context).cloudId !== invocation.cloudId || jiraObject(body.context).moduleKey !== "vector-pre-uninstall") throw new JiraFailure()
      await consume(invocation)
      const record = await readInstallSnapshot(ctx().store, installation(invocation))
      if (!record || record.record.forgeInstallationId !== invocation.installationId) return json(response, 200, { erased: false })
      await eraseInstallation({ ...ctx(), jobs: jobEraser(ctx().store) }, installation(invocation), "uninstalled", { expected: record })
      return json(response, 200, { erased: true })
    } catch { return json(response, 401, { error: { code: "JIRA_INVOCATION_INVALID" } }) }
  }
  return { a2a: async (request: ApiRequest, response: ApiResponse) => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([a2a(request, response, controller.signal), new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          controller.abort()
          if (!response.writableEnded) json(response, 503, { error: { code: "JIRA_RESPONSE_DEADLINE" } })
          resolve()
        }, Math.min(50_000, Math.max(1, deps.requestTimeoutMs ?? 50_000)))
      })])
    } finally { if (timer) clearTimeout(timer) }
  }, uninstall }
}
