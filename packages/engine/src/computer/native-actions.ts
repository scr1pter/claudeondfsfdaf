import { Option, Schema } from "effect"
import { Computer } from "@vectordevai/schema/computer"

export type Platform = "darwin" | "win32"
export type Scroll = { readonly index: number; readonly dx: number; readonly dy: number }

const FIELDS = new Set(Object.keys(Computer.ToolStep.fields))
const ALIASES: Readonly<Record<string, string>> = {
  control: "ctrl",
  control_l: "ctrl",
  control_r: "ctrl",
  ctrl: "ctrl",
  shift: "shift",
  shift_l: "shift",
  shift_r: "shift",
  alt: "alt",
  alt_l: "alt",
  alt_r: "alt",
  option: "alt",
  altgr: "altgr",
  iso_level3_shift: "altgr",
  return: "enter",
  kp_enter: "enter",
  enter: "enter",
  esc: "escape",
  escape: "escape",
  backspace: "backspace",
  delete: "delete",
  del: "delete",
  insert: "insert",
  tab: "tab",
  space: "space",
  spacebar: "space",
  left: "arrowleft",
  right: "arrowright",
  up: "arrowup",
  down: "arrowdown",
  arrowleft: "arrowleft",
  arrowright: "arrowright",
  arrowup: "arrowup",
  arrowdown: "arrowdown",
  page_up: "pageup",
  page_down: "pagedown",
  pgup: "pageup",
  pgdn: "pagedown",
  prior: "pageup",
  next: "pagedown",
  pageup: "pageup",
  pagedown: "pagedown",
  home: "home",
  end: "end",
  minus: "-",
  equal: "=",
  comma: ",",
  period: ".",
  slash: "/",
  backslash: "\\",
  semicolon: ";",
  apostrophe: "'",
  quotedbl: '"',
  grave: "`",
  bracketleft: "[",
  bracketright: "]",
  plus: "+",
  print: "printscreen",
  printscreen: "printscreen",
  caps_lock: "capslock",
  num_lock: "numlock",
  scroll_lock: "scrolllock",
  pause: "pause",
  menu: "contextmenu",
  super: "meta",
  meta: "meta",
  super_l: "meta",
  super_r: "meta",
  meta_l: "meta",
  meta_r: "meta",
  cmd: "meta",
  command: "meta",
  win: "meta",
  windows: "meta",
}

/** Native input is only a spelling adapter. The ordinary tool still owns app, frame and consent checks. */
export function input(value: unknown, platform: Platform): Computer.ToolInput {
  return normalize(value, platform)
}

/** Exact pixel deltas travel separately as trusted runtime context, never as model-granted tool fields. */
export function scrolls(value: unknown): readonly Scroll[] {
  normalize(value)
  if (!record(value) || !Array.isArray(value.actions)) return []
  return value.actions.flatMap((action, index) => {
    const scroll = record(action) ? pixels(action) : undefined
    return scroll ? [{ index, dx: scroll.dx, dy: scroll.dy }] : []
  })
}

function normalize(value: unknown, platform?: Platform): Computer.ToolInput {
  if (!record(value)) return invalid()
  if (typeof value.member === "string") {
    if ("actions" in value) return invalid()
    return member(value, platform)
  }
  if (Object.keys(value).some((key) => key !== "actions" && key !== "safety_checks")) return invalid()
  if (!Array.isArray(value.actions) || value.actions.length < 1 || value.actions.length > Computer.LIMITS.batchSteps)
    return invalid()
  const actions = value.actions.map((action) => generic(action, platform))
  return { action: actions[0].action, actions }
}

function generic(value: unknown, platform?: Platform): Computer.ToolStep {
  if (!record(value)) return invalid()
  const scroll = pixels(value)
  if (scroll) return { action: "scroll", x: scroll.x, y: scroll.y }
  if (Object.keys(value).some((key) => !FIELDS.has(key))) return invalid()
  const decoded = Schema.decodeUnknownOption(Computer.ToolStep)({
    ...value,
    ...(value.keys === undefined ? {} : { keys: keys(value.keys, platform) }),
    ...(value.modifiers === undefined ? {} : { modifiers: keys(value.modifiers, platform) }),
  })
  if (Option.isNone(decoded)) return invalid()
  return decoded.value
}

function member(value: Record<string, unknown>, platform?: Platform): Computer.ToolInput {
  const name = value.member
  const allowed = (fields: readonly string[]) => {
    if (Object.keys(value).some((key) => key !== "member" && !fields.includes(key))) invalid()
  }
  const finish = (action: unknown) => generic(action, platform)
  switch (name) {
    case "screenshot":
    case "cursor_position":
      allowed([])
      return finish({ action: name })
    case "zoom": {
      allowed(["region"])
      const region =
        Array.isArray(value.region) && value.region.length === 4
          ? { x0: value.region[0], y0: value.region[1], x1: value.region[2], y1: value.region[3] }
          : value.region
      if (!region) return invalid()
      // Zoom coordinates always refer to the last full frame; no crop origin is applied here.
      return finish({ action: "zoom", region })
    }
    case "click":
    case "left_click":
    case "right_click":
    case "middle_click":
    case "double_click":
    case "triple_click":
    case "mouse_move": {
      allowed(["coordinate", "x", "y", "ref", "button", "modifiers"])
      if (value.button !== undefined && name !== "click") return invalid()
      const action =
        name === "click"
          ? value.button === undefined || value.button === "left"
            ? "click"
            : value.button === "right"
              ? "right_click"
              : value.button === "middle"
                ? "middle_click"
                : invalid()
          : name === "left_click"
            ? "click"
            : name
      const target = value.ref === undefined ? point(value) : { ref: value.ref }
      if (value.ref !== undefined && (value.coordinate !== undefined || value.x !== undefined || value.y !== undefined))
        return invalid()
      if (name === "mouse_move" && (value.ref !== undefined || value.modifiers !== undefined)) return invalid()
      return finish({ action, ...target, ...(value.modifiers === undefined ? {} : { modifiers: value.modifiers }) })
    }
    case "drag":
    case "left_click_drag": {
      allowed(["path", "start_coordinate", "coordinate", "modifiers"])
      if (value.path !== undefined && (value.start_coordinate !== undefined || value.coordinate !== undefined))
        return invalid()
      if (
        Array.isArray(value.path) &&
        (value.path.length < Computer.LIMITS.dragPointsMin || value.path.length > Computer.LIMITS.dragPointsMax)
      )
        return invalid()
      const path = Array.isArray(value.path)
        ? value.path.map((item) => tuple(item))
        : value.start_coordinate !== undefined && value.coordinate !== undefined
          ? [tuple(value.start_coordinate), tuple(value.coordinate)]
          : invalid()
      return finish({ action: "drag", path, ...(value.modifiers === undefined ? {} : { modifiers: value.modifiers }) })
    }
    case "mouse_down":
    case "mouse_up":
    case "left_mouse_down":
    case "left_mouse_up":
      allowed(["button"])
      if (value.button !== undefined && value.button !== "left") return invalid()
      return finish({ action: name.endsWith("down") ? "mouse_down" : "mouse_up" })
    case "type":
      allowed(["text"])
      if (typeof value.text !== "string" || !value.text.length) return invalid()
      return finish({ action: "type", text: value.text })
    case "key":
    case "hold_key": {
      allowed(["text", "keys", "key", "duration", "seconds", "repeat"])
      const choices = [value.text, value.keys, value.key].filter((item) => item !== undefined)
      if (choices.length !== 1 || (value.duration !== undefined && value.seconds !== undefined)) return invalid()
      if (name === "key" && (value.duration !== undefined || value.seconds !== undefined)) return invalid()
      return finish({
        action: name,
        keys: keys(choices[0], platform),
        ...(value.repeat === undefined ? {} : { repeat: value.repeat }),
        ...(value.duration === undefined && value.seconds === undefined
          ? {}
          : { seconds: value.duration ?? value.seconds }),
      })
    }
    case "scroll": {
      allowed(["coordinate", "x", "y", "direction", "scroll_direction", "amount", "scroll_amount", "modifiers"])
      if (
        (value.direction !== undefined && value.scroll_direction !== undefined) ||
        (value.amount !== undefined && value.scroll_amount !== undefined)
      )
        return invalid()
      if (value.modifiers !== undefined) return invalid()
      const at = value.coordinate !== undefined || value.x !== undefined || value.y !== undefined ? point(value) : {}
      return finish({
        action: "scroll",
        ...at,
        direction: value.direction ?? value.scroll_direction,
        amount: value.amount ?? value.scroll_amount,
      })
    }
    case "wait":
      allowed(["duration", "seconds"])
      if (value.duration !== undefined && value.seconds !== undefined) return invalid()
      return finish({ action: "wait", seconds: value.duration ?? value.seconds ?? 1 })
    default:
      return invalid()
  }
}

function point(value: Record<string, unknown>) {
  if (value.coordinate !== undefined) {
    if (value.x !== undefined || value.y !== undefined) return invalid()
    return tuple(value.coordinate)
  }
  if (!Number.isSafeInteger(value.x) || !Number.isSafeInteger(value.y)) return invalid()
  return { x: value.x as number, y: value.y as number }
}

function tuple(value: unknown): Computer.Point {
  if (record(value)) {
    if (Object.keys(value).some((key) => key !== "x" && key !== "y")) return invalid()
    return point(value)
  }
  if (!Array.isArray(value) || value.length !== 2 || !value.every(Number.isSafeInteger)) return invalid()
  return { x: value[0], y: value[1] }
}

function pixels(value: Record<string, unknown>) {
  if (!("scroll_x" in value) && !("scroll_y" in value)) return undefined
  if (
    value.action !== "scroll" ||
    Object.keys(value).some((key) => !["action", "x", "y", "scroll_x", "scroll_y"].includes(key))
  )
    return invalid()
  if (
    !Number.isSafeInteger(value.x) ||
    !Number.isSafeInteger(value.y) ||
    typeof value.scroll_x !== "number" ||
    !Number.isSafeInteger(value.scroll_x) ||
    Math.abs(value.scroll_x) > 10_000 ||
    typeof value.scroll_y !== "number" ||
    !Number.isSafeInteger(value.scroll_y) ||
    Math.abs(value.scroll_y) > 10_000 ||
    (value.scroll_x === 0 && value.scroll_y === 0)
  )
    return invalid()
  return { x: value.x as number, y: value.y as number, dx: value.scroll_x, dy: value.scroll_y }
}

function keys(value: unknown, platform?: Platform): string {
  const parts = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value === "+"
        ? [value]
        : value.split("+")
      : invalid()
  if (parts.length < 1 || parts.length > 8) return invalid()
  const result = parts.map((part) => {
    if (typeof part !== "string" || !part.length || part.length > 32 || /[\p{C}\p{Zl}\p{Zp}]/u.test(part))
      return invalid()
    if (part === " ") return "space"
    if (part.trim() !== part) return invalid()
    const lower = part.toLowerCase()
    const alias = Object.hasOwn(ALIASES, lower) ? ALIASES[lower] : undefined
    if (alias === "meta") return platform === "darwin" ? "cmd" : platform === "win32" ? "win" : "meta"
    if (alias) return alias
    if ([...part].length === 1) return /^[A-Z]$/.test(part) ? lower : part
    if (/^(?:f(?:[1-9]|1\d|2[0-4])|key[a-z]|digit\d|numpad\w+)$/i.test(part)) return lower
    return invalid()
  })
  // The shared '+' separated representation can express a literal plus only as a lone key.
  if (result.length > 1 && result.includes("+")) return invalid()
  if (new Set(result).size !== result.length) return invalid()
  return result.join("+")
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function invalid(): never {
  throw new Error("The native computer action is invalid or unsupported.")
}

export * as ComputerNativeActions from "./native-actions"
