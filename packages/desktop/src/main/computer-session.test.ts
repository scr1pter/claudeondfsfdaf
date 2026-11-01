import { afterEach, describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Computer } from "@vectordevai/schema/computer"
import { manualClock } from "../../test/computer/fake-helper"
import type { ComputerBridgeKey } from "./computer-bridge"
import { defaultPolicy } from "./computer-policy"
import { createComputerSession, type SessionBackend, type SessionScope } from "./computer-session"
import { defaultPrefs, resolve } from "./computer-settings"
import { createComputerKeepAwake, type KeepAwakeEvent } from "./keep-awake"

// Virtual helper, displays, event stream and power blocker only: these tests never touch the owner's OS.
const APP: Computer.MacIdentity = {
  platform: "macos",
  bundleId: "com.apple.Notes",
  apple: true,
  system: true,
  verified: true,
  name: "Notes",
  path: "/System/Applications/Notes.app",
  pid: 500,
}
const ROOT = { rootSessionID: "root-a", sessionID: "child-a", directory: "/work/project-a" }
const NEXT = { rootSessionID: "root-b", sessionID: "child-b", directory: "/work/project-b" }
const cleanups: (() => Promise<void>)[] = []

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function flush() {
  for (let index = 0; index < 30; index++) await Promise.resolve()
}

afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})

function status(sessionID: string, type: "busy" | "idle", directory = ROOT.directory): KeepAwakeEvent {
  return { directory, payload: { type: "session.status", properties: { sessionID, status: { type } } } }
}

function fixture(
  options: {
    prefs?: Partial<Computer.ComputerPrefs>
    policy?: Partial<Computer.ComputerPolicy>
    kind?: "local-macos" | "local-windows"
    permissions?: Computer.PermissionsStatus
  } = {},
) {
  const time = manualClock(1000)
  const prefs: Computer.ComputerPrefs = {
    ...defaultPrefs(options.kind === "local-windows" ? "win32" : "darwin"),
    enabled: true,
    consentedAt: 1,
    mode: "foreground",
    ...options.prefs,
  }
  const policy = { ...defaultPolicy(), ...options.policy }
  const log: { kind: string; at: number; value?: unknown }[] = []
  const record = (kind: string, value?: unknown) => {
    log.push({ kind, at: time.now(), value })
  }
  const state = {
    autoDetect: true,
    helperLatched: false,
    displays: [] as Promise<void>[],
    beginWait: undefined as Promise<void> | undefined,
    endWait: undefined as Promise<void> | undefined,
    abortWait: undefined as Promise<void> | undefined,
    approvedWait: undefined as Promise<void> | undefined,
    exclusionsWait: undefined as Promise<void> | undefined,
    approved: [APP] as Computer.AppIdentity[],
    begins: [] as Computer.SessionBegin[],
    native: undefined as Computer.SessionBegin | undefined,
    updates: [] as Partial<Computer.SessionBegin>[],
    views: [] as Computer.ComputerState[],
    published: [] as Computer.ComputerState[],
    aborts: [] as { scope: SessionScope; reason: "stopped" | "timeout" }[],
    activeGrants: new Set<string>(),
    visible: false,
    request: 0,
    blocker: 0,
    activeBlockers: new Set<number>(),
  }
  const lost = new Set<() => void>()
  let session!: ReturnType<typeof createComputerSession>
  const backend: SessionBackend = {
    kind: options.kind ?? "local-macos",
    async hello() {
      record("hello")
      if (state.helperLatched) throw new Error("The virtual helper requires explicit recovery.")
      return {
        protocol: { min: Computer.PROTOCOL, max: Computer.PROTOCOL },
        helper: {
          version: "test",
          platform: options.kind === "local-windows" ? "windows" : "macos",
          arch: "arm64",
          os: "virtual test OS",
        },
        features: Object.fromEntries(Computer.HelperFeature.literals.map((feature) => [feature, true])),
        permissions: options.permissions ?? { screen: "granted", accessibility: "granted" },
        limits: { maxFrameBytes: Computer.LIMITS.helperFrameBytes },
        responsible: true,
      }
    },
    async permissions() {
      return options.permissions ?? { screen: "granted", accessibility: "granted" }
    },
    async beginSession(value) {
      state.begins.push(structuredClone(value))
      state.native = structuredClone(value)
      record("begin")
      await state.beginWait
      if (state.autoDetect) session.helperEvent({ event: "input_detection", alive: true })
      record("begin-ack")
    },
    async updateSession(value) {
      state.updates.push(structuredClone(value))
      if (state.native) state.native = { ...state.native, ...structuredClone(value) }
      record("update", value)
    },
    async endSession() {
      record("end")
      await state.endWait
      state.native = undefined
      record("end-ack")
    },
    async cancel() {
      record("cancel")
    },
    async releaseAll() {
      record("release")
      return 0
    },
  }
  const keepAwake = createComputerKeepAwake({
    clock: time,
    blocker: {
      start() {
        const id = state.blocker++
        state.activeBlockers.add(id)
        record("blocker-start", id)
        return id
      },
      stop(id) {
        state.activeBlockers.delete(id)
        record("blocker-stop", id)
      },
    },
  })
  session = createComputerSession({
    backend,
    overlay: {
      async show(value) {
        state.visible = true
        state.views.push(structuredClone(value))
        record("show")
      },
      async update(value) {
        state.views.push(structuredClone(value))
        record("overlay-update")
      },
      async ready() {
        record("ready-wait")
        await Promise.all(state.displays)
        record("ready")
      },
      close() {
        state.visible = false
        record("overlay-close")
      },
      fade() {
        record("fade")
      },
      windowIds: () => ["glow-1", "glow-2", "banner-1"],
      onLost(callback) {
        lost.add(callback)
        return () => void lost.delete(callback)
      },
    },
    settings: { get: () => resolve(prefs, policy, []) },
    async approved() {
      const identities = [...state.approved]
      record("approved-read")
      await state.approvedWait
      return identities
    },
    grants: {
      beginTask(scope) {
        state.activeGrants.add(scope.rootSessionID)
        record("grant-begin", scope)
      },
      endTask(root) {
        state.activeGrants.delete(root)
        record("grant-end", root)
      },
      disconnect() {
        state.activeGrants.clear()
        record("grants-disconnect")
      },
    },
    helper: {
      setRunActive(active) {
        record("helper-active", active)
      },
      async resume() {
        record("helper-resume")
        state.helperLatched = false
      },
    },
    async exclusions() {
      record("exclusions-read")
      await state.exclusionsWait
      return { vectorPids: [700], vectorWindowIds: ["vector-1"] }
    },
    async abort(scope, reason) {
      state.aborts.push({ scope, reason })
      record("abort", scope.rootSessionID)
      await state.abortWait
    },
    clock: time,
    wallNow: () => 1_700_000_000_000 + time.now(),
    onState(value) {
      state.published.push(structuredClone(value))
    },
    keepAwake,
  })
  cleanups.push(async () => {
    await session.close()
    keepAwake.close()
  })
  function request(scope = ROOT, wait = false) {
    const body: Extract<Computer.BridgeRequest, { command: "acquire" }> = {
      v: 1,
      command: "acquire",
      ...scope,
      title: scope.rootSessionID,
      wait,
    }
    const key: ComputerBridgeKey = Object.freeze({ id: ++state.request, command: "acquire", ...scope })
    return { body, key }
  }
  async function acquire(scope = ROOT): Promise<SessionScope> {
    const call = request(scope)
    const result = await session.acquire(call.body, call.key)
    if (!("lease" in result)) throw new Error(`Fixture did not acquire: ${JSON.stringify(result)}`)
    return { ...scope, lease: result.lease }
  }
  async function advance(ms: number, scope?: SessionScope) {
    if (!scope) {
      time.advance(ms)
      await flush()
      return
    }
    for (let remaining = ms; remaining > 0; ) {
      const step = Math.min(5000, remaining)
      time.advance(step)
      await flush()
      await Promise.resolve()
        .then(() => session.heartbeat(scope))
        .catch(() => {})
      await flush()
      remaining -= step
    }
  }
  const kinds = () => log.map((entry) => entry.kind)
  return {
    session,
    state,
    time,
    prefs,
    policy,
    log,
    kinds,
    request,
    acquire,
    advance,
    lose: () => lost.forEach((callback) => callback()),
  }
}

describe("the visible helper-session barrier", () => {
  for (const permissions of [
    { screen: "n/a", accessibility: "granted" },
    { screen: "granted", accessibility: "n/a" },
    { screen: "unknown", accessibility: "granted" },
    { screen: "granted", accessibility: "unknown" },
    { screen: "granted", accessibility: "granted", postEvent: "n/a" },
    { screen: "granted", accessibility: "granted", postEvent: "unknown" },
    { screen: "granted", accessibility: "granted", postEvent: "denied" },
  ] satisfies Computer.PermissionsStatus[])
    test(`macOS rejects ambiguous permission evidence ${JSON.stringify(permissions)}`, async () => {
      const fake = fixture({ permissions })
      const call = fake.request()
      const result = await fake.session.acquire(call.body, call.key)
      expect(result).toMatchObject({ code: "permissions" })
      expect(fake.session.state().holder).toBeUndefined()
      expect(fake.state.begins).toEqual([])
      expect(fake.state.visible).toBe(false)
      expect(fake.state.activeGrants.size).toBe(0)
    })

  test("Windows accepts its explicit n/a permission status", async () => {
    const fake = fixture({ kind: "local-windows", permissions: { screen: "n/a", accessibility: "n/a" } })
    const scope = await fake.acquire()
    expect(scope.lease).toBeGreaterThan(0)
    expect(fake.session.state()).toMatchObject({ backend: "local-windows", holder: { sessionID: ROOT.rootSessionID } })
  })

  test("act and screenshot wait for all displays and the native session acknowledgement", async () => {
    const fake = fixture()
    const first = deferred()
    const second = deferred()
    const begin = deferred()
    fake.state.displays = [first.promise, second.promise]
    fake.state.beginWait = begin.promise
    const scope = await fake.acquire()
    const released: string[] = []
    const act = fake.session.beforeStep(scope, { action: "click" }).then(() => {
      released.push("act")
    })
    const screenshot = fake.session.beforeStep(scope, { action: "screenshot" }).then(() => {
      released.push("screenshot")
    })
    await flush()
    expect(released).toEqual([])
    expect(fake.state.begins).toHaveLength(0)
    first.resolve()
    await flush()
    expect(released).toEqual([])
    second.resolve()
    await flush()
    expect(fake.state.begins).toHaveLength(1)
    expect(released).toEqual([])
    begin.resolve()
    await Promise.all([act, screenshot])
    expect(released.sort()).toEqual(["act", "screenshot"])
    expect(fake.state.begins[0]).toMatchObject({
      approved: [APP],
      vectorPids: [700],
      vectorWindowIds: ["vector-1"],
      overlayWindowIds: ["glow-1", "glow-2", "banner-1"],
      mode: "foreground",
      escStops: true,
      stopChord: fake.prefs.stopChord,
      heartbeatMs: 2000,
      paused: true,
    })
    const enabled = fake.log.findIndex(
      (entry) => entry.kind === "update" && (entry.value as { paused?: boolean }).paused === false,
    )
    expect(enabled).toBeGreaterThan(fake.kinds().indexOf("begin-ack"))
    expect(fake.state.updates.every((value) => value.sessionId === fake.state.begins[0].sessionId)).toBe(true)
  })

  test("overlay loss cancels input and pauses subsequent work", async () => {
    const fake = fixture()
    const scope = await fake.acquire()
    await fake.session.beforeStep(scope)
    const revision = fake.state.native!.phaseRevision ?? 0
    fake.lose()
    await flush()
    expect(fake.session.state()).toMatchObject({ phase: "paused", pause: "overlay", escStops: false })
    expect(fake.kinds()).toContain("cancel")
    expect(fake.kinds()).toContain("release")
    expect(fake.state.native).toMatchObject({
      sessionId: fake.state.begins[0].sessionId,
      paused: true,
      escStops: false,
    })
    expect(fake.state.native!.phaseRevision!).toBeGreaterThan(revision)
    expect(await fake.session.beforeStep(scope).catch((error) => error)).toMatchObject({ code: "paused" })
  })

  test("advertised input detection does not substitute for a live confirmation", async () => {
    const fake = fixture()
    fake.state.autoDetect = false
    const scope = await fake.acquire()
    const result = await fake.session.beforeStep(scope).catch((error) => error)
    expect(result).toMatchObject({ code: "paused" })
    expect(fake.session.state()).toMatchObject({ phase: "paused", pause: "detection" })
  })

  test("grant, mode and phase changes refresh the helper's allowed apps and Esc rule", async () => {
    const fake = fixture()
    const scope = await fake.acquire()
    await fake.session.beforeStep(scope)
    const calculator: Computer.MacIdentity = { ...APP, bundleId: "com.apple.calculator", name: "Calculator", pid: 501 }
    fake.state.approved = [APP, calculator]
    await fake.session.updateGrants()
    expect(fake.state.native).toMatchObject({ approved: [APP, calculator], paused: false, escStops: true })
    await fake.session.setMode("background")
    expect(fake.state.native).toMatchObject({ mode: "background", paused: false, escStops: false })
    await fake.session.transition("asking", {
      requestID: "ask-1",
      directory: ROOT.directory,
      kind: "app",
      title: "Use Calculator?",
      canAlways: true,
      shownAt: 1_700_000_000_000 + fake.time.now(),
    })
    expect(fake.state.native).toMatchObject({ approved: [APP, calculator], paused: true, escStops: false })
    await fake.session.setMode("foreground")
    expect(fake.state.native).toMatchObject({ mode: "foreground", paused: true, escStops: false })
    await fake.session.transition("working")
    expect(fake.state.native).toMatchObject({
      mode: "foreground",
      approved: [APP, calculator],
      paused: false,
      escStops: true,
    })
  })

  for (const boundary of ["approvedWait", "exclusionsWait"] as const)
    test(`revoking grants inhibits native input before the delayed ${boundary} resolves`, async () => {
      const fake = fixture()
      const scope = await fake.acquire()
      await fake.session.beforeStep(scope)
      const gate = deferred()
      fake.state[boundary] = gate.promise
      const stale = fake.session.beforeStep(scope).catch((error) => error)
      await flush()
      const start = fake.log.length
      fake.state.approved = []
      const refreshed = fake.session.updateGrants()
      expect(fake.log.slice(start).map((entry) => entry.kind)).toContain("release")
      expect(fake.state.native).toMatchObject({ paused: true, escStops: false })
      gate.resolve()
      expect(await stale).toMatchObject({ code: "paused" })
      await refreshed
      expect(fake.state.native).toMatchObject({ approved: [], paused: false })
    })

  test("revoking company background access requires foreground detection before more input", async () => {
    const fake = fixture({ prefs: { mode: "background" } })
    fake.state.autoDetect = false
    const scope = await fake.acquire()
    await fake.session.beforeStep(scope)
    expect(fake.state.native).toMatchObject({ mode: "background", paused: false })
    const start = fake.state.updates.length
    fake.policy.background = false
    const result = await fake.session.beforeStep(scope).catch((error) => error)
    expect(["paused", "needs_foreground", "blocked"]).toContain(result?.code)
    expect(fake.state.native?.paused).toBe(true)
    expect(fake.state.updates.slice(start).some((value) => value.paused === false)).toBe(false)
  })
})

describe("lease lifetime and queue isolation", () => {
  test("an exact session reuses its lease while a sibling in the same root waits", async () => {
    const fake = fixture()
    const scope = await fake.acquire()
    expect((await fake.acquire()).lease).toBe(scope.lease)
    const sibling = { ...ROOT, sessionID: "child-a-2" }
    const call = fake.request(sibling, true)
    const waiting = fake.session.acquire(call.body, call.key).catch((error) => error)
    await flush()
    expect(fake.session.state().queue).toHaveLength(1)
    fake.session.cancelAcquire(call.key)
    expect(await waiting).toMatchObject({ code: "stopped" })
    expect(fake.session.state().holder?.sessionID).toBe(ROOT.rootSessionID)
    expect(fake.state.aborts).toEqual([])
  })

  test("cancelling an exact queued request never stops the active lease", async () => {
    const fake = fixture()
    const scope = await fake.acquire()
    await fake.session.beforeStep(scope)
    const call = fake.request(NEXT, true)
    const waiting = fake.session.acquire(call.body, call.key).catch((error) => error)
    await flush()
    fake.session.cancelAcquire({ ...call.key })
    expect(fake.session.state().queue).toHaveLength(1)
    fake.session.cancelAcquire(call.key)
    expect(await waiting).toMatchObject({ code: "stopped" })
    expect(fake.session.state().queue).toEqual([])
    expect(fake.session.state().phase).toBe("working")
    expect(fake.kinds()).not.toContain("cancel")
    expect(fake.kinds()).not.toContain("release")
    expect(fake.state.aborts).toEqual([])
  })

  test("a queued long poll answers busy at sixty seconds without disturbing the holder", async () => {
    const fake = fixture()
    const scope = await fake.acquire()
    const call = fake.request(NEXT, true)
    const waiting = fake.session.acquire(call.body, call.key)
    await fake.advance(60_000, scope)
    expect(await waiting).toMatchObject({ code: "busy", holder: { title: ROOT.rootSessionID } })
    expect(fake.session.state().holder?.sessionID).toBe(ROOT.rootSessionID)
    expect(fake.state.aborts).toEqual([])
  })

  test("a sixty-second poll gap preserves FIFO and never grants a lease to an absent waiter", async () => {
    const fake = fixture()
    const scope = await fake.acquire()
    const first = fake.request(NEXT, true)
    const firstPoll = fake.session.acquire(first.body, first.key)
    await fake.advance(5000, scope)
    const other = { rootSessionID: "root-c", sessionID: "child-c", directory: "/work/project-c" }
    const second = fake.request(other, true)
    const secondPoll = fake.session.acquire(second.body, second.key).catch((error) => error)
    await fake.advance(55_000, scope)
    expect(await firstPoll).toMatchObject({ code: "busy" })
    await fake.session.release(scope)
    await flush()
    expect(fake.session.state().holder).toBeUndefined()
    expect(fake.state.activeGrants.has(NEXT.rootSessionID)).toBe(false)
    expect(fake.session.state().queue.map((entry) => entry.sessionID)).toEqual([
      NEXT.rootSessionID,
      other.rootSessionID,
    ])
    const retry = fake.request(NEXT, true)
    const retryPoll = fake.session.acquire(retry.body, retry.key)
    fake.session.cancelAcquire(first.key)
    expect(await retryPoll).toHaveProperty("lease")
    expect(fake.session.state().holder?.sessionID).toBe(NEXT.rootSessionID)
    fake.session.cancelAcquire(second.key)
    expect(await secondPoll).toMatchObject({ code: "stopped" })
  })

  test("removing a parked FIFO head promptly admits the next live waiter", async () => {
    const fake = fixture()
    const scope = await fake.acquire()
    const first = fake.request(NEXT, true)
    const firstPoll = fake.session.acquire(first.body, first.key)
    await fake.advance(5000, scope)
    const other = { rootSessionID: "root-c", sessionID: "child-c", directory: "/work/project-c" }
    const second = fake.request(other, true)
    const secondPoll = fake.session.acquire(second.body, second.key).catch((error) => error)
    await fake.advance(55_000, scope)
    expect(await firstPoll).toMatchObject({ code: "busy" })
    await fake.session.release(scope)
    await flush()
    expect(fake.session.state().holder).toBeUndefined()
    await fake.session.stopSession(NEXT.rootSessionID)
    await flush()
    expect(await secondPoll).toHaveProperty("lease")
    expect(fake.session.state().holder?.sessionID).toBe(other.rootSessionID)
    expect(fake.state.aborts).toEqual([])
    // A stale queue-row action cannot stop a conversation after it became the active holder.
    await fake.session.stopSession(other.rootSessionID)
    expect(fake.session.state()).toMatchObject({ phase: "working", holder: { sessionID: other.rootSessionID } })
    expect(fake.state.activeGrants.has(other.rootSessionID)).toBe(true)
    expect(fake.state.aborts).toEqual([])
  })

  test("an unrenewed lease closes the overlays at ten seconds despite unrelated SSE events", async () => {
    const fake = fixture()
    const scope = await fake.acquire()
    await fake.session.beforeStep(scope)
    await fake.advance(9999)
    expect(fake.state.visible).toBe(true)
    await fake.session.observe(status(NEXT.rootSessionID, "busy", NEXT.directory))
    await fake.advance(1)
    expect(fake.state.visible).toBe(false)
    expect(fake.kinds()).toContain("release")
    expect(fake.log.filter((entry) => entry.kind === "overlay-close").at(-1)!.at).toBeLessThanOrEqual(11_000)
    expect(fake.session.state().holder).toBeUndefined()
  })

  test("exact lease heartbeats keep a healthy holder alive while SSE is quiet", async () => {
    const fake = fixture()
    const scope = await fake.acquire()
    await fake.session.beforeStep(scope)
    await fake.advance(31_000, scope)
    expect(fake.session.state()).toMatchObject({ phase: "working", holder: { sessionID: ROOT.rootSessionID } })
    expect(fake.state.visible).toBe(true)
    expect(fake.kinds()).not.toContain("overlay-close")
  })

  test("engine exit immediately releases input, closes overlays and forgets task grants", async () => {
    const fake = fixture()
    const scope = await fake.acquire()
    await fake.session.beforeStep(scope)
    await fake.session.engineExit()
    expect(fake.state.visible).toBe(false)
    expect(fake.state.activeGrants.size).toBe(0)
    expect(fake.kinds()).toContain("release")
    expect(fake.session.state().holder).toBeUndefined()
  })

  test("Stop releases input before aborting only the holder and fails queued computer calls", async () => {
    const fake = fixture()
    const scope = await fake.acquire()
    await fake.session.beforeStep(scope)
    const next = fake.request(NEXT, true)
    const queued = fake.session.acquire(next.body, next.key).catch((error) => error)
    await flush()
    expect(fake.session.state().queue).toHaveLength(1)
    const start = fake.log.length
    const at = fake.time.now()
    await fake.session.stop()
    expect(await queued).toMatchObject({ code: "stopped", message: "The user stopped Vector Hands." })
    expect(fake.state.aborts.map((entry) => entry.scope.rootSessionID)).toEqual([ROOT.rootSessionID])
    expect(fake.state.activeGrants.size).toBe(0)
    const stopped = fake.log.slice(start)
    expect(stopped.findIndex((entry) => entry.kind === "release")).toBeLessThan(
      stopped.findIndex((entry) => entry.kind === "abort"),
    )
    expect(stopped.findIndex((entry) => entry.kind === "cancel")).toBeLessThan(
      stopped.findIndex((entry) => entry.kind === "abort"),
    )
    expect(stopped.findIndex((entry) => entry.kind === "abort")).toBeLessThan(
      stopped.findIndex((entry) => entry.kind === "grant-end"),
    )
    expect(stopped.find((entry) => entry.kind === "release")!.at - at).toBeLessThanOrEqual(100)
    expect(fake.session.state().queue).toEqual([])
  })

  test("stop-session fails one queued call while another waits and the holder keeps working", async () => {
    const fake = fixture()
    const scope = await fake.acquire()
    await fake.session.beforeStep(scope)
    const first = fake.request(NEXT, true)
    const other = { rootSessionID: "root-c", sessionID: "child-c", directory: "/work/project-c" }
    const second = fake.request(other, true)
    const dropped = fake.session.acquire(first.body, first.key).catch((error) => error)
    const kept = fake.session.acquire(second.body, second.key).catch((error) => error)
    await flush()
    await fake.session.stopSession(NEXT.sessionID)
    expect(await dropped).toMatchObject({ code: "stopped" })
    expect(fake.session.state()).toMatchObject({ phase: "working", holder: { sessionID: ROOT.rootSessionID } })
    expect(fake.session.state().queue.map((entry) => entry.sessionID)).toEqual([other.rootSessionID])
    expect(fake.state.aborts).toEqual([])
    await fake.session.stop()
    expect(await kept).toMatchObject({ code: "stopped" })
  })

  test("root idle releases the lock to the queued root; child idle does not", async () => {
    const fake = fixture()
    const scope = await fake.acquire()
    await fake.session.beforeStep(scope)
    await fake.session.observe(status(ROOT.rootSessionID, "busy"))
    const next = fake.request(NEXT, true)
    const queued = fake.session.acquire(next.body, next.key).catch((error) => error)
    await flush()
    await fake.session.observe(status(ROOT.sessionID, "idle"))
    expect(fake.session.state().holder?.sessionID).toBe(ROOT.rootSessionID)
    await fake.session.observe(status(ROOT.rootSessionID, "idle"))
    await fake.advance(2000)
    await fake.advance(400)
    const result = await queued
    expect(result).toHaveProperty("lease")
    expect(fake.session.state().holder?.sessionID).toBe(NEXT.rootSessionID)
    expect(fake.state.aborts).toEqual([])
  })
})

describe("pause, physical presence and power", () => {
  test("a normal release shows Done for two seconds, then fades for 400 ms", async () => {
    const fake = fixture()
    const scope = await fake.acquire()
    await fake.session.beforeStep(scope)
    await fake.session.release(scope)
    expect(fake.session.state().phase).toBe("done")
    expect(fake.state.visible).toBe(true)
    await fake.advance(1999)
    expect(fake.kinds()).not.toContain("fade")
    await fake.advance(1)
    expect(fake.kinds()).toContain("fade")
    await fake.advance(399)
    expect(fake.state.visible).toBe(true)
    await fake.advance(1)
    expect(fake.state.visible).toBe(false)
    expect(fake.state.aborts).toEqual([])
  })
  test("thirty minutes paused stops the run even while exact heartbeats continue", async () => {
    const fake = fixture()
    const scope = await fake.acquire()
    await fake.session.beforeStep(scope)
    await fake.session.pause("button")
    await fake.advance(30 * 60_000 - 1, scope)
    expect(fake.session.state().phase).toBe("paused")
    await fake.advance(1)
    expect(fake.session.state().phase).toBe("stopped")
    expect(fake.state.aborts).toEqual([{ scope, reason: "timeout" }])
    expect(fake.state.activeGrants.size).toBe(0)
  })

  test("helper exit pauses without an automatic restart", async () => {
    const fake = fixture()
    const scope = await fake.acquire()
    await fake.session.beforeStep(scope)
    fake.session.helperEvent({ event: "exit", code: 1 })
    await flush()
    expect(fake.session.state()).toMatchObject({ phase: "paused", pause: "helper" })
    await fake.advance(20_000, scope)
    expect(fake.kinds()).not.toContain("helper-resume")
    expect(fake.state.begins).toHaveLength(1)
  })

  test("a new explicit task recovers a crashed helper once after the old run stops", async () => {
    const fake = fixture()
    const scope = await fake.acquire()
    await fake.session.beforeStep(scope)
    fake.state.helperLatched = true
    fake.session.helperEvent({ event: "exit", code: 1 })
    await flush()
    expect(fake.session.state()).toMatchObject({ phase: "paused", pause: "helper" })
    await fake.advance(20_000, scope)
    expect(fake.kinds()).not.toContain("helper-resume")
    await fake.session.stop()
    const start = fake.log.length
    const next = await fake.acquire(NEXT)
    await fake.session.beforeStep(next)
    expect(
      fake.log
        .slice(start)
        .map((entry) => entry.kind)
        .filter((kind) => kind === "helper-resume" || kind === "hello"),
    ).toEqual(["helper-resume", "hello"])
    expect(fake.state.helperLatched).toBe(false)
    expect((await fake.acquire(NEXT)).lease).toBe(next.lease)
    expect(fake.kinds().filter((kind) => kind === "helper-resume")).toHaveLength(1)
    expect(fake.session.state()).toMatchObject({ phase: "working", holder: { sessionID: NEXT.rootSessionID } })
  })

  test("lost detection and secure input pause foreground input immediately", async () => {
    const fake = fixture()
    const scope = await fake.acquire()
    await fake.session.beforeStep(scope)
    fake.session.helperEvent({ event: "input_detection", alive: false, reason: "tap_disabled" })
    await flush()
    expect(fake.session.state()).toMatchObject({ phase: "paused", pause: "detection" })
    fake.session.helperEvent({ event: "input_detection", alive: true })
    await fake.session.resume()
    await fake.session.beforeStep(scope)
    fake.session.helperEvent({ event: "input_detection", alive: false, reason: "secure_input", holder: "Notes" })
    await flush()
    expect(fake.session.state()).toMatchObject({ phase: "paused", pause: "secure_input", secureInputHolder: "Notes" })
    expect(fake.kinds()).toContain("release")
  })

  for (const event of ["lock-screen", "screen-saver-started", "suspend", "user-did-resign-active"] as const)
    test(`${event} pauses and unlock never resumes it`, async () => {
      const fake = fixture()
      const scope = await fake.acquire()
      await fake.session.beforeStep(scope)
      await fake.session.powerEvent(event)
      expect(fake.session.state()).toMatchObject({
        phase: "paused",
        pause: event === "lock-screen" || event === "screen-saver-started" ? "locked" : "suspend",
      })
      await fake.session.powerEvent("unlock-screen")
      expect(fake.session.state().phase).toBe("paused")
      expect(fake.state.activeBlockers.size).toBe(0)
    })

  test("the helper's lock event pauses and its unlock does not resume", async () => {
    const fake = fixture()
    const scope = await fake.acquire()
    await fake.session.beforeStep(scope)
    fake.session.helperEvent({ event: "locked", locked: true })
    await flush()
    expect(fake.session.state()).toMatchObject({ phase: "paused", pause: "locked" })
    fake.session.helperEvent({ event: "locked", locked: false })
    await flush()
    expect(fake.session.state().phase).toBe("paused")
  })

  for (const awayMinutesMax of [undefined, 1])
    test(`the ${awayMinutesMax ?? 30}-minute physical-presence ceiling is checked at the next step`, async () => {
      const fake = fixture({ policy: { awayMinutesMax } })
      const scope = await fake.acquire()
      await fake.session.beforeStep(scope)
      expect(fake.state.activeBlockers.size).toBe(1)
      const limit = (awayMinutesMax ?? 30) * 60_000
      await fake.advance(limit - 1, scope)
      await fake.session.beforeStep(scope)
      await fake.advance(1, scope)
      expect(fake.session.state().phase).toBe("working")
      expect(await fake.session.beforeStep(scope).catch((error) => error)).toMatchObject({ code: "paused" })
      expect(fake.session.state()).toMatchObject({ phase: "paused", pause: "away" })
      expect(fake.state.activeBlockers.size).toBe(0)
    })

  test("only real helper user-input evidence refreshes physical presence", async () => {
    const fake = fixture({ prefs: { mode: "background" }, policy: { awayMinutesMax: 1 } })
    const scope = await fake.acquire()
    await fake.session.beforeStep(scope)
    await fake.advance(40_000, scope)
    fake.session.helperEvent({ event: "user_input", kind: "pointer", dx: 1, dy: 0 })
    await fake.advance(40_000, scope)
    await fake.session.beforeStep(scope)
    expect(fake.session.state().phase).toBe("working")
    await fake.advance(20_000, scope)
    expect(await fake.session.beforeStep(scope).catch((error) => error)).toMatchObject({ code: "paused" })
    expect(fake.session.state().pause).toBe("away")
  })

  test("continuous user waiting releases the actual blocker at two minutes despite heartbeats", async () => {
    const fake = fixture()
    const scope = await fake.acquire()
    await fake.session.beforeStep(scope)
    await fake.session.transition("asking", {
      requestID: "ask-1",
      directory: ROOT.directory,
      kind: "app",
      title: "Use Notes?",
      canAlways: true,
      shownAt: 1_700_000_000_000 + fake.time.now(),
    })
    await fake.advance(120_000 - 1, scope)
    expect(fake.state.activeBlockers.size).toBe(1)
    await fake.advance(1, scope)
    expect(fake.state.activeBlockers.size).toBe(0)
  })

  for (const value of [{ prefs: { keepAwake: false } }, { policy: { keepAwake: false } }])
    test(`keep-awake respects ${"prefs" in value ? "user preference" : "company ceiling"}`, async () => {
      const fake = fixture(value)
      const scope = await fake.acquire()
      await fake.session.beforeStep(scope)
      expect(fake.state.activeBlockers.size).toBe(0)
      expect(fake.kinds()).not.toContain("blocker-start")
    })
})

test("the complete live step is safe and bounded even with a long app name", async () => {
  const fake = fixture()
  const scope = await fake.acquire()
  await fake.session.beforeStep(scope, {
    action: "click",
    app: { key: Computer.appKey(APP), name: "N".repeat(256) },
    target: { name: "L".repeat(80) },
    intent: "MODEL INTENT MUST NOT REACH THE BANNER",
  })
  const state = fake.session.state()
  expect(state.step?.startsWith("Clicking")).toBe(true)
  expect(state.step!.length).toBeLessThanOrEqual(256)
  expect(state.step).not.toContain("MODEL INTENT")
  expect(JSON.stringify(fake.state.published)).not.toContain("MODEL INTENT")
})

test("only one matching scoped legacy Hands reply refreshes native grants", async () => {
  const fake = fixture()
  const scope = await fake.acquire({ rootSessionID: "ses_root", sessionID: "ses_child", directory: ROOT.directory })
  await fake.session.beforeStep(scope)
  const appKey = Computer.appKey(APP)
  const metadata: Computer.AppAskMetadata = {
    action: "use_app",
    level: "interact",
    canAlways: true,
    target: {
      appName: APP.name,
      appKey,
      platform: "macos",
      publisher: "Apple Inc.",
      verified: true,
      category: "office",
      pid: APP.pid,
      path: APP.path,
    },
  }
  const event = (type: string, properties: unknown, directory = scope.directory): KeepAwakeEvent => ({
    directory,
    payload: { type, properties },
  })
  const ask = (id: string, permission = "computer_app", directory = scope.directory) =>
    event(
      "permission.asked",
      {
        id,
        sessionID: scope.sessionID,
        permission,
        patterns: [appKey],
        always: [appKey],
        metadata,
      },
      directory,
    )
  const reply = (id: string, sessionID = scope.sessionID, directory = scope.directory) =>
    event(
      "permission.replied",
      {
        sessionID,
        requestID: id,
        reply: "once",
      },
      directory,
    )
  const start = fake.log.length
  await fake.session.observe(ask("per_ordinary", "read"))
  await fake.session.observe(reply("per_ordinary"))
  await fake.session.observe(ask("per_mcp", "mcp__computer_app"))
  await fake.session.observe(reply("per_mcp"))
  const v2 = ask("per_v2")
  await fake.session.observe({ ...v2, payload: { ...v2.payload, type: "permission.v2.asked" } })
  const v2Reply = reply("per_v2")
  await fake.session.observe({ ...v2Reply, payload: { ...v2Reply.payload, type: "permission.v2.replied" } })
  await fake.session.observe(v2Reply)
  await fake.session.observe(reply("per_unobserved"))
  await fake.session.observe(ask("per_wrong_directory", "computer_app", NEXT.directory))
  await fake.session.observe(reply("per_wrong_directory"))
  const canonical = ask("per_hands")
  await fake.session.observe(canonical)
  await fake.session.observe(reply("per_other"))
  await fake.session.observe(reply("per_hands", "ses_other"))
  await fake.session.observe(reply("per_hands", scope.sessionID, NEXT.directory))
  const nativeWork = () =>
    fake.log.slice(start).filter((entry) => ["cancel", "release", "update", "approved-read"].includes(entry.kind))
  expect(nativeWork()).toEqual([])
  expect(fake.session.state().phase).toBe("working")
  const calculator: Computer.MacIdentity = { ...APP, bundleId: "com.apple.calculator", name: "Calculator", pid: 501 }
  fake.state.approved = [APP, calculator]
  await fake.session.observe(reply("per_hands"))
  expect(nativeWork().filter((entry) => entry.kind === "release")).toHaveLength(1)
  expect(fake.state.native).toMatchObject({ approved: [APP, calculator], paused: false })
  const completed = fake.log.length
  await fake.session.observe(reply("per_hands"))
  await fake.session.observe(canonical)
  await fake.session.observe(reply("per_hands"))
  expect(
    fake.log.slice(completed).filter((entry) => ["cancel", "release", "update", "approved-read"].includes(entry.kind)),
  ).toEqual([])
})

test("composed emoji step lines fit the wire's UTF-16 bound without splitting a character", async () => {
  const fake = fixture()
  const scope = await fake.acquire()
  for (const label of ["😀".repeat(20), `A${"😀".repeat(19)}`]) {
    await fake.session.beforeStep(scope, {
      action: "click",
      app: { key: Computer.appKey(APP), name: "😀".repeat(128) },
      target: { name: label },
    })
    const state = fake.session.state()
    expect(Schema.is(Computer.ComputerState)(state)).toBe(true)
    expect(state.step!.length).toBeLessThanOrEqual(256)
    expect(/\p{Cs}/u.test(state.step!)).toBe(false)
  }
})

test("an old native begin and delayed abort cannot close a successor's overlays or grants", async () => {
  const fake = fixture()
  const oldBegin = deferred()
  const oldAbort = deferred()
  fake.state.beginWait = oldBegin.promise
  fake.state.abortWait = oldAbort.promise
  const first = await fake.acquire()
  const abandoned = fake.session.beforeStep(first).catch((error) => error)
  await flush()
  expect(fake.state.begins).toHaveLength(1)
  const stopped = fake.session.stop()
  await flush()
  expect(fake.state.activeGrants.size).toBe(0)
  fake.state.beginWait = undefined
  const second = await fake.acquire(NEXT)
  const ready = fake.session.beforeStep(second)
  await flush()
  expect(fake.state.begins).toHaveLength(1)
  oldBegin.resolve()
  expect(await abandoned).toMatchObject({ code: "stopped" })
  await ready
  expect(fake.kinds().filter((kind) => ["begin", "end", "end-ack"].includes(kind))).toEqual([
    "begin",
    "end",
    "end-ack",
    "begin",
  ])
  oldAbort.resolve()
  await stopped
  const endCount = fake.kinds().filter((kind) => kind === "end").length
  await fake.advance(2400, second)
  expect(fake.session.state()).toMatchObject({ phase: "working", holder: { sessionID: NEXT.rootSessionID } })
  expect(fake.state.visible).toBe(true)
  expect(fake.state.activeGrants.has(NEXT.rootSessionID)).toBe(true)
  expect(fake.kinds().filter((kind) => kind === "end")).toHaveLength(endCount)
  expect(
    await Promise.resolve()
      .then(() => fake.session.heartbeat(first))
      .catch((error) => error),
  ).toMatchObject({ code: "stopped" })
  expect(
    await Promise.resolve()
      .then(() => fake.session.release(first))
      .catch((error) => error),
  ).toMatchObject({ code: "stopped" })
  expect(fake.session.state().holder?.sessionID).toBe(NEXT.rootSessionID)
})
