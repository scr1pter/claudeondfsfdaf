import { Option, Schema } from "effect"
import {
  publicEntitlements,
  type EntitlementSnapshot,
  type PerkId,
} from "../../packages/schema/src/codium-entitlements.js"
import { CodiumPlan } from "../../packages/schema/src/codium-plan.js"
import {
  modelPlanStatus,
  readEntitlement,
  readModelPlanAccount,
  type ModelPlanStatusRead,
} from "./model-plan-account.js"
import { requireBillingUser } from "./model-plan-billing.js"
import {
  planView,
  servedPlanModels,
  verifiedGatewayModel,
  type ModelPlanCatalogOptions,
} from "./model-plan-catalog-policy.js"
import { modelPlanReservation, modelPlansEnabled } from "./model-plan-config.js"
import { pausedPayment, statusCacheKey } from "./codium-snapshot.js"
import { modelSpendStale } from "./codium-spend-ledger.js"
import { readSwitch } from "./codium-switches.js"
import { usdToMicro } from "./codium-pool.js"
import { renewalGraceMinutes } from "./codium-limits.js"
import { persistentStore } from "./persistent-store.js"
import { handleApiError, json, requireMethod, type ApiRequest, type ApiResponse } from "./http.js"

const DAY_MS = 86_400_000
/** §4.11: a status answer is kept 30 s per account, and reconcile clears it (codium-snapshot.ts WRITE). */
export const STATUS_CACHE_MS = 30_000

export type ModelPlanStatusOptions = ModelPlanCatalogOptions & { meters?: StatusMeterRegistry }

/**
 * `GET /api/model-plans/status` (§4.11): the signed-in account's plan as its own screens show it, in shares of the month,
 * public counts and timestamps only (P1). A browser session or an account token, never a run token (S3).
 */
export async function handleModelPlanStatus(
  request: ApiRequest,
  response: ApiResponse,
  fetcher: typeof fetch = fetch,
  options: ModelPlanStatusOptions = {},
) {
  try {
    requireMethod(request, "GET")
    // The website signs in with a browser session; the desktop app and CLI hold a signed Vector account token.
    const account = await requireBillingUser(request, fetcher)
    // Codium serves models only while it is deployed on and the owner's `codium` switch is on; chat, estimate and
    // `/models` refuse otherwise. Both are read beside the cached body, never kept in it.
    const enabled = modelPlansEnabled() && (await readSwitch("codium", fetcher)) === "on"
    // Perks are listed from A27 on (`listedPerks`, §4.14); until then no perk, entitlement row or meter is listed.
    const listed: PerkId[] = []
    if (!process.env.STRIPE_SECRET_KEY) {
      json(response, 200, {
        enabled,
        active: false,
        access: false,
        listed,
        purchased: { bought: false },
        empty: true,
        low: false,
      })
      return
    }
    const body = await accountStatus(account.id, listed, fetcher, options)
    // While Codium is off no request can start; the plan and its figures still show.
    json(response, 200, { enabled, ...body, ...(enabled ? {} : { access: false }) })
  } catch (error) {
    handleApiError(response, error)
  }
}

/**
 * The status body for one account. An account without a Codium record is never a customer: no snapshot read, no
 * reconcile (M4). Otherwise the snapshot is read by the read rules, and a body cached for that same snapshot version
 * is answered as it is. The version check matters: reconcile clears the cache when it writes, but a status computed
 * from the previous snapshot could still store its answer after that; it is then never served for the new version.
 */
async function accountStatus(
  id: string,
  listed: readonly PerkId[],
  fetcher: typeof fetch,
  options: ModelPlanStatusOptions,
  now = Date.now(),
) {
  const record = await readModelPlanAccount(id, fetcher)
  if (!record) return modelPlanBalance({ active: false, access: false }, { listed, now })
  if (record.closing) return modelPlanBalance({ active: false, customer: true, access: false }, { listed, now })
  const snapshot = await readEntitlement(id, fetcher, now)
  // Only while another request is still writing this account's first snapshot: read again shortly.
  if (!snapshot) throw modelSpendStale()
  const cached = cachedBody(await persistentStore(["GET", statusCacheKey(id)], fetcher), snapshot.version)
  if (cached) return cached
  const status = await modelPlanStatus(id, fetcher, now, snapshot)
  const usable = status.active && (snapshot.state === "active" || snapshot.state === "renewing")
  const body = modelPlanBalance(status, {
    listed,
    now,
    cheapestMicro:
      usable && snapshot.plan ? await cheapestReservation(snapshot.plan, options, fetcher, now) : undefined,
    meters: status.active ? await (options.meters ?? statusMeters).read(snapshot, listed, fetcher) : undefined,
  })
  const ttl = Math.min(
    STATUS_CACHE_MS,
    ...[
      snapshot.periodEnd,
      snapshot.periodEnd + renewalGraceMinutes() * 60_000,
      now - (now % DAY_MS) + DAY_MS,
      snapshot.ramp.poolUntil ?? 0,
    ]
      .filter((at) => at > now)
      .map((at) => at - now),
  )
  await persistentStore(
    ["SET", statusCacheKey(id), JSON.stringify({ version: snapshot.version, body }), "PX", ttl],
    fetcher,
  )
  return body
}

const StatusCache = Schema.Struct({ version: Schema.Number, body: Schema.Record(Schema.String, Schema.Unknown) })
function cachedBody(raw: unknown, version: number) {
  if (typeof raw !== "string") return undefined
  const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(StatusCache))(raw))
  return decoded?.version === version ? decoded.body : undefined
}

/**
 * The smallest fixed reservation of a model this plan may use now (served, unlocked, its plan variant qualified), in
 * micro-dollars: below it the gateway refuses every request. Undefined when no model is served, as in production
 * until route evidence is accepted.
 */
async function cheapestReservation(
  plan: CodiumPlan.PlanId,
  options: ModelPlanCatalogOptions,
  fetcher: typeof fetch,
  now: number,
) {
  const reservation = options.reservation ?? modelPlanReservation
  const required = (await servedPlanModels(options, fetcher)).flatMap((model) => {
    const view = planView(model, plan, options.qualify ?? verifiedGatewayModel, now)
    return view.access && view.served ? [reservation(view.effective, plan).requiredMicro] : []
  })
  return required.length ? Math.min(...required) : undefined
}

/**
 * The account's Codium balance as every Vector screen shows it: the whole-percent share of this month's credits left,
 * and whether the credits are running low or too low for any request. The gateway accounts in provider-cost USD; an
 * amount beside a plan's price would reveal what the plan buys, so no amount, and no fixed-amount threshold whose share
 * would give one away, leaves the server (P1). `cheapestMicro` is the smallest reservation of a served, unlocked model
 * (`empty` below it); without one, `empty` means nothing is left.
 */
export function modelPlanBalance(
  status: ModelPlanStatusRead,
  input: { listed?: readonly PerkId[]; cheapestMicro?: number; meters?: StatusMeters; now?: number } = {},
) {
  const listed = [...(input.listed ?? [])]
  const now = input.now ?? Date.now()
  // Codium sells monthly plans only (no top-ups). Decoders up to 1.99.112 require this field, so it is always sent,
  // and always says nothing was bought (H7).
  const purchased = { bought: false as const }
  if (!status.active)
    return {
      active: false,
      ...(status.customer ? { customer: true } : {}),
      access: false,
      listed,
      purchased,
      empty: true,
      low: false,
    }
  const snapshot = status.snapshot
  const plan = status.plan
  const caps = snapshot.caps
  const spends = snapshot.state === "active" || snapshot.state === "renewing"
  const payment = snapshot.state === "paused" ? pausedPayment(snapshot) : undefined
  const idleMicro = status.idleAvailable === undefined ? undefined : usdToMicro(status.idleAvailable)
  // ADMIT refuses a request unless what is available (M3) covers the model's fixed reservation, so below the cheapest
  // such reservation every request is refused. Abandoned reservations and live nonmodel holds count, as there; live
  // model reservations do not, since they settle within minutes and ADMIT's refusal then says to wait for them. A
  // paused or frozen plan is not "empty": it shows its notice.
  const empty =
    spends &&
    idleMicro !== undefined &&
    (idleMicro <= 0 || (input.cheapestMicro !== undefined && idleMicro < input.cheapestMicro))
  const day = status.day && status.access ? status.day : undefined
  const forecast =
    status.used === undefined || !status.credits
      ? undefined
      : forecastDate({
          used: status.used / status.credits,
          periodStart: status.periodStart,
          periodEnd: status.periodEnd,
          now,
        })
  return {
    active: true,
    customer: true,
    access: status.access,
    plan: {
      id: plan,
      name: CodiumPlan.name(plan) ?? plan,
      ...(status.remaining === undefined || status.credits === undefined
        ? {}
        : { left: share(status.remaining, status.credits) }),
      renewsAt: status.periodEnd,
      cancelAtPeriodEnd: status.cancelAtPeriodEnd,
      state: snapshot.state,
      ...(payment ?? (snapshot.reason ? { reason: snapshot.reason } : {})),
      ...(snapshot.scheduled
        ? {
            scheduled: {
              id: snapshot.scheduled.plan,
              name: CodiumPlan.name(snapshot.scheduled.plan) ?? snapshot.scheduled.plan,
              at: snapshot.scheduled.at,
            },
          }
        : {}),
      ...(day
        ? {
            today: {
              used: day.limitMicro > 0 ? share(day.usedMicro, day.limitMicro) : 1,
              resetsAt: now - (now % DAY_MS) + DAY_MS,
              // ADMIT's daily check (`day + required > floor(total × dailyShare)`) for the cheapest request, on the
              // day without the requests still running, as `empty` leaves them out. Display only: the gateway decides.
              reached:
                day.usedMicro >= day.limitMicro ||
                (input.cheapestMicro !== undefined && day.usedMicro + input.cheapestMicro > day.limitMicro),
            },
          }
        : {}),
      ...(forecast ? { forecastDate: forecast } : {}),
      ...(snapshot.ramp.poolUntil !== undefined && snapshot.ramp.poolUntil > now
        ? { ramp: { until: snapshot.ramp.poolUntil } }
        : {}),
    },
    listed,
    entitlements: publicEntitlements(plan, new Set(listed)),
    ...(input.meters ? { meters: input.meters } : {}),
    ...(caps.velocity ? { velocity: caps.velocity } : {}),
    ...(caps.labs ? { labs: caps.labs } : {}),
    purchased,
    empty,
    // Running low is a tenth of this month's credits.
    low:
      spends &&
      !empty &&
      status.remaining !== undefined &&
      status.credits !== undefined &&
      status.remaining < status.credits / 10,
  }
}

/**
 * The day the month runs out at its average pace so far, as an ISO date (A32 adds the 7-day line and history). Hidden
 * in the first 3 days, under 5% used, and when the month lasts to its end (§4.11, A32).
 */
export function forecastDate(input: { used: number; periodStart: number; periodEnd: number; now: number }) {
  const elapsed = input.now - input.periodStart
  if (elapsed < 3 * DAY_MS || !(input.used >= 0.05) || input.used >= 1) return undefined
  const runsOut = input.periodStart + elapsed / input.used
  return runsOut < input.periodEnd ? new Date(runsOut).toISOString().slice(0, 10) : undefined
}

function share(left: number, total: number) {
  return total > 0 ? Math.round(Math.min(1, Math.max(0, left / total)) * 100) / 100 : 0
}

// ── Meters (§4.11 `meters`): services register their own reader; A18 registers none ─────────────────────────────

/** Each meter's fields as §4.11 declares them: shares in 0..1, whole counts, or flags. Nothing else is sent. */
const METER_FIELDS = {
  cloudAgents: { used: "share", exhausted: "flag" },
  hosted: { used: "share" },
  brain: { used: "share", cap: "share" },
  vault: { usedBytes: "count", quotaBytes: "count" },
  remote: { computers: "count", limit: "count" },
  shipDesk: { used: "share" },
} as const satisfies Record<string, Record<string, "share" | "count" | "flag">>
export type StatusMeterName = keyof typeof METER_FIELDS
type MeterValue<N extends StatusMeterName> = {
  [F in keyof (typeof METER_FIELDS)[N]]: (typeof METER_FIELDS)[N][F] extends "flag" ? boolean : number
}
export type StatusMeters = { [N in StatusMeterName]?: MeterValue<N> }
/** `signal` aborts when the reader's time is up (`METER_TIMEOUT_MS`); a reader passes it on to its own requests. */
export type StatusMeterReader<N extends StatusMeterName> = (
  snapshot: EntitlementSnapshot,
  fetcher: typeof fetch,
  signal: AbortSignal,
) => Promise<MeterValue<N> | undefined>
export type StatusMeterRegistry = ReturnType<typeof createStatusMeterRegistry>
/** How long one meter's reader may take before its meter is left out of the status. */
export const METER_TIMEOUT_MS = 1_500

/**
 * Status meters, one reader per meter, each shown only while its perk is listed. A reader's answer is checked against
 * the meter's declared fields: a share outside 0..1, a count that is not a whole number, a missing field or a reader
 * that fails (throws, rejects, or has not answered within `METER_TIMEOUT_MS`) drops that meter, never the status.
 * Independent registries keep tests from replacing production ones.
 */
export function createStatusMeterRegistry() {
  const meters = new Map<StatusMeterName, { perk: PerkId; read: StatusMeterReader<StatusMeterName> }>()
  return {
    register<N extends StatusMeterName>(perk: PerkId, name: N, read: StatusMeterReader<N>) {
      if (!Object.hasOwn(METER_FIELDS, name) || meters.has(name) || typeof read !== "function")
        throw new Error("A Codium status meter must have exactly one reader.")
      meters.set(name, { perk, read: read as StatusMeterReader<StatusMeterName> })
    },
    async read(snapshot: EntitlementSnapshot, listed: readonly PerkId[], fetcher: typeof fetch) {
      const read = await Promise.all(
        [...meters]
          .filter(([, meter]) => listed.includes(meter.perk))
          .map(async ([name, meter]) => {
            const signal = AbortSignal.timeout(METER_TIMEOUT_MS)
            // `then` turns a reader that throws before returning its promise into a rejection like any other.
            const value = await Promise.race([
              Promise.resolve().then(() => meter.read(snapshot, fetcher, signal)),
              new Promise<undefined>((resolve) =>
                signal.addEventListener("abort", () => resolve(undefined), { once: true }),
              ),
            ]).catch(() => undefined)
            return [name, meterValue(name, value)] as const
          }),
      )
      const shown = read.filter((entry) => entry[1] !== undefined)
      return shown.length ? (Object.fromEntries(shown) as StatusMeters) : undefined
    },
  }
}
const statusMeters = createStatusMeterRegistry()

/** Services register their meter through static imports, beside their provisioner. */
export function registerStatusMeter<N extends StatusMeterName>(perk: PerkId, name: N, read: StatusMeterReader<N>) {
  statusMeters.register(perk, name, read)
}

function meterValue(name: StatusMeterName, value: unknown) {
  if (typeof value !== "object" || value === null) return undefined
  const fields = Object.entries(METER_FIELDS[name]).map(([field, kind]) => {
    const raw = (value as Record<string, unknown>)[field]
    if (kind === "flag") return typeof raw === "boolean" ? [field, raw] : undefined
    if (kind === "count") return Number.isSafeInteger(raw) && Number(raw) >= 0 ? [field, raw] : undefined
    return typeof raw === "number" && raw >= 0 && raw <= 1 ? [field, Math.round(raw * 100) / 100] : undefined
  })
  return fields.every((field) => field !== undefined) ? Object.fromEntries(fields) : undefined
}
