import { Option, Schema } from "effect"
import { enforceRateLimit, requireTrustedJsonRequest } from "./abuse.js"
import { CodiumPlan } from "../../packages/schema/src/codium-plan.js"
import { CODIUM_TIER_MODELS } from "./codium-catalog.js"
import { codiumKey } from "./codium-keys.js"
import { requireEntitlement } from "./codium-entitlements.js"
import { modelSpendStale } from "./codium-spend-ledger.js"
import { requireModelPlanCaller } from "./model-plan-caller.js"
import { snapshotPool } from "./model-plan-account.js"
import {
  gatewayPlanModels,
  planView,
  servedPlanModels,
  verifiedGatewayModel,
  type ModelPlanCatalogOptions,
} from "./model-plan-catalog-policy.js"
import { requireModelPlans } from "./model-plan-config.js"
import { persistentStore } from "./persistent-store.js"
import { ApiError, handleApiError, json, readJson, requireMethod, type ApiRequest, type ApiResponse } from "./http.js"
import { Hosted } from "../../packages/schema/src/hosted.js"
import type { EntitlementSnapshot } from "../../packages/schema/src/codium-entitlements.js"
import { hostedCaps, hostedOpen, hostedSnapshot } from "./hosted-entitlement.js"
import { chargeMinuteMicro } from "./hosted-rates.js"

const MAX_BYTES = 4096
/** Units and costs are rounded up to steps this far apart (P2). */
export const ESTIMATE_STEP = 1.5
export const ESTIMATE_MAX_REQUESTS = 100
/** Upper bounds of each band, as a share of the month (or of today's limit); above 1 is "more than your month". */
export const ESTIMATE_BANDS = [
  [0.01, "under 1%"],
  [0.02, "1–2%"],
  [0.05, "2–5%"],
  [0.1, "5–10%"],
  [0.2, "10–20%"],
  [0.4, "20–40%"],
] as const
const BAND_NAMES = [...ESTIMATE_BANDS.map(([, name]) => name), "over 40%", "more than your month"] as const
const Band = Schema.Literals(BAND_NAMES)
const Saved = Schema.Struct({
  answer: Schema.Struct({ share: Band, todayShare: Schema.optional(Band) }),
  poolStep: Schema.Number,
})
const Body = Schema.Struct({
  model: Schema.String,
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  requests: Schema.optional(Schema.Number),
})
const HostedBody = Schema.Struct({ kind: Schema.Literal("hosted"), minutes: Schema.Number, size: Schema.String })

/**
 * `POST /api/model-plans/estimate` (§4.13, model form): roughly what a request would use, as a band of the month and
 * of today's limit, never an amount (P1). An account token (marked or not: one that may read status may read this) or
 * a run token, 20 a minute. P2: every unit is rounded up to a step 1.5× apart, so is the cost they make together, and
 * the pool is rounded down to the same grid, so no combination of inputs resolves the pool finer than one step. Every
 * rounding errs the same way, so an answer never understates a share; requests, tokens, cost and pool each add up to
 * 1.5×, so it overstates by up to about 1.5⁴ ≈ 5× (typically by none or one band, at most three). Each (account,
 * period, pool ramp phase, cost step) keeps its answer, with the pool step it was worked out on, until the period is
 * over, so asking again after a carry raised the pool says nothing new; the ramp's end, which raises the pool about
 * threefold, starts fresh answers. A pool can also fall inside a phase (a carry's source charge refunded or reversed,
 * M6): a kept answer from a higher pool step would then understate, so it is worked out again and replaces the kept one.
 */
export async function handleModelPlanEstimate(
  request: ApiRequest,
  response: ApiResponse,
  fetcher: typeof fetch = fetch,
  options: ModelPlanCatalogOptions = {},
) {
  try {
    requireMethod(request, "POST")
    requireTrustedJsonRequest(request, MAX_BYTES)
    requireModelPlans()
    // Account tokens, marked or not, and run tokens through their verifiers, with chat's sign-in answers. A browser
    // session is not an estimate caller.
    const account = (
      await requireModelPlanCaller(request, fetcher, Date.now(), options.runVerifiers, { unmarked: true })
    ).account.id
    await enforceRateLimit(
      request,
      response,
      { scope: "model-plan-estimate", identifier: account, limit: 20, windowSeconds: 60, requirePersistent: true },
      fetcher,
    )
    const raw = await readJson<unknown>(request, MAX_BYTES)
    const hosted = hostedEstimateBody(raw)
    if (hosted) {
      const { snapshot, step } = await hostedEstimateStep(account, hosted, fetcher)
      await answerStep(response, account, snapshot, step, fetcher)
      return
    }
    const body = estimateBody(raw)
    const catalog = options.models ?? gatewayPlanModels()
    const model = catalog.find((candidate) => candidate.id === body.model)
    // As chat answers: a staged candidate is not served yet; anything else outside the catalog is an invalid request.
    if (!model && CODIUM_TIER_MODELS.some((candidate) => candidate.id === body.model)) throw modelUnavailable()
    if (!model) throw new ApiError(400, "MODEL_PLAN_MODEL", "Choose a model available in Vector Codium.")
    if (!(await servedPlanModels(options, fetcher)).some((served) => served.id === model.id)) throw modelUnavailable()
    const snapshot = await requireEntitlement(account, "codium", fetcher)
    if (!snapshot.plan) throw new ApiError(402, "MODEL_PLAN_REQUIRED", "Choose a Vector Codium plan to use this model.")
    const now = Date.now()
    const view = planView(model, snapshot.plan, options.qualify ?? verifiedGatewayModel, now)
    if (!view.access)
      throw new ApiError(403, "MODEL_PLAN_UPGRADE_REQUIRED", "Change your Codium plan to use this model.", {
        detail: {
          plan: view.lock,
          planName: CodiumPlan.name(view.lock),
          ...(model.previewUntil ? { previewUntil: model.previewUntil } : {}),
        },
      })
    if (!view.served) throw modelUnavailable()
    const step = estimateStep({
      inputTokens: Math.min(body.inputTokens, view.effective.contextLength),
      outputTokens: Math.min(body.outputTokens, view.effective.maxOutputTokens),
      requests: Math.min(body.requests ?? 1, ESTIMATE_MAX_REQUESTS),
      inputPrice: model.inputPrice,
      outputPrice: model.outputPrice,
    })
    await answerStep(response, account, snapshot, step, fetcher)
  } catch (error) {
    handleApiError(response, error)
  }
}

/**
 * Answers cost step `step` for the snapshot's period: the kept answer when there is one from this pool step or above,
 * otherwise a new one, kept until a day after the period ends. The answer depends only on the cost step and the pool,
 * so every kind of estimate shares one answer per step.
 */
async function answerStep(
  response: ApiResponse,
  account: string,
  snapshot: EntitlementSnapshot,
  step: number,
  fetcher: typeof fetch,
) {
  const now = Date.now()
  const pool = await snapshotPool(account, snapshot, fetcher)
  // Only until reconcile has made (or finished replacing) the period's key: read again shortly.
  if (!pool) throw modelSpendStale()
  const dailyShare = snapshot.caps.dailyShare
  const key = codiumKey(
    "estimate",
    account,
    snapshot.meterEpoch,
    pool.ramped ? "ramp" : "full",
    dailyShare ?? "none",
    step,
  )
  const poolStep = floorStep(Math.max(1, pool.totalMicro))
  const raw = await persistentStore(["GET", key], fetcher)
  const saved = savedAnswer(raw, poolStep)
  if (saved) {
    json(response, 200, saved)
    return
  }
  const answer = estimateAnswer(step, pool.totalMicro, dailyShare)
  // The answer for this step stays until a day after the period ends. A first answer is set only while none is kept,
  // so of two parallel first answers both callers get the one stored (unless it is from a higher pool step than
  // theirs); an answer kept from a higher pool step than this one is replaced.
  const stored = await persistentStore(
    [
      "SET",
      key,
      JSON.stringify({ answer, poolStep }),
      ...(typeof raw === "string" ? [] : ["NX"]),
      "PX",
      Math.max(1, snapshot.periodEnd + 86_400_000 - now),
    ],
    fetcher,
  )
  json(
    response,
    200,
    stored === "OK" ? answer : (savedAnswer(await persistentStore(["GET", key], fetcher), poolStep) ?? answer),
  )
}

/**
 * The hosted form (`{kind: "hosted", minutes, size}`, WP A51): a cloud computer job of `minutes` on `size`, clamped
 * to the plan's longest job now, priced at the per-minute rate its blocks are charged at (hosted-rates.ts, never sent).
 * The minutes are put on the 1.5× grid and so is their cost, as the model form's units are (P2). Answered only while the
 * cloud computer can be started for the account (`computer` listed, or the owner's list) and its plan includes it, with
 * the service's refusals; the rate itself never leaves the server (P1).
 */
async function hostedEstimateStep(
  account: string,
  body: { minutes: number; size: Hosted.Size },
  fetcher: typeof fetch,
) {
  if (!(await hostedOpen(account, fetcher)))
    throw new ApiError(503, "HOSTED_UNAVAILABLE", "The cloud computer is not available on Vector yet.")
  const now = Date.now()
  const snapshot = await hostedSnapshot(account, fetcher, now)
  const caps = hostedCaps(snapshot, now)!
  if (!caps.sizes.includes(body.size))
    throw new ApiError(403, "HOSTED_NOT_INCLUDED", "This computer size is not included in your plan.", {
      detail: { perk: "computer", limit: "size", plan: "vector-200" },
    })
  const minutes = Math.min(body.minutes, caps.jobMin)
  return {
    snapshot,
    step: stepOf(Math.max(1, Math.ceil(gridValue(minutes) * chargeMinuteMicro(body.size)))),
  }
}

/** The hosted form's body, or undefined when the body is not a hosted estimate. Other kinds are refused as before. */
function hostedEstimateBody(raw: unknown) {
  if (typeof raw !== "object" || raw === null || !("kind" in raw) || raw.kind !== "hosted") return undefined
  const body = Option.getOrUndefined(Schema.decodeUnknownOption(HostedBody)(raw))
  if (!body || !Number.isSafeInteger(body.minutes) || body.minutes < 1 || !Hosted.isSize(body.size))
    throw new ApiError(400, "HOSTED_REQUEST", "Include a job's minutes and a computer size.")
  return { minutes: body.minutes, size: body.size }
}

/**
 * The cost step of one estimate: each unit (input and output tokens, requests) rounded up to the 1.5× grid, priced at
 * the catalog's price ceilings (micro-dollars per token), and that cost rounded up to the same grid again. Rounding
 * only the units would let two units together land between steps; rounding the cost keeps every answer on the grid.
 */
export function estimateStep(input: {
  inputTokens: number
  outputTokens: number
  requests: number
  inputPrice: number
  outputPrice: number
}) {
  const cost =
    gridValue(input.requests) *
    (gridValue(input.inputTokens) * input.inputPrice + gridValue(input.outputTokens) * input.outputPrice)
  return stepOf(Math.max(1, Math.ceil(cost)))
}

/**
 * The answer for cost step `step` on a pool of `totalMicro`. The pool is rounded down to the same grid as the cost, so
 * the answer depends only on the difference of the two steps: whatever a caller asks, it learns the pool to within
 * one 1.5× step and no finer. (Rounding the cost alone would not do: the bands' edges sit at different points of the
 * grid, and asking at every step would narrow the pool to a few percent.) Rounding the pool down overstates a share,
 * never understates it.
 */
export function estimateAnswer(step: number, totalMicro: number, dailyShare: number | null) {
  const share = ESTIMATE_STEP ** (step - floorStep(Math.max(1, totalMicro)))
  return {
    share: estimateBand(share),
    ...(dailyShare === null ? {} : { todayShare: estimateBand(dailyShare > 0 ? share / dailyShare : Infinity) }),
  }
}

/** The band for a share of the month (or of today's limit). */
export function estimateBand(share: number) {
  if (share > 1) return "more than your month"
  return ESTIMATE_BANDS.find(([bound]) => share < bound)?.[1] ?? "over 40%"
}

/** The smallest k with 1.5^k ≥ value, for value ≥ 1. */
function stepOf(value: number) {
  let step = 0
  while (ESTIMATE_STEP ** step < value) step++
  return step
}

/** The largest k with 1.5^k ≤ value, for value ≥ 1. */
function floorStep(value: number) {
  let step = 0
  while (ESTIMATE_STEP ** (step + 1) <= value) step++
  return step
}

/** A count rounded up to the grid: 0 stays 0, anything else becomes ⌈1.5^k⌉ for its step k. */
function gridValue(value: number) {
  return value <= 0 ? 0 : Math.ceil(ESTIMATE_STEP ** stepOf(value))
}

function estimateBody(raw: unknown) {
  // Hosted minutes have their form above (A51); races (B06) and playbooks (Track B) get theirs with their packages.
  if (typeof raw === "object" && raw !== null && "kind" in raw)
    throw new ApiError(400, "CODIUM_ESTIMATE_KIND", "This kind of estimate is not available yet.")
  const body = Option.getOrUndefined(Schema.decodeUnknownOption(Body)(raw))
  if (
    !body ||
    ![body.inputTokens, body.outputTokens, body.requests ?? 1].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) ||
    (body.requests ?? 1) < 1
  )
    throw new ApiError(400, "MODEL_PLAN_REQUEST", "Include a model, its input and output tokens, and a request count.")
  return body
}

/**
 * A kept answer, served only while the pool is still on the step it was worked out on or above: a pool that rose since
 * makes it overstate, never understate, and tells nothing new. One kept on a higher step than `poolStep` is not served.
 */
function savedAnswer(raw: unknown, poolStep: number) {
  if (typeof raw !== "string") return undefined
  const saved = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(Saved))(raw))
  return saved && saved.poolStep <= poolStep ? saved.answer : undefined
}

function modelUnavailable() {
  return new ApiError(
    503,
    "MODEL_PLAN_MODEL_UNAVAILABLE",
    "This model is temporarily unavailable. Choose another included model.",
  )
}
