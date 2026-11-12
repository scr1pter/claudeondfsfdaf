import { afterAll, beforeAll, expect, test } from "bun:test"
import { createJobEvents, postPending } from "../../../api/_lib/everywhere/events"
import { claimJob, offerJob, readJob, refuseJob, sweepDue } from "../../../api/_lib/everywhere/jobs"
import { everywhereKeys } from "../../../api/_lib/everywhere/keys"
import { createSweep } from "../../../api/_lib/everywhere/sweep"
import { TIMING } from "../../../packages/schema/src/everywhere"
import { RouteHarness, secret } from "./lib/everywhere-account"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"
import { routerFixture } from "./lib/everywhere-router"

installFetchGuard()
const harness = new RouteHarness()
beforeAll(() => harness.start())
afterAll(() => harness.stop())

test("a silent laptop is ended and its fixed result posts within the next sweep", async () => {
  const f = routerFixture()
  const job = await f.create()
  await offerJob(f.context(), job.jid)
  await claimJob(f.context(), { account: f.account, jid: job.jid, device: f.computer })
  f.fake.clock.advance(TIMING.leaseMs + 60_000)
  const cronSecret = secret()
  harness.mount({ "/sweep": createSweep({ config: () => ({ ...f.config, cronSecret }), context: f.context,
    platforms: () => ({ slack: f.adapter }), stopped: async () => false }) })
  expect((await harness.call("GET", "/sweep", { token: cronSecret })).status).toBe(200)
  expect((await readJob(f.store, job.jid))?.state).toBe("lost")
  expect(JSON.stringify(f.calls)).toContain("stopped answering")
  expect(f.fake.sorted(everywhereKeys.jobsPosts())).toHaveLength(0)
})

test("the terminal transition atomically queues a reply even if the HTTP event never ran", async () => {
  const f = routerFixture()
  const job = await f.create()
  await refuseJob(f.context(), job.jid, "not-mapped")
  expect(f.fake.sorted(everywhereKeys.jobsPosts())).toEqual([job.jid])
  expect(await postPending(f.context, { slack: f.adapter })).toBe(1)
  expect(f.calls.filter((call) => call.kind === "finish")).toHaveLength(1)
})

test("failed posting stays queued and retries once its bounded lock expires", async () => {
  const f = routerFixture()
  const job = await f.create()
  await refuseJob(f.context(), job.jid, "not-mapped")
  let attempts = 0
  f.adapter.finish = async () => { attempts++; if (attempts === 1) throw new Error("fake outage") }
  const events = createJobEvents(f.context, { slack: f.adapter })
  await expect(events.ended!({ job: (await readJob(f.store, job.jid))! })).rejects.toThrow("fake outage")
  expect(await postPending(f.context, { slack: f.adapter })).toBe(0)
  f.fake.clock.advance(60_000)
  expect(await postPending(f.context, { slack: f.adapter })).toBe(1)
  expect(attempts).toBe(2)
  expect(await postPending(f.context, { slack: f.adapter })).toBe(0)
})

test("the sweep requires its exact configured bearer before any store call", async () => {
  const f = routerFixture()
  let calls = 0
  harness.mount({ "/locked": createSweep({ config: () => ({ ...f.config, cronSecret: secret() }),
    context: () => { calls++; throw new Error("must not read") } }) })
  expect((await harness.call("GET", "/locked")).status).toBe(401)
  expect(calls).toBe(0)
})

test("job-body expiration is never turned into an offer", async () => {
  const f = routerFixture()
  const job = await f.create()
  f.fake.clock.advance(2 * 60 * 60_000 + 1)
  await sweepDue(f.context())
  expect((await readJob(f.store, job.jid))?.state).toBe("expired")
  expect(f.calls.some((call) => call.kind === "offer")).toBe(false)
})
