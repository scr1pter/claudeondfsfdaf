import { modelPlanStatus, readModelPlanAccount } from "./model-plan-account.js"
import { modelPlansEnabled } from "./model-plan-config.js"

/*
 * The @vector entitlement seam (vector-at-mention-spec 2.3). The mint, the ledger and the run-token verifier learn what
 * an account may run only from cloudAgentEntitlement and cloudAgentRevokedBefore, so Codium's integration commit (A59)
 * is the one edit this file gets: it replaces those two bodies, swaps the local types for Codium's, re-exports
 * RUN_SOURCES and ENABLED_SOURCES from ../../packages/schema/src/codium-run-trigger.js, and deletes the marked local
 * backing block at the end of the file, the imports above that only the block uses, and
 * packages/web/test/cloud-agents-entitlement.test.ts. The names differ from Codium's on purpose, so no import is ever
 * aliased. Values carry hours, counts and shares only, never an amount.
 */

/** Codium's monthly plan ids (`CodiumPlan.PLANS`). */
export type CodiumPlanId = "vector-10" | "vector-50" | "vector-100" | "vector-200"

/** Every way a run can start, in Codium's order (`packages/schema/src/codium-run-trigger.ts`). */
export const RUN_SOURCES = [
  "desktop",
  "cli",
  "phone",
  "schedule",
  "ops",
  "github-comment",
  "github-dispatch",
  "github-schedule",
  "slack",
  "linear",
  "jira",
] as const
export type RunSource = (typeof RUN_SOURCES)[number]

const RESERVED: readonly RunSource[] = ["slack", "linear", "jira"]

/** The sources a run may start from today: every source except the reserved ones. */
export const ENABLED_SOURCES: ReadonlySet<RunSource> = new Set(
  RUN_SOURCES.filter((source) => !RESERVED.includes(source)),
)

export type RunTrigger = {
  readonly source: RunSource
  readonly account: string
  /** Who asked, on the platform the trigger came from. */
  readonly requestedBy?: { readonly platform: string; readonly userId: string }
  readonly target:
    | { readonly kind: "github-run"; readonly repositoryId: number; readonly branch?: string }
    | { readonly kind: "hosted-job"; readonly size?: "standard" | "large" }
  readonly prompt: string
  /** Success criteria a second lab checks the result against. */
  readonly criteria?: readonly string[]
  /** Milliseconds since the epoch. */
  readonly deliverBy?: number
  readonly purpose: "task" | "review" | "scheduled" | "incident" | "changes"
}

/** Runs at once, agent hours a month, the longest run in minutes, scheduled runs a day, one run's share of a month. */
export type CloudAgentLimits = {
  atOnce: number
  hours: number
  longestRunMin: number
  scheduledPerDay: number
  runCeilingShare: number
}

export type CloudAgentAllowance =
  | {
      active: true
      plan: CodiumPlanId
      limits: CloudAgentLimits
      allowanceSeconds: number
      meterEpoch: string
      /** Milliseconds since the epoch. */
      periodEnd: number
      premiumModels: boolean
      /** Milliseconds since the epoch: run tokens issued before it are refused. */
      revokedBefore?: number
    }
  | {
      active: false
      reason:
        | "none"
        | "payment"
        | "dispute"
        | "fraud"
        | "closing"
        | "service-off"
        | "source-unavailable"
        | "not-in-plan"
    }

/**
 * What `accountId` may run on Codium for a run from `input.source`: its plan's limits, its hours in seconds, the meter
 * epoch its hours are counted under and when its period ends, or why it may not run. The reason is for the server: the
 * mint answers neutral codes (spec 2.9.1). A store or billing failure rejects, and every caller fails closed.
 */
export function cloudAgentEntitlement(
  accountId: string,
  input: { source: RunSource; now?: number },
  fetcher: typeof fetch = fetch,
): Promise<CloudAgentAllowance> {
  return localEntitlement(accountId, input, fetcher)
}

/**
 * When the account's earlier run tokens stopped being valid, in milliseconds since the epoch, or undefined when none
 * were revoked. The verifier compares it with a token's `iat`, also in milliseconds (spec 2.4). Nothing revokes run
 * tokens before A59, which returns Codium's `runTokensRevokedBefore(accountId, fetcher)`; that read fails closed (503)
 * when its mark cannot be read, so callers must treat a rejection as a refusal.
 */
export async function cloudAgentRevokedBefore(
  accountId: string,
  fetcher: typeof fetch = fetch,
): Promise<number | undefined> {
  return undefined
}

// ── Local backing until A59 (Codium deletes from here to the end of the file) ────────────────────────────────────────

/** Each plan's @vector limits: the Codium contract's §4.1 `cloudAgents` row. Only this module and its test name it. */
export const CLOUD_AGENT_LIMITS: Readonly<Record<CodiumPlanId, CloudAgentLimits>> = Object.freeze({
  "vector-10": Object.freeze({ atOnce: 1, hours: 5, longestRunMin: 30, scheduledPerDay: 0, runCeilingShare: 0.1 }),
  "vector-50": Object.freeze({ atOnce: 1, hours: 15, longestRunMin: 45, scheduledPerDay: 0, runCeilingShare: 0.1 }),
  "vector-100": Object.freeze({ atOnce: 2, hours: 40, longestRunMin: 45, scheduledPerDay: 5, runCeilingShare: 0.1 }),
  "vector-200": Object.freeze({ atOnce: 6, hours: 120, longestRunMin: 120, scheduledPerDay: 20, runCeilingShare: 0.1 }),
})

// The mint retries an at-once refusal every 30 s, so an account's plan is read at most once a minute.
const PLAN_CACHE_MS = 60_000

type PlanAnswer =
  | { active: false; closing?: boolean }
  | { active: true; plan: CodiumPlanId; periodStart: number; periodEnd: number }

/**
 * The seam over an injected switch and plan source. It answers `service-off` while the switch is off, then
 * `source-unavailable` for a reserved or unknown source, and only then asks `plan()`, through a per-account cache, so
 * neither check can be answered from a cached plan. Locally only `service-off`, `source-unavailable`, `none` and
 * `closing` arise; `payment`, `dispute`, `fraud` and `not-in-plan` come only from Codium's snapshot after A59.
 */
export function createCloudAgentEntitlement(deps: {
  enabled(): boolean
  plan(accountId: string, fetcher: typeof fetch): Promise<PlanAnswer>
}): typeof cloudAgentEntitlement {
  const cache = new Map<string, { at: number; answer: Promise<PlanAnswer> }>()
  const fresh = (entry: { at: number }, now: number) => now >= entry.at && now - entry.at < PLAN_CACHE_MS
  const planFor = (accountId: string, now: number, fetcher: typeof fetch) => {
    const cached = cache.get(accountId)
    if (cached && fresh(cached, now)) return cached.answer
    // Expired reads go on a miss, so a warm instance does not keep one entry for every account it ever served.
    cache.forEach((entry, id) => {
      if (!fresh(entry, now)) cache.delete(id)
    })
    const entry = { at: now, answer: deps.plan(accountId, fetcher) }
    cache.set(accountId, entry)
    // A failed read is never kept, so the next call asks again. A slow read that fails after a newer one replaced it
    // leaves the newer one in place.
    entry.answer.catch(() => {
      if (cache.get(accountId) === entry) cache.delete(accountId)
    })
    return entry.answer
  }
  return async (accountId, input, fetcher = fetch) => {
    if (!deps.enabled()) return { active: false, reason: "service-off" }
    if (!ENABLED_SOURCES.has(input.source)) return { active: false, reason: "source-unavailable" }
    const answer = await planFor(accountId, input.now ?? Date.now(), fetcher)
    if (!answer.active) return { active: false, reason: answer.closing ? "closing" : "none" }
    // A plan the table does not hold, such as a new Codium plan or a prototype key, grants nothing.
    if (!Object.hasOwn(CLOUD_AGENT_LIMITS, answer.plan)) return { active: false, reason: "none" }
    const limits = { ...CLOUD_AGENT_LIMITS[answer.plan] }
    return {
      active: true,
      plan: answer.plan,
      limits,
      allowanceSeconds: limits.hours * 3600,
      meterEpoch: `p${answer.periodStart}`,
      periodEnd: answer.periodEnd,
      premiumModels: answer.plan === "vector-100" || answer.plan === "vector-200",
    }
  }
}

const localEntitlement = createCloudAgentEntitlement({
  // Both switches are read on every call. VECTOR_CLOUD_AGENTS_ENABLED stays unset in production until A59 (O10).
  enabled: () => modelPlansEnabled() && process.env.VECTOR_CLOUD_AGENTS_ENABLED === "true",
  async plan(accountId, fetcher) {
    if ((await readModelPlanAccount(accountId, fetcher))?.closing) return { active: false, closing: true }
    // Status may still display a paid plan while payment, risk or its current period blocks access.
    const status = await modelPlanStatus(accountId, fetcher)
    if (!status.active || !status.access) return { active: false }
    // The entitlement snapshot already gives the period in milliseconds.
    return { active: true, plan: status.plan, periodStart: status.periodStart, periodEnd: status.periodEnd }
  },
})
