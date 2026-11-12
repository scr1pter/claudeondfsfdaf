import { afterAll, beforeAll, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { createGithubAdapter, createGithubHandoff, type GithubHandoffBinding, type GithubHandoffIdentity } from "../../../api/_lib/everywhere/github/adapter"
import type { GithubStatusPort } from "../../../api/_lib/everywhere/github/status"
import { TRANSITION_SCRIPT, claimJob, createJob, declineJob, finishGithubOffer, offerJob, openReply, readJob, reportJob, settleJob, type JobsContext } from "../../../api/_lib/everywhere/jobs"
import { everywhereKeys } from "../../../api/_lib/everywhere/keys"
import { RouteHarness } from "./lib/everywhere-account"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"
import { routerFixture } from "./lib/everywhere-router"

installFetchGuard()
const harness = new RouteHarness()
beforeAll(() => harness.start())
afterAll(() => harness.stop())

function fixture() {
  const f = routerFixture()
  const identity: GithubHandoffIdentity = { repositoryId: 101, repository: "acme/app", actorId: 42, runId: 1001, runAttempt: 1, eventName: "issue_comment" }
  const binding: GithubHandoffBinding = { account: f.account, githubId: 42, installationId: 77, laptopFirst: true, codiumMode: true,
    workflowVersion: "fixture-v1", repository: { id: 101, fullName: "acme/app", shared: false } }
  const token = randomBytes(32).toString("hex")
  const body = { kind: "issue", issue: 7, commentId: 99, thread: "acme/app#7", workflowVersion: "fixture-v1" }
  const deps = { config: () => ({ ...f.config, platforms: new Set(["github"] as const) }), context: f.context, ports: f.ports,
    now: () => f.fake.clock.now, sleep: f.routing.sleep, verify: async (provided: string) => provided === token ? identity : undefined,
    binding: async () => binding }
  const request = async () => {
    harness.mount({ "/handoff": createGithubHandoff(deps) })
    return harness.call("POST", "/handoff", { body, token })
  }
  return { ...f, identity, binding, token, body, deps, request }
}

async function started(f: ReturnType<typeof fixture>) {
  const created = await createJob(f.context(), { platform: "github", installation: "github:77", kind: "mention", sponsor: f.account,
    requester: { account: f.account, userId: "42" }, repository: f.binding.repository, shared: false, task: "", context: [],
    github: { kind: "issue", number: 7, commentId: 99, actorId: 42, event: "issue_comment" }, reply: { ref: "acme/app#7" } })
  if (!created.ok) throw new Error("Fixture job was not created")
  await offerJob(f.context(), created.job.jid)
  const claim = await claimJob(f.context(), { account: f.account, jid: created.job.jid, device: f.computer })
  if (!claim.ok) throw new Error("Fixture claim failed")
  return { jid: created.job.jid, lease: claim.job.lease.id, report: () => reportJob(f.context(), {
    account: f.account, device: f.computer, report: { jid: created.job.jid, lease: claim.job.lease.id, seq: 0, milestone: "started" },
  }) }
}

test("without real verifier and binding adapters the handoff is 501 before any store read", async () => {
  let reads = 0
  harness.mount({ "/unavailable": createGithubHandoff({ context: () => { reads++; throw new Error("Must not read") } }) })
  expect((await harness.call("POST", "/unavailable", { body: {} })).status).toBe(501)
  expect(reads).toBe(0)
})

test("non-binders, reruns, dispatch and schedule calls hand back without an offer", async () => {
  for (const patch of [{ actorId: 43 }, { runAttempt: 2 }, { eventName: "workflow_dispatch" }, { eventName: "schedule" }]) {
    const f = fixture()
    Object.assign(f.identity, patch)
    const response = await f.request()
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ handled: false })
    expect(f.calls.some((call) => call.kind === "offer")).toBe(false)
    expect(f.fake.sorted(everywhereKeys.jobs(f.account))).toHaveLength(0)
  }
})

test("only an accepted started report handles the binder's handoff, and a repeated run makes no second offer", async () => {
  const f = fixture()
  let offers = 0
  f.ports.offer = async () => {
    offers++
    const jid = f.fake.sorted(everywhereKeys.jobs(f.account))[0]!
    const claim = await claimJob(f.context(), { account: f.account, jid, device: f.computer })
    if (!claim.ok) throw new Error("Fixture claim failed")
    await reportJob(f.context(), { account: f.account, device: f.computer, report: { jid, lease: claim.job.lease.id, seq: 0, milestone: "started" } })
    return "sent"
  }
  const before = f.fake.clock.now
  const response = await f.request()
  expect(response.body).toMatchObject({ handled: true })
  expect((await readJob(f.store, response.body.jid))?.github).toMatchObject({ actorId: 42, event: "issue_comment", commentId: 99 })
  expect(f.fake.clock.now - before).toBeLessThanOrEqual(20_000)
  expect((await f.request()).body).toEqual({ handled: false })
  expect(offers).toBe(1)
})

test("an unverified claim or changed-trigger decline hands back and fences later started reports", async () => {
  for (const changed of [false, true]) {
    const f = fixture()
    let jid = ""
    let lease = ""
    f.ports.offer = async () => {
      jid = f.fake.sorted(everywhereKeys.jobs(f.account))[0]!
      const claim = await claimJob(f.context(), { account: f.account, jid, device: f.computer })
      if (!claim.ok) throw new Error("Fixture claim failed")
      lease = claim.job.lease.id
      if (changed) await declineJob(f.context(), { account: f.account, device: f.computer, jid, lease, reason: "trigger-changed" })
      return "sent"
    }
    expect((await f.request()).body).toEqual({ handled: false })
    expect((await readJob(f.store, jid))?.state).toBe("refused")
    expect(await reportJob(f.context(), { account: f.account, device: f.computer, report: { jid, lease, seq: 1, milestone: "started" } })).toMatchObject({ ok: false, status: 409 })
  }
})

test("a timeout racing started has one authoritative outcome", async () => {
  for (let round = 0; round < 6; round++) {
    const f = fixture()
    const job = await started(f)
    const [handled, report] = await Promise.all([finishGithubOffer(f.context(), job.jid), job.report()])
    expect(handled).toBe(report.ok && report.action === "continue")
    expect((await readJob(f.store, job.jid))?.state).toBe(handled ? "running" : "refused")
    expect(await finishGithubOffer(f.context(), job.jid)).toBe(handled)
  }
})

test("handoff refuses GitHub text and incorrect thread references before persisting anything", async () => {
  const f = fixture()
  harness.mount({ "/handoff": createGithubHandoff(f.deps) })
  for (const body of [{ ...f.body, task: "Private GitHub text" }, { ...f.body, thread: "Private GitHub text" }, { ...f.body, workflowVersion: "wrong" }]) {
    expect((await harness.call("POST", "/handoff", { token: f.token, body })).status).toBe(400)
  }
  expect(f.fake.sorted(everywhereKeys.jobs(f.account))).toHaveLength(0)
  expect(JSON.stringify(f.fake.commands)).not.toContain("Private GitHub text")
})

function statusPort() {
  const comments = new Map<number, string>()
  let edits = 0
  const port: GithubStatusPort = {
    findOwnComment: async (_repository, _issue, marker) => [...comments].find(([, body]) => body.includes(marker)) ? { id: 700 } : undefined,
    comment: async (_repository, _issue, body) => { comments.set(700, body); return { id: 700 } },
    editComment: async (_repository, id, body) => { edits++; comments.set(id, body) },
  }
  return { port, comments, edits: () => edits }
}

test("status ids persist across adapter instances and updates are limited to every thirty seconds", async () => {
  const f = fixture()
  const job = await started(f)
  await job.report()
  const status = statusPort()
  const view = { jid: job.jid, platform: "github" as const, installation: "github:77", shared: false, reply: {} }
  const adapter = createGithubAdapter({ context: f.context, status: status.port })
  await adapter.progress(view, "laptop")
  await adapter.progress(view, "editing")
  expect(status.comments.size).toBe(1)
  expect(status.edits()).toBe(0)
  expect(status.comments.get(700)).toContain("Working on your computer")
  expect(status.comments.get(700)).toContain(`<!-- vector:job ${job.jid} -->`)
  expect(openReply(f.context(), (await readJob(f.store, job.jid))!)?.statusCommentId).toBe(700)
  f.fake.clock.advance(30_000)
  await createGithubAdapter({ context: f.context, status: status.port }).progress(view, "editing")
  expect(status.edits()).toBe(1)
  f.fake.clock.advance(30_000)
  await settleJob(f.context(), { account: f.account, device: f.computer, settle: { jid: job.jid, lease: job.lease, outcome: "no-changes", summary: "Done." } })
  await createGithubAdapter({ context: f.context, status: status.port }).finish(view, { text: "Done." })
  expect(status.comments.size).toBe(1)
  expect(status.comments.get(700)).toContain("Done.")
  f.fake.clock.advance(30_000)
  await createGithubAdapter({ context: f.context, status: status.port }).progress(view, "editing")
  expect(status.comments.get(700)).toContain("Done.")
})

test("a status post whose reference write failed is found by its own marker on retry", async () => {
  const f = fixture()
  const job = await started(f)
  await job.report()
  const status = statusPort()
  let fail = false
  const comment = status.port.comment
  status.port.comment = async (...args) => { const value = await comment(...args); fail = true; return value }
  const context = (): JobsContext => ({ ...f.context(), store: async (command) => {
    if (fail && command[0] === "EVAL" && typeof command[1] === "string" && command[1].endsWith(TRANSITION_SCRIPT)) { fail = false; throw new Error("Fixture lost reference write") }
    return f.store(command)
  } })
  const view = { jid: job.jid, platform: "github" as const, installation: "github:77", shared: false, reply: {} }
  await expect(createGithubAdapter({ context, status: status.port }).progress(view, "laptop")).rejects.toThrow("Fixture lost reference write")
  expect(status.comments.size).toBe(1)
  f.fake.clock.advance(30_000)
  await createGithubAdapter({ context, status: status.port }).progress(view, "editing")
  expect(status.comments.size).toBe(1)
  expect(status.edits()).toBe(1)
  expect(openReply(f.context(), (await readJob(f.store, job.jid))!)?.statusCommentId).toBe(700)
})
