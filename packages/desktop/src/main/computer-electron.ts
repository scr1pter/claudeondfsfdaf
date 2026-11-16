import { release } from "node:os"
import {
  app,
  BrowserWindow,
  clipboard,
  globalShortcut,
  Notification,
  powerMonitor,
  powerSaveBlocker,
  screen,
  shell,
  systemPreferences,
} from "electron"
import { base64Encode } from "@vectordevai/core/util/encode"
import { CHANNEL } from "./constants"
import { decodeComputerHelperPins } from "../shared/computer-helper-pins"
import { isComputerOverlay, nativeId } from "./computer-overlay"
import { openComputerSettings } from "./computer-settings"
import type { ComputerStartupDeps } from "./computer-startup"
import { getStore } from "./store"
import { updateTray } from "./tray"
import { getMainWindow, isTrustedRendererUrl, restoreMainWindows } from "./windows"

// Electron drops a notification's click handler when the object is collected, so shown ones are held until closed.
const notifications = new Set<Notification>()

/** Electron and OS facts for Hands, read after app readiness (globalShortcut, screen and safeStorage need it). */
export function electronComputerDeps(input: {
  warn(message: string, ...fields: unknown[]): void
}): ComputerStartupDeps {
  return {
    platform: process.platform,
    release: release(),
    channel: CHANNEL,
    packaged: app.isPackaged,
    devRoot: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    userData: app.getPath("userData"),
    env: process.env,
    hashes:
      typeof VECTOR_COMPUTER_HELPER_SHA256 === "undefined"
        ? undefined
        : decodeComputerHelperPins(VECTOR_COMPUTER_HELPER_SHA256),
    openSettings: (policy) => openComputerSettings(policy),
    promptStore: getStore(),
    systemPreferences: {
      getMediaAccessStatus: (type) => systemPreferences.getMediaAccessStatus(type),
      isTrustedAccessibilityClient: (prompt) => systemPreferences.isTrustedAccessibilityClient(prompt),
    },
    openExternal: (url) => shell.openExternal(url),
    clipboard: { readText: () => clipboard.readText(), writeText: (text) => clipboard.writeText(text) },
    shortcuts: {
      register: (accelerator, callback) => globalShortcut.register(accelerator, callback),
      isRegistered: (accelerator) => globalShortcut.isRegistered(accelerator),
      unregister: (accelerator) => globalShortcut.unregister(accelerator),
    },
    // Windows helpers report physical pixels; Electron converts per monitor, negative virtual-screen origins included.
    toDip: (rect) => {
      if (rect.w === 0 && rect.h === 0) {
        const point = screen.screenToDipPoint({ x: rect.x, y: rect.y })
        return { x: point.x, y: point.y, w: 0, h: 0 }
      }
      const dip = screen.screenToDipRect(null, { x: rect.x, y: rect.y, width: rect.w, height: rect.h })
      return { x: dip.x, y: dip.y, w: dip.width, h: dip.height }
    },
    // Hands' own blocker keeps the display on while it works (D18); ordinary engine work only blocks app suspension.
    displayBlocker: {
      start: () => powerSaveBlocker.start("prevent-display-sleep"),
      stop: (id) => powerSaveBlocker.stop(id),
    },
    power: {
      on: (event, callback) => powerMonitor.on(event as "lock-screen", callback),
      removeListener: (event, callback) => powerMonitor.removeListener(event as "lock-screen", callback),
    },
    exclusions: () => ({
      vectorPids: [
        ...new Set([
          process.pid,
          ...app.getAppMetrics().map((metric) => metric.pid),
          ...BrowserWindow.getAllWindows()
            .filter((window) => !window.isDestroyed() && !window.webContents.isDestroyed())
            .map((window) => window.webContents.getOSProcessId()),
        ]),
      ].filter((pid) => Number.isSafeInteger(pid) && pid > 0),
      vectorWindowIds: BrowserWindow.getAllWindows()
        .filter((window) => !window.isDestroyed() && !isComputerOverlay(window))
        .map((window) => nativeId(window, process.platform)),
    }),
    windows: () => BrowserWindow.getAllWindows(),
    trustedUrl: isTrustedRendererUrl,
    notification: (message, onClick) => {
      if (!Notification.isSupported()) return
      const notification = new Notification({ title: message.title, body: message.body })
      notifications.add(notification)
      notification.on("click", () => {
        notifications.delete(notification)
        onClick()
      })
      notification.on("close", () => notifications.delete(notification))
      notification.show()
    },
    focused: () => {
      const focused = BrowserWindow.getFocusedWindow()
      return (
        !!focused &&
        !focused.isDestroyed() &&
        !isComputerOverlay(focused) &&
        !focused.webContents.isDestroyed() &&
        isTrustedRendererUrl(focused.webContents.getURL()) &&
        isTrustedRendererUrl(focused.webContents.mainFrame.url)
      )
    },
    open: (target) => {
      const win = getMainWindow() ?? restoreMainWindows()[0]
      if (!win) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      win.webContents.send(
        "computer-open-session",
        `/${base64Encode(target.directory)}/session/${encodeURIComponent(target.sessionID)}`,
      )
    },
    front: () => {
      const win = getMainWindow()
      if (!win) return
      if (process.platform === "darwin") app.focus({ steal: true })
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    },
    trayChanged: () => void updateTray(),
    warn: (message, ...fields) => input.warn(message, ...fields),
  }
}
