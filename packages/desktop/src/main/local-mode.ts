import { mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { App, CommandLine, Debugger, Session, WebContents } from "electron"
import { Option, Schema } from "effect"
import { LocalMode } from "@vectordevai/schema/local-mode"
import { LocalEvent } from "@vectordevai/schema/local-event"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { LocalStartup } from "@vectordevai/core/local-mode/startup"
import { holdDebugger } from "./debugger-hold"
import { decideChromium, egressFilter, type EgressFilter, type Target } from "./egress-filter"
import { engineEventSource } from "./keep-awake"
import { companyAuthorities, trustCompanyCertificates, type WaitingAuthority } from "./local-certificates"
import { desktopLocalFolders, resolveDesktopLocal } from "./local-policy"

// Vector Local in the desktop app (plan sections 4.2, 4.3.6, 4.7 and 4.9). Desktop main resolves the policy before
// app.whenReady from the folders its engine reads (local-policy.ts), and from then on:
// - Chromium: one dispatcher per session (egress-filter.ts), WebRTC kept to the proxy, no DNS prefetching, no QUIC,
//   no spellcheck downloads on Windows and Linux, and no WebRTC peer connections or WebTransport in the agent's
//   browser;
// - the company's certificate authorities are added to the certificates desktop main and its engine trust;
// - once the engine runs, desktop main compares its policy with the engine's (GET /local) as soon as the engine says
//   Vector Local changed (its local.updated event) and every half minute, reading its own folders again each time,
//   and when they differ it uses the stricter of the two and says so; a change applies to Chromium at once where it
//   can (WebRTC, spellcheck dictionaries, the agent browser's peer connections and WebTransport), and DNS prefetching
//   and QUIC, which only a start sets, say a restart is needed; and it sends what its own windows and requests did to
//   the engine's network log (POST /local/egress/report), so "What Vector sent" lists the desktop's requests too;
// - on the first run, with no company policy and no model connected, the requests Vector makes for itself at start
//   (the usage check-in, the update check, the dictation model's pre-warm, release notes, and in the engine the model
//   catalog's refresh, the free models and plans catalogs and the provider policy) wait until the person has chosen
//   how to run models, with no timeout, and go then;
// - the services desktop main reaches (usage, updates, the help assistant) ask Vector Local before they connect.

const AGENT_BROWSER = "persist:vector-browser"
// electron-updater's own session (electronHttpExecutor.js, NET_SESSION_NAME), made with the options it makes it with.
const UPDATER = "electron-updater"
const UPDATER_OPTIONS = { cache: false }
const REPORT_BATCH = 500
const REPORT_LIMIT = 2_000
const RETRY = 5_000
const RECHECK = 30_000
const EVENTS_RETRY = 1_000
const EVENTS_RETRY_MAX = 30_000
const RELEASE_TRIES = 4
const FIRST_RUN_CHECK = 15_000
const CERTIFICATES_CHECK = 60_000
// Chromium's switches under Vector Local, which only a start sets. Name prefetching may look up a name a page links to
// before the request the dispatcher would refuse. QUIC carries WebTransport, whose connections no webRequest listener
// sees, so it is off as one more layer; nothing here checks that Chromium opens no WebTransport without it, which is
// why the agent's browser loses WebTransport itself (guardAgentContents). Web requests fall back to HTTP/2 and
// HTTP/1.1, which the dispatcher decides as before.
const LOCAL_SWITCHES = ["dns-prefetch-disable", "disable-quic"]
const ANSWERED = "firstRunAnswered"
// A start held for the first run's question, which a start that left state behind (ranBefore) still holds for.
const HELD = "firstRunHeld"
/**
 * Desktop main's own store for Vector Local: whether the first run's question was answered, and the certificate
 * authorities from the user's own config its owner trusted.
 */
export const LOCAL_STORE = "local"
const TRUSTED_AUTHORITIES = "trustedAuthorities"
// What the app's windows fetch from the internet, by registry source, as the dispatcher decides it.
const RENDERER = {
  "release-notes": "https://vectordev.ai/changelog.json",
  "site-assets": "https://vectordev.ai/favicon-96x96-desktop-v4.png",
  "crash-reports": "https://ingest.sentry.io/",
  "dictation-model": "https://huggingface.co/onnx-community/whisper-tiny.en/resolve/main/config.json",
} as const

/** Vector Local as the app's windows see it (preload `vectorLocal.status`). */
export type DesktopLocalStatus = {
  readonly enabled: boolean
  readonly web: LocalMode.Web
  readonly lock: boolean
  /** The first run's own startup requests are waiting for the person to choose how to run models. */
  readonly held: boolean
  /** The app and its engine read Vector Local differently; the app uses the stricter of the two. */
  readonly mismatch?: string
  /**
   * Vector Local was turned on after the app started, and until Vector restarts Chromium still looks up the names pages
   * link to before anyone opens them, and still speaks QUIC (DNS prefetching and QUIC are set only at start), though
   * the agent's browser already has no WebTransport. Everything else already applies.
   */
  readonly restartNeeded: boolean
  /** Whether the app's windows may fetch each of these from the internet now: allow, ask (once) or block. */
  readonly sources: Readonly<Record<keyof typeof RENDERER, LocalMode.Decision>>
}

export type Engine = { readonly url: string; readonly password: string }
type Fetch = (input: string, init?: RequestInit) => Promise<Response>

const state: { mismatch?: string; hold: FirstRunHold; switchesSet: boolean } = {
  hold: createFirstRunHold(false),
  switchesSet: false,
}

/**
 * Before app.whenReady, once preferAppEnv has set the desktop's folders: resolves Vector Local's policy, trusts the
 * company's certificate authorities and those of the user's own config its owner trusted (`confirmed`), and sets
 * Chromium's switches.
 */
export function startDesktopLocal(input: {
  readonly userData: string
  readonly commandLine: Pick<CommandLine, "appendSwitch">
  readonly log: (message: string, data?: unknown) => void
  /** The fingerprints of the user's own certificate authorities its owner trusted. */
  readonly confirmed?: readonly string[]
}) {
  const policy = resolveDesktopLocal(input.userData)
  // Only a start sets these, so turning Vector Local on later says a restart is needed
  // (DesktopLocalStatus.restartNeeded).
  state.switchesSet = policy.enabled
  if (policy.enabled) LOCAL_SWITCHES.forEach((name) => input.commandLine.appendSwitch(name))
  policy.warnings.forEach((warning) => input.log("vector local", { warning }))
  // Node's own certificate lists are read through OpenSSL and the system's store, either of which can fail on a
  // broken installation; Vector then keeps the certificates Node starts with.
  const trusted = (() => {
    try {
      return trustCompanyCertificates({ userData: input.userData, confirmed: input.confirmed ?? [] })
    } catch (error) {
      input.log("failed to load system certificates", { error: String(error) })
      return undefined
    }
  })()
  trusted?.problems.forEach((problem) => input.log("company certificate skipped", { problem }))
  if (trusted?.added.length) input.log("company certificates trusted", { count: trusted.added.length })
  if (trusted?.waiting.length) input.log("certificates wait for the owner", { count: trusted.waiting.length })
  return policy
}

/**
 * Checks the certificate files Vector Local names now and every minute. A certificate authority the user's own config
 * names that its owner has not trusted is asked about (`ask`, once per set of them while the app runs, so "Not now"
 * asks again at the next start) and kept with `trust` when they say yes. When the authorities in effect change, it
 * trusts the new set here and calls `changed` (the engine restarts to trust them too, as desktop main starts it with
 * `confirmed`). Company policy's apply without a question. Returns the function that stops checking.
 */
export function watchCompanyCertificates(input: {
  readonly userData: string
  readonly changed: () => void
  /** The fingerprints of the user's own certificate authorities its owner trusted. */
  readonly confirmed: () => readonly string[]
  /** Asks the owner whether to trust these; true to trust them. */
  readonly ask: (waiting: readonly WaitingAuthority[]) => Promise<boolean>
  readonly trust: (fingerprints: readonly string[]) => void
  readonly interval?: number
  readonly apply?: (certificates: string[]) => void
  readonly folders?: LocalStartup.Input
}) {
  const folders = input.folders ?? desktopLocalFolders(input.userData)
  const read = () => companyAuthorities({ folders, confirmed: input.confirmed() })
  const state = { last: read().added.join(), asked: "", busy: false }
  const check = async () => {
    if (state.busy) return
    state.busy = true
    const waiting = read().waiting
    const key = waiting.map((item) => item.fingerprint).join()
    if (waiting.length > 0 && key !== state.asked) {
      state.asked = key
      if (await input.ask(waiting).catch(() => false)) input.trust(waiting.map((item) => item.fingerprint))
    }
    state.busy = false
    const next = read().added.join()
    if (next === state.last) return
    state.last = next
    trustCompanyCertificates({ userData: input.userData, confirmed: input.confirmed(), apply: input.apply, folders })
    input.changed()
  }
  void check()
  const timer = setInterval(() => void check(), input.interval ?? CERTIFICATES_CHECK)
  timer.unref?.()
  return () => clearInterval(timer)
}

type Store = { get(key: string): unknown; set(key: string, value: unknown): void }

/**
 * The fingerprints of the certificate authorities from the user's own config that its owner trusted, as LOCAL_STORE
 * keeps them. The store is the user's to change, like the config, so it is the owner's record and not a boundary:
 * what keeps the agent from writing either is the ask on its own edits.
 */
export function trustedAuthorities(store: Pick<Store, "get">) {
  const value = store.get(TRUSTED_AUTHORITIES)
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

/** Keeps `fingerprints` among the certificate authorities the owner trusted. */
export function trustAuthorities(store: Store, fingerprints: readonly string[]) {
  store.set(TRUSTED_AUTHORITIES, [...new Set([...trustedAuthorities(store), ...fingerprints])])
}

/**
 * Once the app is ready: the dispatcher on the default session and every session Electron makes, the kinds of the
 * sessions Vector knows, WebRTC kept off UDP on every web contents, and, with Vector Local on, no WebRTC peer
 * connections and no WebTransport in the agent's browser (its preload, and guardAgentContents for what the preload
 * never reaches). Returns `apply`, which brings all of it in line with the policy in effect after it changed: every
 * open web contents, every session's spellcheck dictionaries, and the agent browser's preload and guards.
 */
export function installChromiumLocal(deps: {
  readonly app: Pick<App, "on">
  readonly defaultSession: Target
  readonly fromPartition: (partition: string, options?: { cache: boolean }) => Target & Partial<PreloadTarget>
  readonly webContents: () => readonly ChromiumContents[]
  /** Where the agent's browser's preload is written. */
  readonly directory: string
  readonly filter?: EgressFilter
  readonly policy?: () => LocalMode.Policy
}) {
  const filter = deps.filter ?? egressFilter
  const policy = deps.policy ?? Egress.policy
  filter.prepare(deps.defaultSession, "app")
  deps.app.on("session-created", (created) => filter.prepare(created))
  const agent = deps.fromPartition(AGENT_BROWSER)
  filter.prepare(agent, "agent-browser")
  filter.prepare(deps.fromPartition(UPDATER, UPDATER_OPTIONS), "updates")
  // The agent browser's web contents guarded while Vector Local is on, each with the function that stops its guard.
  const guarded = new Map<ChromiumContents, () => void>()
  const guard = (contents: ChromiumContents) => {
    if (!policy().enabled || contents.session !== agent || guarded.has(contents) || !isDebuggee(contents)) return
    const stop = guardAgentContents(contents)
    if (!stop) return
    guarded.set(contents, stop)
    contents.once("destroyed", () => guarded.delete(contents))
  }
  deps.app.on("web-contents-created", (_event, contents) => {
    filter.protect(contents)
    guard(contents)
  })
  const preload: { id?: string } = {}
  const apply = () => {
    deps.webContents().forEach((contents) => {
      filter.protect(contents)
      guard(contents)
    })
    filter.refresh()
    // A page loaded while Vector Local was on keeps what its guard took away until it loads again.
    if (!policy().enabled) {
      guarded.forEach((stop) => stop())
      guarded.clear()
    }
    if (!agent.registerPreloadScript) return
    const on = policy().enabled
    if (on && !preload.id) preload.id = denyPeerConnections(agent as PreloadTarget, deps.directory)
    if (on || !preload.id) return
    // A page loaded while Vector Local was on keeps the preload until it loads again.
    agent.unregisterPreloadScript?.(preload.id)
    preload.id = undefined
  }
  apply()
  return { apply }
}

type PreloadTarget = Pick<Session, "registerPreloadScript" | "unregisterPreloadScript">
/** A web contents as installChromiumLocal reads it: the agent browser's are guarded too. */
type ChromiumContents = Pick<WebContents, "setWebRTCIPHandlingPolicy"> &
  Partial<Pick<WebContents, "session" | "once" | "getURL" | "isLoading">> & { readonly debugger?: Debuggee["debugger"] }
type Debuggee = Pick<WebContents, "once" | "getURL" | "isLoading"> & {
  readonly debugger: Pick<Debugger, "attach" | "detach" | "isAttached" | "sendCommand" | "on" | "removeListener">
}

function isDebuggee(contents: ChromiumContents): contents is ChromiumContents & Debuggee {
  return (
    contents.debugger !== undefined &&
    contents.once !== undefined &&
    contents.getURL !== undefined &&
    contents.isLoading !== undefined
  )
}

// What the agent's browser loses under Vector Local, before a page's own scripts: WebRTC peer connections and
// WebTransport, whose traffic no webRequest listener sees, and which in a session with no proxy (the agent's browser)
// would connect directly, around Web access. QUIC is off too from the next start (LOCAL_SWITCHES).
const NO_PEER_CONNECTIONS = `() => {
  for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCSessionDescription", "RTCIceCandidate", "WebTransport"]) {
    try { Object.defineProperty(globalThis, name, { value: undefined, configurable: false, writable: false }) } catch {}
  }
}`
// The same, as a script the browser's debugging protocol runs in a document or a worker.
const NO_PEER_CONNECTIONS_SCRIPT = `(${NO_PEER_CONNECTIONS})()`
// A sandboxed preload with context isolation reaches the page's world through executeInMainWorld; one without
// isolation already runs there. Electron runs a session's preloads in the main frame only, unless the web contents
// sets nodeIntegrationInSubFrames, as the agent's browser does (AGENT_BROWSER_PREFERENCES, browser-agent.ts): then
// they run in every frame that loads a document too, still sandboxed and without Node. A blank frame a page's script
// makes loads none, so no preload runs there, nor in a worker: guardAgentContents covers those and dedicated workers.
// The Electron smoke checks each.
const PEER_CONNECTIONS_OFF = `"use strict"
// Vector Local: the agent's browser makes no WebRTC peer connections and no WebTransport.
// Written by Vector (local-mode.ts).
const off = ${NO_PEER_CONNECTIONS}
try { require("electron").contextBridge.executeInMainWorld({ func: off }) } catch { off() }
`
// How the agent browser's frames of other sites and its dedicated workers are attached: each waits as it starts until
// Vector let it go. Shared and service workers are left out: a service worker the debugger holds as it starts never
// takes the script and never starts, which would hold the page that registered it. A frame or worker is let go after
// PREPARE_LIMIT whatever happened, so no page waits on the debugger for good.
const AUTO_ATTACH = {
  autoAttach: true,
  waitForDebuggerOnStart: true,
  flatten: true,
  filter: [{ type: "iframe" }, { type: "worker" }],
}
const PREPARE_LIMIT = 2_000

/**
 * Turns WebRTC peer connections and WebTransport off, before their own scripts, where the agent browser's preload
 * never runs: a blank frame a page's script makes, a blank frame in a frame of another site, and dedicated workers. It
 * drives the browser's debugging protocol, as research browsers do: every document gets the script before its own
 * (Page.addScriptToEvaluateOnNewDocument), and a frame of another site or a dedicated worker, which is a target of its
 * own, waits as it starts until it has the script too (Target.setAutoAttach). Shared and service workers keep
 * WebTransport. Returns the function that stops, or undefined when the debugger could not attach, where the preload
 * alone applies.
 */
export function guardAgentContents(contents: Debuggee) {
  const tools = contents.debugger
  // Shared with the tab's own file chooser interception (browser-agent.ts), which may hold it already.
  const release = holdDebugger(tools)
  if (!release) return undefined
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    tools.sendCommand(method, params, sessionId).catch(() => undefined)
  // The page's own script, which a guard that stops while the tab keeps the debugger takes back.
  const added: { identifier?: string } = {}
  const prepare = (sessionId?: string, type?: string) =>
    Promise.all([
      ...(type === "worker"
        ? [send("Runtime.evaluate", { expression: NO_PEER_CONNECTIONS_SCRIPT }, sessionId)]
        : [
            send("Page.enable", {}, sessionId),
            send(
              "Page.addScriptToEvaluateOnNewDocument",
              { source: NO_PEER_CONNECTIONS_SCRIPT, runImmediately: true },
              sessionId,
            ).then((result) => {
              const identifier = (result as { identifier?: unknown } | undefined)?.identifier
              if (sessionId === undefined && typeof identifier === "string") added.identifier = identifier
            }),
          ]),
      send("Target.setAutoAttach", AUTO_ATTACH, sessionId),
    ])
  const attachedTo = (_event: unknown, method: string, params: unknown) => {
    if (method !== "Target.attachedToTarget") return
    const target = params as { readonly sessionId: string; readonly targetInfo: { readonly type: string } }
    const type = target.targetInfo.type
    const ready = type === "iframe" || type === "worker" ? prepare(target.sessionId, type) : Promise.resolve()
    const limit = new Promise<void>((resolve) => setTimeout(resolve, PREPARE_LIMIT).unref?.())
    void Promise.race([ready, limit]).then(() => send("Runtime.runIfWaitingForDebugger", {}, target.sessionId))
  }
  tools.on("message", attachedTo)
  // A web contents that has loaded nothing has no page to send to yet (Electron answers "target closed"); its first
  // navigation's start has one, and what it sends then reaches the page before the page's own scripts.
  if (contents.getURL() === "" && !contents.isLoading()) contents.once("did-start-navigation", () => void prepare())
  else void prepare()
  return () => {
    tools.removeListener("message", attachedTo)
    if (release()) return
    // The tab still holds the debugger: what this guard set there goes, and the frames and workers it held detach.
    if (added.identifier) void send("Page.removeScriptToEvaluateOnNewDocument", { identifier: added.identifier })
    void send("Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: true })
  }
}

/** Registers the preload that turns WebRTC peer connections and WebTransport off in the pages of `target`. */
export function denyPeerConnections(target: Pick<Session, "registerPreloadScript">, directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const filePath = join(directory, "no-peer-connections.js")
  writeFileSync(filePath, PEER_CONNECTIONS_OFF, { mode: 0o600 })
  return target.registerPreloadScript({ type: "frame", id: "vector-local-no-peer-connections", filePath })
}

/** Why the app and its engine disagree about Vector Local, and the stricter policy of the two; undefined when they agree. */
export function policyMismatch(desktop: LocalMode.Policy, engine: LocalMode.Policy) {
  const on = (policy: LocalMode.Policy) => (policy.enabled ? "on" : "off")
  const differences =
    desktop.enabled !== engine.enabled
      ? [`Vector Local is ${on(desktop)} in the app and ${on(engine)} in its engine`]
      : desktop.enabled
        ? [
            desktop.web !== engine.web
              ? `Web access is ${WEB_LABEL[desktop.web]} in the app and ${WEB_LABEL[engine.web]} in its engine`
              : undefined,
            same(endpoints(desktop), endpoints(engine)) ? undefined : "their model server lists differ",
            same(allowed(desktop), allowed(engine)) ? undefined : "their allowed services differ",
            same(desktop.web_domains.allow, engine.web_domains.allow) &&
            same(desktop.web_domains.deny, engine.web_domains.deny)
              ? undefined
              : "their site lists differ",
            desktop.updates?.url === engine.updates?.url ? undefined : "their update mirrors differ",
            desktop.lock === engine.lock ? undefined : "only one of them follows your company's lock",
          ].filter((item): item is string => item !== undefined)
        : []
  if (differences.length === 0) return undefined
  return {
    differences,
    message: `The app and its engine read Vector Local differently: ${differences.join("; ")}. The app uses the stricter of the two until they agree.`,
    stricter: stricterPolicy(desktop, engine),
  }
}

const WEB_LABEL: Record<LocalMode.Web, string> = { ask: "Ask", network: "Your network only", none: "None" }

/** The policy that lets through only what both let through. */
export function stricterPolicy(left: LocalMode.Policy, right: LocalMode.Policy): LocalMode.Policy {
  if (!left.enabled) return right
  if (!right.enabled) return left
  const listed = endpoints(right)
  const services = allowed(right)
  const pending = left.pending || right.pending
  return {
    ...left,
    web: LocalPolicy.stricter(left.web, right.web),
    lock: left.lock || right.lock,
    ...(pending ? { pending } : {}),
    endpoints: left.endpoints.filter((endpoint) => listed.includes(endpointKey(endpoint))),
    web_domains: {
      allow: left.web_domains.allow.filter((site) => right.web_domains.allow.includes(site)),
      deny: [...new Set([...left.web_domains.deny, ...right.web_domains.deny])],
    },
    allow: left.allow.filter((entry) => services.includes(allowKey(entry))),
    ...(left.updates && left.updates.url === right.updates?.url ? { updates: left.updates } : { updates: undefined }),
    user_may: left.user_may.filter((key) => right.user_may.includes(key)),
    locked_keys: [...new Set([...left.locked_keys, ...right.locked_keys])],
    endpoint_domains: left.endpoint_domains.filter((pattern) => right.endpoint_domains.includes(pattern)),
  }
}

const endpointKey = (endpoint: LocalMode.Endpoint) =>
  endpoint.from === "managed" ? `managed ${endpoint.origin}` : (LocalPolicy.origin(endpoint.origin) ?? endpoint.origin)
const endpoints = (policy: LocalMode.Policy) => policy.endpoints.map(endpointKey)
const allowKey = (entry: LocalMode.Allowed) => `${entry.source} ${[...(entry.hosts ?? [])].sort().join(",")}`
const allowed = (policy: LocalMode.Policy) => policy.allow.map(allowKey)
const same = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && [...left].sort().join("\n") === [...right].sort().join("\n")

/**
 * Once the engine answers: compares its policy with this process's own, read again from the desktop's folders each
 * time (`own`), as soon as the engine says Vector Local changed (its local.updated event, `events`) and every half
 * minute, uses the stricter of the two, and tells `changed` the policy in effect each time it changes. Turning Vector
 * Local on or off in the app therefore applies here within moments. A change to the user's config that would loosen
 * Vector Local waits for the owner in the engine (`held`); this process reads the file as it is, which is no
 * disagreement: the engine's stricter policy applies until the owner lets the change apply. It also sends this
 * process's network log lines to the engine's log. Returns how to stop.
 */
export function connectDesktopLocal(input: {
  readonly engine: Engine
  readonly log: (message: string, data?: unknown) => void
  /** This process's own policy, from its folders. Without it, the policy in effect when it connected. */
  readonly own?: () => LocalMode.Policy
  /** The engine's event stream; without it, the engine's own /global/event. */
  readonly events?: (signal: AbortSignal) => AsyncIterable<{ readonly payload: { readonly type: string } }>
  /** The policy in effect, each time it changes. */
  readonly changed?: (policy: LocalMode.Policy) => void
  readonly fetch?: Fetch
  readonly interval?: number
  /** The first wait before the event stream reconnects; it doubles up to 30 seconds. */
  readonly retry?: number
}) {
  const fetch = input.fetch ?? globalThis.fetch
  const start = Egress.policy()
  const own = input.own ?? (() => start)
  const compare = async () => {
    const engine = await readEngineStatus(input.engine, fetch)
    if (!engine) return
    const mine = own()
    const mismatch = policyMismatch(mine, engine.policy)
    const waiting = mismatch && engine.held && policyMismatch(mine, engine.held.proposed) === undefined
    const message = waiting ? undefined : mismatch?.message
    if (message !== state.mismatch) {
      input.log("vector local", { mismatch: message ?? "none" })
      state.mismatch = message
    }
    const next = mismatch?.stricter ?? mine
    if (JSON.stringify(next) === JSON.stringify(Egress.policy())) return
    const applied = Egress.configure(next)
    input.changed?.(applied)
  }
  const first = compare()
  const timer = setInterval(() => void compare(), input.interval ?? RECHECK)
  timer.unref?.()
  const stopping = new AbortController()
  void watchEngineLocal({
    events:
      input.events ??
      engineEventSource({ url: input.engine.url, username: "vector", password: input.engine.password }).events,
    compare,
    signal: stopping.signal,
    retry: input.retry ?? EVENTS_RETRY,
  })
  const forward = forwardEgress({
    // What this process logged before its engine answered, then each line as it is logged.
    initial: Egress.events(),
    subscribe: Egress.subscribe,
    send: (events) =>
      fetch(new URL("/local/egress/report", input.engine.url).href, {
        method: "POST",
        headers: { ...authorization(input.engine), "content-type": "application/json" },
        body: JSON.stringify({ events }),
        signal: AbortSignal.timeout(10_000),
      }).then(
        async (response) => {
          await response.body?.cancel().catch(() => undefined)
          return response.ok
        },
        () => false,
      ),
  })
  return {
    /** The first comparison, settled once the engine answered or could not. */
    compared: first,
    compare,
    stop() {
      clearInterval(timer)
      stopping.abort()
      forward.stop()
    },
  }
}

// Compares at each local.updated event, and again after each reconnect, for what changed while the stream was down.
async function watchEngineLocal(input: {
  readonly events: (signal: AbortSignal) => AsyncIterable<{ readonly payload: { readonly type: string } }>
  readonly compare: () => Promise<void>
  readonly signal: AbortSignal
  readonly retry: number
  readonly delay?: number
}): Promise<void> {
  const heard = { any: false }
  try {
    for await (const event of input.events(input.signal)) {
      heard.any = true
      if (event.payload.type === LocalEvent.Updated.type) await input.compare().catch(() => undefined)
    }
  } catch {
    // The stream dropped: the engine restarted, or the connection did. It is opened again below.
  }
  if (input.signal.aborted) return
  const delay = heard.any ? input.retry : Math.min((input.delay ?? input.retry / 2) * 2, EVENTS_RETRY_MAX)
  const waited = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(true), delay)
    timer.unref?.()
    input.signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        resolve(false)
      },
      { once: true },
    )
  })
  if (!waited) return
  await input.compare().catch(() => undefined)
  return watchEngineLocal({ ...input, delay })
}

async function readEngineStatus(engine: Engine, fetch: Fetch) {
  const response = await fetch(new URL("/local", engine.url).href, {
    headers: authorization(engine),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined)
  if (!response?.ok) {
    await response?.body?.cancel().catch(() => undefined)
    return undefined
  }
  return Option.getOrUndefined(Schema.decodeUnknownOption(EngineStatus)(await response.json().catch(() => undefined)))
}

// The part of GET /local's answer the comparison reads: the policy in effect, and a change held for the owner.
const EngineStatus = Schema.Struct({
  policy: LocalMode.Policy,
  held: Schema.optional(Schema.Struct({ proposed: LocalMode.Policy })),
})

/**
 * Tells the engine the person has chosen how to run models, so the fetches it held at start load now
 * (POST /local/startup/release), trying again a few times while it cannot answer. Resolves whether the engine took it.
 */
export async function releaseStartupHold(
  engine: Engine,
  fetch: Fetch = globalThis.fetch,
  tries = RELEASE_TRIES,
  wait = RETRY,
): Promise<boolean> {
  const response = await fetch(new URL("/local/startup/release", engine.url).href, {
    method: "POST",
    headers: authorization(engine),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined)
  await response?.body?.cancel().catch(() => undefined)
  if (response?.ok) return true
  if (tries <= 1) return false
  await new Promise((resolve) => setTimeout(resolve, wait))
  return releaseStartupHold(engine, fetch, tries - 1, wait)
}

function authorization(engine: Engine) {
  return { authorization: `Basic ${Buffer.from(`vector:${engine.password}`).toString("base64")}` }
}

/**
 * Sends each event this process records to `send`, in batches, a second after the first of a batch. A batch the
 * engine did not take is sent again later; the oldest are dropped past `limit`, as the engine's own memory does.
 */
export function forwardEgress(deps: {
  readonly initial?: readonly LocalMode.Event[]
  readonly subscribe: (listener: (event: LocalMode.Event) => void) => () => void
  readonly send: (events: readonly LocalMode.Event[]) => Promise<boolean>
  readonly delay?: number
  readonly retry?: number
  readonly limit?: number
}) {
  const queue: LocalMode.Event[] = (deps.initial ?? []).slice(-(deps.limit ?? REPORT_LIMIT))
  const status: { timer?: ReturnType<typeof setTimeout>; sending: boolean; stopped: boolean } = {
    sending: false,
    stopped: false,
  }
  const schedule = (delay: number) => {
    if (status.timer || status.stopped) return
    status.timer = setTimeout(() => void flush(), delay)
    status.timer.unref?.()
  }
  const flush = async () => {
    status.timer = undefined
    if (status.sending || queue.length === 0) return
    status.sending = true
    const batch = queue.splice(0, REPORT_BATCH)
    const sent = await deps.send(batch).catch(() => false)
    if (!sent) queue.unshift(...batch.slice(Math.max(0, batch.length + queue.length - (deps.limit ?? REPORT_LIMIT))))
    status.sending = false
    if (queue.length > 0) schedule(sent ? 0 : (deps.retry ?? RETRY))
  }
  const unsubscribe = deps.subscribe((event) => {
    queue.push(event)
    if (queue.length > (deps.limit ?? REPORT_LIMIT)) queue.splice(0, queue.length - (deps.limit ?? REPORT_LIMIT))
    schedule(deps.delay ?? 1_000)
  })
  if (queue.length > 0) schedule(0)
  return {
    flush,
    stop() {
      status.stopped = true
      unsubscribe()
      clearTimeout(status.timer)
    },
  }
}

export type FirstRunHold = ReturnType<typeof createFirstRunHold>

/**
 * The first run's hold on the requests Vector makes for itself at start. It has no timeout: it holds until `answer`,
 * and dismissing the card that asks leaves it holding, at this start and the next.
 */
export function createFirstRunHold(held: boolean) {
  const answered = Promise.withResolvers<void>()
  const status = { held }
  if (!held) answered.resolve()
  return {
    held: () => status.held,
    /** Resolves once the person has chosen how to run models. */
    answered: () => answered.promise,
    answer() {
      if (!status.held) return false
      status.held = false
      answered.resolve()
      return true
    },
  }
}

/**
 * Whether this start holds the requests Vector makes for itself: on a first run, with no company policy (which says
 * how Vector runs before the app is ready) and Vector Local not already on, until the person chooses how to run models.
 * An install that ran before (`ranBefore`) is not on its first run, unless an earlier start held and the person never
 * answered (`heldBefore`): dismissing the question asks again at the next start.
 */
export function firstRunHeld(input: {
  readonly answered: boolean
  readonly managed: boolean
  readonly enabled: boolean
  readonly heldBefore: boolean
  readonly ranBefore: boolean
}) {
  return !input.answered && !input.managed && !input.enabled && (input.heldBefore || !input.ranBefore)
}

/** Decides this start's first-run hold, from the desktop's own records and its folders. */
export function startFirstRun(input: {
  readonly userData: string
  readonly store: Store
  /** Whether the usage check-in has reported this install. */
  readonly reported: boolean
  /** The engine's data folder (<XDG_DATA_HOME>/vector), which holds its database. */
  readonly engineData?: string
  readonly folders?: LocalStartup.Input
}) {
  const held = firstRunHeld({
    answered: input.store.get(ANSWERED) === true,
    managed: LocalStartup.managed(input.folders ?? desktopLocalFolders(input.userData)),
    enabled: Egress.policy().enabled,
    heldBefore: input.store.get(HELD) === true,
    ranBefore: ranBefore(input),
  })
  state.hold = createFirstRunHold(held)
  if (!held) return state.hold
  input.store.set(HELD, true)
  void state.hold.answered().then(() => input.store.set(ANSWERED, true))
  return state.hold
}

/**
 * Whether this install ran before this start, from what earlier starts left: a usage check-in (`reported`), the state
 * the app's windows keep (the renderer's .dat stores in userData) or the engine's database. An install upgraded from a
 * release that never asked the first run's question has one of these, with usage sharing on or off.
 */
export function ranBefore(input: {
  readonly userData: string
  readonly engineData?: string
  readonly reported: boolean
}) {
  if (input.reported) return true
  if (entries(input.userData).some((name) => name.endsWith(".dat"))) return true
  return input.engineData !== undefined && entries(input.engineData).some((name) => name.endsWith(".db"))
}

// A folder's entries, or none when it is missing or Vector cannot read it: this runs before the app is ready, where a
// throw would stop Vector from starting.
function entries(folder: string) {
  try {
    return readdirSync(folder)
  } catch {
    return []
  }
}

/** The hold this start decided. */
export function firstRun() {
  return state.hold
}

/**
 * While the hold holds, asks every 15 seconds whether the person has chosen how to run models: a model connected (an
 * API key, a model server, or free models after signing in to Vector), or Vector Local turned on. It never gives up on
 * its own. Returns the function that stops asking.
 */
export function watchFirstRun(
  hold: FirstRunHold,
  input: {
    readonly answered: () => Promise<boolean>
    readonly interval?: number
  },
) {
  const status: { timer?: ReturnType<typeof setTimeout>; stopped: boolean } = { stopped: false }
  const check = async () => {
    status.timer = undefined
    if (status.stopped || !hold.held()) return
    if (await input.answered().catch(() => false)) return void hold.answer()
    if (status.stopped) return
    status.timer = setTimeout(() => void check(), input.interval ?? FIRST_RUN_CHECK)
    status.timer.unref?.()
  }
  void check()
  return () => {
    status.stopped = true
    clearTimeout(status.timer)
  }
}

/** Whether the person has chosen how to run models, as the engine and the Vector account tell it. */
export async function answeredByEngine(engine: Engine, signedIn: () => boolean, fetch: Fetch = globalThis.fetch) {
  if (signedIn()) return true
  const read = (path: string) =>
    fetch(new URL(path, engine.url).href, { headers: authorization(engine), signal: AbortSignal.timeout(10_000) })
      .then((response) => (response.ok ? response.json() : undefined))
      .catch(() => undefined) as Promise<unknown>
  const [providers, local] = await Promise.all([read("/provider"), read("/local")])
  const connected = (providers as { connected?: unknown } | undefined)?.connected
  if (Array.isArray(connected) && connected.length > 0) return true
  return (local as { policy?: { enabled?: unknown } } | undefined)?.policy?.enabled === true
}

/**
 * Whether the usage check-in may go now: not while the first run's hold holds, and with Vector Local on only when the
 * user allowed it. Its request still goes through Egress, which decides where it goes.
 */
export function usageCheckinAllowed(endpoint: string) {
  if (state.hold.held()) return false
  return (
    LocalPolicy.decide(Egress.policy(), { purpose: "usage", url: endpoint, source: "usage-checkin" }).decision ===
    "allow"
  )
}

/**
 * Vector Local's say over the updater: automatic checks run only when no first-run hold holds and Vector Local allows
 * them (off, or a company mirror); a check the user asks for asks first with Vector Local on, every time, and then lets
 * the updater's session reach the feed while it runs.
 */
export function createUpdateGate(deps: {
  readonly feed: () => string | undefined
  /** Asks the person; true to go ahead. */
  readonly ask: (question: { readonly message: string; readonly detail: string }) => Promise<boolean>
  /** Tells the person why a check cannot run. */
  readonly tell: (notice: { readonly message: string; readonly detail: string }) => Promise<void>
  /** Runs `run` while the updater's session may reach `origins`. */
  readonly during: <T>(origins: readonly string[], run: () => Promise<T>) => Promise<T>
  /** Where the feed's installers may live besides the feed itself, such as Vector's download host. */
  readonly downloads?: () => readonly string[]
  readonly policy?: () => LocalMode.Policy
  readonly held?: () => boolean
}) {
  const policy = deps.policy ?? Egress.policy
  const held = deps.held ?? (() => state.hold.held())
  const decide = (manual: boolean) =>
    LocalPolicy.decide(policy(), {
      purpose: "updates",
      url: deps.feed() ?? "https://vectordev.ai/",
      source: "updates",
      manual,
    })
  return {
    automatic: () => !held() && decide(false).decision === "allow",
    async manual() {
      const verdict = decide(true)
      if (verdict.decision === "allow") return true
      if (verdict.decision === "ask")
        return deps.ask({
          message: "Check for updates with Vector Local on?",
          detail:
            "Vector Local turns off automatic update checks. This check sends your Vector version and platform to Vector's update server, this once.",
        })
      await deps.tell({
        message: "Vector does not check for updates now",
        detail: `${verdict.reason} Change Web access, then check again.`,
      })
      return false
    },
    run<T>(run: () => Promise<T>) {
      const feed = deps.feed()
      if (!policy().enabled || !feed) return run()
      return deps.during([feed, ...(deps.downloads?.() ?? [])], run)
    },
    /**
     * A check the person started: asks first as `manual` does, then runs it as `run` does. Resolves undefined when
     * they cancelled or Vector Local refused it, so no stale "You're up to date" shows.
     */
    async checked<T>(run: () => Promise<T>): Promise<T | undefined> {
      if (!(await this.manual())) return undefined
      return this.run(run)
    },
  }
}

export type UpdateGate = ReturnType<typeof createUpdateGate>

/** Lets the updater's session reach `origins` while `run` runs. */
export function duringUpdateCheck<T>(
  fromPartition: (partition: string, options?: { cache: boolean }) => Target,
  origins: readonly string[],
  run: () => Promise<T>,
) {
  return egressFilter.allowing(fromPartition(UPDATER, UPDATER_OPTIONS), origins, run)
}

/** Vector Local as the app's windows see it. */
export function desktopLocalStatus(): DesktopLocalStatus {
  const policy = Egress.policy()
  const decide = (url: string) => decideChromium({ url, kind: "app", policy }).decision
  return {
    enabled: policy.enabled,
    web: policy.web,
    lock: policy.lock,
    held: state.hold.held(),
    ...(state.mismatch ? { mismatch: state.mismatch } : {}),
    restartNeeded: policy.enabled && !state.switchesSet,
    sources: {
      "release-notes": decide(RENDERER["release-notes"]),
      "site-assets": decide(RENDERER["site-assets"]),
      "crash-reports": decide(RENDERER["crash-reports"]),
      "dictation-model": decide(RENDERER["dictation-model"]),
    },
  }
}
