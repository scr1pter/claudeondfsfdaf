import { afterAll, beforeAll, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { createJobEvents } from "../../../api/_lib/everywhere/events"
import { installationAuthority, readInstallSnapshot, readLinkSnapshot, recordInstall, unlink } from "../../../api/_lib/everywhere/identity"
import { expectedBranch, readJob, settleJob } from "../../../api/_lib/everywhere/jobs"
import { everywhereKeys } from "../../../api/_lib/everywhere/keys"
import { configuredPlatforms } from "../../../api/_lib/everywhere/runtime"
import { createJiraAdapter } from "../../../api/_lib/everywhere/jira/adapter"
import { jiraClient, JIRA_SCOPES } from "../../../api/_lib/everywhere/jira/client"
import { jiraTask } from "../../../api/_lib/everywhere/jira/render"
import { eraseJiraTaskInstallation, readJiraDraft, readJiraTask, writeJiraTask } from "../../../api/_lib/everywhere/jira/task-store"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"
import { jiraFixture, NativeJira } from "./lib/everywhere-jira"

installFetchGuard()
const native = new NativeJira()
beforeAll(() => native.start())
afterAll(() => native.stop())

test("actual Jira claims keep their key in the branch and enforce the native run and total caps", async () => {
  const f = await jiraFixture(native)
  const active = await f.job()
  expect(expectedBranch(active.view.job)).toBe(`vector/ve-PROJ-123-${active.view.jid.slice(-8)}`)
  expect(active.view.job.limits?.minutes).toBeLessThanOrEqual(35)
  expect(active.view.job.limits?.deadline).toBeLessThanOrEqual(active.record.createdAt + 50 * 60_000)
  const task = (await readJiraTask(f.store, active.record.id))!
  expect(jiraTask(f.context(), task.record, active.view.job).status.state).toBe("TASK_STATE_WORKING")
})

test("native artifacts omit private summaries and an absent private surface retains encrypted outbox data", async () => {
  const f = await jiraFixture(native)
  const active = await f.job()
  expect((await settleJob(f.context(), { account: f.account, device: f.computer,
    settle: { jid: active.view.jid, lease: active.lease, outcome: "no-changes", summary: "Private implementation details" } })).ok).toBe(true)
  const job = (await readJob(f.store, active.view.jid))!
  await expect(createJobEvents(f.context, { jira: f.adapter.adapter }).settled!(job)).rejects.toMatchObject({ code: "JIRA_PRIVATE_DELIVERY_UNAVAILABLE" })
  const task = (await readJiraTask(f.store, active.record.id))!
  const wire = jiraTask(f.context(), task.record)
  expect(wire.status.state).toBe("TASK_STATE_COMPLETED")
  expect(wire.artifacts).toHaveLength(1)
  expect(JSON.stringify(wire)).not.toContain("Private implementation details")
  expect(JSON.stringify(wire)).not.toContain("acme/app")
  expect((await readJob(f.store, job.jid))?.summaryEnc).toBeDefined()
  f.fake.clock.advance(60_001)
  const deliveries = new Map<string, string>()
  await createJobEvents(f.context, () => configuredPlatforms({ ...f.deps, privateResult: async (input) => { deliveries.set(`${input.account}:${input.jid}`, input.text) } })).settled!((await readJob(f.store, job.jid))!)
  expect(deliveries.get(`${f.account}:${job.jid}`)).toContain("Private implementation details")
  expect((await readJob(f.store, job.jid))?.summaryEnc).toBeUndefined()
  expect((await readJiraTask(f.store, active.record.id))?.record.privateDelivered).toBe(true)
  expect(await f.store(["ZSCORE", everywhereKeys.jobsPosts(), job.jid])).toBeNull()
  expect(native.calls).toHaveLength(0)
})

test("same-clock reconnect and unlink hold old native progress and result writes", async () => {
  for (const mode of ["reconnect", "unlink"] as const) {
    const f = await jiraFixture(native)
    const active = await f.job()
    const previous = (await readJiraTask(f.store, active.record.id))!
    if (mode === "reconnect") await recordInstall(f.context(), { account: f.account, event: "connect", grant: { installation: f.installation,
      scopes: JIRA_SCOPES, forgeInstallationId: native.forgeInstallation, installer: { admin: true, userId: native.user } } })
    else await unlink(f.context(), { account: f.account, installation: f.installation, userId: native.user })
    await expect(f.adapter.adapter.progress(active.view, "editing")).rejects.toMatchObject({ code: mode === "reconnect" ? "JIRA_AUTHORITY_CHANGED" : "JIRA_LINK_CHANGED" })
    await expect(f.adapter.adapter.finish(active.view, { text: "Old outcome" })).rejects.toMatchObject({ code: mode === "reconnect" ? "JIRA_AUTHORITY_CHANGED" : "JIRA_LINK_CHANGED" })
    expect((await readJiraTask(f.store, active.record.id))?.raw).toBe(previous.raw)
  }
})

test("a draft has a hard short key expiry while bounded task metadata remains, and raw prompt text is never a metadata value", async () => {
  const f = await jiraFixture(native)
  const record = await f.task()
  const task = (await readJiraTask(f.store, record.id))!
  const snapshot = (await readInstallSnapshot(f.store, f.installation))!
  const linked = (await readLinkSnapshot(f.store, f.installation, native.user))!
  const text = "Original private request kept only in the short draft"
  expect(await writeJiraTask(f.context(), { ...record, state: "INPUT_REQUIRED" }, { expected: task, installationRaw: snapshot.raw, linkRaw: linked.raw, draft: { task: text } })).toBe("written")
  expect(await readJiraDraft(f.context(), record)).toEqual({ task: text })
  expect((await readJiraTask(f.store, record.id))?.raw).not.toContain(text)
  expect(await f.store(["PTTL", everywhereKeys.jiraTaskDraft(record.id)])).toBe(50 * 60_000)
  expect(Number(await f.store(["PTTL", everywhereKeys.jiraTask(record.id)]))).toBeGreaterThan(24 * 60 * 60_000)
  f.fake.clock.advance(50 * 60_000 + 1)
  expect(await f.store(["GET", everywhereKeys.jiraTaskDraft(record.id)])).toBeNull()
  expect(await readJiraDraft(f.context(), record)).toBeUndefined()
  expect(await readJiraTask(f.store, record.id)).toBeDefined()
})

test("old indexed native cleanup removes only its authority and preserves a newer task and advanced context", async () => {
  const f = await jiraFixture(native)
  const first = await f.task()
  const old = (await readJiraTask(f.store, first.id))!
  const oldInstall = (await readInstallSnapshot(f.store, f.installation))!
  const linked = (await readLinkSnapshot(f.store, f.installation, native.user))!
  expect(await writeJiraTask(f.context(), { ...first, state: "COMPLETED" }, { expected: old, installationRaw: oldInstall.raw, linkRaw: linked.raw, draft: { task: "Old draft" } })).toBe("written")
  await recordInstall(f.context(), { account: f.account, event: "connect", grant: { installation: f.installation, scopes: JIRA_SCOPES,
    forgeInstallationId: native.forgeInstallation, installer: { admin: true, userId: native.user } } })
  const current = (await readInstallSnapshot(f.store, f.installation))!
  const next = { ...first, id: randomUUID(), messageId: randomUUID(), authority: installationAuthority(current), state: "INPUT_REQUIRED" as const }
  expect(await writeJiraTask(f.context(), next, { installationRaw: current.raw, contextExpected: first.id, linkRaw: linked.raw, draft: { task: "New draft" } })).toBe("written")
  await eraseJiraTaskInstallation(f.store, f.installation, first.authority)
  expect(await readJiraTask(f.store, first.id)).toBeUndefined()
  expect(await f.store(["GET", everywhereKeys.jiraTaskDraft(first.id)])).toBeNull()
  expect(await readJiraTask(f.store, next.id)).toBeDefined()
  expect(await readJiraDraft(f.context(), next)).toEqual({ task: "New draft" })
  expect(await f.store(["GET", everywhereKeys.jiraContext(f.installation, native.user, first.contextId)])).toBe(next.id)
})

test("native read cooldown survives cold callers and never sends a system or an expired retry token", async () => {
  const f = await jiraFixture(native)
  native.answer = () => new Response(null, { status: 429, headers: { "retry-after": "120" } })
  const read = () => jiraClient({ cloudId: native.cloud, userToken: native.token, fetcher: native.fetch, store: f.store, now: () => f.fake.clock.now })
  await expect(read()("myself")).rejects.toMatchObject({ retryMs: 120_000 })
  native.answer = undefined
  await expect(read()("myself")).rejects.toMatchObject({ retryMs: 120_000 })
  expect(native.calls).toHaveLength(1)
  f.fake.clock.advance(120_001)
  expect((await read()("myself")).accountId).toBe(native.user)
  expect(native.calls.every((call) => call.authorization === `Bearer ${native.token}`)).toBe(true)
})
