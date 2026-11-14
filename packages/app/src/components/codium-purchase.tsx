import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { useDialog } from "@vectordevai/ui/context/dialog"
import { ButtonV2 } from "@vectordevai/ui/v2/button-v2"
import { DialogBody, DialogHeader, DialogTitleGroup, DialogV2 } from "@vectordevai/ui/v2/dialog-v2"
import { For, Match, Show, Switch, createSignal, onCleanup, onMount } from "solid-js"
import { usePlatform } from "@/context/platform"
import { codiumChanged, newestRead, onCodiumChange, runBilling, type VectorBillingRequest } from "@/vector-account"
import {
  billingNotice,
  billingProgress,
  offerAction,
  offerPrice,
  planUnknown,
  type BillingNotice,
} from "./codium-billing"
import "./codium-purchase.css"

/**
 * Runs one billing request in the desktop's billing window, or a plan change it answers without one, and says how it
 * went. Without the desktop bridge, as in the web build, it opens vectordev.ai instead: the plans page for a checkout,
 * the account page for everything else. Every screen showing the plan reads it again on codiumChanged(), once the
 * request is done and, after a finished purchase or card update, on a schedule that outlives this page (runBilling).
 */
export function createCodiumBilling() {
  const platform = usePlatform()
  // The request whose billing window is open.
  const [active, setActive] = createSignal<VectorBillingRequest>()
  const busy = () => active() !== undefined
  const [notice, setNotice] = createSignal<BillingNotice>()
  const life = { alive: true }
  onCleanup(() => {
    life.alive = false
  })
  // `paying`: the portal is opened to confirm a payment, so closing it starts the later reads too (runBilling).
  const run = async (request: VectorBillingRequest, options: { paying?: boolean } = {}) => {
    const account = platform.vectorAccount
    if (busy()) return
    if (!account?.billing) {
      platform.openLink(request.kind === "checkout" ? ModelPlanStatus.PURCHASE_URL : ModelPlanStatus.MANAGE_URL)
      return
    }
    setActive(request)
    setNotice(undefined)
    const result = await runBilling(account, request, options)
    if (!life.alive) return
    setActive(undefined)
    setNotice(billingNotice(request, result))
    codiumChanged()
  }
  return { active, busy, notice, run }
}

export type CodiumBilling = ReturnType<typeof createCodiumBilling>

/**
 * The Codium monthly plans, each with its name and public price and never what it buys, so no screen can reveal the
 * markup. Without a plan, one opens checkout in Vector's billing window; a subscriber upgrades now or switches at
 * renewal. While Codium is not on sale, every button reads "Coming soon" and nothing can be bought. `status` is the
 * account's Codium status as last read: until a read has answered, no offer has a button (planUnknown).
 */
export function CodiumPurchase(props: { status?: ModelPlanStatus.Status; billing: CodiumBilling }) {
  const platform = usePlatform()
  // Undefined while loading; null when vectordev.ai could not be read.
  const [offers, setOffers] = createSignal<ModelPlanStatus.Offers | null>()
  onMount(() => {
    const read = platform.vectorAccount?.offers
    if (!read) return setOffers(null)
    void read()
      .then((value) => setOffers(value ?? null))
      .catch(() => setOffers(null))
  })
  const row = (offer: ModelPlanStatus.Offer) => {
    // The account's plan can change while the list is open, after an upgrade for one.
    const action = () => (planUnknown(props.status) ? undefined : offerAction(offer, props.status?.plan))
    return (
      <li class="codium-purchase-offer" data-offer={offer.id}>
        <div>
          <span class="codium-purchase-name">{offer.name}</span>
          <span class="codium-purchase-price">{offerPrice(offer)}</span>
          <Show when={action()?.detail}>{(detail) => <span class="codium-purchase-detail">{detail()}</span>}</Show>
        </div>
        <Show when={action()}>
          {(current) => (
            <Show when={!current().current} fallback={<span class="codium-purchase-current">{current().label}</span>}>
              <ButtonV2
                variant="outline"
                disabled={!current().request || props.billing.busy()}
                aria-label={`${current().label}, ${offer.name}`}
                onClick={() => {
                  const request = current().request
                  if (request) void props.billing.run(request)
                }}
              >
                {current().label}
              </ButtonV2>
            </Show>
          )}
        </Show>
      </li>
    )
  }
  return (
    <div class="codium-purchase" data-component="codium-purchase">
      <Switch>
        <Match when={offers() === undefined}>
          <p role="status" class="codium-purchase-muted">
            Loading Codium plans…
          </p>
        </Match>
        <Match when={offers() === null}>
          <p role="alert" class="codium-purchase-error">
            Vector could not load the Codium plans. Try again shortly.
          </p>
        </Match>
        <Match when={offers()}>
          {(current) => (
            <>
              <Show when={!current().enabled}>
                <p class="codium-purchase-muted">Nothing can be bought until Vector Codium goes on sale.</p>
              </Show>
              <section class="codium-purchase-group" aria-labelledby="codium-purchase-plans">
                <div class="codium-purchase-head">
                  <h4 id="codium-purchase-plans">Monthly plans</h4>
                  <p>Each plan renews every month. Usage shows as a share of the month.</p>
                </div>
                <ul>
                  <For each={current().plans}>{(offer) => row(offer)}</For>
                </ul>
                <Show when={planUnknown(props.status)}>
                  {(unknown) => (
                    <p
                      role={unknown().kind === "error" ? "alert" : "status"}
                      class="codium-purchase-notice"
                      data-kind={unknown().kind}
                    >
                      {unknown().text}
                    </p>
                  )}
                </Show>
                <Show when={props.status?.plan?.scheduled}>
                  <p class="codium-purchase-muted">
                    A smaller plan is already scheduled. Keep your plan first to choose another change.
                  </p>
                </Show>
              </section>
            </>
          )}
        </Match>
      </Switch>
    </div>
  )
}

/**
 * The billing window's progress and how it ended, for a page or dialog that runs billing. `plan` is the account's plan
 * id, which tells an upgrade (paid in Stripe's checkout) from a smaller plan saved without a window.
 */
export function CodiumBillingStatus(props: { billing: CodiumBilling; plan?: string }) {
  return (
    <>
      <Show when={props.billing.active()}>
        {(request) => (
          <p role="status" class="codium-purchase-muted">
            {billingProgress(request(), props.plan)}
          </p>
        )}
      </Show>
      <Show when={props.billing.notice()}>
        {(notice) => (
          <p
            role={notice().kind === "error" ? "alert" : "status"}
            class="codium-purchase-notice"
            data-kind={notice().kind}
          >
            {notice().text}
          </p>
        )}
      </Show>
    </>
  )
}

/**
 * The Codium plans from anywhere in the app, such as a Codium turn that needs a plan or a model the plan does not
 * include, without opening Settings. A smaller plan already scheduled shows here with Keep my plan, as on Settings >
 * Account, since every other change waits for it.
 */
export function DialogCodiumPurchase() {
  const platform = usePlatform()
  const [status, setStatus] = createSignal<ModelPlanStatus.Status>()
  // A purchase's reads overlap; an older answer never replaces a newer one.
  const statusRead = newestRead()
  const refresh = async () => {
    const read = platform.vectorAccount?.codium
    if (!read) return
    const newest = statusRead()
    // A read that throws says so, as the desktop's own failed read does, instead of reading forever.
    const next = await read().catch(() => ({
      signedIn: true,
      enabled: false,
      access: false,
      purchased: { bought: false },
      empty: false,
      low: false,
      error: "Vector could not load your Codium plan. Try again shortly.",
    }))
    if (newest()) setStatus(next)
  }
  const billing = createCodiumBilling()
  onMount(() => {
    onCleanup(onCodiumChange(() => void refresh()))
    void refresh()
  })
  return (
    <DialogV2 fit class="codium-purchase-dialog">
      <DialogHeader>
        <DialogTitleGroup
          title="Vector Codium plans"
          description="Monthly plans, in US dollars. A bigger plan starts today; a smaller one at renewal."
        />
      </DialogHeader>
      <DialogBody>
        <Show when={status()?.plan?.scheduled}>
          {(scheduled) => (
            <div class="codium-purchase-scheduled" data-component="codium-purchase-scheduled">
              <p role="status">
                Switches to {scheduled().name} on {ModelPlanStatus.formatDate(scheduled().at)}.
              </p>
              <ButtonV2 variant="outline" disabled={billing.busy()} onClick={() => void billing.run({ kind: "keep" })}>
                Keep my plan
              </ButtonV2>
            </div>
          )}
        </Show>
        <CodiumPurchase status={status()} billing={billing} />
        <CodiumBillingStatus billing={billing} plan={status()?.plan?.id} />
      </DialogBody>
    </DialogV2>
  )
}

/**
 * Opens the Codium plans: Vector's own dialog where the desktop can bill, else the account page on vectordev.ai, since
 * the web build has no plans to show.
 */
export function useCodiumPurchase() {
  const dialog = useDialog()
  const platform = usePlatform()
  return () =>
    platform.vectorAccount?.billing
      ? dialog.show(() => <DialogCodiumPurchase />)
      : platform.openLink(ModelPlanStatus.MANAGE_URL)
}
