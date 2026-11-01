import { randomUUID } from "node:crypto"
import { Option, Schema } from "effect"
import { Computer } from "@vectordevai/schema/computer"
import { Hands } from "@vectordevai/schema/hands"
import { PermissionPolicy } from "@vectordevai/schema/permission-policy"
import { PermissionV1 } from "@vectordevai/schema/v1/permission"
import { ComputerMainCopy } from "@vectordevai/app/computer/main-copy"
import { ComputerError, type ComputerBridgeKey } from "./computer-bridge"
import type { GrantScope } from "./computer-grants"
import type { KeepAwakeEvent } from "./keep-awake"

export type SessionScope = GrantScope
export type TypingWait = { readonly scope: SessionScope; readonly generation: number }
export type SessionBackend = Pick<
  Computer.ComputerBackend,
  "kind" | "hello" | "permissions" | "beginSession" | "updateSession" | "endSession" | "cancel" | "releaseAll"
>
export type SessionOverlay = {
  show(state: Computer.ComputerState, target?: Rect): Promise<void>
  update(state: Computer.ComputerState, target?: Rect): Promise<void>
  ready(): Promise<void>
  close(): void
  fade(): void
  windowIds(): string[]
  onLost(callback: () => void): () => void
}
export type SessionClock = {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}
type Rect = { x: number; y: number; width: number; height: number }
type Acquire = Extract<Computer.BridgeRequest, { command: "acquire" }>
type AcquireResponse = typeof Computer.BridgeCommands.acquire.response.Type
type Phase = "working" | "waiting" | "asking" | "handoff"
type Run = {
  scope: SessionScope
  nativeID: string
  hello: Computer.HelperHello
  preferenceMode: Computer.Mode
  handsAsks: Set<string>
  seenHandsAsks: Set<string>
  revision: number
  inputAlive?: boolean
  lastInput: number
  lastHeard: number
  watchdog?: unknown
  pausedTimer?: unknown
  pausedAt?: number
  typing?: { generation: number; revision: number; step?: string }
  view: Promise<void>
}
type Entry = {
  request: Acquire
  key: ComputerBridgeKey
  slot: ComputerBridgeKey
  waiting: boolean
  result: ReturnType<typeof Promise.withResolvers<AcquireResponse>>
  timer?: unknown
  cancelled: boolean
}

const time: SessionClock = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}
const LEASE_MS = 10_000
const WAIT_MS = 60_000
const RETRY_MS = 10_000
const QUEUE_MAX = 1000
const ASK_IDS_MAX = 10_000
const decodeReply = Schema.decodeUnknownOption(
  Schema.Struct({
    sessionID: Schema.String,
    requestID: Schema.String,
    reply: PermissionV1.Reply,
  }),
  { onExcessProperty: "error" },
)

/** The sole local computer lease. Native lifecycle writes are ordered; HTTP waits never hold that queue. */
export function createComputerSession(input: {
  backend: SessionBackend
  overlay: SessionOverlay
  settings: { get(): Computer.ResolvedComputerSettings }
  approved(scope: SessionScope): readonly Computer.AppIdentity[] | Promise<readonly Computer.AppIdentity[]>
  grants: {
    beginTask(scope: SessionScope): void
    endTask(rootSessionID: string, directory: string): void
    disconnect(): void
    observe?(event: KeepAwakeEvent): void | Promise<void>
  }
  helper: { setRunActive(active: boolean): void; resume(): Promise<unknown> }
  exclusions():
    | { vectorPids: readonly number[]; vectorWindowIds: readonly string[] }
    | Promise<{ vectorPids: readonly number[]; vectorWindowIds: readonly string[] }>
  abort(scope: SessionScope, reason: "stopped" | "timeout"): Promise<void>
  keepAwake: {
    update(state: {
      phase: Computer.ComputerPhase
      allowed: boolean
      away?: boolean
      pause?: Computer.PauseReason
    }): void
    close(): void
  }
  clock?: SessionClock
  wallNow?: () => number
  onState?(state: Computer.ComputerState): void
}) {
  const clock = input.clock ?? time
  const wallNow = input.wallNow ?? Date.now
  const queue = new Map<ComputerBridgeKey, Entry>()
  const state: {
    run?: Run
    native?: Run
    current: Computer.ComputerState
    lease: number
    epoch: number
    closed: boolean
    connected: boolean
    pumping: boolean
    candidate?: Entry
    locked: boolean
    needsResume: boolean
    helperEpoch: number
    endTimer?: unknown
    closeTimer?: unknown
  } = {
    current: base(),
    lease: 0,
    epoch: 0,
    closed: false,
    connected: true,
    pumping: false,
    locked: false,
    needsResume: false,
    helperEpoch: 0,
  }
  let nativeWork: Promise<void> = Promise.resolve()
  const subscribers = new Set<(value: Computer.ComputerState) => void>()

  function base(): Computer.ComputerState {
    const settings = input.settings.get()
    return {
      phase: enabled(settings) ? "ready" : "off",
      backend:
        input.backend.kind === "local-windows"
          ? "local-windows"
          : input.backend.kind === "remote"
            ? "remote"
            : "local-macos",
      mode: settings.prefs.mode === "background" && settings.policy.background ? "background" : "foreground",
      apps: [],
      queue: [],
      escStops: false,
      stopChord: Computer.clean(settings.prefs.stopChord, 64),
      lease: 0,
      reduceMotion: settings.prefs.reduceMotion,
    }
  }

  function snapshot() {
    return structuredClone(state.current)
  }

  function publish() {
    const settings = input.settings.get()
    state.current = {
      ...state.current,
      queue: [...queue.values()]
        .filter((entry) => !entry.cancelled)
        .map((entry) => ({ sessionID: entry.request.rootSessionID, title: entry.request.title })),
      escStops: !!state.run && state.current.phase === "working" && state.current.mode === "foreground",
      reduceMotion: settings.prefs.reduceMotion,
      stopChord: Computer.clean(settings.prefs.stopChord, 64),
    }
    input.keepAwake.update({
      phase: state.current.phase,
      allowed: !!state.run && enabled(settings) && settings.prefs.keepAwake && settings.policy.keepAwake,
      ...(state.current.pause ? { pause: state.current.pause } : {}),
      away: state.current.pause === "away",
    })
    for (const callback of [...(input.onState ? [input.onState] : []), ...subscribers])
      try {
        callback(snapshot())
      } catch {
        console.warn("Computer session state listener failed.")
      }
  }

  function show(run: Run, first = false) {
    publish()
    const view = first ? input.overlay.show(snapshot()) : input.overlay.update(snapshot())
    run.view = view
    void view.catch(() => {
      if (state.run === run && state.current.pause !== "overlay") void pause("overlay")
    })
  }

  function serial(callback: () => Promise<void>) {
    const next = nativeWork.catch(() => {}).then(callback)
    nativeWork = next
    void next.catch(() => {})
    return next
  }

  function bounded(pending: Promise<unknown>, ms: number) {
    return new Promise<void>((resolve) => {
      const timer = clock.setTimeout(resolve, ms)
      void pending.then(
        () => {
          clock.clearTimeout(timer)
          resolve()
        },
        () => {
          clock.clearTimeout(timer)
          resolve()
        },
      )
    })
  }

  function halt() {
    // Invocation order matters: both native commands are sent in this turn, before abort or grant revocation.
    const calls: Promise<unknown>[] = []
    try {
      calls.push(input.backend.cancel())
    } catch {
      /* Continue to release held input. */
    }
    try {
      calls.push(input.backend.releaseAll())
    } catch {
      /* The lease is revoked independently of an acknowledgement. */
    }
    return bounded(Promise.allSettled(calls), 100)
  }

  function recoverHelper() {
    const epoch = state.helperEpoch
    return new Promise<void>((resolve, reject) => {
      const status = { settled: false }
      const timer = clock.setTimeout(() => {
        status.settled = true
        reject(new ComputerError("unavailable", "The computer helper could not resume."))
      }, 5000)
      void input.helper.resume().then(
        () => {
          if (status.settled) return
          status.settled = true
          clock.clearTimeout(timer)
          if (epoch !== state.helperEpoch) {
            reject(new ComputerError("unavailable", "The computer helper stopped while resuming."))
            return
          }
          state.needsResume = false
          resolve()
        },
        () => {
          if (status.settled) return
          status.settled = true
          clock.clearTimeout(timer)
          reject(new ComputerError("unavailable", "The computer helper could not resume."))
        },
      )
    })
  }

  function inhibit(run: Run) {
    if (state.native !== run) return Promise.resolve()
    // This write must precede a late input call returning from its own awaited feature negotiation.
    try {
      const pending = input.backend.updateSession({
        sessionId: run.nativeID,
        phaseRevision: run.revision,
        mode: desiredMode(run, input.settings.get()).mode,
        paused: true,
        escStops: false,
      })
      void pending.catch(() => {})
      return pending
    } catch {
      return Promise.resolve()
    }
  }

  function endNative(run: Run) {
    return serial(async () => {
      if (state.native !== run) return
      try {
        await input.backend.endSession()
      } finally {
        if (state.native === run) state.native = undefined
      }
    })
  }

  function same(scope: SessionScope, run = state.run) {
    return (
      !!run &&
      run.scope.lease === scope.lease &&
      run.scope.rootSessionID === scope.rootSessionID &&
      run.scope.sessionID === scope.sessionID &&
      run.scope.directory === scope.directory
    )
  }

  function requireRun(scope: SessionScope) {
    if (!same(scope)) throw new ComputerError("stopped", "This computer lease has ended.")
    return state.run!
  }

  function check(run: Run, revision = run.revision) {
    if (state.run !== run) throw new ComputerError("stopped", "This computer lease has ended.")
    if (run.revision !== revision || state.current.phase !== "working")
      throw new ComputerError("paused", `${Hands.NAME} is waiting for you.`)
    const settings = input.settings.get()
    if (!enabled(settings)) {
      retire(run, "stopped", false)
      throw new ComputerError("blocked", `${Hands.NAME} is turned off.`)
    }
    const mode = desiredMode(run, settings)
    if (mode.changed) {
      run.preferenceMode = settings.prefs.mode
      run.inputAlive = undefined
      state.current = { ...state.current, mode: mode.mode }
      void pause("button")
      throw new ComputerError("paused", "The computer work mode changed. Use Resume to continue.")
    }
    if (state.locked) throw new ComputerError("locked", "The computer is locked.")
  }

  function desiredMode(run: Run, settings: Computer.ResolvedComputerSettings) {
    const preferenceChanged = settings.prefs.mode !== run.preferenceMode
    const wanted = preferenceChanged ? settings.prefs.mode : state.current.mode
    const mode =
      wanted === "background" && settings.policy.background && run.hello.features.background === true
        ? "background"
        : "foreground"
    return { mode, changed: preferenceChanged || mode !== state.current.mode } as const
  }

  function watch(run: Run) {
    if (run.watchdog !== undefined) clock.clearTimeout(run.watchdog)
    run.watchdog = clock.setTimeout(
      () => {
        if (state.run !== run) return
        if (clock.now() - run.lastHeard < LEASE_MS) {
          watch(run)
          return
        }
        retire(run, "stopped", false)
      },
      Math.max(0, run.lastHeard + LEASE_MS - clock.now()),
    )
  }

  function clearRunTimers(run: Run) {
    for (const timer of [run.watchdog, run.pausedTimer]) if (timer !== undefined) clock.clearTimeout(timer)
    run.watchdog = run.pausedTimer = undefined
  }

  function clearEndTimers() {
    for (const timer of [state.endTimer, state.closeTimer]) if (timer !== undefined) clock.clearTimeout(timer)
    state.endTimer = state.closeTimer = undefined
  }

  function busy(): AcquireResponse {
    return {
      code: "busy",
      holder: { title: state.current.holder?.title ?? state.candidate?.request.title ?? "Another conversation" },
    }
  }

  function settle(entry: Entry, result?: AcquireResponse, error?: ComputerError) {
    if (queue.get(entry.slot) !== entry) return
    queue.delete(entry.slot)
    entry.cancelled = true
    if (entry.timer !== undefined) clock.clearTimeout(entry.timer)
    if (!entry.waiting) return
    entry.waiting = false
    if (error) entry.result.reject(error)
    else entry.result.resolve(result ?? busy())
  }

  function poll(entry: Entry) {
    entry.timer = clock.setTimeout(() => {
      if (queue.get(entry.slot) !== entry || !entry.waiting) return
      entry.waiting = false
      entry.result.resolve(busy())
      // Keep FIFO through the engine's normal 100 ms poll gap, without granting an unwitnessed lease.
      entry.timer = clock.setTimeout(() => {
        settle(entry)
        publish()
        void pump()
      }, RETRY_MS)
      publish()
    }, WAIT_MS)
  }

  function rejectQueue() {
    for (const entry of [...queue.values()])
      settle(entry, undefined, new ComputerError("stopped", `The user stopped ${Hands.NAME}.`))
    publish()
  }

  function detach(run: Run) {
    if (state.run !== run) return
    state.run = undefined
    run.revision++
    state.epoch++
    clearRunTimers(run)
    input.helper.setRunActive(false)
    void endNative(run)
  }

  function retire(run: Run, phase: "done" | "stopped", flash: boolean) {
    if (state.run !== run) return
    detach(run)
    const stopped = halt()
    void inhibit(run)
    input.grants.endTask(run.scope.rootSessionID, run.scope.directory)
    state.current = {
      ...state.current,
      phase,
      holder: undefined,
      pause: undefined,
      ask: undefined,
      secureInputHolder: undefined,
      step: undefined,
      escStops: false,
    }
    publish()
    if (flash) {
      const epoch = state.epoch
      void input.overlay.update(snapshot()).catch(() => {
        if (epoch === state.epoch && !state.run) input.overlay.close()
      })
      state.endTimer = clock.setTimeout(() => {
        if (epoch !== state.epoch || state.run) return
        input.overlay.fade()
        state.closeTimer = clock.setTimeout(() => {
          if (epoch !== state.epoch || state.run) return
          input.overlay.close()
          state.current = base()
          publish()
        }, Computer.LIMITS.overlayFadeMs)
      }, 2000)
    } else {
      clearEndTimers()
      input.overlay.close()
      state.current = base()
      publish()
    }
    void stopped
    void pump()
  }

  async function pump() {
    if (state.pumping || state.run || state.closed || !state.connected) return
    state.pumping = true
    try {
      while (!state.run && !state.closed && state.connected) {
        const entry = [...queue.values()].find((entry) => !entry.cancelled)
        if (!entry) return
        if (!entry.waiting) return
        state.candidate = entry
        try {
          const settings = input.settings.get()
          if (!enabled(settings) || input.backend.kind === "remote")
            throw new ComputerError("unavailable", `${Hands.NAME} is unavailable.`)
          // A fresh explicit acquire may recover a crashed, ended run. An active paused run never does this.
          if (state.needsResume) {
            await recoverHelper()
            if (entry.cancelled || !entry.waiting || state.closed || !state.connected) continue
          }
          const hello = await input.backend.hello()
          if (entry.cancelled || !entry.waiting || state.closed || !state.connected) continue
          const permissions = await input.backend.permissions()
          if (entry.cancelled || !entry.waiting || state.closed || !state.connected) continue
          const missing: ("screen" | "accessibility")[] = []
          const allowed = input.backend.kind === "local-windows" ? ["granted", "n/a"] : ["granted"]
          if (!allowed.includes(permissions.screen) || permissions.captureBlocked) missing.push("screen")
          if (
            !allowed.includes(permissions.accessibility) ||
            permissions.postEvent === "denied" ||
            (input.backend.kind !== "local-windows" &&
              permissions.postEvent !== undefined &&
              permissions.postEvent !== "granted")
          )
            missing.push("accessibility")
          if (missing.length) {
            settle(entry, { code: "permissions", missing })
            continue
          }
          if (!enabled(input.settings.get())) throw new ComputerError("blocked", `${Hands.NAME} is turned off.`)
          clearEndTimers()
          const scope = Object.freeze({
            rootSessionID: entry.request.rootSessionID,
            sessionID: entry.request.sessionID,
            directory: entry.request.directory,
            lease: ++state.lease,
          })
          const run: Run = {
            scope,
            nativeID: randomUUID(),
            hello,
            preferenceMode: input.settings.get().prefs.mode,
            handsAsks: new Set(),
            seenHandsAsks: new Set(),
            revision: 0,
            lastInput: clock.now(),
            lastHeard: clock.now(),
            view: Promise.resolve(),
          }
          input.grants.beginTask(scope)
          state.epoch++
          state.run = run
          input.helper.setRunActive(true)
          const current = input.settings.get()
          state.current = {
            ...base(),
            phase: "working",
            lease: scope.lease,
            mode:
              current.prefs.mode === "background" && current.policy.background && hello.features.background === true
                ? "background"
                : "foreground",
            holder: {
              sessionID: scope.rootSessionID,
              directory: scope.directory,
              title: Computer.clean(entry.request.title, 256),
              startedAt: wallNow(),
              actions: 0,
            },
          }
          settle(entry, { lease: scope.lease })
          show(run, true)
          watch(run)
          if (state.locked) void pause("locked")
        } catch (error) {
          settle(
            entry,
            undefined,
            error instanceof ComputerError ? error : new ComputerError("unavailable", `${Hands.NAME} is unavailable.`),
          )
        }
      }
    } finally {
      state.pumping = false
      state.candidate = undefined
      publish()
    }
  }

  function acquire(request: Acquire, key: ComputerBridgeKey): Promise<AcquireResponse> {
    if (state.closed || !state.connected)
      return Promise.reject(new ComputerError("unavailable", "The engine is disconnected."))
    if (
      key.command !== "acquire" ||
      key.rootSessionID !== request.rootSessionID ||
      key.sessionID !== request.sessionID ||
      key.directory !== request.directory
    )
      return Promise.reject(new ComputerError("failed", "The computer request scope is invalid."))
    const active = state.run
    if (
      active &&
      active.scope.rootSessionID === request.rootSessionID &&
      active.scope.sessionID === request.sessionID &&
      active.scope.directory === request.directory
    )
      return Promise.resolve({ lease: active.scope.lease })
    const existing = [...queue.values()].find((entry) => entry.waiting && entry.key === key)
    if (existing) return existing.result.promise
    const slot = [...queue.values()].find(
      (entry) =>
        !entry.waiting &&
        entry.request.rootSessionID === request.rootSessionID &&
        entry.request.sessionID === request.sessionID &&
        entry.request.directory === request.directory,
    )
    if (slot && request.wait) {
      if (slot.timer !== undefined) clock.clearTimeout(slot.timer)
      slot.key = key
      slot.request = structuredClone(request)
      slot.result = Promise.withResolvers<AcquireResponse>()
      slot.waiting = true
      void slot.result.promise.catch(() => {})
      poll(slot)
      publish()
      void pump()
      return slot.result.promise
    }
    if ((active || state.pumping || queue.size) && !request.wait) return Promise.resolve(busy())
    if (queue.size >= QUEUE_MAX)
      return Promise.reject(new ComputerError("busy", "Too many conversations are waiting for the computer."))
    const entry: Entry = {
      request: structuredClone(request),
      key,
      slot: key,
      waiting: true,
      result: Promise.withResolvers<AcquireResponse>(),
      cancelled: false,
    }
    void entry.result.promise.catch(() => {})
    poll(entry)
    queue.set(key, entry)
    publish()
    void pump()
    return entry.result.promise
  }

  function scope(key: Pick<ComputerBridgeKey, "rootSessionID" | "sessionID" | "directory" | "lease">): SessionScope {
    const current = state.run?.scope
    if (
      !current ||
      current.lease !== key.lease ||
      current.rootSessionID !== key.rootSessionID ||
      current.sessionID !== key.sessionID ||
      current.directory !== key.directory
    )
      throw new ComputerError("stopped", "This computer lease has ended.")
    return { ...current }
  }

  async function sync(run: Run, revision: number) {
    check(run, revision)
    const identities = await input.approved(run.scope)
    check(run, revision)
    const exclusions = await input.exclusions()
    check(run, revision)
    const overlayWindowIds = input.overlay.windowIds()
    if (!overlayWindowIds.length) {
      void pause("overlay")
      throw new ComputerError("paused", "The screen indicator is unavailable.")
    }
    const session: Computer.SessionBegin = {
      sessionId: run.nativeID,
      mode: state.current.mode,
      approved: structuredClone([...identities]),
      vectorPids: [...exclusions.vectorPids],
      vectorWindowIds: [...exclusions.vectorWindowIds],
      overlayWindowIds,
      escStops: state.current.escStops,
      stopChord: state.current.stopChord,
      heartbeatMs: Computer.LIMITS.heartbeatMs,
      phaseRevision: revision,
      paused: true,
    }
    await serial(async () => {
      check(run, revision)
      if (state.native !== run) {
        if (state.native) {
          await input.backend.endSession()
          state.native = undefined
          check(run, revision)
        }
        state.native = run
        run.inputAlive = undefined
        await input.backend.beginSession(session)
      } else await input.backend.updateSession(session)
      check(run, revision)
    })
    check(run, revision)
    state.current = {
      ...state.current,
      apps: identities.map((identity) => ({
        key: Computer.appKey(identity),
        name: Computer.clean(identity.name, 256),
      })),
    }
    show(run)
  }

  async function beforeStep(value: SessionScope, metadata?: Computer.ComputerPartMetadata) {
    const run = requireRun(value)
    const revision = run.revision
    check(run, revision)
    const maximum = input.settings.get().policy.awayMinutesMax
    const awayMs = Math.min(Computer.LIMITS.awayMinutes, maximum ?? Computer.LIMITS.awayMinutes) * 60_000
    if (clock.now() - run.lastInput >= awayMs) {
      void pause("away")
      throw new ComputerError("paused", `${Hands.NAME} paused so your computer can lock.`)
    }
    if (metadata) {
      const action = Computer.ToolAction.literals.find((action) => action === metadata.action)
      if (action)
        state.current = {
          ...state.current,
          step: Computer.clean(
            ComputerMainCopy.step({
              action,
              app: metadata.app?.name && Computer.clean(metadata.app.name, 256),
              label: metadata.target?.name,
            }),
            256,
          )
            .slice(0, 256)
            .replace(/[\ud800-\udbff]$/, ""),
        }
      show(run)
    }
    try {
      await run.view
      check(run, revision)
      await input.overlay.ready()
      check(run, revision)
    } catch (error) {
      if (state.run === run && run.revision === revision) void pause("overlay")
      throw error instanceof ComputerError ? error : new ComputerError("paused", "The screen indicator is unavailable.")
    }
    try {
      await sync(run, revision)
    } catch (error) {
      if (state.run === run && run.revision === revision) void pause("helper")
      throw error instanceof ComputerError ? error : new ComputerError("paused", "The computer helper stopped.")
    }
    await serial(async () => {
      check(run, revision)
      try {
        await run.view
        check(run, revision)
        await input.overlay.ready()
      } catch (error) {
        if (state.run === run && run.revision === revision) void pause("overlay")
        throw error instanceof ComputerError
          ? error
          : new ComputerError("paused", "The screen indicator is unavailable.")
      }
      check(run, revision)
      if (
        state.current.mode === "foreground" &&
        (run.hello.features["userInput.detect"] !== true || run.inputAlive !== true)
      ) {
        void pause("detection")
        throw new ComputerError("paused", "Physical input detection is unavailable.")
      }
      try {
        await input.backend.updateSession({
          sessionId: run.nativeID,
          phaseRevision: revision,
          mode: state.current.mode,
          paused: false,
          escStops: state.current.escStops,
        })
      } catch (error) {
        if (state.run === run && run.revision === revision) void pause("helper")
        throw error instanceof ComputerError ? error : new ComputerError("paused", "The computer helper stopped.")
      }
      check(run, revision)
    })
    check(run, revision)
  }

  function pause(reason: Computer.PauseReason, holder?: string, ask?: Computer.ComputerState["ask"]) {
    const run = state.run
    if (!run) return Promise.resolve()
    if (state.current.phase === "paused" && state.current.pause === reason) return Promise.resolve()
    run.revision++
    run.typing = undefined
    state.current = {
      ...state.current,
      phase: "paused",
      pause: reason,
      ask: ask ? structuredClone(ask) : undefined,
      secureInputHolder: reason === "secure_input" && holder ? Computer.clean(holder, 256) : undefined,
    }
    const stopped = halt()
    const inhibited = inhibit(run)
    if (run.pausedAt === undefined) {
      run.pausedAt = clock.now()
      run.pausedTimer = clock.setTimeout(() => {
        if (state.run === run && run.pausedAt !== undefined) void stop("timeout")
      }, Computer.LIMITS.pausedEndMinutes * 60_000)
    }
    show(run)
    return Promise.allSettled([stopped, inhibited]).then(() => {})
  }

  async function resume() {
    const run = state.run
    if (!run || state.current.phase !== "paused") return
    if (state.locked) throw new ComputerError("locked", "The computer is locked.")
    const revision = ++run.revision
    if (state.needsResume || state.current.pause === "helper") {
      await recoverHelper()
      if (state.run !== run || run.revision !== revision)
        throw new ComputerError("stopped", "This computer lease has ended.")
      run.hello = await input.backend.hello()
    }
    if (state.run !== run || run.revision !== revision)
      throw new ComputerError("stopped", "This computer lease has ended.")
    await endNative(run)
    if (state.run !== run || run.revision !== revision)
      throw new ComputerError("stopped", "This computer lease has ended.")
    run.pausedAt = undefined
    if (run.pausedTimer !== undefined) clock.clearTimeout(run.pausedTimer)
    run.pausedTimer = undefined
    run.lastInput = clock.now()
    const settings = input.settings.get()
    const mode = desiredMode(run, settings).mode
    run.preferenceMode = settings.prefs.mode
    state.current = {
      ...state.current,
      mode,
      phase: "working",
      pause: undefined,
      ask: undefined,
      secureInputHolder: undefined,
    }
    show(run)
    await beforeStep(run.scope)
  }

  function stop(reason: "stopped" | "timeout" = "stopped") {
    const run = state.run
    rejectQueue()
    if (!run) return Promise.resolve()
    detach(run)
    const stopped = halt()
    void inhibit(run)
    // Native commands were invoked first. Revoke in the same JS turn; an HTTP response never retains authority.
    let abort: Promise<void>
    try {
      abort = input.abort(run.scope, reason)
    } catch {
      abort = Promise.resolve()
    }
    input.grants.endTask(run.scope.rootSessionID, run.scope.directory)
    state.current = {
      ...state.current,
      phase: "stopped",
      holder: undefined,
      pause: undefined,
      ask: undefined,
      secureInputHolder: undefined,
      step: undefined,
      escStops: false,
    }
    publish()
    const epoch = state.epoch
    void input.overlay.update(snapshot()).catch(() => {
      if (epoch === state.epoch && !state.run) input.overlay.close()
    })
    clearEndTimers()
    state.endTimer = clock.setTimeout(() => {
      if (epoch !== state.epoch || state.run) return
      input.overlay.fade()
      state.closeTimer = clock.setTimeout(() => {
        if (epoch !== state.epoch || state.run) return
        input.overlay.close()
        state.current = base()
        publish()
      }, Computer.LIMITS.overlayFadeMs)
    }, 2000)
    return Promise.allSettled([stopped, abort]).then(() => {})
  }

  function disconnect() {
    state.connected = false
    rejectQueue()
    const run = state.run
    if (run) {
      detach(run)
      void halt()
      void inhibit(run)
    }
    input.grants.disconnect()
    clearEndTimers()
    input.overlay.close()
    state.current = base()
    publish()
  }

  async function updateGrants() {
    const run = state.run
    if (!run) return
    const typing = state.current.phase === "waiting" && run.typing?.revision === run.revision ? run.typing : undefined
    run.revision++
    if (typing) typing.revision = run.revision
    void halt()
    const inhibited = inhibit(run)
    if (state.current.phase === "working") await beforeStep(run.scope)
    else await inhibited
  }

  const unlisten = input.overlay.onLost(() => {
    if (state.run) void pause("overlay")
  })

  return {
    state: snapshot,
    subscribe(callback: (value: Computer.ComputerState) => void) {
      subscribers.add(callback)
      return () => void subscribers.delete(callback)
    },
    scope,
    isActive: (value: SessionScope) => same(value) && state.current.phase === "working" && !state.locked,
    nativePhase(value: SessionScope) {
      const run = requireRun(value)
      check(run)
      return { sessionId: run.nativeID, phaseRevision: run.revision }
    },
    didStep(value: SessionScope, count = 1) {
      const run = requireRun(value)
      check(run)
      if (!Number.isSafeInteger(count) || count <= 0 || count > Computer.LIMITS.batchSteps)
        throw new ComputerError("failed", "The completed computer step count is invalid.")
      const holder = state.current.holder!
      state.current = {
        ...state.current,
        holder: { ...holder, actions: Math.min(Number.MAX_SAFE_INTEGER, holder.actions + count) },
      }
      publish()
    },
    acquire,
    cancelAcquire(key: ComputerBridgeKey) {
      const entry = [...queue.values()].find((entry) => entry.waiting && entry.key === key)
      if (!entry) return
      settle(entry, undefined, new ComputerError("stopped", "This computer request was cancelled."))
      publish()
      void pump()
    },
    cancelQueued(value: Pick<SessionScope, "rootSessionID" | "sessionID" | "directory">) {
      for (const entry of [...queue.values()])
        if (
          entry.request.rootSessionID === value.rootSessionID &&
          entry.request.sessionID === value.sessionID &&
          entry.request.directory === value.directory
        )
          settle(entry, undefined, new ComputerError("stopped", "This queued computer request was cancelled."))
      publish()
      void pump()
    },
    release(value: SessionScope) {
      const run = requireRun(value)
      retire(run, "done", true)
      return Promise.resolve()
    },
    heartbeat(value: SessionScope) {
      const run = requireRun(value)
      run.lastHeard = clock.now()
      watch(run)
      return Promise.resolve({ state: snapshot() })
    },
    beforeStep,
    updateGrants,
    waitForInput(app?: string): TypingWait | undefined {
      const run = state.run
      if (!run || state.current.mode !== "background" || state.locked) return
      const owned = state.current.phase === "waiting" && run.typing?.revision === run.revision
      if (state.current.phase !== "working" && !owned) return
      const step = owned ? run.typing?.step : state.current.step
      const revision = ++run.revision
      run.typing = { generation: revision, revision, step }
      state.current = {
        ...state.current,
        phase: "waiting",
        ask: undefined,
        step: app
          ? Computer.clean(ComputerMainCopy.waitingForTyping({ app: Computer.clean(app, 256) }), 256)
              .slice(0, 256)
              .replace(/[\ud800-\udbff]$/, "")
          : ComputerMainCopy.labels.waiting,
      }
      // The caller gets a token synchronously, after authority has already been inhibited.
      const stopped = halt()
      const inhibited = inhibit(run)
      show(run)
      void Promise.allSettled([stopped, inhibited])
      return { scope: { ...run.scope }, generation: revision }
    },
    async continueAfterInput(token: TypingWait): Promise<boolean> {
      const run = state.run
      if (
        !run ||
        !same(token.scope) ||
        run.typing?.generation !== token.generation ||
        run.typing?.revision !== run.revision ||
        state.current.phase !== "waiting" ||
        state.current.mode !== "background" ||
        state.locked
      )
        return false
      const step = run.typing.step
      run.typing = undefined
      run.revision++
      state.current = { ...state.current, phase: "working", step }
      show(run)
      await beforeStep(run.scope)
      return state.run === run && state.current.phase === "working"
    },
    pause,
    resume,
    stop,
    stopSession(sessionID: string) {
      for (const entry of [...queue.values()])
        if (entry.request.rootSessionID === sessionID || entry.request.sessionID === sessionID)
          settle(entry, undefined, new ComputerError("stopped", `The user stopped ${Hands.NAME}.`))
      publish()
      void pump()
      return Promise.resolve()
    },
    transition(phase: Phase, ask?: Computer.ComputerState["ask"]) {
      const run = state.run
      if (!run) return Promise.reject(new ComputerError("stopped", "This computer lease has ended."))
      if (state.current.phase === "paused")
        return Promise.reject(new ComputerError("paused", `Use Resume to continue ${Hands.NAME}.`))
      run.revision++
      run.typing = undefined
      state.current = { ...state.current, phase, ask: ask ? structuredClone(ask) : undefined }
      show(run)
      if (phase === "working") return beforeStep(run.scope)
      const stopped = halt()
      const update = inhibit(run)
      return Promise.allSettled([stopped, update]).then(() => {})
    },
    async setMode(mode: Computer.Mode) {
      const run = state.run
      if (!run) return
      const settings = input.settings.get()
      if (mode === "background" && (!settings.policy.background || run.hello.features.background !== true)) {
        if (state.current.mode === "background") {
          run.preferenceMode = settings.prefs.mode
          run.inputAlive = undefined
          state.current = { ...state.current, mode: "foreground" }
          void pause("button")
        }
        throw new ComputerError("needs_foreground", "Background control is unavailable.")
      }
      const previous = state.current.mode
      run.preferenceMode = settings.prefs.mode
      const typing = state.current.phase === "waiting" && run.typing?.revision === run.revision ? run.typing : undefined
      if (typing && mode !== previous) {
        state.current = { ...state.current, mode }
        await pause("button")
        return
      }
      run.revision++
      if (typing) typing.revision = run.revision
      void halt()
      void inhibit(run)
      state.current = { ...state.current, mode }
      show(run)
      if (state.current.phase === "working") {
        if (mode === "foreground" && previous !== "foreground") {
          await endNative(run)
          if (state.run !== run) throw new ComputerError("stopped", "This computer lease has ended.")
        }
        await beforeStep(run.scope)
      } else {
        const revision = run.revision
        await serial(async () => {
          if (state.run === run && run.revision === revision && state.native === run) {
            const latest = desiredMode(run, input.settings.get())
            if (latest.changed) {
              void inhibit(run)
              throw new ComputerError("paused", "The computer work mode changed.")
            }
            await input.backend.updateSession({
              sessionId: run.nativeID,
              phaseRevision: revision,
              mode,
              paused: true,
              escStops: false,
            })
          }
        })
      }
    },
    async observe(event: KeepAwakeEvent) {
      if (state.closed) return
      if (event.payload.type === "server.connected") state.connected = true
      const run = state.run
      const properties = event.payload.properties
      const info = properties && typeof properties === "object" ? (properties as Record<string, unknown>) : undefined
      const request = event.payload.type === "permission.asked" ? handsAsk(properties) : undefined
      if (
        run &&
        request &&
        request.sessionID === run.scope.sessionID &&
        event.directory === run.scope.directory &&
        !run.seenHandsAsks.has(request.id)
      ) {
        if (run.handsAsks.size >= QUEUE_MAX || run.seenHandsAsks.size >= ASK_IDS_MAX) retire(run, "stopped", false)
        else {
          run.seenHandsAsks.add(request.id)
          run.handsAsks.add(request.id)
        }
      }
      const reply = event.payload.type === "permission.replied" ? decodeReply(properties) : undefined
      const handsReply =
        !!run &&
        !!reply &&
        Option.isSome(reply) &&
        event.directory === run.scope.directory &&
        reply.value.sessionID === run.scope.sessionID &&
        run.handsAsks.delete(reply.value.requestID)
      if (event.payload.type === "session.status" && info && event.directory) {
        const status =
          info.status && typeof info.status === "object" ? (info.status as Record<string, unknown>).type : undefined
        if (typeof status === "string" && status !== "busy" && status !== "retry")
          for (const entry of [...queue.values()])
            if (entry.request.rootSessionID === info.sessionID && entry.request.directory === event.directory)
              settle(entry, undefined, new ComputerError("stopped", "This computer request has ended."))
        publish()
        void pump()
      }
      if (
        run &&
        event.directory === run.scope.directory &&
        (info?.sessionID === run.scope.rootSessionID || info?.sessionID === run.scope.sessionID)
      ) {
        run.lastHeard = clock.now()
        watch(run)
        if (event.payload.type === "session.status" && info.sessionID === run.scope.rootSessionID) {
          const status =
            info.status && typeof info.status === "object" ? (info.status as Record<string, unknown>).type : undefined
          if (typeof status === "string" && status !== "busy" && status !== "retry") retire(run, "done", true)
        }
        if (
          event.payload.type === "session.error" ||
          event.payload.type === "session.deleted" ||
          event.payload.type === "session.aborted"
        )
          retire(run, "stopped", false)
      }
      await input.grants.observe?.(event)
      if (state.run === run && handsReply) await updateGrants()
    },
    helperEvent(event: Computer.HelperEvent) {
      if (event.event === "locked") state.locked = event.locked
      if (event.event === "exit") state.helperEpoch++
      const run = state.run
      if (!run) return
      if (event.event === "user_input") {
        run.lastInput = clock.now()
        return
      }
      if (event.event === "stop") {
        if (event.by === "chord" || state.current.escStops) void stop()
        return
      }
      if (event.event === "exit") {
        state.needsResume = true
        run.inputAlive = false
        void pause("helper")
        return
      }
      if (event.event === "locked") {
        if (event.locked) void pause("locked")
        return
      }
      if (event.event === "display_change") {
        void pause("overlay")
        return
      }
      if (event.event === "input_detection") {
        run.inputAlive = event.alive
        if (event.alive || state.current.mode !== "foreground") return
        void pause(
          event.reason === "secure_input"
            ? "secure_input"
            : event.reason === "secure_desktop"
              ? "secure_desktop"
              : "detection",
          event.holder,
        )
      }
    },
    powerEvent(name: string) {
      if (["unlock-screen", "screen-saver-stopped", "screensaver-stop"].includes(name)) {
        state.locked = false
        return
      }
      if (["lock-screen", "screen-saver-started", "screensaver-start"].includes(name)) {
        state.locked = true
        void pause("locked")
        return
      }
      if (name === "suspend" || name === "user-did-resign-active") {
        state.locked = true
        void pause("suspend")
        return
      }
      if (name === "resume" || name === "user-did-become-active") state.locked = false
    },
    engineExit: disconnect,
    disconnect,
    close() {
      if (state.closed) return
      state.closed = true
      disconnect()
      unlisten()
      subscribers.clear()
      input.keepAwake.close()
    },
  }
}

/** Match the same exact legacy Hands envelope as the grants manager; retain no metadata or typed text here. */
function handsAsk(value: unknown) {
  const decoded = Schema.decodeUnknownOption(PermissionV1.Request)(value)
  if (Option.isNone(decoded)) return
  const request = decoded.value
  if (
    !PermissionPolicy.handsAsk(request.permission) ||
    request.id.length > 256 ||
    request.patterns.length !== 1 ||
    request.always.length > 1
  )
    return
  if (request.permission === "computer_app") {
    const metadata = Schema.decodeUnknownOption(Computer.AppAskMetadata)(request.metadata)
    if (
      Option.isSome(metadata) &&
      request.patterns[0] === metadata.value.target.appKey &&
      metadata.value.canAlways === (request.always.length === 1 && request.always[0] === request.patterns[0])
    )
      return { id: request.id, sessionID: request.sessionID }
    return
  }
  const metadata = Schema.decodeUnknownOption(Computer.SensitiveAskMetadata)(request.metadata)
  if (
    Option.isSome(metadata) &&
    request.always.length === 0 &&
    metadata.value.stepDigest &&
    request.patterns[0] === `${metadata.value.target.appKey}:${metadata.value.why}`
  )
    return { id: request.id, sessionID: request.sessionID }
}

function enabled(settings: Computer.ResolvedComputerSettings) {
  return (
    settings.prefs.enabled &&
    settings.policy.enabled &&
    typeof settings.prefs.consentedAt === "number" &&
    Number.isFinite(settings.prefs.consentedAt) &&
    settings.prefs.consentedAt > 0
  )
}
