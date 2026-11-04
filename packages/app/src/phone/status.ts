import { PERK_IDS, PLAN_STATES, type PerkId, type PlanState } from "@vectordevai/schema/codium-entitlements"

// What the phone app shows (WP A38) comes from the account's status (`GET /api/model-plans/status`, §4.11): `listed`,
// the perks this account's surfaces may show (H1), and `entitlements`, what the plan includes for those perks
// (publicEntitlements). A route appears only when both say so. That decides display only: every service the routes
// reach checks the plan again from the server's own snapshot (S1), so a patched phone gains nothing.

export type PhoneStatus = {
  /** vectordev.ai serves Codium now. */
  enabled: boolean
  plan?: { id: string; name: string; state?: PlanState }
  listed: ReadonlySet<PerkId>
  entitlements: Readonly<Record<string, unknown>>
  remote?: { computers: number; limit: number }
}

const PERKS = new Set<string>(PERK_IDS)
const STATES = new Set<string>(PLAN_STATES)

/**
 * The fields the phone reads from a status answer, each on its own: an unknown perk or state is dropped and a missing
 * field reads as nothing, so a newer server never breaks the phone (the same rule as H7's lenient pass).
 */
export function decodePhoneStatus(body: unknown): PhoneStatus {
  const value = record(body) ?? {}
  const plan = record(value.plan)
  const meters = record(value.meters)
  const remote = record(meters?.remote)
  return {
    enabled: value.enabled === true,
    ...(plan && typeof plan.id === "string" && typeof plan.name === "string"
      ? {
          plan: {
            id: plan.id,
            name: plan.name,
            ...(typeof plan.state === "string" && STATES.has(plan.state) ? { state: plan.state as PlanState } : {}),
          },
        }
      : {}),
    listed: new Set(
      Array.isArray(value.listed)
        ? value.listed.filter((perk): perk is PerkId => typeof perk === "string" && PERKS.has(perk))
        : [],
    ),
    entitlements: record(value.entitlements) ?? {},
    ...(remote && count(remote.computers) !== undefined && count(remote.limit) !== undefined
      ? { remote: { computers: count(remote.computers)!, limit: count(remote.limit)! } }
      : {}),
  }
}

export const PHONE_ROUTES = [
  "sessions",
  "approvals",
  "devices",
  "cloud-runs",
  "computer",
  "ops",
  "notifications",
] as const
export type PhoneRoute = (typeof PHONE_ROUTES)[number]

export type PhoneFeature = {
  route: PhoneRoute
  label: string
  summary: string
}

const FEATURES: Record<PhoneRoute, Omit<PhoneFeature, "route">> = {
  sessions: { label: "Sessions", summary: "Watch and answer the agents on your paired computers." },
  approvals: { label: "Approvals", summary: "Allow once or deny what an agent asks to do." },
  devices: { label: "Devices", summary: "The computers paired with this phone." },
  "cloud-runs": {
    label: "GitHub runs",
    summary: "Runs of Vector's GitHub agent, in your own repo, on your own Actions minutes.",
  },
  computer: { label: "Cloud computer", summary: "Jobs on the computer Vector runs for you." },
  ops: { label: "Production", summary: "Incidents, releases and cards from your production checks." },
  notifications: { label: "Alerts", summary: "Alerts on this phone when an agent finishes or needs you." },
}

/** Whether the account's status shows a route: its perk listed and the plan including it. */
export function routeShown(route: PhoneRoute, status: PhoneStatus): boolean {
  const listed = (perk: PerkId) => status.listed.has(perk)
  const entitled = (field: string) => {
    const value = status.entitlements[field]
    return value !== undefined && value !== null && value !== false
  }
  switch (route) {
    case "sessions":
    case "approvals":
    case "devices":
      return listed("remote") && remoteComputers(status) > 0
    case "cloud-runs":
      // Cloud runs are listed beside Remote's computers (§1.1), from the GitHub agent's run records (A40).
      return listed("remote") && listed("github-agents") && remoteComputers(status) > 0 && entitled("cloudAgents")
    case "computer":
      return listed("computer") && entitled("hosted")
    case "ops":
      return (listed("on-call") || listed("release-guard") || listed("ship-desk")) && entitled("ops")
    case "notifications":
      // Phone alerts are on every plan (§1.1); the plan's public entitlements always carry its rank.
      return listed("alerts") && typeof status.entitlements.rank === "number"
  }
}

/** The routes this account's phone shows, in order. */
export function phoneFeatures(status: PhoneStatus): PhoneFeature[] {
  return PHONE_ROUTES.filter((route) => routeShown(route, status)).map((route) => ({ route, ...FEATURES[route] }))
}

/** The parts of production checks this account shows: only those listed. */
export function opsParts(status: PhoneStatus) {
  return (["on-call", "release-guard", "ship-desk"] as const).filter((perk) => status.listed.has(perk))
}

/**
 * Why the plan's phone features cannot be used now, or undefined while they can (active, or renewing within its
 * grace: §4.4's Remote and Phone alerts rows). The routes stay visible so nobody loses their place.
 */
export function planNotice(status: PhoneStatus): string | undefined {
  switch (status.plan?.state) {
    case undefined:
    case "active":
    case "renewing":
      return undefined
    case "paused":
      return "Your Vector Codium plan is paused until its payment goes through. Fix it on vectordev.ai/account."
    case "frozen":
      return "Your Vector Codium plan is on hold. Contact Vector support from vectordev.ai/support."
    case "ended":
    case "none":
      return "Your Vector Codium plan has ended. Phone features come back with a new plan."
  }
}

export function routeFromPath(pathname: string): PhoneRoute | undefined {
  const match = /^\/phone\/([a-z-]+)\/?$/.exec(pathname)
  return match && (PHONE_ROUTES as readonly string[]).includes(match[1]) ? (match[1] as PhoneRoute) : undefined
}

function remoteComputers(status: PhoneStatus) {
  const remote = record(status.entitlements.remote)
  return count(remote?.computers) ?? 0
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function count(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}
