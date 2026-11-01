import type { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { CodiumPlan } from "@vectordevai/schema/codium-plan"

export type VectorAccountStatus = {
  authenticated: boolean
  pending: boolean
  email?: string
  name?: string
  /** The profile photo as a data URL. The desktop downloads it, so the renderer never loads a third-party image. */
  avatar?: string
  expiresAt?: number
  error?: string
  /**
   * Deleting the account: Vector is waiting for the fresh sign-in in the browser (confirming), or holds the
   * confirmation it gave and can delete (confirmed). The confirmation itself never leaves the desktop main process.
   */
  deletion?: "confirming" | "confirmed"
}

/**
 * What Vector asks vectordev.ai for in its Codium billing window: a monthly plan's checkout, a plan change (an upgrade
 * opens checkout; a smaller plan is scheduled for the renewal date), keeping the plan instead of a scheduled change,
 * or Stripe's customer portal (its home, cancelling, or updating the card). Codium sells no top-ups.
 */
export type VectorBillingRequest =
  | { kind: "checkout"; plan: string }
  | { kind: "change"; plan: string }
  | { kind: "keep" }
  | { kind: "portal"; flow?: "cancel" | "payment_method_update" }

/**
 * How a billing request ended: Stripe finished (completed), the person went back from checkout (cancelled) or closed
 * the window (closed). A smaller plan is scheduled for the renewal date without a window (scheduled), and Keep my plan
 * drops that schedule (kept). An older vectordev.ai, or a sign-in from before Vector 1.99.109 asking for the billing
 * portal, makes Vector open the website instead (website). A request made while a billing window is already open
 * brings that window forward and does nothing else (busy).
 */
export type VectorBillingResult =
  | { outcome: "completed" | "cancelled" | "closed" | "website" | "busy" | "kept" }
  | { outcome: "scheduled"; plan: string; at: number }
  | { outcome: "failed"; message: string }

export type VectorDeletionResult = { deleted: true } | { deleted: false; message: string }

export type VectorAccountPlatform = {
  status(): Promise<VectorAccountStatus>
  start(): Promise<VectorAccountStatus>
  cancel(): Promise<VectorAccountStatus>
  logout(): Promise<VectorAccountStatus>
  /** Vector Codium plan and balances, read by the desktop main process so the account token stays there. */
  codium?(): Promise<ModelPlanStatus.Status>
  /** Codium's monthly plans on sale, by name and price only. */
  offers?(): Promise<ModelPlanStatus.Offers | undefined>
  /** Has the local server read the signed-in account's Codium models now; nothing while signed out. */
  refreshModels?(): Promise<void>
  /** Opens checkout or the billing portal in a Vector window, or changes the plan, and resolves once that is done. */
  billing?(request: VectorBillingRequest): Promise<VectorBillingResult>
  /** Starts the fresh sign-in in the browser that confirms deleting this account. */
  confirmDeletion?(): Promise<VectorAccountStatus>
  /** Drops a deletion confirmation, whether still in the browser or already given. */
  cancelDeletion?(): Promise<VectorAccountStatus>
  /** Deletes the account with the confirmation the desktop holds; `email` is what the person typed. */
  deleteAccount?(email: string): Promise<VectorDeletionResult>
  onChange(listener: (status: VectorAccountStatus) => void): () => void
}

/**
 * What the sidebar's account chip shows, as Claude and Codex show it: the photo, else the first letter, beside the
 * first name from Google or the account, else the email, and then the Codium plan: Free without a subscription, else
 * the plan's name. The plan is left out until Vector has read it, and when it could not.
 */
export function accountChip(status: VectorAccountStatus, codium?: ModelPlanStatus.Status) {
  const name = status.name?.trim() || status.email || ""
  const label = name.split(/\s+/)[0] ?? ""
  return {
    label,
    name,
    plan: codium?.signedIn && !codium.error ? (codium.plan?.name ?? CodiumPlan.FREE) : undefined,
    initial: label.charAt(0),
    // Only an inline raster image, so the chip never loads a URL whatever the status carries.
    photo:
      status.avatar && /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(status.avatar)
        ? status.avatar
        : undefined,
  }
}

const codiumChanges = new Set<() => void>()
// The one read codiumSubscribed shares: of the account signed in as `email` (none while signed out), started at `at`.
const subscription: { email?: string; at: number; read?: Promise<boolean> } = { at: 0 }

/** Calls `listener` whenever a billing window may have changed the account's Codium plan; returns the unsubscribe. */
export function onCodiumChange(listener: () => void) {
  codiumChanges.add(listener)
  return () => {
    codiumChanges.delete(listener)
  }
}

/** Tells every screen showing the Codium plan to read it again. */
export function codiumChanged() {
  subscription.read = undefined
  codiumChanges.forEach((listener) => listener())
}

/**
 * Keeps one screen's Codium plan reads in order. Each call starts a read and returns whether that read is still the
 * newest when it answers; only then may its answer be shown. The reads after a purchase overlap (codiumChanged() once
 * the window closes, then at 5, 20 and 60 s) and each may take up to 10 s, so one started before Stripe's notification
 * can answer after a later one, and showing it would put the plan from before the purchase back on screen.
 */
export function newestRead() {
  const reads = { started: 0 }
  return () => {
    const read = ++reads.started
    return () => read === reads.started
  }
}

/** How long one answer to whether the account has a Codium plan serves every card that asks. */
export const SUBSCRIBED_FOR_MS = 60_000

/**
 * Whether the signed-in account has a Codium plan, for a failed turn's card telling Change plan from See plans. Every
 * card shares one read of the desktop's status, so a session with many failed turns, or timeline rows mounting again
 * as they scroll, asks vectordev.ai at most once a minute. The read belongs to the account signed in when it started
 * (the desktop's bridge is one object for the app's whole life), so signing out, or in as someone else, reads again;
 * so does codiumChanged() (a billing window, a purchase's later reads, Refresh). False without the desktop's reader
 * and when the read fails, and a failed read is never shared: the next card asks again.
 */
export async function codiumSubscribed(
  account: Pick<VectorAccountPlatform, "codium" | "status"> | undefined,
  now = Date.now(),
) {
  if (!account?.codium) return false
  const email = await account.status().then(
    (status) => (status.authenticated ? status.email : undefined),
    () => undefined,
  )
  if (subscription.read && subscription.email === email && now - subscription.at < SUBSCRIBED_FOR_MS)
    return subscription.read
  const read: Promise<boolean> = account
    .codium()
    .catch(() => undefined)
    .then((status) => {
      if (status && !status.error) return Boolean(status.plan)
      if (subscription.read === read) subscription.read = undefined
      return false
    })
  Object.assign(subscription, { email, at: now, read })
  return read
}

/**
 * Runs one billing request in the desktop's billing window and returns how it ended; a request that throws, or a
 * platform without billing, reads as failed. A finished checkout, upgrade or card update starts the plan and model
 * re-reads (refreshAfterPurchase). So does closing the portal opened to confirm a payment (`paying`): the portal's home
 * has no end, so only a later read says whether the bank's confirmation went through.
 */
export async function runBilling(
  account: Pick<VectorAccountPlatform, "billing" | "refreshModels">,
  request: VectorBillingRequest,
  input: { paying?: boolean; wait?: (ms: number) => Promise<void> } = {},
): Promise<VectorBillingResult> {
  const failed = { outcome: "failed" as const, message: "Vector could not open billing. Try again." }
  const result = account.billing ? await account.billing(request).catch(() => failed) : failed
  if (result.outcome === "completed" || (input.paying && result.outcome === "closed"))
    void refreshAfterPurchase({ models: async () => account.refreshModels?.(), wait: input.wait })
  return result
}

/** When a finished purchase reads the plan and the Codium models again, in ms after the billing window returned. */
export const PURCHASE_REFRESH_MS = [5_000, 20_000, 60_000] as const

const purchases = { generation: 0 }

/**
 * After a checkout, an upgrade or a card update returns, every screen reads the Codium plan and models again at 5, 20
 * and 60 s (codiumChanged; the app's layout re-reads the providers on it), since Stripe's notification can trail the
 * window by several seconds. The local server keeps the Codium model list for up to a minute, so each time `models`
 * (the desktop's refreshModels) first has it read the list from vectordev.ai; the announcement follows even when that
 * fails. It runs at module level, so closing the dialog that started it does not stop it, and a newer purchase
 * restarts the schedule instead of running a second one beside it.
 */
export async function refreshAfterPurchase(
  input: { models?: () => Promise<void>; wait?: (ms: number) => Promise<void> } = {},
) {
  const wait = input.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const generation = ++purchases.generation
  for (const [index, at] of PURCHASE_REFRESH_MS.entries()) {
    await wait(at - (PURCHASE_REFRESH_MS[index - 1] ?? 0))
    if (generation !== purchases.generation) return
    await input.models?.().catch(() => undefined)
    if (generation !== purchases.generation) return
    codiumChanged()
  }
}
