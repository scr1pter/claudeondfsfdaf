import { createHash, randomUUID } from "node:crypto"
import { Option, Schema } from "effect"
import { PERK_IDS } from "../../packages/schema/src/codium-entitlements.js"
import { enforceRateLimit, requireTrustedJsonRequest } from "./abuse.js"
import { codiumKey } from "./codium-keys.js"
import { OWNER_AUDIT_SCRIPT } from "./codium-owner.js"
import { readOwnerCodiumDashboard } from "./codium-owner-dashboard.js"
import { SWITCH_NAMES, writeDisabledItem, writeSwitch, type SwitchName, type SwitchValue } from "./codium-switches.js"
import { ApiError, handleApiError, json, readJson, requireMethod, type ApiRequest, type ApiResponse } from "./http.js"
import {
  clearModelPlanRisk,
  refundEndModelPlanAccount,
  reconcileModelPlanAccount,
  type OwnerRefundQuote,
} from "./model-plan-account.js"
import { configuredPlanModels } from "./model-plan-config.js"
import { stripeRecord } from "./model-plan-stripe.js"
import { persistentStore } from "./persistent-store.js"
import { requireUsageOwner } from "./usage.js"
import { replayStripeEvents } from "../model-plans/replay.js"

export type CodiumOwnerAction = "dashboard" | "switch" | "reconcile" | "replay" | "clear-risk" | "refund-end"
export const ownerAuditKey = () => codiumKey("owner", "audit")
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const KEEP_MS = 90 * 86_400_000

/** Every mutation authenticates the same verified Google session before checking its original OAuth sign-in time. */
export async function handleCodiumOwner(
  request: ApiRequest,
  response: ApiResponse,
  action: CodiumOwnerAction,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  response.setHeader("x-robots-tag", "noindex, nofollow, noarchive")
  try {
    requireMethod(request, action === "dashboard" ? "GET" : "POST")
    const owner = await requireUsageOwner(request, fetcher)
    const actor = `owner:${createHash("sha256").update(owner.email).digest("hex")}`
    if (action !== "dashboard") {
      requireRecentGoogleSignIn(request, now)
      requireTrustedJsonRequest(request, 4096)
    }
    await enforceRateLimit(
      request,
      response,
      {
        scope: action === "dashboard" ? "codium-owner-read" : "codium-owner-write",
        identifier: actor,
        limit: action === "dashboard" ? 120 : 30,
        windowSeconds: 3600,
        requirePersistent: true,
      },
      fetcher,
    )
    if (action === "dashboard") return json(response, 200, await readOwnerCodiumDashboard(fetcher, now))
    const raw = await readJson<unknown>(request, 4096)
    if (!stripeRecord(raw)) throw invalid()
    const account =
      action === "reconcile" || action === "clear-risk" || action === "refund-end" ? accountID(raw.account) : undefined
    const prepared = prepare(action, raw, now)
    const operation = randomUUID()
    await audit(
      { id: operation, at: now, actor, action, ...(account ? { account } : {}), outcome: "requested" },
      fetcher,
    )
    const result = await run(action, prepared, account, actor, fetcher, now)
    await audit(
      { id: operation, at: now, actor, action, ...(account ? { account } : {}), outcome: "completed" },
      fetcher,
    )
    json(response, 200, { accepted: true, ...result })
  } catch (error) {
    handleApiError(response, error)
  }
}

function prepare(action: Exclude<CodiumOwnerAction, "dashboard">, raw: Record<string, unknown>, now: number) {
  if (action === "switch") {
    if (typeof raw.name !== "string" || typeof raw.value !== "string") throw invalid()
    const dynamic = /^(model-off|perk-off):(.+)$/.exec(raw.name)
    if (dynamic) {
      if (!["on", "off"].includes(raw.value)) throw invalid()
      if (
        raw.value === "off" &&
        (dynamic[1] === "model-off"
          ? !configuredPlanModels().some((model) => model.id === dynamic[2])
          : !(PERK_IDS as readonly string[]).includes(dynamic[2]!))
      )
        throw invalid()
    } else if (
      !(SWITCH_NAMES as readonly string[]).includes(raw.name) ||
      !(raw.name === "hosted" ? ["on", "no-new", "stop"] : ["on", "off"]).includes(raw.value)
    )
      throw invalid()
  }
  if (
    action === "replay" &&
    (!Number.isSafeInteger(raw.since) ||
      Number(raw.since) < Math.floor(now / 1000) - 30 * 86_400 ||
      Number(raw.since) > Math.floor(now / 1000))
  )
    throw new ApiError(400, "REPLAY_SINCE_INVALID", "Choose a replay start in the last 30 days, in Unix seconds.")
  if (action === "refund-end") {
    if (
      !(
        raw.expectedCharge === null ||
        (typeof raw.expectedCharge === "string" && /^(ch|py)_[A-Za-z0-9]+$/.test(raw.expectedCharge))
      ) ||
      !Number.isSafeInteger(raw.expectedRefundCents) ||
      Number(raw.expectedRefundCents) < 0 ||
      !(
        raw.expectedSubscription === null ||
        (typeof raw.expectedSubscription === "string" && /^sub_[A-Za-z0-9]+$/.test(raw.expectedSubscription))
      ) ||
      !(
        raw.expectedPeriodStart === null ||
        (Number.isSafeInteger(raw.expectedPeriodStart) && Number(raw.expectedPeriodStart) >= 0)
      )
    )
      throw invalid()
  }
  return raw
}
async function run(
  action: Exclude<CodiumOwnerAction, "dashboard">,
  raw: Record<string, unknown>,
  account: string | undefined,
  actor: string,
  fetcher: typeof fetch,
  now: number,
): Promise<Record<string, unknown>> {
  if (action === "switch") {
    const name = String(raw.name)
    const dynamic = /^(model-off|perk-off):(.+)$/.exec(name)
    if (dynamic)
      await writeDisabledItem(
        dynamic[1] === "model-off" ? "models-off" : "perks-off",
        dynamic[2]!,
        raw.value === "off",
        actor,
        fetcher,
        now,
      )
    else await writeSwitch(name as SwitchName, raw.value as SwitchValue, actor, fetcher, now)
    return {}
  }
  if (action === "replay")
    return { result: await replayStripeEvents({ fetcher, now, since: Number(raw.since), budgetMs: 40_000 }) }
  if (!account) throw invalid()
  if (action === "reconcile") {
    await reconcileModelPlanAccount(account, fetcher, now, { source: "owner" })
    return {}
  }
  if (action === "clear-risk") {
    await clearModelPlanRisk(account, fetcher, now)
    return {}
  }
  const expected: OwnerRefundQuote = {
    expectedCharge: raw.expectedCharge as string | null,
    expectedRefundCents: Number(raw.expectedRefundCents),
    expectedSubscription: raw.expectedSubscription as string | null,
    expectedPeriodStart: raw.expectedPeriodStart as number | null,
  }
  return { operation: await refundEndModelPlanAccount(account, expected, fetcher, now) }
}
async function audit(
  record: { id: string; at: number; actor: string; action: string; account?: string; outcome: string },
  fetcher: typeof fetch,
) {
  const result = await persistentStore(
    ["EVAL", OWNER_AUDIT_SCRIPT, 1, ownerAuditKey(), record.at, JSON.stringify(record), record.at - KEEP_MS, KEEP_MS],
    fetcher,
  )
  if (result !== 1) throw new ApiError(503, "CODIUM_AUDIT_UNAVAILABLE", "The owner action could not be recorded.")
}
function accountID(value: unknown) {
  if (typeof value !== "string" || !UUID.test(value)) throw invalid()
  return value
}
function invalid() {
  return new ApiError(400, "CODIUM_OWNER_REQUEST", "Check the owner action and try again.")
}

/** Supabase verified this token above; refreshing JWT/MFA must not refresh the original OAuth sign-in. */
function requireRecentGoogleSignIn(request: ApiRequest, now: number) {
  const value = request.headers.authorization
  const header = Array.isArray(value) ? value[0] : value
  const token = /^Bearer\s+(.+)$/i.exec(header ?? "")?.[1]
  const payload = token?.split(".")[1]
  const claims = payload
    ? Option.getOrUndefined(
        Schema.decodeUnknownOption(
          Schema.fromJsonString(
            Schema.Struct({ amr: Schema.Array(Schema.Struct({ method: Schema.String, timestamp: Schema.Number })) }),
          ),
        )(Buffer.from(payload, "base64url").toString("utf8")),
      )
    : undefined
  const oauth = (claims?.amr ?? []).filter(
    (entry) =>
      entry.method === "oauth" &&
      Number.isFinite(entry.timestamp) &&
      entry.timestamp >= 0 &&
      entry.timestamp * 1000 <= now,
  )
  const latest = Math.max(0, ...oauth.map((entry) => entry.timestamp * 1000))
  if (!oauth.length || now - latest >= 10 * 60_000)
    throw new ApiError(401, "RECENT_SIGN_IN_REQUIRED", "Sign in with Google again to confirm this owner action.")
}
