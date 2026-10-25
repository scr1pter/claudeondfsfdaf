export function isLocalBrowserUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== "http:" && url.protocol !== "https:") return false
    const host = url.hostname.toLowerCase()
    return (
      host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]" || host.endsWith(".localhost")
    )
  } catch {
    return false
  }
}

export function browserOrigin(rawUrl: string) {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== "http:" && url.protocol !== "https:") return
    return url.origin
  } catch {
    return
  }
}

export function isAllowedBrowserNavigation(rawUrl: string, allowedExternalOrigins: ReadonlySet<string>) {
  if (isLocalBrowserUrl(rawUrl)) return true
  const origin = browserOrigin(rawUrl)
  return Boolean(origin && allowedExternalOrigins.has(origin))
}

// Who is driving the controlled browser. Automation (the agent, or the Browser Agent
// workspace's planned steps) drives it through commands; the user drives it with their own
// mouse and keyboard in the visible view. A navigation that follows the user's own click or
// key press is theirs and goes wherever a normal browser would. Every other navigation keeps
// the per-origin approval rule above.

// Commands that can move the page or put input into it. While one runs, and briefly after,
// input the page receives belongs to the automation, not the user.
export const DRIVING_COMMANDS = new Set([
  "openUrl",
  "openTab",
  "click",
  "clickRef",
  "type",
  "typeRef",
  "press",
  "selectOption",
  "hover",
  "reload",
  "goBack",
  "goForward",
  "scroll",
])
export const AUTOMATION_SETTLE_MS = 800
// Long enough for a slow redirect chain after a click, such as a search result's.
export const USER_NAVIGATION_WINDOW_MS = 10_000
const USER_INPUT_TYPES = new Set(["mouseDown", "mouseUp", "rawKeyDown", "keyDown", "char", "gestureTap"])

export type NavigationIntent = { driving: number; drivenUntil: number; userInputAt: number }

export function navigationIntent(): NavigationIntent {
  return { driving: 0, drivenUntil: 0, userInputAt: 0 }
}

// Automation taking over also forgets the user's last gesture, so an automated click can never
// ride a click the user made a moment earlier.
export function beginAutomation(intent: NavigationIntent) {
  intent.driving += 1
  intent.userInputAt = 0
}

export function endAutomation(intent: NavigationIntent, now: number) {
  intent.driving = Math.max(0, intent.driving - 1)
  intent.drivenUntil = now + AUTOMATION_SETTLE_MS
}

/**
 * One command's hold on the browser, ended once: by the command finishing, or by its turn giving it up at the deadline
 * or on close, whichever comes first. A command the turn gave up may still be running, and its late end must not end
 * another command's hold.
 */
export function automationTurn(intent: NavigationIntent) {
  const state = { held: false }
  return {
    begin() {
      state.held = true
      beginAutomation(intent)
    },
    end(now: number) {
      if (!state.held) return
      state.held = false
      endAutomation(intent, now)
    },
  }
}

export function recordPageInput(intent: NavigationIntent, type: string | undefined, now: number) {
  if (!type || !USER_INPUT_TYPES.has(type)) return
  if (intent.driving > 0 || now < intent.drivenUntil) return
  intent.userInputAt = now
}

export function isUserNavigation(intent: NavigationIntent, now: number) {
  return intent.userInputAt > 0 && now - intent.userInputAt < USER_NAVIGATION_WINDOW_MS
}
