import type { PlanId } from "./codium-plan.js"

export * as CodiumEntitlements from "./codium-entitlements.js"
export type { PlanId } from "./codium-plan.js"

/*
 * What each Codium plan includes, as counts, hours, minutes, shares of the month and flags. This module is browser-safe:
 * the API, the app, the CLI and the Workers all import it, so it never holds an amount of money. The size of a plan's
 * monthly pool stays on the server; readers see only `usageMultiple`, which the pricing page renders from.
 */

/**
 * The perks a surface may list, each once its gate passes (`CODIUM_LISTED_PERKS`, its runtime switch, the perks it
 * requires and the service it needs). The listing itself is decided on the server; this is only the vocabulary.
 */
export const PERK_IDS = [
  "github-agents",
  "github-no-secret",
  "scheduled",
  "reviews",
  "second-opinion",
  "remote",
  "alerts",
  "vault",
  "computer",
  "overnight",
  "on-call",
  "release-guard",
  "ship-desk",
  "vote",
  "reports-first",
  "priority",
  "review-panel",
  "founding",
  "brain",
  "auto-learns",
  "brain-cloud",
  "playbooks",
] as const
export type PerkId = (typeof PERK_IDS)[number]

export type Entitlements = {
  readonly rank: 1 | 2 | 3 | 4
  /** The plan's usage as a multiple of Plus's: 1, 5.5, 12, 25. Public; the pricing page renders from it. */
  readonly usageMultiple: number
  /** Codium requests at once, across every caller of the account. */
  readonly inFlight: number
  readonly perMinute: number
  /** The share of the month one UTC day may use; null means no daily limit. */
  readonly dailyShare: number | null
  /** The longest context, in tokens, any model gets on this plan. */
  readonly contextMax: number
  /** The global reserve when Codium is busy, and one retry. */
  readonly priority: boolean
  readonly fastLanes: boolean
  /** Dormant until a catalog entry has a future `previewUntil`. */
  readonly previewModels: boolean
  /** The share of the month Codium Brain helpers may use. */
  readonly purposeShare: { readonly brain: number }
  /**
   * Cloud agents (the GitHub agent on Codium, in the user's own repo on their own Actions minutes): runs at once,
   * Codium agent hours a month, the longest run in minutes, scheduled runs a day, and one run's ceiling as a share of
   * the month.
   */
  readonly cloudAgents: {
    readonly atOnce: number
    readonly hours: number
    readonly longestRunMin: number
    readonly scheduledPerDay: number
    readonly runCeilingShare: number
  }
  /** Vector Remote: computers paired at once. */
  readonly remote: { readonly computers: number }
  /** Brain Vault: storage in GB (0 means none) and the days versions are kept. */
  readonly vault: { readonly gb: number; readonly versionDays: number }
  /** A cloud computer Vector runs: computers at once, hours a month, the longest job in minutes, days a disk is kept. */
  readonly hosted: null | {
    readonly computers: number
    readonly hours: number
    readonly jobMin: number
    readonly diskDays: number
    readonly sizes: readonly ("standard" | "large")[]
  }
  /** Done by Morning: jobs a night, jobs at once, recurring jobs a day. */
  readonly overnight: null | { readonly perNight: number; readonly atOnce: number; readonly recurringPerDay: number }
  readonly ops: null | {
    /** URLs watched, seconds between checks, verified domains, fix runs a day. */
    readonly onCall: {
      readonly urls: number
      readonly intervalSec: number
      readonly domains: number
      readonly fixRunsPerDay: number
    }
    /** Releases a day, minutes each release is watched, paths checked. */
    readonly releaseGuard: { readonly perDay: number; readonly watchMin: number; readonly paths: number }
    /** Cards a month, days a card is kept, images a card. */
    readonly shipDesk: { readonly cardsPerMonth: number; readonly keepDays: number; readonly images: number }
  }
  readonly secondOpinion: boolean
  readonly playbooks: boolean
  readonly vote: boolean
  readonly nominate: boolean
  /** The tag on a bug report, reports an hour, and whether reports are read first. */
  readonly reports: {
    readonly tag: "plus" | "pro" | "max" | "ultra"
    readonly perHour: number
    readonly readFirst: boolean
  }
  /** The usage multiplier for founding subscriptions; it applies only to founding subscriptions. */
  readonly foundingBoost: number | null
  /** Vector Velocity: shown as "Coming" only, never as available. */
  readonly velocity: null | "coming"
  /** Vector Labs: a name and a "Coming" tag only. */
  readonly labs: null | "coming"
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
  return value
}

/**
 * Every plan's caps, frozen. A server applies ramps to a copy (`EntitlementSnapshot.caps`); nothing changes these.
 * Free accounts have no entry. The per-run ceiling is clamped on the server to `dailyShare` when there is one.
 */
export const ENTITLEMENTS: Readonly<Record<PlanId, Entitlements>> = freeze({
  "vector-10": {
    rank: 1,
    usageMultiple: 1,
    inFlight: 3,
    perMinute: 30,
    dailyShare: 0.25,
    contextMax: 262_144,
    priority: false,
    fastLanes: false,
    previewModels: false,
    purposeShare: { brain: 0.1 },
    cloudAgents: { atOnce: 1, hours: 5, longestRunMin: 30, scheduledPerDay: 0, runCeilingShare: 0.1 },
    remote: { computers: 1 },
    vault: { gb: 0, versionDays: 30 },
    hosted: null,
    overnight: null,
    ops: null,
    secondOpinion: false,
    playbooks: false,
    vote: false,
    nominate: false,
    reports: { tag: "plus", perHour: 15, readFirst: false },
    foundingBoost: 1.1,
    velocity: null,
    labs: null,
  },
  "vector-50": {
    rank: 2,
    usageMultiple: 5.5,
    inFlight: 6,
    perMinute: 60,
    dailyShare: 0.25,
    contextMax: 262_144,
    priority: false,
    fastLanes: false,
    previewModels: false,
    purposeShare: { brain: 0.1 },
    cloudAgents: { atOnce: 1, hours: 15, longestRunMin: 45, scheduledPerDay: 0, runCeilingShare: 0.1 },
    remote: { computers: 3 },
    vault: { gb: 10, versionDays: 30 },
    hosted: null,
    overnight: null,
    ops: null,
    secondOpinion: true,
    playbooks: true,
    vote: false,
    nominate: false,
    reports: { tag: "pro", perHour: 15, readFirst: false },
    foundingBoost: 1.1,
    velocity: null,
    labs: null,
  },
  "vector-100": {
    rank: 3,
    usageMultiple: 12,
    inFlight: 12,
    perMinute: 120,
    dailyShare: 0.4,
    contextMax: 512_000,
    priority: true,
    fastLanes: true,
    previewModels: false,
    purposeShare: { brain: 0.1 },
    cloudAgents: { atOnce: 2, hours: 40, longestRunMin: 45, scheduledPerDay: 5, runCeilingShare: 0.1 },
    remote: { computers: 5 },
    vault: { gb: 25, versionDays: 30 },
    hosted: { computers: 1, hours: 20, jobMin: 240, diskDays: 7, sizes: ["standard"] },
    overnight: { perNight: 3, atOnce: 1, recurringPerDay: 5 },
    ops: {
      onCall: { urls: 5, intervalSec: 300, domains: 3, fixRunsPerDay: 3 },
      releaseGuard: { perDay: 10, watchMin: 30, paths: 5 },
      shipDesk: { cardsPerMonth: 100, keepDays: 30, images: 8 },
    },
    secondOpinion: true,
    playbooks: true,
    vote: true,
    nominate: false,
    reports: { tag: "max", perHour: 30, readFirst: true },
    foundingBoost: null,
    velocity: "coming",
    labs: null,
  },
  "vector-200": {
    rank: 4,
    usageMultiple: 25,
    inFlight: 24,
    perMinute: 200,
    dailyShare: null,
    contextMax: 768_000,
    priority: true,
    fastLanes: true,
    previewModels: true,
    purposeShare: { brain: 0.1 },
    cloudAgents: { atOnce: 6, hours: 120, longestRunMin: 120, scheduledPerDay: 20, runCeilingShare: 0.1 },
    remote: { computers: 5 },
    vault: { gb: 50, versionDays: 30 },
    hosted: { computers: 3, hours: 60, jobMin: 720, diskDays: 30, sizes: ["standard", "large"] },
    overnight: { perNight: 10, atOnce: 3, recurringPerDay: 20 },
    ops: {
      onCall: { urls: 10, intervalSec: 60, domains: 10, fixRunsPerDay: 10 },
      releaseGuard: { perDay: 30, watchMin: 60, paths: 5 },
      shipDesk: { cardsPerMonth: 400, keepDays: 90, images: 8 },
    },
    secondOpinion: true,
    playbooks: true,
    vote: true,
    nominate: true,
    reports: { tag: "ultra", perHour: 30, readFirst: true },
    foundingBoost: null,
    velocity: "coming",
    labs: "coming",
  },
})

type Ops = NonNullable<Entitlements["ops"]>
const NO_ON_CALL: Ops["onCall"] = { urls: 0, intervalSec: 0, domains: 0, fixRunsPerDay: 0 }
const NO_RELEASE_GUARD: Ops["releaseGuard"] = { perDay: 0, watchMin: 0, paths: 0 }
const NO_SHIP_DESK: Ops["shipDesk"] = { cardsPerMonth: 0, keepDays: 0, images: 0 }

/**
 * The part of a plan's caps that the account's surfaces may show, given the perks listed for it. The model caps
 * (rank, usage multiple, requests at once and a minute, the daily limit, the longest context, fast lanes), report
 * tags, and Velocity and Labs (always "Coming") are always here. A perk's field appears only while that perk is listed,
 * and a field of an unlisted perk is left out. Where one object holds several perks (scheduled runs inside
 * `cloudAgents`, the three ops perks inside `ops`, read-first inside `reports`), an unlisted perk's numbers read 0 and
 * its flag false: none. `previewModels` is left out: preview models are shown from the catalog once one exists.
 * The answer is a fresh copy, so a caller can change it without touching `ENTITLEMENTS`.
 */
export function publicEntitlements(plan: PlanId, listed: ReadonlySet<PerkId>): Partial<Entitlements> {
  const caps = ENTITLEMENTS[plan]
  if (!caps) return {}
  const has = (perk: PerkId) => listed.has(perk)
  const view: { -readonly [K in keyof Entitlements]?: Entitlements[K] } = {
    rank: caps.rank,
    usageMultiple: caps.usageMultiple,
    inFlight: caps.inFlight,
    perMinute: caps.perMinute,
    dailyShare: caps.dailyShare,
    contextMax: caps.contextMax,
    fastLanes: caps.fastLanes,
    reports: { ...caps.reports, readFirst: caps.reports.readFirst && has("reports-first") },
    velocity: caps.velocity,
    labs: caps.labs,
  }
  if (has("priority")) view.priority = caps.priority
  if (has("brain")) view.purposeShare = { ...caps.purposeShare }
  if (has("github-agents"))
    view.cloudAgents = {
      ...caps.cloudAgents,
      scheduledPerDay: has("scheduled") ? caps.cloudAgents.scheduledPerDay : 0,
    }
  if (has("remote")) view.remote = { ...caps.remote }
  if (has("vault")) view.vault = { ...caps.vault }
  if (has("computer")) view.hosted = caps.hosted && { ...caps.hosted, sizes: [...caps.hosted.sizes] }
  if (has("overnight")) view.overnight = caps.overnight && { ...caps.overnight }
  if (has("on-call") || has("release-guard") || has("ship-desk"))
    view.ops = caps.ops && {
      onCall: { ...(has("on-call") ? caps.ops.onCall : NO_ON_CALL) },
      releaseGuard: { ...(has("release-guard") ? caps.ops.releaseGuard : NO_RELEASE_GUARD) },
      shipDesk: { ...(has("ship-desk") ? caps.ops.shipDesk : NO_SHIP_DESK) },
    }
  if (has("second-opinion")) view.secondOpinion = caps.secondOpinion
  if (has("playbooks")) view.playbooks = caps.playbooks
  if (has("vote")) {
    view.vote = caps.vote
    view.nominate = caps.nominate
  }
  if (has("founding")) view.foundingBoost = caps.foundingBoost
  return view
}

/* The plan cache. Only reconcile writes a snapshot; every other service reads it. */

export const PLAN_STATES = ["none", "active", "renewing", "paused", "ended", "frozen"] as const
export type PlanState = (typeof PLAN_STATES)[number]

export const PLAN_REASONS = [
  "payment_failed",
  "action_required",
  "payment_pending",
  "canceled",
  "refunded",
  "disputed",
  "early_fraud_warning",
  "closing",
  "owner",
] as const
export type PlanReason = (typeof PLAN_REASONS)[number]

export type EntitlementSnapshot = {
  readonly v: 1
  readonly version: number
  readonly livemode: boolean
  readonly account: string
  readonly state: PlanState
  readonly reason?: PlanReason
  readonly plan: PlanId | null
  readonly subscription?: string
  /** Milliseconds since the epoch. */
  readonly periodStart: number
  /** Milliseconds since the epoch. */
  readonly periodEnd: number
  /** `${subscription}:${periodStart}`; new at every new period, including the one an upgrade starts. */
  readonly meterEpoch: string
  readonly cancelAtPeriodEnd: boolean
  /** A downgrade that takes effect at renewal. */
  readonly scheduled?: { readonly plan: PlanId; readonly at: number }
  readonly founding?: { readonly number: number; readonly boost: boolean }
  readonly firstPaidAt?: number
  readonly firstHighPaidAt?: number
  /** The start of an unbroken Max or Ultra run. Private. */
  readonly memberSince?: number
  readonly ramp: { readonly hostedUntil: number; readonly poolUntil?: number; readonly browserFrom: number }
  /** Run tokens and relay sessions issued before this are invalid. */
  readonly revokedBefore?: number
  /** The effective caps, ramps applied. */
  readonly caps: Entitlements
  readonly updatedAt: number
  readonly checkedAt: number
  readonly source: "webhook" | "replay" | "sweep" | "request" | "owner" | "outbox"
}
