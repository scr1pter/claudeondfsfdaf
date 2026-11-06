export * as ModelPlanStatus from "./model-plan-status"

import { Billing } from "@vectordevai/schema/billing"
import { CodiumEntitlements } from "@vectordevai/schema/codium-entitlements"
import { CodiumPlan } from "@vectordevai/schema/codium-plan"
import { Option, Schema } from "effect"
import { InstallationVersion } from "./installation/version"

export const SITE = "https://vectordev.ai"
export const API_URL = `${SITE}/api/model-plans`
export const STATUS_URL = `${API_URL}/status`
export const CONFIG_URL = `${API_URL}/config`
export const PURCHASE_URL = `${SITE}/codium`
export const MANAGE_URL = `${SITE}/account`

// The app imports this module in the browser, so it holds only what a browser can run and sends with the transport its
// caller hands it. Node callers hand it ModelPlans.plansCatalog, which labels each request for Vector Local; that egress
// layer needs Node (async_hooks), so nothing here may import it, not even lazily: Vite bundles a dynamic import too.
type Send = (url: string, init: RequestInit) => Promise<Response>

// The stable internal ID, which the shared Billing module owns; people see the provider as Vector Codium.
export const PROVIDER_ID = Billing.CODIUM_PROVIDER_ID

/** Codium Auto: a listing entry that names a floor, default and ceiling model; never a model the gateway serves. */
export const AUTO_ID = "vector/codium-auto"

/** What a Codium chat request is for (X-Vector-Purpose). A run token's own purpose overrides it on the server. */
export const PURPOSES = ["chat", "title", "brain", "review", "judge", "race", "playbook", "task"] as const
export type Purpose = (typeof PURPOSES)[number]

export function purpose(value: unknown): Purpose {
  return PURPOSES.find((item) => item === value) ?? "chat"
}

/**
 * The headers a current client sends on catalog, chat and status reads (§4.9): its version, which the gateway compares
 * with its minimum, and the catalog shape it decodes. They select a response shape only; they never grant anything.
 */
export function clientHeaders() {
  return { "X-Vector-Client": InstallationVersion, "X-Vector-Catalog": "2" }
}

const Share = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
// What /api/model-plans/status answers: the share of this month's usage left and flags the server works out. No amount
// leaves vectordev.ai (P1). This pass is as permissive as the decoders released up to 1.99.112 (H7), except that
// `purchased` may be missing; the fields added since are read one at a time by `extras`, so an unknown value drops
// only that field and never the whole status.
const Remote = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  access: Schema.Boolean,
  customer: Schema.optional(Schema.Boolean),
  plan: Schema.optional(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      left: Schema.optional(Share),
      renewsAt: Schema.Number,
      cancelAtPeriodEnd: Schema.Boolean,
    }),
  ),
  purchased: Schema.optional(
    Schema.Struct({
      bought: Schema.Boolean,
      state: Schema.optional(Schema.Literals(["available", "low", "used"])),
    }),
  ),
  empty: Schema.Boolean,
  low: Schema.Boolean,
})

const Count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
const Time = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))
const PAYMENT_ACTIONS = ["update-card", "confirm-payment", "change-plan"] as const
const Scheduled = Schema.Struct({ id: Schema.String, name: Schema.String, at: Time })
const Today = Schema.Struct({ used: Share, resetsAt: Time, reached: Schema.Boolean })
const Ramp = Schema.Struct({ until: Time })
const Forecast = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/))
const Meters = {
  cloudAgents: Schema.Struct({ used: Share, exhausted: Schema.Boolean }),
  hosted: Schema.Struct({ used: Share }),
  brain: Schema.Struct({ used: Share, cap: Share }),
  vault: Schema.Struct({ usedBytes: Count, quotaBytes: Count }),
  remote: Schema.Struct({ computers: Count, limit: Count }),
  shipDesk: Schema.Struct({ used: Share }),
}
const History = Schema.Struct({ day: Forecast, used: Share })
const Founding = Schema.Struct({ number: Count })

export type Meters = { -readonly [K in keyof typeof Meters]?: (typeof Meters)[K]["Type"] }

/**
 * The signed-in account's Codium plan and usage, as the account page shows them: the share of this month's usage left,
 * in whole percent, never an amount.
 */
export type Status = {
  signedIn: boolean
  /** Whether vectordev.ai currently sells Codium and serves its models. */
  enabled: boolean
  /** Whether the account can start a Codium model request right now. */
  access: boolean
  /** Whether vectordev.ai keeps a billing account for this person, so the billing portal has invoices to show. */
  customer?: boolean
  plan?: {
    id: string
    name: string
    /** The share of this period's monthly credits left, from 0 to 1, when the gateway could verify it. */
    left?: number
    renewsAt: number
    cancelAtPeriodEnd: boolean
    state?: CodiumEntitlements.PlanState
    reason?: CodiumEntitlements.PlanReason
    /** What fixes a paused plan's payment, or a plan change the person can make. */
    action?: (typeof PAYMENT_ACTIONS)[number]
    /** A plan change that takes effect at `at`. */
    scheduled?: { id: string; name: string; at: number }
    /** The share of today's limit used, and whether a further request is refused until `resetsAt`. */
    today?: { used: number; resetsAt: number; reached: boolean }
    /** The day this month's usage runs out at its pace so far (YYYY-MM-DD). */
    forecastDate?: string
    /** While a new plan's usage is still ramping up. */
    ramp?: { until: number }
  }
  /** The perks this account's surfaces may show. */
  listed?: CodiumEntitlements.PerkId[]
  /** What the plan includes, for the perks listed (publicEntitlements); shares, counts and flags only. */
  entitlements?: Readonly<Record<string, unknown>>
  meters?: Meters
  /** This period's usage by day, as shares. */
  history?: { day: string; used: number }[]
  founding?: { number: number }
  velocity?: "coming"
  labs?: "coming"
  /**
   * Top-up credits, which Codium no longer sells: the server always answers `{bought: false}`, kept for the decoders
   * released up to 1.99.112 (H7).
   */
  purchased: { bought: boolean; state?: "available" | "low" | "used" }
  /**
   * Too few credits are left for any Codium request, including a subscriber's monthly credits before they renew: the
   * gateway serves a request only when the credits available cover the model's largest request, whatever its size.
   */
  empty: boolean
  /** Less than a tenth of this month's usage is left. */
  low: boolean
  error?: string
}

const EMPTY: Status = {
  signedIn: false,
  enabled: false,
  access: false,
  purchased: { bought: false },
  empty: false,
  low: false,
}
const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0 })

/** Reads the signed-in account's Codium plan and usage. The token is only ever sent to vectordev.ai. */
export async function fetchStatus(token: string | undefined, request: Send): Promise<Status> {
  if (!token) return EMPTY
  const response = await request(STATUS_URL, {
    headers: { ...clientHeaders(), authorization: `Bearer ${token}`, accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined)
  if (response?.status === 401) return { ...EMPTY, error: "Your Vector sign-in expired. Sign in again." }
  const body: unknown = response?.ok ? await response.json().catch(() => undefined) : undefined
  const decoded = Schema.decodeUnknownOption(Remote)(body)
  if (Option.isNone(decoded))
    return { ...EMPTY, signedIn: true, error: "Vector could not load your Codium usage. Try again shortly." }
  return fromRemote(decoded.value, body)
}

/**
 * Whether vectordev.ai sells Codium now, from its public configuration, for someone who is not signed in; undefined
 * when it cannot tell. Nothing should point at the purchase page while it only says Codium is coming soon.
 */
export async function salesOpen(request: Send) {
  const response = await request(CONFIG_URL, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined)
  const decoded = response?.ok
    ? Schema.decodeUnknownOption(Schema.Struct({ enabled: Schema.Boolean }))(
        await response.json().catch(() => undefined),
      )
    : Option.none()
  return Option.isSome(decoded) ? decoded.value.enabled : undefined
}

const Offer = Schema.Struct({ id: Schema.String, name: Schema.String, price: Schema.Number, available: Schema.Boolean })
// An older site still lists top-ups beside the plans; Codium sells monthly plans only, so they are not read.
const Config = Schema.Struct({ enabled: Schema.Boolean, plans: Schema.Array(Offer) })

/**
 * A Codium plan as Vector offers it: its name and its public monthly price. What it buys stays off every screen, as
 * does how plans compare, since either beside the price would reveal the markup.
 */
export type Offer = { id: string; name: string; price: number; available: boolean }
export type Offers = { enabled: boolean; plans: Offer[] }

/** The monthly plans vectordev.ai lists publicly, for subscribing inside Vector; undefined when they cannot be read. */
export async function fetchOffers(request: Send): Promise<Offers | undefined> {
  const response = await request(CONFIG_URL, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined)
  const decoded = response?.ok
    ? Schema.decodeUnknownOption(Config)(await response.json().catch(() => undefined))
    : Option.none()
  if (Option.isNone(decoded)) return undefined
  // Only these four fields, whatever else the configuration carries. A plan Vector knows takes its current name, so a
  // site still answering an older name shows the same one as everything else.
  const offer = (item: Offer) => ({
    id: item.id,
    name: CodiumPlan.name(item.id) ?? item.name,
    price: item.price,
    available: decoded.value.enabled && item.available,
  })
  return { enabled: decoded.value.enabled, plans: decoded.value.plans.map(offer) }
}

/**
 * The shares and flags the server worked out, as Vector's screens read them. `body` is the raw answer, read again for
 * the fields added since 1.99.112, each on its own.
 */
export function fromRemote(remote: typeof Remote.Type, body?: unknown): Status {
  const more = extras(body)
  return {
    signedIn: true,
    enabled: remote.enabled !== false,
    access: remote.access,
    ...(remote.customer ? { customer: true } : {}),
    plan: remote.plan && {
      id: remote.plan.id,
      name: CodiumPlan.name(remote.plan.id) ?? remote.plan.name,
      ...(remote.plan.left === undefined ? {} : { left: remote.plan.left }),
      renewsAt: remote.plan.renewsAt,
      cancelAtPeriodEnd: remote.plan.cancelAtPeriodEnd,
      ...more.plan,
    },
    ...more.account,
    purchased: {
      bought: remote.purchased?.bought ?? false,
      ...(remote.purchased?.bought && remote.purchased.state !== undefined ? { state: remote.purchased.state } : {}),
    },
    empty: remote.empty,
    low: remote.low,
  }
}

// The lenient pass (§4.11): each field added since 1.99.112 decodes on its own, enums as strings, and an unknown or
// malformed value is dropped without failing the status.
function extras(body: unknown) {
  const record = object(body)
  const plan = object(record?.plan)
  const field = <S extends Schema.Decoder<unknown>>(schema: S, value: unknown) =>
    Option.getOrUndefined(Schema.decodeUnknownOption(schema)(value)) as S["Type"] | undefined
  const known = <T extends string>(values: readonly T[], value: unknown) => values.find((item) => item === value)
  const meters = object(record?.meters)
  const decodedMeters = Object.fromEntries(
    Object.entries(Meters).flatMap(([name, schema]) => {
      const value = field(schema, meters?.[name])
      return value ? [[name, value]] : []
    }),
  ) as Meters
  const history = Array.isArray(record?.history)
    ? record.history.flatMap((item) => {
        const value = field(History, item)
        return value ? [value] : []
      })
    : undefined
  const listed = Array.isArray(record?.listed)
    ? record.listed.flatMap((item) => {
        const value = known(CodiumEntitlements.PERK_IDS, item)
        return value ? [value] : []
      })
    : undefined
  const entitlements = object(record?.entitlements)
  const founding = field(Founding, record?.founding)
  const scheduled = field(Scheduled, plan?.scheduled)
  const values = {
    plan: {
      state: known(CodiumEntitlements.PLAN_STATES, plan?.state),
      reason: known(CodiumEntitlements.PLAN_REASONS, plan?.reason),
      action: known(PAYMENT_ACTIONS, plan?.action),
      scheduled: scheduled && { ...scheduled, name: CodiumPlan.name(scheduled.id) ?? scheduled.name },
      today: field(Today, plan?.today),
      forecastDate: field(Forecast, plan?.forecastDate),
      ramp: field(Ramp, plan?.ramp),
    },
    account: {
      listed,
      entitlements,
      meters: Object.keys(decodedMeters).length ? decodedMeters : undefined,
      history,
      founding,
      velocity: record?.velocity === "coming" ? ("coming" as const) : undefined,
      labs: record?.labs === "coming" ? ("coming" as const) : undefined,
    },
  }
  return {
    plan: defined(values.plan),
    account: defined(values.account),
  }
}

function object(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function defined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>
  }
}

/** "42%": the same rounding as the account page, so both show the same figure. */
export function formatShare(value: number) {
  return percent.format(value)
}

export function formatDate(time: number) {
  return new Date(time).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

/** Plain-language lines for the CLI and other text surfaces: whole percentages, never an amount (P1, H5). */
export function describe(status: Status) {
  if (!status.signedIn) return [status.error ?? 'Not signed in. Run "vector login" to use Vector Codium.']
  if (status.error) return [status.error]
  const current = notice(status)
  const plan = status.plan
  // Codium off (deployed off or switched off) is said first: no request can start, whatever the plan shows.
  const first = current?.kind === "unavailable" ? [current.text] : []
  const last = current && current.kind !== "unavailable" ? [current.text] : []
  if (!plan)
    return [...first, `Plan: ${CodiumPlan.FREE}`, ...last, ...(status.enabled ? [`See plans: ${PURCHASE_URL}`] : [])]
  return [
    ...first,
    `Plan: ${plan.name}, ${plan.left === undefined ? "usage unavailable" : `${formatShare(plan.left)} left this month`}, ${plan.cancelAtPeriodEnd ? "ends" : "renews"} ${formatDate(plan.renewsAt)}`,
    ...(plan.today ? [`Today: ${formatShare(plan.today.used)} of today's limit used`] : []),
    ...(plan.scheduled ? [`Changes to ${plan.scheduled.name} on ${formatDate(plan.scheduled.at)}`] : []),
    ...last,
    `Change plan: ${MANAGE_URL}`,
  ]
}

/** The one usage message to show next to a signed-in account's Codium plan, if any. */
export function notice(status: Status): { kind: "unavailable" | "empty" | "low"; text: string } | undefined {
  if (!status.enabled) return { kind: "unavailable", text: "Vector Codium is not available right now." }
  const plan = status.plan
  if (plan?.state === "paused")
    return {
      kind: "empty",
      text:
        plan.action === "confirm-payment"
          ? "Your Codium plan is paused until you confirm its payment."
          : "Your Codium plan is paused until its payment goes through. Update your card to continue.",
    }
  if (plan?.state === "frozen") return { kind: "empty", text: "Your Codium plan is on hold. Contact Vector support." }
  if (status.empty && plan && !plan.cancelAtPeriodEnd)
    return {
      kind: "empty",
      text: `This month's Codium usage is used up. It renews on ${formatDate(plan.renewsAt)}; change your plan to keep using Codium models before then.`,
    }
  if (status.empty && plan)
    return {
      kind: "empty",
      text: `This month's Codium usage is used up, and your plan ends on ${formatDate(plan.renewsAt)}. See plans to keep using Codium models.`,
    }
  if (!status.access)
    return {
      kind: "empty",
      text: plan ? "Your Codium plan cannot be used right now." : "Choose a Codium plan to use Codium models.",
    }
  if (status.empty)
    return { kind: "empty", text: "Too little Codium usage is left for a reply. See plans to continue." }
  if (status.low) return { kind: "low", text: "Less than 10% of this month's Codium usage is left." }
}

/** The action a failed turn stores and old app decoders read; finer kinds come from the code (failureKind). */
export type Action = "credits" | "sign-in" | "unavailable"

/** How a client treats a Codium gateway answer (§4.10). */
export type Kind =
  | "credits"
  | "sign-in"
  | "run"
  | "capacity"
  | "busy"
  | "wait"
  | "upgrade"
  | "contact"
  | "plan"
  | "daily"
  | "unavailable"
  | "update"

export type Failure = {
  code: string
  kind: Kind
  /** What fixes a final answer, as a failed turn stores it; undefined for an answer that is retried. */
  action?: Action
  message: string
  /** Temporary: the turn waits (retry-after) and tries again. Every other answer is final and never retried. */
  retry: boolean
}

const CAPACITY =
  "Vector Codium could not run this request: model capacity may be short for a moment. Vector will try again shortly."
const UNAVAILABLE = "Vector Codium is not available right now."
const DISPATCHED =
  "The model provider could not finish this request. It counts toward your Codium usage, so Vector did not send it again. Try again shortly."

// Only these codes, and any answer the gateway marks `dispatched` (gatewayFailure), are classified; any other answer
// stays an ordinary provider error, so a transient gateway failure before dispatch (MODEL_PLAN_UPSTREAM,
// MODEL_PLAN_UNAVAILABLE and the like) keeps the usual 5xx retry. The retried codes here cost nothing when unmarked:
// they are answered before anything reaches the provider.
const CODES: Record<string, { kind: Kind; retry?: true; text?: string }> = {
  RATE_LIMITED: { kind: "busy", retry: true },
  MODEL_PLAN_BUSY: { kind: "busy", retry: true },
  MODEL_PLAN_RENEWING: { kind: "busy", retry: true },
  MODEL_PLAN_CONCURRENCY: { kind: "wait", retry: true },
  MODEL_PLAN_CAPACITY: { kind: "capacity", retry: true, text: CAPACITY },
  SIGN_IN_REQUIRED: { kind: "sign-in", text: "Sign in to Vector to use Vector Codium." },
  CODIUM_SIGN_IN_REQUIRED: {
    kind: "sign-in",
    text: 'Sign in to Vector again, or run "vector login" in a terminal, to use Vector Codium.',
  },
  // An old signed run must start again after an upgrade or renewal; a run or Brain limit is not a credit answer.
  MODEL_PLAN_RUN_EXPIRED: { kind: "run" },
  MODEL_PLAN_RUN_LIMIT: { kind: "run" },
  MODEL_PLAN_BRAIN_SHARE: { kind: "run" },
  MODEL_PLAN_DAILY_LIMIT: { kind: "daily" },
  MODEL_PLAN_REQUIRED: { kind: "credits" },
  MODEL_PLAN_PAYMENT_REQUIRED: { kind: "credits" },
  MODEL_PLAN_EXHAUSTED: { kind: "credits" },
  MODEL_PLAN_UPGRADE_REQUIRED: { kind: "upgrade" },
  CODIUM_PERK_REQUIRED: { kind: "upgrade" },
  MODEL_PLAN_BLOCKED: { kind: "contact" },
  MODEL_PLAN_EXISTS: { kind: "plan" },
  MODEL_PLAN_CHANGE_UNAVAILABLE: { kind: "plan" },
  HOSTED_SESSION_PAUSED: { kind: "wait" },
  CODIUM_UPDATE_REQUIRED: { kind: "update", text: "Update Vector to keep using Vector Codium." },
  MODEL_PLANS_DISABLED: { kind: "unavailable", text: UNAVAILABLE },
  CODIUM_SALES_PAUSED: { kind: "unavailable", text: UNAVAILABLE },
  CODIUM_UNAVAILABLE: { kind: "unavailable", text: UNAVAILABLE },
  MODEL_PLANS_CONFIGURATION: { kind: "unavailable", text: "Vector Codium is temporarily unavailable." },
  MODEL_PLAN_POOL_UNAVAILABLE: { kind: "unavailable", text: "Vector Codium could not verify your usage right now." },
  MODEL_PLAN_MODEL_UNAVAILABLE: { kind: "unavailable", text: "This model is temporarily unavailable." },
  MODEL_PLAN_ACCOUNT_CLOSING: {
    kind: "unavailable",
    text: "This account is being deleted, so Vector Codium is closed for it.",
  },
  MODEL_PLAN_MODEL: { kind: "unavailable", text: "This model is no longer included in Vector Codium." },
  MODEL_PLAN_ADDONS: {
    kind: "unavailable",
    text: "Vector Codium supports text and local tools without paid add-ons.",
  },
  CODIUM_ESTIMATE_KIND: { kind: "unavailable", text: "Vector cannot estimate this kind of work yet." },
  // Local only: a request for Codium Auto itself, which is never sent (ModelPlans.resolveRoute).
  CODIUM_AUTO: { kind: "unavailable", text: "Codium Auto could not pick a model for this request." },
}

const ACTIONS: Record<Kind, Action | undefined> = {
  credits: "credits",
  upgrade: "credits",
  plan: "credits",
  "sign-in": "sign-in",
  run: "unavailable",
  daily: "unavailable",
  contact: "unavailable",
  wait: "unavailable",
  update: "unavailable",
  unavailable: "unavailable",
  capacity: undefined,
  busy: undefined,
}

const DEFAULTS: Record<Kind, string> = {
  credits: "Choose a Vector Codium plan to use this model.",
  upgrade: "Change your Codium plan to use this model.",
  plan: "Manage your Codium plan from your account.",
  "sign-in": "Sign in to Vector to use Vector Codium.",
  run: "This run cannot use Vector Codium any further. Save your work and finish the run.",
  daily: "Your Codium daily limit has been reached. Try again tomorrow.",
  contact: "Your Codium plan is on hold. Contact Vector support.",
  wait: "Vector Codium is busy. Vector will try again shortly.",
  update: "Update Vector to keep using Vector Codium.",
  unavailable: UNAVAILABLE,
  capacity: CAPACITY,
  busy: "Vector Codium is busy. Vector will try again shortly.",
}

const GatewayError = Schema.Struct({
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
    action: Schema.optional(Schema.String),
    dispatched: Schema.optional(Schema.Boolean),
  }),
})

/**
 * Account, plan and availability answers from the Codium gateway, or the same answers given locally before a request,
 * by their code (§4.10). Only `retry` answers may improve on a retry; none may move the conversation to another paid
 * provider. Any other answer is undefined and handled as an ordinary provider error.
 */
export function gatewayFailure(status: number | undefined, body: string | undefined): Failure | undefined {
  const parsed = body
    ? Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(GatewayError))(body))
    : undefined
  const code = parsed?.error.code ?? ""
  // The gateway sent this request to the provider before it failed, so it already counts in full toward the month
  // (unknown outcomes are charged). Each resend would count again, so it is final whatever its code: the person
  // decides whether to try again. The gateway itself retries Max and Ultra once before answering.
  if (parsed?.error.dispatched === true)
    return {
      code,
      kind: "unavailable",
      action: "unavailable",
      message: `${DISPATCHED}${suffix("unavailable", undefined)}`,
      retry: false,
    }
  const known = Object.hasOwn(CODES, code) ? CODES[code] : status === 401 ? CODES.SIGN_IN_REQUIRED : undefined
  if (!known) return undefined
  const kind = known.kind
  const action = known.retry ? undefined : ACTIONS[kind]
  const text = known.text ?? parsed?.error.message.trim() ?? DEFAULTS[kind]
  return {
    code: code || "SIGN_IN_REQUIRED",
    kind,
    ...(action ? { action } : {}),
    message: `${text || DEFAULTS[kind]}${suffix(kind, parsed?.error.action)}`,
    retry: known.retry === true,
  }
}

// The sentence a final answer ends with, which the terminal needs; the app reads it back (failureParts) and offers the
// same step as a button. The credit ones follow the answer's payment action, first match wins.
const SUFFIXES = [
  { kind: "credits", payment: "update-card", text: ` Update your card at ${MANAGE_URL}` },
  { kind: "credits", payment: "confirm-payment", text: ` Confirm your payment at ${MANAGE_URL}` },
  { kind: "credits", text: ` See plans at ${PURCHASE_URL}` },
  { kind: "upgrade", text: ` Change plan at ${MANAGE_URL}` },
  { kind: "plan", text: ` Manage your plan at ${MANAGE_URL}` },
] as const satisfies readonly { kind: Kind; payment?: Payment; text: string }[]
// What failed turns stored before Codium stopped selling top-ups end with.
const LEGACY_CREDITS = ` Buy credits at ${PURCHASE_URL}`

type Payment = "update-card" | "confirm-payment"

function suffix(kind: Kind, action: string | undefined) {
  if (kind === "unavailable") return " Choose another model."
  const found = SUFFIXES.find((item) => item.kind === kind && (!("payment" in item) || item.payment === action))
  return found?.text ?? ""
}

/**
 * A final answer's message split from the step it ends with: the text without that sentence, and the kind and payment
 * action the sentence names. A message without one (or a run, daily or Brain answer, which never ends with a purchase)
 * comes back whole.
 */
export function failureParts(message: string): { text: string; kind?: Kind; payment?: Payment } {
  if (message.endsWith(LEGACY_CREDITS)) return { text: message.slice(0, -LEGACY_CREDITS.length), kind: "credits" }
  const found = SUFFIXES.find((item) => message.endsWith(item.text))
  if (!found) return { text: message }
  return {
    text: message.slice(0, -found.text.length),
    kind: found.kind,
    ...("payment" in found ? { payment: found.payment } : {}),
  }
}

/** The §4.10 kind of a gateway code, for surfaces that show a finer answer than the stored action. */
export function failureKind(code: string): Kind | undefined {
  return Object.hasOwn(CODES, code) ? CODES[code]!.kind : undefined
}

/**
 * The action a failed Vector Codium turn offers: from the engine's recorded APIError (metadata.codium) or from a
 * Core V2 assistant error ({ type: "codium", action }).
 */
export function failureAction(error: unknown): Action | undefined {
  if (!error || typeof error !== "object") return
  const kind =
    "type" in error && error.type === "codium" && "action" in error
      ? error.action
      : "name" in error && error.name === "APIError" && "data" in error
        ? codiumMetadata(error.data)
        : undefined
  return kind === "credits" || kind === "sign-in" || kind === "unavailable" ? kind : undefined
}

/** The gateway code a failed Codium turn recorded (engine metadata.code, or a Core V2 error's `code`), when it has one. */
export function failureCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return
  const code =
    "type" in error && error.type === "codium" && "code" in error
      ? error.code
      : "name" in error && error.name === "APIError" && "data" in error
        ? codiumMetadata(error.data, "code")
        : undefined
  return typeof code === "string" && code ? code : undefined
}

function codiumMetadata(data: unknown, key: "codium" | "code" = "codium") {
  const metadata = data && typeof data === "object" && "metadata" in data ? data.metadata : undefined
  return metadata && typeof metadata === "object" && key in metadata
    ? (metadata as Record<string, unknown>)[key]
    : undefined
}

/**
 * What a listed Codium entry says about itself (Model.Codium), as the app, the TUI and the desktop read it from the
 * model list: structural, so each surface passes its own model shape.
 */
export type Listing = {
  lab?: string
  role?: string
  manualOnly?: boolean
  locked?: { plan: string; name: string; previewUntil?: number }
  preview?: { until: number }
  auto?: unknown
}

/** Whether an entry is Codium Auto, which picks a model for each message and is never a model itself. */
export function isAuto(model: { id: string; codium?: Listing }) {
  return model.id === AUTO_ID || Boolean(model.codium?.auto)
}

/** Whether the account's plan does not include this entry: choosing it opens Change plan instead (label plan §10). */
export function isLocked(model: { codium?: Listing }) {
  return Boolean(model.codium?.locked)
}

/**
 * Whether Vector may put a prompt on this entry by itself (task and image routing, swarms, a default it picks): never
 * Codium Auto, a locked or a manual-only model (§4.12). The person can still choose an unlocked one by name.
 */
export function automatic(model: { id: string; codium?: Listing }) {
  return !isAuto(model) && !isLocked(model) && !model.codium?.manualOnly
}

/**
 * The badge a picker shows beside a Codium entry the plan does not include, or a preview it does: "Codium · Pro" (the
 * plan that includes it), "Preview · Ultra" (only Ultra has it during its preview), or "Preview". None for the rest.
 */
export function listingBadge(codium: Listing | undefined): { label: string; title: string } | undefined {
  const locked = codium?.locked
  if (locked?.previewUntil !== undefined)
    return { label: `Preview · ${locked.name}`, title: `Only in ${locked.name} during its preview` }
  if (locked) return { label: `Codium · ${locked.name}`, title: `Included in ${locked.name} and above` }
  if (codium?.preview) return { label: "Preview", title: "A preview model on your plan" }
}

/**
 * The model a session continues on, from its last user message: the one the person selected (Codium Auto), else the one
 * that message ran on with its variant. Auto picks again for the next message, so a variant of one of its models is not
 * kept.
 */
export function sessionModel(message: {
  model?: { providerID: string; modelID: string; variant?: string }
  selected?: { providerID: string; modelID: string }
}): { providerID: string; modelID: string; variant?: string } | undefined {
  if (message.selected) return { providerID: message.selected.providerID, modelID: message.selected.modelID }
  return message.model
}

/**
 * The providers an automatic model choice may use, best group first: providers the person connected, then Vector's
 * shared free models. Vector Codium spends the account's credits, so it is never chosen automatically.
 */
export function automaticProviders<
  T extends { id: string; models: Record<string, { freeModel?: { source: string } }> },
>(providers: readonly T[]) {
  const others = providers.filter((provider) => provider.id !== PROVIDER_ID)
  const own = others.filter((provider) =>
    Object.values(provider.models).some((model) => model.freeModel?.source !== "shared"),
  )
  return own.length ? own : others
}
