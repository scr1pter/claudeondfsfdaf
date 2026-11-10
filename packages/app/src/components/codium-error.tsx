import { Button } from "@vectordevai/ui/button"
import { Card } from "@vectordevai/ui/card"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { For, Show, createSignal, onCleanup, onMount } from "solid-js"
import { usePlatform, type Platform } from "@/context/platform"
import { showToast } from "@/utils/toast"
import {
  codiumChanged,
  codiumSubscribed,
  newestRead,
  onCodiumChange,
  runBilling,
  type VectorBillingRequest,
} from "@/vector-account"
import { billingNotice, type BillingNotice } from "./codium-billing"
import { useCodiumPurchase } from "./codium-purchase"

/** A Vector Codium turn that could not run: say why, and offer the one action that fixes it. */
export function CodiumError(props: { text: string; action: ModelPlanStatus.Action }) {
  const platform = usePlatform()
  const purchase = useCodiumPurchase()
  // The timeline keeps only the message and the action, so a credit answer that names no payment step asks whether
  // the account has a plan, to tell a subscriber (Change plan) from someone without one (See plans). Every card shares
  // that read (codiumSubscribed). The answer lands in a signal, never a resource: a pending resource read here would
  // suspend the route's Suspense, blanking the whole session page until vectordev.ai answered.
  const [subscribed, setSubscribed] = createSignal<boolean>()
  // A shared read from before a purchase can answer after the one codiumChanged() started; it never wins.
  const subscription = newestRead()
  const read = () => {
    if (props.action !== "credits" || ModelPlanStatus.failureParts(props.text).payment) return
    const newest = subscription()
    void codiumSubscribed(platform.vectorAccount).then((value) => {
      if (newest()) setSubscribed(value)
    })
  }
  onMount(() => {
    onCleanup(onCodiumChange(read))
    // Signing out, or in as someone else, changes whose plan names the fix.
    const account = platform.vectorAccount
    if (account) onCleanup(account.onChange(() => read()))
    read()
  })
  const actions = () =>
    codiumActions({ action: props.action, text: props.text, subscribed: subscribed() }, platform, purchase)
  return (
    <Card variant="error" class="error-card" data-codium-error={props.action}>
      <div class="flex flex-col gap-3">
        <span>{codiumErrorText(props.text, platform)}</span>
        <Show when={actions().length}>
          <div class="flex flex-wrap gap-2">
            <For each={actions()}>{(action) => <Button onClick={action.onClick}>{action.label}</Button>}</For>
          </div>
        </Show>
      </div>
    </Card>
  )
}

/**
 * The engine ends a credit, plan or payment answer with the step that fixes it and its vectordev.ai link ("See plans at
 * …", "Update your card at …"), which the terminal needs. Where the desktop can bill, the app's own button takes that
 * sentence's place; elsewhere the link stays beside the button that opens it.
 */
export function codiumErrorText(text: string, platform: Pick<Platform, "vectorAccount">) {
  if (!platform.vectorAccount?.billing) return text
  return ModelPlanStatus.failureParts(text).text
}

/** What fixes a failed Codium turn. Run, daily and Brain limits, contact, wait, update and unavailable have no fix to buy. */
export type CodiumFix = "plans" | "change-plan" | "update-card" | "confirm-payment" | "manage-plan" | "sign-in"

/**
 * The fix for a failed turn, from the finest evidence at hand: the gateway code (a toast has it), else the step the
 * engine's message ends with (the timeline card keeps only the text), else the stored action. A credit answer is See
 * plans without a plan and Change plan with one; a payment answer is Update card or Confirm payment (§4.10).
 */
export function codiumFix(input: {
  action: ModelPlanStatus.Action
  text: string
  code?: string
  subscribed?: boolean
}): CodiumFix | undefined {
  if (input.action === "sign-in") return "sign-in"
  if (input.action !== "credits") return
  const parts = ModelPlanStatus.failureParts(input.text)
  if (parts.payment) return parts.payment
  const kind = (input.code && ModelPlanStatus.failureKind(input.code)) || parts.kind
  if (kind === "upgrade") return "change-plan"
  if (kind === "plan") return "manage-plan"
  // MODEL_PLAN_EXHAUSTED is a subscriber's month used up; MODEL_PLAN_REQUIRED has no plan, or one that ended.
  if (input.code === "MODEL_PLAN_EXHAUSTED") return "change-plan"
  if (input.code === "MODEL_PLAN_REQUIRED") return "plans"
  return input.subscribed ? "change-plan" : "plans"
}

/**
 * The buttons a failed Codium turn or session notice offers. Choosing another model needs no button. Plans and payments
 * stay in Vector where the desktop can bill (`purchase` opens the plans, Stripe's portal handles the card); elsewhere
 * they open vectordev.ai. A daily, run or Brain limit never offers anything to buy. A portal step runs as Settings runs
 * it (runBilling, with the later plan and model reads), and `options.notify` (a toast by default) says how it ended.
 */
export function codiumActions(
  input: { action: ModelPlanStatus.Action; text: string; code?: string; subscribed?: boolean },
  platform: Pick<Platform, "openLink" | "vectorAccount">,
  purchase?: () => void,
  options: { notify?: (notice: BillingNotice) => void; wait?: (ms: number) => Promise<void> } = {},
) {
  const fix = codiumFix(input)
  const account = platform.vectorAccount
  const billing = account?.billing
  const notify = options.notify ?? billingToast
  // A plan step in Vector's plan dialog where the desktop can bill, else on the website.
  const plans = (url: string) => () => (purchase && billing ? purchase() : platform.openLink(url))
  // Stripe's portal in Vector's billing window; the account is read again once it closes.
  const portal = (request: VectorBillingRequest, paying?: boolean) => () => {
    if (!account || !billing) return platform.openLink(ModelPlanStatus.MANAGE_URL)
    void runBilling(account, request, { paying, wait: options.wait }).then((result) => {
      const notice = billingNotice(request, result)
      if (notice) notify(notice)
      codiumChanged()
    })
  }
  if (fix === "plans") return [{ label: "See plans", onClick: plans(ModelPlanStatus.PURCHASE_URL) }]
  if (fix === "change-plan") return [{ label: "Change plan", onClick: plans(ModelPlanStatus.MANAGE_URL) }]
  if (fix === "manage-plan") return [{ label: "Manage plan", onClick: plans(ModelPlanStatus.MANAGE_URL) }]
  if (fix === "update-card")
    return [{ label: "Update card", onClick: portal({ kind: "portal", flow: "payment_method_update" }) }]
  // Stripe's portal home lists the invoice to confirm (no endpoint hands out the invoice's own page yet). It ends as
  // closed, though the payment may have gone through there, so closing it starts the later reads too.
  if (fix === "confirm-payment") return [{ label: "Confirm payment", onClick: portal({ kind: "portal" }, true) }]
  if (fix === "sign-in" && account)
    return [{ label: "Sign in to Vector", onClick: () => void account.start().catch(() => undefined) }]
  return []
}

/** How a portal step started from a failed turn ended, as a toast, since the card and the notice have no line for it. */
function billingToast(notice: BillingNotice) {
  showToast({
    description: notice.text,
    variant: notice.kind === "error" ? "error" : notice.kind === "done" ? "success" : "default",
  })
}
