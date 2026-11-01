import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { ButtonV2 } from "@vectordevai/ui/v2/button-v2"
import { Match, Show, Switch, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { CodiumBillingStatus, CodiumPurchase, createCodiumBilling } from "@/components/codium-purchase"
import { usePlatform } from "@/context/platform"
import { accountChip, codiumChanged, newestRead, onCodiumChange, type VectorAccountStatus } from "@/vector-account"
import { accountIdentity, codiumSummary, deletionStep, sameEmail } from "./account-model"
import "./settings-v2.css"
import "./settings-account.css"

/**
 * Settings > Account: who is signed in, their Vector Codium plan and billing, and deleting the account. The desktop
 * main process holds the account token, reads the Codium status and runs Stripe in its own billing window, so none of
 * it reaches this page; it only ever sees shares, states and prices.
 */
export function SettingsAccountV2(props: { onUsage: () => void }) {
  const platform = usePlatform()
  const [account, setAccount] = createSignal<VectorAccountStatus>({ authenticated: false, pending: false })
  // Until the desktop answers, the page offers neither Sign in nor Sign out.
  const [loaded, setLoaded] = createSignal(false)
  const [codium, setCodium] = createSignal<ModelPlanStatus.Status>()
  const [busy, setBusy] = createSignal(false)
  const [purchasing, setPurchasing] = createSignal(false)
  // Deleting: the confirmation step the person opened, what they typed, and how the last attempt went.
  const [deleting, setDeleting] = createSignal(false)
  const [typed, setTyped] = createSignal("")
  const [deletion, setDeletion] = createSignal<{ busy?: boolean; error?: string; deleted?: boolean }>({})
  const chip = createMemo(() => accountChip(account()))
  const identity = createMemo(() => accountIdentity(account()))
  const summary = createMemo(() => codiumSummary(codium()))
  const plan = createMemo(() => {
    const current = summary()
    return current.kind === "plan" ? current : undefined
  })
  const failure = createMemo(() => {
    const current = summary()
    return current.kind === "error" ? current.text : undefined
  })

  const step = createMemo(() => deletionStep(deleting(), account().deletion))
  const typedMatches = createMemo(() => sameEmail(typed(), account().email))

  // Reads overlap after a purchase or an account change; an older answer never replaces a newer one.
  const codiumRead = newestRead()
  const refreshCodium = async () => {
    const read = platform.vectorAccount?.codium
    if (!read) return
    const newest = codiumRead()
    const next = await read().catch(() => ({
      signedIn: true,
      enabled: false,
      access: false,
      purchased: { bought: false },
      empty: false,
      low: false,
      error: "Vector could not load your Codium usage. Try again shortly.",
    }))
    if (newest()) setCodium(next)
  }

  onMount(() => {
    const vectorAccount = platform.vectorAccount
    if (!vectorAccount) return
    onCleanup(
      vectorAccount.onChange((next) => {
        // Another account, or none, has nothing of the last one's to delete. A profile refresh keeps the step.
        if (next.email !== account().email) {
          setDeleting(false)
          setTyped("")
          // Signing in again, after a deletion or as someone else, starts the page afresh.
          if (next.authenticated) setDeletion({})
        }
        setAccount(next)
        setLoaded(true)
        // Signing in or out changes whose plan this shows.
        void refreshCodium()
      }),
    )
    void vectorAccount
      .status()
      .then(setAccount)
      .catch(() =>
        setAccount({ authenticated: false, pending: false, error: "Vector could not load your account. Try again." }),
      )
      .finally(() => setLoaded(true))
    // A billing request, a purchase's later reads and Refresh elsewhere all say the plan may have changed.
    onCleanup(onCodiumChange(() => void refreshCodium()))
    void refreshCodium()
  })

  const act = async (action: "start" | "cancel" | "logout") => {
    const vectorAccount = platform.vectorAccount
    if (!vectorAccount || busy()) return
    setBusy(true)
    await vectorAccount[action]()
      .then(setAccount)
      .catch(() =>
        setAccount((value) => ({ ...value, error: "Vector could not complete this account action. Try again." })),
      )
      .finally(() => setBusy(false))
  }

  const billing = createCodiumBilling()

  // The desktop's own account token never deletes the account: it is stored on this machine and carries the email to
  // type. So deletion asks for a fresh sign-in in the browser, and the desktop deletes with what that sign-in gives.
  const confirmDeletion = async () => {
    const vectorAccount = platform.vectorAccount
    if (!vectorAccount?.confirmDeletion || !typedMatches()) return
    setDeletion({})
    await vectorAccount
      .confirmDeletion()
      .then(setAccount)
      .catch(() => setDeletion({ error: "Vector could not start the confirmation. Try again." }))
  }
  const keepAccount = () => {
    setDeleting(false)
    setTyped("")
    setDeletion({})
    void platform.vectorAccount
      ?.cancelDeletion?.()
      .then(setAccount)
      .catch(() => undefined)
  }
  const deleteAccount = async () => {
    const remove = platform.vectorAccount?.deleteAccount
    if (!remove || deletion().busy) return
    setDeletion({ busy: true })
    const result = await remove(typed()).catch(() => ({
      deleted: false as const,
      message: "Vector could not delete your account. Try again.",
    }))
    if (result.deleted) {
      setDeleting(false)
      setTyped("")
      setDeletion({ deleted: true })
      return
    }
    setDeletion({ error: result.message })
  }

  // A failed step of deleting, or a confirmation the browser sign-in could not give, shows where the person is looking.
  const DeletionError = () => (
    <Show when={deletion().error ?? account().error}>
      {(error) => (
        <p role="alert" class="settings-account-error">
          {error()}
        </p>
      )}
    </Show>
  )

  return (
    <section class="settings-v2-page settings-account-page" data-component="settings-account">
      <div class="settings-v2-page-hero">
        <div>
          <p class="settings-v2-page-kicker">Vector account</p>
          <h2 class="settings-v2-page-title">Account</h2>
          <p class="settings-v2-page-subtitle">
            Your Vector sign-in, your Vector Codium plan and billing, and what is left of this month's usage.
          </p>
        </div>
      </div>

      <div class="settings-account-profile" data-state={account().authenticated ? "signed-in" : "signed-out"}>
        <Show
          when={account().authenticated}
          fallback={
            <span class="settings-account-avatar" data-empty aria-hidden="true">
              <svg viewBox="0 0 20 20">
                <path
                  d="M10 9.375a3.125 3.125 0 1 0 0-6.25 3.125 3.125 0 0 0 0 6.25ZM3.958 16.875c.6-3.06 3.04-5 6.042-5s5.442 1.94 6.042 5"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.2"
                  stroke-linecap="round"
                />
              </svg>
            </span>
          }
        >
          <Show
            when={chip().photo}
            fallback={
              <span class="settings-account-avatar" aria-hidden="true">
                {chip().initial}
              </span>
            }
          >
            {(photo) => <img class="settings-account-avatar" src={photo()} alt="" decoding="async" draggable={false} />}
          </Show>
        </Show>

        <div class="settings-account-identity">
          <Show
            when={account().authenticated}
            fallback={
              <Show when={loaded()} fallback={<p role="status">Checking your Vector account…</p>}>
                <Show
                  when={deletion().deleted}
                  fallback={
                    <>
                      <h3>Not signed in</h3>
                      <p>
                        Sign in to connect this app to your Vector account. Your provider keys are managed separately.
                      </p>
                    </>
                  }
                >
                  <h3>Your Vector account was deleted</h3>
                  <p role="status">This app is signed out. Your provider keys and repositories are untouched.</p>
                </Show>
              </Show>
            }
          >
            <h3>{identity().title}</h3>
            <Show when={identity().detail}>{(detail) => <p>{detail()}</p>}</Show>
          </Show>
          <Show when={account().pending}>
            <p role="status" class="settings-account-pending">
              Finish signing in in your browser, then return to Vector.
            </p>
          </Show>
          <Show when={step() === "closed" && account().error}>
            {(error) => (
              <p role="alert" class="settings-account-error">
                {error()}
              </p>
            )}
          </Show>
        </div>

        <Show when={loaded()}>
          <div class="settings-account-actions">
            <Switch>
              <Match when={account().pending}>
                <ButtonV2 variant="outline" disabled={busy()} onClick={() => void act("cancel")}>
                  Cancel sign-in
                </ButtonV2>
              </Match>
              <Match when={account().authenticated}>
                <ButtonV2 variant="outline" disabled={busy()} onClick={() => void act("logout")}>
                  Sign out
                </ButtonV2>
              </Match>
              <Match when={true}>
                <ButtonV2
                  class="settings-account-primary"
                  variant="contrast"
                  disabled={busy()}
                  onClick={() => void act("start")}
                >
                  Sign in to Vector
                </ButtonV2>
              </Match>
            </Switch>
          </div>
        </Show>
      </div>

      <Show when={account().authenticated && platform.vectorAccount?.codium}>
        <div class="settings-account-section" data-component="settings-account-codium">
          <div class="settings-account-section-head">
            <div>
              <h3>Vector Codium</h3>
              <p>Coding models included in your Vector Codium plan. Usage shows as a share of this month.</p>
            </div>
            <Show when={summary().kind === "coming-soon"}>
              <span class="settings-account-badge">Coming soon</span>
            </Show>
          </div>

          <Switch>
            <Match when={summary().kind === "loading"}>
              <p role="status" class="settings-account-muted">
                Loading your plan…
              </p>
            </Match>
            <Match when={summary().kind === "coming-soon"}>
              <p class="settings-account-muted">
                Vector Codium plans are not on sale yet. Your plan and this month's usage will show here.
              </p>
            </Match>
            <Match when={failure()}>
              {(text) => (
                <p role="alert" class="settings-account-error">
                  {text()}
                </p>
              )}
            </Match>
            <Match when={plan()}>
              {(current) => (
                <>
                  <dl class="settings-account-balance">
                    <div>
                      <dt>Plan</dt>
                      <dd>{current().plan}</dd>
                    </div>
                    <Show when={current().usage}>
                      {(usage) => (
                        <div>
                          <dt>This month</dt>
                          <dd>{usage()}</dd>
                          <Show when={current().left !== undefined}>
                            <span
                              class="settings-account-meter"
                              role="meter"
                              aria-label="Share of this month's usage left"
                              aria-valuemin="0"
                              aria-valuemax="100"
                              aria-valuenow={Math.round((current().left ?? 0) * 100)}
                              data-tone={current().notice?.kind ?? "ok"}
                            >
                              <span style={{ width: `${Math.round((current().left ?? 0) * 100)}%` }} />
                            </span>
                          </Show>
                        </div>
                      )}
                    </Show>
                    <Show when={current().renewal}>
                      {(renewal) => (
                        <div>
                          <dt>{renewal().label}</dt>
                          <dd>{renewal().date}</dd>
                        </div>
                      )}
                    </Show>
                  </dl>
                  <Show when={current().scheduled}>
                    {(scheduled) => (
                      <div class="settings-account-scheduled" data-component="settings-account-scheduled">
                        <p role="status">
                          Switches to {scheduled().name} on {scheduled().date}.
                        </p>
                        <ButtonV2
                          variant="outline"
                          disabled={billing.busy()}
                          onClick={() => void billing.run({ kind: "keep" })}
                        >
                          Keep my plan
                        </ButtonV2>
                      </div>
                    )}
                  </Show>
                  <Show when={current().notice}>
                    {(notice) => (
                      <p
                        role={notice().kind === "empty" ? "alert" : "status"}
                        class="settings-account-notice"
                        data-kind={notice().kind}
                      >
                        {notice().text}
                      </p>
                    )}
                  </Show>
                  <Show when={current().payment}>
                    {(payment) => (
                      <div class="settings-account-links">
                        <ButtonV2
                          class="settings-account-primary"
                          variant="contrast"
                          disabled={billing.busy()}
                          onClick={() =>
                            void (payment() === "update-card"
                              ? billing.run({ kind: "portal", flow: "payment_method_update" })
                              : // The portal's home ends as closed, though the payment may have gone through there.
                                billing.run({ kind: "portal" }, { paying: true }))
                          }
                        >
                          {payment() === "update-card" ? "Update card" : "Confirm payment"}
                        </ButtonV2>
                      </div>
                    )}
                  </Show>
                </>
              )}
            </Match>
          </Switch>

          <div class="settings-account-links">
            <ButtonV2 variant="outline" icon="status" onClick={props.onUsage}>
              View usage
            </ButtonV2>
            <Show when={summary().kind === "plan" || summary().kind === "coming-soon"}>
              <ButtonV2
                variant="outline"
                aria-expanded={purchasing()}
                onClick={() =>
                  platform.vectorAccount?.offers
                    ? setPurchasing((value) => !value)
                    : platform.openLink(codium()?.plan ? ModelPlanStatus.MANAGE_URL : ModelPlanStatus.PURCHASE_URL)
                }
              >
                {codium()?.plan ? "Change plan" : "See plans"}
              </ButtonV2>
            </Show>
            <Show when={codium()?.plan && !codium()?.plan?.cancelAtPeriodEnd && summary().kind === "plan"}>
              <ButtonV2
                variant="outline"
                disabled={billing.busy()}
                onClick={() => void billing.run({ kind: "portal", flow: "cancel" })}
              >
                Cancel plan
              </ButtonV2>
            </Show>
            <Show when={plan()?.billing}>
              <ButtonV2
                variant="outline"
                disabled={billing.busy()}
                onClick={() => void billing.run({ kind: "portal" })}
              >
                Manage billing and invoices
              </ButtonV2>
            </Show>
            <Show when={summary().kind !== "coming-soon"}>
              <ButtonV2 variant="ghost" icon="reset" onClick={codiumChanged}>
                Refresh
              </ButtonV2>
            </Show>
          </div>
          <Show when={purchasing()}>
            <CodiumPurchase status={codium()} billing={billing} />
          </Show>
          <CodiumBillingStatus billing={billing} plan={codium()?.plan?.id} />
        </div>
      </Show>

      <Show when={account().authenticated}>
        <div class="settings-account-section settings-account-danger" data-component="settings-account-delete">
          <div class="settings-account-section-head">
            <div>
              <h3>Delete account</h3>
              <p>Deleting removes your sign-in, stops your CLI tokens and ends any Codium plan. It cannot be undone.</p>
            </div>
          </div>
          <Switch>
            <Match when={step() === "type"}>
              <div class="settings-account-confirm" role="group" aria-label="Confirm account deletion">
                <p>
                  Vector deletes your account and sign-in and stops the CLI tokens this account has issued. Any Vector
                  Codium plan ends at once, and what is left of this month's Codium usage can no longer be used.
                  Repositories on this machine are not touched, and neither is anything you have already published to
                  your own cloud accounts.
                </p>
                <label class="settings-account-field">
                  <span>Type {account().email} to confirm</span>
                  <input
                    type="email"
                    autocomplete="off"
                    spellcheck={false}
                    value={typed()}
                    onInput={(event) => setTyped(event.currentTarget.value)}
                  />
                </label>
                <p>Then confirm it is you by signing in to vectordev.ai again in your browser.</p>
                <DeletionError />
                <div class="settings-account-links">
                  <ButtonV2 variant="danger" disabled={!typedMatches()} onClick={() => void confirmDeletion()}>
                    Confirm with your Vector sign-in
                  </ButtonV2>
                  <ButtonV2 variant="outline" onClick={keepAccount}>
                    Keep my account
                  </ButtonV2>
                  <ButtonV2 variant="ghost" onClick={() => platform.openLink(ModelPlanStatus.MANAGE_URL)}>
                    Delete on vectordev.ai instead
                  </ButtonV2>
                </div>
              </div>
            </Match>
            <Match when={step() === "confirming"}>
              <div class="settings-account-confirm" role="group" aria-label="Confirm account deletion">
                <p role="status">
                  Finish signing in to vectordev.ai in your browser. Vector asks for a fresh sign-in before it deletes
                  your account, then brings you back here.
                </p>
                <DeletionError />
                <div class="settings-account-links">
                  <ButtonV2 variant="outline" onClick={() => void confirmDeletion()}>
                    Open the browser again
                  </ButtonV2>
                  <ButtonV2 variant="outline" onClick={keepAccount}>
                    Keep my account
                  </ButtonV2>
                </div>
              </div>
            </Match>
            <Match when={step() === "confirmed"}>
              <div class="settings-account-confirm" role="group" aria-label="Confirm account deletion">
                <p>Confirmed. Delete {account().email} now? This cannot be undone.</p>
                <Show when={!typedMatches()}>
                  <label class="settings-account-field">
                    <span>Type {account().email} to confirm</span>
                    <input
                      type="email"
                      autocomplete="off"
                      spellcheck={false}
                      value={typed()}
                      onInput={(event) => setTyped(event.currentTarget.value)}
                    />
                  </label>
                </Show>
                <DeletionError />
                <div class="settings-account-links">
                  <ButtonV2
                    variant="danger"
                    disabled={deletion().busy || !typedMatches()}
                    onClick={() => void deleteAccount()}
                  >
                    {deletion().busy ? "Deleting…" : "Delete my account"}
                  </ButtonV2>
                  <ButtonV2 variant="outline" disabled={deletion().busy} onClick={keepAccount}>
                    Keep my account
                  </ButtonV2>
                </div>
              </div>
            </Match>
            <Match when={true}>
              <div class="settings-account-links">
                <ButtonV2 variant="ghost" onClick={() => setDeleting(true)}>
                  Delete account…
                </ButtonV2>
              </div>
            </Match>
          </Switch>
        </div>
      </Show>
    </section>
  )
}
