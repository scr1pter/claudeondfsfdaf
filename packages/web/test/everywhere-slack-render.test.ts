import { afterAll, beforeAll, expect, test } from "bun:test"
import { createJobEvents } from "../../../api/_lib/everywhere/events"
import { seal } from "../../../api/_lib/everywhere/crypto"
import { readInstall, recordInstall } from "../../../api/_lib/everywhere/identity"
import { everywhereKeys } from "../../../api/_lib/everywhere/keys"
import { setJson } from "../../../api/_lib/everywhere/store"
import { cancelJob, createJob, openReply, readJob } from "../../../api/_lib/everywhere/jobs"
import { createSlackAdapter } from "../../../api/_lib/everywhere/slack/adapter"
import { slackPlan, slackResult } from "../../../api/_lib/everywhere/slack/render"
import type { JobView } from "../../../api/_lib/everywhere/platform"
import { configuredPlatforms } from "../../../api/_lib/everywhere/runtime"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"
import { FakeSlack, slackFixture } from "./lib/everywhere-slack"

installFetchGuard()
const native = new FakeSlack()
beforeAll(() => native.start())
afterAll(() => native.stop())

async function fixture() {
  native.calls = []
  native.answer = undefined
  const f = await slackFixture()
  const reply = { ...f.parsed.reply, user: f.trigger.actor.userId, installRevision: f.record.revision! }
  const created = await createJob(f.context(), { platform: "slack", installation: f.installation, kind: "mention", sponsor: f.account,
    requester: { userId: f.trigger.actor.userId, account: f.account }, repository: { id: 101, fullName: "acme/app", shared: false },
    shared: true, task: "Fix login <@UATTACK>", context: [], reply })
  if (!created.ok) throw new Error("Fixture job was not admitted")
  const deps = { config: () => f.config, context: f.context, ports: f.ports, fetcher: native.fetch }
  const adapter = createSlackAdapter(deps)
  const view: JobView = { jid: created.job.jid, platform: "slack", installation: f.installation, shared: true, reply, job: created.job }
  return { ...f, deps, adapter, view }
}

test("plan uses actual native task statuses; feedback is inside context_actions", () => {
  expect(slackPlan("reading").tasks.map((task) => task.status)).toEqual(["in_progress", "pending", "pending"])
  expect(slackPlan("editing").tasks.map((task) => task.status)).toEqual(["complete", "in_progress", "pending"])
  expect(slackPlan("pushing", true).tasks.every((task) => task.status === "complete")).toBe(true)
  expect(slackResult("Done")[1]).toMatchObject({ type: "context_actions", elements: [{ type: "feedback_buttons", action_id: "vector-result-feedback" }] })
})

test("shared summaries are requester-only; fresh instances edit sealed message ids without reposting", async () => {
  const f = await fixture()
  const result = { text: "Done on your computer.", privateText: "Private summary: internal fix details" }
  await f.adapter.finish(f.view, result)
  await createSlackAdapter(f.deps).finish(f.view, result)
  const posts = native.calls.filter((call) => call.method === "chat.postMessage")
  const privatePosts = native.calls.filter((call) => call.method === "chat.postEphemeral")
  expect(posts).toHaveLength(1)
  expect(privatePosts).toHaveLength(1)
  expect(JSON.stringify(posts)).not.toContain("internal fix details")
  expect(privatePosts[0]?.body).toMatchObject({ user: "U0ALICE01", channel: "C123", thread_ts: "1731335400.000100", unfurl_links: false, unfurl_media: false })
  expect(native.calls.filter((call) => call.method === "chat.update")).toHaveLength(1)
  const stored = await readJob(f.store, f.view.jid)
  expect(stored && openReply(f.context(), stored)).toMatchObject({ resultTs: expect.any(String), privateDone: true })
  expect(JSON.stringify(f.fake.commands)).not.toContain(f.token)
})

test("ambiguous first delivery is retained and never becomes a duplicate message after a cold start", async () => {
  const f = await fixture()
  native.answer = (method) => method === "chat.postMessage" ? new Response(null, { status: 503 }) : undefined
  await expect(f.adapter.finish(f.view, { text: "Done" })).rejects.toMatchObject({ uncertain: true })
  native.answer = undefined
  await expect(createSlackAdapter(f.deps).finish(f.view, { text: "Done" })).rejects.toMatchObject({ uncertain: true })
  expect(native.calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1)
  expect(openReply(f.context(), (await readJob(f.store, f.view.jid))!)).toMatchObject({ resultAttempt: true })
})

test("Retry-After survives cold starts and a definitive refusal permits one later retry", async () => {
  const f = await fixture()
  native.answer = (method) => method === "chat.postMessage" ? new Response(null, { status: 429, headers: { "retry-after": "120" } }) : undefined
  await expect(f.adapter.finish(f.view, { text: "Done" })).rejects.toMatchObject({ uncertain: false, retryMs: 120_000 })
  native.answer = undefined
  await expect(createSlackAdapter(f.deps).finish(f.view, { text: "Done" })).rejects.toMatchObject({ uncertain: false })
  expect(native.calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1)
  f.fake.clock.advance(120_001)
  await createSlackAdapter(f.deps).finish(f.view, { text: "Done" })
  expect(native.calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(2)
})

test("heartbeat refreshes native processing without new plan posts; late terminal heartbeat stays closed", async () => {
  const f = await fixture()
  const events = createJobEvents(f.context, { slack: f.adapter })
  await events.reported?.({ ...f.view.job!, milestone: "heartbeat" })
  expect(native.calls.filter((call) => call.method === "agents.sessions.setStatus")).toHaveLength(1)
  expect(native.calls.some((call) => call.method === "chat.postMessage")).toBe(false)
  // A report arriving with a stale terminal record cannot reopen the native session after erase/cancellation.
  await f.adapter.erase(f.installation)
  native.calls = []
  await events.reported?.({ ...f.view.job!, milestone: "heartbeat" })
  expect(native.calls).toHaveLength(0)
})

test("cold report factories share persisted plans without needing an events-route registration", async () => {
  const f = await fixture()
  expect(configuredPlatforms({ ...f.deps, config: () => ({ ...f.config, enabled: false }) })).toEqual({})
  const first = createJobEvents(f.context, () => configuredPlatforms(f.deps))
  await first.reported?.({ ...f.view.job!, milestone: "started" })
  const second = createJobEvents(f.context, () => configuredPlatforms(f.deps))
  await second.reported?.({ ...f.view.job!, milestone: "editing" })
  expect(native.calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1)
  expect(native.calls.filter((call) => call.method === "chat.update")).toHaveLength(1)
  expect(native.calls.find((call) => call.method === "agents.sessions.rename")?.body.title).toBe("Vector task")
  expect(JSON.stringify(native.calls.filter((call) => call.method === "agents.sessions.rename"))).not.toContain("acme/app")
})

test("a terminal reply retries behind in-flight processing and late reports cannot reopen a closed session", async () => {
  const f = await fixture()
  let release!: () => void
  let entered!: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { entered = resolve })
  native.answer = async (method, body) => {
    if (method === "agents.sessions.setStatus" && body.status === "processing") { entered(); await blocked }
    return undefined
  }
  const progress = f.adapter.progress(f.view, "reading")
  await started
  const cancelled = await cancelJob(f.context(), f.view.jid)
  expect(cancelled.ok).toBe(true)
  await expect(f.adapter.finish(f.view, { text: "Cancelled" })).rejects.toMatchObject({ uncertain: false })
  release()
  await progress
  expect(native.calls.some((call) => call.method === "chat.postMessage")).toBe(false)
  native.answer = undefined
  await createSlackAdapter(f.deps).finish(f.view, { text: "Cancelled" })
  await f.adapter.progress(f.view, "heartbeat")
  expect(native.calls.filter((call) => call.method === "agents.sessions.setStatus").map((call) => call.body.status)).toEqual(["processing", "closed"])
})

test("reconnect during delayed progress stops later effects, and terminal retries hold the old authorization", async () => {
  const f = await fixture()
  let release!: () => void
  let enter!: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve })
  const entered = new Promise<void>((resolve) => { enter = resolve })
  native.answer = async (method, body) => {
    if (method === "agents.sessions.setStatus" && body.status === "processing") { enter(); await blocked }
    return undefined
  }
  const progress = f.adapter.progress(f.view, "started")
  await entered
  await recordInstall(f.context(), { account: f.account, event: "install", grant: { installation: f.installation, token: f.token,
    botUserId: f.record.botUserId, scopes: f.record.scopes, installer: { admin: true, userId: f.trigger.actor.userId } } })
  release()
  await expect(progress).rejects.toMatchObject({ code: "SLACK_AUTHORITY_CHANGED" })
  const before = native.calls.length
  native.answer = undefined
  await expect(createSlackAdapter(f.deps).finish(f.view, { text: "Old result", privateText: "Old private summary" })).rejects.toMatchObject({ code: "SLACK_AUTHORITY_CHANGED" })
  expect(native.calls).toHaveLength(before)
  expect(native.calls.map((call) => call.method)).toEqual(["agents.sessions.setStatus"])
})

test("same-authorization credential refresh uses the new token for every later native effect", async () => {
  const f = await fixture()
  const refreshed = `${f.token}-refreshed`
  native.answer = async (method, body) => {
    if (method === "agents.sessions.setStatus" && body.status === "processing") {
      const record = await readInstall(f.store, f.installation)
      if (!record) throw new Error("Fixture installation disappeared")
      await setJson(f.store, everywhereKeys.install(f.installation), { ...record, tokenEnc: seal(f.context().keys, refreshed, everywhereKeys.install(f.installation)) })
    }
    return undefined
  }
  await f.adapter.progress(f.view, "started")
  native.answer = undefined
  await createSlackAdapter(f.deps).finish(f.view, { text: "Done", privateText: "Private summary" })
  expect(native.calls[0]?.authorization).toBe(`Bearer ${f.token}`)
  expect(native.calls.slice(1).every((call) => call.authorization === `Bearer ${refreshed}`)).toBe(true)
  expect(native.calls.some((call) => call.method === "chat.postEphemeral")).toBe(true)
})

test("legacy native jobs without a sealed authorization proof hold instead of posting with a new connection", async () => {
  const f = await fixture()
  const { installRevision: _proof, ...reply } = f.view.reply
  const legacy = { ...f.view, reply }
  await expect(f.adapter.progress(legacy, "reading")).rejects.toMatchObject({ code: "SLACK_AUTHORITY_CHANGED" })
  await expect(f.adapter.finish(legacy, { text: "Old result" })).rejects.toMatchObject({ code: "SLACK_AUTHORITY_CHANGED" })
  expect(native.calls).toHaveLength(0)
})
