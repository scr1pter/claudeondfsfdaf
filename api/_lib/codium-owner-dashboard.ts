import { Option, Schema } from "effect"
import { CodiumOwner } from "../../packages/schema/src/codium-owner.js"
import { isPlanId } from "../../packages/schema/src/codium-plan.js"
import { CODIUM_FUNDING_MAX_AGE_MS, readCodiumFunding, readCodiumFundingHistory } from "./codium-funding.js"
import { codiumKey } from "./codium-keys.js"
import { notifyOwner } from "./codium-owner.js"
import { decodeSnapshot } from "./codium-snapshot.js"
import { readDisabledSet, readSwitchState, SWITCH_NAMES } from "./codium-switches.js"
import { decodeModelPlanAccount, ownerRefundQuote, subscriptionStanding } from "./model-plan-account.js"
import { modelPlans, modelPlansEnabled, requireModelPlans } from "./model-plan-config.js"
import { listStripe, modelPlanStripe, stripeMode, stripeModeProblems, stripeRecord } from "./model-plan-stripe.js"
import { persistentStore } from "./persistent-store.js"

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const DAY = 86_400_000
const ACCOUNT_LIMIT = 200
const safeCount = (value: unknown) => (Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null)
const healthy = (detail: string, checkedAt: number): CodiumOwner.Health => ({ status: "healthy", detail, checkedAt })
const unknown = (detail: string): CodiumOwner.Health => ({ status: "unknown", detail })

/** The dashboard is an explicit projection. No Stripe/customer/account object crosses this boundary wholesale. */
export async function readOwnerCodiumDashboard(
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<CodiumOwner.Dashboard> {
  const deadline = Date.now() + 30_000
  const bounded = (async (input, init) => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error("Owner dashboard reading timed out.")
    return fetcher(input, {
      ...init,
      signal: AbortSignal.any([
        ...(init?.signal ? [init.signal] : []),
        AbortSignal.timeout(Math.min(10_000, remaining)),
      ]),
    })
  }) as typeof fetch
  const configured = Boolean(process.env.STRIPE_SECRET_KEY?.trim()) && stripeModeProblems().length === 0
  const [stripe, values] = await Promise.all([
    configured ? stripeSummary(bounded, now).catch(() => undefined) : undefined,
    Promise.allSettled([
      readCodiumFunding(bounded),
      readCodiumFundingHistory(bounded, now),
      Promise.all(
        SWITCH_NAMES.map(async (name) => ({ name, ...(await readSwitchState(name, bounded, { fresh: true, now })) })),
      ),
      readDisabledSet("models-off", bounded, { fresh: true, now }),
      readDisabledSet("perks-off", bounded, { fresh: true, now }),
    ] as const),
  ])
  const funding = values[0].status === "fulfilled" ? values[0].value : undefined
  const history = values[1].status === "fulfilled" ? values[1].value : []
  const switches = values[2].status === "fulfilled" ? values[2].value : []
  const modelsOff = values[3].status === "fulfilled" ? [...values[3].value] : []
  const perksOff = values[4].status === "fulfilled" ? [...values[4].value] : []
  const store = await storeSummary(fetcher, stripe?.complete ? stripe.subscriptions : undefined, now).catch(
    () => undefined,
  )
  const sales = switches.find((value) => value.name === "sales")
  const fundingFresh =
    funding !== undefined && now - funding.checkedAt >= 0 && now - funding.checkedAt < CODIUM_FUNDING_MAX_AGE_MS
  const billingConfigured = (() => {
    try {
      requireModelPlans()
      return true
    } catch {
      return false
    }
  })()
  const enabled =
    modelPlansEnabled() && billingConfigured && sales?.value === "on" && fundingFresh && funding?.status === "open"
  const plans = modelPlans().flatMap((plan) =>
    isPlanId(plan.id)
      ? [
          {
            plan: plan.id,
            count: stripe?.complete
              ? stripe.subscriptions.filter(
                  (subscription) =>
                    owned(subscription, now)?.plan === plan.id &&
                    ["active", "past_due"].includes(String(subscription.status)),
                ).length
              : null,
            mrrCents: stripe?.complete
              ? stripe.subscriptions
                  .filter(
                    (subscription) =>
                      owned(subscription, now)?.plan === plan.id &&
                      ["active", "past_due"].includes(String(subscription.status)),
                  )
                  .reduce((sum) => sum + plan.price * 100, 0)
              : null,
          },
        ]
      : [],
  )
  const risk = stripe?.risk ?? { disputes30d: null, efw30d: null, paidInvoices30d: null, ratio: null }
  if (risk.ratio !== null && risk.ratio > 0.005)
    await notifyOwner(
      {
        kind: "risk-ratio",
        subject: "Vector Codium payment risk is above the alert threshold",
        lines: [
          "Disputes and early-fraud warnings recorded in the last 30 days exceed 0.5% of verified paid Codium invoices. Review the private Codium owner page.",
        ],
      },
      bounded,
    ).catch(() => undefined)
  return {
    generatedAt: now,
    sales: {
      enabled,
      reason: !modelPlansEnabled()
        ? "Codium is disabled by deployment configuration."
        : !billingConfigured
          ? "Codium billing configuration is incomplete."
          : sales?.value !== "on"
            ? "The runtime sales switch is off or unavailable."
            : !funding || !fundingFresh
              ? "No current verified funding reading is available."
              : funding.status === "paused"
                ? `Funding paused new sales: ${funding.reason ?? "unavailable"}.`
                : "Funding and the runtime sales switch permit new purchases.",
    },
    funding: funding
      ? {
          status: funding.status,
          ...(funding.reason ? { reason: funding.reason } : {}),
          checkedAt: funding.checkedAt,
          balance: funding.balance,
          owed: funding.owed,
          reserved: funding.reserved ?? null,
          required: funding.required,
          runwayDays: funding.runwayDays ?? null,
          spendPerDay: funding.spendPerDay ?? null,
          spendPerHour: funding.spendPerHour ?? null,
          lowWater: funding.lowWater ?? false,
          spike: funding.spike ?? false,
          watchdog: funding.topupWatchdog
            ? {
                threshold: funding.topupWatchdog.threshold,
                ...(funding.topupWatchdog.since === undefined ? {} : { since: funding.topupWatchdog.since }),
                overdue: funding.topupWatchdog.overdue,
              }
            : null,
        }
      : null,
    history: history.map((point) => ({
      checkedAt: point.checkedAt,
      balance: point.balance,
      owed: point.owed,
      reserved: point.reserved,
      required: point.required,
    })),
    subscriptions: plans,
    risk,
    health: {
      webhooks: store?.webhooks ?? unknown("Replay checkpoint could not be read."),
      outbox: store?.outbox ?? { depth: null, deadLetters: null },
      sweep: store?.sweep ?? unknown("Sweep progress could not be read."),
      store: store?.health ?? { status: "warning", detail: "The protected store could not be read." },
    },
    budgets: [
      {
        service: "OpenRouter",
        status: funding ? (funding.status === "open" && fundingFresh ? "healthy" : "warning") : "unknown",
        ...(funding?.usage === null || funding?.usage === undefined ? {} : { spentCents: funding.usage }),
        detail:
          "The funding guard counts paid allowance, reservations and the configured margin; it controls new sales.",
      },
      { service: "Hosted compute", status: "unconfigured", detail: "Spend guards are not configured in this build." },
      {
        service: "Cloudflare services",
        status: "unconfigured",
        detail: "Per-service budgets are installed with their service work packages.",
      },
    ],
    switches: switches.map((value) => ({
      name: value.name,
      value: value.value,
      changedAt: value.changedAt,
      ...(value.offSince === undefined ? {} : { offSince: value.offSince }),
    })),
    modelsOff,
    perksOff,
    accounts: store?.accounts ?? [],
    accountsComplete: store?.accountsComplete ?? false,
    stripeChecklist: [
      {
        id: "mode",
        title: "Stripe runtime mode",
        status: configured ? "confirmed" : "unconfigured",
        detail: configured
          ? `The runtime key and deployment mode agree (${stripeMode()}).`
          : "Configure the restricted runtime key and its matching Stripe mode.",
      },
      {
        id: "prices",
        title: "Monthly price IDs configured",
        status: modelPlans().every((plan) => Boolean(plan.priceID)) ? "confirmed" : "unconfigured",
        detail:
          "The setup script verifies four monthly prices, exclusive tax behavior and the Codium statement descriptor.",
      },
      {
        id: "portal",
        title: "No-change billing portal",
        status: "owner-check",
        detail: process.env.STRIPE_MODEL_PLAN_PORTAL_CONFIG_ID?.trim()
          ? "A portal configuration is set. Confirm that subscription changes are disabled in Stripe."
          : "Configure the no-change billing portal after running setup.",
      },
      {
        id: "webhook",
        title: "Webhook event list",
        status: "owner-check",
        detail: "Run the setup check to confirm exactly the 20 supported events and the endpoint signing secret.",
      },
      {
        id: "retries",
        title: "Smart Retries",
        status: "owner-check",
        detail: "In Stripe, enable retries and cancel after the last retry.",
      },
      {
        id: "emails",
        title: "Payment and authentication emails",
        status: "owner-check",
        detail: "In Stripe, enable customer emails for failed payments and 3-D Secure.",
      },
      {
        id: "terms",
        title: "Terms and tax settings",
        status: "owner-check",
        detail: "Confirm the published Codium terms URL and the reviewed tax configuration.",
      },
      {
        id: "radar",
        title: "Radar defaults",
        status: "owner-check",
        detail: "Review Radar defaults; the optional card block list needs its configured list ID.",
      },
    ],
    audit: store?.audit ?? [],
  }
}

async function stripeSummary(fetcher: typeof fetch, now: number) {
  const since = String(Math.floor((now - 30 * DAY) / 1000))
  const [subscriptions, invoices, disputes, warnings] = await Promise.all([
    listStripe(
      "subscriptions",
      [
        ["status", "all"],
        ["expand[]", "data.latest_invoice.charge"],
      ],
      { maxPages: 20 },
      fetcher,
    ),
    listStripe(
      "invoices",
      [
        ["status", "paid"],
        ["created[gte]", since],
        ["expand[]", "data.subscription"],
      ],
      { maxPages: 20 },
      fetcher,
    ),
    listStripe(
      "disputes",
      [
        ["created[gte]", since],
        ["expand[]", "data.charge.invoice.subscription"],
      ],
      { maxPages: 5 },
      fetcher,
    ),
    listStripe(
      "radar/early_fraud_warnings",
      [
        ["created[gte]", since],
        ["expand[]", "data.charge.invoice.subscription"],
      ],
      { maxPages: 5 },
      fetcher,
    ),
  ])
  const byID = new Map(
    subscriptions.data.flatMap((subscription) =>
      typeof subscription.id === "string" ? [[subscription.id, subscription] as const] : [],
    ),
  )
  const cached = new Map<string, Promise<Record<string, unknown>>>()
  const resolve = async (path: string, value: unknown) => {
    if (stripeRecord(value)) return value
    if (typeof value !== "string") return undefined
    const key = `${path}/${encodeURIComponent(value)}`
    if (!cached.has(key)) cached.set(key, modelPlanStripe(key, {}, fetcher))
    return cached.get(key)!
  }
  const belongs = async (value: unknown) => {
    const charge = await resolve("charges", value)
    const invoice = charge ? await resolve("invoices", charge.invoice) : undefined
    const sub = invoice
      ? stripeRecord(invoice.subscription)
        ? invoice.subscription
        : typeof invoice.subscription === "string"
          ? (byID.get(invoice.subscription) ?? (await resolve("subscriptions", invoice.subscription)))
          : undefined
      : undefined
    return Boolean(
      charge &&
        invoice &&
        sub &&
        charge.customer === invoice.customer &&
        invoice.customer === sub.customer &&
        owned(sub, now),
    )
  }
  const count = async (rows: readonly Record<string, unknown>[]) => {
    let total = 0
    for (let start = 0; start < rows.length; start += 4)
      total += (await Promise.all(rows.slice(start, start + 4).map((row) => belongs(row.charge)))).filter(
        Boolean,
      ).length
    return total
  }
  const paid = invoices.complete
    ? invoices.data.filter((invoice) => {
        const sub = stripeRecord(invoice.subscription)
          ? invoice.subscription
          : typeof invoice.subscription === "string"
            ? byID.get(invoice.subscription)
            : undefined
        return (
          sub &&
          invoice.customer === sub.customer &&
          invoice.paid === true &&
          invoice.status === "paid" &&
          Number.isSafeInteger(invoice.amount_paid) &&
          Number(invoice.amount_paid) > 0 &&
          owned(sub, now)
        )
      }).length
    : null
  const [disputeCount, warningCount] = await Promise.all([
    disputes.complete ? count(disputes.data) : null,
    warnings.complete ? count(warnings.data) : null,
  ])
  return {
    subscriptions: subscriptions.data,
    complete: subscriptions.complete,
    risk: {
      disputes30d: disputeCount,
      efw30d: warningCount,
      paidInvoices30d: paid,
      ratio: paid && disputeCount !== null && warningCount !== null ? (disputeCount + warningCount) / paid : null,
    },
  }
}

function owned(subscription: Record<string, unknown>, now: number) {
  const metadata = stripeRecord(subscription.metadata) ? subscription.metadata : undefined
  const account = metadata?.vector_account_id
  const customer = subscription.customer
  if (typeof account !== "string" || !UUID.test(account) || typeof customer !== "string") return undefined
  const standing = subscriptionStanding(subscription, account, now)
  return standing ? { account, customer, plan: standing.plan } : undefined
}

async function storeSummary(
  fetcher: typeof fetch,
  subscriptions: readonly Record<string, unknown>[] | undefined,
  now: number,
) {
  const ids = new Set<string>()
  const prefix = `${codiumKey("account")}:`
  let cursor = "0"
  let complete = true
  let pages = 0
  do {
    if (++pages > 10) {
      complete = false
      break
    }
    const scan = await persistentStore(["SCAN", cursor, "MATCH", `${prefix}*`, "COUNT", ACCOUNT_LIMIT], fetcher)
    if (!Array.isArray(scan) || scan.length !== 2 || !/^\d+$/.test(String(scan[0])) || !Array.isArray(scan[1]))
      throw new Error("Invalid account index")
    cursor = String(scan[0])
    const entries: unknown[] = scan[1]
    for (const key of entries)
      if (typeof key === "string" && key.startsWith(prefix) && UUID.test(key.slice(prefix.length)))
        ids.add(key.slice(prefix.length))
    if (ids.size >= ACCOUNT_LIMIT) {
      complete = cursor === "0" && ids.size <= ACCOUNT_LIMIT
      break
    }
  } while (cursor !== "0")
  const accounts = [...ids].slice(0, ACCOUNT_LIMIT)
  const keys = accounts.flatMap((account) => [codiumKey("account", account), codiumKey("ent", account)])
  const [records, depth, dead, replay, sweep, audit] = await Promise.all([
    keys.length ? persistentStore(["MGET", ...keys], fetcher) : [],
    persistentStore(["ZCARD", codiumKey("outbox")], fetcher),
    persistentStore(["ZCARD", codiumKey("outbox", "dead")], fetcher),
    persistentStore(["GET", codiumKey("stripe", "cursor")], fetcher),
    persistentStore(["GET", codiumKey("sweep", "daily")], fetcher),
    persistentStore(["ZREVRANGE", codiumKey("owner", "audit"), 0, 49], fetcher),
  ])
  if (
    !Array.isArray(records) ||
    records.length !== keys.length ||
    safeCount(depth) === null ||
    safeCount(dead) === null ||
    !Array.isArray(audit)
  )
    throw new Error("Invalid protected store reading")
  const rows: CodiumOwner.Account[] = []
  for (let index = 0; index < accounts.length; index++) {
    try {
      const account = accounts[index]!
      const record = decodeModelPlanAccount(records[index * 2])
      const snapshot = decodeSnapshot(records[index * 2 + 1], account)
      if (snapshot && snapshot.livemode !== (stripeMode() === "live")) {
        complete = false
        continue
      }
      const quote = subscriptions
        ? ownerRefundQuote(
            account,
            record,
            subscriptions.filter(
              (subscription) =>
                owned(subscription, now)?.account === account && subscription.customer === record.customer,
            ),
            now,
          )
        : undefined
      rows.push({
        account,
        state: snapshot?.state ?? "unknown",
        ...(snapshot?.plan ? { plan: snapshot.plan } : {}),
        ...(snapshot?.periodEnd ? { periodEnd: snapshot.periodEnd } : {}),
        blocked: record.risk?.blocked ?? false,
        openDisputes: Object.keys(record.risk?.openDisputes ?? {}).length,
        efw: record.risk?.efw.length ?? 0,
        ...(quote
          ? {
              refundCents: quote.expectedRefundCents,
              refundCharge: quote.expectedCharge,
              refundSubscription: quote.expectedSubscription,
              refundPeriodStart: quote.expectedPeriodStart,
            }
          : {}),
      })
    } catch {
      complete = false
    }
  }
  const checkpoint = safeCount(replay)
  const sweepState =
    typeof sweep === "string"
      ? Option.getOrUndefined(
          Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ startedAt: Schema.Number })))(sweep),
        )
      : undefined
  const events = audit.flatMap((raw) => {
    const parsed =
      typeof raw === "string"
        ? Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(CodiumOwner.Audit))(raw))
        : undefined
    return parsed ? [parsed] : []
  })
  return {
    accounts: rows,
    accountsComplete: complete,
    outbox: { depth: safeCount(depth), deadLetters: safeCount(dead) },
    health: healthy("The protected store and owner counters answered.", now),
    webhooks:
      checkpoint && now - checkpoint * 1000 >= 0 && now - checkpoint * 1000 < 20 * 60_000
        ? healthy("Replay has recently covered incoming Stripe events.", checkpoint * 1000)
        : unknown("No recent replay checkpoint is available; check webhook delivery and replay."),
    sweep: sweepState
      ? {
          status: "warning" as const,
          detail: "The daily audit has an unfinished durable walk.",
          checkedAt: sweepState.startedAt,
        }
      : unknown("No unfinished daily walk is recorded; a completion timestamp is not available."),
    audit: events,
  }
}
