import type { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import type { RemoteStatus } from "@/context/platform"

/*
 * Settings → Remote (WP A42), as the app reads it. The desktop's main process holds Remote's keys and its connection
 * (packages/desktop/src/main/remote-link.ts, A41) and reports a status; vectordev.ai decides from the account's plan
 * whether a ticket is minted at all, and the relay refuses a pairing over the plan's computer count (S1). This only
 * decides what Settings shows.
 */

export const PHONE_APP_ADDRESS = "remote.vectordev.ai"

/**
 * Whether Settings shows the Remote tab: the account's plan includes Remote while vectordev.ai lists it (H1), or this
 * computer already has Remote on or a phone paired, so it can always be turned off and its phones removed.
 */
export function remoteTab(status: ModelPlanStatus.Status | undefined, local: RemoteStatus | undefined) {
  if (local && (local.enabled || local.phones.length > 0)) return true
  return remoteOffered(status)
}

/** Whether the account's plan includes Remote and vectordev.ai lists it. */
export function remoteOffered(status: ModelPlanStatus.Status | undefined) {
  const remote = status?.entitlements?.remote as { computers?: unknown } | undefined
  return Boolean(
    status?.signedIn &&
      !status.error &&
      status.listed?.includes("remote") &&
      typeof remote?.computers === "number" &&
      remote.computers > 0,
  )
}

/** "1 of 3 computers paired", from the account's status meter; else the plan's limit alone. */
export function pairedCountLine(status: ModelPlanStatus.Status | undefined) {
  const meter = status?.meters?.remote
  if (meter) return `${meter.computers} of ${meter.limit} ${meter.limit === 1 ? "computer" : "computers"} paired.`
  const remote = status?.entitlements?.remote as { computers?: unknown } | undefined
  const limit = typeof remote?.computers === "number" ? remote.computers : undefined
  return limit === undefined ? undefined : `Your plan pairs up to ${limit} ${limit === 1 ? "computer" : "computers"}.`
}

/** The connection's state in words. */
export function stateLine(status: RemoteStatus): { text: string; problem: boolean } {
  const say = (text: string, problem = false) => ({ text: status.message ?? text, problem })
  switch (status.state) {
    case "off":
      return { text: "Remote is off on this computer.", problem: false }
    case "ready":
      return { text: "Remote is on. Pair a phone to use it.", problem: false }
    case "connecting":
      return { text: "Connecting…", problem: false }
    case "online":
      return {
        text:
          status.viewers > 0
            ? `Connected. ${status.viewers} ${status.viewers === 1 ? "phone is" : "phones are"} open now.`
            : "Connected. Your paired phones can reach this computer.",
        problem: false,
      }
    case "signed-out":
      return say("Sign in to Vector to use Remote.", true)
    case "paused":
      return say("Your Vector Codium plan is paused, so Remote is off until its payment goes through.", true)
    case "not-in-plan":
      return say("Your Vector Codium plan does not include Remote right now.", true)
    case "unavailable":
      return say("Vector Remote is not available right now. Vector tries again later.", true)
    case "device-limit":
      return say("Your account already has as many computers as its plan pairs. Remove one from a phone's Devices.", true)
    case "fair-use":
      return say("Remote reached this month's fair-use limit. It comes back when your plan renews.", true)
    case "revoked":
      return say("This computer was disconnected from Remote. Start over to pair your phone again.", true)
    case "replaced":
      return say("Remote opened on this computer in another Vector window.", true)
    case "local-off":
      return say("Vector Local blocks Remote's connection. Allow Vector Remote in Settings → Vector Local.", true)
  }
}

/** Seconds left on a pairing code, never below zero. */
export function secondsLeft(expiresAt: number, now = Date.now()) {
  return Math.max(0, Math.ceil((expiresAt - now) / 1_000))
}

export function minutesAndSeconds(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}

/** Six digits as people read them: "123 456". */
export function spacedCode(code: string) {
  return /^\d{6}$/.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : code
}

export function pairedSince(at: number, locale?: string) {
  return new Date(at).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" })
}

export function phoneLine(phone: RemoteStatus["phones"][number]) {
  if (phone.watching) return "Watching now"
  if (phone.connected) return "Connected"
  return "Not connected"
}
