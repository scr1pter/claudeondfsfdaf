import { PermissionPolicy } from "@vectordevai/schema/permission-policy"

export const canAutoAcceptPermission = PermissionPolicy.canAutoApprove
export const canAlwaysAllowPermission = PermissionPolicy.canAlwaysApprove

export function computerPermissionDetails(input: {
  permission: string
  patterns: readonly string[]
  metadata: Record<string, unknown>
}): { action: string; target: string | undefined; proposedText: string | undefined } | undefined {
  if (!input.permission.startsWith("computer_")) return
  const action = typeof input.metadata.action === "string" ? input.metadata.action : ""
  return {
    action: computerActionLabel(action, input.metadata, input.permission),
    target: computerTargetLabel(input.metadata),
    proposedText: action === "type" && typeof input.metadata.text === "string" ? input.metadata.text : undefined,
  }
}

function computerActionLabel(action: string, metadata: Record<string, unknown>, permission: string) {
  const point = coordinate(metadata.x, metadata.y)
  if (action === "list_targets") return "View the list of open app windows"
  if (action === "select_target") return "Select and view this app window"
  if (action === "observe") return "Capture a fresh screenshot"
  if (action === "use_app") return "Use this app"
  if (action === "run_program") return "Run a program"
  if (action === "paste") return "Paste in the selected app"
  if (action === "click") return point ? `Click once at ${point}` : "Click once in the selected app"
  if (action === "double_click") return point ? `Double-click at ${point}` : "Double-click in the selected app"
  if (action === "scroll") return "Scroll in the selected app"
  if (action === "drag") return "Drag the pointer in the selected app"
  if (action === "type") {
    const length = typeof metadata.text === "string" ? Array.from(metadata.text).length : undefined
    return length === undefined ? "Type text in the selected app" : `Type ${length} character${length === 1 ? "" : "s"}`
  }
  if (action === "press") {
    const key = safeLabel(metadata.key, 48)
    return key ? `Press ${key}` : "Press a key in the selected app"
  }
  if (permission === "computer_observe") return "View the selected app"
  if (permission === "computer_interact") return "Use the pointer in the selected app"
  return "Use the keyboard in the selected app"
}

function computerTargetLabel(metadata: Record<string, unknown>) {
  const target = record(metadata.target)
  const app = safeLabel(target?.appName, 100) || safeLabel(metadata.appName, 100) || safeLabel(metadata.targetApp, 100)
  const title =
    safeLabel(target?.name, 160) ||
    safeLabel(target?.title, 160) ||
    safeLabel(metadata.targetName, 160) ||
    safeLabel(metadata.targetTitle, 160) ||
    safeLabel(metadata.windowTitle, 160)
  if (app && title && app !== title) return `${app} · ${title}`
  if (title || app) return title || app
}

export function coordinate(x: unknown, y: unknown): string | undefined {
  if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) return
  return `${Math.round(x)}, ${Math.round(y)}`
}

export function safeLabel(value: unknown, limit: number) {
  if (typeof value !== "string") return ""
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, "")
    .trim()
    .slice(0, Math.max(0, limit))
    .replace(/[\ud800-\udbff]$/, "")
}

export function quotedLabel(value: unknown) {
  return `“${safeLabel(value, 40)}”`
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return Object.fromEntries(Object.entries(value))
}
