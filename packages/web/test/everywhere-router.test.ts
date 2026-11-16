import { describe, expect, test } from "bun:test"
import { claimJob, declineJob, readJob, recordSeen } from "../../../api/_lib/everywhere/jobs"
import { safePorts } from "../../../api/_lib/everywhere/ports"
import { routeJob } from "../../../api/_lib/everywhere/router"
import { TIMING } from "../../../packages/schema/src/everywhere"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"
import { routerFixture } from "./lib/everywhere-router"

installFetchGuard()

describe("Everywhere real routing transitions", () => {
  test("safe ports expose neither a laptop nor an Actions dispatch", async () => {
    const ports = safePorts()
    expect((await ports.presence("unknown")).online).toBe(false)
    expect(await ports.offer("unknown", "offer")).toBe("unavailable")
    expect(await ports.binding(1)).toBeUndefined()
    expect(ports.prepareCloud).toBeUndefined()
    expect(await ports.perk("unknown", "remote")).toBe(false)
  })

  test("no answer exhausts only the 20-second offer window then queues", async () => {
    const f = routerFixture()
    await recordSeen(f.context(), f.account, f.computer)
    const job = await f.create()
    const start = f.fake.clock.now
    expect((await routeJob(f.routing, job, await f.facts())).action).toBe("queue")
    expect(f.fake.clock.now - start).toBe(TIMING.offerWindowMs)
    expect((await readJob(f.store, job.jid))?.state).toBe("waiting")
    expect(f.calls.filter((call) => call.kind === "offer")).toHaveLength(1)
  })

  test("a claim wins and is never dispatched or queued", async () => {
    const f = routerFixture()
    const job = await f.create()
    f.ports.offer = async () => {
      expect((await claimJob(f.context(), { account: f.account, jid: job.jid, device: f.computer })).ok).toBe(true)
      return "sent"
    }
    expect((await routeJob(f.routing, job, await f.facts())).action).toBe("laptop")
    expect((await readJob(f.store, job.jid))?.state).toBe("claimed")
    expect(f.calls.some((call) => call.value === "waiting")).toBe(false)
  })

  test("a busy decline moves to the queue without sleeping", async () => {
    const f = routerFixture()
    await recordSeen(f.context(), f.account, f.computer)
    const job = await f.create()
    f.ports.offer = async () => {
      await declineJob(f.context(), { account: f.account, jid: job.jid, device: f.computer, reason: "busy" })
      return "sent"
    }
    const start = f.fake.clock.now
    expect((await routeJob(f.routing, job, await f.facts())).action).toBe("queue")
    expect(f.fake.clock.now).toBe(start)
  })

  test("all lasting declines refuse with the actual reason", async () => {
    const f = routerFixture()
    const job = await f.create()
    f.ports.offer = async () => {
      await declineJob(f.context(), { account: f.account, jid: job.jid, device: f.computer, reason: "not-mapped" })
      return "sent"
    }
    expect(await routeJob(f.routing, job, await f.facts())).toEqual({ action: "refuse", code: "not-mapped" })
    expect((await readJob(f.store, job.jid))?.code).toBe("not-mapped")
    expect(JSON.stringify(f.calls)).toContain("not an allowed project")
  })

  test("remote switch off makes online presence ineligible", async () => {
    const f = routerFixture()
    const job = await f.create()
    f.ports.switch = async (name) => name === "remote" ? "stop" : "on"
    expect((await routeJob(f.routing, job, await f.facts())).action).toBe("refuse")
    expect(f.calls.some((call) => call.kind === "offer")).toBe(false)
  })

  test("a failed visibility read cannot authorize Actions", async () => {
    const f = routerFixture()
    const job = await f.create()
    f.ports.presence = async () => ({ online: false, computers: 0 })
    f.ports.binding = async () => ({ account: f.account, appInstalled: true, codiumMode: true })
    f.ports.visibility = async () => { throw new Error("unreachable") }
    f.ports.prepareCloud = async () => { throw new Error("must not prepare") }
    expect((await routeJob(f.routing, job, await f.facts())).action).toBe("refuse")
    expect((await readJob(f.store, job.jid))?.state).toBe("refused")
  })

  test("the fenced dispatch is visible before its external commit", async () => {
    const f = routerFixture()
    const job = await f.create()
    f.ports.presence = async () => ({ online: false, computers: 0 })
    f.ports.binding = async () => ({ account: f.account, appInstalled: true, codiumMode: true })
    f.ports.visibility = async () => "private"
    let commits = 0
    f.ports.prepareCloud = async () => ({ ticketHash: "a".repeat(64), commit: async () => {
      commits++
      expect((await readJob(f.store, job.jid))?.state).toBe("dispatched")
      expect((await claimJob(f.context(), { account: f.account, jid: job.jid, device: f.computer })).ok).toBe(false)
    } })
    expect((await routeJob(f.routing, job, await f.facts())).action).toBe("actions")
    expect(commits).toBe(1)
  })

  test("an uncertain dispatch never returns to the laptop", async () => {
    const f = routerFixture()
    const job = await f.create()
    f.ports.presence = async () => ({ online: false, computers: 0 })
    f.ports.binding = async () => ({ account: f.account, appInstalled: true, codiumMode: true })
    f.ports.visibility = async () => "private"
    f.ports.prepareCloud = async () => ({ ticketHash: "b".repeat(64), commit: async () => { throw new Error("uncertain") } })
    expect((await routeJob(f.routing, job, await f.facts())).action).toBe("actions")
    expect((await readJob(f.store, job.jid))?.state).toBe("dispatched")
  })
})
