// Frozen: packages/core/src/model-plan-status.ts exactly as Vector 1.99.112 shipped it (commit ab5fa8ce), kept for invariant H7.
// Only these comment lines and the self-export differ from the release. Do not edit the decoder: it is what installed
// 1.99.112 clients run against every new status and config answer.
export * as ModelPlanStatus1_99_112 from "./model-plan-status-1.99.112"

import { CodiumPlan } from "@vectordevai/schema/codium-plan"
import { Option, Schema } from "effect"

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

// The stable internal ID stays "vector-plan"; people see the provider as Vector Codium.
export const PROVIDER_ID = "vector-plan"

const Share = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
// What /api/model-plans/status answers: the share of this month's credits left, the purchased credits' state and flags
// the server works out. No credit amount leaves vectordev.ai, since an amount beside a purchase price would reveal what
// the purchase buys.
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
  purchased: Schema.Struct({
    bought: Schema.Boolean,
    state: Schema.optional(Schema.Literals(["available", "low", "used"])),
  }),
  empty: Schema.Boolean,
  low: Schema.Boolean,
})

/**
 * The signed-in account's Codium plan and balances, as the account page shows them: the monthly balance is the share
 * of this month's credits left, in whole percent, and purchased credits are a state, never an amount, since an amount
 * next to the purchase price would reveal what a purchase buys.
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
  }
  /**
   * Top-up credits: whether any were bought and, when the gateway could verify it, whether they are available, running
   * low or used up. They pool every top-up ever bought, so a share of that pool would mislead a repeat buyer.
   */
  purchased: { bought: boolean; state?: "available" | "low" | "used" }
  /**
   * Too few credits are left for any Codium request, including a subscriber's monthly credits before they renew: the
   * gateway serves a request only when the credits available cover the model's largest request, whatever its size.
   */
  empty: boolean
  /** Less than a tenth of this month's credits, or of the smallest top-up, is left. */
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
const PURCHASED = { available: "Available", low: "Running low", used: "Used up" } as const

/** Reads the signed-in account's Codium plan and balances. The token is only ever sent to vectordev.ai. */
export async function fetchStatus(token: string | undefined, request: Send): Promise<Status> {
  if (!token) return EMPTY
  const response = await request(STATUS_URL, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined)
  if (response?.status === 401) return { ...EMPTY, error: "Your Vector sign-in expired. Sign in again." }
  const decoded = response?.ok
    ? Schema.decodeUnknownOption(Remote)(await response.json().catch(() => undefined))
    : Option.none()
  if (Option.isNone(decoded))
    return { ...EMPTY, signedIn: true, error: "Vector could not load your Codium balance. Try again shortly." }
  return fromRemote(decoded.value)
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
const Config = Schema.Struct({
  enabled: Schema.Boolean,
  plans: Schema.Array(Offer),
  topups: Schema.optional(Schema.Array(Offer)),
})

/**
 * A Codium plan or top-up as Vector offers it: its name and its public price. What it buys stays off every screen, as
 * does how purchases compare, since either beside the price would reveal the markup.
 */
export type Offer = { id: string; name: string; price: number; available: boolean }
export type Offers = { enabled: boolean; plans: Offer[]; topups: Offer[] }

/** The plans and top-ups vectordev.ai lists publicly, for buying inside Vector; undefined when they cannot be read. */
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
  // Only these four fields, whatever else the configuration carries. A plan or top-up Vector knows takes its current
  // name, so a site still answering an older name shows the same one as everything else.
  const offer = (item: Offer) => ({
    id: item.id,
    name: CodiumPlan.name(item.id) ?? item.name,
    price: item.price,
    available: decoded.value.enabled && item.available,
  })
  return {
    enabled: decoded.value.enabled,
    plans: decoded.value.plans.map(offer),
    topups: (decoded.value.topups ?? []).map(offer),
  }
}

/** The shares and flags the server worked out, as Vector's screens read them. */
export function fromRemote(remote: typeof Remote.Type): Status {
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
    },
    purchased: {
      bought: remote.purchased.bought,
      ...(remote.purchased.bought && remote.purchased.state !== undefined ? { state: remote.purchased.state } : {}),
    },
    empty: remote.empty,
    low: remote.low,
  }
}

/** "42%": the same rounding as the account page, so both show the same figure. */
export function formatShare(value: number) {
  return percent.format(value)
}

/**
 * Purchased credits as a state, not a share: they pool every top-up ever bought, so a share of that pool would read
 * "8% left" for a repeat buyer right after a fresh purchase.
 */
export function formatPurchased(purchased: Status["purchased"]) {
  if (!purchased.bought) return "None"
  if (purchased.state === undefined) return "Balance unavailable"
  return PURCHASED[purchased.state]
}

export function formatDate(time: number) {
  return new Date(time).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

/** Plain-language lines for the CLI and other text surfaces. */
export function describe(status: Status) {
  if (!status.signedIn) return [status.error ?? 'Not signed in. Run "vector login" to use Vector Codium.']
  if (status.error) return [status.error]
  const plan = status.plan
  const lines = [
    plan
      ? `Plan: ${plan.name}, ${plan.left === undefined ? "balance unavailable" : `${formatShare(plan.left)} of this month's credits left`}, ${plan.cancelAtPeriodEnd ? "ends" : "renews"} ${formatDate(plan.renewsAt)}`
      : `Plan: ${CodiumPlan.FREE}`,
    `Purchased credits: ${formatPurchased(status.purchased).toLowerCase()}`,
  ]
  const current = notice(status)
  return current ? [...lines, current.text] : lines
}

/** The one balance message to show next to a signed-in account's Codium balances, if any. */
export function notice(status: Status): { kind: "unavailable" | "empty" | "low"; text: string } | undefined {
  if (!status.enabled) return { kind: "unavailable", text: "Vector Codium is not available yet." }
  const plan = status.plan
  if (status.empty && plan && !plan.cancelAtPeriodEnd)
    return {
      kind: "empty",
      text: `Too few of your monthly Codium credits are left for a reply. They renew on ${formatDate(plan.renewsAt)}; buy credits to keep using Codium models before then.`,
    }
  if (status.empty && plan)
    return {
      kind: "empty",
      text: `Too few Codium credits are left for a reply, and your plan ends on ${formatDate(plan.renewsAt)}. Buy credits to keep using Codium models.`,
    }
  if (!status.access)
    return { kind: "empty", text: "You have no Codium credits available. Buy credits to use Codium models." }
  if (status.empty)
    return {
      kind: "empty",
      text: "Too few Codium credits are left for a reply. Buy credits to keep using Codium models.",
    }
  if (status.low) return { kind: "low", text: "You are running low on Codium credits." }
}

export type Action = "credits" | "sign-in" | "unavailable"

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

function codiumMetadata(data: unknown) {
  const metadata = data && typeof data === "object" && "metadata" in data ? data.metadata : undefined
  return metadata && typeof metadata === "object" && "codium" in metadata ? metadata.codium : undefined
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
