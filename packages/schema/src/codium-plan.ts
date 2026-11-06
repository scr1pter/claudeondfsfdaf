export * as CodiumPlan from "./codium-plan.js"

/**
 * Vector Codium's monthly plans, cheapest first, by the names people read. The ids are what checkout sold and what
 * Stripe's metadata, links and running subscriptions record, so a rename changes only `name` and never `id`.
 */
export const PLANS = [
  { id: "vector-10", name: "Plus", price: 10 },
  { id: "vector-50", name: "Pro", price: 50 },
  { id: "vector-100", name: "Max", price: 100 },
  { id: "vector-200", name: "Ultra", price: 200 },
] as const

/** The id of a Codium plan Vector sells. */
export type PlanId = (typeof PLANS)[number]["id"]

/**
 * Codium sells monthly plans only. Top-ups are gone (owner decision, 27 Oct 2026), so nothing is on this list; it stays
 * empty, never refilled, until the last reader of it is removed, and then it is deleted.
 * @deprecated Codium has no top-ups.
 */
export const TOPUPS: readonly { readonly id: string; readonly name: string; readonly price: number }[] = []

/** What an account without a Codium subscription is on, as the sidebar and Settings say. */
export const FREE = "Free"

/** Whether `id` is the id of a plan Vector sells. */
export function isPlanId(id: unknown): id is PlanId {
  return PLANS.some((plan) => plan.id === id)
}

/**
 * A plan's place in the order Plus 1, Pro 2, Max 3, Ultra 4, so a higher rank always includes more. An id Vector does
 * not sell ranks 0, below every plan, so comparing ranks never lifts an unknown id above a real plan.
 */
export function rank(id: PlanId): 1 | 2 | 3 | 4
export function rank(id: string): 0 | 1 | 2 | 3 | 4
export function rank(id: string) {
  return (PLANS.findIndex((plan) => plan.id === id) + 1) as 0 | 1 | 2 | 3 | 4
}

/** The name of the plan with this id, or undefined for an id that is not a plan Vector sells. */
export function name(id: string) {
  return PLANS.find((plan) => plan.id === id)?.name
}
