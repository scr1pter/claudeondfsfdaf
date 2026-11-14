import { Menu, Notification, Tray, nativeImage, type MenuItemConstructorOptions } from "electron"

import { backgroundModeStatus, type BackgroundWorkState } from "./background-mode"
import { write } from "./logging"
import type { ScheduledAgentRecord } from "./scheduled-agents"

// The menubar needs a monochrome mark, and every icon shipped in resources/ is
// the full-colour app artwork — setting that as a template image collapses it
// into a black square. This is the Vector chip drawn as pure alpha instead, at
// 1x and 2x so Retina menubars stay crisp.
const ICON_1X =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAhElEQVR42mNgoBEIBWJlJL4yVIwoIArEO4C4EIi1obgQKiZKSHMWEP8A4v848A+oGpw2gxRshDoXG94IVSOKzc87oLaEEgib/1C1KOqUof5ENmAOEF+F4jloBhSiBTIYaKMZcBXJ71fRDNDG5jyKDKDYCxQHIsXRSJWERJWkTJXMRBIAADGiSClGfTJJAAAAAElFTkSuQmCC"
const ICON_2X =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA4klEQVR42u1Xuw3EIAxNxwS3DxOko8tMdHRM4EFYJBNkghzFK1Dkcw4OBNFh6RVRnOeX+IOzLNMeZGvEGeEEHweftYUAA3ISfAg+pmZgFaEjLMgDAnAI8LF4Rv0afIs4QFqCAxzFwc9K2Eo+e/rmO/Kbg/3yJbLSoS/BVWHtpCL0t61mkoK7q/o7o4THgltsUS5/tQSkEAcJJe3ECXhFeCbnHvc+CQi4djlDhxPghWr3ggBTMvU4ASQIoCngLwQ0LcLubdh9EHUfxd0Po2GO4+4LyRAr2RBL6RBr+TA/JtOa2BuO3iCEtNyrkAAAAABJRU5ErkJggg=="
// "next in 14m" would otherwise go stale for as long as the app stays resident.
const REFRESH_INTERVAL_MS = 30_000

export type TrayDeps = {
  // Read live rather than pushed, so a menu opened at any moment is accurate.
  readState: () => BackgroundWorkState & { pausedTasks: number }
  openVector: () => void
  runNext: () => void
  setAllPaused: (paused: boolean) => void
  quit: () => void
  /** Vector Remote (WP A41): the phones paired with this computer, and "Disconnect all phones". */
  remote?: {
    read: () => { phones: number; connected: number; watching: boolean }
    disconnectAll: () => void
  }
}

let tray: Tray | undefined
let deps: TrayDeps | undefined
let refreshTimer: NodeJS.Timeout | undefined

export function createTray(next: TrayDeps) {
  if (tray) return true
  deps = next

  const icon = nativeImage.createEmpty()
  icon.addRepresentation({ scaleFactor: 1, dataURL: `data:image/png;base64,${ICON_1X}` })
  icon.addRepresentation({ scaleFactor: 2, dataURL: `data:image/png;base64,${ICON_2X}` })
  // A template image is what lets macOS invert the mark for light and dark
  // menubars; elsewhere the flag is ignored.
  icon.setTemplateImage(true)

  // Linux desktops without a StatusNotifier host reject the tray outright, and
  // Electron surfaces that as a throw from the constructor. Vector must still
  // run there, just without a tray presence — deps stay bound so notifications
  // can still route their click back to a window.
  try {
    tray = new Tray(icon)
  } catch (error) {
    write("utility", "tray unavailable on this platform", { error: String(error) }, "warn")
    return false
  }

  // Electron binds this one only on macOS (electron.d.ts marks it
  // `@platform darwin`); calling it on Windows or Linux is a TypeError that the
  // constructor's catch above is already past, so it would take down startup on
  // exactly the platforms this function claims to survive.
  if (process.platform === "darwin") tray.setIgnoreDoubleClickEvents(true)
  tray.on("click", () => next.openVector())
  void updateTray()

  refreshTimer = setInterval(() => void updateTray(), REFRESH_INTERVAL_MS)
  refreshTimer.unref()
  return true
}

export async function updateTray() {
  if (!tray || !deps) return
  const state = deps.readState()
  const status = await backgroundModeStatus(state)
  // The menu can be torn down while the preference is being read.
  if (!tray || !deps) return
  const paused = state.armedTasks === 0 && state.pausedTasks > 0
  const remote = deps.remote?.read()

  tray.setToolTip(`Vector — ${status.reason}`)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: status.reason, enabled: false },
      { type: "separator" },
      { label: "Open Vector", click: () => deps?.openVector() },
      { label: "Run scheduled task now", enabled: state.armedTasks > 0, click: () => deps?.runNext() },
      {
        label: paused ? "Resume all scheduled tasks" : "Pause all scheduled tasks",
        enabled: state.armedTasks + state.pausedTasks > 0,
        click: () => deps?.setAllPaused(!paused),
      },
      ...remoteItems(remote, () => deps?.remote?.disconnectAll()),
      { type: "separator" },
      { label: "Quit Vector completely", click: () => deps?.quit() },
    ]),
  )
}

/** The tray's Remote lines, shown once a phone is paired: what is connected, and the way to cut every phone off. */
export function remoteItems(
  remote: { phones: number; connected: number; watching: boolean } | undefined,
  disconnectAll: () => void,
): MenuItemConstructorOptions[] {
  if (!remote || remote.phones === 0) return []
  const paired = `${remote.phones} ${remote.phones === 1 ? "phone" : "phones"} paired`
  const label = remote.watching
    ? `Remote: ${paired}, a phone is watching`
    : remote.connected > 0
      ? `Remote: ${paired}, ${remote.connected} connected`
      : `Remote: ${paired}`
  return [{ type: "separator" }, { label, enabled: false }, { label: "Disconnect all phones", click: disconnectAll }]
}

export function destroyTray() {
  if (refreshTimer) clearInterval(refreshTimer)
  refreshTimer = undefined
  tray?.destroy()
  tray = undefined
  deps = undefined
}

export function notifyScheduledRunFinished(run: Pick<ScheduledAgentRecord, "title" | "error">) {
  // Notification support is absent on some Linux sessions and revoked whenever
  // the user denies it on macOS; either way this is a courtesy, never a step
  // the scheduler depends on.
  if (!Notification.isSupported()) return
  const name = run.title?.trim() || "Scheduled task"
  // A recurring run that succeeded is already back at "scheduled" by the time
  // it settles, so the error field is the only reliable outcome signal.
  const notification = new Notification({
    title: run.error ? `${name} failed` : `${name} finished`,
    body: run.error?.slice(0, 200) || "Open Vector to read the transcript.",
  })
  notification.on("click", () => deps?.openVector())
  notification.show()
}
