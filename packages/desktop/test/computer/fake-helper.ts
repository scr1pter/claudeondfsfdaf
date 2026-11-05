import net from "node:net"
import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

import { Exit, Schema } from "effect"
import { Computer } from "@vectordevai/schema/computer"
import { ComputerApps } from "@vectordevai/schema/computer-apps"
import { ComputerProgram } from "@vectordevai/core/computer/program"
import { Hands } from "@vectordevai/schema/hands"
import { optional } from "@vectordevai/schema/schema"
import identity from "../../native/computer-helper/identity.json" with { type: "json" }
import {
  blocklist,
  createDesktop,
  OVERLAY,
  render,
  SCENARIOS,
  type FakeApp,
  type FakeNode,
  type FakeWindow,
  type Paint,
  type Platform,
  type Rect,
  type Scenario,
  type Snapshot,
} from "./fake-desktop"
import { fit } from "./png"
import { encodeFrame, frameReader, type Channel, type Received } from "./transcript"

/**
 * A scriptable fake Vector Hands helper (C1) that speaks helper protocol v1 (build contract 2.10) over a virtual
 * desktop (`fake-desktop.ts`), so desktop main and app tests need no OS grant and never touch the real desktop.
 *
 * Protocol decisions the native helpers share (see native/computer-helper/README.md and the C1 deviations): a
 * failure that cannot be attributed to a request (malformed JSON, no usable id, an oversized frame) answers with id
 * 0, so request ids start at 1; an oversized inbound frame is discarded as it streams and serving continues; `hello`
 * refuses a requested range that does not overlap its own with `helper_incompatible`; 5 s without a heartbeat
 * releases input and answers every input op `stopped` until the next `session.begin`; a stop key or chord does the
 * same, after releasing input and before sending `stop`. Input checks run in a fixed order: halted (`stopped`),
 * `locked`, OS permission, the coordinates (`stale_frame`, `out_of_bounds`), the owner (`protected`, `not_granted`,
 * then `changed` or `occluded`), then, for text input only, `secure_field` and the click-only rule (`blocked`). Text
 * input is `input.type`, `ui.setValue` and a key op that types (see `typedKeys`). `app.activate`, `app.launch` and
 * `window.focus` answer `stopped` and `locked` the same way. A background session (macOS) never moves the pointer or
 * takes focus: clicks go through the element under the point, keys go to the named app, and every other step that
 * would need the pointer or bring something forward answers `needs_foreground` with no side effect.
 *
 * Use it in-process with `createFakeHelper` or `connect`, or as a process:
 * `fake-helper.ts --stdio --parent-pid <pid> [--channel fd3|stdio] [--control-fd <n>] [--platform macos|windows]
 * [--scenario <name>] [--protocol <min>..<max>] [--features -<feature>,...] [--fail crash-after:<n> | hang-hello |
 * deny:screen | deny:accessibility] [--latency <ms>]`, `--version --json` or `--probe --json`. A control channel on
 * the `--control-fd` descriptor takes newline-delimited JSON (`user_input`, `display_change`, `focus`, `lock`).
 * `node:` APIs only (plus the shared schemas), never Bun's, so it can be bundled for Electron runs. Images are PNG
 * whatever format a capture asks for.
 */

export interface FakeOptions {
  readonly platform?: Platform
  readonly scenario?: Scenario
  /** The protocol range `hello` answers; identity.json's by default. */
  readonly protocol?: { readonly min: number; readonly max: number }
  /** Features turned off (`--features -ui.tree,-clipboard`). */
  readonly disabled?: readonly Computer.HelperFeature[]
  /** When request n + 1 arrives, exit with code 1 without answering or releasing anything, as a crash would. */
  readonly crashAfter?: number
  /** Never answer `hello`. */
  readonly hangHello?: boolean
  /** OS permissions the user has not granted. Windows has only the screen capture switch. */
  readonly deny?: readonly ("screen" | "accessibility")[]
  /** Each queued op answers after this long, so `cancel` can reach it. */
  readonly latencyMs?: number
  /** Virtual artifact metadata only; no host filesystem, association lookup or process is used. */
  readonly programs?: readonly FakeProgramArtifact[]
}

export type FakeProgramArtifact = {
  path: string
  name: string
  content: string
  /** Explicit verified virtual handler/direct-launch binding. Missing means unresolved, never an OS fallback. */
  handler?: string
  /** Optional actual virtual desktop app identity; arbitrary invented handler identities are refused. */
  handlerIdentity?: Computer.AppIdentity
  protected?: ComputerApps.BlockReason
  aliases?: readonly string[]
}

export interface Clock {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** A clock tests advance by hand; due timers run in time order. */
export function manualClock(start = 0) {
  const timers = new Map<number, { at: number; callback: () => void }>()
  const state = { now: start, next: 1 }
  return {
    now: () => state.now,
    setTimeout(callback: () => void, ms: number) {
      const id = state.next++
      timers.set(id, { at: state.now + Math.max(0, ms), callback })
      return id
    },
    clearTimeout: (handle: unknown) => void timers.delete(handle as number),
    advance(ms: number) {
      const end = state.now + ms
      while (true) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
        if (!due) break
        timers.delete(due[0])
        state.now = due[1].at
        due[1].callback()
      }
      state.now = end
    },
  } satisfies Clock & { advance(ms: number): void }
}

export interface FakeIo {
  write(bytes: Uint8Array): void
  exit(code: number): void
  clock?: Clock
}

/** One entry of the fake's ordered, in-memory action log. */
export type LogEntry = { readonly at: number; readonly kind: string } & Readonly<Record<string, unknown>>

type Args = {
  [O in Computer.HelperOpName]: Schema.Schema.Type<(typeof Computer.HelperOps)[O]["args"]>
}[Computer.HelperOpName]
type Request = { readonly id: number; readonly args: Args }
type Refusal = { readonly ok: false; readonly code: Computer.ComputerErrorCode; readonly error: string }
type Outcome =
  | { readonly ok: true; readonly result: object; readonly image?: Uint8Array; readonly held?: readonly string[] }
  | Refusal
type ResolvedLaunch =
  | Exclude<Computer.LaunchResolution, { kind: "program" }>
  | { kind: "program"; program: Omit<Computer.NativeProgramLaunch, "token"> }
type Target = { readonly ok: true; readonly window: FakeWindow; readonly node?: FakeNode }
type Session = {
  readonly sessionId: string
  readonly phaseRevision?: number
  readonly mode: Computer.Mode
  readonly paused: boolean
  /** A native take-over stays inhibited until a fresh session.begin, never an asynchronous phase update. */
  readonly physicalPause?: boolean
  readonly approved: ReadonlyMap<string, Computer.AppIdentity>
  readonly vectorPids: ReadonlySet<number>
  readonly vectorWindowIds: ReadonlySet<string>
  readonly overlayWindowIds: ReadonlySet<string>
  readonly escStops: boolean
  readonly stopChord: string
}
type Capture = {
  readonly kind: "display" | "window" | "zoom"
  readonly displayId: string
  readonly origin: { readonly x: number; readonly y: number }
  /** Image pixels per helper unit. */
  readonly scale: number
  readonly width: number
  readonly height: number
  readonly windowId?: string
  readonly snapshot: Snapshot
}

// Answered at once, even while another op is in flight.
const IMMEDIATE: ReadonlySet<Computer.HelperOpName> = new Set(["heartbeat", "cancel", "shutdown", "input.releaseAll"])
// Everything else needs an active session. `apps.list` feeds the composer's @App list before any run, and releasing
// input must never fail.
const SESSIONLESS: ReadonlySet<Computer.HelperOpName> = new Set([
  "hello",
  "permissions.status",
  "permissions.request",
  "permissions.reset",
  "displays.list",
  "apps.list",
  "session.begin",
  "session.end",
  "heartbeat",
  "input.releaseAll",
  "cancel",
  "shutdown",
])
const MAX_CAPTURES = 32

const Control = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("user_input"),
    kind: Schema.Literals(["pointer", "key", "click", "scroll"]),
    /** The physical key, for `kind: "key"`; never forwarded except as a stop. */
    key: optional(Schema.String),
    /** Test-only equivalent of the helper's private native event marker; ignored before all side effects. */
    tagged: optional(Schema.Boolean),
    /** Logical DIP on both virtual platforms; the Windows cursor itself remains in physical pixels. */
    dx: optional(Schema.Finite),
    dy: optional(Schema.Finite),
  }),
  Schema.Struct({ type: Schema.Literal("display_change") }),
  Schema.Struct({ type: Schema.Literal("focus"), windowId: Schema.String, node: optional(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("lock"), locked: Schema.Boolean }),
])
export type ControlMessage = typeof Control.Type

const refuse = (code: Computer.ComputerErrorCode, error: string): Refusal => ({ ok: false, code, error })

// Key names, lowercased. Shift, AltGraph and Fn keep a key's text everywhere, and Option does on macOS (Option+S types
// ß). Command, Win and Control make a combo a shortcut, except that on Windows Ctrl+Alt is AltGraph, and Alt alone is
// a menu key unless a numpad key comes with it (an Alt code types a character).
const TEXT_MODIFIERS: ReadonlySet<string> = new Set([
  ...["shift", "shiftleft", "shiftright", "⇧"],
  "altgr",
  "altgraph",
  "fn",
])
const ALT: ReadonlySet<string> = new Set(["alt", "option", "opt", "altleft", "altright", "⌥"])
const CONTROL: ReadonlySet<string> = new Set(["ctrl", "control", "controlleft", "controlright", "⌃"])
const META: ReadonlySet<string> = new Set([
  ...["cmd", "command", "meta", "metaleft", "metaright", "super", "⌘"],
  ...["win", "windows", "os", "osleft", "osright"],
])
// The keys that never type. The list fails closed: a key it does not name counts as a typing key.
const NON_TYPING: ReadonlySet<string> = new Set([
  ...["enter", "return", "numpadenter", "tab", "backspace", "delete", "del", "forwarddelete", "escape", "esc"],
  ...["arrowleft", "arrowright", "arrowup", "arrowdown", "left", "right", "up", "down"],
  ...["home", "end", "pageup", "pagedown", "pgup", "pgdn", "insert", "ins", "help"],
  ...["capslock", "numlock", "scrolllock", "printscreen", "pause", "contextmenu"],
])
const NON_TYPING_PATTERN = /^(?:f(?:[1-9]|1\d|2[0-4])|media[a-z]+|audiovolume[a-z]+|volume(?:up|down|mute))$/

/**
 * How many characters a key combo types per press, so the secure-field and click-only floors apply to a key op that
 * types as to `input.type` (INV-S4): known paste shortcuts count as text-changing; 0 for other shortcuts,
 * for modifiers alone, and for keys that never type (Enter,
 * Tab, Backspace, Delete, Escape, the arrows, Home, End, the page keys, Insert, F1 to F24, the media keys). Any other
 * key types, so a key name the helper does not know is held to the floors too.
 */
function typedKeys(combo: readonly string[], platform: Platform) {
  const keys = combo.map((key) => key.toLowerCase())
  const has = (group: ReadonlySet<string>) => keys.some((key) => group.has(key))
  if (
    ((keys.includes("v") || keys.includes("keyv")) && (has(META) || has(CONTROL))) ||
    ((keys.includes("insert") || keys.includes("ins")) &&
      keys.some((key) => ["shift", "shiftleft", "shiftright", "⇧"].includes(key)))
  )
    return 1
  const windowsShortcut = has(CONTROL) ? !has(ALT) : has(ALT) && !keys.some((key) => key.startsWith("numpad"))
  if (has(META) || (platform === "macos" ? has(CONTROL) : windowsShortcut)) return 0
  return keys.filter(
    (key) =>
      ![TEXT_MODIFIERS, ALT, CONTROL].some((group) => group.has(key)) &&
      !NON_TYPING.has(key) &&
      !NON_TYPING_PATTERN.test(key),
  ).length
}

const requests = new Map<Computer.HelperOpName, ReturnType<typeof Computer.helperRequest>>()
const responses = new Map<Computer.HelperOpName, ReturnType<typeof Computer.helperResponse>>()
const requestSchema = (op: Computer.HelperOpName) =>
  requests.get(op) ?? requests.set(op, Computer.helperRequest(op)).get(op)!
const responseSchema = (op: Computer.HelperOpName) =>
  responses.get(op) ?? responses.set(op, Computer.helperResponse(op)).get(op)!
const pathOf = (identity: Computer.AppIdentity) =>
  identity.platform === "macos" ? identity.path : identity.platform === "windows" ? identity.exe : undefined
const ok = (result: object = {}, extra: { image?: Uint8Array; held?: readonly string[] } = {}): Outcome => ({
  ok: true,
  result,
  ...extra,
})

export function createFakeHelper(options: FakeOptions, io: FakeIo) {
  const clock = io.clock ?? systemClock
  const platform = options.platform ?? "macos"
  const desktop = createDesktop({ platform, scenario: options.scenario })
  // The virtual desktop has a fixed US layout and no app menu shortcuts; it never reads the owner's keyboard.
  const layout = {
    platform,
    keys: Object.fromEntries([
      ...Array.from("abcdefghijklmnopqrstuvwxyz", (key) => [
        `Key${key.toUpperCase()}`,
        { key, shift: key.toUpperCase() },
      ]),
      ...Array.from("0123456789", (key, index) => [`Digit${key}`, { key, shift: ")!@#$%^&*("[index] }]),
      ...Object.entries({
        Backquote: "`~",
        Minus: "-_",
        Equal: "=+",
        BracketLeft: "[{",
        BracketRight: "]}",
        Backslash: "\\|",
        Semicolon: ";:",
        Quote: "'\"",
        Comma: ",<",
        Period: ".>",
        Slash: "/?",
      }).map(([code, values]) => [code, { key: values[0], shift: values[1] }]),
    ]),
  }
  const range = options.protocol ?? identity.protocol
  const deny = new Set(options.deny ?? [])
  const disabled = new Set(options.disabled ?? [])
  // No helper supports locked use; Windows has no background mode and no clipboard ops (W2).
  const unsupported = new Set<Computer.HelperFeature>(
    platform === "windows" ? ["locked", "background", "clipboard"] : ["locked"],
  )
  const features: Record<Computer.HelperFeature, boolean> = Object.fromEntries(
    Computer.HelperFeature.literals.map((feature) => [feature, !unsupported.has(feature) && !disabled.has(feature)]),
  ) as Record<Computer.HelperFeature, boolean>
  const log: LogEntry[] = []
  const held = new Set<string>()
  const captures = new Map<string, Capture>()
  const programs: readonly FakeProgramArtifact[] = [
    ...(options.programs ?? [
      {
        path: platform === "macos" ? "/virtual/example.script" : "C:\\virtual\\example.script",
        name: "Example script",
        content: "virtual version 1",
        handler: "verified:virtual-test-runner",
      },
    ]),
    // These are virtual file facts, independent of whether the seeded app has a running process or trusted signer.
    ...desktop.apps().flatMap((app) => {
      const file = pathOf(app.identity)
      return app.regular && file
        ? [
            {
              path: file,
              name: app.identity.name,
              content: `virtual-app:${app.slot}:v1`,
              handler: `verified:direct-native:${platform}`,
            },
          ]
        : []
    }),
  ]
  const launchTokens = new Map<
    string,
    { program: Omit<Computer.NativeProgramLaunch, "token">; sessionId: string; expires: number }
  >()
  const queue: Request[] = []
  const state: {
    session?: Session
    halted?: "heartbeat" | "stop"
    locked: boolean
    secureInput: boolean
    watchdog?: unknown
    current?: { request: Request; keys: readonly string[]; timer: unknown }
    received: number
    captures: number
    sessions: number
    closed: boolean
  } = { locked: false, secureInput: false, received: 0, captures: 0, sessions: 0, closed: false }

  // Details never overwrite the entry's own time and kind.
  const record = (kind: string, detail: Record<string, unknown> = {}) =>
    void log.push({ ...detail, at: clock.now(), kind })
  const write = (body: unknown) => void (!state.closed && io.write(encodeFrame(body)))

  const reader = frameReader({
    maxBytes: Computer.LIMITS.helperFrameBytes,
    onOversize: (length) =>
      fail(0, "frame_too_large", `A ${length}-byte frame is over the ${Computer.LIMITS.helperFrameBytes}-byte limit`),
    onFrame: (bytes) => onFrame(bytes),
  })

  function onFrame(bytes: Uint8Array) {
    if (state.closed) return
    state.received++
    if (options.crashAfter !== undefined && state.received > options.crashAfter) return exit(1, "crash")
    const json = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(Buffer.from(bytes).toString("utf8"))
    const message = json._tag === "Some" && isRecord(json.value) ? json.value : undefined
    // Id 0 is reserved for failures that cannot be attributed, so a request carrying it is one of them.
    if (!message || !Number.isSafeInteger(message.id) || (message.id as number) < 1)
      return fail(0, "failed", "Malformed request: expected a JSON object with an integer id of at least 1")
    const id = message.id as number
    const op = message.op
    if (typeof op !== "string" || !Object.hasOwn(Computer.HelperOps, op))
      return fail(id, "unsupported_action", `Unknown op ${JSON.stringify(String(op).slice(0, 64))}`)
    const decoded = Schema.decodeUnknownExit(requestSchema(op as Computer.HelperOpName))(message)
    if (Exit.isFailure(decoded)) return fail(id, "failed", `Invalid arguments for ${op}`)
    const request = { id, args: decoded.value as unknown as Args }
    record("request", { id, op })
    if (op === "hello" && options.hangHello) return
    if (IMMEDIATE.has(op as Computer.HelperOpName)) {
      answer(request, run(request))
      if (op === "shutdown") return exit(0, "shutdown")
      return pump()
    }
    queue.push(request)
    pump()
  }

  // Serve queued ops one at a time; with `latencyMs` each answers later, and `input.hold` holds its keys for `ms`.
  function pump() {
    while (!state.current && !state.closed) {
      const request = queue.shift()
      if (!request) return
      const latency = options.latencyMs ?? 0
      if (request.args.op === "input.hold") {
        const outcome = run(request)
        if (!outcome.ok || !outcome.held) {
          answer(request, outcome)
          continue
        }
        const keys = outcome.held
        state.current = {
          request,
          keys,
          timer: clock.setTimeout(() => {
            state.current = undefined
            release(keys, "hold")
            answer(request, ok())
            pump()
          }, request.args.ms + latency),
        }
        return
      }
      if (latency === 0) {
        answer(request, run(request))
        continue
      }
      state.current = {
        request,
        keys: [],
        timer: clock.setTimeout(() => {
          state.current = undefined
          answer(request, run(request))
          pump()
        }, latency),
      }
      return
    }
  }

  function answer(request: Request, outcome: Outcome) {
    if (!outcome.ok) return fail(request.id, outcome.code, outcome.error)
    const op = request.args.op
    const response = { id: request.id, ok: true, ...outcome.result }
    if (!Schema.is(responseSchema(op))(response))
      throw new Error(`The fake helper built an invalid ${op} response: ${JSON.stringify(response)}`)
    if (outcome.image && outcome.image.length > Computer.LIMITS.helperFrameBytes)
      return fail(request.id, "frame_too_large", "The image is over the frame limit")
    record("response", { id: request.id, op, ok: true })
    write(response)
    if (outcome.image) write(outcome.image)
  }

  function fail(id: number, code: Computer.ComputerErrorCode, error: string) {
    const failure = { id, ok: false, code, error }
    if (!Schema.is(Computer.HelperFailure)(failure))
      throw new Error(`The fake helper built an invalid failure: ${code}`)
    record("response", { id, ok: false, code })
    write(failure)
  }

  function emit(event: Computer.HelperEvent) {
    if (!Schema.is(Computer.HelperEvent)(event))
      throw new Error(`The fake helper built an invalid event: ${JSON.stringify(event)}`)
    record("event", { event: event.event, message: event })
    write(event)
  }

  function exit(code: number, reason: string) {
    if (state.closed) return
    if (state.watchdog !== undefined) clock.clearTimeout(state.watchdog)
    if (state.current) clock.clearTimeout(state.current.timer)
    state.closed = true
    record("exit", { code, reason })
    io.exit(code)
  }

  /** Release every held key and button; recorded even when nothing was held. */
  function releaseAll(reason: string) {
    const keys = [...held]
    held.clear()
    record("release", { reason, keys })
    return keys.length
  }

  function release(keys: readonly string[], reason: string) {
    const released = keys.filter((key) => held.delete(key))
    if (released.length) record("release", { reason, keys: released })
  }

  function abortCurrent(code: Computer.ComputerErrorCode, error: string, reason: string, inputOnly: boolean) {
    const current = state.current
    if (!current || (inputOnly && !current.request.args.op.startsWith("input."))) return
    clock.clearTimeout(current.timer)
    state.current = undefined
    release(current.keys, reason)
    answer(current.request, refuse(code, error))
  }

  function armWatchdog() {
    if (state.watchdog !== undefined) clock.clearTimeout(state.watchdog)
    state.watchdog = clock.setTimeout(() => {
      state.watchdog = undefined
      releaseAll("heartbeat")
      state.halted = "heartbeat"
      record("halt", { reason: "heartbeat" })
      abortCurrent("stopped", "Input stopped: Vector sent no heartbeat", "heartbeat", true)
      pump()
    }, Computer.LIMITS.helperHaltMs)
  }

  function endSession(reason: string) {
    launchTokens.clear()
    if (!state.session) return
    releaseAll(reason)
    if (state.watchdog !== undefined) clock.clearTimeout(state.watchdog)
    state.watchdog = undefined
    state.session = undefined
    state.secureInput = false
    record("session", { action: "end", reason })
  }

  // ------------------------------------------------------------------------------------------------------------
  // Ownership: the never floor, Vector's own windows, and the full observed identities approved for the task.

  const signals = (window: FakeWindow) => (window.windowClass ? { windowClass: window.windowClass } : {})
  const excluded = () => state.session?.overlayWindowIds ?? new Set<string>()
  const isVector = (window: FakeWindow) => {
    const app = desktop.appOf(window)
    return (
      Boolean(state.session?.vectorWindowIds.has(window.windowId) || state.session?.vectorPids.has(app.pid)) ||
      blocklist.category(app.identity, signals(window)) === "vector"
    )
  }
  const isProtected = (window: FakeWindow) =>
    isVector(window) || blocklist.isProtected(desktop.appOf(window).identity, signals(window))
  // What the helper can tell is a password field: nothing when `ui.secureFieldDetect` is off.
  const secure = (item: FakeNode | undefined) => features["ui.secureFieldDetect"] && (item?.secure ?? false)
  // Text input checks after the owner: a secure field first, then a click-only (developer) app, in D16's order.
  const textRefusal = (window: FakeWindow, item: FakeNode | undefined) => {
    if (secure(item)) return refuse("secure_field", "That is a password field")
    if (blocklist.isClickOnly(desktop.appOf(window).identity, signals(window)))
      return refuse("blocked", `${desktop.appOf(window).identity.name} is click-only: typing text into it is refused`)
  }
  const validIdentity = Schema.is(Computer.AppIdentity)
  function approvedIdentity(identity: Computer.AppIdentity, pid: number) {
    const expected = state.session?.approved.get(Computer.appKey(identity))
    if (
      !validIdentity(identity) ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      !expected ||
      identity.platform === "remote" ||
      expected.platform === "remote" ||
      identity.platform !== expected.platform ||
      identity.verified !== expected.verified
    )
      return false
    if (identity.platform === "macos" && expected.platform === "macos") {
      if (identity.apple !== expected.apple || identity.teamId?.toLowerCase() !== expected.teamId?.toLowerCase())
        return false
      if (identity.verified)
        return identity.apple || Boolean(identity.teamId && /^[A-Z0-9]{10}$/i.test(identity.teamId))
    }
    if (identity.platform === "windows" && expected.platform === "windows") {
      if (identity.kind !== expected.kind || identity.publisher?.toLowerCase() !== expected.publisher?.toLowerCase())
        return false
      if (identity.verified)
        return (
          identity.kind === "aumid" ||
          Boolean(identity.publisher.trim() && identity.publisher.trim().toLowerCase() !== "unsigned")
        )
    }
    const file = pathOf(identity)
    const fs = identity.platform === "macos" ? path.posix : path.win32
    return Boolean(
      file &&
        !file.includes("\0") &&
        fs.isAbsolute(file) &&
        fs.normalize(file) === file &&
        file === pathOf(expected) &&
        typeof identity.pid === "number" &&
        Number.isSafeInteger(identity.pid) &&
        identity.pid > 0 &&
        identity.pid === pid &&
        identity.pid === expected.pid,
    )
  }
  const isApproved = (window: FakeWindow) => {
    const app = desktop.appOf(window)
    return approvedIdentity(app.identity, app.pid)
  }
  const hiddenOwner = (window: FakeWindow) => {
    if (window.windowId === OVERLAY || excluded().has(window.windowId)) return
    const app = desktop.appOf(window)
    return app.regular ? Computer.appKey(app.identity) : undefined
  }
  // Without `capture.exclude` the overlay is drawn like any other Vector window; it still takes no clicks.
  const paint = (window: FakeWindow): Paint => {
    if (features["capture.exclude"] && excluded().has(window.windowId)) return "exclude"
    if (isVector(window)) return "vector"
    const identity = desktop.appOf(window).identity
    if (blocklist.isProtected(identity, signals(window))) return "mask"
    if (blocklist.category(identity, signals(window)) === "system-ui") return "show"
    return isApproved(window) ? "show" : "mask"
  }
  const owner = (window: FakeWindow) => {
    const name = desktop.appOf(window).identity.name
    if (isProtected(window)) return refuse("protected", `${name} is protected`)
    if (!isApproved(window)) return refuse("not_granted", `${name} is not approved for this task`)
  }
  const permissions = (): Computer.PermissionsStatus =>
    platform === "macos"
      ? {
          screen: deny.has("screen") ? "denied" : "granted",
          accessibility: deny.has("accessibility") ? "denied" : "granted",
        }
      : { screen: "n/a", accessibility: "n/a", captureBlocked: deny.has("screen") }
  const accessibility = () =>
    platform === "macos" && deny.has("accessibility")
      ? refuse("permissions", "Accessibility is not granted")
      : undefined
  // Halted first, so input after a missed heartbeat answers `stopped` whatever it names. Bringing an app or window
  // forward (`app.activate`, `app.launch`, `window.focus`) passes the same halt and lock checks (M8).
  const actGate = () => {
    if (state.halted === "heartbeat") return refuse("stopped", "Input stopped: Vector sent no heartbeat")
    if (state.halted === "stop") return refuse("stopped", "Stopped by the user")
    if (state.locked) return refuse("locked", "The screen is locked")
    if (state.session?.paused) return refuse("paused", "Vector Hands is paused")
  }
  const inputGate = () => actGate() ?? accessibility()
  const background = () => state.session?.mode === "background"
  // Alongside me never moves the user's pointer or takes focus: a step that would answers this, with no side effect,
  // so the desktop can raise the pointer ask (M9, D19).
  const needsForeground = (what: string) => refuse("needs_foreground", `${what} needs the foreground`)

  // Secure event input is a macOS state (M6), on while a password field has focus; Windows has no such signal.
  function checkSecureInput(force = false) {
    const on = Boolean(platform === "macos" && state.session?.mode === "foreground" && desktop.focusedNode()?.secure)
    if (on === state.secureInput && !force) return
    state.secureInput = on
    emit(
      state.session?.phaseRevision !== undefined && features["userInput.detect"] !== true
        ? { event: "input_detection", alive: false, reason: "probe_missing" }
        : on
          ? {
              event: "input_detection",
              alive: false,
              reason: "secure_input",
              holder: desktop.frontmost().identity.name,
            }
          : { event: "input_detection", alive: true },
    )
  }

  function halt(by: "esc" | "chord") {
    releaseAll("stop")
    state.halted = "stop"
    record("halt", { reason: "stop", by })
    emit({ event: "stop", by })
    abortCurrent("stopped", "Stopped by the user", "stop", true)
    pump()
  }

  // ------------------------------------------------------------------------------------------------------------
  // Captures and coordinates

  function store(capture: Capture) {
    const captureId = `cap_${++state.captures}`
    captures.set(captureId, capture)
    if (captures.size > MAX_CAPTURES) captures.delete(captures.keys().next().value!)
    return captureId
  }

  function image(capture: Capture, frame: ReturnType<typeof render>) {
    const display = desktop.display(capture.displayId)
    return ok(
      {
        captureId: store(capture),
        width: capture.width,
        height: capture.height,
        origin: capture.origin,
        imageScale: capture.scale,
        ...(display?.dpiScale ? { dpiScale: display.dpiScale } : {}),
        displayId: capture.displayId,
        capturedAtMs: clock.now(),
        masked: frame.masked,
        hiddenCount: frame.hiddenCount,
        hash: frame.hash,
        imageBytes: frame.png.length,
      },
      { image: frame.png },
    )
  }

  const sameRect = (a: Rect | undefined, b: Rect | undefined) =>
    Boolean(a && b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h)
  const contains = (rect: Rect, point: { x: number; y: number }) =>
    point.x >= rect.x && point.x < rect.x + rect.w && point.y >= rect.y && point.y < rect.y + rect.h

  function stale(capture: Capture) {
    if (capture.snapshot.displayGeneration !== desktop.displayGeneration)
      return refuse("stale_frame", "The display configuration changed since the capture")
    if (capture.kind !== "window") return
    const window = desktop.window(capture.windowId!)
    const then = capture.snapshot.windows.find((item) => item.windowId === capture.windowId)?.bounds
    if (!window || window.minimized || !sameRect(window.bounds, then))
      return refuse("stale_frame", "The window moved or resized since the capture")
  }

  function capturePoint(capture: Capture, x: number, y: number) {
    return { x: capture.origin.x + (x + 0.5) / capture.scale, y: capture.origin.y + (y + 0.5) / capture.scale }
  }

  /** Map a pixel of a full capture to the window under it now, after the coordinate and owner checks. */
  function locate(captureId: string, x: number, y: number, ownership: boolean): Target | Refusal {
    const capture = captures.get(captureId)
    if (!capture || capture.kind === "zoom")
      return refuse("stale_frame", "Coordinates must name a full capture; a zoom does not replace it")
    const changed = stale(capture)
    if (changed) return changed
    if (x < 0 || y < 0 || x >= capture.width || y >= capture.height)
      return refuse("out_of_bounds", "The point is outside the capture")
    const point = capturePoint(capture, x, y)
    const thenId =
      capture.kind === "window"
        ? capture.windowId
        : capture.snapshot.windows.find((item) => !excluded().has(item.windowId) && contains(item.bounds, point))
            ?.windowId
    const then = thenId ? desktop.window(thenId) : undefined
    const thenBounds = capture.snapshot.windows.find((item) => item.windowId === thenId)?.bounds
    if (!then || then.minimized || !sameRect(then.bounds, thenBounds))
      return refuse("stale_frame", "The window under the point moved since the capture")
    const now = desktop.topAt(point, excluded())
    if (!now) return refuse("out_of_bounds", "Nothing is at that point")
    if (ownership) {
      const blocked = owner(now)
      if (blocked) return blocked
      if (now.windowId !== thenId)
        return capture.kind === "window"
          ? refuse("occluded", "Another window now covers that point")
          : refuse("changed", "A different window is at that point now")
    }
    return { ok: true, window: now, node: desktop.nodeAt(now, point) }
  }

  function expectedTarget(
    target: Target,
    expected: { pid?: number; windowId?: string; ref?: string; elementId?: string },
  ) {
    if (
      (expected.pid !== undefined && expected.pid !== desktop.appOf(target.window).pid) ||
      (expected.windowId !== undefined && expected.windowId !== target.window.windowId) ||
      (expected.ref !== undefined && expected.ref !== refOf(target.window, target.node)) ||
      (expected.elementId !== undefined && expected.elementId !== elementIdOf(target.window, target.node))
    )
      return refuse("changed", "The target changed before input")
  }

  function pointer(expected: {
    captureId: string
    x: number
    y: number
    pid?: number
    windowId?: string
    ref?: string
    elementId?: string
  }): Target | Refusal {
    const target = inputGate() ?? locate(expected.captureId, expected.x, expected.y, true)
    if (!target.ok) return target
    return expectedTarget(target, expected) ?? target
  }

  function keyboard(expected: { pid: number; windowId?: string; ref?: string; elementId?: string }): Target | Refusal {
    const gate = inputGate()
    if (gate) return gate
    const target = background() ? directed(expected.pid) : focused(expected.pid)
    if (!target.ok) return target
    return expectedTarget(target, expected) ?? target
  }

  function focused(pid: number): Target | Refusal {
    const app = desktop.frontmost()
    const window = desktop.windowsOf(app.slot).find((item) => !item.minimized)
    if (!window) return refuse("not_foreground", "No window has keyboard focus")
    const blocked = owner(window)
    if (blocked) return blocked
    if (app.pid !== pid) return refuse("changed", "The focused app is not the one the step named")
    return { ok: true, window, node: desktop.focusedNode() }
  }

  // In the background keys are app-directed: they go to the app the step named, in front or not, and to that app's own
  // focused element, so nothing takes focus. Showing a minimized window would, so that waits for the user (M9).
  function directed(pid: number): Target | Refusal {
    const app = desktop.apps().find((item) => item.running && item.pid === pid)
    const windows = app ? desktop.windowsOf(app.slot) : []
    const window = windows.find((item) => !item.minimized) ?? windows[0]
    if (!app || !window) return refuse("app_not_found", "No running app has that pid")
    const blocked = owner(window)
    if (blocked) return blocked
    if (window.minimized) return needsForeground(`Typing into minimized ${app.identity.name}`)
    return { ok: true, window, node: desktop.focusedNode(app.slot) }
  }

  const refOf = (window: FakeWindow, item?: FakeNode) =>
    `${desktop.generation}:${window.windowId}${item ? `:${item.id}` : ""}`
  const elementIdOf = (window: FakeWindow, item?: FakeNode) =>
    `${state.sessions}:${window.windowId}:${item?.id ?? "window"}`

  function resolve(ref: string): Target | Refusal {
    const [generation, windowId, ...rest] = ref.split(":")
    const window = windowId ? desktop.window(windowId) : undefined
    const item = rest.length ? window?.nodes.find((entry) => entry.id === rest.join(":")) : undefined
    if (generation !== String(desktop.generation) || !window || (rest.length && !item))
      return refuse("stale_ref", "The element changed since the UI tree was read")
    return owner(window) ?? { ok: true, window, node: item }
  }

  // What a hit-test may reveal: the owner and window always, so the desktop can ask for or refuse the app; the
  // element's identity, name, window title and menu context only for an approved app that is not protected.
  function hit(window: FakeWindow, item?: FakeNode) {
    const visible = !isProtected(window) && isApproved(window)
    return {
      ...(visible
        ? {
            ref: refOf(window, item),
            elementId: elementIdOf(window, item),
            name: item?.name ?? window.title,
            windowTitle: window.title,
            layout,
            focusedMenuShortcuts: [],
          }
        : {}),
      role: item?.role ?? "AXWindow",
      secure: secure(item),
      enabled: true,
      editable: item?.editable ?? false,
      owner: desktop.appOf(window).identity,
      windowId: window.windowId,
      signals: signals(window),
      // The virtual desktop's notes/fields are memory-only; it does not fabricate filesystem documents.
      documentStatus: "none" as const,
    }
  }

  function ownerOfApp(slot: string) {
    const window = desktop.windowsOf(slot)[0]
    if (window) return owner(window)
    const app = desktop.app(slot)!
    if (blocklist.isProtected(app.identity) || blocklist.category(app.identity) === "vector")
      return refuse("protected", `${app.identity.name} is protected`)
    if (!approvedIdentity(app.identity, app.pid))
      return refuse("not_granted", `${app.identity.name} is not approved for this task`)
  }

  // A background click goes through the element under the point: a button is pressed (AXPress) and a text field is
  // focused inside its app (AXFocused), so nothing moves the pointer or comes to the front. A click no element can
  // stand in for (no element, nothing to press or focus, another button, a double click, modifiers) needs the
  // foreground, so `needsForeground` in M9 is true only for a coordinate step with no usable element path.
  function elementClick(target: Target, args: Extract<Args, { op: "input.click" }>): Outcome {
    const item = target.node
    const plain = args.button === "left" && args.count === 1 && args.modifiers.length === 0
    if (!plain || !item || (!item.press && !item.editable)) return needsForeground("That click")
    if (item.press) desktop.press(item)
    else desktop.select(target.window.windowId, item.id)
    record("input", { op: "click", windowId: target.window.windowId, node: item.id, button: "left", count: 1 })
    return ok()
  }

  // ------------------------------------------------------------------------------------------------------------
  // Ops

  const featureOf = (args: Args): Computer.HelperFeature | undefined => {
    switch (args.op) {
      case "capture":
        if (args.zoom) return "capture.zoom"
        return "display" in args.target ? "capture.display" : "capture.window"
      case "ui.tree":
        return "ui.tree"
      case "cursor.position":
        return "cursor.position"
      case "ui.perform":
      case "ui.setValue":
        return "ui.actions"
      case "input.click":
      case "input.move":
      case "input.drag":
      case "input.scroll":
        return "input.pointer"
      case "input.key":
      case "input.hold":
        return "input.keyboard"
      case "input.type":
        return "input.unicode"
      case "apps.list":
        return "apps.list"
      case "apps.resolve":
        return "apps.resolve"
      case "program.launch":
        return "program.launch"
      case "app.activate":
      case "app.launch":
      case "window.focus":
        return "apps.open"
      case "clipboard.read":
      case "clipboard.write":
        return "clipboard"
    }
  }

  function run(request: Request): Outcome {
    const args = request.args
    const feature = featureOf(args)
    if (feature && !features[feature]) return refuse("unsupported_action", `This helper has ${feature} turned off`)
    if (!SESSIONLESS.has(args.op) && !state.session) return refuse("unavailable", "No session is active")
    if (
      (args.op.startsWith("input.") && args.op !== "input.releaseAll") ||
      [
        "app.activate",
        "app.launch",
        "program.launch",
        "window.focus",
        "ui.perform",
        "ui.setValue",
        "clipboard.write",
      ].includes(args.op)
    ) {
      const gate = actGate()
      if (gate) return gate
      const session = state.session!
      if (
        session.phaseRevision !== undefined &&
        (!("sessionId" in args) ||
          args.sessionId !== session.sessionId ||
          !("phaseRevision" in args) ||
          args.phaseRevision !== session.phaseRevision)
      )
        return refuse("changed", "The computer session phase changed")
    }
    switch (args.op) {
      case "hello":
        if (args.protocol.max < range.min || args.protocol.min > range.max)
          return refuse("helper_incompatible", `This helper speaks protocol ${range.min} to ${range.max}`)
        return ok({
          protocol: { min: range.min, max: range.max },
          helper: {
            version: identity.helperVersion,
            platform,
            arch: process.arch,
            os: platform === "macos" ? "macOS 15.0 (fake)" : "Windows 11 (fake)",
          },
          features,
          permissions: permissions(),
          limits: { maxFrameBytes: Computer.LIMITS.helperFrameBytes },
          responsible: true,
        })
      case "permissions.status":
        return ok(permissions())
      case "permissions.request":
      case "permissions.reset":
        // Windows has no grant to prompt for or reset (W2).
        if (platform === "windows") return refuse("unsupported_action", `${args.op} is macOS only`)
        record("permissions", { action: args.op, service: args.service })
        return ok(permissions())
      case "session.begin":
        if (args.mode === "background" && !features.background)
          return refuse("unsupported_action", "This helper cannot work in the background")
        launchTokens.clear()
        state.sessions++
        state.session = {
          sessionId: args.sessionId,
          ...(args.phaseRevision === undefined ? {} : { phaseRevision: args.phaseRevision }),
          mode: args.mode,
          paused: args.paused === true,
          approved: new Map(args.approved.map((app) => [Computer.appKey(app), structuredClone(app)])),
          vectorPids: new Set(args.vectorPids),
          vectorWindowIds: new Set(args.vectorWindowIds),
          overlayWindowIds: new Set(args.overlayWindowIds),
          escStops: args.escStops,
          stopChord: args.stopChord,
        }
        state.halted = undefined
        record("session", { action: "begin", sessionId: args.sessionId, mode: args.mode })
        armWatchdog()
        checkSecureInput(args.phaseRevision !== undefined)
        return ok()
      case "session.update": {
        if (args.mode === "background" && !features.background)
          return refuse("unsupported_action", "This helper cannot work in the background")
        const session = state.session!
        if (
          (args.sessionId !== undefined && args.sessionId !== session.sessionId) ||
          (session.phaseRevision !== undefined &&
            (args.sessionId !== session.sessionId ||
              args.phaseRevision === undefined ||
              args.phaseRevision < session.phaseRevision))
        )
          return refuse("changed", "The computer session phase changed")
        if (session.physicalPause && args.paused === false)
          return refuse("changed", "Physical take-over needs a fresh session")
        state.session = {
          ...session,
          ...(args.phaseRevision === undefined ? {} : { phaseRevision: args.phaseRevision }),
          ...(args.mode ? { mode: args.mode } : {}),
          ...(args.escStops === undefined ? {} : { escStops: args.escStops }),
          ...(args.paused === undefined ? {} : { paused: args.paused }),
          ...(args.approved
            ? { approved: new Map(args.approved.map((app) => [Computer.appKey(app), structuredClone(app)])) }
            : {}),
          ...(args.overlayWindowIds ? { overlayWindowIds: new Set(args.overlayWindowIds) } : {}),
        }
        record("session", { action: "update" })
        checkSecureInput()
        return ok()
      }
      case "session.end":
        endSession("session.end")
        return ok()
      case "heartbeat":
        if (state.session) armWatchdog()
        return ok()
      case "displays.list":
        return ok({
          displays: desktop.displays.map((display) => ({
            id: display.id,
            bounds: display.bounds,
            pixelSize: { w: display.bounds.w * display.scale, h: display.bounds.h * display.scale },
            scale: display.scale,
            ...(display.dpiScale ? { dpiScale: display.dpiScale } : {}),
            primary: display.primary,
          })),
        })
      case "cursor.position": {
        if (state.locked) return refuse("locked", "The screen is locked")
        const point = desktop.cursor
        const display = desktop.displays.find((display) => contains(display.bounds, point))
        if (!display) return refuse("out_of_bounds", "The pointer is not on an available display")
        return ok({ ...point, displayId: display.id })
      }
      case "apps.list":
        return ok({
          apps: desktop
            .apps()
            .filter((app) => app.regular && (app.running || args.installed))
            .map((app) => ({
              identity: wireIdentity(app),
              active: app.running && desktop.frontmost().slot === app.slot,
              windows: app.running
                ? desktop.windowsOf(app.slot).map((window) => ({
                    windowId: window.windowId,
                    title: isProtected(window) ? "" : window.title,
                    bounds: window.bounds,
                    minimized: window.minimized,
                    onScreen: !window.minimized,
                  }))
                : [],
            })),
        })
      case "apps.resolve": {
        const resolved = resolveLaunch(args.path)
        if ("ok" in resolved) return resolved
        if (resolved.kind !== "program") return ok(resolved)
        const program = resolved.program
        const token = randomUUID()
        for (const [key, entry] of launchTokens) if (entry.expires <= clock.now()) launchTokens.delete(key)
        if (launchTokens.size >= 1000) return refuse("busy", "Too many launch resolutions are pending")
        launchTokens.set(token, { program, sessionId: state.session!.sessionId, expires: clock.now() + 30_000 })
        return ok({ kind: "program", program: { ...program, token } })
      }
      case "program.launch": {
        const prepared = launchTokens.get(args.token)
        launchTokens.delete(args.token)
        if (
          !prepared ||
          prepared.sessionId !== state.session!.sessionId ||
          prepared.expires <= clock.now() ||
          args.binding !== prepared.program.binding
        )
          return refuse("changed", "The program launch resolution changed")
        const current = resolveLaunch(prepared.program.path)
        if ("ok" in current) return current
        if (current.kind === "protected") return refuse("protected", "The launch handler is protected")
        if (
          current.kind !== "program" ||
          !ComputerProgram.same(
            ComputerProgram.publicLaunch(prepared.program),
            ComputerProgram.publicLaunch(current.program),
          )
        )
          return refuse("changed", "The program or its launch handler changed")
        if (background()) return needsForeground("Launching this program")
        const app = desktop.apps().find((item) => pathOf(item.identity) === prepared.program.path)
        if (app) desktop.activate(app.slot)
        record("program", { action: "launch", key: prepared.program.key })
        checkSecureInput()
        return ok({ launched: true })
      }
      case "app.activate": {
        const gate = actGate()
        if (gate) return gate
        const key = Computer.appKey(args.identity)
        const app = desktop.apps().find((item) => item.running && Computer.appKey(item.identity) === key)
        if (!app) return refuse("app_not_found", "That app is not running")
        const blocked = ownerOfApp(app.slot)
        if (blocked) return blocked
        if (background()) return needsForeground(`Bringing ${app.identity.name} to the front`)
        desktop.activate(app.slot)
        record("app", { action: "activate", app: app.slot })
        checkSecureInput()
        return ok({ foreground: true })
      }
      case "app.launch": {
        const gate = actGate()
        if (gate) return gate
        const app = desktop
          .apps()
          .find((item) =>
            "identity" in args
              ? Computer.appKey(item.identity) === Computer.appKey(args.identity)
              : pathOf(item.identity) === args.path,
          )
        if (!app || !app.regular) return refuse("app_not_found", "No such app is installed")
        const blocked = ownerOfApp(app.slot)
        if (blocked) return blocked
        if (!app.running && !app.identity.verified)
          return refuse("not_granted", "An unsigned program needs a fresh program launch token")
        // The fake's launch always activates, so in the background it waits for the user too.
        if (background()) return needsForeground(`Opening ${app.identity.name}`)
        desktop.activate(app.slot)
        record("app", { action: "launch", app: app.slot })
        checkSecureInput()
        return ok({ foreground: true })
      }
      case "window.focus": {
        const gate = actGate()
        if (gate) return gate
        const window = desktop.window(args.windowId)
        if (!window || !desktop.appOf(window).running) return refuse("failed", "No such window")
        const blocked = owner(window)
        if (blocked) return blocked
        if (background()) return needsForeground(`Bringing ${window.title || "that window"} to the front`)
        desktop.focus(window.windowId)
        record("app", { action: "focus", windowId: window.windowId })
        checkSecureInput()
        return ok({ foreground: true })
      }
      case "capture":
        return capture(args)
      case "ui.tree": {
        if (state.locked) return refuse("locked", "The screen is locked")
        const denied = accessibility()
        if (denied) return denied
        const app = "pid" in args ? desktop.apps().find((item) => item.running && item.pid === args.pid) : undefined
        const windows =
          "windowId" in args
            ? [desktop.window(args.windowId)].filter((window): window is FakeWindow => window !== undefined)
            : app
              ? desktop.windowsOf(app.slot)
              : []
        if (!windows.length) return refuse("app_not_found", "No such app or window")
        const blocked = windows.map(owner).find((item) => item !== undefined)
        if (blocked) return blocked
        const focused = desktop.focusedNode()
        const nodes = windows.flatMap((window) => [
          {
            ref: refOf(window),
            role: "AXWindow",
            name: window.title,
            bounds: window.bounds,
            enabled: true,
            focused: false,
            secure: false,
          },
          ...(args.maxDepth < 2
            ? []
            : window.nodes.map((item) => ({
                ref: refOf(window, item),
                role: item.role,
                name: item.name,
                ...(item.value !== undefined && !item.secure ? { value: item.value } : {}),
                bounds: { ...item.rect, x: window.bounds.x + item.rect.x, y: window.bounds.y + item.rect.y },
                enabled: true,
                focused: item === focused,
                secure: secure(item),
              }))),
        ])
        const cut = args.maxDepth < 2 && windows.some((window) => window.nodes.length > 0)
        return ok({
          generation: desktop.generation,
          truncated: cut || nodes.length > args.maxNodes,
          nodes: nodes.slice(0, args.maxNodes),
        })
      }
      case "ui.hittest": {
        if (state.locked) return refuse("locked", "The screen is locked")
        const denied = accessibility()
        if (denied) return denied
        const target = locate(args.captureId, args.x, args.y, false)
        if (!target.ok) return target
        return ok(hit(target.window, target.node))
      }
      case "ui.focused": {
        if (state.locked) return refuse("locked", "The screen is locked")
        const denied = accessibility()
        if (denied) return denied
        const window = desktop.windowsOf(desktop.frontmost().slot).find((item) => !item.minimized)
        if (!window) return refuse("not_foreground", "No window has keyboard focus")
        return ok(hit(window, desktop.focusedNode()))
      }
      case "ui.resolve": {
        if (state.locked) return refuse("locked", "The screen is locked")
        const target = accessibility() ?? resolve(args.ref)
        if (!target.ok) return target
        return ok(hit(target.window, target.node))
      }
      case "ui.perform": {
        const target = inputGate() ?? resolve(args.ref)
        if (!target.ok) return target
        const changed = expectedTarget(target, args)
        if (changed) return changed
        const item = target.node
        const raise = args.action === "AXRaise" && !item
        if (raise && background()) return needsForeground("Raising a window")
        record("ui", { action: args.action, windowId: target.window.windowId, node: item?.id })
        if (args.action === (options.platform === "windows" ? "Invoke" : "AXPress") && item?.press)
          return ok({ took: desktop.press(item) })
        if (!raise) return ok({ took: false })
        desktop.raise(target.window.windowId)
        checkSecureInput()
        return ok({ took: true })
      }
      case "ui.setValue": {
        const target = inputGate() ?? resolve(args.ref)
        if (!target.ok) return target
        const changed = expectedTarget(target, args)
        if (changed) return changed
        const item = target.node
        const refused = textRefusal(target.window, item)
        if (refused) return refused
        if (!item?.editable) return ok({ took: false })
        desktop.setValue(item, args.value)
        record("ui", { action: "setValue", windowId: target.window.windowId, node: item.id, length: args.value.length })
        return ok({ took: true })
      }
      case "input.click": {
        const target = pointer(args)
        if (!target.ok) return target
        const item = target.node
        if (background()) return elementClick(target, args)
        desktop.cursor = capturePoint(captures.get(args.captureId)!, args.x, args.y)
        desktop.focus(target.window.windowId, item?.editable ? item.id : undefined)
        if (item?.press) desktop.press(item)
        record("input", {
          op: "click",
          windowId: target.window.windowId,
          node: item?.id,
          button: args.button,
          count: args.count,
        })
        checkSecureInput()
        return ok()
      }
      case "input.move":
      case "input.scroll": {
        const target = pointer(args)
        if (!target.ok) return target
        // The fake's elements have no scroll action, so in the background both need the real pointer.
        if (background()) return needsForeground(args.op === "input.move" ? "Moving the pointer" : "Scrolling there")
        desktop.cursor = capturePoint(captures.get(args.captureId)!, args.x, args.y)
        record("input", {
          op: args.op === "input.move" ? "move" : "scroll",
          windowId: target.window.windowId,
          ...(args.op === "input.scroll" ? { dx: args.dx, dy: args.dy, unit: args.unit ?? "wheel" } : {}),
        })
        return ok()
      }
      case "input.drag": {
        const gate = inputGate()
        if (gate) return gate
        if (args.targets && args.targets.length !== args.path.length)
          return refuse("changed", "The drag target count changed")
        const targets = args.path.map((point) => locate(args.captureId, point.x, point.y, true))
        const blocked = targets.find((target): target is Refusal => !target.ok)
        if (blocked) return blocked
        for (let index = 0; index < targets.length; index++) {
          const target = targets[index]!
          if (!target.ok) return target
          const expected = args.targets?.[index]
          const changed = expected && expectedTarget(target, expected)
          if (changed) return changed
        }
        if (background()) return needsForeground("Dragging")
        // The virtual drag has no asynchronous intermediate movement; re-resolve its final release target anyway.
        const end = args.path.at(-1)!
        const release = locate(args.captureId, end.x, end.y, true)
        if (!release.ok) return release
        const expected = args.targets?.at(-1)
        const changed = expected && expectedTarget(release, expected)
        if (changed) return changed
        desktop.cursor = capturePoint(captures.get(args.captureId)!, end.x, end.y)
        record("input", { op: "drag", points: args.path.length, button: args.button })
        return ok()
      }
      case "input.key": {
        const target = keyboard(args)
        if (!target.ok) return target
        const typed = typedKeys(args.combo, platform)
        const refused = typed ? textRefusal(target.window, target.node) : undefined
        if (refused) return refused
        const windowId = target.window.windowId
        // Keys that type are logged as a length, as `input.type` is; shortcuts and navigation keep their combo.
        record(
          "input",
          typed
            ? { op: "key", windowId, types: true, length: typed * args.repeat }
            : { op: "key", windowId, combo: args.combo, repeat: args.repeat },
        )
        return ok()
      }
      case "input.type": {
        const target = keyboard(args)
        if (!target.ok) return target
        const item = target.node
        const refused = textRefusal(target.window, item)
        if (refused) return refused
        if (item?.editable) desktop.setValue(item, `${item.value ?? ""}${args.text}`)
        // Typed text stays out of the log, as in the native helpers' reports: only its length.
        record("input", { op: "type", windowId: target.window.windowId, node: item?.id, length: args.text.length })
        return ok()
      }
      case "input.hold": {
        const target = keyboard(args)
        if (!target.ok) return target
        const typed = typedKeys(args.combo, platform) > 0
        const refused = typed ? textRefusal(target.window, target.node) : undefined
        if (refused) return refused
        // A held typing key goes by an opaque name, so neither this entry nor its release names the character.
        const keys = args.combo.map((key, index) =>
          typed && typedKeys([key], platform) ? `key:text-${index}` : `key:${key}`,
        )
        keys.forEach((key) => held.add(key))
        const windowId = target.window.windowId
        record(
          "input",
          typed
            ? { op: "hold", windowId, types: true, ms: args.ms }
            : { op: "hold", windowId, combo: args.combo, ms: args.ms },
        )
        return ok({}, { held: keys })
      }
      case "input.releaseAll": {
        // A hold in flight ends with its keys: it answers before the release does.
        const released = releaseAll("request")
        abortCurrent("failed", "Input was released", "request", true)
        return ok({ released })
      }
      case "clipboard.read":
        return ok({ text: desktop.clipboard })
      case "clipboard.write": {
        const gate = actGate()
        if (gate) return gate
        desktop.clipboard = args.text
        record("clipboard", { action: "write", length: args.text.length })
        return ok()
      }
      case "cancel": {
        const queued = args.target === undefined ? -1 : queue.findIndex((item) => item.id === args.target)
        if (queued !== -1) answer(queue.splice(queued, 1)[0]!, refuse("failed", "Cancelled"))
        else if (state.current && (args.target === undefined || state.current.request.id === args.target))
          abortCurrent("failed", "Cancelled", "cancel", false)
        return ok()
      }
      case "shutdown":
        releaseAll("shutdown")
        abortCurrent("stopped", "The helper is shutting down", "shutdown", false)
        queue.splice(0).forEach((item) => answer(item, refuse("stopped", "The helper is shutting down")))
        endSession("shutdown")
        return ok()
    }
  }

  function capture(args: Extract<Args, { op: "capture" }>): Outcome {
    if (platform === "macos" && deny.has("screen")) return refuse("permissions", "Screen Recording is not granted")
    if (platform === "windows" && deny.has("screen"))
      return refuse("blocked_by_os", "Windows blocks screen capture for desktop apps")
    if (state.locked) return refuse("locked", "The screen is locked")
    if (args.zoom) {
      const source = captures.get(args.zoom.captureId)
      if (!source || source.kind === "zoom") return refuse("stale_frame", "A zoom needs a full capture")
      const changed = stale(source)
      if (changed) return changed
      const window = source.windowId ? desktop.window(source.windowId) : undefined
      const blocked = window ? owner(window) : undefined
      if (blocked) return blocked
      const region = args.zoom.region
      if (
        region.x0 < 0 ||
        region.y0 < 0 ||
        region.x1 > source.width ||
        region.y1 > source.height ||
        region.x0 >= region.x1 ||
        region.y0 >= region.y1
      )
        return refuse("out_of_bounds", "The region is outside the capture")
      // The region again at the display's native resolution, painted by the same rules as every frame.
      const origin = { x: source.origin.x + region.x0 / source.scale, y: source.origin.y + region.y0 / source.scale }
      const units = { w: (region.x1 - region.x0) / source.scale, h: (region.y1 - region.y0) / source.scale }
      const native = desktop.display(source.displayId)!.scale
      const size = fit(units.w * native, units.h * native, args.budget)
      const scale = size.scale * native
      const frame = render({
        windows: window ? [window] : desktop.stack(),
        paint: window ? () => "show" : paint,
        hiddenOwner,
        origin,
        scale,
        width: size.width,
        height: size.height,
      })
      return image({ ...source, kind: "zoom", origin, scale, width: size.width, height: size.height }, frame)
    }
    if ("display" in args.target) {
      const display = desktop.display(args.target.display)
      if (!display) return refuse("capture_unavailable", "No such display")
      // fit's scale is per native pixel; times the display's scale it is image pixels per helper unit, and it is the
      // one scale both sides were cut with, so the last column and row still map inside the display.
      const size = fit(display.bounds.w * display.scale, display.bounds.h * display.scale, args.budget)
      const scale = size.scale * display.scale
      const origin = { x: display.bounds.x, y: display.bounds.y }
      const frame = render({
        windows: desktop.stack(),
        paint,
        hiddenOwner,
        origin,
        scale,
        width: size.width,
        height: size.height,
      })
      return image(
        {
          kind: "display",
          displayId: display.id,
          origin,
          scale,
          width: size.width,
          height: size.height,
          snapshot: desktop.snapshot(),
        },
        frame,
      )
    }
    const window = desktop.window(args.target.windowId)
    if (!window || !desktop.appOf(window).running) return refuse("failed", "No such window")
    const blocked = owner(window)
    if (blocked) return blocked
    if (window.minimized) return ok({ paused: true })
    const center = { x: window.bounds.x + window.bounds.w / 2, y: window.bounds.y + window.bounds.h / 2 }
    const display = desktop.displayAt(center)
    const size = fit(window.bounds.w * display.scale, window.bounds.h * display.scale, args.budget)
    const scale = size.scale * display.scale
    const origin = { x: window.bounds.x, y: window.bounds.y }
    // A window capture holds that window's own content only, never what overlaps it.
    const frame = render({
      windows: [window],
      paint: () => "show",
      hiddenOwner,
      origin,
      scale,
      width: size.width,
      height: size.height,
    })
    return image(
      {
        kind: "window",
        displayId: display.id,
        origin,
        scale,
        width: size.width,
        height: size.height,
        windowId: window.windowId,
        snapshot: desktop.snapshot(),
      },
      frame,
    )
  }

  function wireIdentity(app: FakeApp): Computer.AppIdentity {
    if (app.running || !("pid" in app.identity)) return app.identity
    const { pid, ...identity } = app.identity
    return identity
  }

  function resolveLaunch(file: string): ResolvedLaunch | Refusal {
    const fs = platform === "macos" ? path.posix : path.win32
    if (!fs.isAbsolute(file) || file.includes("\0")) return refuse("app_not_found", "The program path is not absolute")
    const samePath = (candidate: string) =>
      platform === "windows"
        ? fs.normalize(candidate).toLowerCase() === fs.normalize(file).toLowerCase()
        : fs.normalize(candidate) === fs.normalize(file)
    const app = desktop.apps().find((item) => {
      const file = pathOf(item.identity)
      return file !== undefined && samePath(file)
    })
    if (app) {
      const category = blocklist.category(app.identity)
      if (blocklist.isProtected(app.identity) || category === "system-ui")
        return { kind: "protected", reason: ComputerApps.builtinRule(app.identity)?.reason ?? "security" }
      if (app.running || app.identity.verified) return { kind: "app", identity: wireIdentity(app) }
    }
    const artifact = programs.find((item) => samePath(item.path) || item.aliases?.some(samePath))
    if (artifact?.protected) return { kind: "protected", reason: artifact.protected }
    if (!artifact || !artifact.handler)
      return refuse("app_not_found", "The program or verified launch handler could not be resolved")
    const handler = artifact.handlerIdentity && desktop.apps().find((app) => app.identity === artifact.handlerIdentity)
    if (artifact.handlerIdentity && !handler)
      return refuse("app_not_found", "The launch handler identity is not native")
    if (handler && (blocklist.isProtected(handler.identity) || blocklist.category(handler.identity) === "system-ui"))
      return { kind: "protected", reason: ComputerApps.builtinRule(handler.identity)?.reason ?? "security" }
    const handlerIdentity = handler && wireIdentity(handler)
    const binding = createHash("sha256")
      .update(
        JSON.stringify([
          platform,
          artifact.path,
          artifact.content,
          artifact.handler,
          ...(handlerIdentity ? [handlerIdentity] : []),
        ]),
      )
      .digest("hex")
    const program = { platform, path: artifact.path, name: Computer.clean(artifact.name, 256), binding }
    const resolved = { ...program, key: ComputerProgram.key(program) }
    if (!ComputerProgram.valid(resolved)) return refuse("app_not_found", "The program identity is invalid")
    return {
      kind: "program",
      program: { ...resolved, ...(handlerIdentity ? { handler: structuredClone(handlerIdentity) } : {}) },
    }
  }

  return {
    desktop,
    log,
    features,
    /** Bytes from the desktop, in any chunking. */
    receive(bytes: Uint8Array) {
      if (!state.closed) reader.push(bytes)
    },
    /** A control message (also accepted as newline-delimited JSON on the control descriptor). */
    control(message: unknown) {
      const decoded = Schema.decodeUnknownOption(Control)(message)
      if (decoded._tag === "None" || state.closed) return false
      const value = decoded.value
      if (value.type === "user_input" && value.tagged) return true
      // The user's own key stays out of the log, as it stays out of `user_input` events (2.10).
      record("control", {
        message: value.type === "user_input" && value.key !== undefined ? { ...value, key: "redacted" } : value,
      })
      if (value.type === "display_change") {
        desktop.displayChange()
        emit({ event: "display_change" })
      }
      if (value.type === "focus") {
        desktop.focus(value.windowId, value.node)
        checkSecureInput()
      }
      if (value.type === "lock") {
        state.locked = value.locked
        if (value.locked) {
          releaseAll("locked")
          abortCurrent("locked", "The screen locked", "locked", true)
        }
        emit({ event: "locked", locked: value.locked })
        pump()
      }
      if (value.type !== "user_input") return true
      if (value.kind === "pointer") {
        const point = desktop.cursor
        const scale = platform === "windows" ? (desktop.displayAt(point).dpiScale ?? 1) : 1
        desktop.cursor = { x: point.x + (value.dx ?? 0) * scale, y: point.y + (value.dy ?? 0) * scale }
      }
      const session = state.session
      if (!session) return true
      if (value.kind === "key" && value.key === Hands.STOP_KEY && session.escStops && features["stop.esc"]) {
        halt("esc")
        return true
      }
      if (value.kind === "key" && value.key === session.stopChord && features["stop.chord"]) {
        halt("chord")
        return true
      }
      if (!features["userInput.detect"]) return true
      // The threshold uses one logical displacement, independently of native cursor coordinates. Missing deltas
      // cannot prove that a pointer packet was harmless. Native M8/W9 must halt before emitting the same event.
      const takeover =
        value.kind !== "pointer" ||
        value.dx === undefined ||
        value.dy === undefined ||
        Math.hypot(value.dx, value.dy) >= 8
      if (session.mode === "foreground" && takeover) {
        // Inhibit queued writes before returning from the native callback. Even a newer phase update can have
        // been queued before this event, so only a fresh session.begin can clear physical take-over.
        state.session = {
          ...session,
          paused: true,
          escStops: false,
          physicalPause: true,
        }
        releaseAll("user_input")
        abortCurrent("paused", "Paused for the user's own input", "user_input", true)
      }
      const window = value.kind === "key" ? undefined : desktop.topAt(desktop.cursor, excluded())
      const app = value.kind === "key" ? desktop.frontmost() : window ? desktop.appOf(window) : undefined
      emit({
        event: "user_input",
        kind: value.kind,
        ...(app && Number.isSafeInteger(app.pid) && app.pid > 0 ? { pid: app.pid } : {}),
        ...(value.dx === undefined ? {} : { dx: value.dx }),
        ...(value.dy === undefined ? {} : { dy: value.dy }),
      })
      pump()
      return true
    },
    /** The channel closed: release input and exit. */
    endOfInput() {
      if (state.closed) return
      releaseAll("eof")
      if (state.current) clock.clearTimeout(state.current.timer)
      state.current = undefined
      endSession("eof")
      exit(0, "eof")
    },
  }
}

export type FakeHelper = ReturnType<typeof createFakeHelper>

/**
 * An in-process fake and a replay `Channel` onto it. Frames flow synchronously and timers run on `clock`, so a
 * channel read never needs to wait: what has not arrived yet will not arrive until the clock moves.
 */
export function connect(options: FakeOptions = {}, clock: Clock = manualClock()) {
  const inbox: Received[] = []
  const reader = frameReader({ onFrame: (bytes) => inbox.push({ kind: "frame", bytes }) })
  const helper = createFakeHelper(options, {
    clock,
    write: (bytes) => reader.push(bytes),
    exit: (code) => inbox.push({ kind: "exit", code }),
  })
  const channel: Channel = {
    write: (bytes) => helper.receive(bytes),
    end: () => helper.endOfInput(),
    next: async () => inbox.shift(),
  }
  return { helper, channel, inbox }
}

// ---------------------------------------------------------------------------------------------------------------
// The command line

const FLAGS = {
  version: "boolean",
  probe: "boolean",
  json: "boolean",
  stdio: "boolean",
  "parent-pid": "string",
  channel: "string",
  "control-fd": "string",
  platform: "string",
  scenario: "string",
  protocol: "string",
  features: "string",
  fail: "string",
  latency: "string",
} as const

type Cli =
  | { mode: "version"; options: FakeOptions }
  | { mode: "probe"; options: FakeOptions }
  | {
      mode: "serve"
      options: FakeOptions
      parentPid: number
      channel: "fd3" | "stdio"
      controlFd?: number
    }

/** Parse the fake's arguments; a string is a usage error. */
export function parseCli(argv: readonly string[]): Cli | string {
  const parsed = parseArgs({
    args: [...argv],
    strict: false,
    allowPositionals: true,
    options: Object.fromEntries(
      Object.entries(FLAGS).map(([name, type]) => [name, { type, ...(name === "fail" ? { multiple: true } : {}) }]),
    ),
  })
  if (parsed.positionals.length) return `Unexpected argument ${parsed.positionals[0]}`
  const values = parsed.values
  const unknown = Object.keys(values).find((name) => !Object.hasOwn(FLAGS, name))
  if (unknown) return `Unknown option --${unknown}`
  const wrong = Object.entries(FLAGS).find(([name, type]) => {
    const value = values[name]
    if (value === undefined) return false
    if (type === "boolean") return typeof value !== "boolean"
    return Array.isArray(value) ? value.some((item) => typeof item !== "string") : typeof value !== "string"
  })
  if (wrong) return wrong[1] === "boolean" ? `--${wrong[0]} takes no value` : `--${wrong[0]} needs a value`
  const text = (name: keyof typeof FLAGS) => values[name] as string | undefined
  const integer = (value: string | undefined) =>
    value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined

  const platform = text("platform") ?? "macos"
  if (platform !== "macos" && platform !== "windows") return "--platform must be macos or windows"
  const scenario = text("scenario") ?? "calculator"
  if (!SCENARIOS.includes(scenario as Scenario)) return `--scenario must be one of ${SCENARIOS.join(", ")}`
  const protocolText = text("protocol")
  const protocolMatch = protocolText?.match(/^(\d+)\.\.(\d+)$/)
  const protocol = protocolMatch ? { min: Number(protocolMatch[1]), max: Number(protocolMatch[2]) } : undefined
  if (protocolText !== undefined && (!protocol || protocol.min < 1 || protocol.min > protocol.max))
    return "--protocol must be <min>..<max>, for example 1..2"
  const featureItems = text("features")?.split(",") ?? []
  const disabled = featureItems.map((item) => item.slice(1))
  const known: readonly string[] = Computer.HelperFeature.literals
  if (featureItems.some((item, index) => !item.startsWith("-") || !known.includes(disabled[index]!)))
    return "--features takes a list of known features to turn off, each written -<feature>"
  const fails = (values.fail as string[] | undefined) ?? []
  const crash = fails.map((item) => item.match(/^crash-after:(\d+)$/)).find((match) => match)
  const invalid = fails.find(
    (item) => !/^crash-after:\d+$/.test(item) && !["hang-hello", "deny:screen", "deny:accessibility"].includes(item),
  )
  if (invalid) return `Unknown --fail ${invalid}`
  if (platform === "windows" && fails.includes("deny:accessibility"))
    return "deny:accessibility applies only to --platform macos"
  const latencyText = text("latency")
  const latencyMs = integer(latencyText)
  if (latencyText !== undefined && latencyMs === undefined) return "--latency must be a whole number of milliseconds"
  const options: FakeOptions = {
    platform,
    scenario: scenario as Scenario,
    ...(protocol ? { protocol } : {}),
    disabled: disabled as Computer.HelperFeature[],
    ...(crash ? { crashAfter: Number(crash[1]) } : {}),
    hangHello: fails.includes("hang-hello"),
    deny: [
      ...(fails.includes("deny:screen") ? ["screen" as const] : []),
      ...(fails.includes("deny:accessibility") ? ["accessibility" as const] : []),
    ],
    ...(latencyMs === undefined ? {} : { latencyMs }),
  }
  if (values.version) return values.json ? { mode: "version", options } : "--version needs --json"
  if (values.probe) return values.json ? { mode: "probe", options } : "--probe needs --json"
  if (!values.stdio) return "Pass --version --json, --probe --json or --stdio --parent-pid <pid>"
  const parentPid = integer(text("parent-pid"))
  if (!parentPid) return "--stdio needs --parent-pid <pid>"
  const channel = text("channel") ?? (process.platform === "win32" ? "stdio" : "fd3")
  if (channel !== "fd3" && channel !== "stdio") return "--channel must be fd3 or stdio"
  const controlText = text("control-fd")
  const controlFd = integer(controlText)
  if (controlText !== undefined && (controlFd === undefined || controlFd < 3)) return "--control-fd must be 3 or more"
  return { mode: "serve", options, parentPid, channel, ...(controlFd === undefined ? {} : { controlFd }) }
}

/**
 * Run the command line. `--version --json` and `--probe --json` print one JSON line and return 0; a usage error
 * returns 2; `--stdio` serves the protocol on the process's descriptors until EOF, shutdown or the parent's death.
 */
export function main(argv: readonly string[], io: { out(text: string): void; err(text: string): void }) {
  const cli = parseCli(argv)
  if (typeof cli === "string") {
    io.err(`${cli}\n`)
    return Computer.HELPER_CLI.exit.usage
  }
  const platform = cli.options.platform ?? "macos"
  if (cli.mode === "version") {
    io.out(
      `${JSON.stringify({
        helperVersion: identity.helperVersion,
        protocol: cli.options.protocol ?? identity.protocol,
        platform: platform === "macos" ? "darwin" : "win32",
        arch: process.arch,
        fake: true,
      })}\n`,
    )
    return Computer.HELPER_CLI.exit.pass
  }
  if (cli.mode === "probe") {
    const deny = new Set(cli.options.deny)
    // Never prompts: the fake only reports what it was told.
    io.out(
      `${JSON.stringify(
        platform === "macos"
          ? {
              permissions: {
                screen: deny.has("screen") ? "denied" : "granted",
                accessibility: deny.has("accessibility") ? "denied" : "granted",
              },
              responsible: true,
            }
          : {
              permissions: { screen: "n/a", accessibility: "n/a" },
              captureBlocked: deny.has("screen"),
              elevated: false,
              responsible: true,
            },
      )}\n`,
    )
    return Computer.HELPER_CLI.exit.pass
  }
  serve(cli)
  return undefined
}

function serve(cli: Extract<Cli, { mode: "serve" }>) {
  const socket = cli.channel === "fd3" ? new net.Socket({ fd: 3, readable: true, writable: true }) : undefined
  const input = socket ?? process.stdin
  const output = socket ?? process.stdout
  const watch = setInterval(() => {
    if (!alive(cli.parentPid)) helper.endOfInput()
  }, 250)
  const helper = createFakeHelper(cli.options, {
    write: (bytes) => void output.write(bytes),
    exit(code) {
      clearInterval(watch)
      output.end(() => process.exit(code))
      setTimeout(() => process.exit(code), 500).unref()
    },
  })
  input.on("data", (chunk: Buffer) => helper.receive(chunk))
  input.on("end", () => helper.endOfInput())
  input.on("error", () => helper.endOfInput())
  if (cli.controlFd !== undefined)
    createInterface({ input: new net.Socket({ fd: cli.controlFd, readable: true }) }).on("line", (line) => {
      const message = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(line)
      if (message._tag === "Some") helper.control(message.value)
    })
}

function alive(pid: number) {
  // `kill(pid, 0)` only probes; it throws when the process is gone (EPERM means it exists under another user).
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = main(process.argv.slice(2), {
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
  })
  if (code !== undefined) process.exitCode = code
}
