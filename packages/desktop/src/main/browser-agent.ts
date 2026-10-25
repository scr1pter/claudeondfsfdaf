import { BrowserWindow, WebContentsView, session, type IpcMainInvokeEvent, type WebContents } from "electron"
import { CLIPBOARD_REFUSED, parseKeyPress } from "./browser-agent-keys"
import { clickTargetLabel } from "./browser-click-target"
import {
  bindSelector,
  chooseOptions,
  clickElement,
  clickPoint,
  fieldValue,
  focusField,
  focusedCredential,
  focusedFileField,
  observePage,
  readPage,
  replaceText,
  typingMoved,
  type Chosen,
  type ClickPoint,
  type Focus,
  type Observed,
  type PageRead,
} from "./browser-page"
import { isCredentialField } from "./browser-credential-field"
import { CredentialFocusChangedError, sendGuardedCharacters } from "./browser-credential-input"
import {
  DRIVING_COMMANDS,
  automationTurn,
  browserOrigin,
  isAllowedBrowserNavigation,
  isLocalBrowserUrl,
  isUserNavigation,
  navigationIntent,
  recordPageInput,
  type NavigationIntent,
} from "./browser-navigation-policy"
import { AsyncLocalStorage } from "node:async_hooks"

import type {
  BrowserAgentDialog,
  BrowserAgentInput,
  BrowserAgentPageEvent,
  BrowserAgentRequest,
  BrowserAgentTab,
  BrowserAutomationRun,
} from "../preload/types"
import { redactText } from "./security-redaction"
import { egressFilter } from "./egress-filter"
import { holdDebugger } from "./debugger-hold"

type BrowserAgentLog = { level: string; message: string; location?: string }
type BrowserAgentActionLog = { label: string; ok: boolean; error?: string; result?: unknown; at: string }
type BrowserAgentNetworkError = { url: string; status?: number; error?: string; method?: string }
type BrowserAgentDom = NonNullable<BrowserAutomationRun["domSummary"]>
type BrowserAgentComputedStyle = NonNullable<BrowserAutomationRun["computedStyles"]>[number]
type BrowserAgentBounds = { x: number; y: number; width: number; height: number }
type Settled = NonNullable<BrowserAutomationRun["settled"]>

/** One page of a browser context, with what Vector keeps of it for the reports that describe it. */
export type BrowserTab = {
  /** tab_N: never used twice in its context. */
  id: string
  view: WebContentsView
  /** Its web contents' id, kept for the request log, which names a page by it. */
  contentsId: number
  /** The window that holds the view: the Preview's, or the park window. */
  window?: BrowserWindow
  title: string
  consoleLogs: BrowserAgentLog[]
  pageErrors: string[]
  networkErrors: BrowserAgentNetworkError[]
  /** The request log, oldest first. */
  requests: BrowserAgentRequest[]
  /** Requests on their way, by webRequest id: what settling waits on. */
  inflight: Map<number, { request: BrowserAgentRequest; started: number }>
  /** JavaScript dialogs the page opened since the last report. */
  dialogs: BrowserAgentDialog[]
  /** Navigations of its main frame so far, so a command can tell whether it moved the page. */
  navigations: number
  /** Whether the debugger holds every file chooser its page opens (interceptFileChoosers); it is not driven otherwise. */
  chooser: boolean
}

export type BrowserContext = {
  id: string
  tabs: BrowserTab[]
  /** The tab every command acts on, and the one a Preview shows. */
  active?: string
  /** The number the next tab takes. */
  nextTab: number
  /** The window whose Preview shows this browser, while one is attached. */
  hostWindow?: BrowserWindow
  /** Hidden because a dialog covers its window, so it shows again when the dialog closes. */
  covered?: boolean
  /** Whether the Preview showing it wants it shown. */
  shown: boolean
  /** The command running on this page; the next one starts when it settles or runs past its deadline. */
  queue: Promise<unknown>
  /** Aborted when the page is closed, which ends its running command and every waiting one at once. */
  closing: AbortController
  /** Commands on their way to this page, queued or running; a page with any is never retired to make room. */
  busy: number
  lastBounds?: BrowserAgentBounds
  actionTimeline: BrowserAgentActionLog[]
  lastUsedAt: number
  allowedExternalOrigins: Set<string>
  blockedNavigationError?: string
  intent: NavigationIntent
}

// The agent drives a WebContentsView embedded in the main Vector window, so
// the user always watches the same live page the agent is acting on and can
// take over with normal mouse/keyboard input at any time. A page no Preview
// shows (Preview closed, or another of a context's tabs) waits in one hidden
// park window at a real size, so it lays out, paints and can be captured.
let attaching: Promise<void> | undefined
const contexts = new Map<string, BrowserContext>()
const contextStorage = new AsyncLocalStorage<BrowserContext>()
// Windows a dialog in the app covers: their browser views stay hidden until it closes.
const coveredWindows = new WeakSet<BrowserWindow>()
// Windows whose closing closes the browser their Preview shows.
const watchedWindows = new WeakSet<BrowserWindow>()
const hardenedSessions = new WeakSet<Electron.Session>()
// Each page's tab by its web contents' id, as the session's request events name the page.
const tabsByContents = new Map<number, { context: BrowserContext; tab: BrowserTab }>()
const park: { window?: BrowserWindow } = {}

const PARTITION = "persist:vector-browser"
// The park window's own page loads nothing, in a partition of its own that keeps nothing on disk.
const PARK_PARTITION = "vector-browser-park"
export const PARK_BOUNDS = { x: 0, y: 0, width: 1280, height: 800 }
/**
 * The agent browser's page preferences. The session's preloads run in every frame, sandboxed and without Node, so
 * Vector Local's no-peer-connections preload (local-mode.ts) reaches a frame a page makes as well as the page. Pages
 * keep running when no Preview shows them. JavaScript dialogs are answered at once (alert returns, confirm is false,
 * prompt is null), so none stalls a command, and the File System Access pickers are off in every frame, so no native
 * file dialog opens from a click.
 */
export const AGENT_BROWSER_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: true,
  sandbox: true,
  webSecurity: true,
  backgroundThrottling: false,
  disableDialogs: true,
  disableBlinkFeatures: "FileSystemAccessLocal",
} as const
// A browser context the engine's browser tool opened is named by its session (tool/browser.ts, contextId).
const SESSION_ID = /^ses_[0-9A-Za-z]+$/
export const DOWNLOADS_OFF = "Downloads are off in the agent browser."
export const MAX_TABS = 8
// Commands that only place or show the panel's view. They never wait behind a page command, so resizing or opening
// a dialog stays immediate while the agent waits on a page.
const PANEL_COMMANDS = new Set(["attach", "setBounds", "detach", "setVisible"])
// The Preview's own buttons, sent from the panel with an IPC event: the user's navigation never waits behind the
// agent's command either. Close never waits, from anyone, and ends whatever the page is still running.
const USER_COMMANDS = new Set(["openUrl", "goBack", "goForward", "reload"])
// Commands that start no browser for a context that has none.
const PASSIVE_COMMANDS = new Set(["detach", "setBounds", "closeBrowser", "setVisible", "listTabs"])
// Commands that open no page in a context with no tab: they find the tab they need, or open it themselves.
const NO_PAGE_COMMANDS = new Set([...PASSIVE_COMMANDS, "openTab", "switchTab", "closeTab", "readLogs"])
// Commands after which Vector waits for the page to settle (settled in the report), unless the caller says not to.
const SETTLING_COMMANDS = new Set([
  "openUrl",
  "openTab",
  "click",
  "clickRef",
  "type",
  "typeRef",
  "press",
  "selectOption",
  "reload",
  "goBack",
  "goForward",
])
/**
 * The longest one command may hold its page. A page that never answers (a busy loop, or a script that replaces the
 * timers and observers a wait relies on) would otherwise hold every later command on it for good.
 */
export const TURN_DEADLINE_MS = 60_000
// Settling: what a command started gets a moment to begin, its load up to 15 seconds to end, then the page's requests
// up to 5 seconds to stop for half a second.
const SETTLE_START_MS = 250
const LOAD_WAIT_MS = 15_000
const QUIET_MS = 500
const QUIET_WAIT_MS = 5_000
// What a tab keeps: its request log, and its console, which readLogs reports whole and other commands the end of.
const REQUESTS_KEPT = 200
const CONSOLE_KEPT = 200
const CONSOLE_REPORTED = 30
// The wait helpers run in their own JavaScript world, which shares the page's DOM but not its globals, so a page
// cannot stop them by replacing setTimeout, MutationObserver or Promise.
const WAIT_WORLD = 1_291
// observePage's ref handles live in this world's globals, so they last as long as the page and the page cannot read them.
const PAGE_WORLD = 1_292
// The ref a selector command names its target by in that world, apart from observe's ref_N handles.
const SELECTOR_REF = "selector"
// The most of a page readPage serializes for the reader, as the research reader reads at most.
const READ_BYTES = 5 * 1024 * 1024

function currentContext() {
  const context = contextStorage.getStore()
  if (!context) throw new Error("The controlled browser has no active Vector task context.")
  context.lastUsedAt = Date.now()
  return context
}

function getContext(id: string, create = true) {
  const existing = contexts.get(id)
  if (existing || !create) return existing
  pruneContexts()
  const context: BrowserContext = {
    id,
    tabs: [],
    nextTab: 1,
    shown: true,
    actionTimeline: [],
    lastUsedAt: Date.now(),
    allowedExternalOrigins: new Set(),
    intent: navigationIntent(),
    queue: Promise.resolve(),
    closing: new AbortController(),
    busy: 0,
  }
  contexts.set(id, context)
  return context
}

function activeTab(context: BrowserContext) {
  return context.tabs.find((tab) => tab.id === context.active)
}

/**
 * The agent browser grants a page no permission but fullscreen: no camera, microphone, location, notifications,
 * clipboard, devices or any other, and it never asks the user on a page's behalf.
 */
export function browserPermissionAllowed(permission: string) {
  return permission === "fullscreen"
}

/**
 * Runs a command on a page once the page's earlier commands settle, so two calls never interleave their steps on it.
 * A command that runs past the deadline gives the page up: the next one starts, and this one reports the timeout
 * instead of waiting on. Closing the page ends the running command and every waiting one at once.
 */
export function queueTurn<T>(
  page: { queue: Promise<unknown>; closing: AbortController },
  run: () => Promise<T>,
  end: (reason: "timeout" | "closed") => T,
  ms = TURN_DEADLINE_MS,
) {
  const closing = page.closing.signal
  const turn = page.queue.then(
    () =>
      new Promise<T>((resolve, reject) => {
        if (closing.aborted) return resolve(end("closed"))
        const closed = () => resolve(end("closed"))
        const timer = setTimeout(() => resolve(end("timeout")), ms)
        closing.addEventListener("abort", closed, { once: true })
        run()
          .then(resolve, reject)
          .finally(() => {
            clearTimeout(timer)
            closing.removeEventListener("abort", closed)
          })
      }),
  )
  page.queue = turn.catch(() => undefined)
  return turn
}

/**
 * Hides every browser view in a window while a dialog covers it, and shows again only the views it hid. A dialog
 * is DOM, and a WebContentsView paints over all DOM, so the view would otherwise cover the dialog. Views in the park
 * window are no Preview's and stay as they are.
 */
export function setWindowVisible(
  window: BrowserWindow,
  visible: boolean,
  all: Iterable<BrowserContext> = contexts.values(),
) {
  if (visible) coveredWindows.delete(window)
  else coveredWindows.add(window)
  for (const context of all) {
    const tab = activeTab(context)
    if (context.hostWindow !== window || !tab || tab.window !== window || tab.view.webContents.isDestroyed()) continue
    if (!visible && tab.view.getVisible()) {
      tab.view.setVisible(false)
      context.covered = true
    }
    if (visible && context.covered) {
      tab.view.setVisible(true)
      context.covered = false
    }
  }
}

// The partition's own handlers: permissions denied but fullscreen, downloads cancelled and reported, and each page's
// request log. Electron keeps one listener per webRequest event per session: Vector Local's dispatcher
// (egress-filter.ts) owns this session's onBeforeRequest, and the three below are the agent browser's own.
function hardenSession(partition: Electron.Session) {
  if (hardenedSessions.has(partition)) return
  hardenedSessions.add(partition)
  partition.setPermissionRequestHandler((_contents, permission, callback) =>
    callback(browserPermissionAllowed(permission)),
  )
  partition.setPermissionCheckHandler((_contents, permission) => browserPermissionAllowed(permission))
  partition.on("will-download", (event, item, contents) => {
    event.preventDefault()
    const found = Array.from(contexts.values()).flatMap((context) =>
      context.tabs.filter((tab) => tab.view.webContents === contents).map((tab) => ({ context, tab })),
    )[0]
    if (!found) return
    const shown = redactText(item.getURL())
    found.tab.networkErrors = [...found.tab.networkErrors, { url: shown, error: DOWNLOADS_OFF }].slice(-50)
    pushAction("Cancelled a download", false, DOWNLOADS_OFF, undefined, found.context)
  })
  partition.webRequest.onSendHeaders((details) => {
    const tab = details.webContentsId === undefined ? undefined : tabsByContents.get(details.webContentsId)?.tab
    if (!tab) return
    const entry = {
      request: { method: details.method, url: redactText(details.url), type: details.resourceType, at: now() },
      started: Date.now(),
    }
    // A new page load ends what the page it leaves had on its way.
    if (details.resourceType === "mainFrame") tab.inflight = new Map([[details.id, entry]])
    else tab.inflight.set(details.id, entry)
  })
  partition.webRequest.onCompleted((details) => finishRequest(details, { status: details.statusCode }))
  partition.webRequest.onErrorOccurred((details) => finishRequest(details, { error: details.error }))
}

// A request's end, in its tab's log. A failed answer is also a network error of the page, a script's fetch or XHR as
// much as a document's; a frame's own failed load is did-fail-load's, and an aborted request is no failure.
function finishRequest(
  details: { id: number; url: string; method: string; webContentsId?: number; resourceType: string },
  outcome: { status?: number; error?: string },
) {
  const tab = details.webContentsId === undefined ? undefined : tabsByContents.get(details.webContentsId)?.tab
  if (!tab) return
  const started = tab.inflight.get(details.id)
  tab.inflight.delete(details.id)
  const request: BrowserAgentRequest = {
    ...(started?.request ?? {
      method: details.method,
      url: redactText(details.url),
      type: details.resourceType,
      at: now(),
    }),
    ...(outcome.status === undefined ? {} : { status: outcome.status }),
    ...(outcome.error === undefined ? {} : { error: redactText(outcome.error) }),
    ...(started ? { durationMs: Date.now() - started.started } : {}),
  }
  tab.requests = [...tab.requests, request].slice(-REQUESTS_KEPT)
  const frame = details.resourceType === "mainFrame" || details.resourceType === "subFrame"
  const failed =
    (outcome.status ?? 0) >= 400 || (outcome.error !== undefined && outcome.error !== "net::ERR_ABORTED" && !frame)
  if (!failed) return
  tab.networkErrors = [
    ...tab.networkErrors,
    {
      url: request.url,
      method: request.method,
      ...(request.status === undefined ? {} : { status: request.status }),
      ...(request.error === undefined ? {} : { error: request.error }),
    },
  ].slice(-50)
}

// Vector sets no cap on browser tasks. A new context only retires the oldest
// dead one, whose pages are gone (window closed or page crashed); a context with
// a live page is never closed to make room, and none is refused.
function pruneContexts() {
  const oldest = Array.from(contexts.values())
    .filter((context) => context.busy === 0 && context.tabs.every((tab) => tab.view.webContents.isDestroyed()))
    .toSorted((a, b) => a.lastUsedAt - b.lastUsedAt)[0]
  if (oldest) destroyContext(oldest)
}

function now() {
  return new Date().toISOString()
}

function pushAction(label: string, ok = true, error?: unknown, result?: unknown, context = currentContext()) {
  context.actionTimeline = [
    {
      label,
      ok,
      error: error instanceof Error ? redactText(error.message) : error ? redactText(String(error)) : undefined,
      result,
      at: now(),
    },
    ...context.actionTimeline,
  ].slice(0, 80)
}

export { isLocalBrowserUrl } from "./browser-navigation-policy"

function safeUrl(rawUrl: string, allowExternal = false) {
  const url = new URL(rawUrl)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Browser Agent can only open http and https URLs.")
  }
  if (!isLocalBrowserUrl(rawUrl) && !allowExternal) {
    throw new Error("Browser Agent blocked this external website. Enable external sites for this conversation first.")
  }
  return url.toString()
}

// Installed in each page's own world when its document is ready: page errors, and the JavaScript dialogs it opens.
// Dialogs are off in this browser (alert returns, confirm answers false and prompt null at once), so what a page asked
// is kept for the report instead.
const PAGE_ISSUE_HOOK = `(() => {
  if (window.__vectorAgentIssueHook) return true;
  window.__vectorAgentIssueHook = true;
  window.__vectorAgentIssues = [];
  window.__vectorAgentDialogs = [];
  const push = (message) => {
    try {
      window.__vectorAgentIssues.push(String(message).slice(0, 500));
      window.__vectorAgentIssues = window.__vectorAgentIssues.slice(-40);
    } catch {}
  };
  window.addEventListener("error", (event) => push(event.message || event.error || "Unknown page error"));
  window.addEventListener("unhandledrejection", (event) => push("Unhandled rejection: " + (event.reason?.message || event.reason)));
  for (const type of ["alert", "confirm", "prompt"]) {
    const original = window[type];
    if (typeof original !== "function") continue;
    window[type] = function (message) {
      try {
        window.__vectorAgentDialogs.push({ type, message: String(message ?? "").slice(0, 500), url: location.href, at: new Date().toISOString() });
        window.__vectorAgentDialogs = window.__vectorAgentDialogs.slice(-20);
      } catch {}
      return original.apply(this, arguments);
    };
  }
  return true;
})()`

function emitPageEvent(context: BrowserContext, tab = activeTab(context)) {
  if (!tab || tab.id !== context.active) return
  const contents = tab.view.webContents
  if (contents.isDestroyed() || !context.hostWindow || context.hostWindow.isDestroyed()) return
  const payload: BrowserAgentPageEvent = {
    contextId: context.id,
    url: contents.getURL(),
    title: contents.getTitle(),
    canGoBack: contents.navigationHistory.canGoBack(),
    canGoForward: contents.navigationHistory.canGoForward(),
    loading: contents.isLoading(),
  }
  context.hostWindow.webContents.send("browser-agent-page-event", payload)
}

function wireTab(context: BrowserContext, tab: BrowserTab) {
  const contents = tab.view.webContents
  const blockNavigation = (url: string) => {
    const shown = redactText(url)
    const message = `Browser Agent did not follow ${shown}: ${browserOrigin(url) ?? "that address"} is not approved for this task. Open it with open_url to ask the user.`
    context.blockedNavigationError = message
    tab.networkErrors = [...tab.networkErrors, { url: shown, error: message }].slice(-50)
    pushAction("Blocked unapproved external navigation", false, message, undefined, context)
  }
  // Automation only reaches approved origins. A link the user follows with their own click or
  // key press goes wherever they chose, as in any browser, and approves that site the way
  // typing it into the address bar does.
  const allowNavigation = (url: string) => {
    if (isAllowedBrowserNavigation(url, context.allowedExternalOrigins)) return true
    const origin = browserOrigin(url)
    if (!origin || !isUserNavigation(context.intent, Date.now())) return false
    context.allowedExternalOrigins.add(origin)
    return true
  }
  contents.on("input-event", (_event, input) => recordPageInput(context.intent, input.type, Date.now()))
  // A popup or a link to a new tab the agent opens comes up in a tab of its own, which is then the one shown and
  // driven; with every tab open, it loads in place. One the user opens with their own click in Preview, which has no
  // tabs to switch between, loads in place too, so Back returns to their page. No window of its own ever opens.
  contents.setWindowOpenHandler(({ url }) => {
    // Read before allowNavigation, which takes the user's gesture as their approval of the site.
    const byUser = context.intent.driving === 0 && isUserNavigation(context.intent, Date.now())
    if (!allowNavigation(url)) {
      blockNavigation(url)
      return { action: "deny" }
    }
    if (byUser || context.tabs.length >= MAX_TABS) {
      void contents.loadURL(url).catch(() => undefined)
      return { action: "deny" }
    }
    const opened = createTab(context)
    activate(context, opened)
    void opened.view.webContents.loadURL(url).catch(() => undefined)
    return { action: "deny" }
  })
  const guardNavigation = (event: Electron.Event, url: string) => {
    if (allowNavigation(url)) return
    event.preventDefault()
    blockNavigation(url)
  }
  contents.on("will-navigate", guardNavigation)
  // A frame's own redirect is not the page's navigation: a frame's first load is never checked either, and blocking
  // its redirect would fail the command that loaded the page around it.
  contents.on("will-redirect", (details) => {
    if (details.isMainFrame) guardNavigation(details, details.url)
  })
  contents.on("did-navigate", () => {
    tab.consoleLogs = []
    tab.pageErrors = []
    tab.networkErrors = []
    tab.navigations += 1
    tab.title = contents.getTitle()
    emitPageEvent(context, tab)
  })
  contents.on("did-navigate-in-page", (_event, _url, isMainFrame) => {
    if (isMainFrame) tab.navigations += 1
    emitPageEvent(context, tab)
  })
  contents.on("did-start-loading", () => emitPageEvent(context, tab))
  contents.on("did-stop-loading", () => emitPageEvent(context, tab))
  contents.on("page-title-updated", (_event, title) => {
    tab.title = title
    emitPageEvent(context, tab)
  })
  contents.on("dom-ready", () => {
    void contents.executeJavaScript(PAGE_ISSUE_HOOK, true).catch(() => undefined)
  })
  // A page that asks before it is left is left: nobody is there to answer, and the command leaving it would wait.
  contents.on("will-prevent-unload", (event) => {
    event.preventDefault()
    tab.dialogs = [
      ...tab.dialogs,
      { type: "beforeunload" as const, message: "", url: redactText(contents.getURL()), at: now() },
    ].slice(-20)
  })
  contents.on("console-message", (event) => {
    const labels: Record<string, string> = { info: "info", warning: "warn", error: "error", debug: "debug" }
    tab.consoleLogs = [
      ...tab.consoleLogs,
      {
        level: labels[event.level] ?? "log",
        message: redactText(event.message),
        location: event.sourceId ? redactText(`${event.sourceId}:${event.lineNumber}`) : undefined,
      },
    ].slice(-CONSOLE_KEPT)
  })
  contents.on("render-process-gone", (_event, details) => {
    tab.pageErrors = [...tab.pageErrors, `Renderer stopped: ${details.reason}`].slice(-40)
  })
  contents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    if (errorCode === -3) return
    tab.networkErrors = [
      ...tab.networkErrors,
      { url: redactText(validatedURL), status: errorCode, error: redactText(errorDescription) },
    ].slice(-50)
  })
  // A page can close itself (window.close() on a page with no history): its tab goes, and the one before it shows.
  contents.once("destroyed", () => removeTab(context, tab))
}

async function drainInjectedIssues() {
  const tab = activeTab(currentContext())
  const contents = tab?.view.webContents
  if (!tab || !contents || contents.isDestroyed()) return
  try {
    const drained = (await contents.executeJavaScript(
      `(() => { const issues = window.__vectorAgentIssues || []; const dialogs = window.__vectorAgentDialogs || []; window.__vectorAgentIssues = []; window.__vectorAgentDialogs = []; return { issues, dialogs }; })()`,
      true,
    )) as { issues?: unknown; dialogs?: unknown } | undefined
    const issues = Array.isArray(drained?.issues) ? drained.issues : []
    if (issues.length) tab.pageErrors = [...tab.pageErrors, ...issues.map((item) => String(item))].slice(-40)
    // What the page's own world hands back is the page's to shape, so only what a dialog record holds is kept.
    const records: unknown[] = Array.isArray(drained?.dialogs) ? drained.dialogs : []
    const dialogs = records
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
      .flatMap((item): BrowserAgentDialog[] =>
        item.type === "alert" || item.type === "confirm" || item.type === "prompt"
          ? [
              {
                type: item.type,
                message: redactText(String(item.message ?? "").slice(0, 500)),
                url: redactText(String(item.url ?? "")),
                at: String(item.at ?? now()).slice(0, 40),
              },
            ]
          : [],
      )
    if (dialogs.length) tab.dialogs = [...tab.dialogs, ...dialogs].slice(-20)
  } catch {
    // Page navigated mid-read; the hook reinstalls on the next dom-ready.
  }
}

function scaledBounds(sender: WebContents, bounds: { x: number; y: number; width: number; height: number }) {
  // The renderer measures its pane in CSS pixels; the view is positioned in
  // window DIP coordinates, so account for the app zoom factor.
  const zoom = sender.getZoomFactor()
  return {
    x: Math.round(bounds.x * zoom),
    y: Math.round(bounds.y * zoom),
    width: Math.max(0, Math.round(bounds.width * zoom)),
    height: Math.max(0, Math.round(bounds.height * zoom)),
  }
}

/**
 * The hidden window that holds every view no Preview shows, so its page has a real size to lay out, paint and be
 * captured at, whether or not the user ever opens Preview. Like the research browsers' host, it never takes focus, is
 * in no taskbar or window switcher, and lives only while it holds a view.
 */
function parkWindow() {
  if (park.window && !park.window.isDestroyed()) return park.window
  park.window = new BrowserWindow({
    show: false,
    focusable: false,
    skipTaskbar: true,
    width: PARK_BOUNDS.width,
    height: PARK_BOUNDS.height,
    webPreferences: {
      partition: PARK_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  return park.window
}

function releasePark() {
  const window = park.window
  if (!window) return
  const holding = Array.from(contexts.values()).some((context) => context.tabs.some((tab) => tab.window === window))
  if (holding) return
  park.window = undefined
  if (!window.isDestroyed()) window.destroy()
}

/**
 * Puts a context's views where they belong: the active tab's in the Preview showing it, at the Preview's bounds, once
 * the Preview has measured them; every other one in the park window, at PARK_BOUNDS. A view that moves keeps its page.
 */
function place(context: BrowserContext) {
  const preview =
    context.hostWindow && !context.hostWindow.isDestroyed() && context.lastBounds
      ? { window: context.hostWindow, bounds: context.lastBounds }
      : undefined
  context.tabs.forEach((tab) => {
    if (tab.view.webContents.isDestroyed()) return
    const shown = preview && tab.id === context.active ? preview : undefined
    const target = shown?.window ?? parkWindow()
    if (tab.window !== target) {
      if (tab.window && !tab.window.isDestroyed()) tab.window.contentView.removeChildView(tab.view)
      target.contentView.addChildView(tab.view)
      tab.window = target
    }
    tab.view.setBounds(shown?.bounds ?? PARK_BOUNDS)
    tab.view.setVisible(shown ? context.shown && !context.covered : true)
  })
  releasePark()
}

function viewport(context: BrowserContext) {
  const tab = activeTab(context)
  if (!tab || tab.view.webContents.isDestroyed()) return { x: 0, y: 0, width: 0, height: 0 }
  if (context.lastBounds && tab.window && tab.window === context.hostWindow) return context.lastBounds
  return PARK_BOUNDS
}

async function attachView(event: IpcMainInvokeEvent, bounds?: { x: number; y: number; width: number; height: number }) {
  if (attaching) await attaching
  attaching = (async () => {
    const context = currentContext()
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error("Browser Agent could not find the requesting window.")
    ensureBrowserView()
    // A window's Preview shows one browser: the one it showed before goes back to the park window.
    for (const item of contexts.values()) {
      if (item === context || item.hostWindow !== win) continue
      item.hostWindow = undefined
      item.covered = false
      place(item)
    }
    if (!watchedWindows.has(win)) {
      watchedWindows.add(win)
      // The browser a Preview shows closes with its window.
      win.once("closed", () =>
        Array.from(contexts.values())
          .filter((item) => item.hostWindow === win)
          .forEach(destroyContext),
      )
    }
    context.hostWindow = win
    if (bounds) context.lastBounds = scaledBounds(event.sender, bounds)
    context.shown = true
    // Under an open dialog the view waits, hidden, for the dialog to close.
    context.covered = coveredWindows.has(win)
    place(context)
    // The Preview learns the page it now shows, which may have opened while no Preview was there.
    emitPageEvent(context)
  })()
  try {
    await attaching
  } finally {
    attaching = undefined
  }
}

// Every new view starts in the park window at PARK_BOUNDS, and moves into a Preview when one shows it.
function createTab(context: BrowserContext) {
  const partition = session.fromPartition(PARTITION)
  hardenSession(partition)
  const view = new WebContentsView({ webPreferences: { session: partition, ...AGENT_BROWSER_PREFERENCES } })
  view.setBackgroundColor("#18181a")
  const contents = view.webContents
  const tab: BrowserTab = {
    id: `tab_${context.nextTab}`,
    view,
    contentsId: contents.id,
    title: "",
    consoleLogs: [],
    pageErrors: [],
    networkErrors: [],
    requests: [],
    inflight: new Map(),
    dialogs: [],
    navigations: 0,
    chooser: false,
  }
  context.nextTab += 1
  context.tabs = [...context.tabs, tab]
  tabsByContents.set(tab.contentsId, { context, tab })
  // What its pages load counts in the session the agent browses for, in Vector Local's network log.
  if (SESSION_ID.test(context.id)) {
    const stop = egressFilter.attribute(contents.id, { sessionID: context.id })
    contents.on("destroyed", stop)
  }
  wireTab(context, tab)
  interceptFileChoosers(context, tab)
  place(context)
  return tab
}

/**
 * No native file dialog opens from an agent tab, whatever the page's scripts do: a button whose handler calls a hidden
 * file input's click() or showPicker() passes every check of what Vector clicks or presses, and a trusted click or key
 * gives the page the activation a chooser needs. The browser's debugging protocol takes each chooser the page opens
 * instead, and Vector drops it, as research browsers do. Until that is set, and in a tab whose debugger cannot attach,
 * no command clicks, types or presses keys (CHOOSER_COMMANDS). Frames of other sites run in their own process, and
 * what they open is not held: Enter and Space are refused in a frame Vector cannot read (press).
 */
function interceptFileChoosers(context: BrowserContext, tab: BrowserTab) {
  const contents = tab.view.webContents
  const tools = contents.debugger
  const release = holdDebugger(tools)
  if (!release) return
  contents.once("destroyed", () => void release())
  tools.on("detach", () => {
    tab.chooser = false
  })
  tools.on("message", (_event, method, params) => {
    // With the Page domain on, a dialog can wait for the debugger to answer it: answered as disableDialogs answers it
    // (closed, cancelled, no text), and a page that asks before it is left is left, as will-prevent-unload lets it.
    if (method === "Page.javascriptDialogOpening") {
      const accept = (params as { type?: unknown } | undefined)?.type === "beforeunload"
      void tools.sendCommand("Page.handleJavaScriptDialog", { accept }).catch(() => undefined)
      return
    }
    if (method !== "Page.fileChooserOpened") return
    // Said in the page's errors too, which the next report shows, so the agent learns why nothing was chosen.
    tab.pageErrors = [...tab.pageErrors, CHOOSER_DROPPED].slice(-40)
    pushAction("Dropped a file picker the page opened", false, CHOOSER_DROPPED, undefined, context)
  })
  const prepare = () =>
    void tools
      .sendCommand("Page.enable")
      .then(() => tools.sendCommand("Page.setInterceptFileChooserDialog", { enabled: true }))
      .then(
        () => {
          tab.chooser = true
        },
        () => {
          tab.chooser = false
        },
      )
  // A web contents that has loaded nothing has no page for the debugger yet; its first navigation's start has one,
  // before any of the page's scripts run.
  if (contents.getURL() === "" && !contents.isLoading()) contents.once("did-start-navigation", prepare)
  else prepare()
}

// Makes a tab the one commands act on and the Preview shows, and tells the Preview.
function activate(context: BrowserContext, tab: BrowserTab) {
  context.active = tab.id
  place(context)
  emitPageEvent(context)
}

// Takes a tab out of its context and closes its page. When it was the active one, the tab before it is shown.
function removeTab(context: BrowserContext, tab: BrowserTab) {
  const index = context.tabs.indexOf(tab)
  if (index === -1) return
  context.tabs = context.tabs.filter((item) => item !== tab)
  dropTab(tab)
  if (context.active === tab.id) context.active = context.tabs[Math.max(0, index - 1)]?.id
  place(context)
  emitPageEvent(context)
}

function dropTab(tab: BrowserTab) {
  tabsByContents.delete(tab.contentsId)
  if (tab.window && !tab.window.isDestroyed()) tab.window.contentView.removeChildView(tab.view)
  tab.window = undefined
  if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
}

// Tabs whose page is gone, closed by itself or by a crash, leave their context.
function pruneTabs(context: BrowserContext) {
  context.tabs.filter((tab) => tab.view.webContents.isDestroyed()).forEach((tab) => removeTab(context, tab))
}

// The active tab's view, opening the context's first page when it has none. A page that closed itself left its tab;
// its replacement goes where the context's view is shown, with the same bounds and visibility.
function ensureBrowserView(context = currentContext()) {
  pruneTabs(context)
  const active = activeTab(context)
  if (active) return active.view
  const tab = createTab(context)
  activate(context, tab)
  pushAction("Controlled browser launched", true, undefined, undefined, context)
  return tab.view
}

function detachView() {
  // Out of the Preview, but alive and drawn in the park window, so the agent keeps working on it and reopening the
  // workspace resumes where the agent (or the user) left off. closeBrowser destroys it for real.
  const context = currentContext()
  context.hostWindow = undefined
  context.covered = false
  place(context)
}

async function closeBrowser() {
  destroyContext(currentContext())
}

function destroyContext(context: BrowserContext) {
  const tabs = context.tabs
  context.tabs = []
  context.active = undefined
  context.closing.abort()
  tabs.forEach(dropTab)
  context.hostWindow = undefined
  context.lastBounds = undefined
  context.allowedExternalOrigins.clear()
  context.blockedNavigationError = undefined
  context.actionTimeline = [
    {
      label: "Browser stopped",
      ok: true,
      at: now(),
    },
  ]
  contexts.delete(context.id)
  releasePark()
}

function ensureTab() {
  const tab = activeTab(currentContext())
  if (!tab || tab.view.webContents.isDestroyed()) {
    throw new Error("The controlled browser is unavailable for this task.")
  }
  return tab
}

function ensureView() {
  return ensureTab().view.webContents
}

async function runScript<T>(script: string): Promise<T> {
  const contents = ensureView()
  return (await contents.executeJavaScript(script, true)) as T
}

export async function openUrl(url: string, allowExternal = false) {
  const context = currentContext()
  const target = safeUrl(url, allowExternal)
  const origin = browserOrigin(target)
  if (origin && !isLocalBrowserUrl(target) && allowExternal) context.allowedExternalOrigins.add(origin)
  const tab = ensureTab()
  const contents = tab.view.webContents
  try {
    await contents.loadURL(target)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // ERR_ABORTED means a superseding navigation interrupted this one (e.g. a
    // redirect committed first) — the page is fine, so it is not a failure.
    if (!/ERR_ABORTED/i.test(message)) {
      const friendly = `Could not open ${target}: ${message}`
      tab.networkErrors = [...tab.networkErrors, { url: redactText(target), error: redactText(friendly) }].slice(-50)
      throw new Error(friendly, { cause: error })
    }
  }
  tab.title = contents.getTitle()
  pushAction(`Opened ${target}`)
}

/** Opens a URL, with openUrl's rules, in a new tab that becomes the active one. */
export async function openTab(url: string, allowExternal = false) {
  const context = currentContext()
  safeUrl(url, allowExternal)
  pruneTabs(context)
  if (context.tabs.length >= MAX_TABS)
    throw new Error(`This browser already has ${MAX_TABS} tabs open, the most it holds. Close one first.`)
  if (context.tabs.length === 0) ensureBrowserView(context)
  else activate(context, createTab(context))
  await openUrl(url, allowExternal)
}

function findTab(tabId: string | undefined) {
  const context = currentContext()
  if (!tabId) throw new Error("Name the tab, from list_tabs.")
  pruneTabs(context)
  const tab = context.tabs.find((item) => item.id === tabId)
  if (!tab) throw new Error(`This browser has no ${tabId}. List the tabs again.`)
  return tab
}

export async function switchTab(tabId: string | undefined) {
  const tab = findTab(tabId)
  activate(currentContext(), tab)
  pushAction(`Switched to ${tab.id}`)
}

/**
 * Closes a tab; the tab before it is shown when it was the active one. Closing the last tab closes the browser, once
 * this command has reported (runBrowserAgent): closing it now would end this command as one the close cut short.
 */
export async function closeTab(tabId: string | undefined) {
  const context = currentContext()
  const tab = findTab(tabId)
  removeTab(context, tab)
  pushAction(`Closed ${tab.id}`)
}

// The commands whose clicks and keys could open a file picker, which run only in a tab that holds its choosers.
const CHOOSER_COMMANDS = new Set(["click", "clickRef", "type", "typeRef", "press", "selectOption"])
const CHOOSER_UNHELD =
  "Vector did not act on this page: it cannot keep the page from opening a file picker here, because the browser's debugger did not attach. Close any developer tools open on it, or open the page again."
const CHOOSER_DROPPED =
  "The page tried to open a file picker. Vector never opens one in a page; hand that step to the user."

// Names a selector's first match with SELECTOR_REF, so a selector command takes the ref commands' path.
async function boundSelector(selector: string) {
  if (!(await runPageScript<boolean>(bindSelector, selector, SELECTOR_REF)))
    throw new Error(`No element matches selector: ${selector}`)
  return SELECTOR_REF
}

/**
 * Clicks what a selector matches first, as clickRef clicks a ref: trusted input at its centre, the DOM's click when
 * something else covers it, and a file field, or a label for one, refused.
 */
export async function click(selector: string) {
  await clickTarget(await boundSelector(selector), selector)
}

/**
 * Executor-level guard (defense in depth beyond the planner prompt): typing
 * into credential fields is always refused so the run hands control to the user
 * with the browser tool's handoff instead of ever filling passwords, OTPs, or cards.
 *
 * This is serialized into the page with toString(), so the body has to stay
 * self-contained: anything it read from module scope would be a ReferenceError
 * inside the renderer.
 */
export { isCredentialField } from "./browser-credential-field"

// Every injected script that is about to put characters somewhere opens with
// this so all of them decide with the same predicate rather than each carrying
// its own copy of the rule.
const CREDENTIAL_GUARD = `
    const isCredentialField = ${isCredentialField.toString()};
    const describeField = (el) => ({
      type: el.getAttribute("type"),
      autocomplete: el.getAttribute("autocomplete"),
      name: el.getAttribute("name"),
      id: el.getAttribute("id"),
      textSecurity: (el.ownerDocument.defaultView || window).getComputedStyle(el).getPropertyValue("-webkit-text-security"),
    });`

function credentialRefusal(target: string) {
  return `Refused to send keystrokes to ${target}: it is a credential field (password, one-time code, or card number). Vector never fills credentials — use handoff so the user can complete this step in the live browser.`
}

// Keystrokes land on whatever holds focus, not on the field a caller named, so the paths that type blind (press, and
// type's trusted keys) ask about focus before every key event, followed into shadow roots and frames.
function credentialFocused() {
  return runPageScript<boolean>(focusedCredential, isCredentialField)
}

// What an editable element shows, compared with the text typed: Chromium puts a no-break space for a typed trailing or
// double space, and a typed line break makes a block, which innerText shows as one line break or more.
function sameText(shown: string, expected: string) {
  const normal = (text: string) =>
    text
      .replace(/\u00a0/g, " ")
      .replace(/\r\n?/g, "\n")
      .replace(/\n+/g, "\n")
      .replace(/^\n+|\n+$/g, "")
  return shown === expected || normal(shown) === normal(expected)
}

export async function type(selector: string, text: string) {
  const contents = ensureView()
  // Phase 1 (in-page): the selector's first match, taken as typeRef takes a ref: a text field, a text area or editable
  // text, never a credential field, a file field or a button (a space typed there would press it), focused with what it
  // holds selected, so the trusted keystrokes replace it.
  const ref = await boundSelector(selector)
  const focused = await runPageScript<Focus>(focusField, ref, isCredentialField, selector)
  if (!focused.ok) throw new Error(focused.credential ? credentialRefusal(selector) : focused.reason)

  // Phase 2: real key events through sendInputEvent, char by char, so React/Vue/Svelte controlled inputs see native
  // keystrokes and update state. Each goes only while focus is still on that element: a tab in the text moves focus,
  // and a page's key handler can move it, so the characters after would land on another control.
  if (text.length > 0) {
    contents.focus()
    const moved = await sendGuardedCharacters(
      text,
      () => runPageScript<boolean>(typingMoved, ref, isCredentialField),
      (event) => contents.sendInputEvent(event),
    ).then(
      () => false,
      (error: unknown) => error instanceof CredentialFocusChangedError,
    )
    // A character no key types (emoji, some symbols) falls through, and the check below writes it.
    if (moved && (await credentialFocused())) throw new Error(credentialRefusal("the focused field"))
    if (moved) throw new Error(`Focus left ${selector} while Vector typed, so it stopped. Check the page again.`)
    // Let the queued input events flush and the framework re-render.
    await new Promise((resolve) => setTimeout(resolve, 80))
  }

  // Phase 3: verify what actually landed, a field's value or the text an editable element shows. If trusted typing
  // missed (element in an unfocused subtree, exotic characters, empty text), write the whole text at once so
  // frameworks still notice. The element behind the selector can have been swapped while phase 2 ran, so the fallback
  // re-checks rather than trusting phase 1's verdict, and a selector that matches nothing now fails.
  await boundSelector(selector)
  const shown = await runPageScript<string | undefined>(fieldValue, ref)
  if (shown !== undefined && sameText(shown, text)) {
    pushAction(`Typed into ${selector}`)
    return
  }
  const applied = await runPageScript<Focus>(replaceText, ref, text, isCredentialField)
  if (!applied.ok) throw new Error(applied.credential ? credentialRefusal(selector) : applied.reason)
  pushAction(`Typed into ${selector} (native setter fallback)`)
}

/**
 * Types into what observePage named `ref`: a text-like field, a text area or an editable element, never a credential
 * field. Trusted key events go one at a time, each only while focus is still on that field (followed into shadow
 * roots and frames), and the result is checked against what the field shows.
 */
export async function typeRef(ref: string, text: string) {
  const contents = ensureView()
  const focused = await runPageScript<Focus>(focusField, ref, isCredentialField)
  if (!focused.ok) throw new Error(focused.credential ? credentialRefusal(ref) : focused.reason)
  if (text.length > 0) {
    contents.focus()
    const moved = await sendGuardedCharacters(
      text,
      () => runPageScript<boolean>(typingMoved, ref, isCredentialField),
      (event) => contents.sendInputEvent(event),
    ).then(
      () => false,
      (error: unknown) => error instanceof CredentialFocusChangedError,
    )
    // A character no key types falls through, and the check below writes it; focus that moved stops the typing.
    if (moved) throw new Error(`Focus left ${ref} while Vector typed, so it stopped. Observe the page again.`)
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  const shown = await runPageScript<string | undefined>(fieldValue, ref)
  if (shown !== undefined && sameText(shown, text)) {
    pushAction(`Typed into ${ref}`)
    return
  }
  const applied = await runPageScript<Focus>(replaceText, ref, text, isCredentialField)
  if (!applied.ok) throw new Error(applied.credential ? credentialRefusal(ref) : applied.reason)
  pushAction(`Typed into ${ref} (native setter fallback)`)
}

/**
 * Presses a key, alone or with modifiers (Control+Enter, Shift+Tab, Mod+a), with trusted key events. A key that types
 * a character goes through the credential focus guard; select all, undo and redo run as the page's own commands; the
 * clipboard's keys are refused.
 */
export async function press(key: string) {
  const contents = ensureView()
  const parsed = parseKeyPress(key)
  if (parsed.kind === "clipboard") throw new Error(CLIPBOARD_REFUSED)
  if (parsed.kind === "edit") {
    contents[parsed.edit]()
    pushAction(`Pressed ${key}`)
    return
  }
  // Enter and Space press the focused control, and on a file field that is a file picker. In a frame Vector cannot
  // read, what they would press is unknown.
  const picker = ["enter", "space", "\r", "\n"].includes(parsed.keyCode.toLowerCase())
    ? await runPageScript<"file" | "frame" | undefined>(focusedFileField)
    : undefined
  if (picker === "file")
    throw new Error(`Vector never opens a file picker in a page, so it did not press ${key} on that file field.`)
  if (picker === "frame")
    throw new Error(
      `Vector did not press ${key}: focus is in a frame Vector cannot read, where it could open a file picker. Click what you mean instead.`,
    )
  // press() reaches the page through the same trusted key pipeline as type(),
  // so without this a caller spells a password out one single-character press
  // at a time and walks straight around type()'s guard.
  const guarded = async () => parsed.typesCharacter && (await credentialFocused())
  if (await guarded()) throw new Error(credentialRefusal("the focused field"))
  try {
    // Electron's documented pattern: keyDown + char + keyUp. The char event is
    // what makes Enter actually submit forms and reach framework key handlers.
    contents.focus()
    contents.sendInputEvent({ type: "keyDown", keyCode: parsed.keyCode, modifiers: parsed.modifiers })
    if (await guarded()) throw new CredentialFocusChangedError()
    if (parsed.char) contents.sendInputEvent({ type: "char", keyCode: parsed.keyCode, modifiers: parsed.modifiers })
    if (await guarded()) throw new CredentialFocusChangedError()
    contents.sendInputEvent({ type: "keyUp", keyCode: parsed.keyCode, modifiers: parsed.modifiers })
    pushAction(`Pressed ${key}`)
  } catch (error) {
    if (error instanceof CredentialFocusChangedError) throw new Error(credentialRefusal("the focused field"))
    // A combination is trusted input or nothing: a page tells synthetic events apart, and a synthetic Control or Meta
    // key would only seem to have worked.
    if (parsed.modifiers.length > 0) throw new Error(`The browser could not press ${key}.`, { cause: error })
    // JS fallback for keys sendInputEvent rejects: synthetic key events on the
    // focused element, plus explicit form submission for Enter.
    const fallback = await runScript<{ guarded?: boolean }>(`(() => {${CREDENTIAL_GUARD}
      const key = ${JSON.stringify(key)};
      const typesCharacter = ${JSON.stringify(parsed.typesCharacter)};
      const active = () => document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body;
      const guarded = () => typesCharacter && isCredentialField(describeField(active()));
      if (guarded()) return { guarded: true };
      const el = active();
      const init = { key, code: key.length === 1 ? undefined : key, bubbles: true, cancelable: true };
      const proceed = el.dispatchEvent(new KeyboardEvent("keydown", init));
      if (guarded()) return { guarded: true };
      el.dispatchEvent(new KeyboardEvent("keypress", init));
      if (guarded()) return { guarded: true };
      el.dispatchEvent(new KeyboardEvent("keyup", init));
      if (key === "Enter" && proceed) {
        const form = el.form || (el.closest ? el.closest("form") : null);
        if (form) {
          if (typeof form.requestSubmit === "function") form.requestSubmit();
          else form.submit();
        }
      }
      return { guarded: false };
    })()`)
    if (fallback.guarded) throw new Error(credentialRefusal("the focused field"))
    pushAction(`Pressed ${key} (synthetic fallback)`)
  }
}

export async function wait(milliseconds: number) {
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(milliseconds, 15_000))))
  pushAction(`Waited ${milliseconds}ms`)
}

async function runIsolatedScript<T>(script: string): Promise<T> {
  const contents = ensureView()
  return (await contents.executeJavaScriptInIsolatedWorld(WAIT_WORLD, [{ code: script }], true)) as T
}

// Runs one of browser-page.ts's functions in the page's own world for Vector, with the window and these arguments.
function runPageScript<T>(fn: (win: Window, ...rest: never[]) => unknown, ...args: unknown[]) {
  return runInWorld<T>(ensureView(), PAGE_WORLD, fn, ...args)
}

/**
 * Runs one of browser-page.ts's functions in an isolated world of a page, apart from the page's own globals, with the
 * window and these arguments (a function argument goes as its source). The research browsers use it too.
 */
export async function runInWorld<T>(
  contents: Pick<WebContents, "executeJavaScriptInIsolatedWorld">,
  world: number,
  fn: (win: Window, ...rest: never[]) => unknown,
  ...args: unknown[]
): Promise<T> {
  const values = args.map((value) => (typeof value === "function" ? value.toString() : JSON.stringify(value)))
  return (await contents.executeJavaScriptInIsolatedWorld(
    world,
    [{ code: `(${fn.toString()})(window${values.map((value) => `, ${value}`).join("")})` }],
    true,
  )) as T
}

/**
 * Clicks what observePage named `ref` with trusted input at its centre, as the user's own click would land, or with the
 * DOM's click when something else covers that point. A file field, or a label for one, is refused.
 */
export async function clickRef(ref: string) {
  await clickTarget(ref, ref)
}

async function clickTarget(ref: string, label: string) {
  const contents = ensureView()
  const point = await runPageScript<ClickPoint>(clickPoint, ref)
  if (!point.ok) throw new Error(point.reason)
  // The page measures in CSS pixels; input goes to the view in its own coordinates.
  const zoom = contents.getZoomFactor()
  const at = { x: Math.round(point.x * zoom), y: Math.round(point.y * zoom) }
  if (point.hit) {
    contents.sendInputEvent({ type: "mouseMove", ...at })
    contents.sendInputEvent({ type: "mouseDown", ...at, button: "left", clickCount: 1 })
    contents.sendInputEvent({ type: "mouseUp", ...at, button: "left", clickCount: 1 })
  }
  if (!point.hit) await runPageScript(clickElement, ref)
  pushAction(`Clicked ${label}`)
}

/** Moves the pointer onto what a ref names, scrolled into view, with a trusted mouse move at its centre. */
export async function hover(ref: string, label = ref) {
  const contents = ensureView()
  const point = await runPageScript<ClickPoint>(clickPoint, ref, { hover: true })
  if (!point.ok) throw new Error(point.reason)
  const zoom = contents.getZoomFactor()
  contents.sendInputEvent({ type: "mouseMove", x: Math.round(point.x * zoom), y: Math.round(point.y * zoom) })
  pushAction(`Hovered over ${label}`)
}

/** Chooses options of a `<select>` by value or visible label. */
export async function selectOption(ref: string, values: readonly string[], label = ref) {
  const chosen = await runPageScript<Chosen>(chooseOptions, ref, values)
  if (!chosen.ok) throw new Error(chosen.reason)
  pushAction(`Selected ${chosen.labels.join(", ")} in ${label}`, true, undefined, chosen.labels)
}

export async function waitForSelector(selector: string) {
  await runIsolatedScript(`new Promise((resolve, reject) => {
    const selector = ${JSON.stringify(selector)};
    if (document.querySelector(selector)) return resolve(true);
    const observer = new MutationObserver(() => {
      if (document.querySelector(selector)) {
        observer.disconnect();
        resolve(true);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => {
      observer.disconnect();
      reject(new Error("Timed out waiting for selector: " + selector));
    }, 10000);
  })`)
  pushAction(`Waited for ${selector}`)
}

export async function waitForText(text: string) {
  await runIsolatedScript(`new Promise((resolve, reject) => {
    const text = ${JSON.stringify(text)};
    const hasText = () => (document.body?.innerText || "").includes(text);
    if (hasText()) return resolve(true);
    const observer = new MutationObserver(() => {
      if (hasText()) {
        observer.disconnect();
        resolve(true);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    setTimeout(() => {
      observer.disconnect();
      reject(new Error("Timed out waiting for text: " + text));
    }, 10000);
  })`)
  pushAction(`Waited for text "${text}"`)
}

export async function takeScreenshot() {
  const contents = ensureView()
  const image = await contents.capturePage()
  pushAction("Screenshot captured")
  return image.toDataURL()
}

/**
 * Until a page's load ends: it stops loading, or its main frame fails to load, or, for a history step within the same
 * document, that step commits. At most `ms`.
 */
function loadEnd(contents: WebContents, ms: number, inPage = false) {
  return new Promise<void>((resolve) => {
    const failed = (
      _event: Electron.Event,
      _code: number,
      _description: string,
      _url: string,
      isMainFrame: boolean,
    ) => {
      if (isMainFrame) done()
    }
    const moved = (_event: Electron.Event, _url: string, isMainFrame: boolean) => {
      if (inPage && isMainFrame) done()
    }
    const done = () => {
      clearTimeout(timer)
      contents.removeListener("did-stop-loading", done)
      contents.removeListener("did-fail-load", failed)
      contents.removeListener("did-navigate-in-page", moved)
      contents.removeListener("destroyed", done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    contents.on("did-stop-loading", done)
    contents.on("did-fail-load", failed)
    contents.on("did-navigate-in-page", moved)
    contents.on("destroyed", done)
  })
}

// Starts a reload or a history step and waits for the navigation it starts, as openUrl waits for its load.
async function travel(contents: WebContents, start: () => void) {
  const ended = loadEnd(contents, LOAD_WAIT_MS, true)
  start()
  await ended
}

export async function reload() {
  const contents = ensureView()
  await travel(contents, () => contents.reload())
  pushAction("Reloaded page")
}

export async function goBack() {
  const contents = ensureView()
  if (!contents.navigationHistory.canGoBack()) throw new Error("There is no earlier page in this tab.")
  await travel(contents, () => contents.navigationHistory.goBack())
  pushAction("Went back")
}

export async function goForward() {
  const contents = ensureView()
  if (!contents.navigationHistory.canGoForward()) throw new Error("There is no later page in this tab.")
  await travel(contents, () => contents.navigationHistory.goForward())
  pushAction("Went forward")
}

/**
 * Waits for what a driving command started: a moment for it to begin, the load it began to end, then no request of
 * the tab in flight for QUIET_MS. `before` is the active tab and its navigations when the command started.
 */
async function settle(context: BrowserContext, before: { readonly tab?: string; readonly navigations: number }) {
  const started = Date.now()
  await new Promise((resolve) => setTimeout(resolve, SETTLE_START_MS))
  const tab = activeTab(context)
  if (!tab || tab.view.webContents.isDestroyed())
    return { navigated: before.tab !== undefined, idle: true, waitedMs: Date.now() - started }
  if (tab.view.webContents.isLoading()) await loadEnd(tab.view.webContents, LOAD_WAIT_MS)
  const quiet = { since: Date.now(), idle: false }
  const deadline = Date.now() + QUIET_WAIT_MS
  while (!quiet.idle && Date.now() < deadline && !tab.view.webContents.isDestroyed()) {
    if (tab.inflight.size > 0) quiet.since = Date.now()
    quiet.idle = Date.now() - quiet.since >= QUIET_MS
    if (!quiet.idle) await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return {
    navigated: tab.id !== before.tab || tab.navigations !== before.navigations,
    idle: quiet.idle || tab.view.webContents.isDestroyed(),
    waitedMs: Date.now() - started,
  }
}

export async function scroll(deltaY = 680) {
  const amount = Math.max(-2400, Math.min(deltaY, 2400))
  await runScript(`window.scrollBy({ top: ${amount}, left: 0, behavior: "smooth" }); true`)
  pushAction(`Scrolled ${amount > 0 ? "down" : "up"} ${Math.abs(amount)}px`)
}

export function currentUrl() {
  const contents = activeTab(currentContext())?.view.webContents
  if (!contents || contents.isDestroyed()) return ""
  return contents.getURL()
}

export function clearLogs() {
  const context = currentContext()
  const tab = activeTab(context)
  if (tab) {
    tab.consoleLogs = []
    tab.pageErrors = []
    tab.networkErrors = []
    tab.requests = []
  }
  context.actionTimeline = []
  pushAction("Logs cleared")
}

/**
 * What a click on a ref, or on a selector's first match, would press, as clickTargetLabel names it: the engine's
 * sensitive check before a click, and the desktop's own check that the target is still the one judged.
 */
async function inspectTarget(ref: string | undefined, selector: string | undefined) {
  const key =
    ref ?? (selector && (await runPageScript<boolean>(bindSelector, selector, SELECTOR_REF)) ? SELECTOR_REF : "")
  if (!key) return { found: false, label: "" }
  return runPageScript<NonNullable<BrowserAutomationRun["target"]>>(
    (win: Window, name: string, label: typeof clickTargetLabel) => {
      const element = (win as unknown as { __vectorRefs?: Map<string, Element> }).__vectorRefs?.get(name)
      return element ? { found: true, label: label(element) } : { found: false, label: "" }
    },
    key,
    clickTargetLabel,
  )
}

/**
 * The engine judged one page and one target before it asked the user, in a request of its own; the page can have
 * moved on since. Checked inside the command's own turn, so nothing runs between the check and the action.
 */
async function checkExpected(input: BrowserAgentInput) {
  if (input.expectOrigin !== undefined) {
    const url = currentUrl()
    const origin = URL.canParse(url) ? new URL(url).origin : ""
    if (origin !== input.expectOrigin)
      throw new Error(
        `The page changed to ${origin || "no page"} since Vector checked it, so nothing was done. Check the page again.`,
      )
  }
  if (input.expectLabel === undefined || (input.command !== "click" && input.command !== "clickRef")) return
  const target =
    input.command === "clickRef"
      ? await inspectTarget(input.ref, undefined)
      : await inspectTarget(undefined, input.selector)
  if (target.label !== input.expectLabel)
    throw new Error("The element changed since Vector checked it, so nothing was clicked. Check the page again.")
}

const DOM_INSPECT_SCRIPT = `(() => {
  const selectorFor = (el) => {
    if (el.id) return "#" + CSS.escape(el.id);
    const test = el.getAttribute("data-testid") || el.getAttribute("data-test") || el.getAttribute("aria-label") || el.getAttribute("name");
    if (test) return el.tagName.toLowerCase() + "[" + (el.getAttribute("data-testid") ? "data-testid" : el.getAttribute("data-test") ? "data-test" : el.getAttribute("aria-label") ? "aria-label" : "name") + "=" + JSON.stringify(test) + "]";
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 4) {
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((item) => item.tagName === node.tagName);
        if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  };
  const pick = (el) => ({
    tag: el.tagName.toLowerCase(),
    text: (el.innerText || el.textContent || el.getAttribute("aria-label") || "").trim().replace(/\\s+/g, " ").slice(0, 90),
    selector: selectorFor(el),
    role: el.getAttribute("role") || undefined,
    type: el.getAttribute("type") || undefined,
  });
  const pickInput = (el) => ({
    tag: el.tagName.toLowerCase(),
    selector: selectorFor(el),
    placeholder: el.getAttribute("placeholder") || undefined,
    type: el.getAttribute("type") || undefined,
    name: el.getAttribute("name") || undefined,
  });
  return {
    title: document.title || "",
    description: document.querySelector('meta[name="description"]')?.getAttribute("content") || "",
    textSample: (document.body?.innerText || "").trim().replace(/\\s+/g, " ").slice(0, 1200),
    links: document.querySelectorAll("a").length,
    scripts: document.querySelectorAll("script").length,
    stylesheets: document.querySelectorAll('link[rel~="stylesheet"], style').length,
    htmlBytes: new Blob([document.documentElement.outerHTML]).size,
    interactives: Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')).slice(0, 40).map(pick),
    inputs: Array.from(document.querySelectorAll("input, textarea, select, [contenteditable=true]")).slice(0, 40).map(pickInput),
  };
})()`

async function inspectDom(): Promise<BrowserAgentDom> {
  const dom = await runScript<BrowserAgentDom>(DOM_INSPECT_SCRIPT)
  const tab = activeTab(currentContext())
  if (tab) tab.title = dom.title
  return dom
}

const COMPUTED_STYLES_SCRIPT = `(() => {
  const selectorFor = (el) => {
    if (el.id) return "#" + CSS.escape(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 4) {
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((item) => item.tagName === node.tagName);
        if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  };
  return Array.from(
    document.querySelectorAll("main, header, nav, section, article, form, h1, h2, h3, button, a, input, textarea, select, [role]")
  )
    .filter((el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    })
    .slice(0, 35)
    .map((el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        tag: el.tagName.toLowerCase(),
        selector: selectorFor(el),
        text: (el.innerText || el.textContent || el.getAttribute("aria-label") || "").trim().replace(/\\s+/g, " ").slice(0, 90),
        display: style.display,
        visibility: style.visibility,
        color: style.color,
        backgroundColor: style.backgroundColor,
        fontSize: style.fontSize,
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      };
    });
})()`

export async function runBrowserAgent(
  event: IpcMainInvokeEvent | undefined,
  input: BrowserAgentInput,
): Promise<BrowserAutomationRun> {
  const contextId = input.contextId.trim()
  if (!contextId) throw new Error("The controlled browser needs an active Vector task context.")
  // The app's dialogs hide and restore every browser view in their own window, whichever task each one belongs to.
  if (input.command === "setVisible" && event) {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window) setWindowVisible(window, input.visible !== false)
    return stoppedReport()
  }
  const command = input.command ?? ""
  const context = getContext(contextId, !PASSIVE_COMMANDS.has(command))
  if (!context) return command === "listTabs" ? { ...stoppedReport(), tabs: [] } : stoppedReport()
  // The Preview's own buttons are the user's: they drive nothing for the agent, and a redirect their navigation meets
  // is theirs to follow, as one after their own click on a link is.
  const user = event !== undefined && USER_COMMANDS.has(command)
  const automation = automationTurn(context.intent)
  const run = async () => {
    if (user) context.intent.userInputAt = Date.now()
    if (!user && DRIVING_COMMANDS.has(command)) automation.begin()
    try {
      return await contextStorage.run(context, () => runBrowserAgentInContext(event, input))
    } finally {
      automation.end(Date.now())
    }
  }
  const immediate = PANEL_COMMANDS.has(command) || command === "closeBrowser" || user
  context.busy++
  // One command at a time on a page; the number of pages stays uncapped.
  const report = immediate
    ? run()
    : queueTurn(context, run, (reason) => {
        // The command given up may run on, but its hold on the browser ends with its turn, so the user's own clicks
        // count again.
        automation.end(Date.now())
        return reason === "closed" ? closedReport(command) : timedOutReport(context, command)
      })
  return report.finally(() => {
    context.busy--
    // Its last tab closed, the browser is closed, as closeBrowser closes it.
    if (command === "closeTab" && context.tabs.length === 0 && contexts.get(context.id) === context)
      destroyContext(context)
  })
}

async function runBrowserAgentInContext(
  event: IpcMainInvokeEvent | undefined,
  input: BrowserAgentInput,
): Promise<BrowserAutomationRun> {
  const checkedAt = now()
  const command = input.command ?? ""
  let commandOk = true
  let commandError: string | undefined
  let screenshotDataUrl = ""
  let computedStyles: BrowserAgentComputedStyle[] | undefined
  let pageHtml: string | undefined
  let pageHtmlTotal: number | undefined
  let page: PageRead | undefined
  let observed: Observed | undefined
  let target: BrowserAutomationRun["target"]
  let network: BrowserAgentRequest[] | undefined
  let settled: Settled | undefined

  try {
    if (input.command === "setVisible") {
      const context = currentContext()
      if (context.hostWindow && !context.hostWindow.isDestroyed()) {
        // Under an open dialog the view waits, hidden, for the dialog to close, whoever asks to show it.
        const show = input.visible !== false
        context.shown = show
        context.covered = show && coveredWindows.has(context.hostWindow)
        place(context)
      }
      return stoppedReport()
    }
    if (!NO_PAGE_COMMANDS.has(command)) ensureBrowserView()
    await checkExpected(input)
    // A tab whose file choosers Vector does not hold is not driven: a click or a key there could open one.
    if (CHOOSER_COMMANDS.has(command) && activeTab(currentContext())?.chooser !== true) throw new Error(CHOOSER_UNHELD)
    const start = activeTab(currentContext())
    const before = { tab: start?.id, navigations: start?.navigations ?? 0 }
    switch (input.command) {
      case "attach":
        if (!event) throw new Error("Only Vector's visible browser panel can attach the browser view.")
        await attachView(event, input.bounds)
        break
      case "setBounds":
        if (!event) throw new Error("Browser bounds can only be changed by the visible Browser panel.")
        {
          const context = currentContext()
          if (input.bounds && context.hostWindow && !context.hostWindow.isDestroyed()) {
            context.lastBounds = scaledBounds(event.sender, input.bounds)
            place(context)
          }
        }
        break
      case "detach":
        detachView()
        break
      case "closeBrowser":
        await closeBrowser()
        break
      case "openUrl":
        if (!input.url) throw new Error("The controlled browser needs a URL to open.")
        await openUrl(input.url, input.allowExternal)
        break
      case "openTab":
        if (!input.url) throw new Error("The controlled browser needs a URL to open in a new tab.")
        await openTab(input.url, input.allowExternal)
        break
      case "listTabs":
        break
      case "switchTab":
        await switchTab(input.tabId)
        break
      case "closeTab":
        await closeTab(input.tabId)
        break
      case "click":
        if (!input.selector) throw new Error("The controlled browser needs a selector to click.")
        await click(input.selector)
        break
      case "clickRef":
        if (!input.ref) throw new Error("The controlled browser needs a ref from observe to click.")
        await clickRef(input.ref)
        break
      case "hover":
        if (input.ref) await hover(input.ref)
        else if (input.selector) await hover(await boundSelector(input.selector), input.selector)
        else throw new Error("The controlled browser needs a ref or a selector to hover over.")
        break
      case "selectOption":
        if (input.ref) await selectOption(input.ref, input.values ?? [])
        else if (input.selector)
          await selectOption(await boundSelector(input.selector), input.values ?? [], input.selector)
        else throw new Error("The controlled browser needs a ref or a selector of the list to choose in.")
        break
      case "readPage":
        page = await runPageScript<PageRead>(readPage, { maxBytes: READ_BYTES })
        pushAction("Read the page", true, undefined, `${page.html.length} characters`)
        break
      case "observePage":
        observed = await runPageScript<Observed>(observePage, { maxText: 1_200, maxElements: 60 })
        pushAction("Observed the page", true, undefined, `${observed.elements.length} controls`)
        break
      case "type":
        if (!input.selector) throw new Error("The controlled browser needs a selector to type into.")
        await type(input.selector, input.text ?? "")
        break
      case "typeRef":
        if (!input.ref) throw new Error("The controlled browser needs a ref from observe to type into.")
        await typeRef(input.ref, input.text ?? "")
        break
      case "press":
        if (!input.key) throw new Error("The controlled browser needs a key to press.")
        await press(input.key)
        break
      case "wait":
        await wait(input.milliseconds ?? 500)
        break
      case "waitForSelector":
        if (!input.selector) throw new Error("Browser Agent needs a selector to wait for.")
        await waitForSelector(input.selector)
        break
      case "waitForText":
        if (!input.text) throw new Error("Browser Agent needs text to wait for.")
        await waitForText(input.text)
        break
      case "takeScreenshot":
        screenshotDataUrl = await takeScreenshot()
        break
      case "inspectComputedStyles":
        computedStyles = await runScript<BrowserAgentComputedStyle[]>(COMPUTED_STYLES_SCRIPT)
        pushAction("Read computed styles", true, undefined, `${computedStyles.length} visible elements`)
        break
      case "inspectPageHtml":
        {
          const html = String(await runScript<string>("document.documentElement.outerHTML"))
          pageHtml = html.slice(0, 120_000)
          pageHtmlTotal = html.length
        }
        pushAction("Read page HTML", true, undefined, `${pageHtml.length} characters`)
        break
      case "readLogs":
        network = (activeTab(currentContext())?.requests ?? []).slice(-REQUESTS_KEPT)
        pushAction("Read the logs", true, undefined, `${network.length} requests`)
        break
      case "reload":
        await reload()
        break
      case "goBack":
        await goBack()
        break
      case "goForward":
        await goForward()
        break
      case "scroll":
        await scroll(input.deltaY)
        break
      case "clearLogs":
        clearLogs()
        break
      case "inspectDom":
        // With a selector or a ref, the engine is about to act on it and needs the name of what it would press.
        if (input.ref || input.selector) target = await inspectTarget(input.ref, input.selector)
        break
      default:
        break
    }
    if (SETTLING_COMMANDS.has(command) && input.settle !== false) settled = await settle(currentContext(), before)
  } catch (error) {
    commandOk = false
    commandError = error instanceof Error ? error.message : String(error)
    pushAction(input.command ?? "Browser Agent command", false, error)
  }

  const context = currentContext()
  if (context.blockedNavigationError) {
    if (commandOk) {
      commandOk = false
      commandError = context.blockedNavigationError
    }
    context.blockedNavigationError = undefined
  }
  const tab = activeTab(context)
  const contents = tab?.view.webContents
  const alive = Boolean(contents && !contents.isDestroyed())
  let dom: BrowserAgentDom = {
    title: tab?.title ?? "",
    description: "",
    textSample: "",
    links: 0,
    scripts: 0,
    stylesheets: 0,
    htmlBytes: 0,
    interactives: [],
    inputs: [],
  }
  if (alive && contents!.getURL()) {
    await drainInjectedIssues()
    try {
      dom = await inspectDom()
    } catch {
      // Mid-navigation inspection can fail; the next command retries.
    }
  }
  // Dialogs are reported once, by the report after them.
  const dialogs = tab?.dialogs ?? []
  if (tab) tab.dialogs = []
  const consoleLogs = tab?.consoleLogs ?? []
  const pageErrors = tab?.pageErrors ?? []
  const networkErrors = tab?.networkErrors ?? []

  const url = currentUrl() || input.url || ""
  return {
    url,
    finalUrl: url,
    status: commandOk ? 200 : 500,
    ok: commandOk,
    error: commandError,
    title: dom.title,
    description: dom.description,
    htmlBytes: dom.htmlBytes,
    links: dom.links,
    scripts: dom.scripts,
    stylesheets: dom.stylesheets,
    checkedAt,
    viewport: viewport(context),
    screenshotDataUrl,
    console: consoleLogs.slice(command === "readLogs" ? -CONSOLE_KEPT : -CONSOLE_REPORTED),
    pageErrors: pageErrors.slice(-30),
    networkErrors: networkErrors.slice(-30),
    domSummary: dom,
    target,
    computedStyles,
    pageHtml,
    ...(pageHtmlTotal === undefined ? {} : { pageHtmlTotal }),
    ...(page ? { page } : {}),
    ...(observed ? { observed } : {}),
    diagnostics: {
      consoleCount: consoleLogs.length,
      runtimeErrorCount: pageErrors.length,
      networkErrorCount: networkErrors.length,
      interactiveCount: dom.interactives.length,
      inputCount: dom.inputs.length,
      htmlBytes: dom.htmlBytes,
    },
    actions: context.actionTimeline.slice(0, 40),
    interactives: dom.interactives,
    inputs: dom.inputs,
    browserStatus: alive ? "running" : "stopped",
    currentPage: dom.title || url || "No page open",
    tabs: tabList(context),
    ...(alive && context.active ? { activeTab: context.active } : {}),
    ...(dialogs.length > 0 ? { dialogs } : {}),
    ...(network ? { network } : {}),
    ...(settled ? { settled } : {}),
  }
}

// The context's open tabs, as a report lists them.
function tabList(context: BrowserContext): BrowserAgentTab[] {
  return context.tabs
    .filter((tab) => !tab.view.webContents.isDestroyed())
    .map((tab) => ({
      id: tab.id,
      url: redactText(tab.view.webContents.getURL()),
      title: tab.view.webContents.getTitle() || tab.title,
      active: tab.id === context.active,
      loading: tab.view.webContents.isLoading(),
    }))
}

// A command still waiting, or still running, when its page was closed.
function closedReport(command: string): BrowserAutomationRun {
  return {
    ...stoppedReport(),
    ok: false,
    status: 409,
    error: `The browser was closed before ${command || "this command"} finished.`,
  }
}

// What the page last showed, read from what Vector already holds: a page that stopped answering is not asked again.
function timedOutReport(context: BrowserContext, command: string): BrowserAutomationRun {
  const message = `The page did not answer within ${TURN_DEADLINE_MS / 1000} seconds, so Vector stopped waiting for ${command || "this command"}. Later commands on this page run again; close the browser if the page stays stuck.`
  pushAction(`Stopped waiting for ${command || "a command"}`, false, message, undefined, context)
  const tab = activeTab(context)
  const contents = tab?.view.webContents
  const alive = Boolean(contents && !contents.isDestroyed())
  const url = alive ? contents!.getURL() : ""
  return {
    ...stoppedReport(),
    url,
    finalUrl: url,
    ok: false,
    status: 504,
    error: message,
    title: tab?.title ?? "",
    viewport: viewport(context),
    console: (tab?.consoleLogs ?? []).slice(-CONSOLE_REPORTED),
    pageErrors: (tab?.pageErrors ?? []).slice(-30),
    networkErrors: (tab?.networkErrors ?? []).slice(-30),
    actions: context.actionTimeline.slice(0, 40),
    browserStatus: alive ? "running" : "stopped",
    currentPage: tab?.title || url || "No page open",
    tabs: tabList(context),
    ...(alive && context.active ? { activeTab: context.active } : {}),
  }
}

function stoppedReport(): BrowserAutomationRun {
  return {
    url: "",
    finalUrl: "",
    status: 200,
    ok: true,
    title: "",
    description: "",
    htmlBytes: 0,
    links: 0,
    scripts: 0,
    stylesheets: 0,
    checkedAt: now(),
    viewport: { x: 0, y: 0, width: 0, height: 0 },
    screenshotDataUrl: "",
    console: [],
    pageErrors: [],
    networkErrors: [],
    actions: [],
    interactives: [],
    inputs: [],
    browserStatus: "stopped",
    currentPage: "No page open",
  }
}
