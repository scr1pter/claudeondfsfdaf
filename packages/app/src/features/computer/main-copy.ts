import { Computer } from "@vectordevai/schema/computer"
import { Hands } from "@vectordevai/schema/hands"

export * as ComputerMainCopy from "./main-copy"

// Desktop main has no translation runtime. Callers pass verified app names, accessibility labels and fixed
// Vector-built reasons here; never pass model intent, generated explanations or raw tool output.
export const labels = {
  takeOver: "Take over",
  resume: "Resume",
  stop: "Stop",
  allow: "Allow",
  allowOnce: "Allow once",
  deny: "Deny",
  continue: "Continue",
  handOver: "Hand over",
  notNow: "Not now",
  keepGoing: "Keep going",
  working: "Working",
  needsYou: "Needs you",
  paused: "Paused",
  waiting: "Waiting for the computer",
  yourTurn: "Your turn",
  done: "Done",
  stopped: "Stopped",
} as const

export function banner() {
  return Hands.BANNER
}

export function bannerEnd(input: { reason: "done" | "stopped" }) {
  return `${input.reason === "done" ? "Done" : "Stopped"} — your computer is yours again`
}

export function trayTooltip() {
  return `Vector — ${Hands.BANNER}`
}

export function trayStop() {
  return `Stop ${Hands.NAME}`
}

export function working(input: { app: string }) {
  return `Working in ${input.app}`
}

export function workingBehind(input: { app: string }) {
  return `Working in ${input.app} behind your windows`
}

export function waitingForTyping(input: { app: string }) {
  return `Waiting while you type in ${input.app}`
}

export function foregroundFallback(input: { app: string }) {
  return `${input.app} needs the screen; ${Hands.NAME} will ask before using your mouse.`
}

export function queued(input: { count: number }) {
  return `+${input.count} waiting`
}

export function notificationStart() {
  return `${Hands.BANNER}. Press Esc or Stop to stop it.`
}

export function notificationNeedsYou() {
  return `${Hands.NAME} needs you`
}

/** app is the verified display name or a caller-formatted list of verified app names. */
export function notificationFinished(input: { count: number; app?: string }) {
  return `${Hands.NAME} finished. ${input.count} ${input.count === 1 ? "action" : "actions"}${input.app ? ` in ${input.app}` : ""}.`
}

export function notificationStopped() {
  return `${Hands.NAME} stopped.`
}

/** reason must be a short, fixed Vector-built failure description, never the model's explanation. */
export function notificationFailed(input: { reason: string }) {
  return `${Hands.NAME} couldn't finish: ${input.reason}`
}

const MAC: Record<string, string> = {
  command: "⌘",
  cmd: "⌘",
  commandorcontrol: "⌘",
  cmdorctrl: "⌘",
  super: "⌘",
  meta: "⌘",
  control: "⌃",
  ctrl: "⌃",
  alt: "⌥",
  option: "⌥",
  shift: "⇧",
  escape: "Esc",
  esc: "Esc",
}
const WINDOWS: Record<string, string> = {
  control: "Ctrl",
  ctrl: "Ctrl",
  commandorcontrol: "Ctrl",
  cmdorctrl: "Ctrl",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
  super: "Win",
  meta: "Win",
  command: "Win",
  cmd: "Win",
  escape: "Esc",
  esc: "Esc",
}

/** An Electron accelerator as the platform writes it, in the accelerator's own order: ⌘⇧Esc, or Ctrl+Alt+Shift+Esc. */
export function chord(accelerator: string, platform: "macos" | "windows") {
  const names = platform === "macos" ? MAC : WINDOWS
  return accelerator
    .split("+")
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => names[token.toLowerCase()] ?? Computer.clean(token, 16))
    .join(platform === "macos" ? "" : "+")
}

export function pause(input: { reason: Computer.PauseReason; app?: string }) {
  const copy = {
    input: "Paused — you have control",
    button: "Paused — you have control",
    locked: "Paused while your computer was locked",
    suspend: "Paused while your computer was locked",
    away: `Still there? ${Hands.NAME} paused so your computer can lock.`,
    helper: `Paused — ${Hands.NAME}' helper stopped`,
    detection: "Paused — Vector can't tell whether you're using the mouse and keyboard",
    secure_input: `Paused — secure typing is on in ${input.app || "another app"}`,
    secure_desktop: "Paused — Windows is showing a security screen",
    overlay: "Paused — the screen indicator is unavailable",
    pointer: `${Hands.NAME} needs the mouse for a moment`,
  } satisfies Record<Computer.PauseReason, string>
  return copy[input.reason]
}

export function secureTypingDetail(input: { app: string }) {
  return `${input.app} turned on secure keyboard entry, so Vector can't hear Esc. Finish typing your password or turn it off, then press Resume.`
}

export function checkIn(input: { reason: "actions" | "minutes"; count: number }) {
  return input.reason === "actions"
    ? `${Hands.NAME} has taken ${input.count} ${input.count === 1 ? "step" : "steps"} on this task. Keep going?`
    : `${Hands.NAME} has been working for ${input.count} ${input.count === 1 ? "minute" : "minutes"} on this task. Keep going?`
}

const handoffReasons = {
  credential: "enter your password or code",
  sign_in: "sign in",
  captcha: "complete the CAPTCHA",
  payment_details: "enter your payment details",
  admin_prompt: "answer the administrator prompt",
  security_prompt: "answer the security prompt",
  capture_confirm: "answer the screen recording prompt",
  elevated: "finish this step in the app running as administrator",
  site_permission: "answer the site's permission prompt",
  download: "decide whether to keep or open the download",
  extension: "decide whether to install the extension",
  protocol_handler: "decide whether to open the linked app",
  macros: "decide whether to enable the document's content or macros",
  other: "finish this step yourself",
} satisfies Record<Computer.HandoffReason, string>

export function handoff(input: { reason: Computer.HandoffReason; app?: string }) {
  return `Your turn${input.app ? ` in ${input.app}` : ""}: ${handoffReasons[input.reason]}. Press Continue when you're done.`
}

// Controls and line or paragraph separators become spaces; bidi, zero-width and invisible formatting characters are
// dropped, as the run card's labels do. Together they cover every character `Computer.ComputerState.step` (Safe)
// refuses, so the step line is valid state whatever the screen's label holds.
const BREAKS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g
const INVISIBLE = /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g

// Cut by UTF-16 units, as the schema bounds labels, without leaving half of a surrogate pair.
function quoted(label: string | undefined) {
  return label
    ?.replace(BREAKS, " ")
    .replace(INVISIBLE, "")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, Computer.LIMITS.labelChars)
    .replace(/[\ud800-\udbff]$/, "")
    .trimEnd()
}

/** The banner's mirror of an app ask. app is the verified display name; the banner never offers Always allow. */
export function askApp(input: { app: string }) {
  return `Allow ${Hands.NAME} to use ${input.app}?`
}

/**
 * The banner's mirror of a sensitive ask, built only from the verified app name, the fixed reason and the verified
 * accessibility label. Typed text, key payloads, paths and model intent never enter it.
 */
export function askSensitive(input: {
  action: Computer.SensitiveAskMetadata["action"]
  why: Computer.SensitiveWhy
  app: string
  label?: string
}) {
  if (input.why === "run_program") return `${Hands.NAME} wants to run a program`
  if (input.why === "paste") return `${Hands.NAME} wants to paste in ${input.app}`
  const label = quoted(input.label)
  if (input.action === "click" && label) return `${Hands.NAME} wants to click “${label}” in ${input.app}`
  if (input.action === "type") return `${Hands.NAME} wants to type in ${input.app}`
  if (input.action === "key") return `${Hands.NAME} wants to press a key in ${input.app}`
  if (input.action === "drag") return `${Hands.NAME} wants to drag in ${input.app}`
  return `${Hands.NAME} wants to use ${input.app}`
}

/** Fixed, Vector-built reasons for notificationFailed. Never an engine message or the model's explanation. */
export function failure(input: { reason: "engine" | "error" }) {
  return input.reason === "engine" ? "Vector's engine stopped" : "the conversation ended with an error"
}

/** label is a verified accessibility label. Typed text, key payloads and model intent never enter the banner. */
export function step(input: { action: Computer.ToolAction; app?: string; label?: string }) {
  const label = quoted(input.label)
  const target = label ? ` “${label}”` : ""
  const app = input.app ? ` in ${input.app}` : ""
  const copy = {
    screenshot: input.app ? `Looking at ${input.app}` : "Looking at the approved apps",
    zoom: input.app ? `Looking more closely at ${input.app}` : "Looking more closely",
    cursor_position: "Checking the pointer",
    click: `Clicking${target}${app}`,
    double_click: `Double-clicking${target}${app}`,
    triple_click: `Triple-clicking${target}${app}`,
    right_click: `Right-clicking${target}${app}`,
    middle_click: `Middle-clicking${target}${app}`,
    mouse_move: `Moving the pointer${app}`,
    drag: `Dragging${target}${app}`,
    mouse_down: `Holding the mouse button${app}`,
    mouse_up: `Releasing the mouse button${app}`,
    scroll: `Scrolling${app}`,
    type: `Typing${app}`,
    key: `Pressing keys${app}`,
    hold_key: `Holding keys${app}`,
    wait: "Waiting",
    list_apps: "Looking at available apps",
    open_app: input.app ? `Opening ${input.app}` : "Opening an app",
    focus_window: input.app ? `Switching to ${input.app}` : "Switching windows",
    read_ui: input.app ? `Reading controls in ${input.app}` : "Reading app controls",
    handoff: "Your turn",
  } satisfies Record<Computer.ToolAction, string>
  return copy[input.action]
}
