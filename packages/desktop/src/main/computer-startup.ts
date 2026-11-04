import { execFile } from "node:child_process"
import { realpath } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { Option, Schema } from "effect"
import { Computer } from "@vectordevai/schema/computer"
import { Hands } from "@vectordevai/schema/hands"
import { PermissionPolicy } from "@vectordevai/schema/permission-policy"
import { PermissionV1 } from "@vectordevai/schema/v1/permission"
import { QuestionV1 } from "@vectordevai/schema/v1/question"
import { ComputerMainCopy } from "@vectordevai/app/computer/main-copy"
import identity from "../../native/computer-helper/identity.json"
import { NativeHelperBackend } from "./computer-backend"
import { ComputerError, startComputerBridge, type ComputerExecutor } from "./computer-bridge"
import { createComputerExecutor } from "./computer-executor"
import { createComputerFrames } from "./computer-frames"
import { createComputerGrants } from "./computer-grants"
import { ComputerHelper, HelperUnavailableError } from "./computer-helper"
import { broadcastComputerState, broadcastScreenshotsRemoved, type ComputerIpcService } from "./computer-ipc"
import { createComputerNotify, type ComputerNotification, type ComputerNotifyTarget } from "./computer-notify"
import { createComputerOverlay } from "./computer-overlay"
import { setComputerOverlayControls } from "./computer-overlay-ipc"
import { createComputerPermissions } from "./computer-permissions"
import { createComputerPolicy } from "./computer-policy"
import { computerPrune, createComputerRetention, type ComputerRetentionTimers } from "./computer-retention"
import { createComputerSession } from "./computer-session"
import type { createComputerSettings } from "./computer-settings"
import { createComputerTakeover, validateChord } from "./computer-takeover"
import { computerTrayState, type ComputerTrayCommand, type ComputerTrayState } from "./computer-tray"
import { createComputerKeepAwake, type KeepAwakeEvent, type KeepAwakeSource, type PowerBlocker } from "./keep-awake"

type Settings = Awaited<ReturnType<typeof createComputerSettings>>
type Controller = ReturnType<typeof createComputerSession>
type Retention = ReturnType<typeof createComputerRetention>
type Ask = NonNullable<Computer.ComputerState["ask"]>
type Platform = "darwin" | "win32"
type Window = Parameters<typeof broadcastComputerState>[1] extends () => readonly (infer W)[] ? W : never

export type ComputerAvailability = { available: true } | { available: false; reason: Computer.UnavailableReason }

const ENGINE_MS = 5_000
const LEASES_MAX = 64
const POWER_EVENTS = [
  "lock-screen",
  "unlock-screen",
  "suspend",
  "resume",
  "user-did-resign-active",
  "user-did-become-active",
] as const

/** Section 2.8: the env pair exists only on supported desktops, unelevated, when company policy leaves Hands on. */
export function computerAvailability(input: {
  platform: NodeJS.Platform
  release: string
  elevated: boolean
  policy: Pick<Computer.ComputerPolicy, "enabled">
}): ComputerAvailability {
  const version = input.release.split(".").map(Number)
  if (input.platform !== "darwin" && input.platform !== "win32") return { available: false, reason: "unsupported_os" }
  if (input.platform === "darwin" && !(Number.isInteger(version[0]) && version[0]! >= 23))
    return { available: false, reason: "unsupported_os" }
  if (input.platform === "win32" && !(version[0] === 10 && Number.isInteger(version[2]) && version[2]! >= 19041))
    return { available: false, reason: "unsupported_os" }
  if (input.elevated) return { available: false, reason: "elevated" }
  if (!input.policy.enabled) return { available: false, reason: "policy_disabled" }
  return { available: true }
}

/** The pair the engine sidecar receives in its start message only (never its spawn environment). */
export function computerEnvironment(bridge?: { url: string; token: string }): Record<string, string> {
  return bridge ? { [Computer.BRIDGE.urlEnv]: bridge.url, [Computer.BRIDGE.tokenEnv]: bridge.token } : {}
}

/**
 * Whether Vector itself runs elevated: uid 0 on macOS, a high or system integrity token on Windows. A check that
 * cannot run counts as elevated, so Hands fails closed rather than operating apps from an administrator token.
 */
export async function processElevated(
  platform: NodeJS.Platform,
  options: { uid?: () => number | undefined; groups?: () => Promise<string> } = {},
): Promise<boolean> {
  if (platform === "darwin") return (options.uid ?? (() => process.getuid?.()))() === 0
  if (platform !== "win32") return false
  try {
    const output = await (options.groups ?? whoamiGroups)()
    return /\bS-1-16-(?:12288|16384)\b/.test(output) || !/\bS-1-16-\d+\b/.test(output)
  } catch {
    return true
  }
}

function whoamiGroups() {
  return new Promise<string>((resolve, reject) => {
    execFile(
      "whoami",
      ["/groups", "/fo", "csv", "/nh"],
      { windowsHide: true, timeout: ENGINE_MS, maxBuffer: 256 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout))),
    )
  })
}

/** Directories Hands never types into: Vector's own config, prompt, memory and data locations (D16, INV-S11). */
export function protectedLocations(input: { userData: string; env: NodeJS.ProcessEnv; home?: string }): string[] {
  const home = input.home ?? homedir()
  const locations = [
    input.userData,
    input.env.VECTOR_AGENT_CONFIG_DIR,
    input.env.XDG_DATA_HOME && path.join(input.env.XDG_DATA_HOME, "vector"),
    input.env.XDG_CONFIG_HOME && path.join(input.env.XDG_CONFIG_HOME, "vector"),
    input.env.XDG_STATE_HOME && path.join(input.env.XDG_STATE_HOME, "vector"),
    input.env.XDG_CACHE_HOME && path.join(input.env.XDG_CACHE_HOME, "vector"),
    path.join(home, ".config", "vector"),
    path.join(home, ".local", "share", "vector"),
    path.join(home, ".vector"),
  ]
  return [...new Set(locations.filter((value): value is string => !!value && path.isAbsolute(value)))]
}

/** The local engine's HTTP API, as desktop main uses it for Hands: abort, session ancestry and the banner's replies. */
export function computerEngine(
  connection: { url: string; password: string },
  fetcher: (input: URL, init: RequestInit) => Promise<Response> = (input, init) => fetch(input, init),
) {
  const authorization = `Basic ${Buffer.from(`vector:${connection.password}`).toString("base64")}`
  const decodeSession = Schema.decodeUnknownOption(
    Schema.Struct({ id: Schema.String, parentID: Schema.optional(Schema.String) }),
  )
  async function request(method: "GET" | "POST", route: string, directory: string, body?: unknown) {
    const url = new URL(route, connection.url)
    url.searchParams.set("directory", directory)
    const response = await fetcher(url, {
      method,
      headers: { authorization, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(ENGINE_MS),
    })
    if (!response.ok) throw new Error(`The engine answered ${response.status}.`)
    return response
  }
  const id = (value: string) => encodeURIComponent(value)
  return {
    async abort(scope: { rootSessionID: string; directory: string }) {
      await request("POST", `/session/${id(scope.rootSessionID)}/abort`, scope.directory)
    },
    async rootOf(sessionID: string, directory: string): Promise<string | undefined> {
      let current = sessionID
      for (let depth = 0; depth < 64; depth++) {
        const session = decodeSession(await (await request("GET", `/session/${id(current)}`, directory)).json())
        if (Option.isNone(session) || session.value.id !== current) return undefined
        if (!session.value.parentID) return current
        current = session.value.parentID
      }
      return undefined
    },
    async replyPermission(requestID: string, directory: string, reply: "once" | "reject") {
      await request("POST", `/permission/${id(requestID)}/reply`, directory, { reply })
    },
    async replyQuestion(requestID: string, directory: string, answer: "Continue" | "Keep going") {
      await request("POST", `/question/${id(requestID)}/reply`, directory, { answers: [[answer]] })
    },
  }
}
type Engine = ReturnType<typeof computerEngine>

const decodePermission = Schema.decodeUnknownOption(PermissionV1.Request)
const decodeQuestion = Schema.decodeUnknownOption(QuestionV1.Request)
const decodeAnswered = Schema.decodeUnknownOption(Schema.Struct({ sessionID: Schema.String, requestID: Schema.String }))
const decodeApp = Schema.decodeUnknownOption(Computer.AppAskMetadata)
const decodeSensitive = Schema.decodeUnknownOption(Computer.SensitiveAskMetadata)

function line(text: string) {
  return Computer.clean(text, 256)
    .slice(0, 256)
    .replace(/[\ud800-\udbff]$/, "")
}

/**
 * Mirrors the holder's Hands asks into `state.ask` with fixed Vector-built titles (D18's transition seam), so the
 * banner shows them (INV-T6). Only exact Hands asks (`PermissionPolicy.handsAsk`) and Hands questions qualify; the
 * agent's words, paths, typed text and model-supplied app names never enter the title.
 */
export function createAskMirror(input: {
  controller: Pick<Controller, "state" | "transition">
  /** The child session that holds each lease, from the bridge's acquire. */
  holder(lease: number): string | undefined
  now?(): number
}) {
  const now = input.now ?? Date.now
  let pending: { phase: "asking" | "handoff"; ask: Ask; lease: number } | undefined

  function ours(state: Computer.ComputerState, sessionID: string, directory: string | undefined) {
    return (
      !!state.holder &&
      directory === state.holder.directory &&
      (sessionID === state.holder.sessionID || sessionID === input.holder(state.lease))
    )
  }

  function show(phase: "asking" | "handoff", ask: Ask) {
    const lease = input.controller.state().lease
    pending = undefined
    void input.controller.transition(phase, ask).catch((error: unknown) => {
      // Paused: the ask waits in the dock and reaches the banner once the user resumes.
      if (error instanceof ComputerError && error.code === "paused") pending = { phase, ask, lease }
    })
  }

  function answered(requestID: string) {
    if (pending?.ask.requestID === requestID) pending = undefined
    const state = input.controller.state()
    if (state.ask?.requestID !== requestID) return
    if (state.phase === "asking") void input.controller.transition("working").catch(() => {})
    else if (state.phase === "handoff") void input.controller.transition("handoff").catch(() => {})
  }

  return {
    event(event: KeepAwakeEvent) {
      const state = input.controller.state()
      const properties = event.payload.properties
      if (event.payload.type === "permission.asked") {
        const request = decodePermission(properties)
        if (Option.isNone(request) || !PermissionPolicy.handsAsk(request.value.permission)) return
        if (request.value.id.length > 128 || !ours(state, request.value.sessionID, event.directory)) return
        const base = { requestID: request.value.id, directory: event.directory!, canAlways: false, shownAt: now() }
        if (request.value.permission === PermissionPolicy.COMPUTER_APP) {
          const metadata = decodeApp(request.value.metadata)
          if (Option.isNone(metadata)) return
          const app = Computer.clean(metadata.value.target.appName, 256)
          if (!app) return
          show("asking", { ...base, kind: "app", title: line(ComputerMainCopy.askApp({ app })) })
          return
        }
        const metadata = decodeSensitive(request.value.metadata)
        if (Option.isNone(metadata)) return
        const app = Computer.clean(metadata.value.target.appName, 256) || "the app"
        show("asking", {
          ...base,
          kind: "sensitive",
          title: line(
            ComputerMainCopy.askSensitive({
              action: metadata.value.action,
              why: metadata.value.why,
              app,
              label: metadata.value.targetName,
            }),
          ),
        })
        return
      }
      if (event.payload.type === "question.asked") {
        const request = decodeQuestion(properties)
        if (Option.isNone(request) || !request.value.metadata) return
        if (request.value.id.length > 128 || !ours(state, request.value.sessionID, event.directory)) return
        const base = { requestID: request.value.id, directory: event.directory!, canAlways: false, shownAt: now() }
        const computer = request.value.metadata.computer
        if (computer.kind === "handoff") {
          // The handoff's app can come from the model's own arguments, so the banner names only the fixed reason.
          show("handoff", {
            ...base,
            kind: "handoff",
            title: line(ComputerMainCopy.handoff({ reason: computer.reason })),
          })
          return
        }
        show("asking", {
          ...base,
          kind: "check_in",
          title: line(
            computer.minutes >= Computer.LIMITS.checkInMinutes
              ? ComputerMainCopy.checkIn({ reason: "minutes", count: computer.minutes })
              : ComputerMainCopy.checkIn({ reason: "actions", count: computer.actions }),
          ),
        })
        return
      }
      if (
        event.payload.type === "permission.replied" ||
        event.payload.type === "question.replied" ||
        event.payload.type === "question.rejected"
      ) {
        const reply = decodeAnswered(properties)
        if (Option.isSome(reply) && ours(state, reply.value.sessionID, event.directory)) answered(reply.value.requestID)
      }
    },
    /** A paused ask is shown once its run works again, unless it was answered meanwhile. */
    state(state: Computer.ComputerState) {
      if (!pending) return
      if (!state.holder || state.lease !== pending.lease) {
        pending = undefined
        return
      }
      if (state.phase === "working" && !state.ask) {
        const next = pending
        show(next.phase, next.ask)
      }
    },
  }
}

/**
 * What a banner answer sends to the engine: the same reply the dock would, for the ask the banner shows. Allow is
 * always once (the banner never offers Always allow); anything else, or another request, sends nothing.
 */
export function bannerReply(
  action: Computer.OverlayAction,
  requestID: string | undefined,
  ask: Ask | undefined,
):
  | { route: "permission"; reply: "once" | "reject" }
  | { route: "question"; answer: "Continue" | "Keep going" }
  | undefined {
  if (!ask || !requestID || ask.requestID !== requestID) return
  if ((action === "allow" || action === "deny") && (ask.kind === "app" || ask.kind === "sensitive"))
    return { route: "permission", reply: action === "allow" ? "once" : "reject" }
  if (action === "continue" && ask.kind === "handoff") return { route: "question", answer: "Continue" }
  if (action === "keep-going" && ask.kind === "check_in") return { route: "question", answer: "Keep going" }
}

/** Missing OS grants, read strictly: anything not plainly granted is missing (no optimistic enabling). */
function missingGrants(kind: Computer.Backend, permissions: Computer.PermissionsStatus) {
  const allowed = kind === "local-windows" ? ["granted", "n/a"] : ["granted"]
  return (
    !allowed.includes(permissions.screen) ||
    permissions.captureBlocked === true ||
    !allowed.includes(permissions.accessibility) ||
    permissions.postEvent === "denied" ||
    (kind !== "local-windows" && permissions.postEvent !== undefined && permissions.postEvent !== "granted")
  )
}

/**
 * A renderer's preference write, checked in main: company-locked fields and main's own permission record are
 * refused, and a stop shortcut must pass D20's validation (stored in its canonical form).
 */
function checkedPatch(
  patch: Partial<Computer.ComputerPrefs>,
  resolved: Computer.ResolvedComputerSettings,
  platform: Platform,
): Partial<Computer.ComputerPrefs> {
  if (Object.hasOwn(patch, "granted")) throw new Error(`Vector records ${Hands.NAME}' permission history itself.`)
  for (const field of Object.keys(patch) as (keyof Computer.ComputerPrefs)[])
    if (resolved.locked.includes(field)) throw new Error("Set by your company.")
  if (patch.stopChord === undefined) return { ...patch }
  const chord = validateChord(patch.stopChord, platform)
  if (!chord) throw new Error(`That shortcut can't stop ${Hands.NAME}.`)
  return { ...patch, stopChord: chord }
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

function reasonOf(error: unknown): Computer.UnavailableReason {
  if (error instanceof HelperUnavailableError) return error.reason
  if (error instanceof ComputerError) {
    if (error.code === "helper_incompatible" || error.code === "responsible_missing" || error.code === "unsupported_os")
      return error.code
    if (error.code === "blocked_by_os") return "blocked_by_os"
  }
  return "helper_missing"
}

function idleState(
  backend: Computer.ComputerState["backend"],
  settings: Computer.ResolvedComputerSettings | undefined,
  platform: Platform,
): Computer.ComputerState {
  return {
    phase: settings && enabled(settings) ? "ready" : "off",
    backend,
    mode: "foreground",
    apps: [],
    queue: [],
    escStops: false,
    stopChord: Computer.clean(settings?.prefs.stopChord ?? Hands.STOP_CHORD[platform], 64),
    lease: 0,
    reduceMotion: settings?.prefs.reduceMotion ?? false,
  }
}

/** Electron and OS facts that index.ts supplies after app readiness; tests of the pure pieces need none of them. */
export type ComputerStartupDeps = {
  platform: NodeJS.Platform
  /** Defaults: processElevated, createComputerPolicy and startComputerBridge. Tests replace only these seams. */
  elevated?(): Promise<boolean>
  policy?: { get(): Computer.ComputerPolicy }
  startBridge?: typeof startComputerBridge
  /** The helper supervisor; tests inject one whose native seams are virtual. */
  helper?: ComputerHelper
  release: string
  channel: "dev" | "beta" | "prod"
  packaged: boolean
  devRoot: string
  resourcesPath?: string
  userData: string
  env: NodeJS.ProcessEnv
  hashes?: Readonly<Record<string, string>>
  openSettings(policy: () => Computer.ComputerPolicy): Promise<Settings>
  promptStore: { get(key: string): unknown; set(key: string, value: unknown): void }
  systemPreferences: {
    getMediaAccessStatus(type: "screen"): string
    isTrustedAccessibilityClient(prompt: false): boolean
  }
  openExternal(url: string): Promise<void>
  clipboard: { readText(): string; writeText(text: string): void }
  shortcuts: Parameters<typeof createComputerTakeover>[0]["shortcuts"]
  toDip?(rect: Computer.Rect): Computer.Rect
  displayBlocker: PowerBlocker
  power: {
    on(event: string, callback: () => void): unknown
    removeListener(event: string, callback: () => void): unknown
  }
  exclusions(): { vectorPids: readonly number[]; vectorWindowIds: readonly string[] }
  windows(): readonly Window[]
  trustedUrl(url?: string): boolean
  notification(message: ComputerNotification, onClick: () => void): void
  focused(): boolean
  open(target: ComputerNotifyTarget): void
  front(): void
  trayChanged(): void
  overlayPreload?: string
  /** Tests replace the screenshot retention timers; the prune request uses the global fetch. */
  retentionTimers?: ComputerRetentionTimers
  warn(message: string, ...fields: unknown[]): void
}

export type ComputerRuntime = {
  /** The bridge pair for the sidecar's start message; empty where Hands may not run. */
  environment: Record<string, string>
  service: ComputerIpcService
  tray(): ComputerTrayState | undefined
  trayCommand(command: ComputerTrayCommand): void
  /** After the engine connects: its event stream, abort route, session ancestry and reply routes. */
  attach(engine: { url: string; password: string; source: KeepAwakeSource }): void
  /** The engine sidecar exited: revoke at once (INV-T3). */
  engineExit(): void
  stop(): Promise<void>
}

function limited(
  reason: Computer.UnavailableReason,
  platform: Platform,
  settings: Settings | undefined,
  permissions: ReturnType<typeof createComputerPermissions> | undefined,
  helper: ComputerHelper | undefined,
  retention?: Retention,
): ComputerRuntime {
  const backend = platform === "win32" ? "local-windows" : "local-macos"
  const off = () => Promise.reject(new Error(`${Hands.NAME} is not available on this computer.`))
  const service: ComputerIpcService = {
    status: async () => ({ available: false, reason, backend }),
    state: () => idleState(backend, settings?.get(), platform),
    command: off,
    prefs: () => {
      if (!settings) throw new Error(`${Hands.NAME} settings are unavailable.`)
      return settings.get()
    },
    setPrefs: async (patch) => {
      if (!settings) return off()
      const previous = settings.get()
      const saved = await settings.setPrefs(checkedPatch(patch, previous, platform))
      retention?.changed(previous)
      return saved
    },
    permissions: () => (permissions ? permissions.list() : off()),
    recheck: () => (permissions ? permissions.recheck() : off()),
    openPane: (id) => (permissions ? permissions.openPane(id) : off()),
    reset: (id) => (permissions ? permissions.reset(id) : off()),
    apps: async () => [],
    removeAlways: (key) => (settings ? settings.removeAlways(key) : off()),
    removeAllAlways: () => (settings ? settings.removeAllAlways() : off()),
    block: (app) => (settings ? settings.block(app) : off()),
    unblock: (key) => (settings ? settings.unblock(key) : off()),
    // Screenshots taken before Hands became unavailable still follow the schedule, and Delete all still works.
    deleteScreenshots: () => (retention ? retention.deleteAll() : off()),
  }
  return {
    environment: {},
    service,
    tray: () => undefined,
    trayCommand() {},
    attach(engine) {
      retention?.attach(computerPrune(engine))
    },
    engineExit() {},
    stop: async () => {
      retention?.stop()
      await helper?.close().catch(() => {})
    },
  }
}

/**
 * Wires D13 to D21 into the running app: the bridge before the sidecar spawns (its pair goes in the start message),
 * then the controller, executor, take-over, overlays, permissions, notifications and IPC service. Never throws: a
 * failure leaves Hands unavailable with its reason.
 */
export async function startComputer(deps: ComputerStartupDeps): Promise<ComputerRuntime> {
  if (deps.platform !== "darwin" && deps.platform !== "win32")
    return limited("unsupported_os", "darwin", undefined, undefined, undefined)
  const platform: Platform = deps.platform
  const policy = deps.policy ?? createComputerPolicy()
  const settings = await deps
    .openSettings(() => policy.get())
    .catch((error: unknown) => {
      deps.warn("Computer settings unavailable", error instanceof Error ? error.name : "Error")
      return undefined
    })
  if (!settings) return limited("helper_missing", platform, undefined, undefined, undefined)
  // The child session that took each lease, from the bridge's acquire (the ask mirror and retention read it).
  const leases = new Map<number, string>()
  const retention = createComputerRetention({
    settings,
    holderSession: (lease) => leases.get(lease),
    removed: (removal) => broadcastScreenshotsRemoved(removal, deps.windows, deps.trustedUrl),
    warn: (message, ...fields) => deps.warn(message, ...fields),
    ...(deps.retentionTimers ? { timers: deps.retentionTimers } : {}),
  })
  const helper =
    deps.helper ??
    new ComputerHelper({
      platform,
      channel: deps.channel,
      packaged: deps.packaged,
      devRoot: deps.devRoot,
      ...(deps.resourcesPath ? { resourcesPath: deps.resourcesPath } : {}),
      ...(deps.hashes ? { hashes: deps.hashes } : {}),
    })
  const elevated = await (deps.elevated ? deps.elevated() : processElevated(platform)).catch(() => true)
  const permissions = createComputerPermissions({
    platform,
    helperVersion: identity.helperVersion,
    helper,
    settings,
    promptStore: deps.promptStore,
    signing: () => helper.runtimeSigningKind(),
    vector: deps.systemPreferences,
    openExternal: (url) => deps.openExternal(url),
    elevated: () => elevated,
  })
  const availability = computerAvailability({ platform, release: deps.release, elevated, policy: policy.get() })
  if (!availability.available) return limited(availability.reason, platform, settings, permissions, helper, retention)

  const kind = platform === "win32" ? "local-windows" : "local-macos"
  const backend = new NativeHelperBackend(helper, kind)
  // `connected` admits leases only while the engine's event stream is open, so every ask and reply is observed (D16).
  const connection: { engine?: Engine; abort?: AbortController; connected: boolean; closed: boolean } = {
    connected: false,
    closed: false,
  }
  const grants = createComputerGrants({
    settings,
    rootOf: (sessionID, directory) =>
      connection.engine ? connection.engine.rootOf(sessionID, directory) : Promise.resolve(undefined),
  })
  const overlay = createComputerOverlay({
    platform,
    ...(deps.overlayPreload ? { preloadPath: deps.overlayPreload } : {}),
  })
  const keepAwake = createComputerKeepAwake({ blocker: deps.displayBlocker })
  const controller = createComputerSession({
    backend,
    overlay,
    settings,
    grants,
    async approved(scope) {
      const current = grants.grants(scope)
      return (await backend.apps())
        .filter((app) => settings.access(app.identity, current).verdict === "granted")
        .map((app) => app.identity)
    },
    helper,
    exclusions: () => deps.exclusions(),
    async abort(scope) {
      if (!connection.engine) return
      await connection.engine.abort(scope).catch((error: unknown) => {
        deps.warn("Computer stop could not abort the conversation", error instanceof Error ? error.name : "Error")
      })
    },
    keepAwake,
  })
  const frames = createComputerFrames({
    backend,
    platform: platform === "win32" ? "windows" : "macos",
    phase: (scope) => {
      try {
        return controller.nativePhase(scope)
      } catch {
        return undefined
      }
    },
    ...(platform === "win32" && deps.toDip ? { toDip: (rect: Computer.Rect) => deps.toDip!(rect) } : {}),
  })
  const takeovers: { current?: ReturnType<typeof createComputerTakeover> } = {}
  const executor = createComputerExecutor({
    backend,
    controller,
    settings,
    grants,
    registry: frames,
    canonicalPath: (file) => realpath(file).catch(() => undefined),
    protectedPaths: [],
    protectedDirectories: protectedLocations({ userData: deps.userData, env: deps.env }),
    clipboard: {
      readText: () => deps.clipboard.readText(),
      writeText: (text) => deps.clipboard.writeText(text),
    },
    overlay,
    beforeInput(scope, hit) {
      if (hit.owner.platform === "remote" || !hit.owner.pid)
        throw new ComputerError("changed", "The input target has no live process.")
      takeovers.current?.target(scope, { pid: hit.owner.pid, name: hit.owner.name })
    },
    suspendEsc: () => takeovers.current?.suspendEsc(),
    resumeEsc: () => takeovers.current?.resumeEsc(),
  })
  // Take-over owns the helper's events and routes each one to the controller exactly once (D20).
  const takeover = createComputerTakeover({
    platform,
    controller,
    backend,
    shortcuts: deps.shortcuts,
    onUnavailable: (reason) => deps.warn("Computer stop shortcut unavailable", reason),
  })
  takeovers.current = takeover

  const notify = createComputerNotify({
    show: (message, onClick) => deps.notification(message, onClick),
    enabled: () => settings.get().prefs.notify,
    focused: () => deps.focused(),
    open: (target) => deps.open(target),
    front: () => deps.front(),
  })
  const mirror = createAskMirror({ controller, holder: (lease) => leases.get(lease) })

  function view(): Computer.ComputerState {
    const state = controller.state()
    if (state.holder || (state.phase !== "off" && state.phase !== "ready")) return state
    const resolved = settings!.get()
    return {
      ...state,
      phase: enabled(resolved) ? "ready" : "off",
      stopChord: Computer.clean(resolved.prefs.stopChord, 64),
      reduceMotion: resolved.prefs.reduceMotion,
    }
  }
  function changed() {
    broadcastComputerState(view(), deps.windows, deps.trustedUrl)
    try {
      deps.trayChanged()
    } catch {
      // The tray reads live state when it is next opened.
    }
  }
  const unsubscribe = controller.subscribe((state) => {
    notify.state(state)
    mirror.state(state)
    retention.observe(state)
    changed()
  })
  const power = POWER_EVENTS.map((name) => {
    const callback = () => controller.powerEvent(name)
    deps.power.on(name, callback)
    return () => deps.power.removeListener(name, callback)
  })
  setComputerOverlayControls({
    banner: () => overlay.banner(),
    state: () => controller.state(),
    armed: (requestID) => overlay.armed(requestID),
    hover: (on) => overlay.hover(on),
    async act(action, requestID) {
      if (action === "stop" || action === "takeover" || action === "resume") return executor.control(action)
      if (action === "hand-over" || action === "not-now") return executor.control(action, requestID)
      const ask = controller.state().ask
      const reply = bannerReply(action, requestID, ask)
      const engine = connection.engine
      if (!engine || !ask || !reply) return false
      if (reply.route === "permission") await engine.replyPermission(ask.requestID, ask.directory, reply.reply)
      else await engine.replyQuestion(ask.requestID, ask.directory, reply.answer)
      return true
    },
  })

  /**
   * D21's fresh probe is the truth about the helper's grants: a failed or ungranted view keeps Hands unavailable
   * until a later probe reads healthy, and pauses a run in progress rather than letting it continue (D21.1).
   */
  const probe: { healthy: boolean } = { healthy: true }
  function observed(view: Computer.PermissionsView) {
    probe.healthy = view.helperStart === "ok"
    const granted =
      probe.healthy &&
      (platform === "win32"
        ? view.windows?.captureBlocked === false && view.windows.elevated === false
        : view.rows.length === 2 && view.rows.every((row) => row.status === "granted"))
    if (!granted && controller.state().holder) void controller.pause("helper").catch(() => {})
    return view
  }

  async function availabilityNow(): Promise<{ reason?: Computer.UnavailableReason; hello?: Computer.HelperHello }> {
    if (!policy.get().enabled) return { reason: "policy_disabled" }
    if (!probe.healthy) return { reason: "helper_missing" }
    // Before consent no helper starts (INV-C1); onboarding reads its own fresh probe.
    if (!enabled(settings!.get())) return { reason: "permissions" }
    const hello = await backend.hello().catch((error: unknown) => error)
    if (!hello || hello instanceof Error || typeof hello !== "object") return { reason: reasonOf(hello) }
    const status = await backend.permissions().catch(() => undefined)
    if (!status) return { reason: "helper_missing", hello: hello as Computer.HelperHello }
    return missingGrants(kind, status)
      ? { reason: "permissions", hello: hello as Computer.HelperHello }
      : { hello: hello as Computer.HelperHello }
  }

  async function signing(): Promise<"developer-id" | "adhoc" | "unsigned" | "dev"> {
    if (!deps.packaged) return "dev"
    const value = await helper.runtimeSigningKind()
    if (platform === "darwin") return value === "signed" ? "developer-id" : value === "adhoc" ? "adhoc" : "unsigned"
    return "unsigned"
  }

  const tracked: ComputerExecutor = {
    run(request, key) {
      if (request.command === "acquire" && !connection.connected)
        return Promise.reject(new ComputerError("unavailable", "The engine's event stream is not connected."))
      const result = executor.run(request, key)
      if (request.command === "acquire")
        void result.then(
          (value) => {
            if (!value || typeof value !== "object" || !("lease" in value)) return
            leases.set(value.lease as number, request.sessionID)
            while (leases.size > LEASES_MAX) leases.delete(leases.keys().next().value!)
          },
          () => {},
        )
      return result
    },
    cancel: (key) => executor.cancel(key),
  }
  const bridge = await (deps.startBridge ?? startComputerBridge)({
    executor: tracked,
    capabilities: async (): Promise<Computer.Capabilities> => {
      const current = await availabilityNow()
      const features = current.hello ? backend.capabilities() : { actions: [], features: {} }
      return {
        protocol: Computer.PROTOCOL,
        available: !current.reason,
        ...(current.reason ? { reason: current.reason } : {}),
        backend: kind,
        actions: current.hello ? features.actions : [],
        features: {
          background: features.features.background === true,
          uiTree: features.features["ui.tree"] === true,
          zoom: features.features["capture.zoom"] === true,
          clipboard: features.features.clipboard === true,
          locked: false,
        },
      }
    },
    warn: (message, ...fields) => deps.warn(message, ...fields),
  }).catch((error: unknown) => {
    deps.warn("Computer bridge could not start", error instanceof Error ? error.name : "Error")
    return undefined
  })
  if (!bridge) {
    // Nothing ran yet: close the helper before the controller, so its halt cannot start one.
    await backend.close().catch(() => {})
    executor.close()
    takeover.close()
    unsubscribe()
    for (const off of power) off()
    setComputerOverlayControls(undefined)
    return limited("helper_missing", platform, settings, permissions, undefined, retention)
  }

  function afterSettings(previous: Computer.ResolvedComputerSettings) {
    takeover.refresh()
    retention.changed(previous)
    changed()
    const next = settings!.get()
    if (enabled(previous) && !enabled(next) && controller.state().holder) void controller.stop().catch(() => {})
    if (!enabled(previous) && enabled(next)) void backend.hello().catch(() => {})
  }
  function regrant() {
    void controller.updateGrants().catch(() => {})
  }

  const service: ComputerIpcService = {
    async status() {
      const current = await availabilityNow()
      return {
        available: !current.reason,
        ...(current.reason ? { reason: current.reason } : {}),
        backend: kind,
        ...(current.hello
          ? { helper: { version: current.hello.helper.version, protocol: Computer.PROTOCOL, signing: await signing() } }
          : {}),
      }
    },
    state: view,
    async command(command, arg) {
      if (command === "stop-session") {
        if (!arg?.sessionID) throw new Error("That conversation is not waiting for the computer.")
        await controller.stopSession(arg.sessionID)
        return
      }
      if (command === "hand-over" || command === "not-now") {
        const ask = controller.state().ask
        if (ask?.kind !== "pointer" || !(await executor.control(command, ask.requestID)))
          throw new Error("That request is no longer open.")
        return
      }
      await executor.control(command)
    },
    prefs: () => settings.get(),
    async setPrefs(patch) {
      const previous = settings.get()
      const saved = await settings.setPrefs(checkedPatch(patch, previous, platform))
      afterSettings(previous)
      return saved
    },
    permissions: () => permissions.list().then(observed),
    recheck: () => permissions.recheck().then(observed),
    openPane: (id) => permissions.openPane(id),
    reset: (id) => permissions.reset(id).then(observed),
    async apps(query) {
      if (!enabled(settings.get())) return []
      const [running, installed] = await Promise.all([backend.apps(), backend.apps({ installed: true })])
      const live = new Set(running.map((app) => Computer.appKey(app.identity)))
      const rows = new Map<string, Awaited<ReturnType<Computer.ComputerPlatform["apps"]>>[number]>()
      const needle = query?.toLocaleLowerCase()
      for (const app of [...running, ...installed]) {
        if (app.identity.platform === "remote") continue
        const key = Computer.appKey(app.identity)
        const name = Computer.clean(app.identity.name, 256)
        if (rows.has(key) || !name || (needle && !name.toLocaleLowerCase().includes(needle))) continue
        const verdict = settings.access(app.identity).verdict
        const rule = verdict === "never" || verdict === "blocked" || verdict === "company-deny" ? verdict : undefined
        rows.set(key, { key, name, running: live.has(key), ...(rule ? { rule } : {}) })
        if (rows.size >= 200) break
      }
      return [...rows.values()]
    },
    async removeAlways(key) {
      await settings.removeAlways(key)
      regrant()
      changed()
    },
    async removeAllAlways() {
      await settings.removeAllAlways()
      regrant()
      changed()
    },
    async block(app) {
      await settings.block(app)
      regrant()
      changed()
    },
    async unblock(key) {
      await settings.unblock(key)
      changed()
    },
    deleteScreenshots: () => retention.deleteAll(),
  }

  /**
   * The engine is gone or silent: revoke at once (INV-T3). With nothing held or queued there is nothing to halt, and
   * halting would start an idle helper, so only the admission latch closes.
   */
  function lost() {
    connection.connected = false
    const state = controller.state()
    if (!state.holder && state.queue.length === 0) return
    notify.fail(state.holder ?? { sessionID: "", directory: "" }, "engine")
    executor.disconnect()
  }

  async function events(engine: { source: KeepAwakeSource }, signal: AbortSignal) {
    let delay = 1_000
    while (!signal.aborted) {
      try {
        for await (const event of engine.source.events(signal)) {
          delay = 1_000
          connection.connected = true
          const state = controller.state()
          const info = event.payload.properties as Record<string, unknown> | undefined
          if (
            event.payload.type === "session.error" &&
            state.holder &&
            event.directory === state.holder.directory &&
            info?.sessionID === state.holder.sessionID
          )
            notify.fail(state.holder, "error")
          await controller.observe(event)
          mirror.event(event)
        }
      } catch {
        // The stream ended or failed; whatever held the computer is revoked below.
      }
      if (signal.aborted) return
      // The next connection's first event (server.connected) admits leases again.
      lost()
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay)
        signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true })
      })
      delay = Math.min(delay * 2, 30_000)
    }
  }

  const runtime: ComputerRuntime = {
    environment: computerEnvironment(bridge),
    service,
    tray: () => computerTrayState(controller.state()),
    trayCommand(command) {
      void executor.control(command).catch(() => {})
    },
    attach(engine) {
      if (connection.closed || connection.abort) return
      connection.engine = computerEngine(engine)
      connection.abort = new AbortController()
      void events(engine, connection.abort.signal)
      retention.attach(computerPrune(engine))
      if (enabled(settings.get())) void backend.hello().catch(() => {})
    },
    engineExit() {
      if (!connection.closed) lost()
    },
    async stop() {
      if (connection.closed) return
      connection.closed = true
      notify.close()
      retention.stop()
      setComputerOverlayControls(undefined)
      connection.abort?.abort()
      unsubscribe()
      for (const off of power) off()
      // A live run halts first: the controller cancels and releases input on the running helper, then closes every
      // overlay. With no run, the helper closes first, so quitting never starts one just to halt it.
      const live = !!controller.state().holder
      if (!live) await backend.close().catch(() => {})
      executor.close()
      takeover.close()
      overlay.close()
      await Promise.allSettled([bridge.stop(), live ? backend.close() : Promise.resolve()])
    },
  }
  return runtime
}
