import { contextBridge, ipcRenderer } from "electron"
import type { BannerButton, OverlayApi, OverlayMessage } from "@vectordevai/app/computer/overlay-page"

const actions = [
  "stop",
  "takeover",
  "resume",
  "allow",
  "deny",
  "continue",
  "hand-over",
  "not-now",
  "keep-going",
] as const
const action = (value: unknown): value is Parameters<OverlayApi["act"]>[0] =>
  typeof value === "string" && actions.some((item) => item === value)
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const text = (value: unknown, max: number, min = 0): value is string =>
  typeof value === "string" && value.length >= min && value.length <= max

function button(value: unknown): BannerButton | undefined {
  if (!record(value) || !action(value.action) || !text(value.label, 256)) return
  if (value.requestID !== undefined && !text(value.requestID, 128, 1)) return
  if ([value.arm, value.clickOnly, value.primary].some((flag) => flag !== undefined && typeof flag !== "boolean"))
    return
  return {
    action: value.action,
    label: value.label,
    ...(typeof value.requestID === "string" ? { requestID: value.requestID } : {}),
    ...(typeof value.arm === "boolean" ? { arm: value.arm } : {}),
    ...(typeof value.clickOnly === "boolean" ? { clickOnly: value.clickOnly } : {}),
    ...(typeof value.primary === "boolean" ? { primary: value.primary } : {}),
  }
}

/** Project view fields only: a main-process state object or an IPC event never reaches the isolated page. */
function message(value: unknown): OverlayMessage | undefined {
  if (!record(value)) return
  if (value.type === "fade") return { type: "fade" }
  if (typeof value.reduceMotion !== "boolean") return
  if (
    value.type === "glow" &&
    (value.variant === "working" || value.variant === "background" || value.variant === "dim") &&
    typeof value.end === "boolean"
  )
    return { type: "glow", variant: value.variant, end: value.end, reduceMotion: value.reduceMotion }
  if (
    value.type === "cursor" &&
    (value.kind === "ring" || value.kind === "ghost" || value.kind === "hide") &&
    typeof value.x === "number" &&
    Number.isFinite(value.x) &&
    typeof value.y === "number" &&
    Number.isFinite(value.y)
  )
    return { type: "cursor", kind: value.kind, x: value.x, y: value.y, reduceMotion: value.reduceMotion }
  if (
    value.type !== "banner" ||
    (value.tone !== "working" && value.tone !== "ask" && value.tone !== "paused" && value.tone !== "end") ||
    !text(value.line, 4096) ||
    !text(value.key, 512) ||
    !text(value.waiting, 1024) ||
    !Array.isArray(value.buttons) ||
    value.buttons.length > 8
  )
    return
  const buttons = value.buttons.map(button)
  if (buttons.some((item) => item === undefined)) return
  return {
    type: "banner",
    tone: value.tone,
    line: value.line,
    key: value.key,
    waiting: value.waiting,
    buttons: buttons.filter((item): item is BannerButton => item !== undefined),
    reduceMotion: value.reduceMotion,
  }
}

const api: OverlayApi = {
  onState(callback) {
    if (typeof callback !== "function") return () => {}
    const handler = (_event: unknown, value: unknown) => {
      const view = message(value)
      if (view) callback(view)
    }
    ipcRenderer.on("computer-overlay-state", handler)
    return () => ipcRenderer.removeListener("computer-overlay-state", handler)
  },
  async act(value, requestID) {
    if (!action(value) || (requestID !== undefined && !text(requestID, 128, 1))) return false
    return ipcRenderer.invoke("computer-overlay-act", value, requestID).then(
      (accepted) => accepted === true,
      () => false,
    )
  },
  hover(on) {
    if (typeof on === "boolean") ipcRenderer.send("computer-overlay-hover", on)
  },
}

contextBridge.exposeInMainWorld("computerOverlay", api)
