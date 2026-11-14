import { app, BrowserWindow } from "electron"
import { egressFilter, type Step } from "./egress-filter"
import {
  liveViewStep,
  liveViewTarget,
  liveViewTitle,
  liveViewWindowOptions,
  type LiveViewTarget,
} from "./hosted-client"
import { write as writeLog } from "./logging"

// The cloud computer's live view window (WP A56): Electron's half of hosted-client.ts. One window per session; asking
// again (another live view link, or control after a take-over) loads the new link in that session's window. The
// window shows only the computer's own viewer page: every request to anywhere else is cancelled before it leaves
// (liveViewStep), new windows and downloads are refused, every permission is denied, and its in-memory session is
// cleared when it closes. Under Vector Local the window's requests are the `cloud-computer` source, which is blocked.

const windows = new Map<string, BrowserWindow>()
const owned = new WeakSet<BrowserWindow>()

export function openLiveViewWindow(input: LiveViewTarget, parent?: BrowserWindow | null) {
  const target = liveViewTarget(input)
  if (!target) return
  const open = windows.get(target.session)
  if (open && !open.isDestroyed()) {
    // The open window keeps its own origin rule; a link to another computer gets its own window.
    if (URL.parse(open.webContents.getURL())?.origin === target.origin || open.webContents.getURL() === "") {
      open.setTitle(liveViewTitle(target.mode))
      void open.loadURL(target.url).catch(() => undefined)
      if (open.isMinimized()) open.restore()
      open.focus()
      return
    }
    open.close()
  }
  const owner = parent && !parent.isDestroyed() && !owned.has(parent) ? parent : undefined
  const window = new BrowserWindow({
    ...(owner ? { parent: owner } : {}),
    ...liveViewWindowOptions(target.mode, target.session, app.isPackaged),
  })
  owned.add(window)
  windows.set(target.session, window)
  const contents = window.webContents
  const view = contents.session
  const keep = (url: string) => {
    const allowed = liveViewStep(url, target.origin) === "load"
    if (!allowed) writeLog("hosted", "kept a request out of the live view window", { origin: URL.parse(url)?.origin }, "warn")
    return allowed
  }
  view.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  view.setPermissionCheckHandler(() => false)
  const unregister = egressFilter.register(view, liveViewRequests(target.origin), { kind: "cloud-computer" })
  contents.on("will-navigate", (event) => {
    if (!keep(event.url)) event.preventDefault()
  })
  contents.on("will-redirect", (event) => {
    if (!keep(event.url)) event.preventDefault()
  })
  contents.on("will-frame-navigate", (event) => {
    if (!keep(event.url)) event.preventDefault()
  })
  contents.setWindowOpenHandler(() => ({ action: "deny" }))
  view.on("will-download", (event) => event.preventDefault())
  // The window's title stays Vector's, so it always says whose computer this is.
  contents.on("page-title-updated", (event) => event.preventDefault())
  const show = () => {
    if (!window.isDestroyed() && !window.isVisible()) window.show()
  }
  window.once("ready-to-show", show)
  setTimeout(show, 3_000)
  window.once("closed", () => {
    unregister()
    if (windows.get(target.session) === window) windows.delete(target.session)
    void view.clearStorageData().catch(() => undefined)
  })
  void window.loadURL(target.url).catch(() => undefined)
}

/** The window's step on its session's requests: the viewer's own origin only (its page, script and socket). */
export function liveViewRequests(origin: string): Step {
  return (details, callback) => callback(liveViewStep(details.url, origin) === "load" ? {} : { cancel: true })
}
