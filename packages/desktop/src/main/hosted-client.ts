import {
  downloadLinkAllowed,
  hostedRoute,
  pullRequestLinkAllowed,
  recordingLinkAllowed,
  viewerLinkAllowed,
  viewerOrigin,
} from "@vectordevai/app/hosted"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { EgressGuard } from "@vectordevai/core/local-mode/guard"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import type { BrowserWindowConstructorOptions } from "electron"

// The cloud computer on the desktop (WP A56): the composer's "Run on my cloud computer", the bar that says "Vector is
// using its cloud computer", and the live view. The renderer asks the main process, which holds the account token, and
// the main process asks vectordev.ai. The token never reaches the renderer. Four things only:
//
// - `request`: one of the requests the screens may make (packages/app/src/features/cloud/hosted/hosted-requests.ts),
//   checked by shape here, including the estimate that gives the pre-start ceiling; vectordev.ai checks everything
//   again and decides from the plan (S1).
// - `liveView`: asks vectordev.ai for a live view link (a single-use, five-minute viewer token in the URL fragment) and
//   opens it in the live view window: a sandboxed window with no preload and its own in-memory session that may only
//   show the computer's own viewer page (`liveViewWindowOptions`, `liveViewStep`; Electron wiring in hosted-window.ts).
// - `files`: asks for a session's files and, once they are packed, opens vectordev.ai's 24-hour download link in the
//   browser.
// - `open`: a job's pull request (Approve: the person merges it themselves, S9) or one of its recording's signed links,
//   in the browser, each checked by its shape first.
//
// Requests are Vector Local's `cloud-computer` source (blocked under Vector Local), and so is the live view window.

export type HostedResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status?: number; code?: string; message: string }
export type HostedActionResult = { ok: true; ready?: boolean } | { ok: false; status?: number; code?: string; message: string }

export type LiveViewTarget = { url: string; origin: string; mode: "view" | "control"; session: string }

type Dependencies = {
  token(): Promise<string | undefined>
  /** The network, through Vector Local's guard for `cloud-computer`. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>
  /** Opens (or replaces) the live view window for a session. */
  openLiveView(target: LiveViewTarget): void | Promise<void>
  /** Opens a link in the person's browser. */
  openExternal(url: string): void | Promise<void>
  site?: string
}

const ANSWER_BYTES = 512 * 1024
const UNREACHABLE = "Vector could not reach vectordev.ai. Check your connection and try again."
const LOCAL_OFF = "Vector Local keeps the cloud computer off on this computer. Allow it in Settings → Vector Local."

function apiError(payload: unknown) {
  const error = payload && typeof payload === "object" && "error" in payload ? payload.error : undefined
  if (!error || typeof error !== "object") return undefined
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined
  const message =
    "message" in error && typeof error.message === "string" && error.message.trim()
      ? error.message.trim().slice(0, 300)
      : undefined
  return { code, message }
}

export function createHostedClient(deps: Dependencies) {
  const site = deps.site ?? ModelPlanStatus.SITE
  const send = (url: string, init: RequestInit) =>
    Egress.fetch(
      "cloud-computer",
      url,
      init,
      deps.fetch ? (target, options) => deps.fetch!(String(target), options ?? {}) : undefined,
    )

  async function request(input: unknown): Promise<HostedResult> {
    const route = hostedRoute(input)
    if (!route) return { ok: false, message: "Vector could not send that to the cloud computer." }
    const secret = await deps.token().catch(() => undefined)
    if (!secret)
      return { ok: false, status: 401, code: "SIGN_IN", message: "Sign in to Vector to use your cloud computer." }
    const response = await send(`${site}${route.path}`, {
      method: route.method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${secret}`,
        ...(route.body ? { "content-type": "application/json" } : {}),
      },
      ...(route.body ? { body: JSON.stringify(route.body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    }).catch((cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))))
    if (response instanceof EgressGuard.EgressBlocked) return { ok: false, code: "LOCAL_OFF", message: LOCAL_OFF }
    if (response instanceof Error) return { ok: false, message: UNREACHABLE }
    const text = await response.text().catch(() => "")
    let payload: unknown
    try {
      payload = text && text.length <= ANSWER_BYTES ? JSON.parse(text) : undefined
    } catch {
      payload = undefined
    }
    if (!response.ok) {
      const error = apiError(payload)
      return {
        ok: false,
        status: response.status,
        ...(error?.code ? { code: error.code } : {}),
        message: error?.message ?? "The cloud computer did not answer. Try again shortly.",
      }
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      return { ok: false, message: "Vector could not read the cloud computer's answer. Try again shortly." }
    return { ok: true, body: payload as Record<string, unknown> }
  }

  async function liveView(input: unknown): Promise<HostedActionResult> {
    const value = input && typeof input === "object" ? (input as Record<string, unknown>) : {}
    const mode = value.mode === "control" ? "control" : "view"
    const answer = await request({ kind: "viewer", id: value.id, mode })
    if (!answer.ok) return answer
    const url = answer.body.url
    const origin = typeof url === "string" ? viewerOrigin(url) : undefined
    if (typeof url !== "string" || !origin || typeof value.id !== "string")
      return { ok: false, message: "Vector could not open this live view." }
    await deps.openLiveView({ url, origin, mode, session: value.id })
    return { ok: true }
  }

  async function files(input: unknown): Promise<HostedActionResult> {
    const value = input && typeof input === "object" ? (input as Record<string, unknown>) : {}
    const answer = await request({ kind: "download", id: value.id })
    if (!answer.ok) return answer
    if (answer.body.ready === false) return { ok: true, ready: false }
    if (answer.body.ready !== true || !downloadLinkAllowed(answer.body.url, site))
      return { ok: false, message: "Vector could not open this download." }
    await deps.openExternal(answer.body.url as string)
    return { ok: true, ready: true }
  }

  async function open(input: unknown): Promise<HostedActionResult> {
    const value = input && typeof input === "object" ? (input as Record<string, unknown>) : {}
    const allowed =
      value.kind === "pull-request"
        ? pullRequestLinkAllowed(value.url)
        : value.kind === "recording"
          ? recordingLinkAllowed(value.url)
          : false
    if (!allowed) return { ok: false, message: "Vector does not open that link." }
    await deps.openExternal(value.url as string)
    return { ok: true }
  }

  return { request, liveView, files, open }
}

// ── The live view window ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * In memory only (no "persist:" prefix), one per session so each window's origin rule stays its own, and cleared
 * when the window closes.
 */
export const LIVE_VIEW_PARTITION = "vector-live-view"

export function liveViewPartition(session: string) {
  return `${LIVE_VIEW_PARTITION}-${session.replace(/[^a-z0-9_]/g, "")}`
}

/** The window's title: the purple-edged page inside says the same. */
export function liveViewTitle(mode: "view" | "control") {
  return mode === "control" ? "You have control of the cloud computer" : "Vector is using its cloud computer"
}

/**
 * The live view window's settings. It has no preload, so the computer's page can never reach Vector's IPC; it is
 * sandboxed with context isolation; and it has its own session, so the main window's handlers do not apply to it and
 * nothing it stores reaches the app. Its background is the cloud computer's purple, the edge the page draws too.
 */
export function liveViewWindowOptions(mode: "view" | "control", session: string, packaged = true) {
  return {
    width: 1320,
    height: 900,
    minWidth: 480,
    minHeight: 360,
    show: false,
    title: liveViewTitle(mode),
    autoHideMenuBar: true,
    backgroundColor: "#7c3aed",
    webPreferences: {
      partition: liveViewPartition(session),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
      devTools: !packaged,
    },
  } satisfies BrowserWindowConstructorOptions
}

/**
 * What the live view window does with a request: it shows the computer's own viewer page and talks to its socket, all
 * on one origin, and nothing else. Any other address, a frame or a page anywhere else, is cancelled; nothing opens in
 * the browser either, because a viewer page has no reason to send the person anywhere.
 */
export function liveViewStep(url: string, origin: string) {
  const parsed = URL.parse(url)
  if (!parsed || parsed.username || parsed.password) return "cancel" as const
  const web =
    parsed.protocol === "wss:" ? `https://${parsed.host}` : parsed.protocol === "https:" ? parsed.origin : undefined
  return web === origin ? ("load" as const) : ("cancel" as const)
}

/** The first load: only a live view link (checked again here, since the window takes nothing else). */
export function liveViewTarget(target: LiveViewTarget) {
  return viewerLinkAllowed(target.url) && viewerOrigin(target.url) === target.origin ? target : undefined
}
