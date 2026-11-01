import { Option, Schema } from "effect"
import { ENTITLEMENTS } from "../../packages/schema/src/codium-entitlements.js"
import { CodiumPlan } from "../../packages/schema/src/codium-plan.js"
import { ApiError } from "./http.js"
import { CODIUM_RUNTIME_CATALOG_UPDATED, CODIUM_MODELS, CODIUM_TIER_MODELS } from "./codium-catalog.js"
import { capturedReservationMicro } from "./codium-reservations.js"
import { codiumLimitProblems, testCreditCapUsd } from "./codium-limits.js"
import { stripeMode, stripeModeProblems, requireStripeMode, type StripeMode } from "./model-plan-stripe.js"

export const MODEL_PLAN_PRICES = CodiumPlan.PLANS.map((plan) => plan.price)
export const MODEL_PLAN_ROOT = "https://openrouter.ai/api/v1"
// Generation options a client may set on a Codium request; the gateway owns every other field.
export const MODEL_PLAN_OPTIONS = [
  "temperature",
  "top_p",
  "stop",
  "seed",
  "tools",
  "tool_choice",
  "frequency_penalty",
  "presence_penalty",
  "response_format",
] as const
export const ModelPlanModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  contextLength: Schema.Number,
  maxOutputTokens: Schema.Number,
  inputPrice: Schema.Number,
  outputPrice: Schema.Number,
  category: Schema.optional(Schema.Literals(["everyday", "advanced"])),
  description: Schema.optional(Schema.String),
  quantizations: Schema.optional(Schema.Array(Schema.Literals(["fp8", "bf16", "mxfp4"]))),
  reasoningEffort: Schema.optional(Schema.Literals(["high", "xhigh", "max"])),
  upstream: Schema.optional(Schema.String),
  minPlan: Schema.optional(Schema.Literals(["vector-10", "vector-50", "vector-100", "vector-200"])),
  previewUntil: Schema.optional(Schema.Number),
  providerOnly: Schema.optional(Schema.Array(Schema.String)),
  tierContext: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  manualOnly: Schema.optional(Schema.Boolean),
  lab: Schema.optional(Schema.Literals(["deepseek", "anthropic", "openai", "moonshot", "google"])),
  weight: Schema.optional(Schema.Number),
  explicitCache: Schema.optional(Schema.Boolean),
  cacheStyle: Schema.optional(Schema.Literals(["openai"])),
  autoToolChoice: Schema.optional(Schema.Literals(["forced", "named"])),
  outputTokenParameter: Schema.optional(Schema.Literals(["max_tokens", "max_completion_tokens"])),
  promptTokenLimit: Schema.optional(Schema.Number),
  options: Schema.optional(Schema.Array(Schema.Literals(MODEL_PLAN_OPTIONS))),
})
export type ModelPlanModel = typeof ModelPlanModel.Type

/**
 * The fixed reservation a request must find available, in whole micro-dollars. Captured models use the entire native
 * provider window and all captured price tiers, plus their maximum reply, after the owner's A17 reservation decision. It
 * comes from the catalog and never from the request, so a refusal says only that what is available is below this one
 * amount. Sized from the request instead, a client could vary max_tokens and read back exactly how much is left.
 *
 * A 429/503 answer is not proof that the first attempt cost nothing, and Max and Ultra may dispatch a second attempt, so
 * they reserve two. `requiredMicro` is exactly `attempts × attemptMicro`, so charging every dispatched attempt at
 * `attemptMicro` can never exceed what was reserved.
 */
export function modelPlanReservation(model: ModelPlanModel, plan?: CodiumPlan.PlanId) {
  if (plan !== undefined && !CodiumPlan.isPlanId(plan)) throw configurationError()
  const attemptMicro = capturedReservationMicro(model)
  if (attemptMicro === undefined)
    throw new ApiError(503, "MODEL_PLAN_MODEL_UNAVAILABLE", "A reservation for this model could not be verified.")
  const attempts = modelPlanAttempts(plan)
  return { attemptMicro, attempts, requiredMicro: attemptMicro * attempts }
}

/** How many provider attempts one request may dispatch on `plan`: a second, before any byte, on Max and Ultra. */
export function modelPlanAttempts(plan?: CodiumPlan.PlanId) {
  return plan === undefined || CodiumPlan.rank(plan) >= 3 ? 2 : 1
}

/** The reservation in dollars, for status's read-only "empty" figure. */
export function modelPlanRequestCredits(model: ModelPlanModel, plan?: CodiumPlan.PlanId) {
  return modelPlanReservation(model, plan).requiredMicro / 1_000_000
}

/** Unqualified planning/status estimate only. This function never authorizes a real hold or provider route. */
export function nominalModelPlanRequestCredits(model: ModelPlanModel, plan?: CodiumPlan.PlanId) {
  if (plan !== undefined && !CodiumPlan.isPlanId(plan)) throw configurationError()
  const context =
    plan === undefined
      ? Math.max(model.contextLength, ...Object.values(model.tierContext ?? {}))
      : effectiveModel(model, plan).contextLength
  return (context * model.inputPrice + model.maxOutputTokens * model.outputPrice) / 1_000_000
}

/** Pure staged tier projection. Admission checks modelAccess separately before using this routing shape. */
export function effectiveModel(model: ModelPlanModel, plan: CodiumPlan.PlanId): ModelPlanModel {
  if (!CodiumPlan.isPlanId(plan)) throw configurationError()
  const context = Math.min(model.tierContext?.[plan] ?? model.contextLength, ENTITLEMENTS[plan].contextMax)
  if (
    !Number.isSafeInteger(context) ||
    !Number.isSafeInteger(model.maxOutputTokens) ||
    model.maxOutputTokens < 1 ||
    context < model.maxOutputTokens
  )
    throw configurationError()
  return {
    ...model,
    contextLength: context,
  }
}

/** A future preview window admits Ultra only; its expiry restores the model's ordinary minimum tier. */
export function modelAccess(model: ModelPlanModel, plan: CodiumPlan.PlanId, now = Date.now()) {
  if (!CodiumPlan.isPlanId(plan) || !CodiumPlan.isPlanId(model.minPlan ?? "vector-10") || !Number.isFinite(now))
    return false
  if (model.previewUntil !== undefined && (!Number.isSafeInteger(model.previewUntil) || model.previewUntil < 0))
    return false
  if (model.previewUntil !== undefined && now < model.previewUntil) return plan === "vector-200"
  return CodiumPlan.rank(plan) >= CodiumPlan.rank(model.minPlan ?? "vector-10")
}

// Names come from CodiumPlan, shared with the app and the website; ids and environment names stay keyed by price.
export function modelPlans() {
  return CodiumPlan.PLANS.map((plan) => {
    const credits = creditAllowance(plan.price, process.env[`MODEL_PLAN_${plan.price}_CREDITS_USD`])
    const priceID = process.env[`STRIPE_MODEL_PLAN_${plan.price}_PRICE_ID`]?.trim()
    return {
      id: plan.id,
      name: plan.name,
      price: plan.price,
      credits: Number.isFinite(credits) && credits > 0 && credits <= plan.price ? credits : 0,
      priceID: priceID && /^price_[a-zA-Z0-9]+$/.test(priceID) ? priceID : undefined,
    }
  })
}

/**
 * The monthly credits a subscription on `plan` grants. Checkout records the credits it sold in the subscription's
 * metadata, beside the plan it sold them for, so a later change to a plan's allowance leaves a running subscription as
 * sold. Stripe's customer portal changes the plan without touching that metadata, so the recorded credits count only
 * while the subscription is still on the plan they were sold for; after a change, the new plan's own credits apply.
 */
export function subscriptionPlanCredits(
  metadata: Record<string, unknown> | undefined,
  plan: { id: string; credits: number } | undefined,
) {
  const sold =
    metadata?.vector_plan === undefined || metadata.vector_plan === plan?.id
      ? metadata?.vector_model_credits_usd
      : undefined
  return sold === undefined ? plan?.credits : Number(sold)
}

export function modelCreditMarkup() {
  const configured = process.env.MODEL_CREDIT_MARKUP_PERCENT?.trim()
  if (!configured) return undefined
  const value = Number(configured)
  if (!Number.isFinite(value) || value < 0 || value > 300) throw configurationError()
  return value
}

function creditAllowance(price: number, override: string | undefined) {
  const markup = override?.trim() ? undefined : modelCreditMarkup()
  const credits = override?.trim()
    ? Number(override)
    : markup === undefined
      ? 0
      : Math.floor((price * 10_000) / (100 + markup)) / 100
  return Number.isFinite(credits) && credits > 0 && credits <= price && Math.round(credits * 100) / 100 === credits
    ? credits
    : 0
}

export function modelPlansEnabled() {
  return process.env.MODEL_PLANS_ENABLED === "true"
}

/** Tiered definitions are an internal opt-in until A17/A18 enforce their routing and admission fields. */
export function configuredPlanModels(options: { tiered?: boolean } = {}) {
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(ModelPlanModel)))(
    process.env.MODEL_PLAN_MODELS_JSON?.trim() || JSON.stringify(options.tiered ? CODIUM_TIER_MODELS : CODIUM_MODELS),
  )
  if (Option.isNone(decoded)) throw configurationError()
  const models = decoded.value.map((model) => ({
    ...model,
    minPlan: model.minPlan ?? ("vector-10" as const),
    weight: model.weight ?? (model.inputPrice + model.outputPrice) / 1.5,
  }))
  if (
    models.length > 30 ||
    new Set(models.map((model) => model.id)).size !== models.length ||
    models.some((model) => {
      const contexts = Object.entries(model.tierContext ?? {})
      const eligible = CodiumPlan.PLANS.filter((plan) => CodiumPlan.rank(plan.id) >= CodiumPlan.rank(model.minPlan))
      const effective = eligible.map((plan) => model.tierContext?.[plan.id] ?? model.contextLength)
      return (
        !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.:-]+$/.test(model.id) ||
        model.id.endsWith(":free") ||
        !model.name.trim() ||
        !Number.isSafeInteger(model.contextLength) ||
        model.contextLength < 1 ||
        !Number.isSafeInteger(model.maxOutputTokens) ||
        model.maxOutputTokens < 1 ||
        model.maxOutputTokens > model.contextLength ||
        (model.promptTokenLimit !== undefined &&
          (!Number.isSafeInteger(model.promptTokenLimit) || model.promptTokenLimit < 1)) ||
        !Number.isFinite(model.inputPrice) ||
        model.inputPrice <= 0 ||
        !Number.isFinite(model.outputPrice) ||
        model.outputPrice <= 0 ||
        !Number.isFinite(model.weight) ||
        model.weight <= 0 ||
        (model.id.includes(":") && !model.upstream) ||
        (model.upstream !== undefined &&
          (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.:-]+$/.test(model.upstream) || model.upstream.endsWith(":free"))) ||
        (model.previewUntil !== undefined && (!Number.isSafeInteger(model.previewUntil) || model.previewUntil < 0)) ||
        (model.providerOnly !== undefined &&
          (!model.providerOnly.length ||
            new Set(model.providerOnly).size !== model.providerOnly.length ||
            model.providerOnly.some((tag) => !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(tag)))) ||
        contexts.some(
          ([plan, context]) =>
            !CodiumPlan.isPlanId(plan) ||
            CodiumPlan.rank(plan) < CodiumPlan.rank(model.minPlan) ||
            !Number.isSafeInteger(context) ||
            context < model.maxOutputTokens ||
            context > ENTITLEMENTS[plan].contextMax,
        ) ||
        (options.tiered &&
          effective.some(
            (context, index) =>
              context > ENTITLEMENTS[eligible[index]!.id].contextMax || (index > 0 && context < effective[index - 1]!),
          )) ||
        // The current gateway sends ids directly and has no tier/preview/provider-pin enforcement yet.
        (!options.tiered &&
          (model.upstream !== undefined ||
            model.minPlan !== "vector-10" ||
            model.previewUntil !== undefined ||
            model.providerOnly !== undefined ||
            model.tierContext !== undefined ||
            model.manualOnly === true ||
            (model.reasoningEffort !== undefined && model.reasoningEffort !== "high")))
      )
    })
  )
    throw configurationError()
  return models
}

export function requireModelPlans() {
  if (!modelPlansEnabled()) throw new ApiError(503, "MODEL_PLANS_DISABLED", "Vector Codium is not available yet.")
  return codiumBillingConfig()
}

/**
 * The oldest desktop or CLI Codium serves when `MODEL_PLANS_MIN_CLIENT` is unset. Older clients show Codium tokens and
 * do not send the headers the gateway needs, so they get `enabled:false` and 426 (WP A16). The release that carries the
 * client work (WPs A19–A26) raises this at go-live; until then it fails closed for every client released so far.
 */
export const MODEL_PLANS_MIN_CLIENT_DEFAULT = "1.99.113"
const CLIENT_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/

/** The configured minimum client, or the compiled default. An unreadable value turns Codium off (see the problems). */
export function modelPlansMinClient() {
  const configured = process.env.MODEL_PLANS_MIN_CLIENT?.trim()
  if (!configured) return MODEL_PLANS_MIN_CLIENT_DEFAULT
  if (!CLIENT_VERSION.test(configured)) throw configurationError()
  return configured
}

/** Only tokens marked for Codium (desktop, `cli` from the code exchange, run tokens) spend it, unless set to "false". */
export function modelPlanRequireMarkedTokens() {
  return process.env.MODEL_PLAN_REQUIRE_MARKED_TOKENS?.trim().toLowerCase() !== "false"
}

/** The owner's admin allowlist. Stripe test checkout is open to these addresses only; empty means nobody. */
export function codiumAdminEmails() {
  return (process.env.VECTOR_ADMIN_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * Every checkout, upgrade included, asks this first. In test mode only an admin may open one: a test checkout takes no
 * real money but its key spends Vector's real OpenRouter balance (up to the test cap), so a preview that leaks must not
 * become a free model gateway. Live checkout is open to every signed-in account.
 */
export function requireCodiumCheckoutUser(user: { email: string }) {
  if (requireStripeMode() === "live") return
  if (!codiumAdminEmails().includes(user.email.trim().toLowerCase()))
    throw new ApiError(403, "CODIUM_TEST_CHECKOUT", "Test checkout is open only to Vector admins.")
}

/** The checked billing configuration Codium runs with. */
export type CodiumBillingConfig = {
  readonly mode: StripeMode
  readonly plans: readonly {
    readonly id: CodiumPlan.PlanId
    readonly name: string
    readonly price: number
    readonly credits: number
    readonly priceID: string
  }[]
  readonly minClient: string
  readonly requireMarkedTokens: boolean
  /** The key limit in test mode; null in live mode. */
  readonly testCreditCapUsd: number | null
}

/**
 * The billing configuration, checked as a whole before Codium serves or sells anything: the Stripe mode guard, every
 * secret and price, the private credits and their ratios, the minimum client and the server-only limits. Any problem
 * turns Codium off with one public answer (`MODEL_PLANS_CONFIGURATION`); `codiumBillingConfigProblems()` names them.
 */
export function codiumBillingConfig(): CodiumBillingConfig {
  if (codiumBillingConfigProblems().length) throw configurationError()
  const mode = stripeMode()
  return {
    mode,
    plans: modelPlans().map((plan) => ({ ...plan, priceID: plan.priceID! })),
    minClient: modelPlansMinClient(),
    requireMarkedTokens: modelPlanRequireMarkedTokens(),
    testCreditCapUsd: mode === "test" ? testCreditCapUsd() : null,
  }
}

/**
 * What stops Codium from running, by env name only, never a value, for the owner page and logs. Each plan's private
 * credits must keep the public usage multiple (`ENTITLEMENTS[plan].usageMultiple`, 5.5× Plus on Pro and so on) to
 * within 0.05: the pricing page promises those multiples, so credits that drift from them would sell less than it says.
 */
export function codiumBillingConfigProblems(): string[] {
  const problems = [...stripeModeProblems()]
  const required = [
    "STRIPE_SECRET_KEY",
    "STRIPE_MODEL_PLAN_WEBHOOK_SECRET",
    "STRIPE_MODEL_PLAN_PORTAL_CONFIG_ID",
    "OPENROUTER_MANAGEMENT_KEY",
  ] as const
  for (const name of required) if (!process.env[name]?.trim()) problems.push(`${name} is not set`)
  if (!/^[a-fA-F0-9]{64}$/.test(process.env.MODEL_PLAN_KEY_ENCRYPTION_SECRET ?? ""))
    problems.push("MODEL_PLAN_KEY_ENCRYPTION_SECRET is not 64 hex characters")
  if (!configuredPlanModels().length) problems.push("MODEL_PLAN_MODELS_JSON lists no models")
  const plans = modelPlans()
  for (const plan of plans) {
    if (!plan.credits) problems.push(`MODEL_PLAN_${plan.price}_CREDITS_USD is not set or out of range`)
    if (!plan.priceID) problems.push(`STRIPE_MODEL_PLAN_${plan.price}_PRICE_ID is not set`)
  }
  if (new Set(plans.map((plan) => plan.priceID)).size !== MODEL_PLAN_PRICES.length)
    problems.push("STRIPE_MODEL_PLAN_*_PRICE_ID values are not distinct")
  const base = plans.find((plan) => ENTITLEMENTS[plan.id].rank === 1)?.credits ?? 0
  if (base > 0 && plans.every((plan) => plan.credits > 0))
    for (const plan of plans) {
      const multiple = ENTITLEMENTS[plan.id].usageMultiple
      if (Math.abs(plan.credits / base - multiple) > 0.05)
        problems.push(`MODEL_PLAN_${plan.price}_CREDITS_USD is not ${multiple}x the Plus credits`)
    }
  if (process.env.MODEL_PLANS_MIN_CLIENT?.trim() && !CLIENT_VERSION.test(process.env.MODEL_PLANS_MIN_CLIENT.trim()))
    problems.push("MODEL_PLANS_MIN_CLIENT is not a version like 1.99.113")
  problems.push(...codiumLimitProblems())
  return problems
}

function modelPlanConfigurationReady() {
  return codiumBillingConfigProblems().length === 0
}

/**
 * What anyone may read about Codium, for /codium and the account page: names, monthly prices, each plan's credits as a
 * multiple of Plus's, and usage as ranges of typical tasks per model. Credit amounts, model prices and the task
 * assumptions behind the ranges stay on the server, so no reader can work back to the dollars of model credit in a
 * plan. Codium sells monthly plans only: the answer has no `topups`, which every client decodes as optional.
 */
export function publicModelPlans() {
  const enabled = modelPlansEnabled() && modelPlanConfigurationReady()
  const models = configuredPlanModels()

  const offers = (items: { id: string; name: string; price: number; credits: number }[], available: boolean) =>
    items.map((item) => ({
      id: item.id,
      name: item.name,
      price: item.price,
      available: available && item.credits > 0,
      ...(item.price > items[0]!.price
        ? {
            multiple:
              Math.round(
                (item.credits > 0 && items[0]!.credits > 0
                  ? item.credits / items[0]!.credits
                  : item.price / items[0]!.price) * 10,
              ) / 10,
          }
        : {}),
      // Typical tasks for each model, in catalog order; null where a model has no reviewed assumptions.
      tasks: models.map((model) => {
        const range = CODIUM_TASK_RANGES[model.id]
        return range ? ([(range[0] * item.price) / 10, (range[1] * item.price) / 10] as const) : null
      }),
    }))
  return {
    product: "Vector Codium",
    enabled,
    currency: "usd",
    interval: "month",
    catalogUpdated: CODIUM_RUNTIME_CATALOG_UPDATED,
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      ...(model.category === undefined ? {} : { category: model.category }),
      ...(model.description === undefined ? {} : { description: model.description }),
    })),
    plans: offers(modelPlans(), enabled),
  }
}

// Coarse illustrative ranges reviewed for the launch catalog. They are deliberately independent of private credit
// amounts and provider prices. Actual task size, cache warmth and reasoning vary; these are not guarantees.
const CODIUM_TASK_RANGES: Record<string, readonly [number, number] | undefined> = {
  "deepseek/deepseek-v4.1-flash-1017": [50, 500],
  "anthropic/claude-haiku-5.5": [30, 300],
  "openai/gpt-6-luna": [60, 600],
  "moonshotai/kimi-k3.1-pro": [5, 50],
  "google/gemini-4-argon": [5, 50],
}

export function modelPlanOrigin() {
  const url = new URL(process.env.VECTOR_PUBLIC_URL ?? "https://vectordev.ai")
  if (url.protocol !== "https:" || url.username || url.password) throw configurationError()
  return url.origin
}

function configurationError() {
  return new ApiError(503, "MODEL_PLANS_CONFIGURATION", "Vector Codium is temporarily unavailable.")
}
