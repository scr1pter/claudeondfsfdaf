import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { drainAfter } from "../../../api/_lib/everywhere/after"
import { eraseEverywhereAccount, eraseInstallation } from "../../../api/_lib/everywhere/erase"
import { findLink, installationAuthority, issueLinkCode, readInstallSnapshot, readLinkSnapshot, recordInstall, redeemConnectCode, setMapping } from "../../../api/_lib/everywhere/identity"
import { claimJob, createJob, queueJob, readJob, readJobBody, recordSeen } from "../../../api/_lib/everywhere/jobs"
import { everywhereKeys } from "../../../api/_lib/everywhere/keys"
import { readCounts } from "../../../api/_lib/everywhere/limits"
import { createJiraRoutes } from "../../../api/_lib/everywhere/jira/a2a"
import { JIRA_SCOPES } from "../../../api/_lib/everywhere/jira/client"
import { ERASE_JIRA_TASK_SCRIPT, eraseJiraTaskInstallation, readJiraDraft, readJiraTask, WRITE_JIRA_TASK_SCRIPT, writeJiraTask } from "../../../api/_lib/everywhere/jira/task-store"
import { everywhereStore, type Store } from "../../../api/_lib/everywhere/store"
import { RouteHarness } from "./lib/everywhere-account"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"
import { jiraFixture, NativeJira } from "./lib/everywhere-jira"
import { realRedis, useKv, type RealRedis } from "./lib/everywhere-store"

installFetchGuard()
const native = new NativeJira()
const harness = new RouteHarness()
let restore: () => void
beforeAll(async () => { restore = useKv(); await native.start(); await harness.start() })
afterAll(async () => { await drainAfter(); await harness.stop(); await native.stop(); restore() })

async function ready(options: { installed?: boolean; linked?: boolean; mapped?: boolean; multiple?: boolean } = {}) {
  const f = await jiraFixture(native, options)
  harness.mount({ "/a2a": f.routes.a2a, "/uninstall": f.routes.uninstall })
  if (options.installed !== false && options.mapped !== false) {
    expect((await setMapping(f.context(), { account: f.account, installation: f.installation, place: "PROJ",
      repositories: [{ id: 101, fullName: "acme/app" }, ...(options.multiple ? [{ id: 102, fullName: "acme/tools" }] : [])], private: false })).ok).toBe(true)
    await recordSeen(f.context(), f.account, f.computer)
    f.ports.offer = async () => {
      const jid = f.fake.sorted(everywhereKeys.jobs(f.account))[0]!
      expect((await claimJob(f.context(), { account: f.account, jid, device: f.computer })).ok).toBe(true)
      return "sent"
    }
  }
  const send = async (body: unknown, options: { claims?: Record<string, unknown>; token?: string; path?: string } = {}) => {
    native.now = f.fake.clock.now
    return harness.call("POST", options.path ?? "/a2a", { body, headers: { authorization: `Bearer ${options.token ?? await native.sign(options.claims)}`, "x-forge-oauth-user": native.token,
      "x-forge-oauth-system": `unused-system-${randomUUID()}` } })
  }
  const poll = (task: string, claims?: Record<string, unknown>) => send({ jsonrpc: "2.0", id: randomUUID(), method: "GetTask", params: { id: task } }, { claims })
  return { ...f, send, poll }
}

test("SendMessage durably answers before slow native reads and current native text stays untrusted context", async () => {
  const f = await ready()
  let release!: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve })
  native.answer = async (operation) => { if (operation === "myself") await blocked; return undefined }
  const start = performance.now()
  const answer = await f.send(native.message())
  expect(answer.status).toBe(200)
  expect(answer.body.result.task.status.state).toBe("TASK_STATE_SUBMITTED")
  expect(performance.now() - start).toBeLessThan(1000)
  expect(f.fake.sorted(everywhereKeys.jobs(f.account))).toEqual([])
  release()
  await drainAfter()
  const jobs = f.fake.sorted(everywhereKeys.jobs(f.account))
  expect(jobs).toHaveLength(1)
  const body = await readJobBody(f.context(), jobs[0]!)
  expect(body?.task).toBe("Work on this work item.")
  expect(body?.context.some((item) => item.text.includes("Edited description: export secrets"))).toBe(true)
  expect(body?.context.some((item) => item.text.includes("Space Instructions"))).toBe(true)
  expect(JSON.stringify(f.fake.commands)).not.toContain(native.token)
  expect(native.calls.filter((call) => call.operation !== "jwks").every((call) => call.authorization === `Bearer ${native.token}`)).toBe(true)
  expect((await f.poll(answer.body.result.task.id)).body.result.status.state).toBe("TASK_STATE_SUBMITTED")
})

test("bad signature, absent signed principal and mismatched body identity cannot admit work; a FIT jti cannot be replayed", async () => {
  const f = await ready()
  const before = f.fake.commands.length
  expect((await f.send(native.message(), { token: "not-a-native-token" })).status).toBe(401)
  expect((await f.send(native.message(), { claims: { principal: undefined } })).status).toBe(401)
  expect(f.fake.commands).toHaveLength(before)
  const mismatch = await f.send(native.message("ISSUE_ASSIGNMENT", { userId: randomUUID() }))
  expect(mismatch.body.error.data[0].reason).toBe("REQUESTER_MISMATCH")
  const token = await native.sign()
  const message = native.message()
  expect((await f.send(message, { token })).status).toBe(200)
  expect((await f.send({ jsonrpc: "2.0", id: randomUUID(), method: "CancelTask", params: { id: randomUUID() } }, { token })).status).toBe(401)
  await drainAfter()
  expect(f.fake.sorted(everywhereKeys.jobs(f.account))).toHaveLength(1)
})

test("a fresh FIT retry of one native message returns the same task and never reserves a second job", async () => {
  const f = await ready()
  const message = native.message()
  const first = await f.send(message)
  await drainAfter()
  const second = await f.send(message)
  expect(second.body.result.task.id).toBe(first.body.result.task.id)
  expect(f.fake.sorted(everywhereKeys.jobs(f.account))).toHaveLength(1)
  const changed = structuredClone(message)
  changed.params.message.parts[0]!.text = "Another body under the same native message id"
  const refused = await f.send(changed)
  expect(refused.body.error.data[0].reason).toBe("MESSAGE_CONFLICT")
  expect(f.fake.sorted(everywhereKeys.jobs(f.account))).toHaveLength(1)
})

test("concurrent copies of one native message recover the single atomic task admission", async () => {
  const f = await ready()
  const message = native.message()
  const answers = await Promise.all([f.send(message), f.send(message)])
  expect(answers.every((answer) => answer.status === 200 && answer.body.result?.task?.id)).toBe(true)
  expect(answers[0]!.body.result.task.id).toBe(answers[1]!.body.result.task.id)
  await drainAfter()
  expect(f.fake.sorted(everywhereKeys.jobs(f.account))).toHaveLength(1)
  expect(await f.store(["ZCARD", everywhereKeys.jiraTasks(f.installation)])).toBe(1)
  expect((await readCounts(f.store, { sponsor: f.account, installation: f.installation, userId: native.user }, f.fake.clock.now)).sponsorToday).toBe(1)
})

test("unsupported streaming and unavailable tasks use the native JSON-RPC errors", async () => {
  const f = await ready()
  for (const method of ["SendStreamingMessage", "SubscribeToTask", "UnknownMethod"]) {
    const answer = await f.send({ jsonrpc: "2.0", id: randomUUID(), method, params: {} })
    expect(answer.body.error.code).toBe(-32601)
  }
  expect((await f.poll(randomUUID())).body.error.code).toBe(-32001)
  expect(f.fake.sorted(everywhereKeys.jobs(f.account))).toEqual([])
})

test("AUTOMATION and initial coding chat are rejected without native context reads or quota charges", async () => {
  for (const chat of [false, true]) {
    const f = await ready()
    const answer = await f.send(native.message("AUTOMATION", { chat, text: "Do this paid work" }))
    expect(answer.body.result.task.status.state).toBe("TASK_STATE_REJECTED")
    await drainAfter()
    expect(native.calls.filter((call) => call.operation !== "jwks")).toHaveLength(0)
    expect(f.fake.sorted(everywhereKeys.jobs(f.account))).toEqual([])
    expect((await readCounts(f.store, { sponsor: f.account, installation: f.installation, userId: native.user }, f.fake.clock.now)).sponsorToday).toBe(0)
  }
})

test("native guest, application, inactive, missing membership and user-token identity mismatch all refuse before spend", async () => {
  for (const patch of [{ guest: true }, { accountType: "app" }, { active: false }, { guest: undefined }, { accountId: randomUUID() }]) {
    const f = await ready()
    native.person = { ...native.person, ...patch }
    const answer = await f.send(native.message())
    await drainAfter()
    expect((await f.poll(answer.body.result.task.id)).body.result.status.state).toBe("TASK_STATE_REJECTED")
    expect(f.fake.sorted(everywhereKeys.jobs(f.account))).toEqual([])
    expect((await readCounts(f.store, { sponsor: f.account, installation: f.installation, userId: native.user }, f.fake.clock.now)).sponsorToday).toBe(0)
  }
})

test("only an unedited native comment by the signed requester becomes task text; changed comments require their own new prompt", async () => {
  for (const edited of [false, true]) {
    const f = await ready()
    if (edited) native.comment.updated = "2026-11-11T12:01:00Z"
    const answer = await f.send(native.message("ISSUE_COMMENT_MENTION"))
    await drainAfter()
    if (!edited) {
      const jid = f.fake.sorted(everywhereKeys.jobs(f.account))[0]!
      expect((await readJobBody(f.context(), jid))?.task).toBe("Implement my original request")
      continue
    }
    const task = (await f.poll(answer.body.result.task.id)).body.result
    expect(task.status.state).toBe("TASK_STATE_INPUT_REQUIRED")
    expect(f.fake.sorted(everywhereKeys.jobs(f.account))).toEqual([])
    await f.send(native.message("", { chat: true, contextId: task.contextId, text: "Use these new words as my explicit task" }))
    await drainAfter()
    const jid = f.fake.sorted(everywhereKeys.jobs(f.account))[0]!
    expect((await readJobBody(f.context(), jid))?.task).toBe("Use these new words as my explicit task")
  }
})

test("an unconnected site gets a connect code only after the same signed user's native admin proof", async () => {
  for (const admin of [false, true]) {
    const f = await ready({ installed: false, mapped: false })
    native.admin = admin
    const answer = await f.send(native.message())
    const task = answer.body.result.task
    expect(task.status.state).toBe("TASK_STATE_AUTH_REQUIRED")
    expect(native.calls.map((call) => call.operation)).toEqual(["jwks", "myself", "permissions"])
    const code = /code ([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})/.exec(task.status.message.parts[0].text)?.[1]
    expect(!!code).toBe(admin)
    if (code) expect((await redeemConnectCode(f.context(), { account: f.account, code, cloudId: native.cloud })).ok).toBe(true)
    expect(JSON.stringify(f.fake.commands)).not.toContain(native.token)
    expect(f.fake.sorted(everywhereKeys.jobs(f.account))).toEqual([])
  }
})

test("Rovo link uses the signed native principal privately, persists its terminal response and creates no job", async () => {
  const f = await ready({ linked: false })
  const code = await issueLinkCode(f.context(), { account: f.account, platform: "jira", installation: f.installation })
  expect((await f.send(native.message("", { chat: true, text: `link ${code.code}` }), { claims: { principal: randomUUID() } })).status).toBe(403)
  const answer = await f.send(native.message("", { chat: true, text: `link ${code.code}` }))
  expect(answer.body.result.task.status.state).toBe("TASK_STATE_COMPLETED")
  expect(await findLink(f.store, f.installation, native.user)).toMatchObject({ account: f.account })
  expect((await f.poll(answer.body.result.task.id)).body.result.status.state).toBe("TASK_STATE_COMPLETED")
  expect(f.fake.sorted(everywhereKeys.jobs(f.account))).toEqual([])
})

test("CancelTask changes only the signed requester's native task and makes no later user or context API calls", async () => {
  const f = await ready()
  const active = await f.job()
  const request = { jsonrpc: "2.0", id: randomUUID(), method: "CancelTask", params: { id: active.record.id } }
  const other = await f.send(request, { claims: { principal: randomUUID() } })
  expect(other.body.error.code).toBe(-32002)
  expect((await readJob(f.store, active.view.jid))?.state).toBe("running")
  const answer = await f.send(request)
  expect(answer.body.result.status.state).toBe("TASK_STATE_CANCELED")
  expect((await readJob(f.store, active.view.jid))?.state).toBe("cancelled")
  expect(native.calls.filter((call) => call.operation !== "jwks")).toHaveLength(0)
  expect((await f.send(request)).body.error.code).toBe(-32002)
})

test("opaque repository input resumes the original own prompt and changed mappings, aliases and other principals cannot select", async () => {
  for (const mode of ["valid", "mapping", "alias", "other"] as const) {
    const f = await ready({ multiple: true })
    const answer = await f.send(native.message("ISSUE_COMMENT_MENTION"))
    await drainAfter()
    const task = (await f.poll(answer.body.result.task.id)).body.result
    expect(task.status.state).toBe("TASK_STATE_INPUT_REQUIRED")
    const choice = /vej1:[0-9a-f]{64}/.exec(task.status.message.parts[0].text)?.[0]
    expect(choice).toBeDefined()
    expect(await f.store(["GET", everywhereKeys.jiraTaskDraft(task.id)])).not.toContain("Implement my original request")
    if (mode === "mapping") await setMapping(f.context(), { account: f.account, installation: f.installation, place: "PROJ", repositories: [{ id: 999, fullName: "acme/app" }], private: false })
    await f.send(native.message("", { chat: true, contextId: task.contextId, text: mode === "alias" ? "acme/app" : choice! }), mode === "other" ? { claims: { principal: randomUUID() } } : {})
    await drainAfter()
    const jobs = f.fake.sorted(everywhereKeys.jobs(f.account))
    expect(jobs).toHaveLength(mode === "valid" ? 1 : 0)
    if (mode === "valid") expect((await readJobBody(f.context(), jobs[0]!))?.task).toBe("Implement my original request")
  }
})

test("one context has one active task; poll from a cold route works and unrelated identities cannot read it", async () => {
  const f = await ready()
  const answer = await f.send(native.message())
  await drainAfter()
  const task = answer.body.result.task
  const repeated = await f.send(native.message("", { chat: true, contextId: task.contextId, text: "A second paid task while working" }))
  expect(repeated.body.result.task.id).toBe(task.id)
  expect(f.fake.sorted(everywhereKeys.jobs(f.account))).toHaveLength(1)
  harness.mount({ "/a2a": createJiraRoutes(f.deps).a2a })
  expect((await f.poll(task.id)).body.result.id).toBe(task.id)
  expect((await f.poll(task.id, { principal: randomUUID() })).body.error.code).toBe(-32001)
})

test("a stalled store cannot exceed the native response budget or later schedule a paid job", async () => {
  const f = await ready()
  let release!: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve })
  harness.mount({ "/a2a": createJiraRoutes({ ...f.deps, requestTimeoutMs: 30, context: () => ({ ...f.context(), store: async (command) => { await blocked; return f.store(command) } }) }).a2a })
  const start = performance.now()
  const answer = await f.send(native.message())
  expect(answer.status).toBe(503)
  expect(answer.body.error.code).toBe("JIRA_RESPONSE_DEADLINE")
  expect(performance.now() - start).toBeLessThan(1000)
  release()
  await drainAfter()
  expect(f.fake.sorted(everywhereKeys.jobs(f.account))).toEqual([])
})

test("authenticated pre-uninstall erases indexed native prompts, account links and live bodies", async () => {
  const f = await ready()
  const active = await f.job()
  const snapshot = (await readInstallSnapshot(f.store, f.installation))!
  const linked = (await readLinkSnapshot(f.store, f.installation, native.user))!
  const task = (await readJiraTask(f.store, active.record.id))!
  expect(await writeJiraTask(f.context(), task.record, { expected: task, installationRaw: snapshot.raw, linkRaw: linked.raw, draft: { text: "Private native draft" } })).toBe("written")
  const token = await native.sign({ principal: undefined, app: { id: native.app, installationId: native.forgeInstallation, apiBaseUrl: `https://api.atlassian.com/ex/jira/${native.cloud}`, module: { key: "vector-uninstall" } } })
  const answer = await f.send({ context: { cloudId: native.cloud, moduleKey: "vector-pre-uninstall" } }, { path: "/uninstall", token })
  expect(answer.status).toBe(200)
  expect(answer.body.erased).toBe(true)
  expect(await readJiraTask(f.store, active.record.id)).toBeUndefined()
  expect(await f.store(["GET", everywhereKeys.jiraTaskDraft(active.record.id)])).toBeNull()
  expect(await f.store(["GET", everywhereKeys.jobBody(active.view.jid)])).toBeNull()
  expect(await findLink(f.store, f.installation, native.user)).toBeUndefined()
  expect(await f.store(["GET", everywhereKeys.install(f.installation)])).toBeNull()
})

test("the fifty-minute fallback distinguishes persisted running work from waiting before the lazy sweep ends either job", async () => {
  for (const running of [true, false]) {
    const f = await ready()
    const active = running ? await f.job() : undefined
    const record = active?.record ?? await f.task()
    const jid = active?.view.jid ?? (await (async () => {
      const created = await createJob(f.context(), { platform: "jira", installation: f.installation, kind: "assign", sponsor: f.account,
        requester: { account: f.account, userId: native.user }, repository: { id: 101, fullName: "acme/app", shared: false }, shared: true,
        task: "Work on this work item.", context: [], reply: { task: record.id, ref: record.contextId, user: native.user, installRevision: record.authority } })
      if (!created.ok) throw new Error("Fixture waiting admission failed")
      expect((await queueJob(f.context(), created.job.jid, f.fake.clock.now + 10 * 60_000)).ok).toBe(true)
      await f.store(["SET", everywhereKeys.nativeResource("jira", f.installation, record.contextId), created.job.jid, "PX", 7_500_000])
      return created.job.jid
    })())
    expect((await readJob(f.store, jid))?.state).toBe(running ? "running" : "waiting")
    f.fake.clock.advance(50 * 60_000)
    const task = (await f.poll(record.id)).body.result
    expect(task.status.state).toBe("TASK_STATE_COMPLETED")
    expect(task.status.message.parts[0].text).toBe(running ? "Still running on your computer; the draft pull request will appear on GitHub." : "Your computer did not pick this up in time; assign it again when it is on.")
    expect((await f.poll(record.id)).body.result.status.message.parts[0].text).toBe(task.status.message.parts[0].text)
  }
})

test("indexed cleanup accepts a future business state with the stable authority envelope and still erases native text", async () => {
  const f = await ready()
  const record = await f.task()
  const install = (await readInstallSnapshot(f.store, f.installation))!
  const link = (await readLinkSnapshot(f.store, f.installation, native.user))!
  expect(await writeJiraTask(f.context(), record, { expected: (await readJiraTask(f.store, record.id))!, installationRaw: install.raw, linkRaw: link.raw,
    draft: { task: "Future native draft" } })).toBe("written")
  const current = (await readJiraTask(f.store, record.id))!
  await f.store(["SET", everywhereKeys.jiraTask(record.id), JSON.stringify({ ...current.record, state: "FUTURE_STATE" }), "PX", 172_800_000])
  await expect(readJiraTask(f.store, record.id)).rejects.toMatchObject({ code: "PERSISTENT_STORE_UNAVAILABLE" })
  await eraseInstallation({ ...f.context(), jobs: { installation: async () => undefined, account: async () => undefined } }, f.installation, "uninstalled")
  expect(await f.store(["GET", everywhereKeys.jiraTask(record.id)])).toBeNull()
  expect(await f.store(["GET", everywhereKeys.jiraTaskDraft(record.id)])).toBeNull()
  expect(await findLink(f.store, f.installation, native.user)).toBeUndefined()
})

test("account erasure on someone else's still-connected site fences a stalled account draft writer", async () => {
  const f = await ready()
  const other = randomUUID()
  await recordInstall(f.context(), { account: other, event: "connect", grant: { installation: f.installation, scopes: JIRA_SCOPES,
    forgeInstallationId: native.forgeInstallation, installer: { admin: true, userId: native.user } } })
  const record = await f.task()
  const install = (await readInstallSnapshot(f.store, f.installation))!
  const linked = (await readLinkSnapshot(f.store, f.installation, native.user))!
  const next = { ...record, id: randomUUID(), contextId: randomUUID(), messageId: randomUUID() }
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>((resolve) => { enter = resolve })
  const blocked = new Promise<void>((resolve) => { release = resolve })
  const pending = writeJiraTask({ ...f.context(), store: async (command) => { if (command[0] === "EVAL" && command[1] === WRITE_JIRA_TASK_SCRIPT) { enter(); await blocked }; return f.store(command) } }, next,
    { installationRaw: install.raw, linkRaw: linked.raw, draft: { task: "Late account text" } })
  await entered
  await eraseEverywhereAccount(f.context(), f.account)
  release()
  expect(await pending).toBe("authority-changed")
  expect(await readJiraTask(f.store, record.id)).toBeUndefined()
  expect(await readJiraTask(f.store, next.id)).toBeUndefined()
  expect(await f.store(["GET", everywhereKeys.jiraTaskDraft(next.id)])).toBeNull()
  expect((await readInstallSnapshot(f.store, f.installation))?.record.connector).toBe(other)
})

async function draftFence(store: Store, mode: "erase" | "reconnect" | "unlink") {
  const f = await jiraFixture(native)
  const record = await f.task()
  const snapshot = (await readInstallSnapshot(f.store, f.installation))!
  const linked = (await readLinkSnapshot(f.store, f.installation, native.user))!
  await store(["SET", everywhereKeys.install(f.installation), snapshot.raw])
  await store(["SET", everywhereKeys.link(f.installation, native.user), linked.raw])
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>((resolve) => { enter = resolve })
  const blocked = new Promise<void>((resolve) => { release = resolve })
  const pending = writeJiraTask({ ...f.context(), store: async (command) => { if (command[0] === "EVAL" && command[1] === WRITE_JIRA_TASK_SCRIPT) { enter(); await blocked }; return store(command) } }, record,
    { installationRaw: snapshot.raw, linkRaw: linked.raw, draft: { task: "Private original request" } })
  await entered
  if (mode === "erase") await store(["DEL", everywhereKeys.install(f.installation)])
  if (mode === "unlink") await store(["DEL", everywhereKeys.link(f.installation, native.user)])
  if (mode === "reconnect") {
    await recordInstall(f.context(), { account: f.account, event: "connect", grant: { installation: f.installation, scopes: JIRA_SCOPES,
      forgeInstallationId: native.forgeInstallation, installer: { admin: true, userId: native.user } } })
    const next = (await readInstallSnapshot(f.store, f.installation))!
    expect(next.record.installedAt).toBe(snapshot.record.installedAt)
    expect(next.record.revision).not.toBe(snapshot.record.revision)
    await store(["SET", everywhereKeys.install(f.installation), next.raw])
  }
  release()
  expect(await pending).toBe("authority-changed")
  expect(await store(["GET", everywhereKeys.jiraTask(record.id)])).toBeNull()
  expect(await store(["GET", everywhereKeys.jiraTaskDraft(record.id)])).toBeNull()
  expect(await store(["ZCARD", everywhereKeys.jiraTasks(f.installation)])).toBe(0)
  expect(await store(["ZCARD", everywhereKeys.jiraAccountTasks(f.account)])).toBe(0)
  const current = (await readInstallSnapshot(f.store, f.installation))!
  await store(["SET", everywhereKeys.install(f.installation), current.raw])
  await store(["SET", everywhereKeys.link(f.installation, native.user), linked.raw])
  expect(await writeJiraTask({ ...f.context(), store }, { ...record, authority: installationAuthority(current) }, { installationRaw: current.raw, linkRaw: linked.raw, draft: { task: "Winning own request" } })).toBe("written")
  expect(Number(await store(["PTTL", everywhereKeys.jiraTaskDraft(record.id)]))).toBeGreaterThan(0)
  expect(Number(await store(["PTTL", everywhereKeys.jiraTaskDraft(record.id)]))).toBeLessThanOrEqual(50 * 60_000)
  expect((await readJiraTask(store, record.id))?.record.userId).toBe(native.user)
  if (mode === "reconnect") {
    await eraseJiraTaskInstallation(store, f.installation, installationAuthority(snapshot))
    expect(await readJiraTask(store, record.id)).toBeDefined()
    expect(await readJiraDraft({ ...f.context(), store }, { ...record, authority: installationAuthority(current) })).toEqual({ task: "Winning own request" })
  }
  let raced = false
  await eraseJiraTaskInstallation(async (command) => {
    if (!raced && command[0] === "EVAL" && command[1] === ERASE_JIRA_TASK_SCRIPT) {
      raced = true
      const before = (await readJiraTask(store, record.id))!
      expect(await writeJiraTask({ ...f.context(), store }, { ...before.record, state: "WORKING" }, { expected: before, installationRaw: current.raw, linkRaw: linked.raw })).toBe("written")
    }
    return store(command)
  }, f.installation, installationAuthority(current))
  expect(raced).toBe(true)
  expect((await readJiraTask(store, record.id))?.record.state).toBe("WORKING")
  expect(await store(["GET", everywhereKeys.jiraTaskDraft(record.id)])).not.toBeNull()
  await eraseJiraTaskInstallation(store, f.installation, installationAuthority(current))
  expect(await readJiraTask(store, record.id)).toBeUndefined()
  expect(await store(["GET", everywhereKeys.jiraTaskDraft(record.id)])).toBeNull()
  expect(await store(["ZCARD", everywhereKeys.jiraTasks(f.installation)])).toBe(0)
  expect(await store(["ZCARD", everywhereKeys.jiraAccountTasks(f.account)])).toBe(0)
  expect(await store(["GET", everywhereKeys.jiraContext(f.installation, native.user, record.contextId)])).toBeNull()
}

test("a slow draft cannot resurrect erased/reconnected/unlinked authority and a fresh admission remains possible", async () => {
  for (const mode of ["erase", "reconnect", "unlink"] as const) await draftFence((await jiraFixture(native)).store, mode)
})

describe.skipIf(!process.env.VECTOR_TEST_REDIS_URL)("actual Redis native Jira draft fences", () => {
  let redis: RealRedis
  beforeAll(async () => { redis = (await realRedis())! })
  afterAll(async () => { await redis?.close() })
  test("installation, revision and person-link changes refuse before atomic task, draft or index writes", async () => {
    for (const mode of ["erase", "reconnect", "unlink"] as const) await draftFence(everywhereStore(redis.fetch), mode)
  })
})
