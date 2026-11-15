import { afterAll, beforeAll, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { SWITCH_NAMES } from "../../../api/_lib/codium-switches"
import { ENV_NAMES, readConfig, type EverywhereConfig } from "../../../api/_lib/everywhere/config"
import { createJobEvents, postPending } from "../../../api/_lib/everywhere/events"
import { claimJob, encodeJobRecord, offerJob, readJob, refuseJob, sweepDue } from "../../../api/_lib/everywhere/jobs"
import { everywhereKeys } from "../../../api/_lib/everywhere/keys"
import { createSweep } from "../../../api/_lib/everywhere/sweep"
import { createJobId, TIMING } from "../../../packages/schema/src/everywhere"
import { everywhereEnv, RouteHarness, secret } from "./lib/everywhere-account"
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

test("a full page of newer or unavailable-platform records cannot starve a deliverable reply", async () => {
  for (const unreadable of [true, false]) {
    const f = routerFixture()
    const job = await f.create()
    const ended = await refuseJob(f.context(), job.jid, "not-mapped")
    if (!ended.ok) throw new Error("Fixture must end")
    const blocked: string[] = []
    for (let index = 0; index < 200; index++) {
      const jid = createJobId(f.fake.clock.now + index + 1)
      blocked.push(jid)
      await f.store(["SET", everywhereKeys.job(jid), unreadable ? '{"version":999,"state":"future"}' : encodeJobRecord({
        ...ended.job, jid, platform: "linear", installation: `linear:${randomUUID()}`, issue: { key: "ENG-123" },
      })])
      await f.store(["ZADD", everywhereKeys.jobsPosts(), f.fake.clock.now - 1, jid])
    }
    expect(await postPending(f.context, { slack: f.adapter })).toBe(0)
    expect(await f.store(["ZSCORE", everywhereKeys.jobsPosts(), blocked[0]!])).toBe(String(f.fake.clock.now + 60_000))
    expect(await f.store(["GET", everywhereKeys.job(blocked[0]!)])).not.toBeNull()
    expect(await postPending(f.context, { slack: f.adapter })).toBe(1)
    expect(f.calls.filter((call) => call.kind === "finish")).toHaveLength(1)
    expect(f.fake.sorted(everywhereKeys.jobsPosts())).toHaveLength(200)
  }
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

/** A sweep whose switch, store and platforms each record their use and then throw. */
function counting(f: ReturnType<typeof routerFixture>, config: () => EverywhereConfig, calls: string[]) {
  return createSweep({
    config,
    context: () => {
      calls.push("context")
      return {
        ...f.context(),
        store: async () => {
          calls.push("store")
          throw new Error("must not read the store")
        },
      }
    },
    platforms: () => {
      calls.push("platforms")
      throw new Error("must not build platforms")
    },
    stopped: async () => {
      calls.push("switch")
      throw new Error("must not read the switch")
    },
  })
}

test("while the feature is off the sweep answers enabled:false before any switch, store or platform call", async () => {
  const f = routerFixture()
  const job = await f.create()
  await offerJob(f.context(), job.jid)
  await claimJob(f.context(), { account: f.account, jid: job.jid, device: f.computer })
  f.fake.clock.advance(TIMING.leaseMs + 60_000)
  const before = await readJob(f.store, job.jid)
  const seen = f.fake.commands.length
  const cronSecret = secret()
  const off = [
    {},
    { [ENV_NAMES.enabled]: "true" },
    { ...everywhereEnv(), [ENV_NAMES.enabled]: "false" },
    { ...everywhereEnv(), [ENV_NAMES.dataKey]: "A".repeat(43) },
  ].map((env) => readConfig({ ...env, [ENV_NAMES.cronSecret]: cronSecret }))
  for (const config of off) {
    expect(config.enabled).toBe(false)
    const calls: string[] = []
    harness.mount({ "/sweep": counting(f, () => config, calls) })
    const answer = await harness.call("GET", "/sweep", { token: cronSecret })
    expect([answer.status, answer.body]).toEqual([200, { enabled: false }])
    expect(calls).toEqual([])
    // The real fake store and adapter, with the production switch reader (which reads off as `stop`).
    harness.mount({
      "/sweep": createSweep({ config: () => config, context: f.context, platforms: () => ({ slack: f.adapter }) }),
    })
    const real = await harness.call("GET", "/sweep", { token: cronSecret })
    expect([real.status, real.body]).toEqual([200, { enabled: false }])
  }
  expect(f.fake.commands.length).toBe(seen)
  expect(await readJob(f.store, job.jid)).toEqual(before)
  expect(f.calls.filter((call) => call.kind === "finish")).toHaveLength(0)
  // Every production default: no KV settings exist here, so any store construction or call would answer 503.
  harness.mount({ "/sweep": createSweep({ config: () => readConfig({ [ENV_NAMES.cronSecret]: cronSecret }) }) })
  const defaults = await harness.call("GET", "/sweep", { token: cronSecret })
  expect([defaults.status, defaults.body]).toEqual([200, { enabled: false }])
  // The record left behind ends, and its reply posts, at the next enabled sweep.
  harness.mount({
    "/sweep": createSweep({
      config: () => ({ ...f.config, cronSecret }),
      context: f.context,
      platforms: () => ({ slack: f.adapter }),
      stopped: async () => false,
    }),
  })
  const on = await harness.call("GET", "/sweep", { token: cronSecret })
  expect([on.status, on.body]).toEqual([200, { ended: 1, posted: 1 }])
  expect((await readJob(f.store, job.jid))?.state).toBe("lost")
  expect(JSON.stringify(f.calls)).toContain("stopped answering")
})

test("a wrong or missing bearer gets 401 before anything else, whether the feature is on or off", async () => {
  const f = routerFixture()
  const cronSecret = secret()
  const configs = [{ ...f.config, cronSecret }, readConfig({ [ENV_NAMES.cronSecret]: cronSecret })]
  expect(configs.map((config) => config.enabled)).toEqual([true, false])
  for (const config of configs) {
    const calls: string[] = []
    harness.mount({ "/sweep": counting(f, () => config, calls) })
    const wrong = [undefined, `Bearer ${secret()}`, cronSecret, `Basic ${cronSecret}`, `Bearer ${cronSecret}x`]
    for (const authorization of wrong) {
      const answer = await harness.call("GET", "/sweep", { headers: authorization ? { authorization } : {} })
      expect([answer.status, answer.body]).toEqual([401, { error: { code: "CRON_UNAUTHORIZED" } }])
    }
    const post = await harness.call("POST", "/sweep", { token: cronSecret })
    expect([post.status, post.body]).toEqual([405, { error: { code: "METHOD_NOT_ALLOWED" } }])
    expect(calls).toEqual([])
  }
  // Without CRON_SECRET nothing is accepted, so an unauthenticated caller never learns whether the feature is on.
  for (const config of [readConfig(everywhereEnv()), readConfig({})]) {
    expect(config.cronSecret).toBeUndefined()
    const calls: string[] = []
    harness.mount({ "/sweep": counting(f, () => config, calls) })
    for (const token of [cronSecret, "undefined"])
      expect((await harness.call("GET", "/sweep", { token })).status).toBe(401)
    expect(calls).toEqual([])
  }
})

test("with the feature on the sweep reads the switch once and stop ends live work before its timeout", async () => {
  for (const stop of [false, true]) {
    const f = routerFixture()
    const job = await f.create()
    await offerJob(f.context(), job.jid)
    await claimJob(f.context(), { account: f.account, jid: job.jid, device: f.computer })
    const cronSecret = secret()
    let reads = 0
    harness.mount({
      "/sweep": createSweep({
        config: () => ({ ...f.config, cronSecret }),
        context: f.context,
        platforms: () => ({ slack: f.adapter }),
        stopped: async () => {
          reads++
          return stop
        },
      }),
    })
    const answer = await harness.call("GET", "/sweep", { token: cronSecret })
    expect([answer.status, answer.body]).toEqual([200, stop ? { ended: 1, posted: 1 } : { ended: 0, posted: 0 }])
    expect(reads).toBe(1)
    expect((await readJob(f.store, job.jid))?.state).toBe(stop ? "cancelled" : "claimed")
    expect(f.calls.filter((call) => call.kind === "finish")).toHaveLength(stop ? 1 : 0)
  }
})

test("with the feature on the production switch reader reads `on` without any network call until R-C6", async () => {
  // Codium's SWITCH_NAMES has no `everywhere` until R-C6, so this read makes no I/O; EV-07 updates this case then.
  expect((SWITCH_NAMES as readonly string[]).includes("everywhere")).toBe(false)
  const f = routerFixture()
  const job = await f.create()
  await offerJob(f.context(), job.jid)
  await claimJob(f.context(), { account: f.account, jid: job.jid, device: f.computer })
  const cronSecret = secret()
  harness.mount({
    "/sweep": createSweep({
      config: () => ({ ...f.config, cronSecret }),
      context: f.context,
      platforms: () => ({ slack: f.adapter }),
    }),
  })
  const answer = await harness.call("GET", "/sweep", { token: cronSecret })
  expect([answer.status, answer.body]).toEqual([200, { ended: 0, posted: 0 }])
  expect((await readJob(f.store, job.jid))?.state).toBe("claimed")
})

test("vercel.json runs the sweep every minute, exactly once", async () => {
  const vercel = (await Bun.file(new URL("../../../vercel.json", import.meta.url)).json()) as {
    crons: { path: string; schedule: string }[]
  }
  const sweeps = vercel.crons.filter(
    (cron) => new URL(cron.path, "https://fixture.example.test").pathname === "/api/everywhere/sweep",
  )
  expect(sweeps).toEqual([{ path: "/api/everywhere/sweep", schedule: "* * * * *" }])
})
