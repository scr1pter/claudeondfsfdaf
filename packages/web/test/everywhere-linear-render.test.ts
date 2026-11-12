import { afterAll, beforeAll, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { seal } from "../../../api/_lib/everywhere/crypto"
import { createJobEvents } from "../../../api/_lib/everywhere/events"
import { installationAuthority, recordInstall, setMapping } from "../../../api/_lib/everywhere/identity"
import { cancelJob, readJob, settleJob } from "../../../api/_lib/everywhere/jobs"
import { everywhereKeys } from "../../../api/_lib/everywhere/keys"
import type { JobView } from "../../../api/_lib/everywhere/platform"
import { configuredPlatforms } from "../../../api/_lib/everywhere/runtime"
import { setJson } from "../../../api/_lib/everywhere/store"
import { createLinearAdapter } from "../../../api/_lib/everywhere/linear/adapter"
import { parseLinear } from "../../../api/_lib/everywhere/linear/parse"
import { linearPlan } from "../../../api/_lib/everywhere/linear/render"
import { createJobId } from "../../../packages/schema/src/everywhere"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"
import { FakeLinear, linearFixture } from "./lib/everywhere-linear"

installFetchGuard()
const native = new FakeLinear()
beforeAll(() => native.start())
afterAll(() => native.stop())

test("native plans replace all entries with only the published content and status fields", () => {
  expect(linearPlan("reading")).toEqual([
    { content: "Read the workspace", status: "inProgress" }, { content: "Make the changes", status: "pending" }, { content: "Prepare the result", status: "pending" },
  ])
  expect(linearPlan("editing").map((step) => step.status)).toEqual(["completed", "inProgress", "pending"])
  expect(linearPlan("pushing", "canceled").every((step) => step.status === "canceled")).toBe(true)
})

test("actual start moves an unstarted issue to its lowest-position started status and replaces the plan", async () => {
  const f = await linearFixture(native)
  const active = await f.job()
  await f.adapter.progress(active.view, "started")
  expect(native.calls.find((call) => call.operation === "start")?.variables).toEqual({ id: native.issue, state: native.started })
  const plan = (native.calls.find((call) => call.operation === "session")?.variables.input as { plan: unknown[] }).plan
  expect(plan).toHaveLength(3)
  expect(plan.every((step) => Object.keys(step as object).sort().join(",") === "content,status")).toBe(true)
  const before = native.calls.length
  await f.adapter.progress(active.view, "heartbeat")
  expect(native.calls).toHaveLength(before)
  f.fake.clock.advance(20 * 60_000 + 1)
  await f.adapter.progress(active.view, "heartbeat")
  expect(native.calls.slice(before).map((call) => call.operation)).toEqual(["create"])
})

test("shared native results omit private summaries; missing private surface retains the outbox for a cold retry", async () => {
  const f = await linearFixture(native)
  const active = await f.job()
  expect((await settleJob(f.context(), { account: f.account, device: f.computer,
    settle: { jid: active.view.jid, lease: active.lease, outcome: "no-changes", summary: "Private implementation details" } })).ok).toBe(true)
  const job = await readJob(f.store, active.view.jid)
  if (!job) throw new Error("Fixture terminal job missing")
  const first = createJobEvents(f.context, { linear: f.adapter })
  await expect(first.settled?.(job)).rejects.toMatchObject({ code: "LINEAR_PRIVATE_DELIVERY_UNAVAILABLE" })
  expect(JSON.stringify(native.calls)).not.toContain("Private implementation details")
  expect((await readJob(f.store, job.jid))?.summaryEnc).toBeDefined()
  const links = (native.calls.find((call) => call.operation === "session")?.variables.input as { addedExternalUrls: { url: string }[] }).addedExternalUrls
  expect(links[0]?.url).toBe(`https://vectordev.ai/everywhere?job=${job.jid}`)
  f.fake.clock.advance(60_001)
  const privateResults = new Map<string, string>()
  const adapters = () => configuredPlatforms({ ...f.deps, privateResult: async (input) => { privateResults.set(`${input.account}:${input.jid}`, input.text) } })
  await createJobEvents(f.context, adapters).settled?.((await readJob(f.store, job.jid))!)
  expect(privateResults.get(`${f.account}:${job.jid}`)).toContain("Private implementation details")
  expect((await readJob(f.store, job.jid))?.summaryEnc).toBeUndefined()
  expect([...native.activities.values()].filter((item) => item.content.__typename === "AgentActivityResponseContent")).toHaveLength(1)
  expect(await f.store(["ZSCORE", everywhereKeys.jobsPosts(), job.jid])).toBeNull()
})

test("reconnect during progress holds later native effects and old result delivery", async () => {
  const f = await linearFixture(native)
  const active = await f.job()
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>((resolve) => { enter = resolve })
  const blocked = new Promise<void>((resolve) => { release = resolve })
  native.answer = async (operation) => { if (operation === "issue") { enter(); await blocked }; return undefined }
  const pending = f.adapter.progress(active.view, "started")
  await entered
  await recordInstall(f.context(), { account: f.account, event: "install", grant: { installation: f.installation, token: JSON.stringify(f.pair),
    scopes: f.snapshot.record.scopes, botUserId: native.bot, installer: { admin: true } } })
  release()
  await expect(pending).rejects.toMatchObject({ code: "LINEAR_AUTHORITY_CHANGED" })
  native.answer = undefined
  await expect(f.adapter.finish(active.view, { text: "Old outcome", privateText: "Old summary" })).rejects.toMatchObject({ code: "LINEAR_AUTHORITY_CHANGED" })
  expect(native.calls.map((call) => call.operation)).toEqual(["issue"])
})

test("same-authorization credential replacement is used by later native effects", async () => {
  const f = await linearFixture(native)
  const active = await f.job()
  await setJson(f.store, everywhereKeys.install(f.installation), { ...f.snapshot.record,
    tokenEnc: seal(f.context().keys, JSON.stringify({ ...f.pair, access: native.refreshed.access_token, refresh: native.refreshed.refresh_token }), everywhereKeys.install(f.installation)) })
  await f.adapter.progress(active.view, "editing")
  expect(native.calls.every((call) => call.authorization === `Bearer ${native.refreshed.access_token}`)).toBe(true)
})

test("a concurrent same-authorization token rotation cannot send an obsolete token or erase its replacement", async () => {
  for (const moment of ["before-call", "during-401"] as const) {
    const f = await linearFixture(native)
    const active = await f.job()
    const key = everywhereKeys.install(f.installation)
    const next = { ...f.snapshot.record, tokenEnc: seal(f.context().keys,
      JSON.stringify({ ...f.pair, access: native.refreshed.access_token, refresh: native.refreshed.refresh_token }), key) }
    let reads = 0
    const adapter = createLinearAdapter({ ...f.deps, context: () => ({ ...f.context(), store: async (command) => {
      const value = await f.store(command)
      if (moment === "before-call" && command[0] === "GET" && command[1] === key && ++reads === 2) await setJson(f.store, key, next)
      return value
    } }) })
    if (moment === "during-401") native.answer = async (operation) => {
      if (operation !== "create") return undefined
      await setJson(f.store, key, next)
      return new Response(null, { status: 401 })
    }
    await expect(adapter.progress(active.view, "editing")).rejects.toMatchObject({ code: moment === "before-call" ? "EVERYWHERE_AUTHORITY_CHANGED" : "LINEAR_UNAVAILABLE" })
    expect(native.calls).toHaveLength(moment === "before-call" ? 0 : 1)
    expect(await f.store(["GET", key])).toBe(JSON.stringify(next))
    native.answer = undefined
    await createLinearAdapter(f.deps).progress(active.view, "editing")
    expect(native.calls.at(-1)?.authorization).toBe(`Bearer ${native.refreshed.access_token}`)
    expect(await f.store(["GET", key])).toBe(JSON.stringify(next))
  }
})

test("a lost activity-create response reconciles its exact immutable id across cold instances", async () => {
  const f = await linearFixture(native)
  const active = await f.job()
  native.loseCreate = true
  await f.adapter.progress(active.view, "editing")
  await createLinearAdapter(f.deps).progress(active.view, "editing")
  expect(native.calls.filter((call) => call.operation === "activity")).toHaveLength(2)
  expect([...native.activities.values()].filter((item) => item.content.__typename === "AgentActivityThoughtContent")).toHaveLength(1)
})

async function choices() {
  const f = await linearFixture(native)
  expect((await f.link()).ok).toBe(true)
  const repositories = [{ id: 101, fullName: "acme/app" }, { id: 102, fullName: "acme/tools" }]
  expect((await setMapping(f.context(), { account: f.account, installation: f.installation, place: native.team, repositories, private: false })).ok).toBe(true)
  const original = f.envelope("Implement the creator's original request", { action: "prompted" })
  const parsed = parseLinear(original, `${native.organization}:prompted:${original.agentActivity!.id}`, f.snapshot.record)
  if ("ignore" in parsed) throw new Error(parsed.ignore)
  const view: JobView = { jid: createJobId(f.fake.clock.now), platform: "linear", installation: f.installation, shared: true,
    reply: { ...parsed.reply, installRevision: installationAuthority(f.snapshot) } }
  await f.adapter.repositoryPrompt(parsed.trigger, repositories, view)
  const question = native.history.find((item) => item.signal === "select")
  const options = (question?.signalMetadata as { options: { label: string; value: string }[] }).options
  return { ...f, options, question, repositories, original }
}

test("opaque native choices list only the mapped team and reconstruct the preceding immutable own prompt", async () => {
  const f = await choices()
  expect(f.options.map((option) => option.label)).toEqual(["acme/app", "acme/tools"])
  expect(f.options.every((option) => option.value.startsWith("ve1:") && !option.value.includes("acme"))).toBe(true)
  const selected = f.envelope(f.options[0]!.value, { action: "prompted" })
  const parsed = parseLinear(selected, `${native.organization}:prompted:${selected.agentActivity!.id}`, f.snapshot.record)
  if ("ignore" in parsed) throw new Error(parsed.ignore)
  const restored = await f.adapter.prepare!(parsed, f.snapshot.record)
  if ("ignore" in restored) throw new Error(restored.ignore)
  expect(restored.trigger.task).toBe("Implement the creator's original request")
  expect(restored.trigger.repository).toEqual({ id: 101, fullName: "acme/app" })
  expect(restored.trigger.context.some((item) => item.text.includes("Edited description"))).toBe(true)
})

test("changed mapping, another author's elicitation, alias text or exhausted history never choose a repository", async () => {
  for (const mode of ["mapping", "author", "alias", "exhausted"] as const) {
    const f = await choices()
    if (mode === "mapping") await setMapping(f.context(), { account: f.account, installation: f.installation, place: native.team,
      repositories: [{ id: 999, fullName: "acme/app" }], private: false })
    if (mode === "author" && f.question) f.question.user.id = randomUUID()
    if (mode === "exhausted") { native.history = native.history.filter((item) => item.id !== f.original.agentActivity!.id); native.hasMore = true }
    const selected = f.envelope(mode === "alias" ? "acme/app" : f.options[0]!.value, { action: "prompted" })
    const parsed = parseLinear(selected, `${native.organization}:prompted:${selected.agentActivity!.id}`, f.snapshot.record)
    if ("ignore" in parsed) throw new Error(parsed.ignore)
    await expect(f.adapter.prepare!(parsed, f.snapshot.record)).rejects.toMatchObject({ code: "LINEAR_SELECTION_UNVERIFIED" })
    expect(f.fake.sorted(everywhereKeys.jobs(f.account))).toEqual([])
  }
})

test("Retry-After persists across cold adapter instances and prevents native requests before its deadline", async () => {
  const f = await linearFixture(native)
  const body = f.envelope("Do the task", { action: "prompted" })
  const parsed = parseLinear(body, `${native.organization}:prompted:${body.agentActivity!.id}`, f.snapshot.record)
  if ("ignore" in parsed) throw new Error(parsed.ignore)
  native.answer = (operation) => operation === "user" ? new Response(null, { status: 429, headers: { "retry-after": "120" } }) : undefined
  await expect(f.adapter.prepare!(parsed, f.snapshot.record)).rejects.toMatchObject({ retryMs: 120_000 })
  native.answer = undefined
  await expect(createLinearAdapter(f.deps).prepare!(parsed, f.snapshot.record)).rejects.toMatchObject({ retryMs: 120_000 })
  expect(native.calls.filter((call) => call.operation === "user")).toHaveLength(1)
  f.fake.clock.advance(120_001)
  expect("ignore" in await createLinearAdapter(f.deps).prepare!(parsed, f.snapshot.record)).toBe(false)
})

test("a stop arriving during native reads permits only the final response afterward", async () => {
  const f = await linearFixture(native)
  const active = await f.job()
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>((resolve) => { enter = resolve })
  const blocked = new Promise<void>((resolve) => { release = resolve })
  native.answer = async (operation) => { if (operation === "issue") { enter(); await blocked }; return undefined }
  const pending = f.adapter.progress(active.view, "started")
  await entered
  expect((await cancelJob(f.context(), active.view.jid)).ok).toBe(true)
  release()
  await expect(pending).rejects.toMatchObject({ code: "LINEAR_STOPPED" })
  native.answer = undefined
  await f.adapter.finish(active.view, { text: "Cancelled" })
  expect(native.calls.map((call) => call.operation)).toEqual(["issue", "create"])
})
