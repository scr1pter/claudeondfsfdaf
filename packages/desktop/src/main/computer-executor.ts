import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import { Schema } from "effect"
import { ComputerCredential } from "@vectordevai/core/computer/credential"
import { ComputerProgram } from "@vectordevai/core/computer/program"
import { ComputerSensitive } from "@vectordevai/core/computer/sensitive"
import { Computer } from "@vectordevai/schema/computer"
import { ComputerApps } from "@vectordevai/schema/computer-apps"
import { Hands } from "@vectordevai/schema/hands"
import { ComputerMainCopy } from "@vectordevai/app/computer/main-copy"
import { ComputerError, type BridgeResponse, type ComputerBridgeKey, type ComputerExecutor } from "./computer-bridge"
import { checkStep, typeChecked, type GateContext, type GateResult } from "./computer-gate"
import { imageMime } from "./computer-frames"
import type { createComputerGrants } from "./computer-grants"
import type { createComputerSession, SessionClock, SessionScope } from "./computer-session"
import type { AppGrants } from "./computer-settings"

type Act = Extract<Computer.BridgeRequest, { command: "act" }>
type Screenshot = typeof Computer.ScreenshotResponse.Type
type Controller = ReturnType<typeof createComputerSession>
type Grants = ReturnType<typeof createComputerGrants>
type Target = Computer.CaptureRequest["target"]
type OpenTarget = Computer.AppQuery | { path: string }

/** Main's one frame/ref registry, injected so the dispatcher never invents geometry or renderer refs. */
export type ExecutorRegistry = {
  add(
    scope: SessionScope,
    capture: {
      header: Computer.CaptureHeader
      bytes: Uint8Array
      target: Target
      approved: readonly Computer.AppIdentity[]
      phase: Computer.NativePhase
      budget?: Computer.CaptureBudget
    },
  ): Promise<Screenshot>
  frame(scope: SessionScope, id: string): Computer.Frame
  latest(scope: SessionScope): Computer.Frame | undefined
  captureId(scope: SessionScope, id: string): string
  current(scope: SessionScope, frame: Computer.Frame, hit: Computer.HitResult): Promise<boolean>
  tree(
    scope: SessionScope,
    tree: Computer.TreeResult,
    frame?: Computer.Frame,
    phase?: Computer.NativePhase,
  ): Computer.UiNode[] | Promise<Computer.UiNode[]>
  resolve(scope: SessionScope, ref: string): Promise<Computer.HitResult>
  uiRef(scope: SessionScope, hit: Computer.HitResult): string | undefined
  point(scope: SessionScope, frame: Computer.Frame | string, point: Computer.Point): { x: number; y: number }
  pixel(scope: SessionScope, frame: Computer.Frame | string, point: { x: number; y: number }): Computer.Point
  toDip?(rect: Computer.Rect, displayID: string): Computer.Rect
  clear(scope?: SessionScope): void
}
type Flight = {
  key: ComputerBridgeKey
  command: Computer.BridgeCommandName
  abort: AbortController
  scope?: SessionScope
  promise?: Promise<unknown>
  started: boolean
  allowPaused?: boolean
  durable?: boolean
  cleanups: Set<() => void>
}
type Task = {
  scope: SessionScope
  clipboardHash?: string
  launched: Set<string>
  foreground: Set<string>
  programs: Map<string, Computer.ProgramLaunch>
  initialMode: Computer.Mode
  borrowed?: boolean
  pointer?: { id: string; app: string; result?: "resumed" | "declined" }
}

const clock: SessionClock = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
}
const OBSERVE = new Set<Computer.BridgeCommandName>([
  "access",
  "prepareOpen",
  "grant",
  "remember",
  "listApps",
  "screenshot",
  "zoom",
  "inspect",
  "readUi",
])

export function actDeadline(request: Pick<Act, "steps" | "settleMs">) {
  return (
    request.steps.reduce(
      (total, step) =>
        total +
        (step.kind === "wait"
          ? step.ms
          : Computer.LIMITS.inputStepMs + (step.kind === "key" ? (step.holdMs ?? 0) * step.repeat : 0)),
      0,
    ) +
    request.settleMs +
    Computer.LIMITS.captureMs +
    Computer.LIMITS.actSlackMs
  )
}

/** Exact HTTP request ownership surrounds the shared live target gate; no model identity is authority. */
export function createComputerExecutor(input: {
  backend: Computer.ComputerBackend
  controller: Controller
  settings: {
    get(): Computer.ResolvedComputerSettings
    access(identity: Computer.AppIdentity, grants?: AppGrants): Computer.AccessVerdict
  }
  grants: Grants
  registry: ExecutorRegistry
  canonicalPath(file: string): Promise<string | undefined>
  protectedPaths: readonly string[]
  protectedDirectories: readonly string[]
  documentProtected?: (file: string) => boolean
  signals?: (hit: Computer.HitResult) => ComputerApps.Signals | undefined
  beforeInput?: (scope: SessionScope, hit: Computer.HitResult) => void
  clipboard: {
    readText(): string | Promise<string>
    writeText?(text: string, phase: Computer.NativePhase): void | Promise<void>
  }
  overlay: {
    cursor(cursor: {
      kind: "ring" | "ghost" | "hide"
      point?: { x: number; y: number }
      visible: boolean
    }): Promise<void>
    step(point?: { x: number; y: number }): void
    realPointer(active: boolean): void
    ready(): Promise<void>
    windowIds(): string[]
  }
  clock?: SessionClock
  suspendEsc?(): void | (() => void)
  resumeEsc?(): void
}) {
  const time = input.clock ?? clock
  const flights = new Map<ComputerBridgeKey, Flight>()
  const tasks = new Map<number, Task>()
  const queues = new Map<number, Promise<unknown>>()
  const controlWaiters = new Set<() => void>()
  const state: { closed: boolean; native?: Flight; view?: Computer.ComputerState } = { closed: false }

  function task(scope: SessionScope) {
    input.controller.scope(scope)
    if (!input.grants.isActive(scope)) throw new ComputerError("stopped", "This computer task has ended.")
    for (const [lease, previous] of tasks)
      if (lease !== scope.lease) {
        input.registry.clear(previous.scope)
        tasks.delete(lease)
      }
    const current = tasks.get(scope.lease)
    if (current) return current
    const created: Task = {
      scope: { ...scope },
      launched: new Set(),
      foreground: new Set(),
      programs: new Map(),
      initialMode: input.controller.state().mode,
    }
    tasks.set(scope.lease, created)
    return created
  }

  function live(flight: Flight, working = !OBSERVE.has(flight.command)) {
    if (flight.abort.signal.aborted) throw flight.abort.signal.reason
    if (state.closed) throw new ComputerError("stopped", "This computer request was cancelled.")
    if (!flight.scope) return
    input.controller.scope(flight.scope)
    if (working && !input.controller.isActive(flight.scope))
      throw new ComputerError("paused", `${Hands.NAME} is waiting for you.`)
    if (!input.grants.isActive(flight.scope)) throw new ComputerError("stopped", "This computer task has ended.")
  }

  function scoped(key: ComputerBridgeKey, request: Computer.BridgeRequest) {
    const lease = "lease" in request && request.lease !== undefined ? request.lease : input.controller.state().lease
    return input.controller.scope({ ...key, lease })
  }

  async function readClipboard(scope: SessionScope) {
    const text = await input.clipboard.readText()
    return { text, agentOwned: task(scope).clipboardHash === hash(text) }
  }

  function after<T>(flight: Flight, promise: Promise<T>, working?: boolean) {
    return promise.then(async (value) => {
      live(flight, working)
      await input.grants.synchronize()
      live(flight, working)
      return value
    })
  }

  function wait(flight: Flight, ms: number) {
    live(flight)
    return new Promise<void>((resolve, reject) => {
      const cancel = () => {
        time.clearTimeout(timer)
        flight.cleanups.delete(cancel)
        reject(flight.abort.signal.reason ?? new ComputerError("stopped", "This computer request was cancelled."))
      }
      const timer = time.setTimeout(() => {
        flight.cleanups.delete(cancel)
        resolve()
      }, ms)
      flight.cleanups.add(cancel)
    }).then(() => live(flight))
  }

  async function barrier(flight: Flight, metadata?: Computer.ComputerPartMetadata) {
    live(flight)
    await input.grants.synchronize()
    live(flight)
    if (["access", "prepareOpen", "listApps"].includes(flight.command) && input.controller.state().phase === "asking") {
      await input.overlay.ready()
      live(flight, false)
      return
    }
    await input.controller.beforeStep(flight.scope!, metadata)
    live(flight)
  }

  async function native<T>(flight: Flight, callback: () => Promise<T>) {
    live(flight)
    state.native = flight
    try {
      return await callback()
    } finally {
      if (state.native === flight) state.native = undefined
    }
  }

  async function foreground<T>(flight: Flight, app: string, callback: () => Promise<T>): Promise<T> {
    try {
      return await native(flight, callback)
    } catch (error) {
      if (
        !(error instanceof ComputerError) ||
        error.code !== "needs_foreground" ||
        input.controller.state().mode !== "background"
      )
        throw error
      live(flight)
      const current = task(flight.scope!)
      const identity = input.controller.state().apps.find((candidate) => candidate.key === app)
      if (identity)
        await input.controller.setStep(flight.scope!, ComputerMainCopy.foregroundFallback({ app: identity.name }))
      current.foreground.add(app)
      if (input.settings.get().prefs.pointer === "take") {
        await input.controller.setMode("foreground")
        current.borrowed = true
      } else pointerWait(flight, app)
      throw new ComputerError("needs_foreground", "This app needs foreground control before continuing.")
    }
  }

  function enqueue<T>(flight: Flight, callback: () => Promise<T>, working = !OBSERVE.has(flight.command)) {
    const lease = flight.scope!.lease
    const previous = queues.get(lease) ?? Promise.resolve()
    const pending = previous
      .catch(() => {})
      .then(() => {
        live(flight, working)
        flight.started = true
        return callback()
      })
    queues.set(lease, pending)
    void pending
      .finally(() => {
        if (queues.get(lease) === pending) queues.delete(lease)
      })
      .catch(() => {})
    return pending
  }

  function launchPathFloor(file: string) {
    if (ComputerSensitive.protectedDocument(file, input) || input.documentProtected?.(file))
      throw new ComputerError("blocked", `${Hands.NAME} cannot open that target.`)
  }

  async function canonicalLaunchPath(flight: Flight, file: string) {
    // Refuse both spellings before the native resolver can read or fingerprint an artifact.
    launchPathFloor(file)
    const canonical = await after(flight, input.canonicalPath(file))
    if (!canonical) throw new ComputerError("app_not_found", "That target could not be resolved.")
    launchPathFloor(canonical)
    return canonical
  }

  async function resolve(flight: Flight, query: OpenTarget, installed = true): Promise<Computer.HelperApp> {
    live(flight)
    if ("path" in query) {
      const canonical = await canonicalLaunchPath(flight, query.path)
      const resolution = await after(flight, input.backend.resolveLaunch(canonical))
      if (resolution.kind === "protected") throw new ComputerError("blocked", `${Hands.NAME} cannot open that target.`)
      if (resolution.kind !== "app") throw new ComputerError("not_granted", "Prepare this program before opening it.")
      const apps = await after(flight, input.backend.apps({ installed }))
      const running = apps.find((app) => sameIdentity(app.identity, resolution.identity))
      return running ?? { identity: resolution.identity, active: false, windows: [] }
    }
    const apps = await after(flight, input.backend.apps({ installed }))
    const matches = apps.filter((app) =>
      "key" in query
        ? Computer.appKey(app.identity) === query.key
        : app.identity.name.toLocaleLowerCase() === query.name.toLocaleLowerCase(),
    )
    if (matches.length !== 1)
      throw new ComputerError(
        "app_not_found",
        matches.length ? "That app name is ambiguous." : "That app could not be found.",
      )
    return matches[0]!
  }

  function appAccess(scope: SessionScope, identity: Computer.AppIdentity, extra?: AppGrants) {
    return input.settings.access(identity, { ...input.grants.grants(scope), ...extra })
  }

  function programFloor(
    flight: Flight,
    identities: readonly Computer.AppIdentity[],
    program?: Computer.ProgramLaunch,
    handler?: Computer.AppIdentity,
  ) {
    live(flight)
    const settings = input.settings.get()
    if (!settings.prefs.enabled || !settings.policy.enabled)
      throw new ComputerError("blocked", `${Hands.NAME} is turned off.`)
    if (
      !Number.isSafeInteger(settings.prefs.consentedAt) ||
      !settings.prefs.consentedAt ||
      settings.prefs.consentedAt <= 0
    )
      throw new ComputerError("not_granted", `${Hands.NAME} needs your approval.`)
    if (program && input.grants.grants(flight.scope!).denied?.has(program.key))
      throw new ComputerError("not_granted", "This program was denied for this conversation.")
    for (const identity of [...identities, ...(handler ? [handler] : [])]) {
      const verdict = appAccess(flight.scope!, identity)
      if (["never", "blocked", "company-deny"].includes(verdict.verdict))
        throw new ComputerError("blocked", `${Hands.NAME} cannot open that target.`)
      if (verdict.verdict === "denied")
        throw new ComputerError("not_granted", "That app was denied for this conversation.")
    }
    if (program && !identities.length && settings.policy.defaultAccess === "deny")
      throw new ComputerError("blocked", "Your company does not allow this program.")
  }

  async function programCeiling(flight: Flight, program: Computer.ProgramLaunch, handler?: Computer.AppIdentity) {
    programFloor(flight, [], undefined, handler)
    const apps = await after(flight, input.backend.apps({ installed: true }))
    const fs = program.platform === "windows" ? path.win32 : path.posix
    const normalize = (file: string) =>
      program.platform === "windows" ? fs.normalize(file).toLowerCase() : fs.normalize(file)
    const identities = (
      await Promise.all(
        apps.map(async (app) => {
          if (app.identity.platform !== program.platform) return undefined
          const file =
            app.identity.platform === "macos"
              ? app.identity.path
              : app.identity.platform === "windows"
                ? app.identity.exe
                : undefined
          if (!file) return undefined
          const canonical =
            normalize(file) === normalize(program.path) ? file : await after(flight, input.canonicalPath(file))
          return canonical && normalize(canonical) === normalize(program.path) ? app.identity : undefined
        }),
      )
    ).filter((identity) => identity !== undefined)
    programFloor(flight, identities, program, handler)
    return identities
  }

  async function access(flight: Flight, identity: Computer.AppIdentity, level: Computer.AskLevel = "observe") {
    live(flight)
    const verdict = appAccess(flight.scope!, identity)
    if (verdict.verdict === "never" || verdict.verdict === "blocked" || verdict.verdict === "company-deny")
      throw new ComputerError("blocked", `${Hands.NAME} cannot use that app.`)
    if (verdict.verdict !== "granted" || (level === "interact" && verdict.level !== "interact"))
      throw new ComputerError("not_granted", "That app needs your approval.")
    return verdict
  }

  async function approved(flight: Flight) {
    const apps = await after(flight, input.backend.apps())
    return apps.filter((app) => appAccess(flight.scope!, app.identity).verdict === "granted").map((app) => app.identity)
  }

  function displayFor(displays: readonly Computer.DisplayInfo[], rect: Computer.Rect) {
    return displays.reduce(
      (best, display) => (overlap(display.bounds, rect) > overlap(best.bounds, rect) ? display : best),
      displays.find((display) => display.primary) ?? displays[0]!,
    )
  }

  function toDip(rect: Computer.Rect, display: string) {
    if (input.backend.kind !== "local-windows") return { ...rect }
    if (!input.registry.toDip) throw new ComputerError("unavailable", "The Windows display transform is unavailable.")
    return input.registry.toDip(rect, display)
  }

  async function inspect(flight: Flight, hit: Computer.HitResult): Promise<Computer.InspectResult> {
    live(flight)
    const signals = { ...input.signals?.(hit), ...hit.signals }
    const category = ComputerApps.category(hit.owner, signals)
    if (ComputerApps.isNever(category) || category === "system-ui")
      throw new ComputerError("protected", "That window is protected.")
    await access(flight, hit.owner)
    if (hit.owner.platform === "remote" || !hit.owner.pid)
      throw new ComputerError("changed", "The app no longer has a live process.")
    const clipboard = await after(flight, readClipboard(flight.scope!))
    const document = hit.document ? await after(flight, input.canonicalPath(hit.document)) : undefined
    const programPath = hit.programPath ? await after(flight, input.canonicalPath(hit.programPath)) : undefined
    await access(flight, hit.owner)
    return {
      app: hit.owner,
      category,
      pid: hit.owner.pid,
      window: { id: hit.windowId, ...(hit.windowTitle ? { title: hit.windowTitle } : {}) },
      element: {
        role: hit.role,
        ...(input.registry.uiRef(flight.scope!, hit) ? { ref: input.registry.uiRef(flight.scope!, hit) } : {}),
        ...(hit.elementId ? { elementId: hit.elementId } : {}),
        ...(hit.name === undefined ? {} : { label: hit.name }),
        secure: hit.secure,
        enabled: hit.enabled === true,
        editable: hit.editable === true,
      },
      clipboard: {
        agentOwned: clipboard.agentOwned,
        ...(!ComputerCredential.secret(clipboard.text) && clipboard.text.length <= Computer.LIMITS.typeTextChars
          ? { text: clipboard.text }
          : {}),
      },
      ...(document ? { document } : {}),
      ...(programPath ? { programPath } : {}),
      ...(hit.documentStatus ? { documentStatus: hit.documentStatus } : {}),
      ...(hit.layout ? { layout: hit.layout } : {}),
      ...(hit.focusedMenuShortcuts ? { focusedMenuShortcuts: hit.focusedMenuShortcuts } : {}),
      ...(hit.elevated ? { elevated: true } : {}),
    }
  }

  async function capture(
    flight: Flight,
    target: Target,
    budget: Computer.CaptureBudget,
    format: "jpeg" | "png" = "jpeg",
    zoom?: Computer.CaptureRequest["zoom"],
  ) {
    await barrier(flight, { action: zoom ? "zoom" : "screenshot" })
    const identities = await approved(flight)
    await barrier(flight)
    const phase = input.controller.nativePhase(flight.scope!)
    const checkPhase = () => {
      const current = input.controller.nativePhase(flight.scope!)
      if (current.sessionId !== phase.sessionId || current.phaseRevision !== phase.phaseRevision)
        throw new ComputerError("changed", "The computer changed during the screenshot.")
    }
    const result = await native(flight, () =>
      input.backend.capture(
        {
          op: "capture",
          target,
          budget,
          format,
          ...(format === "jpeg" ? { quality: Computer.LIMITS.jpegQuality } : {}),
          ...(zoom ? { zoom } : {}),
        },
        Computer.LIMITS.captureMs,
      ),
    )
    await input.grants.synchronize()
    live(flight)
    checkPhase()
    if (zoom) {
      if (result.bytes.byteLength !== result.header.imageBytes)
        throw new ComputerError("capture_unavailable", "The zoom image is incomplete.")
      const image = `data:${imageMime(result.bytes)};base64,${Buffer.from(result.bytes).toString("base64")}`
      if (!Schema.is(Computer.ImageData)(image))
        throw new ComputerError("frame_too_large", "The zoom image exceeds the response limit.")
      return { image }
    }
    const shot = await after(
      flight,
      input.registry.add(flight.scope!, { ...result, target, approved: identities, phase, budget }),
    )
    checkPhase()
    if (input.backend.capabilities().actions.includes("cursor_position")) {
      const cursor = await after(flight, input.backend.cursorPosition())
      checkPhase()
      try {
        return { ...shot, pointer: input.registry.pixel(flight.scope!, shot.frame, cursor) }
      } catch (error) {
        if (!(error instanceof ComputerError) || !["stale_frame", "out_of_bounds"].includes(error.code)) throw error
      }
    }
    return shot
  }

  async function prepareOpen(flight: Flight, target: OpenTarget) {
    await barrier(flight, { action: "open_app" })
    const app = "path" in target ? undefined : await resolve(flight, target)
    if (app) {
      programFloor(flight, [app.identity])
      const running = (await after(flight, input.backend.apps())).find((candidate) =>
        sameIdentity(candidate.identity, app.identity),
      )
      if (running) return { kind: "app" as const, identity: running.identity }
    }
    const file =
      "path" in target
        ? target.path
        : app!.identity.platform === "macos"
          ? app!.identity.path
          : app!.identity.platform === "windows"
            ? app!.identity.exe
            : undefined
    if (!file) {
      if (app?.identity.verified) return { kind: "app" as const, identity: app.identity }
      throw new ComputerError("app_not_found", "The installed artifact path is unavailable.")
    }
    const canonical = await canonicalLaunchPath(flight, file)
    const resolved = await after(flight, input.backend.resolveLaunch(canonical))
    if (resolved.kind === "protected") throw new ComputerError("blocked", `${Hands.NAME} cannot open that target.`)
    if (resolved.kind === "app") return resolved
    const program = ComputerProgram.publicLaunch(resolved.program)
    if (!ComputerProgram.valid(program))
      throw new ComputerError("changed", "The program identity could not be verified.")
    await programCeiling(flight, program, resolved.program.handler)
    const current = task(flight.scope!)
    if (!current.programs.has(program.key) && current.programs.size >= 1000)
      throw new ComputerError("unavailable", "Too many program preparations are pending.")
    current.programs.set(program.key, structuredClone(program))
    return { kind: "program" as const, program }
  }

  async function programOpen(flight: Flight, requested: Computer.ProgramLaunch, requestID?: string) {
    const current = task(flight.scope!)
    const previous = current.programs.get(requested.key)
    if (!previous || !ComputerProgram.same(previous, requested))
      throw new ComputerError("not_granted", "Prepare this program before opening it.")
    await programCeiling(flight, previous)
    await barrier(flight, { action: "open_app" })
    const canonical = await canonicalLaunchPath(flight, previous.path)
    if (canonical !== previous.path)
      throw new ComputerError("changed", "The program changed before it could be opened.")
    const resolved = await after(flight, input.backend.resolveLaunch(canonical))
    if (resolved.kind !== "program")
      throw new ComputerError("changed", "The program changed before it could be opened.")
    const program = ComputerProgram.publicLaunch(resolved.program)
    const identities = await programCeiling(flight, program, resolved.program.handler)
    if (!ComputerProgram.same(previous, program)) {
      if (!current.programs.has(program.key) && current.programs.size >= 1000)
        throw new ComputerError("unavailable", "Too many program preparations are pending.")
      current.programs.set(program.key, structuredClone(program))
      return { pending: { kind: "sensitive" as const, why: "run_program" as const, program } }
    }
    await input.grants.synchronize()
    if (requestID) await input.grants.waitForReply(requestID, flight.scope!)
    live(flight)
    if (!requestID || !input.grants.consumeProgram(requestID, flight.scope!, program, false))
      return { pending: { kind: "sensitive" as const, why: "run_program" as const, program } }
    if (input.controller.state().mode === "background") {
      if (input.settings.get().prefs.pointer === "take") {
        await input.controller.setMode("foreground")
        current.borrowed = true
      } else pointerWait(flight, program.key)
      throw new ComputerError("needs_foreground", "Running a program needs foreground control.")
    }
    const phase = input.controller.nativePhase(flight.scope!)
    programFloor(flight, identities, program, resolved.program.handler)
    if (!input.grants.consumeProgram(requestID, flight.scope!, program))
      throw new ComputerError("not_granted", "This program approval has already been used.")
    await native(flight, () => input.backend.launchProgram(resolved.program, phase))
    live(flight)
    current.programs.delete(program.key)
    current.launched.add(program.key)
    input.registry.clear(flight.scope!)
    input.controller.didStep(flight.scope!)
    return { program, launched: true as const }
  }

  async function gate(flight: Flight, request: Act, index: number): Promise<GateContext> {
    const scope = flight.scope!
    const step = request.steps[index]!
    const frame = request.frame && step.kind !== "wait" ? input.registry.frame(scope, request.frame) : undefined
    const point =
      frame && step.kind === "scroll" && !step.at
        ? input.registry.pixel(scope, frame, await after(flight, input.backend.cursorPosition()))
        : undefined
    return {
      scope,
      backend: {
        hitTest: (id, x, y) => input.backend.hitTest(input.registry.captureId(scope, id), x, y),
        focused: () => input.backend.focused(),
        apps: (query) => input.backend.apps(query),
        input: (op, deadline) => input.backend.input(op, deadline),
      },
      settings: input.settings,
      grants: {
        ...input.grants,
        isActive: (value) =>
          input.grants.isActive(value) && input.controller.isActive(value) && !flight.abort.signal.aborted,
      },
      index,
      allowedApps: request.allowedApps,
      approvals: request.approvals,
      frame,
      ...(point ? { point } : {}),
      frameCurrent: (current, hit) => input.registry.current(scope, current, hit),
      resolveRef: (ref) => input.registry.resolve(scope, ref),
      uiRef: (hit) => input.registry.uiRef(scope, hit),
      clipboard: () => readClipboard(scope),
      canonicalPath: input.canonicalPath,
      protectedPaths: input.protectedPaths,
      protectedDirectories: input.protectedDirectories,
      documentProtected: input.documentProtected,
      signals: input.signals,
      beforeInput: (hit) => {
        live(flight)
        input.beforeInput?.(scope, hit)
        live(flight)
      },
    }
  }

  async function cursor(flight: Flight, step: Computer.Step, frame?: Computer.Frame, fallback?: Computer.Point) {
    const point =
      step.kind === "drag"
        ? step.path.at(-1)
        : step.kind === "click" && "x" in step.at
          ? step.at
          : step.kind === "move"
            ? step.at
            : step.kind === "scroll"
              ? (step.at ?? fallback)
              : undefined
    if (!point || !frame) {
      await input.overlay.cursor({ kind: "hide", visible: false })
      return false
    }
    const hit = await after(
      flight,
      input.backend.hitTest(input.registry.captureId(flight.scope!, frame.id), point.x, point.y),
    )
    const granted =
      appAccess(flight.scope!, hit.owner).verdict === "granted" &&
      !ComputerApps.isNever(ComputerApps.category(hit.owner, { ...input.signals?.(hit), ...hit.signals }))
    const global = input.registry.point(flight.scope!, frame, point)
    input.overlay.step(global)
    await input.overlay.cursor({
      kind: input.controller.state().mode === "background" ? "ghost" : "ring",
      point: global,
      visible: granted,
    })
    live(flight)
    await input.overlay.ready()
    await barrier(flight)
    return granted
  }

  function pointerWait(flight: Flight, app: string) {
    const current = task(flight.scope!)
    current.foreground.add(app)
    const id = randomUUID()
    current.pointer = { id, app }
    flight.allowPaused = true
    void input.controller
      .pause("pointer", undefined, {
        requestID: id,
        directory: flight.scope!.directory,
        kind: "pointer",
        title: ComputerMainCopy.pause({ reason: "pointer" }),
        canAlways: false,
        shownAt: Date.now(),
      })
      .catch(() => {})
    return { waitId: id, reason: "pointer" as const }
  }

  async function act(flight: Flight, request: Act) {
    let done = 0
    for (let index = 0; index < request.steps.length; index++) {
      live(flight)
      const step = request.steps[index]!
      await barrier(flight, { action: actionOf(step) })
      const ctx = await gate(flight, request, index)
      const cursorDrawn = await cursor(flight, step, ctx.frame, ctx.point)
      live(flight)
      const current = task(flight.scope!)
      if (
        step.kind !== "wait" &&
        current.borrowed &&
        current.initialMode === "background" &&
        input.settings.get().prefs.mode === "background" &&
        input.settings.get().policy.background &&
        input.controller.state().mode === "foreground"
      ) {
        const ref =
          step.kind === "type" ? step.ref : step.kind === "click" && "ref" in step.at ? step.at.ref : undefined
        const point =
          step.kind === "drag"
            ? step.path[0]
            : step.kind === "click" && "x" in step.at
              ? step.at
              : step.kind === "move"
                ? step.at
                : step.kind === "scroll"
                  ? (step.at ?? ctx.point)
                  : undefined
        const hit = ref
          ? await input.registry.resolve(flight.scope!, ref)
          : point && ctx.frame
            ? await input.backend.hitTest(input.registry.captureId(flight.scope!, ctx.frame.id), point.x, point.y)
            : await input.backend.focused()
        live(flight)
        if (!current.foreground.has(Computer.appKey(hit.owner))) {
          await input.controller.setMode("background")
          live(flight)
          throw new ComputerError("paused", "Background control is ready. Inspect the target again before retrying.")
        }
      }
      let targetApp: string | undefined
      const send = async (
        checked: Extract<GateResult, { verdict: "ok"; inspect: Computer.InspectResult }>,
        text?: string,
        fresh?: Computer.HitResult,
      ) => {
        live(flight)
        const hit = fresh ?? checked.hit
        const app = Computer.appKey(hit.owner)
        targetApp = app
        await input.controller.target(flight.scope!, hit.owner)
        live(flight)
        if (input.controller.state().mode === "background" && !cursorDrawn)
          await input.controller.setStep(
            flight.scope!,
            ComputerMainCopy.workingBehind({ app: Computer.clean(hit.owner.name, 256) }),
          )
        if (input.controller.state().mode === "background" && current.foreground.has(app)) {
          if (input.settings.get().prefs.pointer !== "take")
            throw new ComputerError("needs_foreground", "This app needs the real pointer.")
          await input.controller.setMode("foreground")
          current.borrowed = true
          live(flight)
          throw new ComputerError(
            "needs_foreground",
            "Foreground control is ready. Inspect the app again before retrying.",
          )
        }
        const phase = input.controller.nativePhase(flight.scope!)
        const target = witness(hit)
        const binding = { pid: checked.inspect.pid, ...target }
        const captureId = ctx.frame ? input.registry.captureId(flight.scope!, ctx.frame.id) : undefined
        const realPointer =
          input.controller.state().mode === "foreground" &&
          ((step.kind === "click" && "x" in step.at) || ["move", "drag", "scroll"].includes(step.kind))
        if (realPointer) input.overlay.realPointer(true)
        const escape = step.kind === "key" && step.combo.some((key) => /^(esc|escape)$/i.test(key))
        const resumeEsc = escape ? input.suspendEsc?.() : undefined
        try {
          await native(flight, async () => {
            if (step.kind === "type") {
              await input.backend.input(
                { op: "input.type", ...phase, ...binding, text: text ?? step.text },
                Computer.LIMITS.inputStepMs,
              )
              return
            }
            if (step.kind === "key") {
              if (step.holdMs) {
                for (let repeat = 0; repeat < step.repeat; repeat++) {
                  live(flight)
                  await input.backend.input(
                    { op: "input.hold", ...phase, ...binding, combo: step.combo, ms: step.holdMs },
                    step.holdMs + Computer.LIMITS.inputStepMs,
                  )
                }
              } else
                await input.backend.input(
                  { op: "input.key", ...phase, ...binding, combo: step.combo, repeat: step.repeat },
                  Computer.LIMITS.inputStepMs,
                )
              return
            }
            if (step.kind === "wait") {
              await wait(flight, step.ms)
              return
            }
            if (step.kind === "click" && "ref" in step.at) {
              if (!hit.ref || step.button !== "left" || step.count !== 1 || step.modifiers.length)
                throw new ComputerError("unsupported_action", "This control does not support that click.")
              const result = await input.backend.perform(hit.ref, "press", phase, {
                pid: checked.inspect.pid,
                ...(hit.elementId ? { elementId: hit.elementId } : {}),
              })
              if (!result.took) throw new ComputerError("unsupported_action", "That control could not be pressed.")
              return
            }
            if (!captureId) throw new ComputerError("stale_frame", "Capture the desktop before using coordinates.")
            if (step.kind === "click")
              await input.backend.input(
                {
                  op: "input.click",
                  ...phase,
                  ...target,
                  captureId,
                  ...(step.at as Computer.Point),
                  button: step.button,
                  count: step.count,
                  modifiers: step.modifiers,
                },
                Computer.LIMITS.inputStepMs,
              )
            if (step.kind === "move")
              await input.backend.input(
                { op: "input.move", ...phase, ...target, captureId, ...step.at },
                Computer.LIMITS.inputStepMs,
              )
            if (step.kind === "drag")
              await input.backend.input(
                {
                  op: "input.drag",
                  ...phase,
                  captureId,
                  path: step.path,
                  targets: checked.hits.map(witness),
                  button: "left",
                  modifiers: step.modifiers,
                },
                Computer.LIMITS.inputStepMs,
              )
            if (step.kind === "scroll") {
              const point = checked.point ?? step.at
              if (!point) throw new ComputerError("stale_frame", "Inspect a scroll target before scrolling.")
              await input.backend.input(
                {
                  op: "input.scroll",
                  ...phase,
                  ...target,
                  captureId,
                  ...point,
                  dx: step.dx,
                  dy: step.dy,
                  ...(step.unit ? { unit: step.unit } : {}),
                },
                Computer.LIMITS.inputStepMs,
              )
            }
          })
          live(flight)
          return true
        } finally {
          if (realPointer) input.overlay.realPointer(false)
          if (typeof resumeEsc === "function") resumeEsc()
          else if (escape) input.resumeEsc?.()
        }
      }
      let checked: GateResult
      try {
        if (step.kind === "type")
          checked = await typeChecked(step, ctx, async (text, inspect, hit) => {
            await send({ verdict: "ok", inspect, hit, hits: [hit] }, text, hit)
          })
        else {
          checked = await checkStep(step, ctx)
          if (checked.verdict === "ok") {
            if (checked.waiting) await wait(flight, step.kind === "wait" ? step.ms : 0)
            else await send(checked)
          }
        }
      } catch (error) {
        if (
          error instanceof ComputerError &&
          error.code === "needs_foreground" &&
          input.controller.state().mode === "background"
        ) {
          if (!targetApp) throw error
          const app = targetApp
          const identity = input.controller.state().apps.find((candidate) => candidate.key === app)
          if (identity)
            await input.controller.setStep(flight.scope!, ComputerMainCopy.foregroundFallback({ app: identity.name }))
          current.foreground.add(app)
          if (input.settings.get().prefs.pointer === "take") {
            await input.controller.setMode("foreground")
            current.borrowed = true
            throw new ComputerError(
              "needs_foreground",
              "The app switched to foreground control. Inspect it again before retrying.",
            )
          }
          const waiting = await pointerWait(flight, app)
          return { done, state: input.controller.state(), waiting }
        }
        throw error
      }
      live(flight)
      if (checked.verdict === "refuse")
        throw new ComputerError(checked.code, "This computer step could not be performed.")
      if (checked.verdict === "pending")
        return {
          done,
          state: input.controller.state(),
          pending: {
            index,
            kind: checked.kind,
            ...(checked.why ? { why: checked.why } : {}),
            inspect: checked.inspect,
          },
        }
      done++
      input.controller.didStep(flight.scope!)
    }
    if (request.settleMs) await wait(flight, request.settleMs)
    return { done, state: input.controller.state() }
  }

  function cancelFlight(flight: Flight, code: "stopped" | "timeout" | "paused" = "stopped") {
    if (flight.abort.signal.aborted) return
    flight.abort.abort(
      new ComputerError(
        code,
        code === "timeout" ? "The computer request timed out." : "This computer request was cancelled.",
      ),
    )
    for (const cleanup of [...flight.cleanups]) cleanup()
    flight.cleanups.clear()
    if (flight.command === "acquire") input.controller.cancelAcquire(flight.key)
    if (flight.scope && flight.command === "act" && flight.started && input.controller.isActive(flight.scope))
      void input.controller.updateGrants().catch(() => {})
    else if (state.native === flight) {
      void input.backend.cancel().catch(() => {})
      void input.backend.releaseAll().catch(() => {})
    }
  }

  async function dispatch(request: Computer.BridgeRequest, flight: Flight): Promise<unknown> {
    const key = flight.key
    if (request.command === "status") {
      const hello = await input.backend.hello()
      const permissions = await input.backend.permissions()
      const displays = await input.backend.displays()
      live(flight, false)
      return {
        platform: hello.helper.platform,
        backendVersion: hello.helper.version,
        permissions: { screen: permissions.screen, accessibility: permissions.accessibility },
        displays: displays.map((display, index) => ({
          id: display.id,
          name: `Display ${index + 1}`,
          bounds: toDip(display.bounds, display.id),
          scale: display.scale,
          primary: display.primary,
        })),
        mode: input.controller.state().mode,
      }
    }
    if (request.command === "acquire") return input.controller.acquire(request, key)
    if (request.command === "cancel" && request.lease === undefined) {
      for (const other of flights.values())
        if (
          other.command === "acquire" &&
          other.key.rootSessionID === key.rootSessionID &&
          other.key.sessionID === key.sessionID &&
          other.key.directory === key.directory
        )
          cancelFlight(other)
      input.controller.cancelQueued(key)
      return { ok: true }
    }
    flight.scope = scoped(key, request)
    task(flight.scope)
    if (request.command === "heartbeat") return input.controller.heartbeat(flight.scope)
    if (request.command === "release") {
      await input.controller.release(flight.scope)
      input.registry.clear(flight.scope)
      tasks.delete(flight.scope.lease)
      return { ok: true }
    }
    if (request.command === "cancel") {
      for (const other of flights.values())
        if (
          other !== flight &&
          other.command === "act" &&
          other.scope?.lease === flight.scope.lease &&
          (!request.requestId || String(other.key.id) === request.requestId)
        )
          cancelFlight(other)
      return { ok: true }
    }
    if (request.command === "awaitControl") {
      const pointerId =
        request.waitId ?? (input.controller.state().pause === "pointer" ? task(flight.scope!).pointer?.id : undefined)
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          flight.cleanups.delete(cancel)
          time.clearTimeout(timer)
          unsubscribe()
          controlWaiters.delete(check)
        }
        const done = (result: "resumed" | "stopped" | "declined" | "pending") => {
          cleanup()
          resolve({ result })
        }
        const cancel = () => {
          cleanup()
          reject(flight.abort.signal.reason ?? new ComputerError("stopped", "This computer wait was cancelled."))
        }
        const check = () => {
          if (flight.abort.signal.aborted) return cancel()
          try {
            live(flight, false)
          } catch {
            return done("stopped")
          }
          const pointer = task(flight.scope!).pointer
          if (pointerId) {
            if (!pointer || pointer.id !== pointerId) return done("stopped")
            if (pointer.result) return done(pointer.result)
          } else if (input.controller.isActive(flight.scope!)) return done("resumed")
        }
        const timer = time.setTimeout(() => done("pending"), Computer.LIMITS.longPollMs)
        const unsubscribe = input.controller.subscribe(check)
        controlWaiters.add(check)
        flight.cleanups.add(cancel)
        check()
      })
    }
    if (request.command === "grant" || request.command === "remember") {
      await input.grants.synchronize()
      const actual = await resolve(flight, { key: Computer.appKey(request.identity) })
      live(flight)
      if (request.command === "remember") {
        flight.durable = true
        return { saved: await input.grants.remember(flight.scope, actual.identity, request.requestID) }
      }
      if (!(await input.grants.grant(flight.scope, actual.identity, request.level, request.requestID)))
        throw new ComputerError("not_granted", "That app approval is not current.")
      await input.controller.updateGrants()
      const view = input.controller.state()
      if (view.phase === "asking" && view.ask?.kind === "app" && view.ask.requestID === request.requestID)
        await input.controller.transition("working")
      live(flight)
      return { ok: true }
    }
    if (request.command === "access") {
      await barrier(flight)
      const app = await resolve(flight, request.app)
      const location =
        app.identity.platform === "macos"
          ? app.identity.path
          : app.identity.platform === "windows"
            ? app.identity.exe
            : undefined
      const root = location ? await after(flight, input.canonicalPath(flight.scope.directory)) : undefined
      const canonical = location ? await after(flight, input.canonicalPath(location)) : undefined
      const relative = root && canonical ? nativePath(input.backend.kind).relative(root, canonical) : undefined
      const ownBuild =
        relative !== undefined &&
        relative !== ".." &&
        !relative.startsWith(`..${nativePath(input.backend.kind).sep}`) &&
        !nativePath(input.backend.kind).isAbsolute(relative)
          ? { repo: flight.scope.directory }
          : undefined
      return {
        identity: app.identity,
        category: ComputerApps.category(app.identity),
        ...appAccess(flight.scope, app.identity, {
          ...(request.liftDeny ? { liftDeny: true } : {}),
          ...(ownBuild ? { ownBuild } : {}),
        }),
      }
    }
    const pending = input.controller.state().ask
    if (pending?.kind === "sensitive") {
      const requestID =
        request.command === "act"
          ? request.approvals?.find((approval) => approval.requestID === pending.requestID)?.requestID
          : request.command === "openApp"
            ? request.requestID
            : undefined
      if (requestID === pending.requestID) {
        await input.grants.waitForReply(requestID, flight.scope!)
        live(flight, false)
      }
    }
    const view = input.controller.state()
    if (view.phase === "asking" && view.ask?.kind === "sensitive") {
      const answered =
        request.command === "act"
          ? request.approvals?.some(
              (approval) =>
                approval.requestID === view.ask!.requestID &&
                !!input.grants.peekSensitive(approval.requestID, flight.scope!),
            )
          : request.command === "openApp" &&
            "program" in request.app &&
            request.requestID === view.ask.requestID &&
            input.grants.consumeProgram(request.requestID, flight.scope, request.app.program, false)
      if (answered) await input.controller.transition("working")
    }
    return enqueue(
      flight,
      async () => {
        if (request.command === "prepareOpen") return prepareOpen(flight, request.app)
        if (request.command === "openApp") {
          if ("program" in request.app) return programOpen(flight, request.app.program, request.requestID)
          const prepared = await prepareOpen(flight, request.app)
          if (prepared.kind === "program") return programOpen(flight, prepared.program, request.requestID)
          await barrier(flight, { action: "open_app" })
          const app = await resolve(flight, { key: Computer.appKey(prepared.identity) })
          await access(flight, app.identity, "interact")
          const running = (await after(flight, input.backend.apps())).some((candidate) =>
            sameIdentity(candidate.identity, app.identity),
          )
          await input.controller.target(flight.scope!, app.identity)
          const phase = input.controller.nativePhase(flight.scope!)
          await foreground(flight, Computer.appKey(app.identity), () =>
            running ? input.backend.activate(app.identity, phase) : input.backend.launch(app.identity, phase),
          )
          live(flight)
          const actual = await resolve(flight, { key: Computer.appKey(app.identity) })
          if (!running) task(flight.scope!).launched.add(Computer.appKey(actual.identity))
          input.registry.clear(flight.scope!)
          input.controller.didStep(flight.scope!)
          return { identity: actual.identity, launched: !running }
        }
        if (request.command === "focusWindow") {
          await barrier(flight, { action: "focus_window" })
          const app = await resolve(flight, request.app, false)
          await access(flight, app.identity, "interact")
          const window = request.window
            ? app.windows.find((window) => window.windowId === request.window)
            : app.windows.find((window) => !window.minimized)
          if (!window) throw new ComputerError("app_not_found", "That app window could not be found.")
          await input.controller.target(flight.scope!, app.identity)
          await foreground(flight, Computer.appKey(app.identity), () =>
            input.backend.focusWindow(window.windowId, input.controller.nativePhase(flight.scope!)),
          )
          live(flight)
          input.registry.clear(flight.scope!)
          input.controller.didStep(flight.scope!)
          return { ok: true }
        }
        if (request.command === "listApps") {
          await barrier(flight, { action: "list_apps" })
          const apps = await after(flight, input.backend.apps({ installed: request.installed }))
          const running = new Set(
            (await after(flight, input.backend.apps())).map((app) => Computer.appKey(app.identity)),
          )
          const displays = await after(flight, input.backend.displays())
          return {
            apps: apps
              .filter(
                (app) =>
                  !request.query || app.identity.name.toLocaleLowerCase().includes(request.query.toLocaleLowerCase()),
              )
              .map((app) => {
                const verdict = appAccess(flight.scope!, app.identity)
                return {
                  identity: app.identity,
                  name: app.identity.name,
                  running: running.has(Computer.appKey(app.identity)),
                  frontmost: app.active,
                  category: ComputerApps.category(app.identity),
                  verdict: verdict.verdict,
                  ...(verdict.verdict === "granted" && displays.length
                    ? {
                        windows: app.windows.map((window) => {
                          const display = displayFor(displays, window.bounds)
                          return {
                            id: window.windowId,
                            title: window.title,
                            bounds: toDip(window.bounds, display.id),
                            display: display.id,
                          }
                        }),
                      }
                    : {}),
                }
              }),
          }
        }
        if (request.command === "screenshot") {
          await barrier(flight)
          const scope = request.scope
          if ("app" in scope) {
            const app = await resolve(flight, scope.app, false)
            await access(flight, app.identity)
            const window = scope.window
              ? app.windows.find((window) => window.windowId === scope.window)
              : app.windows.find((window) => !window.minimized)
            if (!window) throw new ComputerError("app_not_found", "That app has no capturable window.")
            return capture(flight, { windowId: window.windowId }, request.budget, request.format)
          }
          const displays = await after(flight, input.backend.displays())
          const display = scope.display
            ? displays.find((display) => display.id === scope.display)
            : (displays.find((display) => display.primary) ?? displays[0])
          if (!display) throw new ComputerError("out_of_bounds", "That display is unavailable.")
          return capture(flight, { display: display.id }, request.budget, request.format)
        }
        if (request.command === "zoom") {
          const frame = input.registry.frame(flight.scope!, request.frame)
          const target =
            frame.scope === "window" && frame.windowId ? { windowId: frame.windowId } : { display: frame.display }
          const result = await capture(flight, target, request.budget, "png", {
            captureId: input.registry.captureId(flight.scope!, frame.id),
            region: request.region,
          })
          return { image: result.image }
        }
        if (request.command === "inspect") {
          await barrier(flight)
          if ((request.x === undefined) !== (request.y === undefined))
            throw new ComputerError("out_of_bounds", "Inspect needs both coordinates.")
          const frame = request.frame ? input.registry.frame(flight.scope!, request.frame) : undefined
          const point =
            request.x !== undefined && request.y !== undefined
              ? { x: request.x, y: request.y }
              : frame && !request.focus && !request.ref
                ? input.registry.pixel(flight.scope!, frame, await after(flight, input.backend.cursorPosition()))
                : undefined
          if (request.frame && !request.focus && !request.ref && !point)
            throw new ComputerError("stale_frame", "Move to a verified point before using the current pointer.")
          const hit = request.ref
            ? await after(flight, input.registry.resolve(flight.scope!, request.ref))
            : point
              ? await after(
                  flight,
                  input.backend.hitTest(input.registry.captureId(flight.scope!, request.frame ?? ""), point.x, point.y),
                )
              : await after(flight, input.backend.focused())
          return inspect(flight, hit)
        }
        if (request.command === "readUi") {
          await barrier(flight, { action: "read_ui" })
          const app = await resolve(flight, request.app, false)
          await access(flight, app.identity)
          const window = request.window
            ? app.windows.find((window) => window.windowId === request.window)
            : app.windows.find((window) => !window.minimized)
          if (!window) throw new ComputerError("app_not_found", "That app window could not be found.")
          const phase = input.controller.nativePhase(flight.scope!)
          const result = await after(
            flight,
            input.backend.tree(
              { op: "ui.tree", windowId: window.windowId, maxNodes: Computer.LIMITS.readUiNodesMax, maxDepth: 30 },
              Computer.LIMITS.uiTreeMs,
            ),
          )
          const frame = input.registry.latest(flight.scope!)
          const nodes = await input.registry.tree(flight.scope!, result, frame, phase)
          live(flight)
          return {
            nodes: nodes
              .filter(
                (node) =>
                  !request.query ||
                  `${node.name ?? ""} ${node.role}`.toLocaleLowerCase().includes(request.query.toLocaleLowerCase()),
              )
              .slice(0, request.limit)
              .map((node) => (node.secure ? { ...node, value: undefined } : node)),
          }
        }
        if (request.command === "act") return act(flight, request)
        if (request.command === "handoff") {
          live(flight, request.phase !== "end")
          if (request.phase === "start") input.registry.clear(flight.scope!)
          await input.controller.transition(request.phase === "start" ? "handoff" : "working")
          return { ok: true }
        }
        throw new ComputerError("unsupported_action", "This computer command is unavailable.")
      },
      request.command === "handoff" && request.phase === "end" ? false : !OBSERVE.has(flight.command),
    )
  }

  const unsubscribe = input.controller.subscribe((view) => {
    const previous = state.view
    state.view = view
    for (const [lease, current] of tasks) {
      try {
        input.controller.scope(current.scope)
      } catch {
        input.registry.clear(current.scope)
        tasks.delete(lease)
      }
      if (
        lease === view.lease &&
        ((view.phase === "paused" && previous?.phase !== "paused") ||
          (previous?.lease === lease && previous.mode !== view.mode))
      )
        input.registry.clear(current.scope)
    }
    for (const flight of flights.values()) {
      if (!flight.scope) continue
      try {
        input.controller.scope(flight.scope)
      } catch {
        if (flight.command !== "release" && !flight.durable) cancelFlight(flight)
        continue
      }
      if (flight.command === "act" && flight.started && !flight.allowPaused && view.phase !== "working")
        cancelFlight(flight, "paused")
    }
  })

  const executor: ComputerExecutor = {
    run<R extends Computer.BridgeRequest>(request: R, key: ComputerBridgeKey): Promise<BridgeResponse<R["command"]>> {
      if (state.closed) return Promise.reject(new ComputerError("unavailable", "The computer executor is closed."))
      if (
        request.command !== key.command ||
        request.rootSessionID !== key.rootSessionID ||
        request.sessionID !== key.sessionID ||
        request.directory !== key.directory
      )
        return Promise.reject(new ComputerError("failed", "The computer request scope is invalid."))
      if ("lease" in request && request.lease !== undefined && request.lease !== key.lease)
        return Promise.reject(new ComputerError("failed", "The computer request lease is invalid."))
      const existing = flights.get(key)
      if (existing) return existing.promise as Promise<BridgeResponse<R["command"]>>
      if (flights.size >= 1000)
        return Promise.reject(new ComputerError("busy", "Too many computer requests are pending."))
      const flight: Flight = {
        key,
        command: request.command,
        abort: new AbortController(),
        started: false,
        cleanups: new Set(),
      }
      flights.set(key, flight)
      if (request.command === "act") {
        const timer = time.setTimeout(() => cancelFlight(flight, "timeout"), actDeadline(request))
        flight.cleanups.add(() => time.clearTimeout(timer))
      }
      const aborted = new Promise<never>((_resolve, reject) => {
        const cancel = () => reject(flight.abort.signal.reason)
        flight.abort.signal.addEventListener("abort", cancel, { once: true })
        flight.cleanups.add(() => flight.abort.signal.removeEventListener("abort", cancel))
      })
      flight.promise = Promise.race([dispatch(request, flight), aborted])
        .catch((error) => {
          if (flight.abort.signal.aborted) throw flight.abort.signal.reason
          throw error
        })
        .finally(() => {
          for (const cleanup of flight.cleanups) cleanup()
          flight.cleanups.clear()
          if (flights.get(key) === flight) flights.delete(key)
        })
      return flight.promise as Promise<BridgeResponse<R["command"]>>
    },
    cancel(key) {
      const flight = flights.get(key)
      if (flight) cancelFlight(flight)
    },
  }

  return {
    ...executor,
    async control(action: Computer.OverlayAction, requestID?: string) {
      if (action === "stop") {
        await input.controller.stop()
        return true
      }
      if (action === "takeover") {
        await input.controller.pause("button")
        return true
      }
      if (action === "resume") {
        await input.controller.resume()
        return true
      }
      const current = input.controller.state()
      const taskState = tasks.get(current.lease)
      if (action === "hand-over" || action === "not-now") {
        const pointer = taskState?.pointer
        if (!pointer || pointer.id !== requestID || current.ask?.requestID !== requestID) return false
        if (action === "not-now") {
          pointer.result = "declined"
          for (const wake of controlWaiters) wake()
          await input.controller.resume()
          input.controller.scope(taskState!.scope)
          return true
        }
        await input.controller.setMode("foreground")
        input.controller.scope(taskState!.scope)
        await input.controller.resume()
        input.controller.scope(taskState!.scope)
        pointer.result = "resumed"
        taskState!.borrowed = true
        for (const wake of controlWaiters) wake()
        return true
      }
      if (action === "continue" && current.phase === "handoff" && current.ask?.requestID === requestID) {
        await input.controller.transition("working")
        return true
      }
      return false
    },
    async writeClipboard(scope: SessionScope, text: string) {
      if (!input.clipboard.writeText) throw new ComputerError("unsupported_action", "Clipboard writes are unavailable.")
      await input.controller.beforeStep(scope)
      const phase = input.controller.nativePhase(scope)
      if (ComputerCredential.secret(text)) throw new ComputerError("secure_field", "That text contains a secret.")
      await input.clipboard.writeText(text, phase)
      const latest = input.controller.nativePhase(scope)
      if (latest.sessionId !== phase.sessionId || latest.phaseRevision !== phase.phaseRevision)
        throw new ComputerError("changed", "The computer task changed during the clipboard write.")
      task(scope).clipboardHash = hash(text)
    },
    disconnect() {
      for (const flight of flights.values()) cancelFlight(flight)
      input.controller.disconnect()
      input.registry.clear()
      tasks.clear()
    },
    close() {
      if (state.closed) return
      state.closed = true
      for (const flight of flights.values()) cancelFlight(flight)
      input.controller.close()
      unsubscribe()
      input.registry.clear()
      tasks.clear()
    },
  }
}

function hash(text: string) {
  return createHash("sha256").update(text).digest("hex")
}
function witness(hit: Computer.HitResult) {
  return {
    ...(hit.owner.platform !== "remote" && hit.owner.pid ? { pid: hit.owner.pid } : {}),
    windowId: hit.windowId,
    ...(hit.ref ? { ref: hit.ref } : {}),
    ...(hit.elementId ? { elementId: hit.elementId } : {}),
  }
}
function nativePath(backend: Computer.Backend) {
  return backend === "local-windows" ? path.win32 : path.posix
}
function sameIdentity(first: Computer.AppIdentity, second: Computer.AppIdentity) {
  if (first.platform !== second.platform || Computer.appKey(first) !== Computer.appKey(second)) return false
  if (first.platform === "macos" && second.platform === "macos")
    return (
      first.verified === second.verified &&
      first.teamId === second.teamId &&
      first.apple === second.apple &&
      first.path === second.path
    )
  if (first.platform === "windows" && second.platform === "windows")
    return first.verified === second.verified && first.publisher === second.publisher && first.exe === second.exe
  return false
}
function overlap(first: Computer.Rect, second: Computer.Rect) {
  return (
    Math.max(0, Math.min(first.x + first.w, second.x + second.w) - Math.max(first.x, second.x)) *
    Math.max(0, Math.min(first.y + first.h, second.y + second.h) - Math.max(first.y, second.y))
  )
}
function actionOf(step: Computer.Step): Computer.ToolAction {
  if (step.kind === "click")
    return step.count === 3
      ? "triple_click"
      : step.count === 2
        ? "double_click"
        : step.button === "right"
          ? "right_click"
          : step.button === "middle"
            ? "middle_click"
            : "click"
  return step.kind === "move"
    ? "mouse_move"
    : step.kind === "down"
      ? "mouse_down"
      : step.kind === "up"
        ? "mouse_up"
        : step.kind === "key" && step.holdMs
          ? "hold_key"
          : step.kind
}
