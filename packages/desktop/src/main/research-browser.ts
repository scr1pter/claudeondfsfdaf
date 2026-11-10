import { BrowserWindow, WebContentsView, session, type Session, type WebContents } from "electron"
import { Effect } from "effect"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { ResearchProvenance } from "@vectordevai/core/research/provenance"
import { ResearchRate } from "@vectordevai/core/research/rate"
import { ResearchReader } from "@vectordevai/core/research/reader"
import { ResearchRobots } from "@vectordevai/core/research/robots"
import { ResearchSearch } from "@vectordevai/core/research/search"
import { queueTurn, runInWorld } from "./browser-agent"
import { isCredentialField } from "./browser-credential-field"
import { CredentialFocusChangedError, sendGuardedCharacters } from "./browser-credential-input"
import {
  clickElement,
  clickPoint,
  fieldValue,
  observePage,
  readPage,
  typeTarget,
  typingMoved,
  type Observed,
  type PageRead,
} from "./browser-page"
import { POST, addLinks, decideResearchNavigation, spelled, type Decision, type Kind } from "./research-navigation"
import { NEEDS_GUARD, startResearchProxy, type ResearchProxy } from "./research-proxy"
import { readSearchPage, searchOutcome, type SearchOutcome, type SearchPageRead } from "./research-search-page"
import { egressFilter } from "./egress-filter"

// Every research agent's own browser (section 5.6a). The lead `research` agent and each `researcher` it starts drive
// one research browser apiece, through the engine's research_browser tool and the bridge's POST /research. A run (keyed
// by the run's ID, which the engine takes from its root session) has at most 1 + its researcher cap open at once; an
// agent past that waits for one to close. They live in their own map, apart from the visible agent browser's contexts,
// so a research command has no way to name a visible-browser page and a visible-browser command none to name these.
//
// Isolation:
// - Each browser is a WebContentsView of 1280x900 inside one hidden host window (as cloud-browser-check.ts does), with
//   background throttling off so pages finish loading. The host is never focusable and never in the taskbar, and it is
//   destroyed when the last research browser closes, so it neither keeps Vector open once its windows close nor is a
//   window anything can show. Its session is a slot from a pool of in-memory partitions,
//   `vector-research-<n>`: Electron has no call that frees a session, so a partition per run would keep each one until
//   Vector quits. A slot serves one agent at a time and shares no cookies, storage, cache or sign-in with the user's
//   browser or another slot. When its browser closes, its pages close and then every storage type (service workers
//   included), the cache, the auth cache, the host resolver cache and the open connections are cleared; a slot whose
//   clearing fails, or whose page is still alive 2 seconds after it was told to close, is retired. The pool grows to the
//   most browsers open at once and does not shrink; it is not a cap. Known residual: Electron has no call that clears a
//   session's HSTS entries, so a site that sets them can recognise the slot when a later agent's browser in it visits
//   (it learns that the visits came from the same Vector, which the network address often tells it anyway).
// - Sandbox, context isolation and web security on, Node off, no preload, dialogs off, no spellcheck, audio muted,
//   WebRTC only through the proxy (and stubbed), no webview tags, no plugins (so a PDF is a download), and no File
//   System Access pickers (the Blink feature is off in every frame of the page, and stubbed too). Every document
//   a research browser loads, each frame's included, gets a CSP `sandbox` without `allow-modals`, which a fresh frame
//   inherits and cannot undo: no print dialog, alert, confirm or prompt. Vector never focuses one; typing goes to the
//   field with the page told it has focus (DevTools focus emulation), so the user's window keeps the keyboard.
// - Every permission is denied, fullscreen included, and there is no display-media handler, so screen capture is
//   refused. Downloads are cancelled; a PDF is fetched again through the proxy into memory for the reader instead.
// - No credentials of any kind: a client-certificate request gets none, `login` is answered only for the browser's own
//   proxy, a site's NTLM or Negotiate challenge is cancelled before Chromium can answer it with the user's own Windows
//   or Kerberos sign-in, and certificate errors are never overridden. allowNTLMCredentialsForDomains is not used: Electron
//   applies it to the whole app, and an empty list is no list, so on Windows the system's own zone settings would still
//   decide which hosts get the user's sign-in.
// - Service worker scripts are cancelled in the network stack (their request carries a `Service-Worker` header), since
//   a script stub can be undone from a fresh frame; clearing a slot removes any registration.
// - A popup or target=_blank link loads in the same page when the navigation rule allows it.
// - Between commands the page's scripts are held in the DevTools debugger and run again for the next command, so a
//   hostile page cannot keep its scripts, timers or network callbacks running; file choosers are intercepted there, so
//   none opens. After a load or an action the page runs until it has made no request for half a second (at most 3
//   seconds), so a page built by script after its load event is built when it is held. A page that does not answer
//   within the command deadline is closed, and so is a browser whose page the debugger cannot attach to.
// - Fonts never load; images and media load only when the agent's model reads images. A page load may make at most
//   150 other requests and receive 20 MB, counted by the browser's own proxy as the bytes arrive (chunked and
//   compressed answers included), after which further requests are cancelled. An answer already arriving then may
//   finish, up to 40 MB for the page load, its own document included; past that the proxy ends the browser's
//   connections, so one endless answer cannot keep downloading while the page waits for its next command.
// - Every request goes through the browser's own proxy (research-proxy.ts). The navigation rule (research-navigation.ts)
//   runs in onBeforeRequest on every main-frame and subframe request and redirect hop, with the run's provenance, the
//   run's per-host rate limits for documents and robots.txt for what Vector discovered.
// - A browser closes when its agent's session finishes (the engine closes it), when its run is stopped, after 10 idle
//   minutes, or when its page stops answering.
//
// Searching (research_search, section 5.7): the agent's own browser loads the results page Vector builds for the query,
// Google's first, and Vector reads the organic results off it (research-search-page.ts). A check for automated
// traffic, a consent wall or a page Vector cannot read is never answered or clicked through: the browser loads
// DuckDuckGo's HTML results page once instead, and when that is no better, search is unavailable for this call. While
// the browser shows a results page (or a check one led to), the agent may only open, go back, search again or close:
// nothing on it can be read as a source, clicked or typed into. What the browser shows is decided when a page commits,
// not when its load starts, so a load that never commits (a PDF, which is a download, a 204 answer or a timeout)
// leaves the guard as it was; and a page on a search engine's own host is held to it whatever led there.
//
// Electron keeps one listener per webRequest event per session, and Vector Local's Chromium dispatcher
// (egress-filter.ts) holds each session's onBeforeRequest: the navigation rule registers there as a step, which runs
// after Vector Local's own decision. The other webRequest events are this file's alone.

export const PARTITION_PREFIX = "vector-research-"
export const VIEW = { width: 1280, height: 900 } as const
export const IDLE_MS = 10 * 60_000
export const LOAD_TIMEOUT_MS = 20_000
export const COMMAND_DEADLINE_MS = 45_000
/** How long an agent past its run's count waits for a research browser to close. */
export const WAIT_MS = 60_000
/** How long a page must make no request after a load or an action before it counts as settled, and the most to wait. */
export const QUIET_MS = 500
export const SETTLE_MS = 3_000
/** How long typing waits for the page to show the keys it was sent. */
export const TYPED_MS = 2_000
export const MAX_SUBRESOURCES = 150
export const MAX_SUBRESOURCE_BYTES = 20 * 1024 * 1024
/** The most a page load receives in all, answers already arriving and its own document included. */
export const MAX_PAGE_BYTES = 2 * MAX_SUBRESOURCE_BYTES
/** How often a page load's bytes are checked against MAX_PAGE_BYTES. */
const BOUND_MS = 200
/** Roughly what observe shows of the page's text. */
export const OBSERVE_TEXT = 1_200
const OBSERVE_ELEMENTS = 80
// The isolated world Vector's page scripts run in, apart from the page's globals and the visible browser's worlds.
const WORLD = 1_301

export const DOWNLOADS_OFF = "Downloads are off in research browsers."
export const PDF_OPENED = "That address is a PDF; Vector read it into memory instead of downloading it."
export const SUBRESOURCES =
  "The page made more requests, or loaded more, than a research browser allows, so the rest were cancelled."
export const PAGE_CUT =
  "The page kept loading past the 40 MB a research browser allows, so Vector ended its connections; what loaded before stays."
export const AMBIENT = "Research browsers never sign in to a site with your own Windows or Kerberos account."
export const NO_DEVTOOLS =
  "Vector could not attach to the research browser's page, so it closed the browser: without that it cannot hold the page's scripts between commands or keep file dialogs from opening."
export const SERVICE_WORKER = "Research browsers do not run service workers."
export const STOPPED = "The user stopped this research browser, so this agent browses no more in this research."
export const ON_SEARCH =
  "Your research browser is on a search engine's page. Its results came back from research_search: open one of them to read it."
/** How long one results page may take to load: both engines' pages and their settling fit in the command deadline. */
export const SEARCH_LOAD_MS = 15_000
/** The CSP every research browser document gets: scripts, its own origin and GET forms, and no dialogs of any kind. */
export const SANDBOX = "sandbox allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
export const ROBOTS = ResearchReader.ROBOTS
export const KEYS = ["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"] as const

export type ResearchCommand =
  | "research.open"
  | "research.read"
  | "research.links"
  | "research.find"
  | "research.observe"
  | "research.click"
  | "research.type"
  | "research.press"
  | "research.scroll"
  | "research.back"
  | "research.screenshot"
  | "research.search"
  | "research.close"

export type ResearchInput = {
  readonly command: ResearchCommand
  readonly runID: string
  readonly sessionID: string
  /** The run's lead, who the requests are attributed to as root. */
  readonly rootID?: string
  readonly agent: "research" | "researcher"
  /** How many research browsers the run may have open at once: 1 + its researcher cap. */
  readonly max: number
  /** The agent's model reads images, so images and media load and screenshots are taken. */
  readonly images?: boolean
  /** The copy of the run's provenance the engine last saw; without it, `provenance` is the whole set. */
  readonly generation?: string
  readonly provenance?: readonly string[]
  /** Addresses the user typed: robots.txt does not apply to them. */
  readonly typed?: readonly string[]
  readonly url?: string
  readonly ref?: string
  readonly text?: string
  readonly key?: string
  readonly deltaY?: number
  /** search: the words to search for, the site filter already in them as `site:`. */
  readonly query?: string
  readonly recency?: ResearchSearch.Recency
  readonly limit?: number
  /** search: the engines Vector Local lets this search reach, in order (both by default). */
  readonly engines?: readonly ResearchSearch.Engine[]
}

export type Report = {
  readonly ok: boolean
  readonly error?: string
  /** The desktop's copy of the run's provenance is not the one the engine named: send it whole. */
  readonly resync?: boolean
  readonly generation: string
  readonly label: string
  /** The address the navigation rule decided for the page shown. */
  readonly url: string
  /** The address bar, which a page can change on its own (history.pushState). */
  readonly address: string
  readonly title: string
  readonly status?: number
  /** Links a navigation followed since the last command, which joined the run's provenance. */
  readonly joined: readonly string[]
  /** Navigations the rule refused since the last command, and why. */
  readonly refused: readonly { readonly url: string; readonly reason: string }[]
  readonly read?: PageRead
  readonly observed?: Observed
  readonly screenshot?: string
  readonly pdf?: { readonly url: string; readonly base64: string; readonly contentType: string }
  /** What typing left in the field, when it is not what was typed. */
  readonly value?: string
  /** search: the engine whose results page answered, its results, and why each engine before it did not. */
  readonly search?: {
    readonly engine?: ResearchSearch.Engine
    readonly results: readonly ResearchSearch.Result[]
    readonly tried: readonly { readonly engine: ResearchSearch.Engine; readonly reason: string }[]
  }
}

/** One live chip per research browser, for watching (the Sources tab). */
export type Chip = {
  readonly id: string
  readonly runID: string
  readonly sessionID: string
  readonly label: string
  readonly host: string
  readonly state: State
}

type State = "opening" | "loading" | "reading" | "browsing" | "idle"

// ---------------------------------------------------------------------------------------------------------------
// The slot pool

/** What a slot's clearing needs of a session: Electron's Session has it. */
export type SlotSession = Pick<
  Session,
  "clearStorageData" | "clearCache" | "clearAuthCache" | "clearHostResolverCache" | "closeAllConnections"
>

export type Slot<S extends SlotSession = SlotSession> = {
  readonly name: string
  readonly session: S
  busy: boolean
  retired: boolean
}

/** A pool of in-memory partitions. A slot serves one agent at a time; one whose clearing fails is never used again. */
export function slotPool<S extends SlotSession>(make: (name: string) => S) {
  const slots: Slot<S>[] = []
  return {
    acquire: () => {
      const free = slots.find((slot) => !slot.busy && !slot.retired)
      if (free) {
        free.busy = true
        return free
      }
      const name = `${PARTITION_PREFIX}${slots.length + 1}`
      const slot: Slot<S> = { name, session: make(name), busy: true, retired: false }
      slots.push(slot)
      return slot
    },
    /**
     * Clears the slot for its next agent, or retires it when clearing fails or `retire` says its page may still be
     * alive. Whether it was cleared.
     */
    release: async (slot: Slot<S>, retire = false) => {
      const cleared = await clear(slot.session).then(
        () => true,
        () => false,
      )
      slot.retired = slot.retired || !cleared || retire
      slot.busy = false
      return cleared
    },
    slots: () => [...slots],
  }
}

async function clear(target: SlotSession) {
  // No storage types named: every one, service workers and cache storage included.
  await target.clearStorageData()
  await target.clearCache()
  await target.clearAuthCache()
  await target.clearHostResolverCache()
  await target.closeAllConnections()
}

// ---------------------------------------------------------------------------------------------------------------
// State

type Run = {
  readonly id: string
  readonly generation: string
  provenance: ResearchProvenance.Addresses
  readonly browsers: Map<string, Browser>
  opening: number
  researchers: number
  readonly waiters: Set<() => void>
  readonly limiter: ResearchRate.Limiter
  readonly robots: ResearchRobots.Cache
}

type Browser = {
  readonly key: string
  readonly run: Run
  readonly sessionID: string
  readonly agent: ResearchInput["agent"]
  readonly label: string
  readonly slot: Slot<Session>
  readonly proxy: ResearchProxy
  readonly view: WebContentsView
  readonly contents: WebContents
  readonly contentsID: number
  /** Stops attributing what this browser loads to its agent's session (the Vector Local dispatcher's log). */
  readonly unattribute: () => void
  queue: Promise<unknown>
  closing: AbortController
  closed: boolean
  images: boolean
  state: State
  idle?: ReturnType<typeof setTimeout>
  /** Checks the page load's bytes against MAX_PAGE_BYTES while the browser is open. */
  watch?: ReturnType<typeof setInterval>
  debugger: boolean
  /** Links and GET form targets Vector read on the page at the agent's last read, links or observe. */
  links: Set<string>
  forms: Set<string>
  /**
   * The href of the element the agent is clicking, for the one main-frame navigation the click starts; cleared when
   * that navigation is decided, when the click command ends, at every other command and on every navigation.
   */
  clicked?: string
  actedAt?: number
  /** The page's address as the rule decided it. */
  decided?: string
  /** The page shown is a results page a search loaded, or a page its load led to on its own: set when a page commits. */
  search: boolean
  /** The last main-frame request the rule allowed, and whether it is a search's: what `search` becomes if it commits. */
  landing?: { readonly url: string; readonly search: boolean }
  status?: number
  /** A load Vector itself started, already decided: the agent's open or back, or a popup the rule allowed. */
  expected?: { readonly url: string; readonly decision: Decision & { readonly allow: true } }
  /**
   * Main-frame requests in flight, by request ID, so a redirect hop is known as one: the host the user typed it on, and
   * whether it is a search's (a results page, or a navigation a search engine's page made on its own).
   */
  readonly requests: Map<number, { readonly typedHost?: string; readonly search: boolean }>
  /** Every request of the page in flight, for waiting until it is quiet. */
  inflight: Set<number>
  /**
   * This page load's other requests, what the proxy had received when it began, whether it passed the request bound,
   * and whether its connections were ended at MAX_PAGE_BYTES.
   */
  page: { requests: number; start: number; over: boolean; cut: boolean }
  joined: string[]
  refused: { url: string; reason: string }[]
  download?: { readonly url: string; readonly mime: string }
}

const runs = new Map<string, Run>()
const browsers = new Map<string, Browser>()
const byContents = new Map<number, Browser>()
const opening = new Map<string, Promise<Browser | { readonly error: string }>>()
const watchers = new Set<() => void>()
// Browsers the user stopped, by run and session, so their agent does not open another (the most recent ones).
const stopped = new Set<string>()
const STOPPED_KEPT = 500
const hardened = new WeakSet<object>()
const pool = slotPool((name) => session.fromPartition(name))
const host: { window?: BrowserWindow } = {}

// ---------------------------------------------------------------------------------------------------------------
// Commands

/** Runs one research browser command for one agent of one run. */
export async function runResearchBrowser(input: ResearchInput): Promise<Report> {
  const key = `${input.runID}:${input.sessionID}`
  // Before the run's copy of the provenance is touched: closing a browser the desktop no longer holds (the engine's
  // close after the idle close, a timeout or Stop) starts no run.
  if (input.command === "research.close") {
    const generation = runs.get(input.runID)?.generation ?? ""
    const existing = browsers.get(key)
    if (existing) await closeBrowser(existing)
    return { ...empty(generation), ok: true }
  }
  if (stopped.has(key)) return { ...empty(runs.get(input.runID)?.generation ?? ""), ok: false, error: STOPPED }
  const run = sync(input)
  if (!run) return { ...empty(""), ok: false, resync: true, error: "Send the run's addresses again." }
  const found = browsers.get(key) ?? (await obtain(key, input, run))
  if ("error" in found) return { ...empty(run.generation), ok: false, error: found.error }
  const browser = found
  browser.images = input.images === true
  if (browser.idle) clearTimeout(browser.idle)
  return queueTurn(
    browser,
    () => perform(browser, input),
    (reason) => {
      if (reason === "timeout") void closeBrowser(browser)
      return {
        ...report(browser),
        ok: false,
        error:
          reason === "timeout"
            ? `The page did not answer within ${COMMAND_DEADLINE_MS / 1000} seconds, so Vector closed its research browser.`
            : "The research browser closed before this command finished.",
      }
    },
    COMMAND_DEADLINE_MS,
  ).finally(() => {
    if (browser.closed) return
    // Commands can overlap: the timer the one before armed is replaced, never left behind to close a browser in use.
    if (browser.idle) clearTimeout(browser.idle)
    browser.idle = setTimeout(() => void closeBrowser(browser), IDLE_MS)
    browser.idle.unref?.()
  })
}

// The desktop's copy of the run's provenance: kept while any of the run's browsers is open, with the links its
// browsers followed added. The engine sends what it added since the copy it last saw, or the whole set to start one.
function sync(input: ResearchInput) {
  const known = runs.get(input.runID)
  if (input.generation !== undefined && known?.generation !== input.generation) return undefined
  const run = known ?? createRun(input.runID)
  run.provenance = addLinks(run.provenance, input.provenance ?? [], "search")
  run.provenance = addLinks(run.provenance, input.typed ?? [], "typed")
  return run
}

function createRun(id: string): Run {
  const run: Run = {
    id,
    generation: crypto.randomUUID(),
    provenance: ResearchProvenance.empty(),
    browsers: new Map(),
    opening: 0,
    researchers: 0,
    waiters: new Set(),
    limiter: ResearchRate.make(),
    // robots.txt through one of the run's open browsers' proxies; with none open, nothing is read.
    robots: ResearchRobots.cache((address) =>
      Effect.promise(() => {
        const through = [...run.browsers.values()].find((browser) => !browser.closed)?.proxy
        return through ? through.robots(address) : Promise.resolve({ status: "unreachable" as const })
      }),
    ),
  }
  runs.set(id, run)
  return run
}

// The agent's browser, opened once even when two of its calls arrive together, after waiting for room in the run.
function obtain(key: string, input: ResearchInput, run: Run) {
  const pending = opening.get(key)
  if (pending) return pending
  const started = (async () => {
    const deadline = Date.now() + WAIT_MS
    while (run.browsers.size + run.opening >= input.max) {
      const freed = await new Promise<boolean>((resolve) => {
        const wake = () => {
          clearTimeout(timer)
          run.waiters.delete(wake)
          resolve(true)
        }
        const timer = setTimeout(
          () => {
            run.waiters.delete(wake)
            resolve(false)
          },
          Math.max(0, deadline - Date.now()),
        )
        run.waiters.add(wake)
      })
      if (!freed)
        return {
          error: `This research has its ${input.max} research browser${input.max === 1 ? "" : "s"} open. Vector waited ${WAIT_MS / 1000} seconds for one to close; try again when a researcher finishes.`,
        }
    }
    run.opening++
    return open(key, input, run).finally(() => {
      run.opening--
    })
  })().finally(() => opening.delete(key))
  opening.set(key, started)
  return started
}

async function open(key: string, input: ResearchInput, run: Run): Promise<Browser | { readonly error: string }> {
  const slot = pool.acquire()
  const partition = slot.session
  if (!hardened.has(partition)) {
    harden(partition)
    hardened.add(partition)
  }
  const attribution = {
    sessionID: input.sessionID,
    ...(input.rootID ? { rootID: input.rootID } : {}),
    agent: input.agent,
  }
  const proxy = await startResearchProxy({ attribution }).catch(async (error: unknown) => {
    await pool.release(slot)
    return { error: error instanceof Error ? error.message : String(error) }
  })
  if ("error" in proxy) return proxy
  // Before the slot's first page, so nothing it loads goes around the proxy.
  const applied = await proxy.apply(partition).then(
    () => true,
    () => false,
  )
  if (!applied) {
    await proxy.stop()
    await pool.release(slot)
    return { error: NEEDS_GUARD }
  }
  const view = new WebContentsView({
    webPreferences: {
      session: partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      disableDialogs: true,
      spellcheck: false,
      backgroundThrottling: false,
      webviewTag: false,
      plugins: false,
      navigateOnDragDrop: false,
      autoplayPolicy: "document-user-activation-required",
      // showOpenFilePicker, showSaveFilePicker and showDirectoryPicker, in every frame, a fresh one included: a native
      // file dialog would open on the user's screen from a click the agent made.
      disableBlinkFeatures: "FileSystemAccessLocal",
    },
  })
  hostWindow().contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, ...VIEW })
  const contents = view.webContents
  contents.setAudioMuted(true)
  contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp")
  const browser: Browser = {
    key,
    run,
    sessionID: input.sessionID,
    agent: input.agent,
    label: input.agent === "research" ? "Research lead" : `Researcher ${++run.researchers}`,
    slot,
    proxy,
    view,
    contents,
    contentsID: contents.id,
    // The pages it opens count in its run's counters, as its proxy's connections do.
    unattribute: egressFilter.attribute(contents.id, attribution),
    queue: Promise.resolve(),
    closing: new AbortController(),
    closed: false,
    images: input.images === true,
    state: "opening",
    debugger: false,
    search: false,
    links: new Set(),
    forms: new Set(),
    requests: new Map(),
    inflight: new Set(),
    page: { requests: 0, start: proxy.received(), over: false, cut: false },
    joined: [],
    refused: [],
  }
  browsers.set(key, browser)
  byContents.set(contents.id, browser)
  run.browsers.set(input.sessionID, browser)
  wire(browser)
  browser.watch = setInterval(() => bound(browser), BOUND_MS)
  browser.watch.unref?.()
  // The first empty page, which the rule allows once: DevTools answers nothing about a page before there is one.
  await contents.loadURL("about:blank").catch(() => undefined)
  if (contents.isDestroyed()) {
    await closeBrowser(browser)
    return { error: "The research browser closed as it opened." }
  }
  if (!(await devtools(browser))) {
    await closeBrowser(browser)
    return { error: NO_DEVTOOLS }
  }
  changed()
  return browser
}

// Ends the browser's connections once its page load has received MAX_PAGE_BYTES: the request bound stops new requests
// only, and the network keeps reading an answer while the page's scripts are held.
function bound(browser: Browser) {
  if (browser.closed || browser.page.cut) return
  if (browser.proxy.received() - browser.page.start <= MAX_PAGE_BYTES) return
  browser.page.cut = true
  browser.page.over = true
  browser.proxy.drop()
  note(browser, browser.decided ?? "", PAGE_CUT)
}

async function perform(browser: Browser, input: ResearchInput): Promise<Report> {
  // A click's href is good for the navigation that click starts, never for a later command's.
  browser.clicked = undefined
  await lifecycle(browser, "running")
  const result = await act(browser, input).catch(
    (error: unknown): Partial<Report> => ({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  )
  if (!browser.closed) await lifecycle(browser, "paused")
  browser.state = "idle"
  changed()
  return { ...report(browser), ok: true, ...result }
}

// What may not be done on a search engine's page: its results are research_search's, and a check is never answered.
const OFF_SEARCH = new Set<ResearchCommand>([
  "research.read",
  "research.links",
  "research.find",
  "research.observe",
  "research.click",
  "research.type",
  "research.press",
  "research.scroll",
  "research.screenshot",
])

async function act(browser: Browser, input: ResearchInput): Promise<Partial<Report>> {
  const contents = browser.contents
  if (OFF_SEARCH.has(input.command) && onSearch(browser)) return fail(ON_SEARCH)
  switch (input.command) {
    case "research.open": {
      if (!input.url) return fail("Give the address to open.")
      browser.state = "loading"
      changed()
      const decision = decide(browser, input.url, "open")
      if (!decision.allow) return refuse(browser, input.url, decision.reason)
      browser.actedAt = Date.now()
      browser.expected = { url: spelled(input.url), decision }
      await load(browser, () => contents.loadURL(input.url!))
      await quiet(browser)
      return finishLoad(browser)
    }
    case "research.read":
    case "research.links":
    case "research.find": {
      browser.state = "reading"
      changed()
      const read = await world<PageRead>(browser, readPage, { maxBytes: ResearchReader.MAX_BYTES })
      remember(browser, read.links, read.forms)
      // links and find need the page's links or its text, not the whole page again.
      return input.command === "research.links" ? { read: { ...read, html: "" } } : { read }
    }
    case "research.observe": {
      browser.state = "browsing"
      const observed = await world<Observed>(browser, observePage, {
        maxText: OBSERVE_TEXT,
        maxElements: OBSERVE_ELEMENTS,
      })
      remember(browser, observed.links, observed.forms)
      return { observed }
    }
    case "research.click": {
      if (!input.ref) return fail("Give the ref of what to click, from observe.")
      browser.state = "browsing"
      const point = await world<Awaited<ReturnType<typeof clickPoint>>>(browser, clickPoint, input.ref)
      if (!point.ok) return fail(point.reason)
      browser.clicked = point.href
      browser.actedAt = Date.now()
      if (point.hit) {
        contents.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y })
        contents.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y, button: "left", clickCount: 1 })
        contents.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y, button: "left", clickCount: 1 })
      }
      if (!point.hit) await world(browser, clickElement, input.ref)
      await settle(browser)
      browser.clicked = undefined
      return finishLoad(browser)
    }
    case "research.type": {
      if (!input.ref) return fail("Give the ref of the field to type into, from observe.")
      const text = input.text ?? ""
      if (/[\r\n\t]/.test(text)) return fail("Type text without line breaks or tabs; press Enter to submit.")
      browser.state = "browsing"
      const target = await world<Awaited<ReturnType<typeof typeTarget>>>(
        browser,
        typeTarget,
        input.ref,
        isCredentialField,
      )
      if (!target.ok) return fail(target.reason)
      browser.actedAt = Date.now()
      const typed = await sendGuardedCharacters(
        text,
        () => world<boolean>(browser, typingMoved, input.ref!, isCredentialField),
        (event) => contents.sendInputEvent(event),
      ).then(
        () => true,
        (error: unknown) => {
          if (error instanceof CredentialFocusChangedError) return false
          throw error
        },
      )
      if (!typed) return fail("Focus left the field while Vector typed, so it stopped.")
      browser.actedAt = Date.now()
      const value = await typedValue(browser, input.ref, text)
      return value === undefined || value.endsWith(text) ? {} : { value }
    }
    case "research.press": {
      const key = KEYS.find((item) => item === input.key)
      if (!key) return fail(`Research browsers press only ${KEYS.join(", ")}.`)
      browser.state = "browsing"
      browser.actedAt = Date.now()
      contents.sendInputEvent({ type: "keyDown", keyCode: key })
      if (key === "Enter") contents.sendInputEvent({ type: "char", keyCode: key })
      contents.sendInputEvent({ type: "keyUp", keyCode: key })
      browser.actedAt = Date.now()
      await settle(browser)
      return finishLoad(browser)
    }
    case "research.scroll": {
      const amount = Math.max(-2_400, Math.min(input.deltaY ?? 700, 2_400))
      await world(browser, (win: Window, delta: number) => win.scrollBy(0, delta), amount)
      return {}
    }
    case "research.back": {
      const history = contents.navigationHistory
      const index = history.getActiveIndex()
      const entry = index > 0 ? history.getEntryAtIndex(index - 1) : undefined
      // The browser's first empty page is not a page to go back to.
      if (!entry || entry.url === "about:blank") return fail("There is no earlier page in this research browser.")
      const decision = decide(browser, entry.url, "back")
      if (!decision.allow) return refuse(browser, entry.url, decision.reason)
      browser.actedAt = Date.now()
      browser.expected = { url: spelled(entry.url), decision }
      history.goBack()
      await settle(browser)
      return finishLoad(browser)
    }
    case "research.screenshot": {
      if (!browser.images) return fail("Screenshots are only taken for a model that reads images.")
      const image = await contents.capturePage()
      return { screenshot: image.toDataURL() }
    }
    case "research.search": {
      const query = (input.query ?? "").trim()
      if (!query) return fail("Give the words to search for.")
      browser.state = "loading"
      changed()
      return search(
        browser,
        { query, ...(input.recency ? { recency: input.recency } : {}) },
        input.limit ?? ResearchSearch.DEFAULT_RESULTS,
        input.engines ?? ResearchSearch.ENGINES,
        [],
      )
    }
    case "research.close":
      return {}
  }
}

// Whether the page shown is a search's, or on a search engine's own host (a check, a consent wall, a results page),
// however the browser got there.
function onSearch(browser: Browser) {
  if (browser.search) return true
  const shown = browser.contents.isDestroyed() ? "" : browser.contents.getURL()
  return URL.canParse(shown) && ResearchSearch.own(new URL(shown).hostname)
}

// Searches on each engine in turn until one answers with a results page; the next is tried only after a check, a
// consent wall or a page Vector could not read, so DuckDuckGo is tried once at most.
async function search(
  browser: Browser,
  query: ResearchSearch.Query,
  limit: number,
  engines: readonly ResearchSearch.Engine[],
  tried: readonly { readonly engine: ResearchSearch.Engine; readonly reason: string }[],
): Promise<Partial<Report>> {
  const engine = engines[0]
  if (!engine)
    return {
      ok: false,
      error: ResearchSearch.unavailable(tried),
      search: { results: [], tried },
    }
  const outcome = await searchOn(browser, engine, query, limit)
  if (outcome.kind === "results") return { search: { engine, results: outcome.results, tried } }
  return search(browser, query, limit, engines.slice(1), [...tried, { engine, reason: outcome.reason }])
}

// One engine's results page, loaded as Vector's own navigation and read without touching it.
async function searchOn(
  browser: Browser,
  engine: ResearchSearch.Engine,
  query: ResearchSearch.Query,
  limit: number,
): Promise<SearchOutcome> {
  const url = ResearchSearch.page(engine, query)
  const decision = decide(browser, url, "search")
  if (!decision.allow) return { kind: "unreadable", reason: decision.reason }
  browser.actedAt = Date.now()
  browser.expected = { url: spelled(url), decision }
  const failed = await load(browser, () => browser.contents.loadURL(url), SEARCH_LOAD_MS).then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  )
  if (failed) return { kind: "unreadable", reason: failed }
  await quiet(browser)
  return world<SearchPageRead>(browser, readSearchPage, engine).then(
    (read) => searchOutcome(engine, read, limit),
    (): SearchOutcome => ({
      kind: "unreadable",
      reason: `Vector could not read ${ResearchSearch.NAMES[engine]}'s results page.`,
    }),
  )
}

// The field's value once the page has taken the keys: Chromium hands the page key events after sendInputEvent returns,
// and a page held before then would show them only at the next command. After TYPED_MS, what the field shows.
async function typedValue(browser: Browser, ref: string, text: string) {
  const deadline = Date.now() + TYPED_MS
  while (true) {
    const value = await world<string | undefined>(browser, fieldValue, ref)
    if (value === undefined || value.endsWith(text) || Date.now() >= deadline) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

// After a load: a PDF the browser would have downloaded is fetched into memory through the proxy instead.
async function finishLoad(browser: Browser): Promise<Partial<Report>> {
  const download = browser.download
  browser.download = undefined
  if (!download) return {}
  const got = await browser.proxy.get(download.url, ResearchReader.MAX_BYTES).catch(() => undefined)
  if (!got || got.status < 200 || got.status >= 300) return fail(`${DOWNLOADS_OFF} Vector could not read that PDF.`)
  return { pdf: { url: download.url, base64: got.body.toString("base64"), contentType: got.contentType } }
}

function decide(
  browser: Browser,
  url: string,
  kind: Kind,
  extra: {
    readonly frame?: "main" | "sub"
    readonly method?: string
    readonly typedHost?: string
    /** For a redirect hop: whether its navigation is a search's, which the page shown says for anything else. */
    readonly searching?: boolean
  } = {},
) {
  return decideResearchNavigation({
    url,
    method: extra.method ?? "GET",
    frame: extra.frame ?? "main",
    kind,
    initial: browser.decided === undefined && url === "about:blank",
    provenance: browser.run.provenance,
    links: browser.links,
    forms: browser.forms,
    ...(browser.clicked ? { clicked: browser.clicked } : {}),
    ...(browser.decided ? { current: browser.decided } : {}),
    ...(browser.actedAt !== undefined ? { actedAt: browser.actedAt } : {}),
    now: Date.now(),
    ...(extra.typedHost ? { typedHost: extra.typedHost } : {}),
    ...((extra.searching ?? browser.search) ? { searching: true } : {}),
  })
}

// What the agent read on the page: the links the rule lets it follow, as page links do, and the GET forms.
function remember(browser: Browser, links: readonly { readonly url: string }[], forms: readonly string[]) {
  browser.links = new Set(ResearchProvenance.offered(links).map((link) => spelled(link.url)))
  browser.forms = new Set(forms)
}

function refuse(browser: Browser, url: string, reason: string): Partial<Report> {
  note(browser, url, reason)
  return fail(reason)
}

function note(browser: Browser, url: string, reason: string) {
  if (browser.refused.some((item) => item.url === url && item.reason === reason)) return
  browser.refused = [...browser.refused, { url, reason }].slice(-20)
}

function fail(error: string): Partial<Report> {
  return { ok: false, error }
}

// Loads within the timeout. A load the rule cancelled reads as the rule's reason, not as a network error.
async function load(browser: Browser, start: () => Promise<void>, timeout = LOAD_TIMEOUT_MS) {
  const before = browser.refused.length
  const outcome = await Promise.race([
    start().then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    ),
    new Promise<string>((resolve) =>
      setTimeout(() => resolve(`The page did not load within ${timeout / 1000} seconds.`), timeout),
    ),
  ])
  if (!outcome) return
  if (/timed out|did not load/i.test(outcome)) browser.contents.stop()
  const refusal = browser.refused.slice(before).at(-1)
  if (refusal) throw new Error(refusal.reason)
  // A later navigation that took over this one (a redirect the page made at once) is not a failure.
  if (/ERR_ABORTED/.test(outcome)) return
  throw new Error(`Could not open the page: ${outcome}`)
}

// Waits for what an action started: a navigation it caused, or the page's own reaction.
async function settle(browser: Browser) {
  await new Promise((resolve) => setTimeout(resolve, 300))
  if (!browser.closed && browser.contents.isLoading())
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, LOAD_TIMEOUT_MS)
      browser.contents.once("did-stop-loading", () => {
        clearTimeout(timer)
        resolve()
      })
    })
  await quiet(browser)
}

// Until the page has had no request in flight for QUIET_MS, at most SETTLE_MS: the page is held when the command ends,
// so a page that builds itself by script after its load event gets the time to, and so do its own redirects.
async function quiet(browser: Browser) {
  const deadline = Date.now() + SETTLE_MS
  const state = { since: Date.now() }
  while (!browser.closed && Date.now() < deadline) {
    if (browser.inflight.size > 0) state.since = Date.now()
    if (Date.now() - state.since >= QUIET_MS) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function report(browser: Browser) {
  const joined = browser.joined
  const refused = browser.refused
  browser.joined = []
  browser.refused = []
  const contents = browser.contents
  const alive = !contents.isDestroyed()
  return {
    ...empty(browser.run.generation),
    label: browser.label,
    url: browser.decided ?? "",
    address: alive ? contents.getURL() : "",
    title: alive ? contents.getTitle() : "",
    ...(browser.status !== undefined ? { status: browser.status } : {}),
    joined,
    refused,
  }
}

function empty(generation: string): Report {
  return { ok: true, generation, label: "", url: "", address: "", title: "", joined: [], refused: [] }
}

// Runs one of browser-page.ts's functions in the page's isolated world, with the window and these arguments.
function world<T>(browser: Browser, fn: (win: Window, ...rest: never[]) => unknown, ...args: unknown[]) {
  return runInWorld<T>(browser.contents, WORLD, fn, ...args)
}

// ---------------------------------------------------------------------------------------------------------------
// The page's events and the session's handlers

function wire(browser: Browser) {
  const contents = browser.contents
  contents.on("login", (event, _details, authInfo, callback) => {
    event.preventDefault()
    browser.proxy.login(authInfo, callback)
  })
  // Without an answer Electron would send the first certificate in the user's store.
  contents.on("select-client-certificate", (event, _url, _list, callback) => {
    event.preventDefault()
    ;(callback as (certificate?: Electron.Certificate) => void)()
  })
  contents.on("will-attach-webview", (event) => event.preventDefault())
  // The network stack decides http and https; this also stops what it never sees (data:, blob:, file: and the rest)
  // and says why.
  contents.on("will-frame-navigate", (event) => {
    if (event.isSameDocument) return
    const decision = decide(browser, event.url, "page", { frame: event.isMainFrame ? "main" : "sub" })
    if (decision.allow) return
    event.preventDefault()
    note(browser, event.url, decision.reason)
  })
  contents.on("will-redirect", (event) => {
    if (!event.isMainFrame) return
    const decision = decide(browser, event.url, "redirect")
    if (decision.allow) return
    event.preventDefault()
    note(browser, event.url, decision.reason)
  })
  contents.setWindowOpenHandler(({ url }) => {
    const decision = decide(browser, url, "page")
    if (!decision.allow) {
      note(browser, url, decision.reason)
      return { action: "deny" }
    }
    browser.expected = { url: spelled(url), decision }
    void contents.loadURL(url).catch(() => undefined)
    return { action: "deny" }
  })
  contents.on("did-navigate", (_event, url, code) => {
    browser.clicked = undefined
    // The browser's first empty page is no page the rule decided.
    if (url === "about:blank" && browser.decided === undefined) return
    const landed = browser.landing && browser.landing.url === spelled(url) ? browser.landing : undefined
    browser.landing = undefined
    // A page that commits with no request the rule saw (one restored from the back-forward cache) is a search's when it
    // is one of the engines' own pages.
    browser.search = landed ? landed.search : ResearchSearch.enginePage(url)
    browser.decided = url
    browser.status = code
    // The links of the page before are not on this one.
    browser.links = new Set()
    browser.forms = new Set()
    changed()
  })
  contents.on("render-process-gone", () => void closeBrowser(browser))
}

function harden(partition: Session) {
  partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  partition.setPermissionCheckHandler(() => false)
  partition.setDevicePermissionHandler(() => false)
  partition.setSpellCheckerEnabled(false)
  partition.on("will-download", (event, item, contents) => {
    event.preventDefault()
    const browser = byContents.get(contents.id)
    if (!browser) return
    const url = item.getURL()
    const mime = item.getMimeType()
    const web = /^https?:\/\//i.test(url) && URL.canParse(url)
    if (web && (mime === "application/pdf" || /\.pdf$/i.test(new URL(url).pathname))) {
      browser.download = { url, mime }
      return
    }
    note(browser, url, DOWNLOADS_OFF)
  })
  registerResearchListeners(partition)
}

/** Registers the research browsers' webRequest listeners on a slot session, the navigation rule through the dispatcher. */
export function registerResearchListeners(target: Pick<Session, "webRequest">) {
  egressFilter.register(target, researchRequestHandlers.beforeRequest, { kind: "research-browser" })
  target.webRequest.onBeforeSendHeaders(researchRequestHandlers.beforeSendHeaders)
  target.webRequest.onHeadersReceived(researchRequestHandlers.headersReceived)
  target.webRequest.onCompleted(researchRequestHandlers.done)
  target.webRequest.onErrorOccurred(researchRequestHandlers.done)
}

type BeforeRequest = Electron.OnBeforeRequestListenerDetails
type Answer = (response: Electron.CallbackResponse) => void

export const researchRequestHandlers = {
  /** Every request a research browser makes: the navigation rule for frames, the bounds for everything else. */
  beforeRequest: (details: BeforeRequest, callback: Answer) => {
    // A request from no research browser (a service worker's, which has no page) is refused.
    const browser = details.webContentsId === undefined ? undefined : byContents.get(details.webContentsId)
    if (!browser || browser.closed) return callback({ cancel: true })
    if (details.resourceType === "mainFrame" || details.resourceType === "subFrame")
      return void frame(browser, details).then(
        (allowed) => callback({ cancel: !allowed }),
        () => callback({ cancel: true }),
      )
    if (!URL.canParse(details.url)) return callback({ cancel: true })
    const target = new URL(details.url)
    if (
      (target.protocol === "http:" ||
        target.protocol === "https:" ||
        target.protocol === "ws:" ||
        target.protocol === "wss:") &&
      LocalPolicy.hostClass(target.hostname) !== "internet"
    )
      return callback({ cancel: true })
    if (details.resourceType === "font") return callback({ cancel: true })
    if ((details.resourceType === "image" || details.resourceType === "media") && !browser.images)
      return callback({ cancel: true })
    browser.page.requests++
    const over =
      browser.page.requests > MAX_SUBRESOURCES || browser.proxy.received() - browser.page.start > MAX_SUBRESOURCE_BYTES
    if (over) {
      if (!browser.page.over) note(browser, details.url, SUBRESOURCES)
      browser.page.over = true
      return callback({ cancel: true })
    }
    browser.inflight.add(details.id)
    callback({})
  },
  beforeSendHeaders: (
    details: Electron.OnBeforeSendHeadersListenerDetails,
    callback: (response: Electron.BeforeSendResponse) => void,
  ) => {
    const worker = Object.keys(details.requestHeaders).some((name) => name.toLowerCase() === "service-worker")
    if (worker) {
      const browser = details.webContentsId === undefined ? undefined : byContents.get(details.webContentsId)
      if (browser) note(browser, details.url, SERVICE_WORKER)
      return callback({ cancel: true })
    }
    callback({ requestHeaders: details.requestHeaders })
  },
  /**
   * Every answer a research browser gets: one that asks for ambient sign-in is cancelled, and every document is
   * sandboxed with no dialogs, which a frame it holds inherits.
   */
  headersReceived: (
    details: Electron.OnHeadersReceivedListenerDetails,
    callback: (response: Electron.HeadersReceivedResponse) => void,
  ) => {
    const headers = details.responseHeaders ?? {}
    // A 401 that offers NTLM or Negotiate is cancelled here, before Chromium answers it. On Windows Chromium answers
    // those with the user's own sign-in for hosts its zone policy calls local intranet, where enterprises put their
    // sign-in servers, and those often have public addresses. Basic and Digest reach `login`, which cancels them.
    if (details.statusCode === 401 && ambient(headers)) {
      const browser = details.webContentsId === undefined ? undefined : byContents.get(details.webContentsId)
      if (browser) note(browser, details.url, AMBIENT)
      return callback({ cancel: true })
    }
    if (details.resourceType !== "mainFrame" && details.resourceType !== "subFrame") return callback({})
    const name = Object.keys(headers).find((key) => key.toLowerCase() === "content-security-policy")
    callback({
      responseHeaders: {
        ...headers,
        [name ?? "Content-Security-Policy"]: [...(name ? (headers[name] ?? []) : []), SANDBOX],
      },
    })
  },
  done: (details: { readonly id: number; readonly webContentsId?: number }) => {
    const browser = details.webContentsId === undefined ? undefined : byContents.get(details.webContentsId)
    browser?.requests.delete(details.id)
    browser?.inflight.delete(details.id)
  },
}

// Whether an answer's challenges include NTLM or Negotiate, which Chromium may answer with the user's own sign-in.
function ambient(headers: Record<string, string[]>) {
  return Object.entries(headers)
    .filter(([name]) => name.toLowerCase() === "www-authenticate")
    .flatMap(([, values]) => values)
    .some((value) => /(?:^|[\s,])(?:negotiate|ntlm)(?:[\s,]|$)/i.test(value))
}

// A main-frame or subframe request: the navigation rule, then robots.txt for what Vector discovered, then the run's
// per-host rate limits for documents.
async function frame(browser: Browser, details: BeforeRequest) {
  const main = details.resourceType === "mainFrame"
  const prior = main ? browser.requests.get(details.id) : undefined
  const expected =
    main && !prior && browser.expected && browser.expected.url === spelled(details.url) ? browser.expected : undefined
  const decision: Decision = expected
    ? expected.decision
    : decide(browser, details.url, prior ? "redirect" : "page", {
        frame: main ? "main" : "sub",
        method: details.method,
        ...(prior?.typedHost ? { typedHost: prior.typedHost } : {}),
        ...(prior ? { searching: prior.search } : {}),
      })
  if (expected) browser.expected = undefined
  // A click's href is spent on the first main-frame navigation after it, allowed or not.
  if (main && !prior) browser.clicked = undefined
  // Even a load Vector started is refused when its method is not a read: a form can be resubmitted through history.
  const method = details.method.toUpperCase()
  if (decision.allow && method !== "GET" && method !== "HEAD") return refused(browser, details.url, POST)
  if (!decision.allow) return refused(browser, details.url, decision.reason)
  // about:blank and about:srcdoc, which reach no site.
  if (!/^https?:/i.test(details.url)) return true
  if (decision.robots && !(await Effect.runPromise(browser.run.robots.check(details.url))))
    return refused(browser, details.url, ROBOTS)
  await Effect.runPromise(browser.run.limiter.run(new URL(details.url).hostname, Effect.void, () => undefined))
  if (!main) {
    browser.inflight.add(details.id)
    return true
  }
  // A new page: what the last one still had in flight is the network's to cancel, not this page's to wait for.
  browser.inflight = new Set([details.id])
  // A redirect on the host the user typed is not decided by robots.txt either; a search's redirect only when it leads
  // to the engine's own pages (the rule's `searching`).
  const typed =
    prior?.typedHost ?? (!decision.robots && decision.via === "provenance" ? new URL(details.url).hostname : undefined)
  // A results page, a redirect of its load (a check, a consent wall) and the page's own navigations on its origin.
  const search = prior ? prior.search : decision.via === "search" || (decision.via === "same-origin" && browser.search)
  browser.requests.set(details.id, { ...(typed ? { typedHost: typed } : {}), search })
  // What the page shown becomes only once this request commits (did-navigate).
  browser.landing = { url: spelled(details.url), search }
  browser.page = { requests: 0, start: browser.proxy.received(), over: false, cut: false }
  if (decision.join) {
    browser.run.provenance = addLinks(browser.run.provenance, [decision.join], "link")
    browser.joined = [...new Set([...browser.joined, decision.join])]
  }
  return true
}

function refused(browser: Browser, url: string, reason: string) {
  note(browser, url, reason)
  return false
}

// Whether the debugger attached. Without it the page runs unheld, with no file chooser interception, stubs or focus
// emulation, so the caller closes the browser.
async function devtools(browser: Browser) {
  const tools = browser.contents.debugger
  const attached = await Promise.resolve()
    .then(() => tools.attach("1.3"))
    .then(
      () => true,
      () => false,
    )
  if (!attached) return false
  browser.debugger = true
  const send = (method: string, params?: Record<string, unknown>) =>
    tools.sendCommand(method, params).catch(() => undefined)
  await send("Page.enable")
  // No native file dialog, whatever the page's scripts do.
  await send("Page.setInterceptFileChooserDialog", { enabled: true })
  // The page behaves as focused, so typing reaches its field without Vector focusing the browser, which would take the
  // keyboard from the user's own window.
  await send("Emulation.setFocusEmulationEnabled", { enabled: true })
  // Before the page's own scripts in every frame, a frame its script just made included (the Electron smoke checks it):
  // no print dialog, no peer connections, no WebTransport (whose connections no webRequest listener sees) and no
  // file pickers. What holds whatever a page does is the documents' sandbox for print() and dialogs, the proxy-only
  // WebRTC policy, the Blink feature turned off for file pickers, and the network stack's refusal of service workers.
  await send("Page.addScriptToEvaluateOnNewDocument", { source: STUBS, runImmediately: true })
  // For holding the page's scripts between commands (lifecycle).
  await send("Debugger.enable")
  await send("Debugger.setSkipAllPauses", { skip: true })
  tools.on("message", (_event, method) => {
    if (method === "Page.javascriptDialogOpening") void send("Page.handleJavaScriptDialog", { accept: false })
  })
  return true
}

const STUBS = `(() => {
  const stub = (target, key, value) => {
    try { Object.defineProperty(target, key, { value, configurable: false, writable: false }) } catch {}
  };
  stub(window, "print", () => undefined);
  stub(window, "RTCPeerConnection", undefined);
  stub(window, "webkitRTCPeerConnection", undefined);
  stub(window, "RTCDataChannel", undefined);
  stub(window, "WebTransport", undefined);
  const cancelled = () => Promise.reject(new DOMException("The user aborted a request.", "AbortError"));
  ["showOpenFilePicker", "showSaveFilePicker", "showDirectoryPicker"].forEach((key) => {
    if (key in window) stub(window, key, cancelled);
  });
  try { Object.defineProperty(Navigator.prototype, "serviceWorker", { get: () => undefined, configurable: false }) } catch {}
})()`

// Holds the page's scripts between commands and lets them run for the next one. It pauses them in the debugger: the
// page's timers, handlers and network callbacks wait, none is dropped, and they run once the next command starts.
// Chromium's own freezing (Page.setWebLifecycleState) does not stop a page that is shown, and research pages are, by
// focus emulation (the Electron smoke checks both). While the page runs, pauses are skipped, so neither the page's own
// `debugger` statement nor a pause asked for while no script ran can hold Vector's page scripts.
async function lifecycle(browser: Browser, state: "paused" | "running") {
  if (!browser.debugger || browser.closed || browser.contents.isDestroyed()) return
  const send = (method: string, params?: Record<string, unknown>) =>
    browser.contents.debugger.sendCommand(method, params).catch(() => undefined)
  if (state === "paused") {
    await send("Debugger.setSkipAllPauses", { skip: false })
    await send("Debugger.pause")
    return
  }
  await send("Debugger.setSkipAllPauses", { skip: true })
  // Answers an error when nothing was paused yet, which is fine.
  await send("Debugger.resume")
}

function hostWindow() {
  if (host.window && !host.window.isDestroyed()) return host.window
  host.window = new BrowserWindow({
    show: false,
    // Nothing the user does reaches it: it never takes focus and is in no taskbar or window switcher.
    focusable: false,
    skipTaskbar: true,
    width: VIEW.width,
    height: VIEW.height,
    webPreferences: {
      partition: `${PARTITION_PREFIX}host`,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  return host.window
}

// ---------------------------------------------------------------------------------------------------------------
// Closing and watching

async function closeBrowser(browser: Browser) {
  if (browser.closed) return
  browser.closed = true
  if (browser.idle) clearTimeout(browser.idle)
  if (browser.watch) clearInterval(browser.watch)
  browser.closing.abort()
  browsers.delete(browser.key)
  byContents.delete(browser.contentsID)
  browser.unattribute()
  browser.run.browsers.delete(browser.sessionID)
  const contents = browser.contents
  if (host.window && !host.window.isDestroyed()) host.window.contentView.removeChildView(browser.view)
  // Its pages close before its slot is cleared, with its scripts let run, so an unload handler does not hold the close.
  if (browser.debugger && !contents.isDestroyed()) {
    await contents.debugger.sendCommand("Debugger.setSkipAllPauses", { skip: true }).catch(() => undefined)
    await contents.debugger.sendCommand("Debugger.resume").catch(() => undefined)
  }
  await new Promise<void>((resolve) => {
    if (contents.isDestroyed()) return resolve()
    const timer = setTimeout(resolve, 2_000)
    contents.once("destroyed", () => {
      clearTimeout(timer)
      resolve()
    })
    contents.close()
  })
  // A page still alive after the wait would run beside the next agent's page in the slot, so its renderer is ended and
  // the slot is never used again.
  const alive = !contents.isDestroyed()
  if (alive) contents.forcefullyCrashRenderer()
  await browser.proxy.stop().catch(() => undefined)
  await pool.release(browser.slot, alive)
  // A run waiting for room keeps its copy of the provenance for the agent that takes the room.
  const run = browser.run
  if (run.browsers.size === 0 && run.opening === 0 && run.waiters.size === 0) runs.delete(run.id)
  ;[...run.waiters].forEach((wake) => wake())
  releaseHost()
  changed()
}

// The host window lives only while a research browser does, so it never keeps Vector open after its own windows
// close, and no lookup of Vector's windows ever finds it with nothing in it.
function releaseHost() {
  if (browsers.size > 0 || !host.window) return
  const window = host.window
  host.window = undefined
  if (!window.isDestroyed()) window.destroy()
}

function changed() {
  watchers.forEach((watcher) => watcher())
}

/**
 * Watching research browsers (R5's Sources tab chips): a chip per browser, snapshots of its page, and Stop. There is
 * no way to send input to one, so nothing the user does there can sign it in to anything.
 */
export const ResearchWatch = {
  list: (): Chip[] =>
    [...browsers.values()].map((browser) => ({
      id: browser.key,
      runID: browser.run.id,
      sessionID: browser.sessionID,
      label: browser.label,
      host: browser.decided && URL.canParse(browser.decided) ? new URL(browser.decided).hostname : "",
      state: browser.state,
    })),
  /** A PNG data URL of the page as it shows now; about two a second is what a watcher needs. */
  snapshot: async (id: string) => {
    const browser = browsers.get(id)
    if (!browser || browser.closed || browser.contents.isDestroyed()) return undefined
    return (await browser.contents.capturePage()).toDataURL()
  },
  /** Closes the browser, and its agent opens no other in this research. */
  stop: async (id: string) => {
    const browser = browsers.get(id)
    if (!browser) return false
    stopped.add(id)
    if (stopped.size > STOPPED_KEPT) stopped.delete(stopped.values().next().value!)
    await closeBrowser(browser)
    return true
  },
  subscribe: (watcher: () => void) => {
    watchers.add(watcher)
    return () => {
      watchers.delete(watcher)
    }
  },
}
