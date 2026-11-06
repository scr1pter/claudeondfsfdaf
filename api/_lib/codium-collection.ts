import { randomUUID } from "node:crypto"
import { Option, Schema } from "effect"
import { codiumKey } from "./codium-keys.js"
import { enqueueAction, registerAction } from "./codium-provision.js"
import { readSwitchState, writeSwitch } from "./codium-switches.js"
import { ApiError } from "./http.js"
import {
  listSubscriptions,
  planStanding,
  readModelPlanAccount,
  riskState,
  withCodiumLease,
} from "./model-plan-account.js"
import { modelPlansEnabled } from "./model-plan-config.js"
import { modelPlanStripe, stripeRecord } from "./model-plan-stripe.js"
import { persistentStore } from "./persistent-store.js"

const OwnedPause = Schema.Struct({ token: Schema.String, invoices: Schema.Array(Schema.String) })
const Collection = Schema.Record(Schema.String, OwnedPause)
type Collection = Record<string, { token: string; invoices: readonly string[] }>
const collectionKey = (account: string) => codiumKey("collection", account)
const completedKey = () => codiumKey("collection", "generation")
const INDEX = () => codiumKey("idx", "period-end")
const INVOICE = /^in_[A-Za-z0-9]+$/

export function collectionPauseMinutes() {
  const value = Number(process.env.CODIUM_CODIUM_OFF_PAUSE_MINUTES?.trim() || "60")
  if (!Number.isSafeInteger(value) || value < 1 || value > 1440)
    throw new ApiError(503, "CODIUM_SWITCH_UNAVAILABLE", "A Vector Codium setting could not be read.")
  return value
}

/** The minute cron schedules each switch generation once; the handler always re-reads current state. */
export async function queueCollectionSweep(fetcher: typeof fetch = fetch, now = Date.now()) {
  let state = await readSwitchState("codium", fetcher, { fresh: true, now })
  // Bare pre-A11 switches have no reliable off timestamp. Start their clock when first observed, atomically.
  if (state.value === "off" && state.offSince === undefined)
    state = await writeSwitch("codium", "off", "system", fetcher, now)
  if ((await persistentStore(["GET", completedKey()], fetcher)) === state.generation) return false
  await enqueueAction(
    "pause-collection",
    `sweep:${state.generation}`,
    { sweep: true, cursor: "0", generation: state.generation },
    state.value === "off" ? (state.offSince ?? now) + collectionPauseMinutes() * 60_000 : now,
    fetcher,
    now,
  )
  return true
}

/** Callers own the billing lease. Persist intents before Stripe, and retain them until the exact renewal is queued. */
export async function syncCodiumCollection(
  id: string,
  account: NonNullable<Awaited<ReturnType<typeof readModelPlanAccount>>>,
  subscriptions: readonly Record<string, unknown>[],
  verify: () => Promise<void>,
  fetcher: typeof fetch,
  now: number,
) {
  const state = await readSwitchState("codium", fetcher, { fresh: true, now })
  const raw = await persistentStore(["GET", collectionKey(id)], fetcher)
  const stored =
    raw === null
      ? {}
      : Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(Collection))(String(raw)))
  if (!stored) throw unavailable()
  const owned: Collection = { ...stored }
  const off = state.value === "off"
  const due = off && state.offSince !== undefined && now >= state.offSince + collectionPauseMinutes() * 60_000
  const legacy = subscriptions.some((subscription) => legacyPause(subscription))
  if (!Object.keys(owned).length && !due && !legacy) return
  // Risk reconciliation may just have changed collection; use current provider state before taking ownership.
  const listed = await listSubscriptions(account.customer, fetcher)
  const governing = planStanding(id, account, listed, now).governing?.id
  for (const subscription of listed) {
    if (
      typeof subscription.id !== "string" ||
      !stripeRecord(subscription.metadata) ||
      subscription.metadata.vector_account_id !== id
    )
      continue
    const sub = subscription.id
    const pause = stripeRecord(subscription.pause_collection) ? subscription.pause_collection : undefined
    const tagged =
      pause?.behavior === "void" &&
      !pause.resumes_at &&
      subscription.metadata.vector_codium_pause === id &&
      subscription.metadata.vector_codium_pause_token === owned[sub]?.token
    const inherited = legacyPause(subscription)
    const riskPause = pause?.behavior === "void" && !pause.resumes_at && subscription.metadata.vector_risk_pause === id
    if (subscription.status === "canceled") {
      if (owned[sub]) {
        delete owned[sub]
        await save(id, owned, verify, fetcher)
      }
      continue
    }
    // A changed owner pause conclusively ends Vector's previous intent; a future cycle gets a fresh token.
    if (riskPause) continue
    if (subscription.pause_collection && !tagged && !inherited) {
      if (owned[sub]) {
        delete owned[sub]
        await save(id, owned, verify, fetcher)
      }
      continue
    }
    if (governing !== sub) continue
    if (due && modelPlansEnabled() && !riskState(account)) {
      const invoices = collectableInvoice(subscription)
      // Freshly observed unpaused collection cannot reuse a successful pause someone deliberately undid.
      const intent = {
        token: tagged ? owned[sub]!.token : randomUUID(),
        invoices: [...new Set([...(owned[sub]?.invoices ?? []), ...invoices])],
      }
      owned[sub] = intent
      await save(id, owned, verify, fetcher)
      if (!tagged) {
        await verify()
        if (!(await currentGeneration(state.generation, true, fetcher, now))) return
        await modelPlanStripe(
          `subscriptions/${encodeURIComponent(sub)}`,
          {
            method: "POST",
            idempotency: `vector-codium-pause-${intent.token}`,
            body: new URLSearchParams({
              "pause_collection[behavior]": "void",
              "metadata[vector_paused_for]": "codium-off",
              "metadata[vector_codium_pause]": id,
              "metadata[vector_codium_pause_token]": intent.token,
            }),
          },
          fetcher,
        )
      }
      for (const invoice of intent.invoices)
        await holdInvoice(invoice, sub, account.customer, intent.token, verify, fetcher)
      continue
    }
    // Another hold keeps the existing pause. Env-off also never authorizes automatic resumption.
    if (off || !modelPlansEnabled() || account.closing || riskState(account)) continue
    if (!tagged && !inherited && !owned[sub]) continue
    const intent = {
      token: owned[sub]?.token ?? randomUUID(),
      invoices: [...new Set([...(owned[sub]?.invoices ?? []), ...collectableInvoice(subscription)])],
    }
    owned[sub] = intent
    await save(id, owned, verify, fetcher)
    if (tagged || inherited) {
      await verify()
      if (!(await currentGeneration(state.generation, false, fetcher, now))) return
      await modelPlanStripe(
        `subscriptions/${encodeURIComponent(sub)}`,
        {
          method: "POST",
          idempotency: `vector-codium-resume-${intent.token}`,
          body: new URLSearchParams({
            pause_collection: "",
            "metadata[vector_paused_for]": "",
            "metadata[vector_codium_pause]": "",
            "metadata[vector_codium_pause_token]": "",
          }),
        },
        fetcher,
      )
    }
    // If a response or the lease was lost after resume, the saved exact invoices still get queued on retry.
    for (const invoice of intent.invoices) {
      const current = await ownedInvoice(invoice, sub, account.customer, fetcher)
      if (!current || !collectable(current)) continue
      await verify()
      await enqueueAction("finalize-renewal", invoice, { customer: account.customer }, undefined, fetcher, now)
    }
    delete owned[sub]
    await save(id, owned, verify, fetcher)
  }
}

/** A renewal guard holds this invoice before a risk/service pause can be lifted or its provider response lost. */
export async function rememberCollectionInvoice(
  account: string,
  subscription: string,
  invoice: string,
  verify: () => Promise<void>,
  fetcher: typeof fetch,
) {
  if (!INVOICE.test(invoice)) throw unavailable()
  const raw = await persistentStore(["GET", collectionKey(account)], fetcher)
  const stored =
    raw === null
      ? {}
      : Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(Collection))(String(raw)))
  if (!stored) throw unavailable()
  const before = stored[subscription]
  await save(
    account,
    {
      ...stored,
      [subscription]: {
        token: before?.token ?? randomUUID(),
        invoices: [...new Set([...(before?.invoices ?? []), invoice])],
      },
    },
    verify,
    fetcher,
  )
}

registerAction("pause-collection", async (action, fetcher) => {
  if (!stripeRecord(action.payload)) throw unavailable()
  if (action.payload.sweep === true) {
    const payload = action.payload
    if (typeof payload.cursor !== "string" || !/^\d+$/.test(payload.cursor) || typeof payload.generation !== "string")
      throw unavailable()
    const state = await readSwitchState("codium", fetcher, { fresh: true, now: action.now })
    if (state.generation !== payload.generation) {
      await queueCollectionSweep(fetcher, action.now)
      return
    }
    if (
      state.value === "off" &&
      (state.offSince === undefined || action.now < state.offSince + collectionPauseMinutes() * 60_000)
    ) {
      await queueCollectionSweep(fetcher, action.now)
      throw new ApiError(503, "CODIUM_COLLECTION_NOT_DUE", "Collection is not due to pause yet.")
    }
    const result = await persistentStore(["ZSCAN", INDEX(), payload.cursor, "COUNT", 100], fetcher)
    if (
      !Array.isArray(result) ||
      result.length !== 2 ||
      !/^\d+$/.test(String(result[0])) ||
      !Array.isArray(result[1]) ||
      result[1].length % 2
    )
      throw unavailable()
    const entries: unknown[] = result[1]
    for (let index = 0; index < entries.length; index += 2) {
      const account = entries[index]
      if (typeof account !== "string" || !account) throw unavailable()
      await enqueueAction("pause-collection", `account:${account}`, { account }, undefined, fetcher, action.now)
    }
    if (String(result[0]) !== "0")
      await enqueueAction(
        "pause-collection",
        `sweep:${state.generation}:${result[0]}`,
        { sweep: true, cursor: String(result[0]), generation: state.generation },
        undefined,
        fetcher,
        action.now,
      )
    else await persistentStore(["SET", completedKey(), state.generation], fetcher)
    return
  }
  const id = action.payload.account
  if (typeof id !== "string") throw unavailable()
  await withCodiumLease(
    id,
    async (verify) => {
      const account = await readModelPlanAccount(id, fetcher)
      if (!account) return
      await syncCodiumCollection(
        id,
        account,
        await listSubscriptions(account.customer, fetcher),
        verify,
        fetcher,
        action.now,
      )
    },
    fetcher,
  )
})

async function currentGeneration(generation: string, pausing: boolean, fetcher: typeof fetch, now: number) {
  const state = await readSwitchState("codium", fetcher, { fresh: true, now })
  return (
    state.generation === generation &&
    (pausing
      ? state.value === "off" &&
        state.offSince !== undefined &&
        now >= state.offSince + collectionPauseMinutes() * 60_000
      : state.value === "on")
  )
}

function legacyPause(subscription: Record<string, unknown>) {
  if (
    !stripeRecord(subscription.pause_collection) ||
    subscription.pause_collection.behavior !== "void" ||
    subscription.pause_collection.resumes_at ||
    !stripeRecord(subscription.metadata)
  )
    return false
  return (
    ["codium-off", "frozen"].includes(String(subscription.metadata.vector_paused_for)) &&
    !subscription.metadata.vector_codium_pause &&
    !subscription.metadata.vector_risk_pause
  )
}
function collectable(value: Record<string, unknown>) {
  return value.status === "draft" || (value.status === "open" && Number(value.attempt_count ?? 0) === 0)
}
function collectableInvoice(subscription: Record<string, unknown>) {
  const invoice = stripeRecord(subscription.latest_invoice) ? subscription.latest_invoice : undefined
  return invoice &&
    typeof invoice.id === "string" &&
    INVOICE.test(invoice.id) &&
    invoice.billing_reason === "subscription_cycle" &&
    collectable(invoice)
    ? [invoice.id]
    : []
}
async function ownedInvoice(id: string, subscription: string, customer: string, fetcher: typeof fetch) {
  if (!INVOICE.test(id)) throw unavailable()
  const invoice = await modelPlanStripe(`invoices/${encodeURIComponent(id)}`, {}, fetcher)
  const sub =
    typeof invoice.subscription === "string"
      ? invoice.subscription
      : stripeRecord(invoice.subscription)
        ? invoice.subscription.id
        : undefined
  if (
    invoice.id !== id ||
    invoice.customer !== customer ||
    sub !== subscription ||
    invoice.billing_reason !== "subscription_cycle"
  )
    throw unavailable()
  return invoice
}
async function holdInvoice(
  id: string,
  sub: string,
  customer: string,
  token: string,
  verify: () => Promise<void>,
  fetcher: typeof fetch,
) {
  const invoice = await ownedInvoice(id, sub, customer, fetcher)
  if (!collectable(invoice) || invoice.auto_advance === false) return
  await verify()
  await modelPlanStripe(
    `invoices/${encodeURIComponent(id)}`,
    {
      method: "POST",
      idempotency: `vector-codium-hold-${token}-${id}`,
      body: new URLSearchParams({ auto_advance: "false" }),
    },
    fetcher,
  )
}
async function save(id: string, value: Collection, verify: () => Promise<void>, fetcher: typeof fetch) {
  await verify()
  await persistentStore(["SET", collectionKey(id), JSON.stringify(value)], fetcher)
}
function unavailable() {
  return new ApiError(503, "CODIUM_COLLECTION_UNAVAILABLE", "Codium collection could not be verified.")
}
