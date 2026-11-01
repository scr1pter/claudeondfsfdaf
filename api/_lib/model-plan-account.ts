import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto"
import { Option, Schema } from "effect"
import {
  PLAN_REASONS,
  type EntitlementSnapshot,
  type PlanReason,
  type PlanState,
} from "../../packages/schema/src/codium-entitlements.js"
import { isPlanId, rank, type PlanId } from "../../packages/schema/src/codium-plan.js"
import type { AccountUser } from "./account.js"
import { withBillingMutation } from "./billing-lock.js"
import { requireCodiumSales, reserveCodiumSale } from "./codium-funding.js"
import { writeRampOwed } from "./codium-ramp.js"
import {
  initializeFreshModelPool,
  modelSpendStale,
  modelSpendUnavailable,
  monthlyShortfall,
  readModelSpendDay,
  readModelSpendLedger,
} from "./codium-spend-ledger.js"
import { readSwitch } from "./codium-switches.js"
import { syncCodiumCollection } from "./codium-collection.js"
import {
  authenticatedCharge,
  blockFraudCard,
  codiumChargeOwned,
  checkoutRiskFields,
  fraudRefundEnabled,
  readFraudWarning,
  refundFraudWarning,
  stripeObjectId,
} from "./codium-risk.js"
import { codiumKey, openRouterKeyName } from "./codium-keys.js"
import { codiumKeyLimitUsd, renewalGraceMinutes, TRUST_RAMP, POOL_RAMP } from "./codium-limits.js"
import { enqueueAction, registerAction, saveAccountAndReconcile } from "./codium-provision.js"
import { checkoutConsentFields, CODIUM_TERMS_DATE, sendCodiumConfirmation } from "./codium-consent.js"
import {
  carryMicro,
  changeUnavailable,
  releaseDowngrade,
  scheduleDowngrade,
  scheduledPlan,
  supersedeSubscription,
} from "./codium-plan-change.js"
// Every snapshot this module writes queues one outbox item per configured provisioner (contract §4.8), so the
// provisioners are registered wherever reconcile can run.
import "./codium-provisioners.js"
import {
  buildSnapshot,
  isStale,
  readSnapshot,
  readSnapshotForWrite,
  requireUsableSnapshot,
  SNAPSHOT_RECHECK_MS,
  writeSnapshot,
  type SnapshotFacts,
  type SnapshotSource,
} from "./codium-snapshot.js"
import {
  DEBIT_RETRY_MS,
  DEBITS_KEEP_MS,
  debitHoldTicket,
  dueDebitApplies,
  expectedLimitMicro,
  finishDebitApply,
  holdMember,
  isPoolPurpose,
  limitMatches,
  limitUsd,
  markDebitsApplied,
  MAX_POOL_HOLD_MS,
  microToUsd,
  placeHold,
  poolFigures,
  poolLedger,
  poolShareUsed,
  postponeDebitApply,
  readDebits,
  readPoolLedger,
  recordDebit,
  releaseHold,
  usdToMicro,
  usdToMicroCeil,
  validDebitRef,
  validRunId,
  type PoolBase,
  type PoolFunding,
  type PoolPurpose,
  type PoolTicket,
} from "./codium-pool.js"
import {
  modelPlanOrigin,
  modelPlans,
  modelPlansEnabled,
  MODEL_PLAN_ROOT,
  requireCodiumCheckoutUser,
  subscriptionPlanCredits,
} from "./model-plan-config.js"
import { listStripe, modelPlanStripe, stripeMode, stripeRecord } from "./model-plan-stripe.js"
import { ApiError } from "./http.js"
import { persistentStore } from "./persistent-store.js"

// `reservation` names the checkout's hold on Vector's OpenRouter balance (see reserveCodiumSale).
const Checkout = Schema.Struct({
  id: Schema.String,
  plan: Schema.String,
  url: Schema.String,
  expires: Schema.Number,
  reservation: Schema.optional(Schema.String),
  supersedes: Schema.optional(Schema.String),
})
const Micro = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const CarryOrigin = Schema.Struct({ charge: Schema.String, micro: Micro })
const KeyCreation = Schema.Struct({
  nonce: Schema.String,
  subscription: Schema.String,
  start: Schema.Number,
  end: Schema.Number,
  limitMicro: Micro,
  expiresAt: Schema.String,
})
/**
 * What holds an account's Codium regardless of what Stripe says is paid (contract §4.3, §4.4): disputes still open on
 * any of its charges, by charge, with Stripe's status and when Vector first saw it; charges with an early-fraud
 * warning; and a block, from a lost dispute, a refunded fraud warning (WP A10) or the owner. Reconcile keeps this from
 * Stripe's current state; only the owner clears a block or a warning.
 */
const Risk = Schema.Struct({
  blocked: Schema.Boolean,
  // "disputed", "early_fraud_warning" or "owner"; anything else reads as the owner's block.
  reason: Schema.optional(Schema.String),
  at: Schema.optional(Schema.Number),
  openDisputes: Schema.Record(Schema.String, Schema.Struct({ status: Schema.String, at: Schema.Number })),
  efw: Schema.Array(Schema.String),
  efwWarnings: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  refundTargets: Schema.optional(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  paused: Schema.optional(Schema.Array(Schema.String)),
  pauseTokens: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})
type Risk = typeof Risk.Type
const NO_RISK: Risk = { blocked: false, openDisputes: {}, efw: [] }
// Codium sells monthly plans only (WP A04). A record written while top-ups existed may still carry `topupCheckout`,
// `purchases` and `wallet`, in any shape: decoding ignores keys the struct does not name, so such a record still
// decodes, nothing reads those fields, and the next save leaves them out. Sales never opened, so no one holds
// purchased credits that would need honouring.
const Account = Schema.Struct({
  customer: Schema.String,
  closing: Schema.optional(Schema.Boolean),
  risk: Schema.optional(Risk),
  riskCleared: Schema.optional(
    Schema.Struct({
      warnings: Schema.Array(Schema.String),
      disputes: Schema.Array(
        Schema.Struct({ id: Schema.String, charge: Schema.String, status: Schema.Literal("lost") }),
      ),
    }),
  ),
  ownerRefunded: Schema.optional(Schema.Struct({ subscription: Schema.String, periodStart: Schema.Number })),
  ownerEnd: Schema.optional(
    Schema.Struct({
      id: Schema.String,
      at: Schema.Number,
      customer: Schema.String,
      charge: Schema.NullOr(Schema.String),
      refundCents: Micro,
      refundAttempt: Schema.optional(Micro),
      refund: Schema.optional(
        Schema.Struct({ amount: Micro, id: Schema.optional(Schema.String), status: Schema.optional(Schema.String) }),
      ),
      subscription: Schema.NullOr(Schema.String),
      periodStart: Schema.NullOr(Schema.Number),
      subscriptions: Schema.Array(Schema.String),
      checkouts: Schema.Array(Schema.String),
      done: Schema.Boolean,
    }),
  ),
  // Set by WP A10 once a rank 3 or higher payment passed 3-D Secure.
  highValueVerified: Schema.optional(Schema.Boolean),
  poolRamp: Schema.optional(
    Schema.Struct({
      startedAt: Schema.Number,
      until: Schema.Number,
      charge: Schema.String,
      ultraPeriod: Schema.optional(Schema.String),
    }),
  ),
  // Milliseconds. The first paid invoice; the first paid invoice of a rank 3 or higher price (restarted after a gap of
  // more than 14 days without a paid period: the trust ramp); the start of an unbroken Max or Ultra run (private); and
  // the end of the last paid period, which measures that gap.
  firstPaidAt: Schema.optional(Schema.Number),
  firstHighPaidAt: Schema.optional(Schema.Number),
  memberSince: Schema.optional(Schema.Number),
  paidThrough: Schema.optional(Schema.Number),
  checkout: Schema.optional(Checkout),
  downgrade: Schema.optional(Schema.Struct({ plan: Schema.String, token: Schema.String })),
  consent: Schema.optional(
    Schema.Struct({
      session: Schema.String,
      terms_of_service: Schema.String,
      terms_date: Schema.String,
      confirmationSent: Schema.optional(Schema.Boolean),
    }),
  ),
  // The barrier every key replacement saves before it reads any source balance (renewal, upgrade, a downgrade taking
  // effect). It changes the private record that HOLD and ADMIT fence on, so a hold or admission observed earlier can
  // never land after the source ledger was read; the save that publishes the new key clears it. A replacement whose
  // period stops governing first is abandoned by the same-period path (provisionMonthlyKey).
  transition: Schema.optional(Schema.Struct({ subscription: Schema.String, start: Schema.Number, at: Schema.Number })),
  // Persisted before creating an A17 pool; the nonce cannot refer to a pre-A17/exposed key.
  keyCreation: Schema.optional(KeyCreation),
  // Creations whose replacement was abandoned before its key was published (`abandonReplacement`). Their key may exist
  // with its answer lost, so a later creation for the same period reuses the nonce and OpenRouter's idempotent create
  // answers that key instead of making a second funded one. Neither the fence nor the credential reads this field.
  abandonedCreations: Schema.optional(Schema.Array(KeyCreation)),
  // Persisted before disabling the old key or creating its replacement: a retry keeps exactly the same carry.
  upgrade: Schema.optional(
    Schema.Struct({
      subscription: Schema.String,
      start: Schema.Number,
      at: Schema.Number,
      micro: Micro,
      fromSubscription: Schema.String,
      fromStart: Schema.Number,
      fromCharge: Schema.String,
      fromHash: Schema.String,
      fromLimitMicro: Micro,
      fromAppliedMicro: Micro,
      origins: Schema.Array(CarryOrigin),
      sourceOrigins: Schema.Array(CarryOrigin),
      visibleOrigins: Schema.Array(CarryOrigin),
      fromVisibleLimitMicro: Micro,
      fullMicro: Micro,
      rampUntil: Schema.optional(Schema.Number),
    }),
  ),
  key: Schema.optional(
    Schema.Struct({
      hash: Schema.String,
      provisioning: Schema.optional(Schema.Boolean),
      spendGenesis: Schema.optional(
        Schema.Struct({ nonce: Schema.String, state: Schema.Literals(["pending", "ready"]) }),
      ),
      encrypted: Schema.String,
      subscription: Schema.String,
      start: Schema.Number,
      end: Schema.Number,
      credits: Schema.Number,
      // The pool in integer micro-dollars (codium-pool.ts): the credits this key grants (test-mode cap applied), the
      // carry an upgrade brought (WP A09), and the limit last set on the key, credits + carry − applied debits. A
      // record written before these existed has no debits, so its limit is its credits.
      creditsMicro: Schema.optional(Micro),
      fullCreditsMicro: Schema.optional(Micro),
      carry: Schema.optional(
        Schema.Struct({
          micro: Micro,
          fromSubscription: Schema.String,
          fromStart: Schema.Number,
          fromCharge: Schema.String,
          fromHash: Schema.optional(Schema.String),
          fromLimitMicro: Schema.optional(Micro),
          fromAppliedMicro: Schema.optional(Micro),
          trueupAt: Schema.optional(Schema.Number),
          revoked: Schema.optional(Schema.Boolean),
          origins: Schema.optional(Schema.Array(CarryOrigin)),
          sourceOrigins: Schema.optional(Schema.Array(CarryOrigin)),
          visibleOrigins: Schema.optional(Schema.Array(CarryOrigin)),
          fromVisibleLimitMicro: Schema.optional(Micro),
          fullMicro: Schema.optional(Micro),
          // Set by the first completed true-up: `fullMicro` is then settled, not an upper bound (settledCarryOrigins).
          trued: Schema.optional(Schema.Boolean),
          rampUntil: Schema.optional(Schema.Number),
          revokedOrigins: Schema.optional(Schema.Array(Schema.String)),
        }),
      ),
      limitMicro: Schema.optional(Micro),
      // Why reconcile switched this key off for good: the account ended while it was the current key (its charge
      // refunded, a lost dispute, a refunded fraud warning, the plan cancelled or unpaid). That period was not kept,
      // so a renewal of it never turns this key back on (M11 keeps only a paid period's key serving).
      revoked: Schema.optional(Schema.Literals(PLAN_REASONS)),
    }),
  ),
})
type Account = typeof Account.Type
type AccountKey = NonNullable<Account["key"]>
const accountKey = (id: string) => codiumKey("account", id)

/** The pool one key pays from: its credits and carry, and the limit the key should have now. */
function keyPool(key: AccountKey): PoolBase & { limitMicro: number } {
  const creditsMicro = key.creditsMicro ?? usdToMicro(codiumKeyLimitUsd(key.credits))
  const carryMicro = key.carry?.micro ?? 0
  return { creditsMicro, carryMicro, limitMicro: key.limitMicro ?? creditsMicro + carryMicro }
}

/**
 * When a period's key stops working on its own: the period's end plus the renewal grace (contract §4.4, M11), so a
 * renewal that is still being collected never locks out someone who pays. Reconcile switches the key off sooner when
 * the renewal fails, the plan ends or the account is held, and a paid renewal replaces it with the next period's key.
 */
export function keyExpiresAt(periodEnd: number) {
  return new Date(periodEnd * 1000 + renewalGraceMinutes() * 60_000).toISOString()
}

/**
 * The account's billing lease. Checkout, deletion, the webhook and model requests all serialize on this one key, in the
 * same mode namespace as the account it guards.
 */
function withAccountLease<T>(id: string, work: (verify: () => Promise<void>) => Promise<T>, fetcher: typeof fetch) {
  return withBillingMutation(`model-plan:${id}`, work, fetcher, { key: codiumKey("lease", id) })
}

export async function readModelPlanAccount(id: string, fetcher: typeof fetch = fetch) {
  const saved = await persistentStore(["GET", accountKey(id)], fetcher)
  if (saved === null) return undefined
  return decodeModelPlanAccount(saved)
}
export function decodeModelPlanAccount(raw: unknown) {
  const decoded =
    typeof raw === "string"
      ? Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(Account))(raw))
      : undefined
  if (!decoded) throw new ApiError(503, "MODEL_PLAN_ACCOUNT_INVALID", "Model access could not be verified.")
  return decoded
}

/**
 * The Vector account a Stripe customer pays for: the customer's `vector_account_id`, read again from Stripe, when that
 * account's record names this customer. Undefined for a customer that is not a Codium account's (another product's, or
 * one whose record has moved on), which billing notifications then leave alone.
 */
export async function accountForCustomer(customer: string, fetcher: typeof fetch = fetch) {
  const record = await modelPlanStripe(`customers/${encodeURIComponent(customer)}`, {}, fetcher)
  const id = stripeRecord(record.metadata) ? record.metadata.vector_account_id : undefined
  if (typeof id !== "string" || !id) return undefined
  const account = await readModelPlanAccount(id, fetcher)
  if (account?.customer === customer) return id
  // Ids only: never the person.
  if (account)
    console.warn("Vector Codium: a billing notification names a customer the account no longer uses", { account: id })
  return undefined
}

async function saveAccount(id: string, value: Account, fetcher: typeof fetch) {
  await persistentStore(["SET", accountKey(id), JSON.stringify(value)], fetcher)
}

/**
 * A call to OpenRouter's key management API. Creating a key (POST) names an idempotency key, so a create retried after a
 * lost answer can be recognised instead of leaving a second funded key behind; the account lease is what serializes
 * the creates themselves.
 */
export async function openRouterManagement(
  path: string,
  body?: Record<string, unknown>,
  fetcher: typeof fetch = fetch,
  method = "GET",
  idempotency?: string,
) {
  if (method === "POST" && !idempotency?.trim())
    throw new ApiError(500, "MODEL_PLAN_IDEMPOTENCY_REQUIRED", "Your model allowance could not be created.")
  const response = await fetcher(`${MODEL_PLAN_ROOT}/keys${path}`, {
    method,
    headers: {
      authorization: `Bearer ${process.env.OPENROUTER_MANAGEMENT_KEY ?? ""}`,
      "content-type": "application/json",
      ...(idempotency ? { "Idempotency-Key": idempotency } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  })
  const result: unknown = await response.json().catch(() => undefined)
  if (!response.ok || !stripeRecord(result))
    throw new ApiError(503, "MODEL_PLAN_UPSTREAM", "Your model allowance is temporarily unavailable.")
  return result
}

// The webhook and model requests wait this long for the account's lease before answering BILLING_MUTATION_BUSY.
const LEASE_WAIT_MS = 5_000

/**
 * The account's billing lease for the payment webhook and model requests, which wait briefly for it instead of failing
 * at once: Stripe sends several notifications for one payment at the same moment, and a buyer's first request often
 * arrives while one of them is still granting the credits. Checkout and account deletion still refuse at once.
 */
export async function withCodiumLease<T>(
  id: string,
  work: (verify: () => Promise<void>) => Promise<T>,
  fetcher: typeof fetch = fetch,
  deadline = Date.now() + LEASE_WAIT_MS,
): Promise<T> {
  return withAccountLease(id, work, fetcher).catch(async (error: unknown) => {
    if (!(error instanceof ApiError) || error.code !== "BILLING_MUTATION_BUSY" || Date.now() >= deadline) throw error
    await new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 150))
    return withCodiumLease(id, work, fetcher, deadline)
  })
}

export function protectModelPlanKey(value: string, context: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv)
  cipher.setAAD(Buffer.from(context))
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url")
}

export function revealModelPlanKey(value: string, context: string) {
  const bytes = Buffer.from(value, "base64url")
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), bytes.subarray(0, 12))
  decipher.setAAD(Buffer.from(context))
  decipher.setAuthTag(bytes.subarray(12, 28))
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8")
}

function encryptionKey() {
  const key = process.env.MODEL_PLAN_KEY_ENCRYPTION_SECRET ?? ""
  if (!/^[a-fA-F0-9]{64}$/.test(key))
    throw new ApiError(503, "MODEL_PLAN_ENCRYPTION", "Vector Codium is temporarily unavailable.")
  return Buffer.from(key, "hex")
}

/**
 * Whether a disputed charge may still pay for its month. `Charge.disputed` is historical, so a resolved dispute can
 * leave it true: only conclusively merchant-won or closed-inquiry disputes on this charge restore it. Unknown,
 * pending, lost, truncated and mismatched results all leave it unavailable.
 */
async function chargeAvailable(charge: Record<string, unknown>, chargeID: string, fetcher: typeof fetch) {
  if (charge.disputed === false) return true
  if (charge.disputed !== true || !chargeID) return false
  const query = new URLSearchParams({ charge: chargeID, limit: "100" })
  const result = await modelPlanStripe(`disputes?${query}`, {}, fetcher)
  return (
    result.has_more === false &&
    Array.isArray(result.data) &&
    result.data.length > 0 &&
    result.data.every(
      (value) =>
        stripeRecord(value) && ["won", "warning_closed"].includes(String(value.status)) && value.charge === chargeID,
    )
  )
}

/** A notification's object that reconcile must re-read itself, because no subscription points at it. */
export type ReconcileHint =
  /** A dispute on one of the customer's charges, current month or not. */
  | { kind: "dispute"; charge: string }
  /** An early-fraud warning, by id, on one of the customer's charges. */
  | { kind: "efw"; id: string; charge?: string }

const DAY_MS = 86_400_000

/**
 * Reconciles the account from Stripe now, unless that already happened in the last minute: `reconcile:<id>` is taken
 * with SET NX for 60 s, so a hundred requests at a period's end make one Stripe call, and an account without a plan
 * at most one a minute. Undefined when another request holds the minute.
 */
export async function reconcileOnDemand(
  account: string,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<EntitlementSnapshot | undefined> {
  const taken = await persistentStore(
    ["SET", codiumKey("reconcile", account), String(now), "NX", "PX", SNAPSHOT_RECHECK_MS],
    fetcher,
  )
  if (taken !== "OK") return undefined
  return reconcileModelPlanAccount(account, fetcher, now, { source: "request" })
}

// While another request reconciles an account that has no snapshot yet, wait this long, in steps, for its answer.
const MISSING_WAIT_MS = 2_000
const MISSING_STEP_MS = 200

/**
 * The account's snapshot, by the read rules (contract §4.3; codium-entitlements.ts re-exports it): a fresh one as
 * stored; a stale one (over 6 hours old, past its period, or a `none` or `renewing` one over a minute old) served after
 * one reconcile, or as it is when another request is already reconciling or Stripe cannot be read; a missing one
 * reconciled on demand. When there is none and the reconcile that would write it is running elsewhere and did not
 * finish in time, an account with a Codium record (every checkout makes one, so it may have just paid) is answered
 * 503 `MODEL_PLAN_RENEWING` to read again shortly, never a final "choose a plan"; only an account without a record
 * gets undefined, which has no plan. A snapshot from the other Stripe mode is refused (503). It lives beside
 * `reconcileOnDemand` so `holdPool` reads by the same rules as chat without an import cycle.
 */
export async function readEntitlement(
  account: string,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<EntitlementSnapshot | undefined> {
  const stored = await readSnapshot(account, fetcher)
  if (stored && !isStale(stored, now)) return stored
  const fresh = await reconcileOnDemand(account, fetcher, now).catch((error: unknown) => {
    // A stale snapshot is still the best answer while Stripe or the lease is unavailable; a missing one is not.
    if (stored) return undefined
    throw error
  })
  if (fresh) return fresh
  if (stored) return stored
  for (let waited = 0; waited < MISSING_WAIT_MS; waited += MISSING_STEP_MS) {
    await new Promise((resolve) => setTimeout(resolve, MISSING_STEP_MS))
    const written = await readSnapshot(account, fetcher)
    if (written) return written
  }
  if (await readModelPlanAccount(account, fetcher)) throw modelSpendStale()
  return undefined
}

/**
 * Brings the account in line with Stripe's current state (contract §4.3, §4.4) and writes its entitlement snapshot,
 * which every service reads instead of calling Stripe. It reads the account's subscriptions and the disputes and
 * fraud warnings that hold it, picks the governing subscription, maps it to a state, records the payment history, and
 * converges the OpenRouter key: the paid period's key gets the pool's limit (each period gets a new key, so monthly
 * credits reset rather than roll over), a renewing account keeps its previous key, and every other state switches
 * the key off. It reads Stripe rather than applying the notification, so a replayed or out-of-order notification
 * changes nothing; the snapshot's version moves only when something changed. Only this function, and account deletion,
 * write a snapshot.
 */
export async function reconcileModelPlanAccount(
  id: string,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
  options: { source?: SnapshotSource; hint?: ReconcileHint } = {},
): Promise<EntitlementSnapshot> {
  const source = options.source ?? "webhook"
  return withCodiumLease(
    id,
    async (verify) => {
      const stored = await readSnapshotForWrite(id, fetcher)
      const account = await readModelPlanAccount(id, fetcher)
      if (!account)
        return commitSnapshot(
          { account: id, state: "none", plan: null, periodStart: 0, periodEnd: 0, cancelAtPeriodEnd: false, source },
          stored,
          fetcher,
          now,
          verify,
        )
      if (account.closing) {
        // The snapshot that ends access goes first, as for every state that stops the key (see below).
        const closed = await commitSnapshot(
          closingFacts(id, account, stored.previous, source),
          stored,
          fetcher,
          now,
          verify,
        )
        if (account.key) await disableKey(account.key, verify, fetcher)
        await writeRampOwed(id, 0, fetcher)
        return closed
      }
      const listed = await listSubscriptions(account.customer, fetcher)
      const review = await reviewRisk(id, account, listed, options.hint, fetcher, now)
      const current = listed.map((subscription) => clearWonDispute(subscription, review.cleared))
      const reviewed = { ...account, risk: review.risk, riskCleared: review.riskCleared }
      const standing = revokedRenewal(
        reviewed,
        planStanding(id, reviewed, current, now, { known: knownPeriods(account, stored.previous) }),
      )
      const updated = await recordCheckoutConsent(
        id,
        revokeEndedKey(recordPoolRamp(reviewed, recordPaidHistory(reviewed, standing), standing), standing),
        standing.state === "active",
        fetcher,
        verify,
        now,
      )
      if (accountChanged(account, updated)) {
        await verify()
        await saveAccount(id, updated, fetcher)
      }
      // M11: while renewing, the previous period's key keeps serving, at its pool's limit, until the renewal is paid or
      // its grace runs out (the key's own expiry is the period's end plus the grace).
      const previous = standing.state === "renewing" ? renewingKey(updated, standing.governing) : undefined
      const serving = (standing.state === "active" && !!standing.governing?.paid) || !!previous
      if (standing.state === "active" && standing.governing?.paid)
        await provisionMonthlyKey(id, updated, standing.governing.paid, fetcher, verify, now)
      else if (previous)
        await convergeKey(id, await abandonReplacement(id, updated, verify, fetcher, now), previous, verify, fetcher, {
          expiresAt: keyExpiresAt(standing.governing!.end),
        })
      if (standing.duplicates.length)
        // Owner alerts arrive with WP A11; until then the log names the subscriptions, never the person.
        console.warn("Vector Codium: an account has more than one live subscription", {
          account: id,
          governing: standing.governing?.id,
          duplicates: standing.duplicates,
        })
      const governing = standing.governing
      const planned = standing.state !== "none"
      const snapshot = await commitSnapshot(
        {
          account: id,
          state: standing.state,
          ...(standing.reason ? { reason: standing.reason } : {}),
          plan: planned ? (governing?.plan ?? stored.previous?.plan ?? null) : null,
          ...(planned && (governing?.id ?? stored.previous?.subscription)
            ? { subscription: governing?.id ?? stored.previous?.subscription }
            : {}),
          // Without a plan there is no period: an incomplete checkout's dates mean nothing yet.
          periodStart: !planned ? 0 : governing ? governing.start * 1000 : (stored.previous?.periodStart ?? 0),
          periodEnd: !planned ? 0 : governing ? governing.end * 1000 : (stored.previous?.periodEnd ?? 0),
          cancelAtPeriodEnd: governing?.cancelAtPeriodEnd ?? false,
          ...(governing
            ? {
                scheduled: await scheduledPlan(
                  current.find((value) => value.id === governing.id),
                  fetcher,
                ),
              }
            : {}),
          ...history(updated),
          ...(updated.poolRamp
            ? {
                poolUntil: updated.poolRamp.until,
                poolDailyShare:
                  updated.poolRamp.ultraPeriod === `${governing?.id}:${governing?.start}`
                    ? POOL_RAMP.ultraDailyShare
                    : undefined,
              }
            : {}),
          source,
        },
        stored,
        fetcher,
        now,
        verify,
      )
      // Past due, unpaid, ended, refunded, disputed, warned or blocked, and a renewing account's key from any other
      // period: the key stops at once (M5). The snapshot that ends access, and the outbox items it queues, are written
      // first, so every service that reads it stops even while OpenRouter cannot be reached; a PATCH that fails throws,
      // and the queued reconcile switches the key off when it runs again.
      if (standing.state === "frozen") {
        // A disputed payment may become usable again before any key was provisioned. Keep that obligation funded too.
        const contracted = current.reduce((sum, subscription) => {
          const invoice = stripeRecord(subscription.latest_invoice) ? subscription.latest_invoice : undefined
          const metadata = stripeRecord(subscription.metadata) ? subscription.metadata : undefined
          const plan = modelPlans().find((value) => value.id === metadata?.vector_plan)
          return subscription.status === "active" &&
            metadata?.vector_account_id === id &&
            invoice?.paid === true &&
            plan
            ? sum + usdToMicro(codiumKeyLimitUsd(plan.credits))
            : sum
        }, 0)
        const previous = updated.key
          ? (updated.key.fullCreditsMicro ?? keyPool(updated.key).creditsMicro) + carryPotential(updated.key.carry)
          : 0
        await writeRampOwed(id, Math.max(contracted, previous), fetcher, "raise")
      }
      if (!serving && updated.key) await disableKey(updated.key, verify, fetcher)
      // Access is durably stopped before a refund/cancel/pause can fail or time out.
      if (standing.state === "ended" || standing.state === "none") await writeRampOwed(id, 0, fetcher)
      await applyRiskEffects(id, updated, current, review.actionable, verify, fetcher, now)
      if (updated.ownerEnd && !updated.ownerEnd.done)
        return finishOwnerEnd(id, (await readModelPlanAccount(id, fetcher)) ?? updated, verify, fetcher, now)
      await syncCodiumCollection(
        id,
        (await readModelPlanAccount(id, fetcher)) ?? updated,
        current,
        verify,
        fetcher,
        now,
      )
      if (updated.poolRamp && now < updated.poolRamp.until)
        await enqueueAction(
          "pool-ramp",
          `${id}:${updated.poolRamp.startedAt}`,
          { account: id, until: updated.poolRamp.until },
          updated.poolRamp.until,
          fetcher,
          now,
        )
      return snapshot
    },
    fetcher,
  )
}

/** Switches a key off. Callers hold the lease. */
async function disableKey(key: AccountKey, verify: () => Promise<void>, fetcher: typeof fetch) {
  await verify()
  await openRouterManagement(`/${encodeURIComponent(key.hash)}`, { disabled: true }, fetcher, "PATCH")
}

/**
 * The account's state when it is renewing a period whose key reconcile switched off for good (the subscription went on
 * billing after the month was refunded, for example from Stripe's dashboard): that period was not kept, so its renewal
 * keeps nothing on until it is paid, and the account stays ended for the reason its key was switched off. Any other
 * standing is returned as it is.
 */
function revokedRenewal(account: Account, standing: ReturnType<typeof planStanding>): ReturnType<typeof planStanding> {
  const key = account.key
  const governing = standing.governing
  if (standing.state !== "renewing" || !key?.revoked || !governing) return standing
  if (key.subscription !== governing.id || key.start !== governing.start) return standing
  return { ...standing, state: "ended", reason: key.revoked }
}

/** The record with its current key marked revoked once the account ended, so no renewal of its period revives it. */
function revokeEndedKey(account: Account, standing: ReturnType<typeof planStanding>): Account {
  if (standing.state !== "ended" || !account.key || account.key.revoked) return account
  return { ...account, key: { ...account.key, revoked: standing.reason ?? "canceled" } }
}

/**
 * Writes the snapshot for `facts` over what was stored, still holding the lease, so a reconcile that ran out of time
 * cannot overwrite a newer one written meanwhile; when a newer one is already there, answers that instead.
 */
async function commitSnapshot(
  facts: SnapshotFacts,
  stored: { previous?: EntitlementSnapshot; version: number },
  fetcher: typeof fetch,
  now: number,
  verify: () => Promise<void>,
) {
  const snapshot = buildSnapshot(facts, stored.previous, now, stored.version)
  await verify()
  const { written } = await writeSnapshot(snapshot, stored.previous, fetcher, now)
  if (!written) return (await readSnapshot(facts.account, fetcher)) ?? snapshot
  return snapshot
}

function history(account: Account) {
  return {
    ...(account.firstPaidAt === undefined ? {} : { firstPaidAt: account.firstPaidAt }),
    ...(account.firstHighPaidAt === undefined ? {} : { firstHighPaidAt: account.firstHighPaidAt }),
    ...(account.memberSince === undefined ? {} : { memberSince: account.memberSince }),
  }
}

/** A deleted account's snapshot: ended for good, keeping the plan and period it last had for the owner's records. */
function closingFacts(
  id: string,
  account: Account,
  previous: EntitlementSnapshot | undefined,
  source: SnapshotSource,
): SnapshotFacts {
  return {
    account: id,
    state: "ended",
    reason: "closing",
    plan: previous?.plan ?? null,
    ...(previous?.subscription ? { subscription: previous.subscription } : {}),
    periodStart: previous?.periodStart ?? 0,
    periodEnd: previous?.periodEnd ?? 0,
    cancelAtPeriodEnd: false,
    ...history(account),
    source,
  }
}

/** Periods this account is known to have had, in seconds: the current key's and the last snapshot's. */
function knownPeriods(account: Account, previous: EntitlementSnapshot | undefined) {
  return [
    ...(account.key
      ? [{ subscription: account.key.subscription, start: account.key.start, end: account.key.end }]
      : []),
    ...(previous?.subscription
      ? [
          {
            subscription: previous.subscription,
            start: Math.floor(previous.periodStart / 1000),
            end: Math.floor(previous.periodEnd / 1000),
          },
        ]
      : []),
  ]
}

/** Whether reconcile changed the record, whatever order its fields are in. */
function accountChanged(before: Account, after: Account) {
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([, field]) => field !== undefined)
              .sort(([a], [b]) => (a < b ? -1 : 1))
              .map(([name, field]) => [name, stable(field)]),
          )
        : value
  return JSON.stringify(stable(before)) !== JSON.stringify(stable(after))
}

// ── Risk: disputes and early-fraud warnings ──────────────────────────────────────────────────────────────────────

// Stripe's dispute statuses at the pinned API version. Any status not listed here counts as open: it fails closed.
const WON_DISPUTE = new Set(["won", "warning_closed"])
const LOST_DISPUTE = new Set(["lost"])

/**
 * Where the disputes on one charge stand: lost if any was lost, open if any is still open (or cannot be read), won
 * once every one of them was won or closed as an inquiry. A charge Stripe marks disputed with no dispute listed, or
 * with more than one page of them, counts as open.
 */
async function disputeOutcome(
  charge: string,
  fetcher: typeof fetch,
  acknowledged: readonly { id: string; charge: string; status: "lost" }[] = [],
) {
  const query = new URLSearchParams({ charge, limit: "100" })
  const result = await modelPlanStripe(`disputes?${query}`, {}, fetcher)
  const disputes = Array.isArray(result.data) ? result.data.filter(stripeRecord) : []
  if (result.has_more !== false || !disputes.length || disputes.some((value) => value.charge !== charge))
    return { kind: "open" as const, status: "unknown" }
  const open = disputes.find(
    (value) => !WON_DISPUTE.has(String(value.status)) && !LOST_DISPUTE.has(String(value.status)),
  )
  if (open) return { kind: "open" as const, status: typeof open.status === "string" ? open.status : "unknown" }
  const lost = disputes.filter((value) => LOST_DISPUTE.has(String(value.status)))
  if (
    lost.some(
      (value) =>
        !acknowledged.some(
          (entry) => entry.id === value.id && entry.charge === charge && entry.status === value.status,
        ),
    )
  )
    return { kind: "lost" as const, status: "lost" }
  return lost.length ? { kind: "acknowledged" as const, status: "lost" } : { kind: "won" as const, status: "won" }
}

/**
 * Brings `risk` in line with Stripe: every charge with a dispute this account has seen (the notified one, any latest
 * charge Stripe marks disputed, and every dispute still open in the record) is read again. A dispute on any Codium
 * charge holds the account, not only one on the latest (M5). A lost dispute blocks it. An early-fraud warning named by
 * a notification is read again and recorded against its charge. Returns the charges whose disputes were all won, which
 * may pay for their month again.
 */
async function reviewRisk(
  accountID: string,
  account: Account,
  subscriptions: readonly Record<string, unknown>[],
  hint: ReconcileHint | undefined,
  fetcher: typeof fetch,
  now: number,
) {
  const before = account.risk ?? NO_RISK
  const risk = {
    ...before,
    openDisputes: { ...before.openDisputes },
    efw: [...before.efw],
    efwWarnings: { ...before.efwWarnings },
    refundTargets: { ...before.refundTargets },
    paused: [...(before.paused ?? [])],
    pauseTokens: { ...before.pauseTokens },
  }
  const charges = new Set<string>(Object.keys(risk.openDisputes))
  if (
    hint?.kind === "dispute" &&
    validChargeId(hint.charge) &&
    (await codiumChargeOwned(accountID, account.customer, hint.charge, fetcher))
  )
    charges.add(hint.charge)
  for (const subscription of subscriptions) {
    if (
      !stripeRecord(subscription.metadata) ||
      subscription.metadata.vector_account_id !== accountID ||
      !isPlanId(subscription.metadata.vector_plan)
    )
      continue
    const charge = latestCharge(subscription)
    if (charge?.disputed === true && typeof charge.id === "string") charges.add(charge.id)
  }
  const cleared = new Set<string>()
  let acknowledged = [...(account.riskCleared?.disputes ?? [])]
  for (const charge of charges) {
    const outcome = await disputeOutcome(charge, fetcher, acknowledged)
    if (outcome.kind === "open") {
      acknowledged = acknowledged.filter((entry) => entry.charge !== charge)
      risk.openDisputes[charge] = { status: outcome.status, at: before.openDisputes[charge]?.at ?? now }
      continue
    }
    delete risk.openDisputes[charge]
    if (outcome.kind === "won") cleared.add(charge)
    else if (outcome.kind === "lost" && !risk.blocked)
      Object.assign(risk, { blocked: true, reason: "disputed", at: now })
  }
  const warnings = new Map<string, Awaited<ReturnType<typeof readFraudWarning>>>()
  if (hint?.kind === "efw" && !account.riskCleared?.warnings.includes(hint.id)) {
    const warning = await readFraudWarning(accountID, account.customer, hint.id, fetcher)
    warnings.set(hint.id, warning)
    if (warning && (!hint.charge || hint.charge === warning.charge) && !risk.efw.includes(warning.charge))
      risk.efw.push(warning.charge)
    if (warning && (!hint.charge || hint.charge === warning.charge)) risk.efwWarnings[hint.id] = warning.charge
  }
  const actionable: string[] = []
  for (const [warningID, charge] of Object.entries(risk.efwWarnings)) {
    const warning = warnings.has(warningID)
      ? warnings.get(warningID)
      : await readFraudWarning(accountID, account.customer, warningID, fetcher)
    if (warning?.charge === charge && warning.actionable && fraudRefundEnabled()) actionable.push(charge)
  }
  const currentCharges = subscriptions.flatMap((subscription) => {
    const paid = paidModelPlan(clearWonDispute(subscription, cleared), accountID, now)
    return paid?.charge ? [paid.charge] : []
  })
  for (const source of actionable)
    risk.refundTargets[source] = [...new Set([...(risk.refundTargets[source] ?? []), ...currentCharges])]
  if (actionable.length && (!risk.blocked || risk.reason === "owner"))
    Object.assign(risk, { blocked: true, reason: "early_fraud_warning", at: now })
  // A fresh observation that collection is unpaused starts a new idempotent intent. A prior successful intent may
  // have been deliberately undone by the owner, so its old Stripe key must not be reused.
  for (const subscription of subscriptions) {
    if (
      subscription.status === "canceled" ||
      typeof subscription.id !== "string" ||
      !stripeRecord(subscription.metadata) ||
      subscription.metadata.vector_account_id !== accountID ||
      !isPlanId(subscription.metadata.vector_plan)
    )
      continue
    const collection = stripeRecord(subscription.pause_collection) ? subscription.pause_collection : undefined
    const owned =
      collection?.behavior === "void" && !collection.resumes_at && subscription.metadata.vector_risk_pause === accountID
    if (subscription.pause_collection && !owned) {
      const at = risk.paused.indexOf(subscription.id)
      if (at >= 0) risk.paused.splice(at, 1)
      delete risk.pauseTokens[subscription.id]
      continue
    }
    if (Object.keys(risk.openDisputes).length && !subscription.pause_collection) {
      if (!risk.paused.includes(subscription.id)) risk.paused.push(subscription.id)
      risk.pauseTokens[subscription.id] = randomUUID()
    }
  }
  const normalized: Risk = {
    ...risk,
    efwWarnings: Object.keys(risk.efwWarnings).length ? risk.efwWarnings : undefined,
    refundTargets: Object.keys(risk.refundTargets).length ? risk.refundTargets : undefined,
    paused: risk.paused.length ? risk.paused : undefined,
    pauseTokens: risk.paused.length ? risk.pauseTokens : undefined,
  }
  const unchanged = JSON.stringify(normalized) === JSON.stringify(before)
  return {
    risk: unchanged && !account.risk ? undefined : normalized,
    cleared,
    actionable,
    riskCleared: account.riskCleared ? { ...account.riskCleared, disputes: acknowledged } : undefined,
  }
}

/** Financial side effects run only after the snapshot and key reflect the hold. Callers own the billing lease. */
async function applyRiskEffects(
  id: string,
  account: Account,
  listed: readonly Record<string, unknown>[],
  actionable: readonly string[],
  verify: () => Promise<void>,
  fetcher: typeof fetch,
  now: number,
) {
  const owned = listed.filter(
    (subscription) =>
      stripeRecord(subscription.metadata) &&
      subscription.metadata.vector_account_id === id &&
      isPlanId(subscription.metadata.vector_plan),
  )
  const risk = account.risk
  if (!risk) return
  const ending = risk.blocked && (risk.reason === "disputed" || risk.reason === "early_fraud_warning")
  if (ending) {
    // Stop future billing even if the refund provider is unavailable. Targets were persisted before cancellation.
    for (const subscription of owned) {
      await verify()
      await supersedeSubscription(account.customer, String(subscription.id), fetcher, verify)
    }
    for (const charge of new Set(actionable)) {
      await verify()
      await refundFraudWarning(account.customer, charge, risk.refundTargets?.[charge] ?? [], fetcher, verify)
    }
    for (const charge of new Set(actionable)) await blockFraudCard(account.customer, charge, fetcher, verify)
    return
  }
  if (Object.keys(risk.openDisputes).length) {
    for (const subscription of owned) {
      if (!risk.paused?.includes(String(subscription.id)) || subscription.status === "canceled") continue
      const collection = stripeRecord(subscription.pause_collection) ? subscription.pause_collection : undefined
      const metadata = stripeRecord(subscription.metadata) ? subscription.metadata : undefined
      if (collection?.behavior === "void" && !collection.resumes_at && metadata?.vector_risk_pause === id) continue
      if (subscription.pause_collection) continue
      await verify()
      await modelPlanStripe(
        `subscriptions/${encodeURIComponent(String(subscription.id))}`,
        {
          method: "POST",
          idempotency: `vector-risk-pause-${digest(`${id}:${subscription.id}:${risk.pauseTokens?.[String(subscription.id)]}`)}`,
          body: new URLSearchParams({ "pause_collection[behavior]": "void", "metadata[vector_risk_pause]": id }),
        },
        fetcher,
      )
    }
    return
  }
  // Another risk hold, an owner pause, a stopped service or a superseded subscription never gets auto-resumed.
  if (riskState(account) || !modelPlansEnabled() || (await readSwitch("codium", fetcher, { fresh: true })) !== "on")
    return
  const governing = planStanding(id, account, owned, now, { known: knownPeriods(account, undefined) }).governing
  const cleared = new Set<string>()
  for (const paused of risk.paused ?? []) {
    const subscription = owned.find((value) => value.id === paused)
    if (!subscription || subscription.status === "canceled") {
      cleared.add(paused)
      continue
    }
    if (governing?.id !== paused) continue
    if (!subscription.pause_collection) {
      cleared.add(paused)
      continue
    }
    const collection = stripeRecord(subscription.pause_collection) ? subscription.pause_collection : undefined
    if (
      collection?.behavior !== "void" ||
      collection.resumes_at ||
      !stripeRecord(subscription.metadata) ||
      subscription.metadata.vector_risk_pause !== id
    ) {
      cleared.add(paused)
      continue
    }
    await verify()
    await modelPlanStripe(
      `subscriptions/${encodeURIComponent(paused)}`,
      {
        method: "POST",
        idempotency: `vector-risk-resume-${digest(`${id}:${paused}:${risk.pauseTokens?.[paused]}`)}`,
        body: new URLSearchParams({ pause_collection: "", "metadata[vector_risk_pause]": "" }),
      },
      fetcher,
    )
    cleared.add(paused)
  }
  if (cleared.size) {
    const latest = await readModelPlanAccount(id, fetcher)
    if (!latest?.risk) return
    const remaining = (latest.risk.paused ?? []).filter((paused) => !cleared.has(paused))
    await verify()
    await saveAccount(
      id,
      {
        ...latest,
        risk: {
          ...latest.risk,
          paused: remaining.length ? remaining : undefined,
          pauseTokens: remaining.length
            ? Object.fromEntries(
                Object.entries(latest.risk.pauseTokens ?? {}).filter(([sub]) => remaining.includes(sub)),
              )
            : undefined,
        },
      },
      fetcher,
    )
  }
}

const validChargeId = (value: unknown): value is string =>
  typeof value === "string" && /^(ch|py)_[a-zA-Z0-9]+$/.test(value)

function latestCharge(subscription: Record<string, unknown>) {
  const invoice = stripeRecord(subscription.latest_invoice) ? subscription.latest_invoice : undefined
  return invoice && stripeRecord(invoice.charge) ? invoice.charge : undefined
}

/** The same subscription with its latest charge's `disputed` lifted, when every dispute on that charge was won. */
function clearWonDispute(subscription: Record<string, unknown>, cleared: ReadonlySet<string>) {
  const invoice = stripeRecord(subscription.latest_invoice) ? subscription.latest_invoice : undefined
  const charge = latestCharge(subscription)
  if (!invoice || !charge || typeof charge.id !== "string" || !cleared.has(charge.id)) return subscription
  return { ...subscription, latest_invoice: { ...invoice, charge: { ...charge, disputed: false } } }
}

/**
 * The state the account's risk record forces, whatever Stripe says is paid, in this order: deletion; a block from a
 * lost dispute or a refunded fraud warning (ended); an open dispute (frozen); an early-fraud warning (frozen); any
 * other block, the owner's (frozen).
 */
export function riskState(account: {
  closing?: boolean
  ownerEnd?: { done: boolean }
  risk?: Risk
}): { state: PlanState; reason: PlanReason } | undefined {
  if (account.closing) return { state: "ended", reason: "closing" }
  if (account.ownerEnd && !account.ownerEnd.done) return { state: "frozen", reason: "owner" }
  const risk = account.risk
  if (!risk) return undefined
  if (risk.blocked && (risk.reason === "disputed" || risk.reason === "early_fraud_warning"))
    return { state: "ended", reason: risk.reason }
  if (Object.keys(risk.openDisputes).length) return { state: "frozen", reason: "disputed" }
  if (risk.efw.length) return { state: "frozen", reason: "early_fraud_warning" }
  if (risk.blocked) return { state: "frozen", reason: "owner" }
  return undefined
}

/**
 * The refusal for a model request from an account its risk record holds, the same answer `requireEntitlement` gives
 * for that state (contract §4.4, §4.10): an account that ended (a lost dispute, a refunded fraud warning) is 402
 * `MODEL_PLAN_REQUIRED {reason}`; a freeze (an open dispute, a fraud warning, the owner's block) is 403
 * `MODEL_PLAN_BLOCKED {reason}`, which a new card does not fix.
 */
function riskRefusal(held: { state: PlanState; reason: PlanReason }) {
  if (held.state === "ended" && held.reason === "closing")
    return new ApiError(409, "MODEL_PLAN_ACCOUNT_CLOSING", "This account is being deleted. Model access is closed.")
  if (held.state === "ended")
    return new ApiError(402, "MODEL_PLAN_REQUIRED", "Your Vector Codium plan has ended. Choose a plan to use this.", {
      detail: { reason: held.reason },
    })
  return blockedRefusal(held)
}

/** 403 `MODEL_PLAN_BLOCKED {reason}`: the account is held, and buying or using Codium waits for Vector support. */
function blockedRefusal(held: { reason: PlanReason }) {
  return new ApiError(
    403,
    "MODEL_PLAN_BLOCKED",
    held.reason === "disputed"
      ? "Vector Codium is on hold for this account while a payment dispute is open."
      : "Vector Codium is on hold for this account. Contact Vector support.",
    { detail: { reason: held.reason } },
  )
}

// ── The governing subscription and its state ───────────────────────────────────────────────────────────────────

/** One subscription of the account, mapped to a state. Periods are in seconds. */
export type Standing = {
  id: string
  plan: PlanId
  state: PlanState
  reason?: PlanReason
  /** The period the state is about: the paid one, or, while a renewal is due or failing, the one that just ended. */
  start: number
  end: number
  cancelAtPeriodEnd: boolean
  supersedes?: string
  created: number
  paid?: NonNullable<ReturnType<typeof paidModelPlan>>
}

type StandingContext = {
  graceMs?: number
  /** Periods the account is known to have had, to find the start of the one a renewal follows. */
  known?: readonly { subscription: string; start: number; end: number }[]
}

/** The Codium plan a subscription is for: its price as configured, or the plan checkout recorded in its metadata. */
function subscriptionPlanId(price: Record<string, unknown> | undefined, metadata: Record<string, unknown> | undefined) {
  const configured = modelPlans().find((plan) => plan.priceID && plan.priceID === price?.id)
  if (configured && isPlanId(configured.id)) return configured.id
  return isPlanId(metadata?.vector_plan) ? metadata.vector_plan : undefined
}

function invoiceCovers(invoice: Record<string, unknown>, priceID: unknown, start: number, end: number) {
  const lines = stripeRecord(invoice.lines) && Array.isArray(invoice.lines.data) ? invoice.lines.data : []
  return lines.some(
    (line) =>
      stripeRecord(line) &&
      stripeRecord(line.period) &&
      line.period.start === start &&
      line.period.end === end &&
      (!stripeRecord(line.price) || line.price.id === priceID),
  )
}

function fullyRefunded(charge: Record<string, unknown> | undefined) {
  return (
    !!charge &&
    (charge.refunded === true ||
      (typeof charge.amount === "number" &&
        charge.amount > 0 &&
        typeof charge.amount_refunded === "number" &&
        charge.amount_refunded >= charge.amount))
  )
}

function needsAction(invoice: Record<string, unknown> | undefined) {
  const intent = invoice && stripeRecord(invoice.payment_intent) ? invoice.payment_intent : undefined
  return intent?.status === "requires_action"
}

/**
 * The period a renewal follows, in seconds: a renewal invoice's own `period_start`/`period_end` name it, then a period
 * the account is known to have had, and failing both the same length again before the current period.
 */
function previousPeriod(
  subscription: string,
  start: number,
  end: number,
  invoice: Record<string, unknown> | undefined,
  known: StandingContext["known"],
) {
  const invoiceStart = Number(invoice?.period_start)
  if (Number.isSafeInteger(invoiceStart) && invoice?.period_end === start && invoiceStart < start)
    return { start: invoiceStart, end: start }
  const period = known?.find((value) => value.subscription === subscription && value.end === start)
  if (period && period.start < start) return { start: period.start, end: start }
  return { start: start - (end - start), end: start }
}

/**
 * One subscription's state (contract §4.4 "Stripe → state"), before the account's risk record is applied:
 * - none: `incomplete`, `incomplete_expired`, and anything Codium does not sell (trials, mismatched prices);
 * - active: the current period's invoice is paid and unreversed (a partial refund is goodwill and changes nothing);
 * - renewing: the period ended and its renewal invoice is a draft, or open without an attempt, until `periodEnd` +
 *   grace, after which it is paused / payment_pending;
 * - paused: `past_due` (payment_failed, or action_required when the bank asks the customer to confirm), Stripe's own
 *   `paused`, and a renewal invoice that was voided;
 * - ended: `unpaid` (payment_failed), `canceled`, and a full refund of the current period's charge (refunded).
 * Undefined for a subscription that is not this account's Codium plan.
 */
export function subscriptionStanding(
  subscription: unknown,
  accountID: string,
  now = Date.now(),
  context: StandingContext = {},
): Standing | undefined {
  if (!stripeRecord(subscription) || typeof subscription.id !== "string") return undefined
  const metadata = stripeRecord(subscription.metadata) ? subscription.metadata : undefined
  if (metadata?.vector_account_id !== accountID) return undefined
  const items =
    stripeRecord(subscription.items) && Array.isArray(subscription.items.data) ? subscription.items.data : []
  const item = items.length === 1 && stripeRecord(items[0]) ? items[0] : undefined
  const price = item && stripeRecord(item.price) ? item.price : undefined
  const plan = subscriptionPlanId(price, metadata)
  const start = Number(item?.current_period_start ?? subscription.current_period_start)
  const end = Number(item?.current_period_end ?? subscription.current_period_end)
  if (!plan || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) return undefined
  const base = {
    id: subscription.id,
    plan,
    start,
    end,
    cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
    ...(typeof metadata?.vector_supersedes === "string" && metadata.vector_supersedes
      ? { supersedes: metadata.vector_supersedes }
      : {}),
    created: Number.isSafeInteger(subscription.created) ? Number(subscription.created) : 0,
  }
  const status = String(subscription.status)
  if (status === "canceled") return { ...base, state: "ended", reason: "canceled" }
  if (status === "unpaid") return { ...base, state: "ended", reason: "payment_failed" }
  if (status !== "active" && status !== "past_due" && status !== "paused") return { ...base, state: "none" }
  const invoice = stripeRecord(subscription.latest_invoice) ? subscription.latest_invoice : undefined
  const before = previousPeriod(subscription.id, start, end, invoice, context.known)
  const failed = (): Standing => ({
    ...base,
    ...before,
    state: "paused",
    reason: needsAction(invoice) ? "action_required" : "payment_failed",
  })
  if (status === "past_due") return failed()
  if (status === "paused") return { ...base, ...before, state: "paused", reason: "payment_pending" }
  const paid = paidModelPlan(subscription, accountID, now)
  if (paid) return { ...base, start: paid.start, end: paid.end, state: "active", paid }
  const grace = context.graceMs ?? renewalGraceMinutes() * 60_000
  const renewal = (period: { start: number; end: number }): Standing =>
    now > period.end * 1000 + grace
      ? { ...base, ...period, state: "paused", reason: "payment_pending" }
      : { ...base, ...period, state: "renewing" }
  const covers = invoice !== undefined && invoiceCovers(invoice, price?.id, start, end)
  if (!covers) return { ...base, state: "none" }
  const charge = stripeRecord(invoice.charge) ? invoice.charge : undefined
  if (invoice.status === "paid" && fullyRefunded(charge)) return { ...base, state: "ended", reason: "refunded" }
  // Stripe has not moved the subscription on to its next period yet: the paid period is over and its renewal is due.
  if (invoice.status === "paid" && now >= end * 1000) return renewal({ start, end })
  if ((invoice.status === "draft" || invoice.status === "open") && now >= start * 1000)
    return Number(invoice.attempt_count ?? 0) > 0 ? failed() : renewal(before)
  if (invoice.status === "void") return { ...base, ...before, state: "paused", reason: "payment_pending" }
  return { ...base, state: "none" }
}

const STATE_ORDER: Record<PlanState, number> = { active: 5, renewing: 4, paused: 3, frozen: 3, ended: 2, none: 1 }
const LIVE_STATES: ReadonlySet<PlanState> = new Set(["active", "renewing", "paused"])

/**
 * The subscription that governs the account: the best-standing one (paid first), the highest rank among those, then
 * the most recent. A subscription another one names in `vector_supersedes` stops counting once that one has been paid
 * (an upgrade, WP A09). Any other subscription still live is a duplicate, for the owner.
 */
export function governingStanding(standings: readonly Standing[]) {
  const superseded = new Set(
    standings.flatMap((value) => (value.supersedes && value.state !== "none" ? [value.supersedes] : [])),
  )
  const candidates = standings
    .filter((value) => !superseded.has(value.id))
    .sort(
      (a, b) =>
        STATE_ORDER[b.state] - STATE_ORDER[a.state] ||
        rank(b.plan) - rank(a.plan) ||
        b.start - a.start ||
        b.created - a.created,
    )
  const governing = candidates[0]
  return {
    governing,
    duplicates: candidates.slice(1).flatMap((value) => (LIVE_STATES.has(value.state) ? [value.id] : [])),
  }
}

/** The account's state: its risk record first, then its governing subscription's. */
export function planStanding(
  accountID: string,
  account: Pick<Account, "closing" | "risk" | "ownerEnd" | "ownerRefunded">,
  subscriptions: readonly unknown[],
  now = Date.now(),
  context: StandingContext = {},
) {
  const standings = subscriptions
    .map((subscription) => subscriptionStanding(subscription, accountID, now, context))
    .filter((value) => value !== undefined)
  const { governing, duplicates } = governingStanding(standings)
  const held = riskState(account)
  const refunded =
    governing?.state === "ended" &&
    ((account.ownerRefunded?.subscription === governing.id &&
      account.ownerRefunded.periodStart === governing.start * 1000) ||
      (account.ownerEnd?.done &&
        account.ownerEnd.charge !== null &&
        governing.id === account.ownerEnd.subscription &&
        governing.start * 1000 === account.ownerEnd.periodStart))
  const state =
    held ??
    (governing
      ? { state: governing.state, reason: refunded ? ("refunded" as const) : governing.reason }
      : { state: "none" as const })
  return { state: state.state, reason: state.reason, governing, duplicates }
}

/**
 * The account's payment history after this reconcile, from the governing subscription's paid period: the first paid
 * invoice, the first paid invoice of a rank 3 or higher price (a Plus→Ultra upgrade starts it, Max→Ultra does not),
 * the start of an unbroken Max or Ultra run, and the end of the last paid period. A gap of more than 14 days without a
 * paid period restarts the high-value history. A Plus or Pro period, or an ending, breaks the run.
 */
function recordPaidHistory(account: Account, standing: ReturnType<typeof planStanding>): Account {
  const paid = standing.state === "active" ? standing.governing?.paid : undefined
  if (!paid) {
    if (standing.state !== "ended" && standing.state !== "none") return account
    const { memberSince: _ended, ...rest } = account
    return rest
  }
  const paidAt = paid.paidAt ?? paid.start * 1000
  const startedAt = paid.start * 1000
  const gap = account.paidThrough !== undefined && startedAt - account.paidThrough > TRUST_RAMP.restartGapDays * DAY_MS
  const high = rank(paid.plan.id) >= 3
  const { firstHighPaidAt: _high, memberSince: _since, ...rest } = account
  const firstHighPaidAt = high
    ? gap
      ? paidAt
      : (account.firstHighPaidAt ?? paidAt)
    : gap
      ? undefined
      : account.firstHighPaidAt
  const memberSince = high ? (gap ? startedAt : (account.memberSince ?? startedAt)) : undefined
  return {
    ...rest,
    firstPaidAt: account.firstPaidAt ?? paidAt,
    ...(firstHighPaidAt === undefined ? {} : { firstHighPaidAt }),
    ...(memberSince === undefined ? {} : { memberSince }),
    paidThrough: Math.max(account.paidThrough ?? 0, paid.end * 1000),
  }
}

/** Remember the first high-value payment, so changing tier cannot bypass its risk window. */
function recordPoolRamp(before: Account, account: Account, standing: ReturnType<typeof planStanding>): Account {
  const paid = standing.state === "active" ? standing.governing?.paid : undefined
  if (!paid || rank(paid.plan.id) < 3 || account.firstHighPaidAt === undefined) return account
  const fresh = before.firstHighPaidAt !== account.firstHighPaidAt
  const secure = paid.authenticated
  const ramp = fresh
    ? secure
      ? undefined
      : {
          startedAt: account.firstHighPaidAt,
          until: account.firstHighPaidAt + POOL_RAMP.hours * 3_600_000,
          charge: paid.charge ?? "",
        }
    : account.poolRamp
  return {
    ...account,
    highValueVerified: fresh ? secure : account.highValueVerified || secure,
    poolRamp: ramp
      ? {
          ...ramp,
          ...(paid.plan.id === "vector-200" && paid.start * 1000 < ramp.until
            ? { ultraPeriod: `${paid.id}:${paid.start}` }
            : {}),
        }
      : undefined,
  }
}

/** Direct admission can race the payment webhook; it establishes the same persisted cohort before granting a key. */
async function preparePaidHistory(
  id: string,
  account: Account,
  paid: NonNullable<ReturnType<typeof paidModelPlan>>,
  verify: () => Promise<void>,
  fetcher: typeof fetch,
  now: number,
) {
  const standing = {
    state: "active" as const,
    reason: undefined,
    duplicates: [] as string[],
    governing: {
      id: paid.id,
      plan: paid.plan.id as PlanId,
      state: "active" as const,
      start: paid.start,
      end: paid.end,
      cancelAtPeriodEnd: paid.cancelAtPeriodEnd,
      created: 0,
      paid,
    },
  }
  const updated = recordPoolRamp(account, recordPaidHistory(account, standing), standing)
  if (accountChanged(account, updated)) {
    await verify()
    await saveAccount(id, updated, fetcher)
  }
  if (updated.poolRamp && now < updated.poolRamp.until)
    await enqueueAction(
      "pool-ramp",
      `${id}:${updated.poolRamp.startedAt}`,
      { account: id, until: updated.poolRamp.until },
      updated.poolRamp.until,
      fetcher,
      now,
    )
  return updated
}

function monthlyCreditsMicro(account: Account, paid: NonNullable<ReturnType<typeof paidModelPlan>>, now: number) {
  const factor =
    rank(paid.plan.id) >= 3 && account.poolRamp && now < account.poolRamp.until ? POOL_RAMP.creditsShare : 1
  return usdToMicro(codiumKeyLimitUsd(paid.plan.credits * factor))
}

/**
 * The paid month a subscription grants now, or undefined: an active subscription of this account on one configured
 * plan at its exact monthly price, whose latest invoice is paid in full for the current period by a charge that is
 * paid, not fully refunded and not disputed (a won dispute is lifted before this is asked). A partial refund leaves the
 * month paid. Collection paused on the subscription does not change a month already paid.
 */
export function paidModelPlan(subscription: unknown, accountID: string, now = Date.now()) {
  if (!stripeRecord(subscription) || typeof subscription.id !== "string" || subscription.status !== "active")
    return undefined
  const metadata = stripeRecord(subscription.metadata) ? subscription.metadata : undefined
  const items = stripeRecord(subscription.items) ? subscription.items.data : undefined
  if (
    metadata?.vector_account_id !== accountID ||
    !Array.isArray(items) ||
    items.length !== 1 ||
    !stripeRecord(items[0])
  )
    return undefined
  const item = items[0]
  const price = stripeRecord(item.price) ? item.price : undefined
  const recurring = price && stripeRecord(price.recurring) ? price.recurring : undefined
  const configured = modelPlans().find((plan) => plan.priceID && plan.priceID === price?.id)
  const credits = subscriptionPlanCredits(metadata, configured)
  const plan =
    configured && credits !== undefined && Number.isFinite(credits) && credits > 0 && credits <= configured.price
      ? { ...configured, credits }
      : undefined
  if (
    !plan?.credits ||
    item.quantity !== 1 ||
    price?.currency !== "usd" ||
    price.unit_amount !== plan.price * 100 ||
    recurring?.interval !== "month" ||
    recurring.interval_count !== 1
  )
    return undefined
  const start = Number(item.current_period_start ?? subscription.current_period_start)
  const end = Number(item.current_period_end ?? subscription.current_period_end)
  const invoice = stripeRecord(subscription.latest_invoice) ? subscription.latest_invoice : undefined
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start * 1000 > now ||
    end * 1000 <= now ||
    end <= start ||
    invoice?.paid !== true ||
    invoice.status !== "paid"
  )
    return undefined
  const charge = stripeRecord(invoice.charge) ? invoice.charge : undefined
  if (
    typeof invoice.amount_paid !== "number" ||
    invoice.amount_paid < plan.price * 100 ||
    !charge ||
    charge.paid !== true ||
    charge.refunded !== false ||
    charge.disputed !== false ||
    !(
      charge.amount_refunded === 0 ||
      (typeof charge.amount_refunded === "number" &&
        typeof charge.amount === "number" &&
        charge.amount_refunded > 0 &&
        charge.amount_refunded < charge.amount)
    )
  )
    return undefined
  // An old paid invoice must not grant a newly changed billing period or an unpaid upgrade.
  const lines = stripeRecord(invoice.lines) ? invoice.lines.data : undefined
  if (
    !Array.isArray(lines) ||
    !lines.some(
      (line) =>
        stripeRecord(line) &&
        stripeRecord(line.price) &&
        line.price.id === price.id &&
        stripeRecord(line.period) &&
        line.period.start === start &&
        line.period.end === end &&
        line.proration !== true,
    )
  )
    return undefined
  const transitions = stripeRecord(invoice.status_transitions) ? invoice.status_transitions : undefined
  const paidAt = Number(transitions?.paid_at)
  return {
    id: subscription.id,
    plan,
    start,
    end,
    cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
    ...(Number.isSafeInteger(paidAt) && paidAt > 0 ? { paidAt: paidAt * 1000 } : {}),
    ...(typeof charge.id === "string" ? { charge: charge.id } : {}),
    authenticated: authenticatedCharge(charge),
    ...(typeof metadata.vector_supersedes === "string" && metadata.vector_supersedes
      ? { supersedes: metadata.vector_supersedes }
      : {}),
  }
}

/**
 * The paid month that pays for the account's requests: of the subscriptions paid now, the one with the highest rank
 * (the latest on a tie), leaving out any an upgrade supersedes. The same choice reconcile makes, so the key it
 * provisions is the key requests use.
 */
function governingPaid(subscriptions: readonly unknown[], accountID: string, now: number) {
  const paid = subscriptions
    .map((subscription) => paidModelPlan(subscription, accountID, now))
    .filter((value) => value !== undefined)
  const superseded = new Set(paid.flatMap((value) => (value.supersedes ? [value.supersedes] : [])))
  return paid
    .filter((value) => !superseded.has(value.id))
    .sort((a, b) => rank(b.plan.id) - rank(a.plan.id) || b.start - a.start)[0]
}

/**
 * The account's key when it is the one for the period a renewal follows: the governing subscription's last paid one,
 * unless reconcile switched it off for good when the account ended (`revoked`).
 */
function renewingKey(account: Account, governing: Standing | undefined) {
  const key = account.key
  return key && !key.revoked && governing && key.subscription === governing.id && key.start === governing.start
    ? key
    : undefined
}

/**
 * While the account is renewing (contract §4.4: the governing subscription's period ended and its renewal is not paid
 * yet, within the grace), the previous period's key and that period. Undefined in any other state, or when the account's
 * key is for another period. Requests and the account's screens keep using that key until the renewal is paid (M11).
 */
function renewingPeriod(id: string, account: Account, listed: readonly unknown[], now: number) {
  const standing = planStanding(id, account, listed, now, { known: knownPeriods(account, undefined) })
  if (standing.state !== "renewing" || !standing.governing) return undefined
  const key = renewingKey(account, standing.governing)
  return key ? { key, governing: standing.governing } : undefined
}

/** The customer's subscriptions as Stripe has them, latest invoice, charge and payment intent expanded. */
export async function listSubscriptions(customer: string, fetcher: typeof fetch) {
  const query = new URLSearchParams([
    ["customer", customer],
    ["status", "all"],
    ["limit", "100"],
    ["expand[]", "data.latest_invoice.charge"],
    ["expand[]", "data.latest_invoice.payment_intent"],
  ])
  const result = await modelPlanStripe(`subscriptions?${query}`, {}, fetcher)
  if (!Array.isArray(result.data) || result.has_more === true)
    throw new ApiError(503, "MODEL_PLAN_SUBSCRIPTIONS", "Your subscription could not be verified.")
  return result.data.filter(stripeRecord)
}

/** The customer's subscriptions, each latest charge whose disputes were all won lifted so it can pay for its month. */
async function subscriptions(customer: string, fetcher: typeof fetch) {
  return Promise.all(
    (await listSubscriptions(customer, fetcher)).map(async (subscription) => {
      const invoice = stripeRecord(subscription.latest_invoice) ? subscription.latest_invoice : undefined
      const charge = invoice && stripeRecord(invoice.charge) ? invoice.charge : undefined
      if (
        !charge ||
        charge.disputed !== true ||
        typeof charge.id !== "string" ||
        !(await chargeAvailable(charge, charge.id, fetcher))
      )
        return subscription
      return { ...subscription, latest_invoice: { ...invoice, charge: { ...charge, disputed: false } } }
    }),
  )
}

// Plan states whose plan the account's screens show: a paused or frozen plan is still the account's (§4.11).
const SHOWN_STATES: ReadonlySet<PlanState> = new Set(["active", "renewing", "paused", "frozen"])

/** What `modelPlanStatus` reads. The pool's figures are there only once the period's key exists. */
export type ModelPlanStatusRead =
  | { active: false; customer?: true; access: false }
  | {
      active: true
      customer: true
      access: boolean
      snapshot: EntitlementSnapshot
      plan: PlanId
      periodStart: number
      periodEnd: number
      cancelAtPeriodEnd: boolean
      credits?: number
      used?: number
      remaining?: number
      available?: number
      idleAvailable?: number
      shareUsed?: number
      day?: { usedMicro: number; limitMicro: number }
    }

/**
 * The account's Codium month for its own screens, from the entitlement snapshot (M4: a fresh snapshot costs no Stripe
 * call; a missing or stale one is reconciled by `readEntitlement`'s rules, at most once a minute) and, for the
 * snapshot's own period key, one OpenRouter key read and the pool's ledger. `given` is a snapshot the caller already
 * read. An account without a Codium record is never reconciled here. Dollars in the answer never leave the server:
 * `credits` is the pool's total (credits + carry), `used` what was spent (model spend, never below the committed
 * floor, plus debits), `remaining` what is left of the month, `available` what a new request could still hold (M3, as
 * HOLD and ADMIT compute it), `idleAvailable` the same once the model requests still running have ended (abandoned
 * reservations and nonmodel holds still count; status's `empty`), `shareUsed` the whole-percent share spent, and `day`
 * today's spend against the daily share as ADMIT counts it, likewise without the model requests still running. A
 * paused or frozen plan has no figures: nothing can spend from it.
 */
export async function modelPlanStatus(
  id: string,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
  given?: EntitlementSnapshot,
): Promise<ModelPlanStatusRead> {
  const account = await readModelPlanAccount(id, fetcher)
  if (!account) return { active: false, access: false }
  if (account.closing) return { active: false, customer: true, access: false }
  const snapshot = given ?? (await readEntitlement(id, fetcher, now))
  // Only while another request is still writing this account's first snapshot: read again shortly.
  if (!snapshot) throw modelSpendStale()
  if (!snapshot.plan || !SHOWN_STATES.has(snapshot.state)) return { active: false, customer: true, access: false }
  const shown = {
    active: true as const,
    customer: true as const,
    snapshot,
    plan: snapshot.plan,
    periodStart: snapshot.periodStart,
    periodEnd: snapshot.periodEnd,
    cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
  }
  if (snapshot.state === "paused" || snapshot.state === "frozen") return { ...shown, access: false }
  // An open dispute, a fraud warning or a block holds the account before reconcile has written it; a renewing plan
  // serves its previous period until the grace ends (M11), as the gateway's fence does.
  const access =
    !riskState(account) &&
    now >= snapshot.periodStart &&
    now < snapshot.periodEnd + (snapshot.state === "renewing" ? renewalGraceMinutes() * 60_000 : 0)
  const key = account.key
  const current =
    key && !key.revoked && key.subscription === snapshot.subscription && key.start * 1000 === snapshot.periodStart
      ? key
      : undefined
  // Until reconcile has made the period's key, nothing about its pool can be verified.
  if (!current) return { ...shown, access }
  const data = (await openRouterManagement(`/${encodeURIComponent(current.hash)}`, undefined, fetcher)).data
  const usage =
    stripeRecord(data) && typeof data.usage === "number" && Number.isFinite(data.usage) && data.usage >= 0
      ? usdToMicro(data.usage)
      : undefined
  const spend = await readModelSpendLedger(id, current.hash, now, fetcher)
  const figures = poolFigures(keyPool(current), usage ?? 0, poolLedger(spend))
  const known = <T>(value: T) => (usage === undefined ? undefined : value)
  const dailyShare = snapshot.caps.dailyShare
  return {
    ...shown,
    access,
    credits: microToUsd(figures.totalMicro),
    used: known(microToUsd(figures.spentMicro)),
    remaining: known(microToUsd(Math.max(0, figures.remainingMicro))),
    available: known(microToUsd(Math.max(0, figures.availableMicro))),
    // Live model reservations settle by their deadline (minutes); abandoned ones count for the rest of the period.
    idleAvailable: known(microToUsd(Math.max(0, figures.availableMicro + spend.reservedMicro - spend.abandonedMicro))),
    shareUsed: known(poolShareUsed(figures)),
    ...(dailyShare === null
      ? {}
      : {
          day: {
            usedMicro: await readModelSpendDay(id, current.hash, now, fetcher),
            limitMicro: Math.floor(figures.totalMicro * dailyShare),
          },
        }),
  }
}

/**
 * The pool of the snapshot's own period key, for estimates: its total (credits + carry, integer micro-dollars) and
 * whether its credits are still the pool ramp's share (A10), which ends inside the period and raises the total.
 * Undefined while that key is not yet the account's (reconcile has not made it, or a replacement is under way). That
 * key from before the A17 ledger has no trusted credits: final, as at chat, not a retry.
 */
export async function snapshotPool(id: string, snapshot: EntitlementSnapshot, fetcher: typeof fetch = fetch) {
  const key = (await readModelPlanAccount(id, fetcher))?.key
  if (!key || key.revoked || key.subscription !== snapshot.subscription || key.start * 1000 !== snapshot.periodStart)
    return undefined
  if (key.creditsMicro === undefined) throw modelSpendUnavailable()
  return {
    totalMicro: key.creditsMicro + (key.carry?.micro ?? 0),
    ramped: key.fullCreditsMicro !== undefined && key.creditsMicro < key.fullCreditsMicro,
  }
}

/**
 * The key of the account's paid period, provisioned or repaired under the lease when it needs it, for checks and the
 * account's own maintenance. It holds nothing: model requests are admitted and held by ADMIT (model-plan-admit.ts) and
 * every other pool charge by `holdPool`, both against the durable committed floor. With `requiredCredits`, the pool
 * must have that much available now, by the same figure HOLD and ADMIT use (M3); otherwise the one shortfall answer.
 */
export async function modelPlanCredential(
  id: string,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
  requiredCredits = 0,
) {
  if ((await readSwitch("codium", fetcher, { now })) !== "on")
    throw new ApiError(503, "MODEL_PLANS_DISABLED", "Vector Codium is temporarily unavailable.")
  // A request's largest cost, in whole micro-dollars and never rounded down.
  const required = requiredCredits > 0 ? usdToMicroCeil(requiredCredits) : 0
  const funding = await monthlyCredential(id, fetcher, now, required)
  if (required > 0) {
    const ledger = await readPoolLedger(id, funding.pool, now, fetcher)
    const figures = poolFigures(
      { creditsMicro: funding.totalMicro, carryMicro: 0 },
      funding.totalMicro - funding.baseMicro,
      ledger,
    )
    if (figures.availableMicro <= 0 || figures.availableMicro < required) throw monthlyShortfall()
  }
  return { key: funding.key }
}

/**
 * The credential for one model admission or pool hold, from the entitlement snapshot alone (M4: no Stripe call on a
 * hot path). The snapshot names the paid period; the account's ready key for exactly that period is read once from
 * OpenRouter. Undefined when that key is missing, still being provisioned or replaced, or needs a repair: only
 * reconcile (or the account's lease) provisions and repairs. The private record is read before the provider, and is
 * what HOLD and ADMIT fence on, so any billing write after this observation makes the hold or admission stale.
 */
export async function snapshotPoolCredential(
  id: string,
  snapshot: EntitlementSnapshot,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<(PoolFunding & { key: string }) | undefined> {
  const raw = await persistentStore(["GET", accountKey(id)], fetcher)
  if (raw === null) return undefined
  const account = decodeModelPlanAccount(raw)
  if (account.closing)
    throw new ApiError(409, "MODEL_PLAN_ACCOUNT_CLOSING", "This account is being deleted. Model access is closed.")
  const held = riskState(account)
  if (held) throw riskRefusal(held)
  const key = account.key
  const end = snapshot.periodEnd / 1000
  // The same predicate the shared Lua fence applies (codium-spend-ledger.ts), so a refusal here and there agree.
  if (
    snapshot.account !== id ||
    (snapshot.state !== "active" && snapshot.state !== "renewing") ||
    (snapshot.state === "active" && now >= snapshot.periodEnd) ||
    (snapshot.state === "renewing" && now >= snapshot.periodEnd + renewalGraceMinutes() * 60_000) ||
    !key ||
    account.transition !== undefined ||
    account.upgrade !== undefined ||
    account.keyCreation !== undefined ||
    (account.ownerEnd !== undefined && !account.ownerEnd.done) ||
    key.provisioning ||
    key.revoked !== undefined ||
    key.subscription !== snapshot.subscription ||
    key.start * 1000 !== snapshot.periodStart ||
    key.end !== end
  )
    return undefined
  // A key from before the A17 ledger has no trusted genesis, and a zero is never assumed for it: final, not a retry.
  if (key.spendGenesis?.state !== "ready" || key.creditsMicro === undefined) throw modelSpendUnavailable()
  const ready = await readyKey(id, key, end, fetcher)
  return ready && { ...ready, accountRecord: String(raw) }
}

/**
 * The key of the account's paid period and what its pool holds: `baseMicro` is credits + carry − usage. Normal parallel
 * calls only read the account and the key; provisioning, repairs and debits are serialized on the account's lease.
 * Whether the pool can pay is decided only by HOLD/ADMIT's one figure (M3); `requiredMicro` only stops a key being
 * created for a request no month of this plan could ever pay for.
 */
async function monthlyCredential(id: string, fetcher: typeof fetch, now: number, requiredMicro: number) {
  // Normal parallel agent turns only read the existing entitlement/key. Serialize
  // provisioning and repairs, not every model request for the same account.
  const existing = await readModelPlanAccount(id, fetcher)
  if (existing?.closing)
    throw new ApiError(409, "MODEL_PLAN_ACCOUNT_CLOSING", "This account is being deleted. Model access is closed.")
  // A dispute on any charge, a fraud warning or a block holds the account before Stripe is asked anything, and
  // provisioning below never switches its key back on (M5).
  const held = existing && riskState(existing)
  if (held) throw riskRefusal(held)
  // A key replacement or plan change in progress resumes under the lease, never on the fast path.
  if (existing && !existing.transition && !existing.upgrade && !existing.keyCreation) {
    const listed = await subscriptions(existing.customer, fetcher)
    const paid = governingPaid(listed, id, now)
    // A renewal still being collected keeps the month that just ended, and its key, serving (M11).
    const renewing = paid ? undefined : renewingPeriod(id, existing, listed, now)
    if (renewing) {
      const ready = await readyKey(id, renewing.key, renewing.governing.end, fetcher)
      if (ready) return ready
    } else {
      if (!paid && !existing.key)
        throw new ApiError(
          402,
          "MODEL_PLAN_PAYMENT_REQUIRED",
          "Your model subscription needs an active paid billing period.",
        )
      if (!paid && existing.key) {
        const result = await openRouterManagement(`/${encodeURIComponent(existing.key.hash)}`, undefined, fetcher)
        if (stripeRecord(result.data) && result.data.disabled === true)
          throw new ApiError(
            402,
            "MODEL_PLAN_PAYMENT_REQUIRED",
            "Your model subscription needs an active paid billing period.",
          )
      }
      if (paid && existing.key?.subscription === paid.id && existing.key.start === paid.start) {
        const ready = await readyKey(id, existing.key, paid.end, fetcher)
        if (ready) return ready
      }
    }
  }
  return withCodiumLease(
    id,
    async (verify) => {
      const account = await readModelPlanAccount(id, fetcher)
      if (!account) throw new ApiError(402, "MODEL_PLAN_REQUIRED", "Choose a Codium plan to use this model.")
      if (account.closing)
        throw new ApiError(409, "MODEL_PLAN_ACCOUNT_CLOSING", "This account is being deleted. Model access is closed.")
      const held = riskState(account)
      if (held) throw riskRefusal(held)
      const listed = await subscriptions(account.customer, fetcher)
      const paid = governingPaid(listed, id, now)
      const renewing = paid ? undefined : renewingPeriod(id, account, listed, now)
      if (renewing) {
        // The previous period's key, brought back to what its pool says and to its grace-extended expiry.
        const end = renewing.governing.end
        const resumed = await abandonReplacement(id, account, verify, fetcher, now)
        const converged = await convergeKey(id, resumed, renewing.key, verify, fetcher, {
          expiresAt: keyExpiresAt(end),
        })
        return {
          key: revealModelPlanKey(renewing.key.encrypted, `${id}:${renewing.key.subscription}:${renewing.key.start}`),
          pool: renewing.key.hash,
          baseMicro: converged.creditsMicro + converged.carryMicro - converged.usageMicro,
          totalMicro: converged.creditsMicro + converged.carryMicro,
          subscription: renewing.key.subscription,
          start: renewing.key.start,
          end,
        }
      }
      if (!paid) {
        if (account.key)
          await openRouterManagement(`/${encodeURIComponent(account.key.hash)}`, { disabled: true }, fetcher, "PATCH")
        throw new ApiError(
          402,
          "MODEL_PLAN_PAYMENT_REQUIRED",
          "Your model subscription needs an active paid billing period.",
        )
      }
      // A request no month of this plan could ever pay for creates no key.
      const current =
        account.key?.subscription === paid.id && account.key.start === paid.start ? account.key : undefined
      const most = current
        ? keyPool(current)
        : { creditsMicro: usdToMicro(codiumKeyLimitUsd(paid.plan.credits)), carryMicro: 0 }
      if (most.creditsMicro + most.carryMicro < requiredMicro) throw monthlyShortfall()
      const funding = await provisionMonthlyKey(id, account, paid, fetcher, verify, now)
      return {
        key: funding.key,
        pool: funding.pool,
        baseMicro: funding.creditsMicro + funding.carryMicro - funding.usageMicro,
        totalMicro: funding.creditsMicro + funding.carryMicro,
        subscription: paid.id,
        start: paid.start,
        end: paid.end,
      }
    },
    fetcher,
  )
}

/**
 * A period's key as it is, when it needs no repair: switched on, at the limit the pool last set (M1, within half a
 * cent), never resetting, counting the buyer's own keys, and expiring at the period's end plus the grace. Undefined when
 * anything there differs, which the lease's path repairs. It decides nothing about what the pool can pay: HOLD and
 * ADMIT do, against the committed floor as well as this usage (M3).
 */
async function readyKey(id: string, key: AccountKey, end: number, fetcher: typeof fetch) {
  if (key.provisioning) return undefined
  const data = (await openRouterManagement(`/${encodeURIComponent(key.hash)}`, undefined, fetcher)).data
  const pool = keyPool(key)
  if (
    !stripeRecord(data) ||
    data.disabled !== false ||
    !limitMatches(data.limit, pool.limitMicro) ||
    data.limit_reset !== null ||
    data.include_byok_in_limit !== true ||
    data.expires_at !== keyExpiresAt(end) ||
    typeof data.usage !== "number" ||
    !Number.isFinite(data.usage) ||
    data.usage < 0
  )
    return undefined
  const usage = usdToMicro(data.usage)
  return {
    key: revealModelPlanKey(key.encrypted, `${id}:${key.subscription}:${key.start}`),
    pool: key.hash,
    baseMicro: pool.creditsMicro + pool.carryMicro - usage,
    totalMicro: pool.creditsMicro + pool.carryMicro,
    subscription: key.subscription,
    start: key.start,
    end,
  }
}

/**
 * The paid period's key, or a new one when the period changed. Callers hold the lease. An existing key is brought to
 * what the pool says (M1): enabled, expiring at the period's end plus the renewal grace, and limited to credits + carry
 * less every debit recorded against it, never back to the plan's credits. Its limit is PATCHed only when it is more
 * than half a cent off, and any debit not yet applied is applied in the same pass.
 */
async function provisionMonthlyKey(
  id: string,
  account: Account,
  paid: NonNullable<ReturnType<typeof paidModelPlan>>,
  fetcher: typeof fetch,
  verify: () => Promise<void>,
  now = Date.now(),
) {
  account = await preparePaidHistory(id, account, paid, verify, fetcher, now)
  const previous = account.key
  const samePeriod = previous?.subscription === paid.id && previous.start === paid.start
  const source = samePeriod
    ? carryPotential(previous?.carry)
    : previous && paid.supersedes === previous.subscription
      ? (previous.fullCreditsMicro ?? keyPool(previous).creditsMicro) + carryPotential(previous.carry)
      : 0
  // A paid key creation may fail longer than its checkout reservation lives. Keep the entire pending obligation funded.
  await writeRampOwed(id, usdToMicro(codiumKeyLimitUsd(paid.plan.credits)) + source, fetcher, "raise")
  const context = `${id}:${paid.id}:${paid.start}`
  // M11: the key outlives its period by the renewal grace; a paid renewal replaces it, anything else switches it off.
  const expires = keyExpiresAt(paid.end)
  if (account.key?.subscription === paid.id && account.key.start === paid.start) {
    account = await abandonReplacement(id, account, verify, fetcher, now)
    account = await initializePendingSpend(id, account, verify, fetcher)
    account = await refreshCarry(id, account, fetcher, verify)
    await finishUpgrade(id, account, paid, fetcher, verify, now)
    const desiredCredits = monthlyCreditsMicro(account, paid, now)
    if (account.key!.creditsMicro !== desiredCredits) {
      account = { ...account, key: { ...account.key!, creditsMicro: desiredCredits, provisioning: true } }
      await verify()
      await saveAccount(id, account, fetcher)
    }
    const key = account.key!
    const converged = await convergeKey(id, account, key, verify, fetcher, { expiresAt: expires })
    const published = await publishKey(id, converged.account, verify, fetcher)
    return {
      key: revealModelPlanKey(key.encrypted, context),
      pool: key.hash,
      usageMicro: converged.usageMicro,
      account: published,
      creditsMicro: converged.creditsMicro,
      carryMicro: converged.carryMicro,
      limitMicro: converged.limitMicro,
    }
  }
  // The barrier goes first, before anything below observes the source key's balances (handoff 8.7 item 1).
  if (account.transition?.subscription !== paid.id || account.transition.start !== paid.start) {
    account = { ...account, transition: { subscription: paid.id, start: paid.start, at: now } }
    await verify()
    await saveAccount(id, account, fetcher)
  }
  account = await refreshCarry(id, account, fetcher, verify)
  const upgrade = await prepareUpgrade(id, account, paid, fetcher, verify, now)
  if (upgrade) account = { ...account, upgrade }
  if (account.key) {
    await verify()
    await openRouterManagement(`/${encodeURIComponent(account.key.hash)}`, { disabled: true }, fetcher, "PATCH")
  }
  await verify()
  // A new period starts at the plan's credits; in test mode the key holds no more than the test cap.
  const creditsMicro = monthlyCreditsMicro(account, paid, now)
  const carried = upgrade
    ? {
        micro: Math.max(0, usdToMicro(codiumKeyLimitUsd(microToUsd(creditsMicro + upgrade.micro))) - creditsMicro),
        fromSubscription: upgrade.fromSubscription,
        fromStart: upgrade.fromStart,
        fromCharge: upgrade.fromCharge,
        fromHash: upgrade.fromHash,
        fromLimitMicro: upgrade.fromLimitMicro,
        fromAppliedMicro: upgrade.fromAppliedMicro,
        origins: allocateCarry(
          Math.max(0, usdToMicro(codiumKeyLimitUsd(microToUsd(creditsMicro + upgrade.micro))) - creditsMicro),
          upgrade.visibleOrigins,
        ),
        sourceOrigins: upgrade.sourceOrigins,
        visibleOrigins: upgrade.visibleOrigins,
        fromVisibleLimitMicro: upgrade.fromVisibleLimitMicro,
        fullMicro: upgrade.fullMicro,
        rampUntil: upgrade.rampUntil,
        trueupAt: upgrade.at + 12 * 60_000,
      }
    : undefined
  const limitMicro = creditsMicro + (carried?.micro ?? 0)
  const fullCreditsMicro = usdToMicro(codiumKeyLimitUsd(paid.plan.credits))
  await writeRampOwed(
    id,
    Math.max(0, fullCreditsMicro - creditsMicro + (carried?.fullMicro ?? carried?.micro ?? 0) - (carried?.micro ?? 0)),
    fetcher,
    "raise",
  )
  const forPaid = (creation: typeof KeyCreation.Type) =>
    creation.subscription === paid.id && creation.start === paid.start && creation.end === paid.end
  // A creation abandoned for this same period may have made its key with the answer lost: its nonce (and request) is
  // reused, so OpenRouter's idempotent create answers that key instead of making a second funded one.
  const creation = (account.keyCreation && forPaid(account.keyCreation) ? account.keyCreation : undefined) ??
    account.abandonedCreations?.find(forPaid) ?? {
      nonce: randomUUID(),
      subscription: paid.id,
      start: paid.start,
      end: paid.end,
      limitMicro,
      expiresAt: expires,
    }
  if (account.keyCreation !== creation) {
    // A creation for another period replaced here is kept aside as an abandoned one is, until its key would expire.
    const abandoned = [
      ...(account.abandonedCreations ?? []),
      ...(account.keyCreation ? [account.keyCreation] : []),
    ].filter((entry) => entry !== creation && Date.parse(entry.expiresAt) > now)
    account = { ...account, keyCreation: creation, abandonedCreations: abandoned.length ? abandoned : undefined }
    await verify()
    await saveAccount(id, account, fetcher)
  }
  const result = await openRouterManagement(
    "",
    {
      name: openRouterKeyName([id, paid.id, paid.start]),
      limit: limitUsd(creation.limitMicro),
      limit_reset: null,
      include_byok_in_limit: true,
      expires_at: creation.expiresAt,
    },
    fetcher,
    "POST",
    `vector-codium-pool-v1-${stripeMode()}-${creation.nonce}`,
  )
  if (
    !stripeRecord(result.data) ||
    typeof result.data.hash !== "string" ||
    typeof result.key !== "string" ||
    !result.key
  )
    throw new ApiError(503, "MODEL_PLAN_KEY_INVALID", "Your model allowance could not be created.")
  const updated = {
    ...account,
    transition: undefined,
    upgrade: undefined,
    keyCreation: undefined,
    key: {
      hash: result.data.hash,
      // The fast credential path must wait for the lease until carry has been revalidated and its limit converged.
      provisioning: true,
      spendGenesis: { nonce: creation.nonce, state: "pending" as const },
      encrypted: protectModelPlanKey(result.key, context),
      subscription: paid.id,
      start: paid.start,
      end: paid.end,
      credits: paid.plan.credits,
      creditsMicro,
      fullCreditsMicro,
      ...(carried ? { carry: carried } : {}),
      limitMicro: creation.limitMicro,
    },
  }
  await saveAccount(id, updated, fetcher)
  const initialized = await initializePendingSpend(id, updated, verify, fetcher)
  const checked = await refreshCarry(id, initialized, fetcher, verify)
  const converged = await convergeKey(id, checked, checked.key!, verify, fetcher)
  await finishUpgrade(id, converged.account, paid, fetcher, verify, now)
  const published = await publishKey(id, converged.account, verify, fetcher)
  return {
    key: result.key,
    pool: result.data.hash,
    usageMicro: converged.usageMicro,
    account: published,
    creditsMicro: converged.creditsMicro,
    carryMicro: converged.carryMicro,
    limitMicro: converged.limitMicro,
  }
}

/**
 * Every replacement intent is cleared by the save that publishes its new key, so one still present while the current
 * key's own period governs (or is renewing) belongs to a replacement whose target stopped governing first: a refunded
 * upgrade, a reversed renewal. It created no key anyone holds and granted no carry. Clearing it lets the current key
 * serve again (M11, M12: a paying user is never locked out); the caller's converge re-enables that key. Its key
 * creation is kept aside until that key would have expired: OpenRouter may have made the key with the answer lost, and
 * the same period's next creation reuses the nonce rather than making a second key.
 */
async function abandonReplacement(
  id: string,
  account: Account,
  verify: () => Promise<void>,
  fetcher: typeof fetch,
  now: number,
) {
  if (!account.transition && !account.upgrade && !account.keyCreation) return account
  const kept = [...(account.abandonedCreations ?? []), ...(account.keyCreation ? [account.keyCreation] : [])].filter(
    (entry) => Date.parse(entry.expiresAt) > now,
  )
  const abandoned = {
    ...account,
    transition: undefined,
    upgrade: undefined,
    keyCreation: undefined,
    abandonedCreations: kept.length ? kept : undefined,
  }
  await verify()
  await saveAccount(id, abandoned, fetcher)
  return abandoned
}

/** Only a nonce from the fresh creation path may establish zero spend; lost/corrupt ready ledgers never reset. */
async function initializePendingSpend(
  id: string,
  account: Account,
  verify: () => Promise<void>,
  fetcher: typeof fetch,
) {
  const key = account.key
  if (!key || key.spendGenesis?.state !== "pending") return account
  await verify()
  await initializeFreshModelPool(
    {
      account: id,
      pool: key.hash,
      subscription: key.subscription,
      start: key.start,
      end: key.end,
      creation: key.spendGenesis.nonce,
    },
    fetcher,
  )
  await verify()
  const initialized = await readModelPlanAccount(id, fetcher)
  if (
    initialized?.key?.hash !== key.hash ||
    initialized.key.spendGenesis?.state !== "ready" ||
    initialized.key.spendGenesis.nonce !== key.spendGenesis.nonce
  )
    throw new ApiError(503, "MODEL_PLAN_POOL_UNAVAILABLE", "Your model allowance could not be verified.")
  return initialized
}

/** Only a fully checked key is visible to concurrent model admissions. */
async function publishKey(id: string, account: Account, verify: () => Promise<void>, fetcher: typeof fetch) {
  const key = account.key
  if (!key) return account
  const deferred = Math.max(
    0,
    (key.fullCreditsMicro ?? keyPool(key).creditsMicro) -
      keyPool(key).creditsMicro +
      carryPotential(key.carry) -
      (key.carry?.micro ?? 0),
  )
  await writeRampOwed(id, deferred, fetcher)
  if (!key.provisioning) return account
  const published = { ...account, key: { ...account.key, provisioning: undefined } }
  await verify()
  await saveAccount(id, published, fetcher)
  return published
}

/**
 * Sets the account's current key to its pool's limit, credits + carry less every debit recorded against it, and marks
 * the debits that limit includes applied, saving the limit in the account record in the same step. Callers hold the
 * lease. `repair` also re-enables the key and resets its other settings; only provisioning for a paid period and the
 * renewing period's key (M11, never while the account is held) pass it, so applying a debit never turns a key back on.
 */
async function convergeKey(
  id: string,
  account: Account,
  key: AccountKey,
  verify: () => Promise<void>,
  fetcher: typeof fetch,
  repair?: { expiresAt: string },
) {
  if (key.carry) {
    account = await refreshCarry(id, account, fetcher, verify)
    key = account.key!
  }
  const debits = await readDebits(id, key.hash, fetcher)
  const pending = debits.filter((debit) => !debit.applied)
  const pool = keyPool(key)
  const limitMicro = expectedLimitMicro(
    pool,
    debits.reduce((sum, debit) => sum + debit.micro, 0),
  )
  const data = (await openRouterManagement(`/${encodeURIComponent(key.hash)}`, undefined, fetcher)).data
  if (
    !stripeRecord(data) ||
    typeof data.disabled !== "boolean" ||
    (repair && (typeof data.usage !== "number" || !Number.isFinite(data.usage) || data.usage < 0))
  )
    throw new ApiError(503, "MODEL_PLAN_KEY_INVALID", "Your model allowance could not be verified.")
  const settings =
    repair &&
    (data.disabled ||
      data.limit_reset !== null ||
      data.include_byok_in_limit !== true ||
      data.expires_at !== repair.expiresAt)
  if (settings || !limitMatches(data.limit, limitMicro)) {
    await verify()
    await openRouterManagement(
      `/${encodeURIComponent(key.hash)}`,
      repair
        ? {
            disabled: false,
            limit: limitUsd(limitMicro),
            limit_reset: null,
            include_byok_in_limit: true,
            expires_at: repair.expiresAt,
          }
        : { limit: limitUsd(limitMicro) },
      fetcher,
      "PATCH",
    )
  }
  const changed = key.limitMicro !== limitMicro || key.creditsMicro !== pool.creditsMicro
  const updated = changed ? { ...account, key: { ...key, creditsMicro: pool.creditsMicro, limitMicro } } : account
  const left =
    pending.length || changed
      ? await verify().then(() =>
          markDebitsApplied(
            {
              account: id,
              keyHash: key.hash,
              accountRecord: changed ? { key: accountKey(id), json: JSON.stringify(updated) } : undefined,
              pending,
            },
            fetcher,
          ),
        )
      : 0
  return {
    account: updated,
    usageMicro: typeof data.usage === "number" && Number.isFinite(data.usage) ? usdToMicro(Math.max(0, data.usage)) : 0,
    creditsMicro: pool.creditsMicro,
    carryMicro: pool.carryMicro,
    limitMicro,
    applied: pending.length,
    pending: left,
  }
}

/** What the daily sweep's key audit found (never an amount). */
export type KeyAudit =
  /** No key, or the account is being deleted. */
  | { outcome: "none" }
  /** The key is switched off, so its limit spends nothing; reconcile decides whether it should serve. */
  | { outcome: "disabled" }
  | { outcome: "ok" }
  /**
   * The key had drifted and was set back: its limit was above or below what the pool allows, or it had no limit at all;
   * or it was switched on while the account's risk record holds it (`enabled`).
   */
  | { outcome: "repaired"; drift: "above" | "below" | "unset" | "enabled" }

/**
 * The daily sweep's audit of the account's current OpenRouter key (contract §5 WP A08), under the account's lease and
 * without asking Stripe anything. A key's limit is expected to be either what Vector last set (`limitMicro`), or what
 * its pool says now (credits + carry less every debit recorded, when a debit is still being applied). A limit that is
 * neither, or missing, was changed outside Vector: it is set back to the pool's limit, as reconcile would (M1). A key
 * switched on while a dispute, a fraud warning or a block holds the account is switched off at once (M5). Whether a
 * key should serve at all is otherwise reconcile's question, so a switched-off key is left alone.
 */
export async function auditModelPlanKey(id: string, fetcher: typeof fetch = fetch): Promise<KeyAudit> {
  return withCodiumLease(
    id,
    async (verify) => {
      const account = await readModelPlanAccount(id, fetcher)
      const key = account?.key
      if (!account || !key || account.closing) return { outcome: "none" }
      const data = (await openRouterManagement(`/${encodeURIComponent(key.hash)}`, undefined, fetcher)).data
      if (!stripeRecord(data) || typeof data.disabled !== "boolean")
        throw new ApiError(503, "MODEL_PLAN_KEY_INVALID", "Your model allowance could not be verified.")
      if (data.disabled) return { outcome: "disabled" }
      if (riskState(account)) {
        await verify()
        await openRouterManagement(`/${encodeURIComponent(key.hash)}`, { disabled: true }, fetcher, "PATCH")
        return { outcome: "repaired", drift: "enabled" }
      }
      const pool = keyPool(key)
      const debits = await readDebits(id, key.hash, fetcher)
      const target = expectedLimitMicro(
        pool,
        debits.reduce((sum, debit) => sum + debit.micro, 0),
      )
      if (limitMatches(data.limit, pool.limitMicro) || limitMatches(data.limit, target)) return { outcome: "ok" }
      await convergeKey(id, account, key, verify, fetcher)
      const limit = typeof data.limit === "number" && Number.isFinite(data.limit) ? usdToMicro(data.limit) : undefined
      return { outcome: "repaired", drift: limit === undefined ? "unset" : limit > target ? "above" : "below" }
    },
    fetcher,
  )
}

/** A hold on an account's pool for a charge made outside OpenRouter: a hosted block, or any other pool charge. */
export type PoolHold = {
  ticket: string
  micro: number
  expiresAt: number
  /**
   * Records what the charge cost, in dollars, as a debit under `ref` (a retry with the same ref records nothing new),
   * then lowers the key's limit by it. The charge stays held until that is done; when the key cannot be updated now,
   * the outbox action `debit-apply` retries it. `applied` says whether the limit already carries it.
   */
  settle(chargedUsd: number, ref: string): Promise<{ recorded: boolean; applied: boolean }>
  /** Gives the hold back unspent, when nothing was charged. */
  release(): Promise<void>
}

/**
 * Holds `usd` of an account's pool for `ttlMs` for a charge made outside OpenRouter (§4.7 `holdPool`): the same held
 * set, the same fence and the same available figure as model admissions (M2, M3), so a hosted block can never spend
 * what a request is holding, nor the other way round. Refused with the same answer as any other shortfall.
 *
 * It reads no Stripe state on its hot path (M4): the period comes from the entitlement snapshot, the caller's
 * (`snapshot`, whose version the fence then also requires) or the stored one read by `readEntitlement`'s rules (a
 * missing or stale one is reconciled on demand, as chat's is), and only reconcile provisions or repairs the key. A
 * snapshot whose plan state cannot use Codium gets `requireEntitlement`'s final answer (402, 403, 409), not a retry. A
 * key that is not ready gets at most one on-demand reconcile (once a minute per account), as chat does; a reconcile
 * that changed the snapshot means the caller reads it again (503 `MODEL_PLAN_RENEWING`). The hold's lifetime starts
 * when it is placed, after every credential read, not before: the clock is read again then. There is deliberately no
 * fixed `now` option, because a timestamp taken before those awaits would date the hold's deadline and the fence's
 * period check in the past; `clock` is a test seam and must return the current time on every call.
 *
 * Producers (WP A51 and later) must hold their worst case and never settle above it: a charge settled above its hold
 * spends from the pool the hold was placed on, and a second upgrade inside the carry true-up delay counts a live hold
 * as spent at its held amount. The day, Brain and run shares are not enforced here (codium-a17-admission-notes.md).
 */
export async function holdPool(
  account: string,
  usd: number,
  ttlMs: number,
  purpose: PoolPurpose,
  options: {
    runId?: string
    fetcher?: typeof fetch
    clock?: () => number
    snapshot?: EntitlementSnapshot
  } = {},
): Promise<PoolHold> {
  if (
    !Number.isFinite(usd) ||
    usd <= 0 ||
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 1_000 ||
    ttlMs > MAX_POOL_HOLD_MS ||
    !isPoolPurpose(purpose) ||
    !validRunId(options.runId)
  )
    throw new ApiError(500, "MODEL_PLAN_POOL_INVALID", "This Codium charge could not be held.")
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  const required = usdToMicroCeil(usd)
  const snapshot = requireUsableSnapshot(
    options.snapshot ?? (await readEntitlement(account, fetcher, clock())),
    clock(),
  )
  const funding =
    (await snapshotPoolCredential(account, snapshot, fetcher, clock())) ??
    (await reconcileOnDemand(account, fetcher, clock()).then((fresh) =>
      fresh && requireUsableSnapshot(fresh, clock()).version === snapshot.version
        ? snapshotPoolCredential(account, fresh, fetcher, clock())
        : undefined,
    ))
  if (!funding) throw modelSpendStale()
  const now = clock()
  const ticket = await placeHold(
    {
      account,
      funding,
      requiredMicro: required,
      purpose,
      run: options.runId,
      ttlMs,
      now,
      ...(options.snapshot ? { version: options.snapshot.version } : {}),
    },
    fetcher,
  )
  if (!ticket) throw monthlyShortfall()
  return {
    ticket: ticket.ticket,
    micro: ticket.micro,
    expiresAt: now + ttlMs,
    release: () => releaseHold(ticket, fetcher),
    settle: (chargedUsd, ref) => settlePoolCharge(ticket, funding.end, chargedUsd, ref, fetcher),
  }
}

async function settlePoolCharge(
  ticket: PoolTicket,
  periodEnd: number,
  chargedUsd: number,
  ref: string,
  fetcher: typeof fetch,
) {
  if (!Number.isFinite(chargedUsd) || chargedUsd < 0 || !validDebitRef(ref))
    throw new ApiError(500, "MODEL_PLAN_POOL_INVALID", "This Codium charge could not be recorded.")
  // A charge is never rounded down: what the pool pays covers at least what the provider charged.
  const micro = usdToMicroCeil(chargedUsd)
  const now = Date.now()
  const recorded = await recordDebit(ticket, { ref, micro, keepUntil: periodEnd * 1000 + DEBITS_KEEP_MS, now }, fetcher)
  // The debit is held until applied, and queued for `debit-apply`, so a key that cannot be updated now loses nothing.
  const applied = await applyPoolDebits(ticket.account, ticket.pool, fetcher).then(
    () => true,
    () => false,
  )
  return { recorded, applied }
}

/**
 * The outbox action `debit-apply` (contract §4.8): under the account's lease, lowers the key's limit by every debit
 * recorded against it and marks them applied. A debit on a key the account no longer uses is marked applied without
 * touching that key: it was switched off when it was replaced, so its limit no longer spends anything. Returns how many
 * debits were applied and how many arrived meanwhile and are still pending.
 */
export async function applyPoolDebits(account: string, keyHash?: string, fetcher: typeof fetch = fetch) {
  return withCodiumLease(
    account,
    async (verify) => {
      const record = await readModelPlanAccount(account, fetcher)
      const hash = keyHash ?? record?.key?.hash
      if (!hash) return { applied: 0, pending: 0 }
      if (record?.key?.hash === hash) {
        const converged = await convergeKey(account, record, record.key, verify, fetcher)
        return { applied: converged.applied, pending: converged.pending }
      }
      const pending = (await readDebits(account, hash, fetcher)).filter((debit) => !debit.applied)
      await verify()
      const left = await markDebitsApplied({ account, keyHash: hash, pending }, fetcher)
      return { applied: pending.length, pending: left }
    },
    fetcher,
  )
}

/**
 * Retries every key whose `debit-apply` is due, one at a time within `budgetMs`. The DEBIT script queues a key here in
 * the same step as its debit, so the minute outbox cron (api/model-plans/outbox.ts) runs this after the outbox itself.
 * A key that still fails is tried again after DEBIT_RETRY_MS; its debits stay held meanwhile.
 */
export async function drainDebitApplies(
  options: { fetcher?: typeof fetch; now?: number; budgetMs?: number; limit?: number } = {},
) {
  const fetcher = options.fetcher ?? fetch
  const started = Date.now()
  const now = options.now ?? started
  const budget = options.budgetMs ?? 20_000
  const due = await dueDebitApplies(now, options.limit ?? 50, fetcher)
  const outcome = { applied: 0, retried: 0 }
  for (const item of due) {
    if (Date.now() - started >= budget) break
    const result = await applyPoolDebits(item.account, item.keyHash, fetcher).catch(() => undefined)
    if (result && result.pending === 0) {
      await finishDebitApply(item.account, item.keyHash, fetcher)
      outcome.applied++
    } else {
      await postponeDebitApply(item.account, item.keyHash, Date.now() + DEBIT_RETRY_MS, fetcher)
      outcome.retried++
    }
  }
  return outcome
}

// ── Outbox actions (contract §4.8) ─────────────────────────────────────────────────────────────────────────────────

/** The hint a queued reconcile carries, when it is one reconcile can use. */
function queuedHint(payload: unknown): ReconcileHint | undefined {
  if (!stripeRecord(payload) || !stripeRecord(payload.hint)) return undefined
  const hint = payload.hint
  if (hint.kind === "dispute" && typeof hint.charge === "string") return { kind: "dispute", charge: hint.charge }
  if (hint.kind === "efw" && typeof hint.id === "string")
    return { kind: "efw", id: hint.id, ...(typeof hint.charge === "string" ? { charge: hint.charge } : {}) }
  return undefined
}

// `reconcile` (key: the account; payload `{hint?}`): a reconcile that could not finish where it started, such as a
// webhook's, run again from Stripe's current state.
registerAction("reconcile", async (action, fetcher) => {
  const hint = queuedHint(action.payload)
  await reconcileModelPlanAccount(action.key, fetcher, action.now, { source: "outbox", ...(hint ? { hint } : {}) })
})

// `debit-apply` (key: `<account>:<keyHash>`, or the account alone for its current key): the pool debits a key still
// has to carry. It fails, and is tried again, while any stay pending.
registerAction("debit-apply", async (action, fetcher) => {
  const split = action.key.indexOf(":")
  const account = split < 0 ? action.key : action.key.slice(0, split)
  const keyHash = split < 0 ? undefined : action.key.slice(split + 1) || undefined
  const result = await applyPoolDebits(account, keyHash, fetcher)
  if (result.pending > 0)
    throw new ApiError(503, "MODEL_PLAN_DEBIT_PENDING", "Some Codium charges are still being applied.")
  if (keyHash) await finishDebitApply(account, keyHash, fetcher)
})

/** Consent is read from Stripe's completed session, never from a browser's success URL. */
async function recordCheckoutConsent(
  id: string,
  account: Account,
  active: boolean,
  fetcher: typeof fetch,
  verify: () => Promise<void>,
  now: number,
) {
  if (!active || !account.checkout) return account
  if (account.consent?.session === account.checkout.id) {
    if (!account.consent.confirmationSent)
      await enqueueAction(
        "purchase-confirmation",
        account.checkout.id,
        { account: id, session: account.checkout.id, customer: account.customer, plan: account.checkout.plan },
        undefined,
        fetcher,
        now,
      )
    return account
  }
  const session = await modelPlanStripe(`checkout/sessions/${encodeURIComponent(account.checkout.id)}`, {}, fetcher)
  if (session.status !== "complete" || session.payment_status !== "paid" || session.customer !== account.customer)
    return account
  if (
    !stripeRecord(session.consent) ||
    session.consent.terms_of_service !== "accepted" ||
    !stripeRecord(session.metadata) ||
    typeof session.metadata.vector_terms_date !== "string"
  )
    throw new ApiError(503, "MODEL_PLAN_CONSENT", "Your purchase confirmation could not be verified.")
  const consent = {
    session: account.checkout.id,
    terms_of_service: "accepted",
    terms_date: session.metadata.vector_terms_date,
  }
  await verify()
  await saveAccount(id, { ...account, consent }, fetcher)
  return recordCheckoutConsent(id, { ...account, consent }, active, fetcher, verify, now)
}

/**
 * Freeze carry before replacing a key. Both the source charge and subscription must belong to this account, and only
 * a paid upgrade can use them. The durable record survives a timeout after key creation.
 */
async function prepareUpgrade(
  id: string,
  account: Account,
  paid: NonNullable<ReturnType<typeof paidModelPlan>>,
  fetcher: typeof fetch,
  verify: () => Promise<void>,
  now: number,
): Promise<Account["upgrade"]> {
  if (account.upgrade?.subscription === paid.id && account.upgrade.start === paid.start) return account.upgrade
  const key = account.key
  if (!paid.supersedes || !key || key.subscription !== paid.supersedes || key.revoked) return undefined
  const query = new URLSearchParams([["expand[]", "latest_invoice.charge"]])
  const source = await modelPlanStripe(`subscriptions/${encodeURIComponent(paid.supersedes)}?${query}`, {}, fetcher)
  const before = paidModelPlan(source, id, now)
  if (
    source.customer !== account.customer ||
    !before?.charge ||
    before.start !== key.start ||
    rank(before.plan.id) >= rank(paid.plan.id)
  )
    return undefined
  await verify()
  await disableKey(key, verify, fetcher)
  const data = (await openRouterManagement(`/${encodeURIComponent(key.hash)}`, undefined, fetcher)).data
  if (!stripeRecord(data) || typeof data.usage !== "number" || !Number.isFinite(data.usage) || data.usage < 0)
    throw new ApiError(503, "MODEL_PLAN_KEY_INVALID", "Your remaining allowance could not be verified.")
  const ledger = await readPoolLedger(id, key.hash, now, fetcher)
  const fromVisibleLimitMicro = expectedLimitMicro(keyPool(key), ledger.appliedMicro)
  // Keep every paid origin across repeated upgrades: a later reversal cannot be laundered through another plan.
  const sourceOrigins = [
    { charge: before.charge, micro: key.fullCreditsMicro ?? keyPool(key).creditsMicro },
    ...(await settledCarryOrigins(id, key, now, fetcher)),
  ]
  const fromLimitMicro = Math.max(0, sourceOrigins.reduce((sum, origin) => sum + origin.micro, 0) - ledger.appliedMicro)
  // The source's model spend is the larger of its lagging usage and the committed floor, never their sum. Live holds
  // and abandoned reservations (unknown outcomes) are not carried; the true-up returns what they did not spend. So
  // `fullMicro` is an upper bound (deferred allowance stays funded) until this carry's own true-up settles it.
  const spent = Math.max(usdToMicro(data.usage), ledger.committedMicro)
  const micro = carryMicro(fromVisibleLimitMicro, spent, ledger.heldMicro + ledger.abandonedMicro)
  const fullMicro = carryMicro(fromLimitMicro, spent, ledger.abandonedMicro)
  const visibleOrigins = [
    { charge: before.charge, micro: keyPool(key).creditsMicro },
    ...(key.carry?.origins ?? (key.carry?.micro ? [{ charge: key.carry.fromCharge, micro: key.carry.micro }] : [])),
  ]
  const upgrade = {
    subscription: paid.id,
    start: paid.start,
    at: now,
    micro,
    fullMicro,
    origins: allocateCarry(micro, visibleOrigins),
    sourceOrigins,
    visibleOrigins,
    fromVisibleLimitMicro,
    ...(account.poolRamp && now < account.poolRamp.until ? { rampUntil: account.poolRamp.until } : {}),
    fromSubscription: key.subscription,
    fromStart: key.start,
    fromCharge: before.charge,
    fromHash: key.hash,
    fromLimitMicro,
    fromAppliedMicro: ledger.appliedMicro,
  }
  await verify()
  await saveAccount(id, { ...account, upgrade }, fetcher)
  return upgrade
}

// Email delivery never gates a paid entitlement. The outbox retries outages independently of provisioning.
registerAction("pool-ramp", async (action, fetcher) => {
  const payload = action.payload
  if (!stripeRecord(payload) || typeof payload.account !== "string" || typeof payload.until !== "number")
    throw changeUnavailable()
  if (action.now < payload.until) throw new ApiError(503, "MODEL_PLAN_RAMP_PENDING", "Your allowance is being updated.")
  await reconcileModelPlanAccount(payload.account, fetcher, action.now, { source: "outbox" })
})

registerAction("purchase-confirmation", async (action, fetcher) => {
  const payload = action.payload
  if (
    !stripeRecord(payload) ||
    typeof payload.account !== "string" ||
    typeof payload.session !== "string" ||
    typeof payload.customer !== "string" ||
    typeof payload.plan !== "string"
  )
    throw changeUnavailable()
  const id = payload.account
  await withCodiumLease(
    id,
    async (verify) => {
      const account = await readModelPlanAccount(id, fetcher)
      if (!account || account.customer !== payload.customer || account.closing) return
      const mark = codiumKey("purchase-confirmed", payload.session as string)
      if (await persistentStore(["GET", mark], fetcher)) return
      const plan = modelPlans().find((value) => value.id === payload.plan)
      if (!plan || !(await sendCodiumConfirmation(account.customer, payload.session as string, plan, fetcher)))
        throw new ApiError(503, "MODEL_PLAN_CONFIRMATION", "Purchase confirmation is not configured.")
      await verify()
      await persistentStore(["SET", mark, "sent", "PX", 35 * DAY_MS], fetcher)
      if (account.consent && account.consent.session === payload.session)
        await saveAccount(id, { ...account, consent: { ...account.consent, confirmationSent: true } }, fetcher)
    },
    fetcher,
  )
})

/** Allocate remaining value to the newest paid month first, consuming older carry before new credits. */
function allocateCarry(micro: number, origins: readonly { charge: string; micro: number }[]) {
  return origins.flatMap((origin) => {
    const kept = Math.min(micro, origin.micro)
    micro -= kept
    return kept ? [{ charge: origin.charge, micro: kept }] : []
  })
}

function carryPotentialOrigins(carried: AccountKey["carry"], potentialMicro = carried?.fullMicro ?? carried?.micro) {
  if (!carried || potentialMicro === undefined) return []
  return allocateCarry(
    potentialMicro,
    carried.sourceOrigins ?? [{ charge: carried.fromCharge, micro: carried.micro }],
  ).filter((origin) => !carried.revokedOrigins?.includes(origin.charge))
}
function carryPotential(carried: AccountKey["carry"]) {
  return carryPotentialOrigins(carried).reduce((sum, origin) => sum + origin.micro, 0)
}

/**
 * What a key's carry is worth to the next upgrade. Before its true-up, `fullMicro` is only an upper bound (its source's
 * live holds may still spend), and once the key is replaced that true-up never runs: the next upgrade would grant the
 * held amount again. So an untrued carry is settled here from its source's current standing, counting live holds as
 * spent. Allowance a live hold later leaves unspent is not returned, and is never granted twice.
 */
async function settledCarryOrigins(id: string, key: AccountKey, now: number, fetcher: typeof fetch) {
  const carried = key.carry
  if (!carried?.fromHash || carried.fromLimitMicro === undefined || carried.trued) return carryPotentialOrigins(carried)
  const source = await carrySource(id, carried.fromHash, carried.fromAppliedMicro, now, fetcher)
  const potential = carryMicro(
    Math.max(0, carried.fromLimitMicro - source.lateDebits),
    source.finalUsage,
    source.ledger.heldMicro,
  )
  // A shortfall debit already charged to this key (a true-up interrupted before its save) is in this key's applied.
  const recorded = await recordedShortfall(id, key.hash, carried.fromHash, fetcher)
  return carryPotentialOrigins(carried, potential + recorded)
}

/**
 * A replaced source pool's standing, by its immutable identity: late settlements still land there (old-pool identity).
 * Model spend is the larger of the final provider usage and the committed floor plus abandoned reservations, a max and
 * never a sum: a settled charge is in both once the provider catches up. Replaced keys no longer get their limits
 * PATCHed when hosted debits settle, so the durable debit delta since the upgrade is returned separately.
 */
async function carrySource(
  id: string,
  fromHash: string,
  fromAppliedMicro: number | undefined,
  now: number,
  fetcher: typeof fetch,
) {
  const data = (await openRouterManagement(`/${encodeURIComponent(fromHash)}`, undefined, fetcher)).data
  if (
    !stripeRecord(data) ||
    data.disabled !== true ||
    typeof data.usage !== "number" ||
    !Number.isFinite(data.usage) ||
    data.usage < 0
  )
    throw new ApiError(503, "MODEL_PLAN_KEY_INVALID", "Your remaining allowance could not be verified.")
  const ledger = await readPoolLedger(id, fromHash, now, fetcher)
  return {
    ledger,
    lateDebits: Math.max(0, ledger.appliedMicro - (fromAppliedMicro ?? 0)),
    finalUsage: Math.max(usdToMicro(data.usage), ledger.committedMicro + ledger.abandonedMicro),
  }
}

/** Every originating payment remains accountable after repeated upgrades, not just the latest subscription. */
async function refreshCarry(id: string, account: Account, fetcher: typeof fetch, verify: () => Promise<void>) {
  const carried = account.key?.carry
  if (!carried) return account
  const sources = carried.sourceOrigins ?? [{ charge: carried.fromCharge, micro: carried.micro }]
  const valid = new Set<string>()
  for (const origin of sources) {
    const charge = await modelPlanStripe(`charges/${encodeURIComponent(origin.charge)}`, {}, fetcher)
    if (
      charge.customer === account.customer &&
      charge.paid === true &&
      charge.refunded === false &&
      !fullyRefunded(charge) &&
      (await chargeAvailable(charge, origin.charge, fetcher))
    )
      valid.add(origin.charge)
  }
  const before = carried.origins ?? [{ charge: carried.fromCharge, micro: carried.micro }]
  const origins = before.filter((origin) => valid.has(origin.charge))
  const revokedOrigins = [
    ...new Set([
      ...(carried.revokedOrigins ?? []),
      ...sources.filter((origin) => !valid.has(origin.charge)).map((origin) => origin.charge),
    ]),
  ]
  if (origins.length === before.length && revokedOrigins.length === (carried.revokedOrigins?.length ?? 0))
    return account
  const updated = {
    ...account,
    key: {
      ...account.key!,
      carry: {
        ...carried,
        micro: origins.reduce((sum, origin) => sum + origin.micro, 0),
        origins,
        sourceOrigins: sources,
        revokedOrigins,
        revoked: sources.every((origin) => revokedOrigins.includes(origin.charge)),
      },
    },
  }
  await verify()
  await saveAccount(id, updated, fetcher)
  return updated
}

async function finishUpgrade(
  id: string,
  account: Account,
  paid: NonNullable<ReturnType<typeof paidModelPlan>>,
  fetcher: typeof fetch,
  verify: () => Promise<void>,
  now: number,
) {
  if (!paid.supersedes) return
  // Retry cleanup independently if a Stripe response is lost; the source must be this customer's subscription.
  const old = await modelPlanStripe(`subscriptions/${encodeURIComponent(paid.supersedes)}`, {}, fetcher)
  if (old.customer !== account.customer || !stripeRecord(old.metadata) || old.metadata.vector_account_id !== id)
    throw changeUnavailable()
  await enqueueAction(
    "supersede",
    `${id}:${paid.supersedes}`,
    { customer: account.customer, subscription: paid.supersedes },
    now,
    fetcher,
    now,
  )
  const carried = account.key?.carry
  if (carried?.fromHash && carried.trueupAt)
    await enqueueAction(
      "carry-trueup",
      `${id}:${account.key!.hash}`,
      { account: id, hash: account.key!.hash },
      carried.trueupAt,
      fetcher,
      now,
    )
  if (carried?.fromHash && carried.rampUntil && now < carried.rampUntil)
    await enqueueAction(
      "carry-trueup",
      `${id}:${account.key!.hash}:ramp`,
      { account: id, hash: account.key!.hash },
      carried.rampUntil,
      fetcher,
      now,
    )
  await verify()
  await supersedeSubscription(account.customer, paid.supersedes, fetcher)
}

registerAction("supersede", async (action, fetcher) => {
  const payload = action.payload
  if (!stripeRecord(payload) || typeof payload.customer !== "string" || typeof payload.subscription !== "string")
    throw changeUnavailable()
  await supersedeSubscription(payload.customer, payload.subscription, fetcher)
})

registerAction("carry-trueup", async (action, fetcher) => {
  const payload = action.payload
  if (!stripeRecord(payload) || typeof payload.account !== "string" || typeof payload.hash !== "string")
    throw changeUnavailable()
  const id = payload.account
  await withCodiumLease(
    id,
    async (verify) => {
      const saved = await readModelPlanAccount(id, fetcher)
      if (!saved || saved.key?.hash !== payload.hash || saved.closing || riskState(saved)) return
      const refreshed = await refreshCarry(id, saved, fetcher, verify)
      // A source reversal discovered here must lower the actual provider limit even when no true-up may proceed.
      const repaired = await convergeKey(id, refreshed, refreshed.key!, verify, fetcher)
      const account = await publishKey(id, repaired.account, verify, fetcher)
      const key = account.key!
      const carried = key.carry
      if (
        !carried ||
        carried.revoked ||
        !carried.fromHash ||
        carried.fromLimitMicro === undefined ||
        !carried.trueupAt ||
        action.now < carried.trueupAt
      )
        return
      const source = await carrySource(id, carried.fromHash, carried.fromAppliedMicro, action.now, fetcher)
      // Live holds (nonmodel holds and model reservations before their deadline) or pending debits still reserve the
      // source; retry instead of releasing their money early. An abandoned reservation has no live request left to
      // wait for: it counts as consumed at its full amount (in `finalUsage`).
      if (source.ledger.heldMicro || source.ledger.pendingMicro)
        throw new ApiError(503, "MODEL_PLAN_CARRY_PENDING", "Your remaining allowance is being updated.")
      const lateDebits = source.lateDebits
      const finalUsage = source.finalUsage
      const limited = carried.rampUntil !== undefined && action.now < carried.rampUntil
      const finalLimit = Math.max(
        0,
        (limited ? (carried.fromVisibleLimitMicro ?? carried.fromLimitMicro) : carried.fromLimitMicro) - lateDebits,
      )
      // Allocate historical spend against the original origin order before excluding reversed payments.
      // Filtering that order first could resurrect an older allowance that was already consumed.
      const candidates = allocateCarry(
        carryMicro(finalLimit, finalUsage),
        (limited ? carried.visibleOrigins : carried.sourceOrigins) ?? [
          { charge: carried.fromCharge, micro: finalLimit },
        ],
      ).filter((origin) => !carried.revokedOrigins?.includes(origin.charge))
      const supported = candidates.reduce((sum, origin) => sum + origin.micro, 0)
      // Carry only rises (M6), so what this pool really holds of it is `carried.micro` less the shortfall debits
      // already charged to it. When the source finally spent more than it held at the upgrade (a charge settled above
      // its hold or reservation), the carry granted that difference twice: once here, once by the source's own spend.
      // The excess over `supported` is charged to this successor pool as a debit, once per cumulative amount. A later
      // true-up that supports more (the full limit once the ramp ends) raises the carry over what was charged instead,
      // so nothing is granted twice and no overspend is charged twice.
      const recorded = await recordedShortfall(id, key.hash, carried.fromHash, fetcher)
      const charged = Math.max(recorded, carried.micro - supported)
      await chargeCarryShortfall(id, key, carried.fromHash, charged, recorded, action.now, verify, fetcher)
      const proposed = Math.max(carried.micro, supported + charged)
      const credits = keyPool(key).creditsMicro
      const raised = Math.min(proposed, usdToMicro(codiumKeyLimitUsd(microToUsd(credits + proposed))) - credits)
      const origins = proposed > carried.micro ? allocateCarry(raised, candidates) : carried.origins
      // Settled potential for the next upgrade, in the same units as `micro` (gross of this pool's shortfall debits,
      // which that upgrade subtracts as applied debits). `trued` tells the next upgrade it may trust it.
      const fullMicro = carryMicro(Math.max(0, carried.fromLimitMicro - lateDebits), finalUsage) + charged
      const updated = {
        ...account,
        key: { ...key, carry: { ...carried, micro: raised, fullMicro, origins, trued: true } },
      }
      await verify()
      await saveAccount(id, updated, fetcher)
      const converged = await convergeKey(id, updated, updated.key, verify, fetcher)
      await publishKey(id, converged.account, verify, fetcher)
    },
    fetcher,
  )
})

/** Carry shortfall debits already charged to `pool` for the carry from `fromHash`. */
async function recordedShortfall(id: string, pool: string, fromHash: string, fetcher: typeof fetch) {
  return (await readDebits(id, pool, fetcher))
    .filter((debit) => debit.ref.startsWith(`carry-shortfall-${fromHash}-`))
    .reduce((sum, debit) => sum + debit.micro, 0)
}

/**
 * Records carry the source pool could not support as a debit on the successor key, up to the cumulative
 * `shortfallMicro`. Refs carry that cumulative amount, and only the part not already `recorded` (read under the same
 * lease) is charged, so a retried or second true-up never charges twice and a crash between the debit and the account
 * save loses nothing. Callers hold the lease and converge after.
 */
async function chargeCarryShortfall(
  id: string,
  key: AccountKey,
  fromHash: string,
  shortfallMicro: number,
  recorded: number,
  now: number,
  verify: () => Promise<void>,
  fetcher: typeof fetch,
) {
  const micro = shortfallMicro - recorded
  if (micro <= 0) return
  const ref = `carry-shortfall-${fromHash}-${shortfallMicro}`
  const member = holdMember(debitHoldTicket(ref), "chat", undefined, micro)
  await verify()
  await recordDebit(
    { account: id, pool: key.hash, ticket: debitHoldTicket(ref), member, purpose: "chat", micro },
    { ref, micro, keepUntil: key.end * 1000 + DEBITS_KEEP_MS, now },
    fetcher,
  )
}

export async function modelPlanChange(
  user: AccountUser,
  planID: string | undefined,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  requireCodiumCheckoutUser(user)
  if (planID !== undefined && !isPlanId(planID))
    throw new ApiError(400, "MODEL_PLAN_INVALID", "Choose an available Codium subscription.")
  return withCodiumLease(
    user.id,
    async (verify) => {
      const account = await readModelPlanAccount(user.id, fetcher)
      if (!account || account.closing || riskState(account)) throw changeUnavailable()
      const listed = await subscriptions(account.customer, fetcher)
      const standing = planStanding(user.id, account, listed, now)
      const paid = standing.state === "active" ? standing.governing?.paid : undefined
      if (!paid || standing.duplicates.length) throw changeUnavailable()
      const current = listed.find((value) => value.id === paid.id)!
      if (planID === undefined) {
        await verify()
        await releaseDowngrade(current, fetcher)
        await saveAccount(user.id, { ...account, downgrade: undefined }, fetcher)
        return { scheduled: false }
      }
      if (current.schedule) {
        const existing = await scheduledPlan(current, fetcher)
        if (existing?.plan === planID) return { scheduled: existing }
        if (account.downgrade?.plan !== planID) throw changeUnavailable()
      }
      if (current.cancel_at_period_end || planID === paid.plan.id) throw changeUnavailable()
      const target = modelPlans().find((value) => value.id === planID)
      if (!target?.priceID || !target.credits) throw changeUnavailable()
      // Any invoice still collectible makes another charge unsafe, whether it is this subscription's or a duplicate's.
      const open = await modelPlanStripe(
        `invoices?${new URLSearchParams({ customer: account.customer, status: "open", limit: "1" })}`,
        {},
        fetcher,
      )
      if (!Array.isArray(open.data) || open.data.length || open.has_more !== false) throw changeUnavailable()
      const price = await modelPlanStripe(`prices/${encodeURIComponent(target.priceID)}`, {}, fetcher)
      if (
        price.active !== true ||
        price.currency !== "usd" ||
        price.unit_amount !== target.price * 100 ||
        !stripeRecord(price.recurring) ||
        price.recurring.interval !== "month" ||
        price.recurring.interval_count !== 1
      )
        throw changeUnavailable()
      if (rank(planID) < rank(paid.plan.id)) {
        const pending = account.downgrade?.plan === planID ? account.downgrade : { plan: planID, token: randomUUID() }
        await verify()
        await saveAccount(user.id, { ...account, downgrade: pending }, fetcher)
        await scheduleDowngrade(current, target.priceID, pending.token, fetcher)
        await verify()
        await saveAccount(user.id, { ...account, downgrade: undefined }, fetcher)
        return { scheduled: { plan: planID, at: paid.end * 1000 } }
      }
      if ((await readSwitch("sales", fetcher, { fresh: true })) !== "on") throw changeUnavailable()
      const funding = await requireCodiumSales(fetcher, now)
      const riskFields = await checkoutRiskFields(user.id, account.customer, target.price, fetcher)
      const requires3DS = "payment_method_options[card][request_three_d_secure]" in riskFields
      const earlier = account.checkout && account.checkout.expires > now ? account.checkout : undefined
      const pending = earlier
        ? await modelPlanStripe(`checkout/sessions/${encodeURIComponent(earlier.id)}`, {}, fetcher)
        : undefined
      if (pending?.status === "complete") throw changeUnavailable()
      if (
        earlier?.supersedes === paid.id &&
        earlier.plan === target.id &&
        pending?.status === "open" &&
        stripeRecord(pending.metadata) &&
        pending.metadata.vector_price_id === target.priceID &&
        pending.metadata.vector_model_credits_usd === String(target.credits) &&
        pending.metadata.vector_terms_date === CODIUM_TERMS_DATE &&
        pending.metadata.vector_3ds_requested === String(requires3DS)
      )
        return { url: earlier.url }
      if (pending?.status === "open") {
        await verify()
        await modelPlanStripe(
          `checkout/sessions/${encodeURIComponent(earlier!.id)}/expire`,
          { method: "POST", idempotency: `vector-expire-${earlier!.id}` },
          fetcher,
        )
      }
      const closes = (Math.floor(now / 1_800_000) + 2) * 1_800_000
      const idempotency = `vector-upgrade-${digest(`${user.id}:${paid.id}:${target.priceID}:${target.credits}:${earlier?.id ?? "new"}`)}-${Math.floor(now / 1_800_000)}`
      await reserveCodiumSale(
        funding,
        {
          id: idempotency,
          credits: target.credits,
          closes,
          released: pending?.status === "expired" || pending?.status === "open" ? earlier?.reservation : undefined,
        },
        fetcher,
        now,
      )
      await verify()
      const result = await modelPlanStripe(
        "checkout/sessions",
        {
          method: "POST",
          idempotency,
          body: new URLSearchParams({
            mode: "subscription",
            customer: account.customer,
            client_reference_id: user.id,
            "payment_method_types[0]": "card",
            "line_items[0][price]": target.priceID,
            "line_items[0][quantity]": "1",
            ...checkoutConsentFields(target),
            ...riskFields,
            "metadata[vector_3ds_requested]": String(requires3DS),
            "metadata[vector_model_credits_usd]": String(target.credits),
            "metadata[vector_price_id]": target.priceID,
            "subscription_data[metadata][vector_account_id]": user.id,
            "subscription_data[metadata][vector_plan]": target.id,
            "subscription_data[metadata][vector_model_credits_usd]": String(target.credits),
            "subscription_data[metadata][vector_supersedes]": paid.id,
            success_url: `${modelPlanOrigin()}/account?model_plan=success&change=upgrade`,
            cancel_url: `${modelPlanOrigin()}/account?model_plan=cancelled`,
            expires_at: String(closes / 1000),
          }),
        },
        fetcher,
      )
      if (
        typeof result.id !== "string" ||
        typeof result.url !== "string" ||
        !result.url.startsWith("https://checkout.stripe.com/") ||
        typeof result.expires_at !== "number"
      )
        throw new ApiError(502, "BILLING_CHECKOUT", "Checkout could not be opened.")
      await verify()
      await saveAccount(
        user.id,
        {
          ...account,
          checkout: {
            id: result.id,
            plan: target.id,
            url: result.url,
            expires: result.expires_at * 1000,
            reservation: idempotency,
            supersedes: paid.id,
          },
        },
        fetcher,
      )
      return { url: result.url }
    },
    fetcher,
  )
}

export async function modelPlanCheckout(
  user: AccountUser,
  planID: string,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  const plan = modelPlans().find((plan) => plan.id === planID)
  if (!plan?.priceID || !plan.credits)
    throw new ApiError(400, "MODEL_PLAN_INVALID", "Choose an available Codium subscription.")
  const priceID = plan.priceID
  requireCodiumCheckoutUser(user)
  // Sell only credits Vector's OpenRouter balance can pay for.
  if ((await readSwitch("sales", fetcher, { fresh: true })) !== "on") throw changeUnavailable()
  const funding = await requireCodiumSales(fetcher, now)
  return withAccountLease(
    user.id,
    async (verify) => {
      const previous = await readModelPlanAccount(user.id, fetcher)
      if (previous?.closing)
        throw new ApiError(409, "MODEL_PLAN_ACCOUNT_CLOSING", "This account is being deleted. Checkout is closed.")
      // An account a lost dispute, a fraud warning or the owner holds buys nothing: reconcile would never grant what it
      // paid for. Refused before any customer, reservation or session is made.
      const held = previous && riskState(previous)
      if (held) throw blockedRefusal(held)
      const customer =
        previous?.customer ??
        (
          await modelPlanStripe(
            "customers",
            {
              method: "POST",
              idempotency: `vector-model-customer-${user.id}`,
              body: new URLSearchParams({ email: user.email, "metadata[vector_account_id]": user.id }),
            },
            fetcher,
          )
        ).id
      if (typeof customer !== "string" || !/^cus_[a-zA-Z0-9]+$/.test(customer))
        throw new ApiError(502, "BILLING_CUSTOMER", "Your billing account could not be created.")
      const account = previous ?? { customer }
      if (!previous) await saveAccount(user.id, account, fetcher)
      if (
        (await subscriptions(customer, fetcher)).some(
          (subscription) => !["canceled", "incomplete_expired"].includes(String(subscription.status)),
        )
      )
        throw new ApiError(409, "MODEL_PLAN_EXISTS", "You already have a subscription. Manage it from your account.")
      const riskFields = await checkoutRiskFields(user.id, customer, plan.price, fetcher)
      const requires3DS = "payment_method_options[card][request_three_d_secure]" in riskFields
      const earlier = account.checkout && account.checkout.expires > now ? account.checkout : undefined
      const pending = earlier
        ? await modelPlanStripe(`checkout/sessions/${encodeURIComponent(earlier.id)}`, {}, fetcher)
        : undefined
      if (pending?.status === "complete")
        throw new ApiError(
          409,
          "MODEL_PLAN_EXISTS",
          "Checkout has already completed. Refresh your account or manage your subscription.",
        )
      if (
        earlier &&
        pending?.status === "open" &&
        earlier.plan === plan.id &&
        stripeRecord(pending.metadata) &&
        pending.metadata.vector_model_credits_usd === String(plan.credits) &&
        pending.metadata.vector_price_id === priceID &&
        pending.metadata.vector_terms_date === CODIUM_TERMS_DATE &&
        pending.metadata.vector_3ds_requested === String(requires3DS)
      )
        return { url: earlier.url }
      if (pending?.status === "open") await verify()
      const closed =
        earlier && pending?.status === "open"
          ? await modelPlanStripe(
              `checkout/sessions/${encodeURIComponent(earlier.id)}/expire`,
              { method: "POST", idempotency: `vector-expire-${earlier.id}` },
              fetcher,
            )
          : pending
      const price = await modelPlanStripe(`prices/${priceID}`, {}, fetcher)
      const recurring = stripeRecord(price.recurring) ? price.recurring : undefined
      if (
        price.active !== true ||
        price.currency !== "usd" ||
        price.unit_amount !== plan.price * 100 ||
        recurring?.interval !== "month" ||
        recurring.interval_count !== 1
      )
        throw new ApiError(503, "MODEL_PLAN_PRICE_MISMATCH", "This subscription price is not configured correctly.")
      const closes = (Math.floor(now / 1_800_000) + 2) * 1_800_000
      const idempotency = `vector-model-checkout-${user.id}-${plan.id}-${createHash("sha256").update(`${priceID}:${plan.credits}`).digest("hex").slice(0, 12)}-${account.checkout?.id ?? "new"}-${Math.floor(now / 1_800_000)}`
      // Only a checkout that can no longer be paid gives its reservation back. A paid one keeps counting until it
      // lapses, because the reading this sale is measured against may not count its credits as owed yet.
      await reserveCodiumSale(
        funding,
        {
          id: idempotency,
          credits: plan.credits,
          closes,
          released: closed?.status === "expired" ? earlier?.reservation : undefined,
        },
        fetcher,
        now,
      )
      await verify()
      const checkout = await modelPlanStripe(
        "checkout/sessions",
        {
          method: "POST",
          idempotency,
          body: new URLSearchParams({
            mode: "subscription",
            "payment_method_types[0]": "card",
            ...checkoutConsentFields(plan),
            ...riskFields,
            "metadata[vector_3ds_requested]": String(requires3DS),
            customer,
            client_reference_id: user.id,
            "line_items[0][price]": priceID,
            "line_items[0][quantity]": "1",
            "metadata[vector_model_credits_usd]": String(plan.credits),
            "metadata[vector_price_id]": priceID,
            "subscription_data[metadata][vector_account_id]": user.id,
            "subscription_data[metadata][vector_plan]": plan.id,
            "subscription_data[metadata][vector_model_credits_usd]": String(plan.credits),
            success_url: `${modelPlanOrigin()}/account?model_plan=success`,
            cancel_url: `${modelPlanOrigin()}/account?model_plan=cancelled`,
            expires_at: String(closes / 1000),
          }),
        },
        fetcher,
      )
      if (
        typeof checkout.id !== "string" ||
        typeof checkout.url !== "string" ||
        !checkout.url.startsWith("https://checkout.stripe.com/") ||
        typeof checkout.expires_at !== "number"
      )
        throw new ApiError(502, "BILLING_CHECKOUT", "Checkout could not be opened.")
      await saveAccount(
        user.id,
        {
          ...account,
          checkout: {
            id: checkout.id,
            plan: plan.id,
            url: checkout.url,
            expires: checkout.expires_at * 1000,
            reservation: idempotency,
          },
        },
        fetcher,
      )
      return { url: checkout.url }
    },
    fetcher,
  )
}

/** The no-change portal's home, cancellation step or payment-method update, including for an unpaid customer. */
export async function modelPlanPortal(
  id: string,
  fetcher: typeof fetch = fetch,
  options: { flow?: "change" | "cancel" | "payment_method_update"; now?: number } = {},
) {
  if (options.flow === "change") throw changeUnavailable()
  const account = await readModelPlanAccount(id, fetcher)
  if (!account) throw new ApiError(404, "MODEL_PLAN_ACCOUNT_MISSING", "No Codium billing account exists yet.")
  const configuration = process.env.STRIPE_MODEL_PLAN_PORTAL_CONFIG_ID?.trim()
  if (!configuration)
    throw new ApiError(503, "BILLING_PORTAL_UNAVAILABLE", "Subscription management is temporarily unavailable.")
  const subscription =
    options.flow === "cancel"
      ? (await subscriptions(account.customer, fetcher)).flatMap((value) => {
          const paid = paidModelPlan(value, id, options.now)
          // A smaller plan chosen in the portal waits for the renewal date in a subscription schedule.
          return paid ? [{ ...paid, scheduled: stripeRecord(value) && Boolean(value.schedule) }] : []
        })
      : []
  if (options.flow === "cancel" && subscription.length !== 1)
    throw new ApiError(404, "MODEL_PLAN_MISSING", "There is no paid Codium plan to cancel.")
  // Stripe does not change a subscription that is cancelling or already has a change waiting, so say why here rather
  // than open a portal step that fails.
  if (options.flow === "cancel" && subscription[0]!.cancelAtPeriodEnd)
    throw new ApiError(409, "MODEL_PLAN_ENDING", "Your plan already ends at the close of this billing period.")
  if (options.flow === "cancel") {
    await withCodiumLease(
      id,
      async (verify) => {
        await verify()
        const current = await listSubscriptions(account.customer, fetcher)
        const selected = current.find((value) => value.id === subscription[0]!.id)
        if (selected) await releaseDowngrade(selected, fetcher)
        const latest = await readModelPlanAccount(id, fetcher)
        if (latest?.downgrade) await saveAccount(id, { ...latest, downgrade: undefined }, fetcher)
      },
      fetcher,
    )
  }
  const flow = options.flow === "cancel" ? "subscription_cancel" : options.flow
  const body = new URLSearchParams({
    customer: account.customer,
    configuration,
    return_url: `${modelPlanOrigin()}/account`,
    // The account return is also recognized by Vector's billing window.
    ...(flow
      ? {
          "flow_data[type]": flow,
          ...(flow === "subscription_cancel"
            ? { "flow_data[subscription_cancel][subscription]": subscription[0]!.id }
            : {}),
          "flow_data[after_completion][type]": "redirect",
          "flow_data[after_completion][redirect][return_url]": `${modelPlanOrigin()}/account?model_plan=${flow === "subscription_cancel" ? "ending" : "updated"}`,
        }
      : {}),
  })
  // A double click within the minute opens the same portal session; Stripe refuses a key reused with other values,
  // so the key covers everything the request says.
  const result = await modelPlanStripe(
    "billing_portal/sessions",
    {
      method: "POST",
      body,
      idempotency: `vector-portal-${digest(body.toString())}-${Math.floor((options.now ?? Date.now()) / 60_000)}`,
    },
    fetcher,
  )
  if (typeof result.url !== "string" || !result.url.startsWith("https://billing.stripe.com/"))
    throw new ApiError(502, "BILLING_PORTAL_UNAVAILABLE", "Subscription management could not be opened.")
  return { url: result.url }
}

/** An owner quote is a confirmation fence, never an amount supplied to the refund provider. */
export function ownerRefundQuote(
  id: string,
  account: Account,
  listed: readonly Record<string, unknown>[],
  now = Date.now(),
) {
  if (account.ownerEnd && !account.ownerEnd.done) {
    const operation = account.ownerEnd
    return {
      expectedCharge: operation.charge,
      expectedRefundCents: operation.refundCents,
      expectedSubscription: operation.subscription,
      expectedPeriodStart: operation.periodStart,
    }
  }
  const current = listed.filter((subscription) => subscription.customer === account.customer)
  const governing = planStanding(id, account, current, now).governing
  const source = current.find((value) => value.id === governing?.id)
  // Cancellation stops access; it does not make the current paid invoice ineligible for an owner's cash refund.
  const paid =
    governing?.paid ??
    (source?.status === "canceled" ? paidModelPlan({ ...source, status: "active" }, id, now) : undefined)
  const base = {
    expectedSubscription: governing?.id ?? null,
    expectedPeriodStart: governing ? governing.start * 1000 : null,
  }
  if (!paid) return { ...base, expectedCharge: null, expectedRefundCents: 0 }
  const charge = source && latestCharge(source)
  if (
    !charge ||
    !validChargeId(charge.id) ||
    charge.paid !== true ||
    charge.currency !== "usd" ||
    !Number.isSafeInteger(charge.amount) ||
    !Number.isSafeInteger(charge.amount_refunded) ||
    Number(charge.amount) <= 0 ||
    Number(charge.amount_refunded) < 0 ||
    Number(charge.amount_refunded) > Number(charge.amount)
  )
    return undefined
  return {
    ...base,
    expectedCharge: charge.id,
    expectedRefundCents: Number(charge.amount) - Number(charge.amount_refunded),
  }
}
export type OwnerRefundQuote = NonNullable<ReturnType<typeof ownerRefundQuote>>

/** Freeze and bind immutable targets before external writes. The existing reconcile outbox discovers/retries this intent. */
export async function refundEndModelPlanAccount(
  id: string,
  expected: OwnerRefundQuote,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  const operation = await withCodiumLease(
    id,
    async (verify) => {
      const account = await readModelPlanAccount(id, fetcher)
      if (!account || account.closing)
        throw new ApiError(409, "CODIUM_ACCOUNT_UNAVAILABLE", "This Codium account cannot be changed.")
      if (
        account.ownerEnd?.done &&
        expected.expectedCharge === account.ownerEnd.charge &&
        expected.expectedSubscription === account.ownerEnd.subscription &&
        expected.expectedPeriodStart === account.ownerEnd.periodStart &&
        expected.expectedRefundCents === account.ownerEnd.refundCents
      )
        return account.ownerEnd.id
      const listed = await listSubscriptions(account.customer, fetcher)
      const quote = ownerRefundQuote(id, account, listed, now)
      if (
        !quote ||
        Object.keys(expected).some(
          (key) => expected[key as keyof OwnerRefundQuote] !== quote[key as keyof OwnerRefundQuote],
        )
      )
        throw new ApiError(
          409,
          "CODIUM_REFUND_CHANGED",
          "The current payment changed. Refresh and confirm the updated payment.",
        )
      if (account.ownerEnd && !account.ownerEnd.done) {
        const failed = account.ownerEnd.refund?.status === "failed" || account.ownerEnd.refund?.status === "canceled"
        await verify()
        if (failed)
          await saveAccountAndReconcile(
            id,
            {
              ...account,
              ownerEnd: {
                ...account.ownerEnd,
                refundAttempt: (account.ownerEnd.refundAttempt ?? 0) + 1,
                refund: undefined,
              },
            },
            fetcher,
            now,
          )
        else await enqueueAction("reconcile", id, {}, undefined, fetcher, now)
        return account.ownerEnd.id
      }
      if (quote.expectedCharge && !(await codiumChargeOwned(id, account.customer, quote.expectedCharge, fetcher)))
        throw new ApiError(
          409,
          "CODIUM_REFUND_CHANGED",
          "The current payment could not be verified. Refresh and try again.",
        )
      // A session can complete after the first subscription read. Include every status and the durably bound
      // session explicitly; otherwise an open-only list can omit both it and its newly created subscription.
      const checkouts = await listStripe("checkout/sessions", [["customer", account.customer]], {}, fetcher)
      if (!checkouts.complete)
        throw new ApiError(503, "MODEL_PLAN_CLEANUP", "Pending Codium checkouts could not be verified.")
      const captured = checkouts.data.filter((session) => ownerCheckoutOwned(id, account, session))
      if (account.checkout && !captured.some((session) => session.id === account.checkout!.id)) {
        const bound = await modelPlanStripe(`checkout/sessions/${encodeURIComponent(account.checkout.id)}`, {}, fetcher)
        if (!ownerCheckoutOwned(id, account, bound))
          throw new ApiError(503, "MODEL_PLAN_CLEANUP", "The saved Codium checkout could not be verified.")
        captured.push(bound)
      }
      if (captured.some((session) => typeof session.id !== "string"))
        throw new ApiError(503, "MODEL_PLAN_CLEANUP", "Pending Codium checkouts could not be verified.")
      // Confirm the quoted payment again after session discovery. A newly paid checkout must require a new
      // confirmation; a later completion remains covered by its immutable captured session target.
      const current = await listSubscriptions(account.customer, fetcher)
      const confirmed = ownerRefundQuote(id, account, current, now)
      if (
        !confirmed ||
        Object.keys(expected).some(
          (key) => expected[key as keyof OwnerRefundQuote] !== confirmed[key as keyof OwnerRefundQuote],
        )
      )
        throw new ApiError(
          409,
          "CODIUM_REFUND_CHANGED",
          "The current payment changed. Refresh and confirm the updated payment.",
        )
      const intent = {
        id: randomUUID(),
        at: now,
        customer: account.customer,
        charge: quote.expectedCharge,
        refundCents: quote.expectedRefundCents,
        subscription: quote.expectedSubscription,
        periodStart: quote.expectedPeriodStart,
        subscriptions: current
          .filter(
            (subscription) =>
              subscription.customer === account.customer &&
              stripeRecord(subscription.metadata) &&
              subscription.metadata.vector_account_id === id &&
              isPlanId(subscription.metadata.vector_plan),
          )
          .map((subscription) => String(subscription.id)),
        checkouts: captured.map((session) => String(session.id)),
        done: false,
      }
      const held = { ...account, ownerEnd: intent }
      await verify()
      await saveAccountAndReconcile(id, held, fetcher, now)
      // An interruption after this save is also found by ordinary reconciliation/sweeps through the frozen snapshot.
      const stored = await readSnapshotForWrite(id, fetcher)
      await commitSnapshot(
        { ...closingFacts(id, held, stored.previous, "owner"), state: "frozen", reason: "owner" },
        stored,
        fetcher,
        now,
        verify,
      )
      const keyOwed = account.key
        ? (account.key.fullCreditsMicro ?? keyPool(account.key).creditsMicro) + carryPotential(account.key.carry)
        : 0
      const contracted = current.reduce((sum, subscription) => {
        const paid = paidModelPlan(subscription, id, now)
        return sum + (paid ? usdToMicro(codiumKeyLimitUsd(paid.plan.credits)) : 0)
      }, 0)
      const owed = Math.max(keyOwed, contracted)
      await writeRampOwed(id, owed, fetcher, "raise")
      if (account.key) await disableKey(account.key, verify, fetcher)
      await verify()
      await enqueueAction("reconcile", id, {}, undefined, fetcher, now)
      return intent.id
    },
    fetcher,
  )
  // Work remains queued if the bounded immediate attempt fails. The caller can retry the same confirmation safely.
  await reconcileModelPlanAccount(id, fetcher, now, { source: "owner" })
  return operation
}

function ownerCheckoutOwned(id: string, account: Account, session: Record<string, unknown>, captured = false) {
  const known = account.checkout && account.checkout.id === session.id && isPlanId(account.checkout.plan)
  if (
    session.customer !== account.customer ||
    session.mode !== "subscription" ||
    (session.client_reference_id !== id && !(known && session.client_reference_id == null))
  )
    return false
  if (captured || known) return true
  const metadata = stripeRecord(session.metadata) ? session.metadata : undefined
  return (
    modelPlans().some((plan) => plan.priceID && plan.priceID === metadata?.vector_price_id) &&
    Number.isFinite(Number(metadata?.vector_model_credits_usd)) &&
    Number(metadata?.vector_model_credits_usd) > 0
  )
}

async function finishOwnerEnd(
  id: string,
  account: Account,
  verify: () => Promise<void>,
  fetcher: typeof fetch,
  now: number,
) {
  const operation = account.ownerEnd
  if (!operation || operation.done || operation.customer !== account.customer)
    throw new ApiError(503, "CODIUM_OWNER_OPERATION_INVALID", "The saved owner operation could not be verified.")
  const targets = new Set(operation.subscriptions)
  for (const checkout of operation.checkouts) {
    const session = await modelPlanStripe(`checkout/sessions/${encodeURIComponent(checkout)}`, {}, fetcher)
    if (!ownerCheckoutOwned(id, account, session, true))
      throw new ApiError(503, "CODIUM_OWNER_OPERATION_INVALID", "The saved checkout could not be verified.")
    if (session.status === "open") {
      await verify()
      await modelPlanStripe(
        `checkout/sessions/${encodeURIComponent(checkout)}/expire`,
        { method: "POST", idempotency: `vector-owner-expire-${operation.id}-${checkout}` },
        fetcher,
      )
    }
    // A captured pending checkout can finish while it is being stopped. Its resulting subscription remains bound to that immutable checkout target.
    const subscription = stripeObjectId(session.subscription)
    if (session.status === "complete" && subscription) targets.add(subscription)
  }
  for (const subscription of targets) {
    const current = await modelPlanStripe(`subscriptions/${encodeURIComponent(subscription)}`, {}, fetcher)
    if (
      current.customer !== account.customer ||
      !stripeRecord(current.metadata) ||
      current.metadata.vector_account_id !== id ||
      !isPlanId(current.metadata.vector_plan)
    )
      throw new ApiError(503, "CODIUM_OWNER_OPERATION_INVALID", "The saved subscription could not be verified.")
    await supersedeSubscription(account.customer, subscription, fetcher, verify)
  }
  if (operation.charge) await settleOwnerRefund(id, account, verify, fetcher)
  const latest = await readModelPlanAccount(id, fetcher)
  if (!latest || latest.ownerEnd?.id !== operation.id)
    throw new ApiError(503, "CODIUM_OWNER_OPERATION_INVALID", "The saved owner operation changed.")
  const refunded =
    operation.charge && operation.subscription && operation.periodStart !== null
      ? { subscription: operation.subscription, periodStart: operation.periodStart }
      : latest.ownerRefunded
  const ended = {
    ...latest,
    ownerEnd: { ...latest.ownerEnd, done: true },
    ownerRefunded: refunded,
    ...(latest.key
      ? {
          key: {
            ...latest.key,
            revoked:
              refunded &&
              refunded.subscription === latest.key.subscription &&
              refunded.periodStart === latest.key.start * 1000
                ? ("refunded" as const)
                : ("canceled" as const),
          },
        }
      : {}),
  }
  await verify()
  await saveAccount(id, ended, fetcher)
  await writeRampOwed(id, 0, fetcher)
  const stored = await readSnapshotForWrite(id, fetcher)
  const facts = closingFacts(id, ended, stored.previous, "owner")
  return commitSnapshot(
    {
      ...facts,
      state: "ended",
      reason:
        ended.ownerRefunded &&
        ended.ownerRefunded.subscription === facts.subscription &&
        ended.ownerRefunded.periodStart === facts.periodStart
          ? "refunded"
          : "canceled",
    },
    stored,
    fetcher,
    now,
    verify,
  )
}

/** A successful HTTP response can still describe pending/failed money. Only settled refunds finish the operation. */
async function settleOwnerRefund(id: string, account: Account, verify: () => Promise<void>, fetcher: typeof fetch) {
  const operation = account.ownerEnd!
  const source = operation.charge!
  const charge = await modelPlanStripe(`charges/${encodeURIComponent(source)}`, {}, fetcher)
  if (
    !(await codiumChargeOwned(id, account.customer, source, fetcher, charge)) ||
    charge.paid !== true ||
    charge.currency !== "usd" ||
    !Number.isSafeInteger(charge.amount) ||
    !Number.isSafeInteger(charge.amount_refunded) ||
    Number(charge.amount) <= 0 ||
    Number(charge.amount_refunded) < 0 ||
    Number(charge.amount_refunded) > Number(charge.amount)
  )
    throw ownerOperationInvalid()
  const remaining = Number(charge.amount) - Number(charge.amount_refunded)
  if (remaining > operation.refundCents)
    throw new ApiError(409, "CODIUM_REFUND_CHANGED", "The saved payment amount changed. Refresh the owner page.")
  const attempt = operation.refundAttempt ?? 0
  const listed = await listStripe("refunds", [["charge", source]], {}, fetcher)
  if (!listed.complete) throw ownerOperationInvalid()
  const matching = listed.data.filter(
    (refund) =>
      stripeRecord(refund.metadata) &&
      refund.metadata.vector_owner_operation === operation.id &&
      String(refund.metadata.vector_owner_attempt) === String(attempt),
  )
  if (matching.length > 1) throw ownerOperationInvalid()
  let intent = operation.refund
  let refund = intent?.id ? await modelPlanStripe(`refunds/${encodeURIComponent(intent.id)}`, {}, fetcher) : matching[0]
  const persist = async (next: { amount: number; id?: string; status?: string }) => {
    const latest = await readModelPlanAccount(id, fetcher)
    if (!latest || latest.ownerEnd?.id !== operation.id || (latest.ownerEnd.refundAttempt ?? 0) !== attempt)
      throw ownerOperationInvalid()
    await verify()
    await saveAccount(id, { ...latest, ownerEnd: { ...latest.ownerEnd, refund: next } }, fetcher)
  }
  if (!refund && remaining > 0) {
    intent = intent ?? { amount: remaining }
    if (remaining < intent.amount)
      throw new ApiError(
        409,
        "CODIUM_REFUND_CHANGED",
        "Another refund changed the saved payment. Review it in Stripe before retrying.",
      )
    await persist(intent)
    await verify()
    refund = await modelPlanStripe(
      "refunds",
      {
        method: "POST",
        idempotency: `vector-owner-refund-${operation.id}-${attempt}`,
        body: new URLSearchParams({
          charge: source,
          amount: String(intent.amount),
          reason: "requested_by_customer",
          "metadata[vector_owner_operation]": operation.id,
          "metadata[vector_owner_attempt]": String(attempt),
        }),
      },
      fetcher,
    )
  }
  if (refund) {
    if (
      typeof refund.id !== "string" ||
      !/^re_[A-Za-z0-9]+$/.test(refund.id) ||
      stripeObjectId(refund.charge) !== source ||
      refund.currency !== "usd" ||
      !Number.isSafeInteger(refund.amount) ||
      Number(refund.amount) <= 0 ||
      Number(refund.amount) > operation.refundCents ||
      (intent && refund.amount !== intent.amount) ||
      !["succeeded", "pending", "requires_action", "failed", "canceled"].includes(String(refund.status))
    )
      throw ownerOperationInvalid()
    await persist({ amount: Number(refund.amount), id: refund.id, status: String(refund.status) })
    if (refund.status !== "succeeded")
      throw new ApiError(
        503,
        refund.status === "failed" || refund.status === "canceled" ? "CODIUM_REFUND_FAILED" : "CODIUM_REFUND_PENDING",
        refund.status === "failed" || refund.status === "canceled"
          ? "Stripe did not complete the refund. Review the payment before confirming another attempt."
          : "Stripe is still processing the refund. Access stays stopped while it settles.",
      )
  }
  const settled = await listStripe("refunds", [["charge", source]], {}, fetcher)
  const refreshed = await modelPlanStripe(`charges/${encodeURIComponent(source)}`, {}, fetcher)
  const returned = settled.data.reduce(
    (sum, value) =>
      sum +
      (stripeObjectId(value.charge) === source &&
      value.status === "succeeded" &&
      value.currency === "usd" &&
      Number.isSafeInteger(value.amount) &&
      Number(value.amount) > 0
        ? Number(value.amount)
        : 0),
    0,
  )
  if (
    !settled.complete ||
    !Number.isSafeInteger(returned) ||
    returned < Number(charge.amount) ||
    !Number.isSafeInteger(refreshed.amount_refunded) ||
    Number(refreshed.amount_refunded) < Number(charge.amount)
  )
    throw new ApiError(
      503,
      "CODIUM_REFUND_PENDING",
      "The full refund has not settled yet. Access stays stopped while it settles.",
    )
}
function ownerOperationInvalid() {
  return new ApiError(503, "CODIUM_OWNER_OPERATION_INVALID", "The saved owner operation could not be verified.")
}

/** Clearing a hold acknowledges exact terminal signals, never an open dispute or a replacement payment. */
export async function clearModelPlanRisk(id: string, fetcher: typeof fetch = fetch, now = Date.now()) {
  await withCodiumLease(
    id,
    async (verify) => {
      const account = await readModelPlanAccount(id, fetcher)
      if (!account || account.closing || (account.ownerEnd && !account.ownerEnd.done))
        throw new ApiError(409, "CODIUM_ACCOUNT_UNAVAILABLE", "This Codium account cannot be changed.")
      const charges = await listStripe("charges", [["customer", account.customer]], {}, fetcher)
      if (!charges.complete)
        throw new ApiError(503, "MODEL_PLAN_RISK_UNAVAILABLE", "Payment history could not be verified.")
      const acknowledged = [...(account.riskCleared?.disputes ?? [])]
      for (const charge of charges.data) {
        if (
          !validChargeId(charge.id) ||
          charge.disputed !== true ||
          !(await codiumChargeOwned(id, account.customer, charge.id, fetcher, charge))
        )
          continue
        const listed = await listStripe("disputes", [["charge", charge.id]], {}, fetcher)
        if (
          !listed.complete ||
          !listed.data.length ||
          listed.data.some(
            (dispute) =>
              dispute.charge !== charge.id ||
              typeof dispute.id !== "string" ||
              (!WON_DISPUTE.has(String(dispute.status)) && !LOST_DISPUTE.has(String(dispute.status))),
          )
        )
          throw new ApiError(409, "CODIUM_DISPUTE_OPEN", "Close the payment dispute before clearing this hold.")
        for (const dispute of listed.data)
          if (
            dispute.status === "lost" &&
            !acknowledged.some((entry) => entry.id === dispute.id && entry.charge === charge.id)
          )
            acknowledged.push({ id: String(dispute.id), charge: charge.id, status: "lost" })
      }
      // Also verify known open charges absent from an inconsistent charge listing; absence is not proof of a closed dispute.
      for (const charge of Object.keys(account.risk?.openDisputes ?? {})) {
        const outcome = await disputeOutcome(charge, fetcher, acknowledged)
        if (outcome.kind === "open")
          throw new ApiError(409, "CODIUM_DISPUTE_OPEN", "Close the payment dispute before clearing this hold.")
      }
      const updated = {
        ...account,
        riskCleared: {
          warnings: [
            ...new Set([...(account.riskCleared?.warnings ?? []), ...Object.keys(account.risk?.efwWarnings ?? {})]),
          ],
          disputes: acknowledged,
        },
        risk: { ...NO_RISK, paused: account.risk?.paused, pauseTokens: account.risk?.pauseTokens },
      }
      await verify()
      await saveAccountAndReconcile(id, updated, fetcher, now)
    },
    fetcher,
  )
  return reconcileModelPlanAccount(id, fetcher, now, { source: "owner" })
}

export async function cancelModelPlanAccount(id: string, fetcher: typeof fetch = fetch) {
  if (!process.env.STRIPE_SECRET_KEY?.trim()) {
    if (
      !process.env.KV_REST_API_URL?.trim() &&
      !process.env.UPSTASH_REDIS_REST_URL?.trim() &&
      process.env.MODEL_PLANS_ENABLED !== "true"
    )
      return
    if (await readModelPlanAccount(id, fetcher))
      throw new ApiError(503, "BILLING_UNAVAILABLE", "Model billing must be available before deleting this account.")
    return
  }
  await withAccountLease(
    id,
    async (verify) => {
      const account = await readModelPlanAccount(id, fetcher)
      if (!account) return
      // Persist closure before external cleanup so retries cannot open new
      // checkout sessions or re-enable a key while identity deletion proceeds.
      await verify()
      const closing = { ...account, closing: true }
      await saveAccount(id, closing, fetcher)
      // Every service reads the snapshot, so the account is ended/closing everywhere from here (contract §4.4).
      const stored = await readSnapshotForWrite(id, fetcher)
      await commitSnapshot(closingFacts(id, closing, stored.previous, "request"), stored, fetcher, Date.now(), verify)
      if (account.key)
        await openRouterManagement(`/${encodeURIComponent(account.key.hash)}`, { disabled: true }, fetcher, "PATCH")
      await verify()
      await writeRampOwed(id, 0, fetcher)
      const query = new URLSearchParams({ customer: account.customer, status: "open", limit: "100" })
      const pending = await modelPlanStripe(`checkout/sessions?${query}`, {}, fetcher)
      if (!Array.isArray(pending.data) || pending.has_more === true)
        throw new ApiError(503, "MODEL_PLAN_CLEANUP", "Pending checkout sessions could not be closed. Retry deletion.")
      for (const session of pending.data) {
        if (!stripeRecord(session) || typeof session.id !== "string")
          throw new ApiError(
            503,
            "MODEL_PLAN_CLEANUP",
            "Pending checkout sessions could not be closed. Retry deletion.",
          )
        await verify()
        await modelPlanStripe(
          `checkout/sessions/${encodeURIComponent(session.id)}/expire`,
          { method: "POST", idempotency: `vector-expire-${session.id}` },
          fetcher,
        )
      }
      for (const subscription of await subscriptions(account.customer, fetcher)) {
        if (["canceled", "incomplete_expired"].includes(String(subscription.status))) continue
        await verify()
        await modelPlanStripe(
          `subscriptions/${encodeURIComponent(String(subscription.id))}`,
          { method: "DELETE" },
          fetcher,
        )
      }
    },
    fetcher,
  )
}

/** A short, fixed-length digest for idempotency keys, so they stay well under Stripe's 255 characters. */
function digest(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 32)
}
