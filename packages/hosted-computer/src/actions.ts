/*
 * hostd's action format (contract WP A54): the same model-facing input as the local computer-use tool, so the agent's
 * generic `computer` tool drives a cloud computer exactly as it drives a desktop. The action names, the field names, the
 * limits and the batch rule are the local format's own; `Step` is its normalized form. A cloud computer has one display
 * and no app list or accessibility tree, so `list_apps`, `open_app`, `focus_window` and `read_ui` (and the `ui_N`
 * references only `read_ui` hands out) answer `unsupported_action`.
 *
 * Coordinates are pixels of the latest screenshot, which is at most 1280 wide; hostd maps them to the display.
 */

export const PROTOCOL = 1

export const TOOL_ACTIONS = [
  "screenshot",
  "zoom",
  "cursor_position",
  "click",
  "double_click",
  "triple_click",
  "right_click",
  "middle_click",
  "mouse_move",
  "drag",
  "mouse_down",
  "mouse_up",
  "scroll",
  "type",
  "key",
  "hold_key",
  "wait",
  "list_apps",
  "open_app",
  "focus_window",
  "read_ui",
  "handoff",
] as const
export type ToolAction = (typeof TOOL_ACTIONS)[number]

/** The local format's actions a cloud computer cannot do: it has no app list, windows to pick or accessibility tree. */
export const UNSUPPORTED: readonly ToolAction[] = ["list_apps", "open_app", "focus_window", "read_ui"]

export const LIMITS = Object.freeze({
  intentChars: 120,
  handoffReasonChars: 300,
  typeTextChars: 4000,
  batchSteps: 10,
  dragPointsMin: 2,
  dragPointsMax: 50,
  repeatMax: 20,
  scrollAmountMax: 20,
  waitSecondsMax: 30,
  holdSecondsMax: 10,
  jpegQuality: 80,
})

/** The exact text for batch steps after a failure. */
export const BATCH_FAILURE = "Not executed: an earlier computer action in this turn failed."

/** The local format's error codes that a cloud computer can answer. */
export const ERROR_CODES = [
  "unavailable",
  "paused",
  "stopped",
  "blocked",
  "secure_field",
  "stale_frame",
  "stale_ref",
  "out_of_bounds",
  "timeout",
  "unsupported_action",
  "capture_unavailable",
  "failed",
] as const
export type ErrorCode = (typeof ERROR_CODES)[number]

/** Why the agent hands the computer to the person (the local format's reasons). */
export const HANDOFF_REASONS = [
  "credential",
  "sign_in",
  "captcha",
  "payment_details",
  "admin_prompt",
  "security_prompt",
  "capture_confirm",
  "elevated",
  "site_permission",
  "download",
  "extension",
  "protocol_handler",
  "macros",
  "other",
] as const
export type HandoffReason = (typeof HANDOFF_REASONS)[number]

export type Point = { x: number; y: number }
export type Rect = { x: number; y: number; w: number; h: number }
export type Region = { x0: number; y0: number; x1: number; y1: number }

export type ToolStep = {
  action: ToolAction
  app?: string
  window?: string
  display?: string
  x?: number
  y?: number
  ref?: string
  path?: Point[]
  modifiers?: string
  text?: string
  keys?: string
  repeat?: number
  direction?: "up" | "down" | "left" | "right"
  amount?: number
  seconds?: number
  region?: Region
  query?: string
  screenshot?: boolean
  intent?: string
}

export type ToolInput = ToolStep & { reason?: string; actions?: ToolStep[] }

/** A screenshot's frame, in the local format: one display, in display pixels, with the image's size and scale. */
export type Frame = {
  id: string
  scope: "display"
  display: string
  bounds: Rect
  scale: number
  image: { w: number; h: number }
  at: number
  /** 16 hex digits identifying the image's content. */
  hash: string
}

type Button = "left" | "right" | "middle"
export type Step =
  | { kind: "click"; button: Button; count: 1 | 2 | 3; at: Point; modifiers: string[] }
  | { kind: "move"; at: Point }
  | { kind: "down" | "up"; button: Button }
  | { kind: "drag"; path: Point[]; modifiers: string[] }
  | { kind: "scroll"; at?: Point; dx: number; dy: number }
  | { kind: "type"; text: string }
  | { kind: "key"; combo: string[]; repeat: number; holdMs?: number }
  | { kind: "wait"; ms: number }

export class ActionError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly handoff?: HandoffReason,
  ) {
    super(message)
  }
}

// ── Parsing ────────────────────────────────────────────────────────────────────────────────────────────────────────

const STEP_FIELDS = new Set([
  "action",
  "app",
  "window",
  "display",
  "x",
  "y",
  "ref",
  "path",
  "modifiers",
  "text",
  "keys",
  "repeat",
  "direction",
  "amount",
  "seconds",
  "region",
  "query",
  "screenshot",
  "intent",
])
const INPUT_FIELDS = new Set([...STEP_FIELDS, "reason", "actions"])
const UI_REF = /^ui_\d{1,6}$/

function fail(message: string): never {
  throw new ActionError("failed", message)
}

function int(value: unknown, name: string, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    fail(`${name} must be an integer from ${min} to ${max}.`)
  return value
}

function text(value: unknown, name: string, max: number) {
  if (typeof value !== "string" || value.length > max) fail(`${name} must be text of at most ${max} characters.`)
  return value
}

function point(value: unknown, name: string): Point {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be a point.`)
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => key !== "x" && key !== "y")) fail(`${name} has unknown fields.`)
  return { x: int(record.x, `${name}.x`), y: int(record.y, `${name}.y`) }
}

function parseStep(value: unknown, fields: Set<string>, nested: boolean): ToolInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("An action must be an object.")
  const record = value as Record<string, unknown>
  const unknown = Object.keys(record).filter((key) => !fields.has(key))
  if (unknown.length) fail(`Unknown action fields: ${unknown.slice(0, 5).join(", ")}.`)
  const action = record.action
  if (typeof action !== "string" || !(TOOL_ACTIONS as readonly string[]).includes(action)) fail("Unknown action.")
  if (nested && action === "handoff") fail("A handoff cannot run inside a batch.")
  const out: ToolInput = { action: action as ToolAction }
  for (const name of ["app", "window", "display", "query"] as const)
    if (record[name] !== undefined) out[name] = text(record[name], name, 256)
  if (record.x !== undefined) out.x = int(record.x, "x")
  if (record.y !== undefined) out.y = int(record.y, "y")
  if (record.ref !== undefined) {
    if (typeof record.ref !== "string" || !UI_REF.test(record.ref)) fail("ref must be a ui_N reference.")
    out.ref = record.ref
  }
  if (record.path !== undefined) {
    if (
      !Array.isArray(record.path) ||
      record.path.length < LIMITS.dragPointsMin ||
      record.path.length > LIMITS.dragPointsMax
    )
      fail(`path must hold ${LIMITS.dragPointsMin} to ${LIMITS.dragPointsMax} points.`)
    out.path = record.path.map((item, index) => point(item, `path[${index}]`))
  }
  if (record.modifiers !== undefined) out.modifiers = text(record.modifiers, "modifiers", 64)
  if (record.text !== undefined) out.text = text(record.text, "text", LIMITS.typeTextChars)
  if (record.keys !== undefined) out.keys = text(record.keys, "keys", 64)
  if (record.repeat !== undefined) out.repeat = int(record.repeat, "repeat", 1, LIMITS.repeatMax)
  if (record.direction !== undefined) {
    if (!["up", "down", "left", "right"].includes(record.direction as string)) fail("direction must be up, down, left or right.")
    out.direction = record.direction as ToolStep["direction"]
  }
  if (record.amount !== undefined) out.amount = int(record.amount, "amount", 1, LIMITS.scrollAmountMax)
  if (record.seconds !== undefined) {
    const max = action === "hold_key" ? LIMITS.holdSecondsMax : LIMITS.waitSecondsMax
    if (typeof record.seconds !== "number" || !Number.isFinite(record.seconds) || record.seconds < 0 || record.seconds > max)
      fail(`seconds must be between 0 and ${max}.`)
    out.seconds = record.seconds
  }
  if (record.region !== undefined) {
    const region = record.region as Record<string, unknown>
    if (!region || typeof region !== "object" || Array.isArray(region)) fail("region must be an object.")
    if (Object.keys(region).some((key) => !["x0", "y0", "x1", "y1"].includes(key))) fail("region has unknown fields.")
    out.region = {
      x0: int(region.x0, "region.x0"),
      y0: int(region.y0, "region.y0"),
      x1: int(region.x1, "region.x1"),
      y1: int(region.y1, "region.y1"),
    }
  }
  if (record.screenshot !== undefined) {
    if (typeof record.screenshot !== "boolean") fail("screenshot must be true or false.")
    out.screenshot = record.screenshot
  }
  if (record.intent !== undefined) out.intent = text(record.intent, "intent", LIMITS.intentChars)
  if (!nested) {
    if (record.reason !== undefined) out.reason = text(record.reason, "reason", LIMITS.handoffReasonChars)
    if (record.actions !== undefined) {
      if (!Array.isArray(record.actions) || record.actions.length > LIMITS.batchSteps)
        fail(`actions must hold at most ${LIMITS.batchSteps} steps.`)
      out.actions = record.actions.map((item) => parseStep(item, STEP_FIELDS, true))
    }
  }
  return out
}

/** Checks one request's input; unknown fields and out-of-range values are refused, never ignored. */
export function parseToolInput(value: unknown): ToolInput {
  return parseStep(value, INPUT_FIELDS, false)
}

// ── Steps ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A screenshot point → a display point, refused when there is no frame or it falls outside the frame. */
export function toDisplay(x: number | undefined, y: number | undefined, frame: Frame | undefined): Point {
  if (x === undefined || y === undefined) fail("This action requires both x and y coordinates.")
  if (!frame) throw new ActionError("stale_frame", "Take a fresh screenshot before using coordinates.")
  if (x < 0 || y < 0 || x >= frame.image.w || y >= frame.image.h)
    throw new ActionError("out_of_bounds", "The coordinates are outside the latest screenshot.")
  return {
    x: Math.min(frame.bounds.x + frame.bounds.w - 1, frame.bounds.x + Math.round(x / frame.scale)),
    y: Math.min(frame.bounds.y + frame.bounds.h - 1, frame.bounds.y + Math.round(y / frame.scale)),
  }
}

const MODIFIER = /^(?:shift|ctrl|control|cmd|command|meta|alt|option|super|win|windows|altgr|altgraph)$/i

/** Splits a key combination ("ctrl+shift+t", "+"), as the local format does. */
export function keys(value: string | undefined, modifiersOnly = false): string[] {
  if (value === undefined && modifiersOnly) return []
  if (!value?.trim()) fail("The action requires a key or key combination.")
  if (/[\u0000-\u001f\u007f]/.test(value)) fail("Key combinations cannot contain control characters.")
  const result = value === "+" ? ["+"] : value.split("+").map((key) => key.trim())
  if (result.some((key) => !key) || result.length > 8) fail("Use a non-empty key combination of at most 8 keys.")
  if (modifiersOnly && result.some((key) => !MODIFIER.test(key))) fail("Pointer modifiers must be modifier keys.")
  return result
}

function seconds(value: number | undefined, max: number) {
  const s = value ?? 1
  if (!Number.isFinite(s) || s < 0 || s > max) fail(`The action duration must be between 0 and ${max} seconds.`)
  return Math.round(s * 1000)
}

/**
 * One input action as a `Step` in display pixels (the local format's normalization), or undefined for the actions hostd
 * answers itself (screenshot, zoom, cursor_position, handoff). Unsupported actions and references are refused.
 */
export function toStep(input: ToolStep, frame: Frame | undefined): Step | undefined {
  if (UNSUPPORTED.includes(input.action))
    throw new ActionError("unsupported_action", "A cloud computer has one screen and no app list; use screenshots and coordinates.")
  if (input.ref !== undefined)
    throw new ActionError("unsupported_action", "Accessibility references are not available on a cloud computer; use coordinates.")
  switch (input.action) {
    case "click":
    case "double_click":
    case "triple_click":
    case "right_click":
    case "middle_click":
      return {
        kind: "click",
        button: input.action === "right_click" ? "right" : input.action === "middle_click" ? "middle" : "left",
        count: input.action === "double_click" ? 2 : input.action === "triple_click" ? 3 : 1,
        at: toDisplay(input.x, input.y, frame),
        modifiers: keys(input.modifiers, true),
      }
    case "mouse_move":
      return { kind: "move", at: toDisplay(input.x, input.y, frame) }
    case "drag":
      if (!input.path) fail(`A drag requires a path of ${LIMITS.dragPointsMin} to ${LIMITS.dragPointsMax} points.`)
      return {
        kind: "drag",
        path: input.path.map((item) => toDisplay(item.x, item.y, frame)),
        modifiers: keys(input.modifiers, true),
      }
    case "mouse_down":
    case "mouse_up":
      if (input.x !== undefined || input.y !== undefined || input.modifiers !== undefined)
        fail("Mouse down and up use the current pointer. Move it first when needed.")
      return { kind: input.action === "mouse_down" ? "down" : "up", button: "left" }
    case "scroll": {
      if (!input.direction) fail("A scroll requires a direction.")
      const amount = input.amount ?? 1
      return {
        kind: "scroll",
        ...(input.x !== undefined || input.y !== undefined ? { at: toDisplay(input.x, input.y, frame) } : {}),
        dx: input.direction === "left" ? -amount : input.direction === "right" ? amount : 0,
        dy: input.direction === "up" ? -amount : input.direction === "down" ? amount : 0,
      }
    }
    case "type":
      if (!input.text) fail("Typing requires non-empty text.")
      return { kind: "type", text: input.text }
    case "key":
    case "hold_key":
      return {
        kind: "key",
        combo: keys(input.keys),
        repeat: input.repeat ?? 1,
        ...(input.action === "hold_key" ? { holdMs: seconds(input.seconds, LIMITS.holdSecondsMax) } : {}),
      }
    case "wait":
      return { kind: "wait", ms: seconds(input.seconds, LIMITS.waitSecondsMax) }
    default:
      return undefined
  }
}

// ── xdotool ────────────────────────────────────────────────────────────────────────────────────────────────────────

const NAMED: Readonly<Record<string, string>> = {
  shift: "shift",
  ctrl: "ctrl",
  control: "ctrl",
  cmd: "super",
  command: "super",
  meta: "super",
  super: "super",
  win: "super",
  windows: "super",
  alt: "alt",
  option: "alt",
  altgr: "ISO_Level3_Shift",
  altgraph: "ISO_Level3_Shift",
  enter: "Return",
  return: "Return",
  esc: "Escape",
  escape: "Escape",
  tab: "Tab",
  backspace: "BackSpace",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  space: "space",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  home: "Home",
  end: "End",
  pageup: "Prior",
  pagedown: "Next",
  page_up: "Prior",
  page_down: "Next",
  capslock: "Caps_Lock",
  menu: "Menu",
}
const PUNCTUATION: Readonly<Record<string, string>> = {
  "+": "plus",
  "-": "minus",
  "=": "equal",
  "/": "slash",
  "\\": "backslash",
  ".": "period",
  ",": "comma",
  ";": "semicolon",
  "'": "apostrophe",
  "`": "grave",
  "[": "bracketleft",
  "]": "bracketright",
  " ": "space",
}

/** An X keysym name for one key of a combination; refuses names xdotool would read as options or several keys. */
export function keysym(name: string): string {
  const lower = name.toLowerCase()
  if (NAMED[lower]) return NAMED[lower]!
  if (PUNCTUATION[name]) return PUNCTUATION[name]!
  if (/^f([1-9]|1\d|2[0-4])$/.test(lower)) return lower.toUpperCase()
  if (/^[A-Za-z0-9]$/.test(name)) return name
  if (/^[A-Za-z][A-Za-z0-9_]{1,31}$/.test(name)) return name
  fail(`Unknown key: ${name.slice(0, 32)}.`)
}

/** A command hostd runs for a step: an xdotool argument list (with text on stdin), or a pause. */
export type Command = { argv: string[]; stdin?: string } | { sleepMs: number }

const BUTTON: Readonly<Record<Button, string>> = { left: "1", middle: "2", right: "3" }

/**
 * The xdotool commands for one step. Text goes on stdin (`type --file -`), never on the command line, which other
 * processes could read.
 */
export function plan(step: Step): Command[] {
  const at = (point: Point) => ({ argv: ["mousemove", "--sync", String(point.x), String(point.y)] })
  const down = (mods: string[]) => (mods.length ? [{ argv: ["keydown", mods.map(keysym).join("+")] }] : [])
  const up = (mods: string[]) => (mods.length ? [{ argv: ["keyup", mods.map(keysym).join("+")] }] : [])
  switch (step.kind) {
    case "move":
      return [at(step.at)]
    case "click":
      return [
        at(step.at),
        ...down(step.modifiers),
        { argv: ["click", "--repeat", String(step.count), "--delay", "80", BUTTON[step.button]] },
        ...up(step.modifiers),
      ]
    case "down":
      return [{ argv: ["mousedown", BUTTON[step.button]] }]
    case "up":
      return [{ argv: ["mouseup", BUTTON[step.button]] }]
    case "drag":
      return [
        ...down(step.modifiers),
        at(step.path[0]!),
        { argv: ["mousedown", "1"] },
        ...step.path.slice(1).map(at),
        { argv: ["mouseup", "1"] },
        ...up(step.modifiers),
      ]
    case "scroll": {
      const commands: Command[] = step.at ? [at(step.at)] : []
      if (step.dy) commands.push({ argv: ["click", "--repeat", String(Math.abs(step.dy)), "--delay", "40", step.dy < 0 ? "4" : "5"] })
      if (step.dx) commands.push({ argv: ["click", "--repeat", String(Math.abs(step.dx)), "--delay", "40", step.dx < 0 ? "6" : "7"] })
      return commands
    }
    case "type":
      return [{ argv: ["type", "--clearmodifiers", "--delay", "12", "--file", "-"], stdin: step.text }]
    case "key": {
      const combo = step.combo.map(keysym).join("+")
      if (step.holdMs !== undefined) return [{ argv: ["keydown", combo] }, { sleepMs: step.holdMs }, { argv: ["keyup", combo] }]
      return [{ argv: ["key", "--clearmodifiers", "--repeat", String(step.repeat), "--delay", "50", combo] }]
    }
    case "wait":
      return [{ sleepMs: step.ms }]
  }
}

/** Keys that move focus or submit without typing anything, allowed even when a credential field has focus. */
const NAVIGATION = new Set(["Tab", "Escape", "Up", "Down", "Left", "Right", "Home", "End", "Prior", "Next", "Return"])

/** Whether a step could put characters into the focused field (what the credential guard checks first). */
export function typesText(step: Step): boolean {
  if (step.kind === "type") return true
  if (step.kind !== "key") return false
  const combo = step.combo.map(keysym)
  return !combo.every((key) => NAVIGATION.has(key) || key === "shift")
}

/**
 * Where a pointer step could put text into a field without any typing (what the credential guard checks for pointer
 * steps): a middle click pastes the selection where it lands, a right click opens a menu with Paste for the field under
 * it, and a drag, or a mouse up after a mouse down, drops what it carries. "pointer" is the pointer's current position.
 */
export function insertsAt(step: Step): Point | "pointer" | undefined {
  if (step.kind === "click" && step.button !== "left") return step.at
  if (step.kind === "drag") return step.path[step.path.length - 1]
  if (step.kind === "up") return "pointer"
  return undefined
}

/** The screen points a step presses at (what the CAPTCHA check looks at). */
export function pressPoints(step: Step): Point[] {
  if (step.kind === "click") return [step.at]
  if (step.kind === "drag") return step.path
  return []
}

// ── Frames ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The image size of a capture of `width` × `height`, at most `maxWidth` wide, with an even height. */
export function imageSize(width: number, height: number, maxWidth: number) {
  const w = Math.min(maxWidth, width)
  const h = Math.max(2, Math.round((height * w) / width / 2) * 2)
  return { w, h }
}

/** Whether a zoom region is a non-empty part of the frame. */
export function checkRegion(region: Region | undefined, frame: Frame | undefined): Region {
  if (!region) fail("A zoom requires a region.")
  if (!frame) throw new ActionError("stale_frame", "Take a fresh screenshot before zooming.")
  if (region.x0 < 0 || region.y0 < 0 || region.x1 > frame.image.w || region.y1 > frame.image.h)
    throw new ActionError("out_of_bounds", "The region is outside the latest screenshot.")
  if (region.x1 - region.x0 < 8 || region.y1 - region.y0 < 8) fail("The region must be at least 8 pixels wide and high.")
  return region
}
