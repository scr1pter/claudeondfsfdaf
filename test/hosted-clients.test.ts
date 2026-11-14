import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { Hosted } from "../packages/schema/src/hosted"
import {
  decodeDownload,
  decodeHostedStatus,
  decodeJob,
  decodeJobs,
  decodeSessionAnswer,
  decodeSessions,
  decodeViewer,
  handoffLine,
} from "../packages/app/src/features/cloud/hosted/hosted-model"
import { hostedRoute, viewerLinkAllowed, type HostedRequest } from "../packages/app/src/features/cloud/hosted/hosted-requests"
import { handleHostedHeartbeat, handleHostedSessionAction, handleHostedSessions, handleHostedStatus } from "../api/_lib/hosted-api"
import { HANDOFF_ALERT_GAP_MS, HANDOFF_ALERT_TITLE, handoffAlertHook } from "../api/_lib/hosted-handoff"
import { HOSTED_JOB_SCRIPTS, type JobOptions } from "../api/_lib/hosted-jobs"
import { handleHostedJobs } from "../api/_lib/hosted-jobs-api"
import { computerName } from "../api/_lib/hosted-provider"
import { registerHostedHeartbeatHook, swapHostedHeartbeatHookForTest } from "../api/_lib/hosted-sessions"
import { configuredPlanModels } from "../api/_lib/model-plan-config"
import { ledgerBackend, type LedgerBackend } from "./hosted-fixture"
import { ACCOUNT_ID, HOUR, daemonBeat, hostedSessionEnvironment, hostedWorld, invoke, type HostedWorld } from "./hosted-sessions-fixture"

// WP A56: the cloud computer's clients against the real routes. Every request the desktop and the phone may send
// (packages/app/src/features/cloud/hosted/hosted-requests.ts) is accepted by its route, and every answer is read by
// the screens' decoders (hosted-model.ts); a hand-over to the person shows on the session list and sends one
// title-only phone alert (P7). The store, the ledger, the provider and Stripe are fakes, as in A53's tests.

const root = path.join(import.meta.dir, "..")
let ledger: LedgerBackend
let restore = () => {}
const alerts: { account: string; title: string; tag?: string }[] = []

// This file does not import hosted-jobs-runtime.ts, which registers the same hook with the real push sender; another
// file in the same process may have, so its hook is set aside here and given back after this file.
const runtimeHandoff = swapHostedHeartbeatHookForTest("handoff", undefined)
registerHostedHeartbeatHook(
  "handoff",
  handoffAlertHook(async (account, alert) => {
    alerts.push({ account, ...alert })
  }),
)
afterAll(() => {
  swapHostedHeartbeatHookForTest("handoff", runtimeHandoff)
})

beforeAll(async () => {
  ledger = await ledgerBackend()
})
afterAll(async () => {
  await ledger.close()
})
beforeEach(async () => {
  restore = hostedSessionEnvironment()
  await ledger.reset()
  alerts.length = 0
})
afterEach(() => restore())

/** Sends one of the screens' requests to its route, as the desktop's main process or the phone would. */
async function send(w: HostedWorld, request: HostedRequest, authorization = w.desktopToken()) {
  const route = hostedRoute(request)
  if (!route) throw new Error(`the screens may not send ${JSON.stringify(request)}`)
  const id = route.path.match(/\/(hs_[a-z2-7]{26}|jb_[a-z2-7]{26})(?:\/|$)/)?.[1]
  const action = route.path.match(/\/sessions\/hs_[a-z2-7]{26}\/(stop|takeover|release|viewer|download)$/)?.[1]
  const input = {
    method: route.method,
    authorization,
    ...(route.body ? { body: route.body } : {}),
    ...(id ? { query: { id } } : {}),
  }
  if (action)
    return invoke(
      (req, res) => handleHostedSessionAction(req, res, action as "stop", w.options),
      input,
    )
  if (route.path === "/api/hosted/sessions") return invoke((req, res) => handleHostedSessions(req, res, w.options), input)
  if (route.path === "/api/hosted/status") return invoke((req, res) => handleHostedStatus(req, res, w.options), input)
  if (route.path === "/api/hosted/jobs") return invoke((req, res) => handleHostedJobs(req, res, jobOptions(w)), input)
  throw new Error(`no route in this test for ${route.path}`)
}

function beat(w: HostedWorld, id: string, body: Record<string, unknown>) {
  return invoke((req, res) => handleHostedHeartbeat(req, res, w.options), {
    method: "POST",
    authorization: w.provider.token(computerName(ACCOUNT_ID, 1))!,
    body: daemonBeat(id, body),
    query: { id },
  })
}

async function startOne(w: HostedWorld) {
  const answer = await send(w, { kind: "start", size: "standard", jobMinutes: 60, prompt: "Tidy the docs", title: "Docs" })
  expect([answer.status, answer.body?.error?.code]).toEqual([201, undefined])
  const session = decodeSessionAnswer(answer.body)
  expect(session).toBeDefined()
  return session!
}

function jobOptions(w: HostedWorld): JobOptions {
  return { ...w.options, catalog: { models: configuredPlanModels({ tiered: true }), qualify: () => true } }
}

/** Done by Morning's queue script, as A55's test runs it (TypeScript copy of ENQUEUE). */
function registerEnqueue(w: HostedWorld) {
  const { store, clock } = w.fakes
  store.scripts.set(HOSTED_JOB_SCRIPTS.ENQUEUE, ([counter, record, due, index], [cap, ttl, json, keep, id, at, created]) => {
    if (store.live(record!)) return -1
    const used = Number(store.get(counter!) ?? "0")
    if (used >= Number(cap)) return 0
    store.set(counter!, String(used + 1))
    if (!store.expires.has(counter!)) store.expires.set(counter!, clock.now + Number(ttl))
    store.set(record!, json!)
    store.expires.set(record!, clock.now + Number(keep))
    store.zset(due!).set(id!, Number(at))
    store.zset(index!).set(id!, Number(created))
    return used + 1
  })
}

describe("every request the screens send is accepted, and every answer is read", () => {
  test("start, status, sessions, watch, take over, control, give back, files and stop", async () => {
    const w = await hostedWorld(ledger)
    const session = await startOne(w)
    expect(session).toMatchObject({ state: "running", computer: 1, size: "standard", title: "Docs" })

    const status = decodeHostedStatus((await send(w, { kind: "status" })).body)
    expect(status).toMatchObject({ available: true, access: "start", plan: { computers: 1, sizes: ["standard"] } })
    expect(status?.sessions.map((item) => item.id)).toEqual([session.id])
    expect(decodeSessions((await send(w, { kind: "sessions" })).body).map((item) => item.id)).toEqual([session.id])

    const view = decodeViewer((await send(w, { kind: "viewer", id: session.id, mode: "view" })).body)
    expect(view?.mode).toBe("view")
    expect(viewerLinkAllowed(view?.url)).toBe(true)

    const taken = decodeSessionAnswer((await send(w, { kind: "takeover", id: session.id })).body)
    expect(taken?.state).toBe("takeover")
    expect(taken?.takeover).toBeDefined()
    expect(decodeViewer((await send(w, { kind: "viewer", id: session.id, mode: "control" })).body)?.mode).toBe("control")
    expect(decodeSessionAnswer((await send(w, { kind: "release", id: session.id })).body)?.state).toBe("running")

    const files = await send(w, { kind: "download", id: session.id })
    expect(files.status).toBe(202)
    expect(decodeDownload(files.body)).toEqual({ ready: false })

    const stopped = decodeSessionAnswer((await send(w, { kind: "stop", id: session.id })).body)
    expect(stopped?.state).toBe("ended")
    expect(decodeHostedStatus((await send(w, { kind: "status" })).body)?.sessions).toEqual([])
  })

  test("the phone's website session is accepted too", async () => {
    const w = await hostedWorld(ledger)
    const phone = w.sessionToken()
    expect(decodeHostedStatus((await send(w, { kind: "status" }, phone)).body)?.access).toBe("start")
  })

  test("Done by Morning: the queue request is taken, and the queue and its job are read", async () => {
    const w = await hostedWorld(ledger)
    registerEnqueue(w)
    const queued = await send(w, {
      kind: "queue",
      prompt: "Check the signup page",
      criteria: ["The page loads", "The form submits"],
      deliverBy: w.fakes.clock.now + 8 * HOUR,
      size: "standard",
      jobMinutes: 30,
      title: "Signup check",
    })
    expect([queued.status, queued.body?.error?.code]).toEqual([201, undefined])
    const job = decodeJob(queued.body.job)
    expect(job).toMatchObject({ state: "queued", criteria: ["The page loads", "The form submits"], jobMinutes: 30 })
    const list = decodeJobs((await send(w, { kind: "jobs" })).body)
    expect(list).toMatchObject({ queue: "open", plan: { perNight: 3, atOnce: 1, recurringPerDay: 5 } })
    expect(list?.jobs.map((item) => item.id)).toEqual([job!.id])
  })
})

describe("a hand-over to the person (WP A54 → A56)", () => {
  test("shows on the session list while the agent has control, and asks the person to take over", async () => {
    const w = await hostedWorld(ledger)
    const session = await startOne(w)
    await beat(w, session.id, { booted: true, handoff: "captcha" })
    const listed = decodeHostedStatus((await send(w, { kind: "status" })).body)!.sessions[0]!
    expect(listed.handoff).toEqual({ reason: "captcha", since: w.fakes.clock.now })
    expect(handoffLine(listed.handoff)).toContain("Take over")
    // Taking over answers it: the list no longer asks.
    await send(w, { kind: "takeover", id: session.id })
    expect(decodeSessions((await send(w, { kind: "sessions" })).body)[0]?.handoff).toBeUndefined()
    // A reason the daemon does not know never reaches the list.
    await send(w, { kind: "release", id: session.id })
    await beat(w, session.id, { handoff: "type the password hunter2" })
    expect(decodeSessions((await send(w, { kind: "sessions" })).body)[0]?.handoff).toBeUndefined()
  })

  test("sends one title-only phone alert per new hand-over, at most one per session in ten minutes, none during a take-over (P7)", async () => {
    const w = await hostedWorld(ledger)
    const session = await startOne(w)
    await beat(w, session.id, { booted: true })
    expect(alerts).toEqual([])
    await beat(w, session.id, { handoff: "credential" })
    expect(alerts).toEqual([{ account: ACCOUNT_ID, title: HANDOFF_ALERT_TITLE, tag: "computer" }])
    w.advance(30_000)
    await beat(w, session.id, { handoff: "credential" })
    expect(alerts).toHaveLength(1)
    // A hand-over that flaps (gone, back, another reason) within ten minutes alerts no more (P8 review).
    for (const handoff of [undefined, "credential", undefined, "payment_details"]) {
      w.advance(30_000)
      await beat(w, session.id, handoff ? { handoff } : {})
    }
    expect(alerts).toHaveLength(1)
    w.advance(HANDOFF_ALERT_GAP_MS)
    await beat(w, session.id, {})
    w.advance(30_000)
    await beat(w, session.id, { handoff: "payment_details" })
    expect(alerts).toHaveLength(2)
    await send(w, { kind: "takeover", id: session.id })
    w.advance(30_000)
    await beat(w, session.id, { handoff: "captcha" })
    expect(alerts).toHaveLength(2)
    // The alert names no page, field or reason: a title and the tag that opens the phone's computer page.
    expect(HANDOFF_ALERT_TITLE.length).toBeLessThanOrEqual(120)
    expect(HANDOFF_ALERT_TITLE).not.toMatch(/password|card|captcha|code|\$|GitHub|Actions/i)
  })

  test("the heartbeat's route registers the hook with the real push sender", () => {
    const runtime = readFileSync(path.join(root, "api/_lib/hosted-jobs-runtime.ts"), "utf8")
    expect(runtime).toContain('registerHostedHeartbeatHook("handoff", handoffAlertHook())')
    const route = readFileSync(path.join(root, "api/hosted/sessions/[id]/heartbeat.ts"), "utf8")
    expect(route).toContain("hosted-jobs-runtime")
    expect(Hosted.HANDOFFS).toEqual(["credential", "payment_details", "captcha", "other"])
  })
})

describe("the clients' boundaries", () => {
  test("the screens never import the API's hosted modules or the rates", () => {
    for (const file of [
      "packages/app/src/features/cloud/hosted/hosted-model.ts",
      "packages/app/src/features/cloud/hosted/hosted-requests.ts",
      "packages/app/src/features/cloud/hosted/hosted-composer.tsx",
      "packages/app/src/phone/routes/computer.tsx",
      "packages/desktop/src/main/hosted-client.ts",
      "packages/desktop/src/main/hosted-window.ts",
    ]) {
      const text = readFileSync(path.join(root, file), "utf8")
      expect({ file, imports: /from\s+["'][^"']*(?:hosted-rates|_lib\/)/.test(text) }).toEqual({ file, imports: false })
    }
  })

  test("the desktop's requests and live view window are Vector Local's cloud-computer source", () => {
    const sources = readFileSync(path.join(root, "packages/core/src/local-mode/sources.ts"), "utf8")
    const entry = sources.slice(sources.indexOf('id: "cloud-computer"'), sources.indexOf('id: "phone-alerts"'))
    expect(entry).toContain('local: "blocked"')
    expect(entry).toContain("packages/desktop/src/main/hosted-client.ts")
    expect(entry).toContain("packages/desktop/src/main/hosted-window.ts")
    expect(readFileSync(path.join(root, "packages/desktop/src/main/hosted-client.ts"), "utf8")).toContain(
      'Egress.fetch(\n      "cloud-computer"',
    )
  })
})
