import { Button } from "@vectordevai/ui/button"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { CodiumPlan } from "@vectordevai/schema/codium-plan"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { usePlatform } from "@/context/platform"
import { newestRead, onCodiumChange } from "@/vector-account"
import { CodiumBillingStatus, createCodiumBilling, useCodiumPurchase } from "./codium-purchase"

/** Vector Codium plan and usage. The desktop main process reads them, so the account token never reaches here. */
export function SettingsVectorCodium() {
  const platform = usePlatform()
  const [status, setStatus] = createSignal<ModelPlanStatus.Status>()
  const [busy, setBusy] = createSignal(false)
  // Reads overlap after a purchase or an account change; an older answer never replaces a newer one, and every
  // announcement starts its own read rather than waiting on one that may predate the change.
  const statusRead = newestRead()
  const refresh = async () => {
    const account = platform.vectorAccount
    if (!account?.codium) return
    const newest = statusRead()
    setBusy(true)
    const next = await account.codium().catch(() => ({
      signedIn: true,
      enabled: false,
      access: false,
      purchased: { bought: false },
      empty: false,
      low: false,
      error: "Vector could not load your Codium usage. Try again shortly.",
    }))
    if (!newest()) return
    setStatus(next)
    setBusy(false)
  }
  const billing = createCodiumBilling()
  const purchase = useCodiumPurchase()
  onMount(() => {
    const account = platform.vectorAccount
    if (!account?.codium) return
    // Signing in or out changes whose plan this shows.
    onCleanup(account.onChange(() => void refresh()))
    // A billing request, and a purchase's later reads, say the plan may have changed.
    onCleanup(onCodiumChange(() => void refresh()))
    void refresh()
  })
  const plan = () => status()?.plan
  return (
    <Show when={platform.vectorAccount?.codium}>
      <section
        class="settings-form-section flex flex-col gap-3"
        aria-labelledby="vector-codium-title"
        data-component="vector-codium"
      >
        <div>
          <h3 id="vector-codium-title" class="text-14-medium text-text-strong">
            Vector Codium
          </h3>
          <p class="text-12-regular text-text-weak mt-1">
            Coding models included in your Vector Codium plan, available whenever you are signed in to Vector. Usage
            shows as a share of this month. Vector itself stays free.
          </p>
        </div>
        <Show when={status()}>
          {(current) => (
            <>
              <Show when={current().error}>
                <p role="alert" class="text-12-regular text-text-danger-base">
                  {current().error}
                </p>
              </Show>
              <Show when={!current().signedIn && !current().error}>
                <p class="text-12-regular">Sign in to Vector to see your Codium plan and use Codium models.</p>
              </Show>
              <Show when={current().signedIn && !current().error}>
                <dl data-slot="codium-balance">
                  <div>
                    <dt>Plan</dt>
                    <dd>{plan()?.name ?? CodiumPlan.FREE}</dd>
                  </div>
                  <Show when={plan()}>
                    {(active) => (
                      <>
                        <div>
                          <dt>This month</dt>
                          <dd>
                            {active().left === undefined
                              ? "Usage unavailable"
                              : `${ModelPlanStatus.formatShare(active().left!)} left this month`}
                          </dd>
                        </div>
                        <div>
                          <dt>{active().cancelAtPeriodEnd ? "Ends" : "Renews"}</dt>
                          <dd>{ModelPlanStatus.formatDate(active().renewsAt)}</dd>
                        </div>
                      </>
                    )}
                  </Show>
                </dl>
                <Show when={ModelPlanStatus.notice(current())}>
                  {(notice) => (
                    <p
                      role={notice().kind === "empty" ? "alert" : "status"}
                      class="text-12-regular"
                      data-slot={`codium-${notice().kind}`}
                    >
                      {notice().text}
                    </p>
                  )}
                </Show>
              </Show>
            </>
          )}
        </Show>
        <div class="flex flex-wrap gap-2">
          {/* In the desktop the plans open in Vector, where each reads Coming soon until Codium is on sale. */}
          <Show when={status()?.signedIn && (platform.vectorAccount?.billing || status()?.enabled)}>
            <Button
              onClick={() =>
                platform.vectorAccount?.billing ? purchase() : platform.openLink(ModelPlanStatus.PURCHASE_URL)
              }
            >
              {plan() ? "Change plan" : "See plans"}
            </Button>
          </Show>
          <Show when={plan() || status()?.customer}>
            <Button variant="secondary" disabled={billing.busy()} onClick={() => void billing.run({ kind: "portal" })}>
              Manage billing and invoices
            </Button>
          </Show>
          <Show when={status()?.signedIn}>
            <Button variant="secondary" disabled={busy()} onClick={() => void refresh()}>
              Refresh
            </Button>
          </Show>
        </div>
        <CodiumBillingStatus billing={billing} />
      </section>
    </Show>
  )
}
