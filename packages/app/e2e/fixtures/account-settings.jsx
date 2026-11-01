import { Suspense } from "solid-js"
import { render } from "solid-js/web"
import { CodiumPlan } from "@vectordevai/schema/codium-plan"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { DialogProvider } from "@vectordevai/ui/context/dialog"
import { PlatformProvider } from "../../src/context/platform"
import { SettingsWorkspace } from "../../src/components/settings-v2"
import { CodiumError } from "../../src/components/codium-error"
import { yieldLaunchScreen } from "../../src/features/launch/launch-bridge"
import "../../src/index.css"
import "../../src/vector-premium.css"

// Settings > Account against a stand-in for the desktop's account bridge. The query picks the account: ?account=
// signed-out, signed-in (no photo), photo, broken (a photo that will not decode) or email (no name and no photo),
// ?codium= coming-soon, plan, exhausted, low, ended, none (on sale, never bought), paused-card (a failed payment),
// paused-confirm (the bank asks to confirm), scheduled (Pro with Plus starting at renewal) or error, and ?billing= how
// a billing window ends (completed, cancelled, closed, website, busy or failed; pending keeps it open until
// accountFixture.finish() closes it). Links the page opens, billing requests and account actions it takes are kept on
// window.accountFixture for the spec to read; accountFixture.confirm() stands in for the browser sign-in that confirms
// deleting the account. ?view=codium-error shows a failed Codium turn instead of Settings, worded as the engine words
// the gateway's ?error= answer: required (no plan, the default), exhausted (a subscriber's month used up), update-card,
// confirm-payment or daily, inside a Suspense boundary as the app's route has one around the timeline. ?status=pending
// holds every Codium status read until accountFixture.answer() lets them through, and ?status=failed fails every one
// as the desktop bridge does when it cannot answer at all.
const query = new URLSearchParams(location.search)
const renewsAt = Date.UTC(2026, 10, 1, 12)
const codium = {
  "coming-soon": {
    signedIn: true,
    enabled: false,
    access: false,
    purchased: { bought: false },
    empty: false,
    low: false,
  },
  plan: {
    signedIn: true,
    enabled: true,
    access: true,
    plan: { id: "vector-50", name: "Pro", left: 0.64, renewsAt, cancelAtPeriodEnd: false, state: "active" },
    purchased: { bought: false },
    empty: false,
    low: false,
  },
  "paused-card": {
    signedIn: true,
    enabled: true,
    access: false,
    plan: {
      id: "vector-50",
      name: "Pro",
      left: 0.64,
      renewsAt,
      cancelAtPeriodEnd: false,
      state: "paused",
      reason: "payment_failed",
      action: "update-card",
    },
    purchased: { bought: false },
    empty: false,
    low: false,
  },
  "paused-confirm": {
    signedIn: true,
    enabled: true,
    access: false,
    plan: {
      id: "vector-50",
      name: "Pro",
      left: 0.64,
      renewsAt,
      cancelAtPeriodEnd: false,
      state: "paused",
      reason: "action_required",
      action: "confirm-payment",
    },
    purchased: { bought: false },
    empty: false,
    low: false,
  },
  scheduled: {
    signedIn: true,
    enabled: true,
    access: true,
    plan: {
      id: "vector-50",
      name: "Pro",
      left: 0.64,
      renewsAt,
      cancelAtPeriodEnd: false,
      state: "active",
      scheduled: { id: "vector-10", name: "Plus", at: renewsAt },
    },
    purchased: { bought: false },
    empty: false,
    low: false,
  },
  exhausted: {
    signedIn: true,
    enabled: true,
    access: true,
    plan: { id: "vector-50", name: "Pro", left: 0, renewsAt, cancelAtPeriodEnd: false },
    purchased: { bought: false },
    empty: true,
    low: false,
  },
  low: {
    signedIn: true,
    enabled: true,
    access: true,
    plan: { id: "vector-10", name: "Plus", left: 0.06, renewsAt, cancelAtPeriodEnd: false },
    purchased: { bought: false },
    empty: false,
    low: true,
  },
  ended: {
    signedIn: true,
    enabled: true,
    access: true,
    plan: { id: "vector-100", name: "Max", renewsAt, cancelAtPeriodEnd: true },
    purchased: { bought: false },
    empty: false,
    low: false,
  },
  none: {
    signedIn: true,
    enabled: true,
    access: false,
    purchased: { bought: false },
    empty: true,
    low: false,
  },
  error: {
    signedIn: true,
    enabled: false,
    access: false,
    purchased: { bought: false },
    empty: false,
    low: false,
    error: "Vector could not load your Codium balance. Try again shortly.",
  },
}[query.get("codium") ?? "coming-soon"]

// A small generated PNG, standing in for the Google photo the desktop downloads.
const photo =
  "data:image/png;base64,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"
const signedIn = {
  authenticated: true,
  pending: false,
  name: "Ana Diaz",
  email: "ana@example.com",
  expiresAt: Date.now() + 86_400_000,
}
const initial =
  {
    "signed-out": { authenticated: false, pending: false },
    photo: { ...signedIn, avatar: photo },
    broken: { ...signedIn, avatar: "data:image/png;base64,AAAA" },
    email: { authenticated: true, pending: false, email: "ana.diaz@example.com", expiresAt: signedIn.expiresAt },
  }[query.get("account") ?? ""] ?? signedIn

// The desktop's monthly offers. Nothing is available while Codium is coming soon. Codium sells no top-ups.
const sale = codium.enabled
const offers = {
  enabled: sale,
  plans: CodiumPlan.PLANS.map((plan) => ({ id: plan.id, name: plan.name, price: plan.price, available: sale })),
}
const outcome = query.get("billing") ?? "completed"

const state = { account: initial, opened: [], actions: [], billing: [], codiumReads: 0, modelReads: 0 }
const listeners = new Set()
const change = (next) => {
  state.account = next
  listeners.forEach((listener) => listener(next))
  return next
}
window.accountFixture = state
// The fresh sign-in in the browser came back with its confirmation.
state.confirm = () => change({ ...state.account, deletion: "confirmed" })
// The person closes the open billing window.
const open = []
state.finish = () => open.shift()?.()
// Codium status reads held by ?status=pending, until vectordev.ai "answers".
const held = []
state.answer = () => held.splice(0).forEach((release) => release())

const platform = {
  platform: "desktop",
  version: "1.99.109",
  openLink: (url) => state.opened.push(url),
  restart: async () => undefined,
  back: () => undefined,
  forward: () => undefined,
  notify: async () => undefined,
  vectorAccount: {
    status: async () => state.account,
    start: async () => {
      state.actions.push("start")
      return change({ authenticated: false, pending: true })
    },
    cancel: async () => {
      state.actions.push("cancel")
      return change({ authenticated: false, pending: false })
    },
    logout: async () => {
      state.actions.push("logout")
      return change({ authenticated: false, pending: false })
    },
    codium: async () => {
      state.codiumReads += 1
      if (query.get("status") === "pending") await new Promise((resolve) => held.push(resolve))
      if (query.get("status") === "failed") throw new Error("The desktop could not read the Codium status.")
      return state.account.authenticated
        ? codium
        : { signedIn: false, enabled: false, access: false, purchased: { bought: false }, empty: false, low: false }
    },
    offers: async () => offers,
    // The desktop has the local server read the account's Codium models again (a credential write, no reload).
    refreshModels: async () => {
      if (state.account.authenticated) state.modelReads += 1
    },
    billing: async (request) => {
      state.billing.push(request)
      if (request.kind === "topup") throw new Error("Unexpected top-up billing request: Codium is monthly-only.")
      if (request.kind === "checkout" && (!sale || !CodiumPlan.PLANS.some((plan) => plan.id === request.plan)))
        throw new Error("Unexpected monthly checkout request.")
      // The real API refuses a legacy portal plan change, and any change but the scheduled one while a smaller plan is
      // scheduled (409 MODEL_PLAN_CHANGE_UNAVAILABLE).
      const refused = { outcome: "failed", message: "Change plans on vectordev.ai/account." }
      if (request.kind === "portal" && request.flow === "change") return refused
      if (request.kind === "change") {
        const plan = codium.plan
        if (!plan || !CodiumPlan.isPlanId(request.plan) || request.plan === plan.id)
          throw new Error("Unexpected change.")
        if (plan.scheduled && plan.scheduled.id !== request.plan) return refused
        // A smaller plan is scheduled for renewal with no window; an upgrade opens checkout and ends as it does.
        if (CodiumPlan.rank(request.plan) < CodiumPlan.rank(plan.id))
          return { outcome: "scheduled", plan: request.plan, at: plan.renewsAt }
      } else if (request.kind === "keep") {
        if (!codium.plan?.scheduled) throw new Error("Unexpected keep request.")
        return { outcome: "kept" }
      } else if (
        request.kind !== "checkout" &&
        !(
          request.kind === "portal" &&
          (request.flow === undefined || request.flow === "cancel" || request.flow === "payment_method_update")
        )
      )
        throw new Error("Unexpected billing action.")
      if (outcome === "pending") {
        await new Promise((resolve) => open.push(resolve))
        return { outcome: "closed" }
      }
      return outcome === "failed"
        ? { outcome, message: "Subscription management is temporarily unavailable." }
        : { outcome }
    },
    confirmDeletion: async () => {
      state.actions.push("confirmDeletion")
      return change({ ...state.account, deletion: "confirming" })
    },
    cancelDeletion: async () => {
      state.actions.push("cancelDeletion")
      const { deletion: _, ...rest } = state.account
      return change(rest)
    },
    deleteAccount: async (email) => {
      state.actions.push(`delete ${email}`)
      change({ authenticated: false, pending: false })
      return { deleted: true }
    },
    onChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  },
}

// A failed Codium turn as the engine words the gateway's answer (ModelPlanStatus.gatewayFailure), so the card reads
// exactly what a real turn stores.
const answers = {
  required: [402, "MODEL_PLAN_REQUIRED", "Choose a Vector Codium plan to use this model."],
  exhausted: [
    402,
    "MODEL_PLAN_EXHAUSTED",
    "This month's Vector Codium usage cannot cover this model's largest request.",
  ],
  "update-card": [
    402,
    "MODEL_PLAN_PAYMENT_REQUIRED",
    "Your last Vector Codium payment did not go through. Update your card to keep using Vector Codium.",
    "update-card",
  ],
  "confirm-payment": [
    402,
    "MODEL_PLAN_PAYMENT_REQUIRED",
    "Your bank needs you to confirm your Vector Codium payment.",
    "confirm-payment",
  ],
  daily: [429, "MODEL_PLAN_DAILY_LIMIT", "Your Codium daily limit has been reached. Try again tomorrow."],
}
const [status, code, message, action] = answers[query.get("error") ?? "required"]
const failure = ModelPlanStatus.gatewayFailure(
  status,
  JSON.stringify({ error: { code, message, ...(action ? { action } : {}) } }),
)

yieldLaunchScreen("app")
render(
  () => (
    <PlatformProvider value={platform}>
      <DialogProvider>
        {query.get("view") === "codium-error" ? (
          <Suspense fallback={<p data-suspended>Suspended</p>}>
            <CodiumError text={failure.message} action={failure.action ?? "unavailable"} />
          </Suspense>
        ) : (
          <SettingsWorkspace section="account" />
        )}
      </DialogProvider>
    </PlatformProvider>
  ),
  document.querySelector("#root"),
)
