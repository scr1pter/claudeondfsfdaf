import { createHash, timingSafeEqual } from "node:crypto"
import { Option, Schema } from "effect"
import { readCodiumFunding } from "./codium-funding.js"
import { codiumKey } from "./codium-keys.js"
import { ApiError, handleApiError, json, queryValue, requireMethod, type ApiRequest, type ApiResponse } from "./http.js"
import { openRouterManagement, readModelPlanAccount, withCodiumLease } from "./model-plan-account.js"
import { modelPlans, subscriptionPlanCredits } from "./model-plan-config.js"
import { modelPlanStripe, stripeRecord } from "./model-plan-stripe.js"
import { persistentStore } from "./persistent-store.js"

/**
 * One Codium payment as the owner's books see it, in US cents: what the buyer paid and got back, what Stripe kept, the
 * model credit the payment can still cost Vector, OpenRouter's fee on buying that credit, and what is left. The model
 * cost assumes every credit granted is spent, so monthly credits that expire unused are margin this does not show.
 * It holds what makes the markup plain, so it stays on the server and reaches only the owner.
 */
const Entry = Schema.Struct({
  charge: Schema.String,
  // Codium sells monthly plans only (WP A04), so every entry written now is a subscription's. "topup" still decodes so
  // a line written before top-ups were removed keeps counting in the books as it was recorded; nothing writes one.
  kind: Schema.Literals(["subscription", "topup"]),
  account: Schema.String,
  product: Schema.String,
  created: Schema.Number,
  price: Schema.Number,
  refunded: Schema.Number,
  disputed: Schema.Boolean,
  stripeFee: Schema.NullOr(Schema.Number),
  stripeNet: Schema.Number,
  // The credits the purchase granted before any refund or dispute.
  granted: Schema.Number,
  credits: Schema.Number,
  openRouterFee: Schema.Number,
  profit: Schema.Number,
  updatedAt: Schema.Number,
})
type Entry = typeof Entry.Type

// Read at each call: the mode namespace comes from the environment.
const LEDGER_KEY = () => codiumKey("ledger")

/**
 * Writes the ledger entry for one charge from Stripe's current state, so every notification about it (paid, fee
 * settled, refunded, disputed, dispute closed) rewrites the same entry and a replay changes nothing. A charge that is
 * not a paid Codium purchase by this account is left out. The read and the write happen under the account's lease,
 * so a slower notification that read the charge before a refund cannot land after, and undo, the one that read it.
 */
export async function recordCodiumCharge(id: string, chargeID: string, fetcher: typeof fetch = fetch) {
  return withCodiumLease(
    id,
    async () => {
      const query = new URLSearchParams([
        ["expand[]", "balance_transaction"],
        ["expand[]", "payment_intent"],
        ["expand[]", "invoice.subscription"],
      ])
      const charge = await modelPlanStripe(`charges/${encodeURIComponent(chargeID)}?${query}`, {}, fetcher)
      const account = await readModelPlanAccount(id, fetcher)
      if (
        !account ||
        charge.id !== chargeID ||
        charge.customer !== account.customer ||
        charge.paid !== true ||
        charge.currency !== "usd" ||
        !Number.isSafeInteger(charge.amount) ||
        !Number.isSafeInteger(charge.amount_refunded) ||
        typeof charge.created !== "number"
      )
        return
      const price = Number(charge.amount)
      const refunded = Number(charge.amount_refunded)
      const disputes = charge.disputed === true ? await chargeDisputes(chargeID, fetcher) : []
      // A dispute takes the credits away until Stripe says it was won, as the grant itself does.
      const disputed =
        charge.disputed === true &&
        !(disputes.length > 0 && disputes.every((value) => ["won", "warning_closed"].includes(String(value.status))))
      const sale = subscriptionSale(charge, id)
      if (!sale) return
      const reversed = refunded > 0 || disputed
      const credits = reversed ? await revokedMonthlyCost(account, sale, fetcher) : sale.credits
      const transaction = stripeRecord(charge.balance_transaction) ? charge.balance_transaction : undefined
      const disputeTransactions = disputes.flatMap((value) =>
        Array.isArray(value.balance_transactions) ? value.balance_transactions.filter(stripeRecord) : [],
      )
      const sum = (field: "fee" | "net") =>
        disputeTransactions.reduce((total, value) => total + (usdCents(value, field) ?? 0), 0)
      // Before Stripe settles the charge's balance transaction the fee is unknown and the net is the amount kept so far.
      const fee = transaction && usdCents(transaction, "fee")
      const net = transaction && usdCents(transaction, "net")
      const stripeFee = fee === undefined ? null : fee + sum("fee")
      const stripeNet = (net ?? price) - refunded + sum("net")
      const openRouterFee = Math.ceil((credits * openRouterFeePercent()) / 100)
      const entry: Entry = {
        charge: chargeID,
        kind: sale.kind,
        account: id,
        product: sale.product,
        created: Number(charge.created) * 1000,
        price,
        refunded,
        disputed,
        stripeFee,
        stripeNet,
        granted: sale.credits,
        credits,
        openRouterFee,
        profit: stripeNet - credits - openRouterFee,
        updatedAt: Date.now(),
      }
      await persistentStore(["HSET", LEDGER_KEY(), chargeID, JSON.stringify(entry)], fetcher)
      return entry
    },
    fetcher,
  )
}

/** Every entry, newest first. */
export async function codiumLedger(fetcher: typeof fetch = fetch) {
  return [...new Map((await ledgerPage(fetcher)).map((entry) => [entry.charge, entry])).values()]
    .sort((a, b) => a.created - b.created)
    .reverse()
}

/** The owner's view: totals overall and by month, with the funding check's last reading. */
export async function codiumLedgerSummary(fetcher: typeof fetch = fetch) {
  const entries = await codiumLedger(fetcher)
  const months = [...new Set(entries.map(month))]
  return {
    currency: "usd",
    unit: "cents",
    totals: totals(entries),
    months: months.map((value) => ({ month: value, ...totals(entries.filter((entry) => month(entry) === value)) })),
    funding: (await readCodiumFunding(fetcher)) ?? null,
    entries,
  }
}

/** The owner-only summary. Without the owner secret every method answers 404, so the route does not show itself. */
export async function handleCodiumLedger(request: ApiRequest, response: ApiResponse, fetcher: typeof fetch = fetch) {
  try {
    const secret = process.env.CODIUM_OWNER_SECRET?.trim() ?? ""
    const digest = (value: string) => createHash("sha256").update(value).digest()
    if (
      secret.length < 32 ||
      !timingSafeEqual(digest(String(request.headers.authorization ?? "")), digest(`Bearer ${secret}`))
    )
      throw new ApiError(404, "NOT_FOUND", "Not found.")
    requireMethod(request, "GET")
    const summary = await codiumLedgerSummary(fetcher)
    json(response, 200, queryValue(request, "entries") === "1" ? summary : { ...summary, entries: undefined })
  } catch (error) {
    handleApiError(response, error)
  }
}

function subscriptionSale(charge: Record<string, unknown>, id: string) {
  const invoice = stripeRecord(charge.invoice) ? charge.invoice : undefined
  const subscription = invoice && stripeRecord(invoice.subscription) ? invoice.subscription : undefined
  const metadata = subscription && stripeRecord(subscription.metadata) ? subscription.metadata : undefined
  const lines = invoice && stripeRecord(invoice.lines) && Array.isArray(invoice.lines.data) ? invoice.lines.data : []
  if (metadata?.vector_account_id !== id || typeof subscription?.id !== "string") return
  const priced = lines.filter(stripeRecord).flatMap((value) => {
    const price = stripeRecord(value.price) ? value.price : undefined
    const plan = modelPlans().find((item) => item.priceID && item.priceID === price?.id)
    return plan ? [{ line: value, plan }] : []
  })
  const line = priced[0]?.line
  const plan = priced[0]?.plan
  const period = line && stripeRecord(line.period) ? line.period : undefined
  const credits = subscriptionPlanCredits(metadata, plan)
  if (!plan || credits === undefined || !Number.isFinite(credits) || credits <= 0 || credits > plan.price) return
  return {
    kind: "subscription" as const,
    product: plan.id,
    credits: Math.round(credits * 100),
    subscription: subscription.id,
    start: Number(period?.start),
  }
}

/**
 * A refunded or disputed month's credits are switched off, but what was spent before that is still Vector's cost.
 * That is known while the account still holds the month's key; otherwise the whole month counts as spent.
 */
async function revokedMonthlyCost(
  account: NonNullable<Awaited<ReturnType<typeof readModelPlanAccount>>>,
  sale: { credits: number; subscription?: string; start?: number },
  fetcher: typeof fetch,
) {
  const key = account.key
  if (!key || key.subscription !== sale.subscription || key.start !== sale.start) return sale.credits
  const result = await openRouterManagement(`/${encodeURIComponent(key.hash)}`, undefined, fetcher)
  const usage = stripeRecord(result.data) ? result.data.usage : undefined
  if (typeof usage !== "number" || !Number.isFinite(usage) || usage < 0) return sale.credits
  return Math.min(sale.credits, Math.ceil(usage * 100 - 1e-6))
}

/**
 * A balance transaction's amount in US cents. An account that settles in another currency gets Stripe's exchange rate
 * on each transaction; this converts back with it, which is exact for currencies with two decimal places.
 */
function usdCents(transaction: Record<string, unknown>, field: "fee" | "net") {
  const value = transaction[field]
  if (!Number.isSafeInteger(value)) return undefined
  if (transaction.currency === undefined || transaction.currency === "usd") return Number(value)
  const rate = transaction.exchange_rate
  return typeof rate === "number" && Number.isFinite(rate) && rate > 0 ? Math.round(Number(value) / rate) : undefined
}

async function chargeDisputes(charge: string, fetcher: typeof fetch) {
  const result = await modelPlanStripe(`disputes?${new URLSearchParams({ charge, limit: "100" })}`, {}, fetcher)
  return Array.isArray(result.data) ? result.data.filter(stripeRecord) : []
}

function openRouterFeePercent() {
  // OpenRouter's published card fee on credit purchases; set CODIUM_OPENROUTER_FEE_PERCENT when its terms change.
  const value = Number(process.env.CODIUM_OPENROUTER_FEE_PERCENT?.trim() || 5.5)
  if (!Number.isFinite(value) || value < 0 || value > 100)
    throw new ApiError(
      503,
      "CODIUM_LEDGER_CONFIGURATION",
      "The OpenRouter fee for the Codium ledger is not configured correctly.",
    )
  return value
}

async function ledgerPage(fetcher: typeof fetch, cursor = "0"): Promise<Entry[]> {
  const result = await persistentStore(["HSCAN", LEDGER_KEY(), cursor, "COUNT", 500], fetcher)
  if (!Array.isArray(result) || !Array.isArray(result[1]))
    throw new ApiError(503, "CODIUM_LEDGER_UNAVAILABLE", "The Codium ledger could not be read.")
  const entries = result[1]
    .filter((_, index) => index % 2 === 1)
    .flatMap((value) => Option.toArray(Schema.decodeUnknownOption(Schema.fromJsonString(Entry))(value)))
  const next = String(result[0])
  return next === "0" ? entries : [...entries, ...(await ledgerPage(fetcher, next))]
}

const month = (entry: { created: number }) => new Date(entry.created).toISOString().slice(0, 7)

function totals(entries: readonly Entry[]) {
  return entries.reduce(
    (sum, entry) => ({
      payments: sum.payments + 1,
      price: sum.price + entry.price,
      refunded: sum.refunded + entry.refunded,
      stripeFee: sum.stripeFee + (entry.stripeFee ?? 0),
      stripeNet: sum.stripeNet + entry.stripeNet,
      credits: sum.credits + entry.credits,
      openRouterFee: sum.openRouterFee + entry.openRouterFee,
      profit: sum.profit + entry.profit,
      feesPending: sum.feesPending + (entry.stripeFee === null ? 1 : 0),
    }),
    {
      payments: 0,
      price: 0,
      refunded: 0,
      stripeFee: 0,
      stripeNet: 0,
      credits: 0,
      openRouterFee: 0,
      profit: 0,
      feesPending: 0,
    },
  )
}
