import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { CodiumPlan } from "@vectordevai/schema/codium-plan"
import { accountChip, type VectorAccountStatus } from "@/vector-account"

export type CodiumSummary =
  | { kind: "loading" }
  | { kind: "signed-out" }
  | { kind: "error"; text: string }
  | { kind: "coming-soon" }
  | {
      kind: "plan"
      plan: string
      /** The share of this month's usage left, from 0 to 1, when the gateway could verify it. */
      left?: number
      usage?: string
      renewal?: { label: "Renews" | "Ends"; date: string }
      /** A smaller plan that starts at renewal, which Keep my plan drops. */
      scheduled?: { name: string; date: string }
      /** What starts a paused plan again: a new card, or confirming the payment with the bank. */
      payment?: "update-card" | "confirm-payment"
      notice?: ReturnType<typeof ModelPlanStatus.notice>
      /** Whether vectordev.ai keeps billing for this account: a plan or past invoices to manage. */
      billing: boolean
    }

/**
 * What Settings > Account shows for Vector Codium. The status only ever carries shares and states, and this keeps it
 * that way: a percentage of this month's usage, never an amount, so the markup cannot be worked out. Codium sells
 * monthly plans only, so nothing here speaks of credits or top-ups. While Codium is not on sale and the account has
 * never paid for it, it is Coming soon.
 */
export function codiumSummary(status?: ModelPlanStatus.Status): CodiumSummary {
  if (!status) return { kind: "loading" }
  if (status.error) return { kind: "error", text: status.error }
  if (!status.signedIn) return { kind: "signed-out" }
  const plan = status.plan
  if (!status.enabled && !plan && !status.customer) return { kind: "coming-soon" }
  return {
    kind: "plan",
    plan: plan?.name ?? CodiumPlan.FREE,
    ...(plan?.left === undefined ? {} : { left: plan.left }),
    ...(plan
      ? {
          usage:
            plan.left === undefined
              ? "Usage unavailable"
              : `${ModelPlanStatus.formatShare(plan.left)} of this month's usage left`,
          renewal: {
            label: plan.cancelAtPeriodEnd ? ("Ends" as const) : ("Renews" as const),
            date: ModelPlanStatus.formatDate(plan.renewsAt),
          },
        }
      : {}),
    ...(plan?.scheduled
      ? { scheduled: { name: plan.scheduled.name, date: ModelPlanStatus.formatDate(plan.scheduled.at) } }
      : {}),
    ...(plan?.state === "paused"
      ? { payment: plan.action === "confirm-payment" ? ("confirm-payment" as const) : ("update-card" as const) }
      : {}),
    notice: ModelPlanStatus.notice(status),
    billing: Boolean(plan || status.customer),
  }
}

/**
 * Which step of deleting the account the page shows. The desktop's own state comes first, so a confirmation still in
 * the browser, or one already given, shows again when the page is reopened.
 */
export function deletionStep(open: boolean, deletion?: "confirming" | "confirmed") {
  if (deletion) return deletion
  return open ? ("type" as const) : ("closed" as const)
}

/** Whether the typed email is the account's own, as vectordev.ai compares them. */
export function sameEmail(typed: string, email?: string) {
  const value = typed.trim().toLowerCase()
  return Boolean(value && email && value === email.trim().toLowerCase())
}

/** The account card's heading and line under it: the name from Google or the account, else the email alone. */
export function accountIdentity(status: { name?: string; email?: string }) {
  const name = status.name?.trim()
  if (name) return { title: name, detail: status.email }
  return { title: status.email ?? "", detail: undefined }
}

/**
 * Who the Settings header names: the person's photo, else their initials, beside their name, else the part of their
 * email before the @. Signed out, or until the desktop answers, there is no one, and the header shows Vector's own logo
 * and name. `failed` is a photo the header could not show; it falls back to the initials until a different one arrives.
 */
export function settingsIdentity(status: VectorAccountStatus, failed?: string) {
  const name = status.name?.trim() || status.email?.split("@")[0]?.trim()
  if (!status.authenticated || !name) return undefined
  const words = name.split(/[\s._+-]+/).filter(Boolean)
  const photo = accountChip(status).photo
  return {
    name,
    initials:
      (words.length > 1 ? [words[0], words[words.length - 1]] : words)
        .map((word) => [...word][0])
        .join("")
        .toLocaleUpperCase() || [...name][0],
    photo: photo === failed ? undefined : photo,
  }
}
