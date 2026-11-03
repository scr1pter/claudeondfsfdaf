import { Button } from "@vectordevai/ui/button"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { CodiumPlan } from "@vectordevai/schema/codium-plan"
import { createEffect, For, onCleanup, onMount, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { codiumChanged, newestRead, onCodiumChange, onCodiumTurnEnd } from "@/vector-account"
import { CodiumBillingStatus, createCodiumBilling, useCodiumPurchase } from "./codium-purchase"
import {
  codiumUsageRows,
  createUsageRefresh,
  renewalCard,
  usageForecast,
  usageFreshness,
  usageHistoryStrip,
  usageShare,
} from "./settings-v2/codium-usage-model"
import type { DisplayUsageSummary } from "@/utils/usage-summary"

// Reopening Settings does not repeat a notification for this account and billing period.
import "./settings-v2/settings-account.css"

const alertedPeriods = new Set<string>()

/**
 * Plan status is read by the desktop main process; account tokens never reach this component. `summary` is this
 * computer's local usage, for the renewal card's counts.
 */
export function SettingsVectorCodium(props: { summary?: DisplayUsageSummary }) {
  const platform = usePlatform()
  const settings = useSettings()
  const [state, setState] = createStore<{
    status?: ModelPlanStatus.Status
    busy: boolean
    updatedAt?: number
    now: number
    identity?: string
  }>({ busy: false, now: Date.now() })
  const statusRead = newestRead()
  const refresh = async () => {
    const account = platform.vectorAccount
    if (!account?.codium) return
    const newest = statusRead()
    updates.read()
    setState("busy", true)
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
    setState("status", reconcile(next))
    setState("busy", false)
    if (!next.error) setState({ updatedAt: Date.now(), now: Date.now() })
  }
  const updates = createUsageRefresh(codiumChanged)
  const billing = createCodiumBilling()
  const purchase = useCodiumPurchase()
  const plan = () => state.status?.plan
  const notice = () => state.status && ModelPlanStatus.notice(state.status)
  createEffect(() => {
    const status = state.status
    const share = usageShare(status?.plan?.left)
    if (
      !settings.codium.alert80() ||
      !state.identity ||
      !status?.signedIn ||
      status.error ||
      !status.plan ||
      !share ||
      (status.plan.left ?? 1) > 0.2
    )
      return
    const key = `${state.identity}:${status.plan.id}:${status.plan.renewsAt}`
    if (alertedPeriods.has(key)) return
    alertedPeriods.add(key)
    void platform
      .notify(
        "Vector Codium usage",
        "You've used at least 80% of this month's Codium usage. Check your plan in Settings → Usage.",
        undefined,
        { force: true },
      )
      .catch(() => alertedPeriods.delete(key))
  })
  onMount(() => {
    const account = platform.vectorAccount
    if (!account?.codium) return
    const identityRead = newestRead()
    const identity = identityRead()
    void account
      .status()
      .then((next) => {
        if (identity()) setState("identity", next.authenticated ? next.email : undefined)
      })
      .catch(() => undefined)
    onCleanup(
      account.onChange((next) => {
        identityRead()
        setState({ status: undefined, updatedAt: undefined, identity: next.authenticated ? next.email : undefined })
        void refresh()
      }),
    )
    onCleanup(onCodiumChange(() => void refresh()))
    onCleanup(onCodiumTurnEnd(updates.turn))
    window.addEventListener("focus", updates.focus)
    const freshness = setInterval(() => setState("now", Date.now()), 60_000)
    onCleanup(() => {
      statusRead()
      identityRead()
      updates.dispose()
      clearInterval(freshness)
      window.removeEventListener("focus", updates.focus)
    })
    void refresh()
  })
  return (
    <Show when={platform.vectorAccount?.codium}>
      <section
        class="settings-form-section flex flex-col gap-3"
        aria-labelledby="vector-codium-title"
        data-component="vector-codium"
        aria-busy={state.busy}
      >
        <div>
          <h3 id="vector-codium-title" class="text-14-medium text-text-strong">
            Vector Codium
          </h3>
          <p class="text-12-regular text-text-weak mt-1">
            Coding models included in your Vector Codium plan. Vector itself stays free.
          </p>
        </div>
        <Show when={state.status} fallback={<p role="status">Loading Codium usage…</p>}>
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
                <dl data-slot="codium-balance" class="flex flex-col gap-3">
                  <div>
                    <dt>Plan</dt>
                    <dd>{plan()?.name ?? CodiumPlan.FREE}</dd>
                  </div>
                  <Show when={plan()}>
                    {(active) => (
                      <div>
                        <dt>{active().cancelAtPeriodEnd ? "Ends" : "Renews"}</dt>
                        <dd>{ModelPlanStatus.formatDate(active().renewsAt)}</dd>
                      </div>
                    )}
                  </Show>
                  <For each={codiumUsageRows(current())}>
                    {(row) => (
                      <div>
                        <dt>{row.label}</dt>
                        <dd>
                          <Show when={row.share} fallback="Usage unavailable">
                            {(share) => (
                              <>
                                <span
                                  class="settings-account-meter"
                                  role="meter"
                                  aria-label={`${row.label} usage left`}
                                  aria-valuemin="0"
                                  aria-valuemax="100"
                                  aria-valuenow={share().left}
                                  data-tone={
                                    row.label === "This month" && notice()
                                      ? notice()!.kind
                                      : share().left === 0
                                        ? "empty"
                                        : share().left < 10
                                          ? "low"
                                          : "ok"
                                  }
                                >
                                  <span style={{ width: `${share().left}%` }} />
                                </span>
                                <span>{share().text}</span>
                              </>
                            )}
                          </Show>
                          <Show when={row.detail}>
                            <span class="block text-12-regular text-text-weak">{row.detail}</span>
                          </Show>
                        </dd>
                      </div>
                    )}
                  </For>
                </dl>
                <Show when={current().velocity === "coming"}>
                  <p class="text-12-regular">Vector Velocity: Coming. Max and Ultra get access when it launches.</p>
                </Show>
                <Show when={usageHistoryStrip(current(), state.now)}>
                  {(strip) => (
                    <figure class="settings-codium-history" data-slot="codium-history">
                      <ol class="settings-codium-strip" aria-label="Codium usage by day, last 31 days">
                        <For each={strip().days}>
                          {(day) => (
                            <li
                              data-period={day.period ? "current" : "before"}
                              data-today={day.today ? "" : undefined}
                              aria-label={day.label}
                              title={day.label}
                            >
                              <span style={{ height: `${day.height}%` }} />
                            </li>
                          )}
                        </For>
                      </ol>
                      <figcaption class="text-12-regular text-text-weak">{strip().caption}</figcaption>
                    </figure>
                  )}
                </Show>
                <Show when={usageForecast(current())}>
                  {(forecast) => (
                    <p class="text-12-regular" data-slot="codium-forecast">
                      {forecast()}
                    </p>
                  )}
                </Show>
                <Show when={renewalCard(current(), props.summary)}>
                  {(card) => (
                    <section class="settings-codium-renewal" data-slot="codium-renewal" aria-label={card().title}>
                      <h4 class="text-12-medium text-text-strong">{card().title}</h4>
                      <dl>
                        <For each={card().rows}>
                          {(row) => (
                            <div>
                              <dt>{row.label}</dt>
                              <dd>{row.value}</dd>
                            </div>
                          )}
                        </For>
                      </dl>
                      <p class="text-12-regular text-text-weak">{card().note}</p>
                    </section>
                  )}
                </Show>
                <Show when={notice()}>
                  {(currentNotice) => (
                    <p
                      role={currentNotice().kind === "empty" ? "alert" : "status"}
                      class="text-12-regular"
                      data-slot={`codium-${currentNotice().kind}`}
                    >
                      {currentNotice().text}
                    </p>
                  )}
                </Show>
                <Show when={current().empty && plan()}>
                  <p class="text-12-regular">
                    Keep working with your own keys or a free model. An upgrade keeps your leftover usage.
                  </p>
                </Show>
                <Show when={plan()?.today?.reached}>
                  <p role="status" class="text-12-regular">
                    Today's Codium usage is used up. Your daily usage resets at the time shown above; your own keys and
                    free models are still available.
                  </p>
                </Show>
                <Show when={plan()}>
                  <label class="text-12-regular flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={settings.codium.alert80()}
                      onChange={(event) => settings.codium.setAlert80(event.currentTarget.checked)}
                    />
                    Notify me when 80% of this month's usage is used
                  </label>
                  <p class="text-12-regular text-text-weak">
                    Rounded to the nearest whole percent, so a small request may not change it. Work on Codium models
                    shows as Codium elsewhere in Vector; Vector never shows Codium tokens or dollars.
                  </p>
                </Show>
              </Show>
            </>
          )}
        </Show>
        <div class="flex flex-wrap gap-2">
          <Show when={state.status?.signedIn && (platform.vectorAccount?.billing || state.status?.enabled)}>
            <Button
              onClick={() =>
                platform.vectorAccount?.billing ? purchase() : platform.openLink(ModelPlanStatus.PURCHASE_URL)
              }
            >
              {plan() ? "Change plan" : "See plans"}
            </Button>
          </Show>
          <Show when={plan()?.action === "update-card" || plan()?.action === "confirm-payment"}>
            <Button
              variant="secondary"
              disabled={billing.busy()}
              onClick={() =>
                void billing.run(
                  {
                    kind: "portal",
                    ...(plan()?.action === "update-card" ? { flow: "payment_method_update" as const } : {}),
                  },
                  { paying: plan()?.action === "confirm-payment" },
                )
              }
            >
              {plan()?.action === "confirm-payment" ? "Confirm payment" : "Update card"}
            </Button>
          </Show>
          <Show when={plan() || state.status?.customer}>
            <Button variant="secondary" disabled={billing.busy()} onClick={() => void billing.run({ kind: "portal" })}>
              Manage billing
            </Button>
          </Show>
          <Show when={state.status?.signedIn}>
            <Button variant="secondary" disabled={state.busy} onClick={codiumChanged}>
              Refresh
            </Button>
          </Show>
        </div>
        <p class="text-12-regular text-text-weak" data-slot="codium-freshness">
          {usageFreshness(state.updatedAt, state.now)}
        </p>
        <CodiumBillingStatus billing={billing} />
      </section>
    </Show>
  )
}
