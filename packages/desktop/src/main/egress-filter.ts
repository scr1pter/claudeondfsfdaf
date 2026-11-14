import type { LocalMode } from "@vectordevai/schema/local-mode"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { EgressAttribution } from "@vectordevai/core/local-mode/attribution"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import type { CallbackResponse, OnBeforeRequestListenerDetails, Session, WebContents } from "electron"

// Vector Local in Chromium (plan section 4.3.6). The backstop guard sees the desktop's own Node requests, but not what
// Chromium loads for Vector's windows, the agent's browser, the research browsers or the updater, so every Chromium
// session gets one dispatcher on webRequest.onBeforeRequest. Electron keeps one listener per event per session, so
// nothing else may call onBeforeRequest itself: a window that needs one of its own (the billing window, the research
// browsers) registers a step here, which runs after Vector Local's own decision and only when that decision lets the
// request go. `decideChromium` is that decision, as a pure function of the address, the kind of session and the policy
// in effect. With Vector Local off it lets everything through and logs nothing, and the steps run as they would alone.
// What Chromium sends that no webRequest listener sees is listed in the registry (LocalSources, chromium-network).

/** What a Chromium session is for, which says what Vector Local lets it reach. */
export type Kind = "app" | "agent-browser" | "research-browser" | "updates" | "billing" | "cloud-computer" | "other"

/** Vector Local's decision for one request, with the registry source it is logged as. */
export type Decision = LocalPolicy.Verdict & { readonly source: string; readonly purpose: LocalMode.Purpose }

/** A listener as Electron's onBeforeRequest takes it, so a window's own listener registers here unchanged. */
export type Step = (details: OnBeforeRequestListenerDetails, callback: (response: CallbackResponse) => void) => void

export type Target = Pick<Session, "webRequest"> & Partial<Pick<Session, "setSpellCheckerDictionaryDownloadURL">>

// The renderer's own scheme (windows.ts, rendererProtocol), which serves the app's files from disk.
const APP_SCHEME = "oc:"
// Addresses that stay on this computer: files, the app's own pages, in-memory data and the browser's own pages.
const LOCAL_SCHEMES = new Set([
  "file:",
  "data:",
  "blob:",
  "about:",
  "devtools:",
  "chrome:",
  "chrome-error:",
  "chrome-extension:",
  APP_SCHEME,
])
// A research browser holds only web pages: in-memory data for what a page builds itself, and blank or inline frames,
// which inherit their parent (section 5.6a). Its own files, the app's pages and the browser's are never its to load.
const RESEARCH_SCHEMES = new Set(["data:", "blob:", "about:"])
const WEB_KINDS = new Set<Kind>(["agent-browser", "research-browser"])
// One record per host per page is enough for the log, so a page's hundreds of requests are a handful of lines.
const SEEN_LIMIT = 256
const STAY = "This stays on this computer."
const PRIVATE_REASON = "Research browsers never reach this computer, your network or a cloud metadata address."
const WINDOW_RULE =
  "This window's own rule stopped it before it left, such as a research browser's navigation rule or the billing window handing its return to the app."
// What the app's own code sends (its requests and WebSockets), as against what a page it shows loads.
const APP_REQUESTS = new Set(["xhr", "webSocket"])
// Where Chromium looks for spellcheck dictionaries under Vector Local on Windows and Linux: a port Chromium never
// connects to, on this computer, so no dictionary is downloaded and spellcheck keeps the ones already on disk.
const NO_DICTIONARIES = "http://127.0.0.1:9/"

/**
 * Whether Vector Local lets a Chromium session of `kind` load `url`. Vector's own windows reach this computer, its
 * files and pages, and the model servers on the list; on your network they reach the Vector servers they connect to
 * as Web access lets them: with None, only what the app's own code sends there (`resource` xhr or webSocket), never
 * what a page it shows loads, such as an image in a reply. What the app itself fetches from the internet (release
 * notes, crash reports, the dictation model) is decided as the registry source it is. The agent's browser and the
 * research browsers follow Web access, and a research browser never reaches this computer or your network. The
 * updater's session checks for updates only as `updates` allows, or for an origin the user just asked to check
 * (`granted`). Anything else is a request no part of Vector labelled, which reaches only this computer and the list.
 */
export function decideChromium(input: {
  readonly url: string
  readonly kind: Kind
  readonly policy: LocalMode.Policy
  /** Origins this session may reach for now, such as the update feed of a check the user asked for. */
  readonly granted?: Pick<ReadonlySet<string>, "has">
  /** What Chromium says the request is for (webRequest's resourceType). */
  readonly resource?: string
}): Decision {
  const labelled = label(input.kind, input.url)
  const decision = (
    verdict: Omit<LocalPolicy.Verdict, "allowable"> & { allowable?: boolean },
    source = labelled.source,
    purpose = labelled.purpose,
  ): Decision => ({ allowable: false, ...verdict, source, purpose })
  if (!URL.canParse(input.url))
    return decision({ decision: "block", rule: "unlabelled", class: "internet", reason: "This is not an address." })
  const url = new URL(input.url)
  const local = input.kind === "research-browser" ? RESEARCH_SCHEMES : LOCAL_SCHEMES
  if (!input.policy.enabled)
    return decision({ decision: "allow", rule: "local-off", class: "this-computer", reason: "Vector Local is off." })
  if (local.has(url.protocol))
    return decision({ decision: "allow", rule: "loopback", class: "this-computer", reason: STAY })
  const web = webAddress(url)
  if (!web)
    return decision({
      decision: "block",
      rule: "unlabelled",
      class: "internet",
      reason:
        input.kind === "research-browser"
          ? "Research browsers load web pages only."
          : "Vector Local lets Vector's windows load web addresses and their own files only.",
    })
  const place = LocalPolicy.hostClass(web.hostname)
  if (input.kind === "research-browser" && place !== "internet")
    return decision({ decision: "block", rule: "private-destination", class: place, reason: PRIVATE_REASON })
  // Until the policy is read, only this computer and the app's own schemes are reachable, as everywhere else: not the
  // Vector servers on your network, nor a feed the user asked to check.
  if (input.policy.pending)
    return decision(LocalPolicy.decide(input.policy, { purpose: labelled.purpose, url: web, source: labelled.source }))
  if (input.granted?.has(web.origin))
    return decision({
      decision: "allow",
      rule: "manual-check",
      class: LocalPolicy.classify(input.policy, web),
      reason: "You asked Vector to check for updates.",
    })
  // The app's windows talk to the Vector servers you connect them to: this computer's, WSL's and a build box's. With
  // Web access None, a reply the app shows still cannot make it load anything on your network.
  if (labelled.source === "unlabelled" && input.kind === "app" && place === "your-network") {
    if (input.policy.web !== "none" || APP_REQUESTS.has(input.resource ?? ""))
      return decision({
        decision: "allow",
        rule: "private-remote",
        class: LocalPolicy.classify(input.policy, web),
        reason: "Vector's windows reach the Vector servers they connect to on your network.",
      })
    return decision({
      decision: "block",
      rule: "web-none",
      class: LocalPolicy.classify(input.policy, web),
      reason:
        "Web access is None, so Vector's windows reach your network only for the Vector servers they connect to, not for what a page loads.",
    })
  }
  return decision(LocalPolicy.decide(input.policy, { purpose: labelled.purpose, url: web, source: labelled.source }))
}

/**
 * The dispatcher for every Chromium session: Vector Local's decision first, then the steps windows registered, in the
 * order they registered. Each request is logged through `record` while Vector Local is on, once its outcome is known:
 * a request a window's step cancels or redirects never leaves, so it is logged as blocked by that window's rule
 * (`window-rule`), never as a page loaded. One line per host per page for what a page loads, and never for what stays
 * on this computer, each attributed to the session whose browser made it (`attribute`), so a research or agent
 * browser's pages count in that session's counters.
 */
export function createEgressFilter(deps: {
  readonly policy: () => LocalMode.Policy
  readonly record: (request: Egress.Request, verdict: LocalPolicy.Verdict) => void
  readonly platform?: NodeJS.Platform
}) {
  type State = { kind: Kind; steps: Step[]; granted: Map<string, number> }
  const sessions = new WeakMap<Target, State>()
  // Every session the dispatcher is on, for what a change of policy applies to all of them. Sessions live as long as
  // the app: Electron frees none.
  const prepared = new Set<Target>()
  // Sessions whose spellcheck dictionaries Vector Local pointed at this computer; that holds until Vector restarts.
  const offline = new WeakSet<Target>()
  // The page each web contents is on, counted up at each main-frame request, and the hosts logged for it.
  const pages = new Map<number, { page: number; requests: Set<number>; seen: Set<string> }>()
  // Who each browser's requests are for, by web contents.
  const owners = new Map<number, EgressAttribution.Info>()

  // Chromium downloads spellcheck dictionaries from Google on Windows and Linux (macOS uses its own spellchecker).
  const dictionaries = (target: Target) => {
    const platform = deps.platform ?? process.platform
    if (offline.has(target) || !deps.policy().enabled || (platform !== "win32" && platform !== "linux")) return
    target.setSpellCheckerDictionaryDownloadURL?.(NO_DICTIONARIES)
    offline.add(target)
  }

  const state = (target: Target, kind?: Kind) => {
    const known = sessions.get(target)
    if (known) {
      if (kind) known.kind = kind
      return known
    }
    const created: State = { kind: kind ?? "other", steps: [], granted: new Map() }
    sessions.set(target, created)
    prepared.add(target)
    target.webRequest.onBeforeRequest((details, callback) => dispatch(created, details, callback))
    dictionaries(target)
    return created
  }

  const dispatch = (
    session: State,
    details: OnBeforeRequestListenerDetails,
    callback: (response: CallbackResponse) => void,
  ) => {
    const policy = deps.policy()
    const decided = decideChromium({
      url: details.url,
      kind: session.kind,
      policy,
      granted: session.granted,
      resource: details.resourceType,
    })
    const settle = (response: CallbackResponse, outcome: Decision) => {
      if (policy.enabled) log(session.kind, details, outcome)
      callback(response)
    }
    if (decided.decision !== "allow") return settle({ cancel: true }, decided)
    const stopped: Decision = { ...decided, decision: "block", rule: "window-rule", reason: WINDOW_RULE }
    // Electron holds a request until its listener answers, so a step that throws cancels it rather than hanging it.
    const run = (index: number): void => {
      const step = session.steps[index]
      if (!step) return settle({}, decided)
      try {
        step(details, (response) => {
          if (response.cancel || response.redirectURL) return settle(response, stopped)
          run(index + 1)
        })
      } catch {
        settle({ cancel: true }, stopped)
      }
    }
    run(0)
  }

  const log = (kind: Kind, details: OnBeforeRequestListenerDetails, decided: Decision) => {
    const contents = details.webContentsId ?? -1
    const known = pages.get(contents)
    const main = details.resourceType === "mainFrame"
    // A new main-frame request is a new page; a redirect hop of it is the same page reaching another host. One that
    // never left is a page refused, and what the page already open loads still counts for that page.
    const fresh = main && !known?.requests.has(details.id)
    const current =
      !known || (fresh && decided.decision === "allow")
        ? { page: (known?.page ?? 0) + 1, requests: new Set([details.id]), seen: new Set<string>() }
        : known
    if (current !== known) {
      pages.delete(contents)
      pages.set(contents, current)
      if (pages.size > SEEN_LIMIT) pages.delete(pages.keys().next().value!)
    }
    // A page on this computer is still a new page for what it loads, but stays out of the log.
    if (decided.decision === "allow" && decided.class === "this-computer") return
    const origin = URL.canParse(details.url) ? new URL(details.url).origin : details.url
    const key = `${origin} ${decided.decision}`
    if (!fresh && current.seen.has(key)) return
    current.seen.add(key)
    // Electron's callback runs in no session's scope, so the browser's own session is named here.
    EgressAttribution.run(owners.get(contents) ?? {}, () =>
      deps.record(
        {
          source: decided.source,
          url: details.url,
          method: details.method,
          ...(WEB_KINDS.has(kind) ? { resource: fresh ? ("page" as const) : ("subresource" as const) } : {}),
        },
        decided,
      ),
    )
  }

  return {
    /** Puts the dispatcher on a session, once, and says what the session is for. */
    prepare(target: Target, kind?: Kind) {
      state(target, kind)
    },
    /**
     * Adds a window's own onBeforeRequest listener to a session, after Vector Local's decision. Returns the function
     * that takes it off again.
     */
    register(target: Target, step: Step, options: { readonly kind?: Kind } = {}) {
      const session = state(target, options.kind)
      session.steps.push(step)
      return () => {
        session.steps = session.steps.filter((item) => item !== step)
      }
    },
    /** Lets a session reach `origins` while `run` runs, such as the update feed of a check the user asked for. */
    async allowing<T>(target: Target, origins: readonly string[], run: () => Promise<T>) {
      const session = state(target)
      const named = [...new Set(origins.flatMap((item) => (URL.canParse(item) ? [new URL(item).origin] : [])))]
      named.forEach((origin) => session.granted.set(origin, (session.granted.get(origin) ?? 0) + 1))
      return await run().finally(() =>
        named.forEach((origin) => {
          const left = (session.granted.get(origin) ?? 1) - 1
          if (left > 0) return void session.granted.set(origin, left)
          session.granted.delete(origin)
        }),
      )
    },
    /**
     * Attributes what a browser's web contents loads to the session it browses for, in the network log and the
     * counters. Returns the function that stops, for when the browser closes.
     */
    attribute(contentsID: number, info: EgressAttribution.Info) {
      owners.set(contentsID, info)
      return () => {
        if (owners.get(contentsID) === info) owners.delete(contentsID)
      }
    },
    /**
     * Under Vector Local, turns WebRTC's UDP off in a web contents. WebRTC can then use TCP only, through the session's
     * proxy when it has one (the research proxy, for research browsers). Vector's windows and the agent's browser have
     * no proxy, so there its TCP connects directly: the agent's browser also loses RTCPeerConnection and WebTransport
     * in its frames and dedicated workers (local-mode.ts), and Vector's windows run only the app.
     */
    protect(contents: Pick<WebContents, "setWebRTCIPHandlingPolicy">) {
      if (!deps.policy().enabled) return false
      contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp")
      return true
    },
    /**
     * After the policy changed: points every session's spellcheck dictionaries at this computer once Vector Local is
     * on. Turning Vector Local off leaves them there until Vector restarts; dictionaries already on disk still work.
     */
    refresh() {
      prepared.forEach(dictionaries)
    },
  }
}

export type EgressFilter = ReturnType<typeof createEgressFilter>

/** The desktop's dispatcher, deciding with the policy desktop main resolved and logging to its network log. */
export const egressFilter = createEgressFilter({
  policy: () => Egress.policy(),
  record: (request, verdict) => void Egress.record(request, verdict),
})

// The registry source a request is decided and logged as, by the kind of session and what the address is.
function label(kind: Kind, input: string): { source: string; purpose: LocalMode.Purpose } {
  if (kind === "agent-browser") return { source: "agent-browser", purpose: "browser" }
  if (kind === "research-browser") return { source: "research-browser", purpose: "research-browser" }
  if (kind === "updates") return { source: "updates", purpose: "updates" }
  // The cloud computer's live view window (WP A56) shows only the computer's own viewer page.
  if (kind === "cloud-computer") return { source: "cloud-computer", purpose: "account" }
  const url = URL.canParse(input) ? webAddress(new URL(input)) : undefined
  if (kind === "app" && url) {
    const host = url.hostname
    const vector = LocalPolicy.domainMatches(host, "vectordev.ai")
    if (vector && url.pathname === "/changelog.json") return { source: "release-notes", purpose: "release-notes" }
    if (vector && /\.(?:png|ico|svg|jpe?g|webp|gif)$/i.test(url.pathname))
      return { source: "site-assets", purpose: "asset" }
    if (LocalPolicy.domainMatches(host, "sentry.io")) return { source: "crash-reports", purpose: "crash" }
    if (["huggingface.co", "hf.co"].some((pattern) => LocalPolicy.domainMatches(host, pattern)))
      return { source: "dictation-model", purpose: "model-download" }
  }
  return { source: "unlabelled", purpose: "unknown" }
}

// A web address as Vector Local decides it: a WebSocket is the http or https address it starts from.
function webAddress(url: URL) {
  if (url.protocol === "http:" || url.protocol === "https:") return url
  if (url.protocol !== "ws:" && url.protocol !== "wss:") return undefined
  const web = new URL(url.href)
  web.protocol = url.protocol === "ws:" ? "http:" : "https:"
  return web
}
